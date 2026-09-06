import json
import os
import tempfile
import unittest
from unittest import mock

from agent_irc import config

CODEX_TOML = """
approval_policy = "on-request"

[projects."/home/g"]
trust_level = "trusted"

[agent-irc]
channels = ["ircs://u:p@h/#a", 'irc://h/#b']
log_channels = [
  "ircs://u:p@h/#log",  # comment
]
level = "full"
flood_burst = 2000
flood_interval = 0.0005
queue_limit = 0
ignored = 3

[other]
channels = ["irc://h/#not-ours"]
"""


class TomlFallbackTests(unittest.TestCase):
    def test_parse_table(self):
        t = config.parse_toml_table(CODEX_TOML, "agent-irc")
        self.assertEqual(t["channels"], ["ircs://u:p@h/#a", "irc://h/#b"])
        self.assertEqual(t["log_channels"], ["ircs://u:p@h/#log"])
        self.assertEqual(t["level"], "full")
        self.assertEqual(t["flood_burst"], 2000)
        self.assertEqual(t["flood_interval"], 0.0005)
        self.assertEqual(t["queue_limit"], 0)
        self.assertEqual(t["ignored"], 3)  # parsed here, dropped by merge_layers

    def test_parse_quoted_table_name(self):
        t = config.parse_toml_table(CODEX_TOML, 'projects."/home/g"')
        self.assertEqual(t, {"trust_level": "trusted"})

    def test_missing_table(self):
        self.assertEqual(config.parse_toml_table(CODEX_TOML, "nothing"), {})

    def test_escapes(self):
        t = config.parse_toml_table('[agent-irc]\nx = "a\\"b\\\\c"\n', "agent-irc")
        self.assertEqual(t["x"], 'a"b\\c')

    def test_bracket_inside_quoted_string(self):
        t = config.parse_toml_table('[agent-irc]\nchannels = ["irc://h/#a]b", "irc://h/#c"]\n', "agent-irc")
        self.assertEqual(t["channels"], ["irc://h/#a]b", "irc://h/#c"])

    def test_comment_with_quotes_inside_array(self):
        text = '[agent-irc]\nchannels = [\n  "irc://h/#a",  # not "this" one\n  "irc://h/#b",\n]\nlevel = "full"\n'
        t = config.parse_toml_table(text, "agent-irc")
        self.assertEqual(t["channels"], ["irc://h/#a", "irc://h/#b"])
        self.assertEqual(t["level"], "full")

    def test_numbers(self):
        text = ("[agent-irc]\na = 0\nb = -7\nc = 1_000\nd = 0.5\n"
                "e = 2.5e-3\nf = 12  # trailing comment\n")
        t = config.parse_toml_table(text, "agent-irc")
        self.assertEqual(t, {"a": 0, "b": -7, "c": 1000, "d": 0.5, "e": 2.5e-3, "f": 12})
        self.assertIsInstance(t["a"], int)
        self.assertIsInstance(t["d"], float)

    def test_values_that_are_not_strings_or_numbers_are_skipped(self):
        # A bare date must not be read as the year, and a key we cannot
        # represent is left out rather than guessed at.
        t = config.parse_toml_table('[agent-irc]\nd = 1979-05-27\nb = true\nlevel = "full"\n', "agent-irc")
        self.assertEqual(t, {"level": "full"})

    def test_unterminated_array_keeps_what_it_read(self):
        t = config.parse_toml_table('[agent-irc]\nchannels = ["irc://h/#a"\n', "agent-irc")
        self.assertEqual(t["channels"], ["irc://h/#a"])


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name

    def write(self, name, content):
        path = os.path.join(self.dir, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return path

    def test_json_namespace(self):
        p = self.write("s.json", json.dumps({"agent-irc": {"channels": ["irc://h/#a"]}, "model": "x"}))
        self.assertEqual(config.read_json_namespace(p), {"channels": ["irc://h/#a"]})

    def test_json_missing_or_invalid(self):
        self.assertEqual(config.read_json_namespace(os.path.join(self.dir, "nope.json")), {})
        p = self.write("bad.json", "{not json")
        logs = []
        self.assertEqual(config.read_json_namespace(p, logs.append), {})
        self.assertTrue(logs and "invalid JSON" in logs[0])
        p = self.write("wrong.json", json.dumps({"agent-irc": "string"}))
        self.assertEqual(config.read_json_namespace(p), {})

    def test_toml_namespace_with_tomllib_if_available(self):
        p = self.write("config.toml", CODEX_TOML)
        t = config.read_toml_namespace(p)
        self.assertEqual(t["channels"], ["ircs://u:p@h/#a", "irc://h/#b"])
        self.assertEqual(t["level"], "full")

    def test_toml_namespace_fallback(self):
        p = self.write("config.toml", CODEX_TOML)
        with mock.patch.object(config, "_load_toml", return_value=None):
            t = config.read_toml_namespace(p)
        self.assertEqual(t["log_channels"], ["ircs://u:p@h/#log"])
        # The tuning numbers reach the fallback too -- without them a Python
        # older than 3.11 silently runs on the default bucket and queue cap.
        self.assertEqual(t["flood_burst"], 2000)
        self.assertEqual(t["flood_interval"], 0.0005)
        self.assertEqual(t["queue_limit"], 0)

    def test_toml_missing(self):
        self.assertEqual(config.read_toml_namespace(os.path.join(self.dir, "nope.toml")), {})


class TrustTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name
        os.makedirs(os.path.join(self.home, ".codex"))

    def test_ancestors(self):
        self.assertEqual(config.ancestors("/a/b/c"), ["/a/b/c", "/a/b", "/a", "/"])

    def test_claude_trust_inherited(self):
        with open(os.path.join(self.home, ".claude.json"), "w") as f:
            json.dump({"projects": {"/home/g/dev": {"hasTrustDialogAccepted": True},
                                    "/home/g/other": {"hasTrustDialogAccepted": False}}}, f)
        self.assertTrue(config.is_trusted("claude", "/home/g/dev/proj", self.home))
        self.assertFalse(config.is_trusted("claude", "/home/g/other", self.home))
        self.assertFalse(config.is_trusted("claude", "/tmp/x", self.home))

    def test_claude_trust_missing_file(self):
        self.assertFalse(config.is_trusted("claude", "/home/g/dev", self.home))

    def test_codex_trust_inherited(self):
        with open(os.path.join(self.home, ".codex", "config.toml"), "w") as f:
            f.write(CODEX_TOML)
        self.assertTrue(config.is_trusted("codex", "/home/g/dev/proj", self.home))
        self.assertFalse(config.is_trusted("codex", "/home/other", self.home))

    def test_codex_trust_fallback_parser(self):
        with open(os.path.join(self.home, ".codex", "config.toml"), "w") as f:
            f.write(CODEX_TOML)
        with mock.patch.object(config, "_load_toml", return_value=None):
            self.assertTrue(config.is_trusted("codex", "/home/g/dev/proj", self.home))
            self.assertFalse(config.is_trusted("codex", "/home/other", self.home))


if __name__ == "__main__":
    unittest.main()
