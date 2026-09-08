import io
import json
import os
import signal
import tempfile
import threading
import time
import unittest

from agent_irc.server import App, detect_harness, install_signal_handlers

A = "irc://u:p@a.example/"


class FakeConnection:
    instances = []

    def __init__(self, server, channels, nick_base, realname, log, **kw):
        self.server, self.channels, self.nick_base, self.realname = server, channels, nick_base, realname
        self.kw = kw
        self.messages, self.quit = [], None
        self.begin_close_calls = 0
        FakeConnection.instances.append(self)

    def start(self):
        pass

    def send_message(self, text):
        self.messages.append(text)

    def begin_close(self, quit_message):
        self.begin_close_calls += 1
        self.quit = quit_message

    def join(self, timeout=None):
        pass

    def close(self, quit_message, timeout=2.0):
        self.begin_close(quit_message)
        self.join(timeout)


def rpc(id_, method, params=None):
    return json.dumps({"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}}) + "\n"


class DetectTests(unittest.TestCase):
    def test_names(self):
        self.assertEqual(detect_harness({"name": "claude-code", "version": "2.1"}), "claude")
        self.assertEqual(detect_harness({"name": "Codex CLI"}), "codex")
        self.assertEqual(detect_harness({"name": "other"}), "other")
        self.assertEqual(detect_harness(None), "agent")


class AppTests(unittest.TestCase):
    def setUp(self):
        FakeConnection.instances = []
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = os.path.join(self.tmp.name, "home")
        self.cwd = os.path.join(self.tmp.name, "agent-irc")
        os.makedirs(os.path.join(self.home, ".claude"))
        os.makedirs(self.cwd)
        with open(os.path.join(self.home, ".claude", "settings.json"), "w") as f:
            json.dump({"agent-irc": {"channels": [A + "#agents", A + "#log"], "level": "activity"}}, f)
        self.logs = []

    def run_app(self, lines, connection_factory=FakeConnection, debug=None):
        stdin = io.StringIO("".join(lines))
        stdout = io.StringIO()
        app = App(self.home, {"USER": "getty"}, stdin, stdout, self.logs.append,
                  connection_factory=connection_factory, debug=debug, cwd=self.cwd)
        app.run()
        return app, stdout.getvalue()

    def test_session_flow(self):
        sid = "e873ddde-2247-4f84-9e15-527db0caf191"
        app, out = self.run_app([
            rpc(1, "initialize", {"protocolVersion": "2025-06-18", "clientInfo": {"name": "claude-code"}}),
            rpc(2, "tools/call", {"name": "event", "arguments": {"event": "PreToolUse", "tool_name": "Bash"}}),
            rpc(3, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": sid,
                                                                  "cwd": self.cwd, "prompt": "hello"}}),
            rpc(4, "tools/call", {"name": "event", "arguments": {"event": "PostToolUse", "session_id": sid,
                                                                  "tool_name": "Bash", "tool_input": {"command": "ls"}}}),
            rpc(5, "tools/call", {"name": "event", "arguments": {"event": "SessionEnd", "session_id": sid, "reason": "other"}}),
        ])
        self.assertEqual(app.harness, "claude")
        self.assertEqual(len(FakeConnection.instances), 1)
        conn = FakeConnection.instances[0]
        self.assertEqual(conn.channels, ["#agents", "#log"])
        self.assertEqual(conn.nick_base, "agent-irc")
        self.assertEqual(conn.realname, "claude %s %s" % (sid, self.cwd))
        self.assertEqual(conn.messages[0], "▶ session e873ddde · claude · %s" % self.cwd)
        self.assertEqual(conn.messages[1], "» hello")
        self.assertEqual(conn.messages[2], "⚙ Bash: ls")
        self.assertTrue(conn.messages[3].startswith("■ session ended (other) · "))
        self.assertTrue(conn.quit.startswith("session ended · "))
        self.assertIn("1 turns · 1 tools", conn.quit)
        self.assertEqual(len([l for l in out.splitlines() if l]), 5)

    def settings(self, **extra):
        with open(os.path.join(self.home, ".claude", "settings.json"), "w") as f:
            json.dump({"agent-irc": dict({"channels": [A + "#agents"], "level": "activity"}, **extra)}, f)

    def tools(self, out):
        return [t["name"] for t in json.loads(out.splitlines()[1])["result"]["tools"]]

    def test_read_messages_is_not_offered_unless_listening(self):
        app, out = self.run_app([rpc(1, "initialize", {"clientInfo": {"name": "claude-code"}}),
                                 rpc(2, "tools/list")])
        self.assertEqual(self.tools(out), ["event"])
        self.assertFalse(app.inbox.listening)

    def test_listen_in_the_settings_offers_read_messages(self):
        self.settings(listen=True, listen_from=["getty!*@vhost.example"])
        app, out = self.run_app([rpc(1, "initialize", {"clientInfo": {"name": "claude-code"}}),
                                 rpc(2, "tools/list")])
        self.assertEqual(self.tools(out), ["event", "read_messages"])
        self.assertTrue(app.inbox.listening)

    def test_the_connection_feeds_the_inbox_through_the_allowlist(self):
        self.settings(listen=True, listen_from=["getty!*@vhost.example"])
        app = App(self.home, {"USER": "getty"}, io.StringIO(""), io.StringIO(), self.logs.append,
                  connection_factory=FakeConnection, cwd=self.cwd)
        app.on_initialize({"clientInfo": {"name": "claude-code"}})
        app._handle({"event": "UserPromptSubmit", "session_id": "s1", "cwd": self.cwd, "prompt": "hi"})
        on_message = FakeConnection.instances[0].kw["on_message"]
        on_message("getty!getty@vhost.example", "agent-irc-1", "carry on")
        on_message("stranger!x@elsewhere", "agent-irc-1", "ignore me")
        report = app.inbox.report()
        self.assertIn("carry on", report)
        self.assertNotIn("ignore me", report)

    def test_a_session_config_without_listen_turns_it_off_again(self):
        self.settings(listen=True, listen_from=["*"])
        app = App(self.home, {"USER": "getty"}, io.StringIO(""), io.StringIO(), self.logs.append,
                  connection_factory=FakeConnection, cwd=self.cwd)
        app.on_initialize({"clientInfo": {"name": "claude-code"}})
        self.assertTrue(app.inbox.listening)
        self.settings()  # the session's own load reads the file again
        app._handle({"event": "UserPromptSubmit", "session_id": "s1", "cwd": self.cwd, "prompt": "hi"})
        self.assertFalse(app.inbox.listening)

    def test_no_config_means_no_connections(self):
        os.remove(os.path.join(self.home, ".claude", "settings.json"))
        app, _ = self.run_app([
            rpc(1, "initialize", {"clientInfo": {"name": "claude-code"}}),
            rpc(2, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": "s",
                                                                  "cwd": self.cwd, "prompt": "x"}}),
        ])
        self.assertEqual(FakeConnection.instances, [])
        self.assertTrue(any("no channels configured" in l for l in self.logs))

    def test_orphan_session_end_stays_quiet(self):
        # A harness may spin up a fresh server process solely to deliver
        # SessionEnd after the process that held the real session state is
        # already gone (observed live against Claude Code, 2026-09-05: a
        # SIGTERM'd connection followed by a fresh one for just this event).
        # With no prior activity, this process must not announce a phantom
        # session with a false "0 turns" summary.
        app, _ = self.run_app([
            rpc(1, "initialize", {"clientInfo": {"name": "claude-code"}}),
            rpc(2, "tools/call", {"name": "event", "arguments": {"event": "SessionEnd", "session_id": "s",
                                                                  "cwd": self.cwd, "reason": "other"}}),
        ])
        self.assertIsNone(app.session)
        self.assertEqual(FakeConnection.instances, [])
        self.assertTrue(any("SessionEnd with no prior state" in l for l in self.logs))

    def test_new_session_id_replaces_the_running_session(self):
        # /clear or /resume hand the running MCP server a new session_id
        # (and transcript_path) without restarting it. The old Session must
        # not keep counting turns for a session that no longer exists.
        other_cwd = os.path.join(self.tmp.name, "other-project")
        os.makedirs(other_cwd)
        t1 = os.path.join(self.tmp.name, "s1.jsonl")
        t2 = os.path.join(self.tmp.name, "s2.jsonl")
        app, _ = self.run_app([
            rpc(1, "initialize", {"clientInfo": {"name": "claude-code"}}),
            rpc(2, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": "s1",
                                                                  "cwd": self.cwd, "transcript_path": t1,
                                                                  "prompt": "first"}}),
            rpc(3, "tools/call", {"name": "event", "arguments": {"event": "SessionEnd", "session_id": "s1",
                                                                  "reason": "clear"}}),
            rpc(4, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": "s2",
                                                                  "cwd": other_cwd, "transcript_path": t2,
                                                                  "prompt": "second"}}),
        ])
        self.assertEqual(app.session.session_id, "s2")
        self.assertEqual(app.session.turns, 1)
        # The connections opened for s1 are kept, not reopened, for s2.
        self.assertEqual(len(FakeConnection.instances), 1)
        conn = FakeConnection.instances[0]
        session_lines = [m for m in conn.messages if m.startswith("▶ session")]
        self.assertEqual(len(session_lines), 2)
        self.assertIn("▶ session s2 · claude · %s" % other_cwd, session_lines[1])
        self.assertTrue(any("new session s2" in l and "s1" in l for l in self.logs))

    def test_late_events_for_a_replaced_session_do_not_resurrect_it(self):
        # async hooks keep no order: a trailing Stop/SessionEnd for the old
        # session may arrive after the new session's first prompt. Neither
        # may announce the old session again or reset the new one.
        t1 = os.path.join(self.tmp.name, "s1.jsonl")
        t2 = os.path.join(self.tmp.name, "s2.jsonl")
        app, _ = self.run_app([
            rpc(1, "initialize", {"clientInfo": {"name": "claude-code"}}),
            rpc(2, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": "s1",
                                                                  "cwd": self.cwd, "transcript_path": t1,
                                                                  "prompt": "one"}}),
            rpc(3, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": "s2",
                                                                  "cwd": self.cwd, "transcript_path": t2,
                                                                  "prompt": "two"}}),
            rpc(4, "tools/call", {"name": "event", "arguments": {"event": "Stop", "session_id": "s1",
                                                                  "transcript_path": t1}}),
            rpc(5, "tools/call", {"name": "event", "arguments": {"event": "SessionEnd", "session_id": "s1",
                                                                  "reason": "clear"}}),
            rpc(6, "tools/call", {"name": "event", "arguments": {"event": "SessionEnd", "session_id": "never-seen",
                                                                  "reason": "other"}}),
            rpc(7, "tools/call", {"name": "event", "arguments": {"event": "Stop", "session_id": "s2",
                                                                  "transcript_path": t2}}),
        ])
        self.assertEqual(app.session.session_id, "s2")
        self.assertEqual(app.session.turns, 1)
        msgs = FakeConnection.instances[0].messages
        self.assertEqual([m for m in msgs if m.startswith("▶ session")],
                         [m for m in msgs if m.startswith("▶ session s1")] + [m for m in msgs if m.startswith("▶ session s2")])
        self.assertEqual(len([m for m in msgs if m.startswith("▶ session")]), 2)
        self.assertEqual([m for m in msgs if m.startswith("■")], [])
        self.assertEqual(len([m for m in msgs if m.startswith("✔ turn")]), 1)
        self.assertEqual(FakeConnection.instances[0].quit and "1 turns" in FakeConnection.instances[0].quit, True)

    def test_foreign_id_tool_events_stay_with_the_running_session(self):
        # Only a prompt starts a session; a tool event carrying an unknown
        # id (a subagent with its own id, if a harness ever does that) is
        # handled by the running session instead of replacing it.
        t1 = os.path.join(self.tmp.name, "s1.jsonl")
        app, _ = self.run_app([
            rpc(1, "initialize", {"clientInfo": {"name": "claude-code"}}),
            rpc(2, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": "s1",
                                                                  "cwd": self.cwd, "transcript_path": t1,
                                                                  "prompt": "one"}}),
            rpc(3, "tools/call", {"name": "event", "arguments": {"event": "PreToolUse", "session_id": "sub-1",
                                                                  "tool_name": "Bash", "tool_use_id": "t1",
                                                                  "tool_input": {"command": "ls"}}}),
            rpc(4, "tools/call", {"name": "event", "arguments": {"event": "PostToolUse", "session_id": "sub-1",
                                                                  "tool_name": "Bash", "tool_use_id": "t1",
                                                                  "tool_input": {"command": "ls"}}}),
        ])
        self.assertEqual(app.session.session_id, "s1")
        msgs = FakeConnection.instances[0].messages
        self.assertEqual(len([m for m in msgs if m.startswith("▶ session")]), 1)
        self.assertTrue(any(m.startswith("⚙ Bash") for m in msgs), msgs)

    def test_failed_connect_does_not_wedge_the_session(self):
        # If opening the connections raises on the first event, the next
        # event must still start the session (without connections) instead
        # of tripping the rollover branch on a session that has no id yet.
        def broken_factory(*a, **kw):
            raise RuntimeError("can't start thread")
        t1 = os.path.join(self.tmp.name, "s1.jsonl")
        app, _ = self.run_app([
            rpc(1, "initialize", {"clientInfo": {"name": "claude-code"}}),
            rpc(2, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": "s1",
                                                                  "cwd": self.cwd, "transcript_path": t1,
                                                                  "prompt": "one"}}),
            rpc(3, "tools/call", {"name": "event", "arguments": {"event": "Stop", "session_id": "s1",
                                                                  "transcript_path": t1}}),
        ], connection_factory=broken_factory)
        self.assertEqual(app.session.session_id, "s1")
        self.assertEqual(app.session.turns, 0)
        self.assertFalse(any("NoneType" in l for l in self.logs), self.logs)

    def test_flood_and_queue_settings_reach_the_connection(self):
        with open(os.path.join(self.home, ".claude", "settings.json"), "w") as f:
            json.dump({"agent-irc": {"channels": [A + "#agents"], "level": "full",
                                     "flood_burst": 50, "flood_interval": 0.05, "queue_limit": 0}}, f)
        self.run_app([
            rpc(1, "initialize", {"clientInfo": {"name": "claude-code"}}),
            rpc(2, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": "s",
                                                                 "cwd": self.cwd, "prompt": "x"}}),
        ])
        kw = FakeConnection.instances[0].kw
        self.assertEqual(kw["queue_limit"], 0)
        self.assertEqual((kw["bucket"].burst, kw["bucket"].interval), (50.0, 0.05))

    def test_flood_and_queue_default_when_unconfigured(self):
        self.run_app([
            rpc(1, "initialize", {"clientInfo": {"name": "claude-code"}}),
            rpc(2, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": "s",
                                                                 "cwd": self.cwd, "prompt": "x"}}),
        ])
        kw = FakeConnection.instances[0].kw
        self.assertEqual(kw["queue_limit"], 500)
        self.assertEqual((kw["bucket"].burst, kw["bucket"].interval), (4.0, 2.0))

    def test_debug_logs_the_raw_event(self):
        debug = []
        self.run_app([
            rpc(1, "initialize", {"clientInfo": {"name": "claude-code"}}),
            rpc(2, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": "s",
                                                                  "cwd": self.cwd, "prompt": "x"}}),
        ], debug=debug.append)
        self.assertTrue(any("agent-irc: event" in l and '"event": "UserPromptSubmit"' in l for l in debug))

    def test_events_before_session_id_are_ignored(self):
        app, _ = self.run_app([
            rpc(1, "initialize", {"clientInfo": {"name": "codex"}}),
            rpc(2, "tools/call", {"name": "event", "arguments": {"event": "PreToolUse", "session_id": "${session_id}"}}),
        ])
        self.assertIsNone(app.session)
        self.assertEqual(FakeConnection.instances, [])

    def test_one_connection_per_server(self):
        with open(os.path.join(self.home, ".claude", "settings.json"), "w") as f:
            json.dump({"agent-irc": {"channels": [A + "#a", "irc://u:p@b.example/#b", A + "#c"]}}, f)
        self.run_app([
            rpc(1, "initialize", {"clientInfo": {"name": "claude-code"}}),
            rpc(2, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": "s",
                                                                  "cwd": self.cwd, "prompt": "x"}}),
        ])
        self.assertEqual([(c.server.host, c.channels) for c in FakeConnection.instances],
                         [("a.example", ["#a", "#c"]), ("b.example", ["#b"])])

    def test_shutdown_delivers_quit_to_every_connection(self):
        with open(os.path.join(self.home, ".claude", "settings.json"), "w") as f:
            json.dump({"agent-irc": {"channels": [A + "#a", "irc://u:p@b.example/#b"]}}, f)
        self.run_app([
            rpc(1, "initialize", {"clientInfo": {"name": "claude-code"}}),
            rpc(2, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": "s",
                                                                  "cwd": self.cwd, "prompt": "x"}}),
        ])
        self.assertEqual(len(FakeConnection.instances), 2)
        quits = [c.quit for c in FakeConnection.instances]
        self.assertTrue(all(q is not None for q in quits))
        self.assertEqual(quits[0], quits[1])
        self.assertTrue(quits[0].startswith("session ended · "))

    def test_shutdown_is_bounded(self):
        class SlowJoinConnection(FakeConnection):
            def join(self, timeout=None):
                time.sleep(min(timeout if timeout is not None else 5, 5))

        with open(os.path.join(self.home, ".claude", "settings.json"), "w") as f:
            json.dump({"agent-irc": {"channels": [A + "#a", "irc://u:p@b.example/#b"]}}, f)
        start = time.monotonic()
        self.run_app([
            rpc(1, "initialize", {"clientInfo": {"name": "claude-code"}}),
            rpc(2, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": "s",
                                                                  "cwd": self.cwd, "prompt": "x"}}),
        ], connection_factory=SlowJoinConnection)
        elapsed = time.monotonic() - start
        self.assertEqual(len(FakeConnection.instances), 2)
        self.assertLess(elapsed, 3.0)

    def test_shutdown_is_idempotent(self):
        app, _ = self.run_app([
            rpc(1, "initialize", {"clientInfo": {"name": "claude-code"}}),
            rpc(2, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": "s",
                                                                  "cwd": self.cwd, "prompt": "x"}}),
        ])
        self.assertEqual([c.begin_close_calls for c in FakeConnection.instances], [1])
        app.shutdown()
        app.shutdown()
        self.assertEqual([c.begin_close_calls for c in FakeConnection.instances], [1])


class SignalHandlerTests(unittest.TestCase):
    def test_signal_is_ignored_once_the_app_is_already_stopped(self):
        # An EOF-triggered shutdown() sets App.stopped immediately, before
        # it finishes sending the QUIT (see server.py's App.shutdown). A
        # signal landing after that point must not raise SystemExit and
        # unwind the shutdown already in progress -- even though this
        # would be the *first* signal this handler has seen.
        logs = []
        original = signal.getsignal(signal.SIGTERM)
        try:
            install_signal_handlers(logs.append, is_stopped=lambda: True)
            handler = signal.getsignal(signal.SIGTERM)
            handler(signal.SIGTERM, None)  # must not raise
        finally:
            signal.signal(signal.SIGTERM, original)
        self.assertTrue(any("already shutting down" in l for l in logs))

    def test_signal_raises_when_the_app_is_not_stopped(self):
        logs = []
        original = signal.getsignal(signal.SIGTERM)
        try:
            install_signal_handlers(logs.append, is_stopped=lambda: False)
            handler = signal.getsignal(signal.SIGTERM)
            with self.assertRaises(SystemExit):
                handler(signal.SIGTERM, None)
        finally:
            signal.signal(signal.SIGTERM, original)
        self.assertTrue(any("shutting down" in l for l in logs))


if __name__ == "__main__":
    unittest.main()
