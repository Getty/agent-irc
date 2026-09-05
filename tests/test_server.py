import io
import json
import os
import tempfile
import threading
import time
import unittest

from agent_irc.server import App, detect_harness

A = "irc://u:p@a.example/"


class FakeConnection:
    instances = []

    def __init__(self, server, channels, nick_base, realname, log, **kw):
        self.server, self.channels, self.nick_base, self.realname = server, channels, nick_base, realname
        self.messages, self.quit = [], None
        FakeConnection.instances.append(self)

    def start(self):
        pass

    def send_message(self, text):
        self.messages.append(text)

    def begin_close(self, quit_message):
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

    def run_app(self, lines, connection_factory=FakeConnection):
        stdin = io.StringIO("".join(lines))
        stdout = io.StringIO()
        app = App(self.home, {"USER": "getty"}, stdin, stdout, self.logs.append, connection_factory=connection_factory)
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


if __name__ == "__main__":
    unittest.main()
