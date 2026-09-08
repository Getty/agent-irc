import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

from tests.fakeirc import FakeIrcServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SID = "01a06850-1f0d-7970-a9c5-da84c99a6ef7"


def rpc(id_, method, params):
    return json.dumps({"jsonrpc": "2.0", "id": id_, "method": method, "params": params}) + "\n"


class EndToEndTests(unittest.TestCase):
    def test_full_level_sends_a_large_tool_input_whole(self):
        """The point of level full: a 600-line Write reaches IRC as 600 lines.

        Needs all three of the tuning numbers -- the default bucket sends one
        line every two seconds and the default queue drops everything past
        500 -- and a server whose LINELEN says a 5000-byte line fits in one
        PRIVMSG.
        """
        fake = FakeIrcServer(isupport=("LINELEN=8192",))
        self.addCleanup(fake.close)
        with tempfile.TemporaryDirectory() as tmp:
            home = os.path.join(tmp, "home")
            cwd = os.path.join(tmp, "proj")
            os.makedirs(os.path.join(home, ".codex"))
            os.makedirs(cwd)
            with open(os.path.join(home, ".codex", "config.toml"), "w") as f:
                f.write('[agent-irc]\nchannels = ["irc://getty@127.0.0.1:%d/#agents"]\n'
                        'level = "full"\nflood_burst = 2000\nflood_interval = 0.0005\nqueue_limit = 0\n' % fake.port)
            env = dict(os.environ, HOME=home, USER="getty")
            proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "bin", "agent-irc")], cwd=cwd, env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.addCleanup(proc.kill)
            content = "\n".join("line %d" % i for i in range(600)) + "\n" + "y" * 5000
            proc.stdin.write("".join([
                rpc(1, "initialize", {"protocolVersion": "2025-06-18", "clientInfo": {"name": "codex"}}),
                rpc(2, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": SID,
                                                                      "cwd": cwd, "prompt": "write it"}}),
                rpc(3, "tools/call", {"name": "event", "arguments": {"event": "PostToolUse", "session_id": SID,
                                                                      "tool_name": "Write", "tool_use_id": "w1",
                                                                      "tool_input": {"file_path": cwd + "/big.txt",
                                                                                     "content": content}}}),
            ]))
            proc.stdin.flush()
            self.assertTrue(fake.wait_for(lambda ls: "PRIVMSG #agents :    line 599" in ls, timeout=30),
                            "last body line never arrived")
            self.assertTrue(fake.wait_for(lambda ls: "PRIVMSG #agents :    " + "y" * 5000 in ls, timeout=30),
                            "the 5000-byte line did not fit one PRIVMSG")
            out, err = proc.communicate("", timeout=30)
            self.assertEqual(proc.returncode, 0, err)
        lines = fake.lines()
        sent = [l for l in lines if l.startswith("PRIVMSG #agents :")]
        for i in range(600):
            self.assertIn("PRIVMSG #agents :    line %d" % i, sent)
        self.assertFalse([l for l in sent if "dropped" in l], "lines were dropped at level full")

    def test_subprocess_mirrors_session_and_quits_on_eof(self):
        fake = FakeIrcServer(password="pw")
        self.addCleanup(fake.close)
        with tempfile.TemporaryDirectory() as tmp:
            home = os.path.join(tmp, "home")
            cwd = os.path.join(tmp, "simpici")
            os.makedirs(os.path.join(home, ".codex"))
            os.makedirs(cwd)
            with open(os.path.join(home, ".codex", "config.toml"), "w") as f:
                f.write('[agent-irc]\nchannels = ["irc://getty:${IRC_PW}@127.0.0.1:%d/#agents"]\n' % fake.port)
            env = dict(os.environ, HOME=home, IRC_PW="pw", USER="getty")
            proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "bin", "agent-irc")], cwd=cwd, env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            messages = [
                rpc(1, "initialize", {"protocolVersion": "2025-06-18", "clientInfo": {"name": "codex", "version": "0.153"}}),
                rpc(2, "tools/list", {}),
                rpc(3, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": SID,
                                                                      "cwd": cwd, "model": "gpt-5.6-sol", "prompt": "hi"}}),
                rpc(4, "tools/call", {"name": "event", "arguments": {"event": "PreToolUse", "session_id": SID,
                                                                      "tool_name": "shell", "tool_use_id": "c1",
                                                                      "tool_input": {"command": ["bash", "-lc", "ls"]}}}),
                rpc(5, "tools/call", {"name": "event", "arguments": {"event": "PostToolUse", "session_id": SID,
                                                                      "tool_name": "shell", "tool_use_id": "c1"}}),
            ]
            out, err = proc.communicate("".join(messages), timeout=20)
            self.assertEqual(proc.returncode, 0, err)
            responses = [json.loads(l) for l in out.splitlines() if l.strip()]
            self.assertEqual([r["id"] for r in responses], [1, 2, 3, 4, 5])
            self.assertEqual(responses[0]["result"]["serverInfo"]["name"], "agent-irc")
            self.assertTrue(fake.wait_for(lambda ls: any(l.startswith("QUIT :session ended") for l in ls)))
            lines = fake.lines()
            self.assertEqual(lines[:3], ["PASS :pw", "NICK simpici-1", "USER getty 0 * :codex %s %s" % (SID, cwd)])
            self.assertIn("JOIN #agents", lines)
            self.assertIn("PRIVMSG #agents :▶ session 01a06850 · codex gpt-5.6-sol · %s" % cwd, lines)
            self.assertIn("PRIVMSG #agents :» hi", lines)
            self.assertTrue(any(l.startswith("PRIVMSG #agents :⚙ shell 0.") and l.endswith(": bash -lc ls") for l in lines), lines)
            self.assertIn("initialized by codex", err)

    def test_an_irc_message_reaches_the_agent_through_read_messages(self):
        """The one inbound path: a DM waits until the agent asks for it.

        Nothing wakes the session -- neither harness lets an MCP server do
        that -- so the message sits in the inbox until a tools/call fetches
        it, which is what a looping agent does once per iteration.
        """
        fake = FakeIrcServer()
        self.addCleanup(fake.close)
        with tempfile.TemporaryDirectory() as tmp:
            home = os.path.join(tmp, "home")
            cwd = os.path.join(tmp, "proj")
            os.makedirs(os.path.join(home, ".claude"))
            os.makedirs(cwd)
            with open(os.path.join(home, ".claude", "settings.json"), "w") as f:
                json.dump({"agent-irc": {"channels": ["irc://127.0.0.1:%d/#agents" % fake.port],
                                         "listen": True,
                                         "listen_from": ["getty!*@vhost.example"]}}, f)
            env = dict(os.environ, HOME=home, USER="getty")
            proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "bin", "agent-irc")], cwd=cwd, env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.addCleanup(proc.kill)

            def call(id_, method, params):
                proc.stdin.write(rpc(id_, method, params))
                proc.stdin.flush()
                return json.loads(proc.stdout.readline())

            call(1, "initialize", {"protocolVersion": "2025-06-18", "clientInfo": {"name": "claude-code"}})
            listed = call(2, "tools/list", {})
            self.assertEqual([t["name"] for t in listed["result"]["tools"]], ["event", "read_messages"])

            call(3, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": SID,
                                                                  "cwd": cwd, "prompt": "hi"}})
            self.assertTrue(fake.wait_for(lambda ls: "JOIN #agents" in ls))
            fake.send_to_all(":stranger!x@elsewhere PRIVMSG proj-1 :ignore me")
            fake.send_to_all(":getty!getty@vhost.example PRIVMSG #agents :not for anyone")
            fake.send_to_all(":getty!getty@vhost.example PRIVMSG proj-1 :carry on")
            fake.send_to_all(":getty!getty@vhost.example PRIVMSG #agents :proj-1: and this")

            deadline = time.time() + 10
            report = ""
            while time.time() < deadline:
                report = call(4, "tools/call", {"name": "read_messages", "arguments": {}})["result"]["content"][0]["text"]
                if "and this" in report:
                    break
                time.sleep(0.1)
            self.assertIn("carry on", report)
            self.assertIn("→ dm:", report)
            self.assertIn("→ #agents: proj-1: and this", report)
            self.assertNotIn("ignore me", report, "the allowlist let a stranger through")
            self.assertNotIn("not for anyone", report, "a channel line that never named us was kept")
            self.assertIn("Untrusted", report)

            drained = call(5, "tools/call", {"name": "read_messages", "arguments": {}})["result"]["content"][0]["text"]
            self.assertIn("No IRC messages waiting.", drained)

            out, err = proc.communicate("", timeout=20)
            self.assertEqual(proc.returncode, 0, err)
        # Nothing of the inbound traffic goes back out to IRC: read-only.
        self.assertFalse([l for l in fake.lines() if "carry on" in l or "and this" in l], fake.lines())

    def start_session(self, fake, tmp):
        home = os.path.join(tmp, "home")
        cwd = os.path.join(tmp, "proj")
        os.makedirs(os.path.join(home, ".claude"))
        os.makedirs(cwd)
        with open(os.path.join(home, ".claude", "settings.json"), "w") as f:
            json.dump({"agent-irc": {"channels": ["irc://127.0.0.1:%d/#sig" % fake.port]}}, f)
        env = dict(os.environ, HOME=home, USER="getty")
        proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "bin", "agent-irc")], cwd=cwd, env=env,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        proc.stdin.write(rpc(1, "initialize", {"protocolVersion": "2025-06-18", "clientInfo": {"name": "claude-code"}}))
        proc.stdin.write(rpc(2, "tools/call", {"name": "event", "arguments": {"event": "UserPromptSubmit", "session_id": SID,
                                                                             "cwd": cwd, "prompt": "hi"}}))
        proc.stdin.flush()
        self.assertTrue(fake.wait_for(lambda ls: "PRIVMSG #sig :» hi" in ls))
        return proc

    def assert_quits_on(self, signum):
        fake = FakeIrcServer()
        self.addCleanup(fake.close)
        with tempfile.TemporaryDirectory() as tmp:
            proc = self.start_session(fake, tmp)
            proc.send_signal(signum)
            self.assertTrue(fake.wait_for(lambda ls: any(l.startswith("QUIT :session ended") for l in ls), timeout=5))
            out, err = proc.communicate(timeout=10)
            self.assertEqual(proc.returncode, 128 + signum, err)
            self.assertNotIn("Traceback", err)

    def test_sigterm_sends_quit(self):
        import signal
        self.assert_quits_on(signal.SIGTERM)

    def test_sigint_sends_quit(self):
        import signal
        self.assert_quits_on(signal.SIGINT)

    def test_sigint_then_sigterm_still_sends_quit(self):
        # Live-observed (Task 20, 2026-09-05): Claude Code sends SIGINT, and
        # ~100ms later, having found the process still alive, escalates to
        # SIGTERM -- close enough behind the first signal to land while
        # shutdown() is still blocked inside a join(). Reproduces the race.
        import signal
        fake = FakeIrcServer()
        self.addCleanup(fake.close)
        with tempfile.TemporaryDirectory() as tmp:
            proc = self.start_session(fake, tmp)
            proc.send_signal(signal.SIGINT)
            time.sleep(0.1)
            proc.send_signal(signal.SIGTERM)
            self.assertTrue(fake.wait_for(lambda ls: any(l.startswith("QUIT :session ended") for l in ls), timeout=5))
            out, err = proc.communicate(timeout=10)
            self.assertEqual(proc.returncode, 128 + signal.SIGINT, err)
            self.assertNotIn("Traceback", err)


if __name__ == "__main__":
    unittest.main()
