import json
import os
import subprocess
import sys
import tempfile
import unittest

from tests.fakeirc import FakeIrcServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SID = "01a06850-1f0d-7970-a9c5-da84c99a6ef7"


def rpc(id_, method, params):
    return json.dumps({"jsonrpc": "2.0", "id": id_, "method": method, "params": params}) + "\n"


class EndToEndTests(unittest.TestCase):
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
        import signal as _signal
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


if __name__ == "__main__":
    unittest.main()
