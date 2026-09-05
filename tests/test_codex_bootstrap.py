import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STUB = "#!/usr/bin/env python3\nimport sys\nprint('stub', sys.argv[0])\n"


class CodexBootstrapTests(unittest.TestCase):
    def bootstrap_args(self):
        with open(os.path.join(ROOT, ".mcp.codex.json"), encoding="utf-8") as f:
            return json.load(f)["irc"]["args"]

    def make_cache(self, home, marketplace, version, body=STUB):
        d = os.path.join(home, "plugins", "cache", marketplace, "agent-irc", version, "bin")
        os.makedirs(d)
        path = os.path.join(d, "agent-irc")
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
        return path

    def run_bootstrap(self, home):
        env = dict(os.environ, CODEX_HOME=home)
        return subprocess.run([sys.executable] + self.bootstrap_args(), env=env, capture_output=True, text=True, timeout=10)

    def test_runs_the_newest_cached_copy(self):
        with tempfile.TemporaryDirectory() as home:
            old = self.make_cache(home, "getty", "0.0.9")
            os.utime(old, (1, 1))
            new = self.make_cache(home, "getty", "0.1.0")
            result = self.run_bootstrap(home)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "stub " + new)

    def test_fails_loudly_when_not_installed(self):
        with tempfile.TemporaryDirectory() as home:
            result = self.run_bootstrap(home)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("agent-irc", result.stderr)
            self.assertIn(home, result.stderr)


if __name__ == "__main__":
    unittest.main()
