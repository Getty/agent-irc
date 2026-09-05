import json
import os
import tempfile
import unittest

from agent_irc import config

A = "ircs://a.example/"
B = "ircs://b.example/"


def targets(cfg):
    return [(t.server.host, t.channel) for t in cfg.targets]


class MergeTests(unittest.TestCase):
    def test_named_lists_override_by_name(self):
        user = {"channels": [A + "#agents"], "log_channels": [A + "#log"], "level": "activity"}
        cases = [
            ({}, ["#agents", "#log"]),
            ({"simpici_channels": [A + "#simpici"]}, ["#agents", "#log", "#simpici"]),
            ({"channels": [B + "#foo"]}, ["#foo", "#log"]),
            ({"channels": [B + "#foo"], "log_channels": []}, ["#foo"]),
            ({"channels": [], "log_channels": []}, []),
        ]
        for project, expected in cases:
            lists, level = config.merge_layers([user, project])
            got = [config.parse_url(u, "x").channel for name in lists for u in lists[name]]
            self.assertEqual(got, expected, project)
            self.assertEqual(level, "activity")

    def test_level_most_specific_wins_and_validates(self):
        self.assertEqual(config.merge_layers([{"level": "full"}, {"level": "subactivity"}])[1], "subactivity")
        self.assertEqual(config.merge_layers([{"level": "full"}, {"level": "bogus"}])[1], "full")
        self.assertEqual(config.merge_layers([{}])[1], "activity")

    def test_ignores_junk(self):
        lists, _ = config.merge_layers([{"channels": "notalist", "Channels": [], "x_channels_y": [], "foo": 1},
                                        None, {"team_channels": [A + "#t", 5]}])
        self.assertEqual(lists, {"team_channels": [A + "#t"]})

    def test_resolve_dedupes_and_skips_bad_entries(self):
        logs = []
        lists = {"channels": [A + "#a", A + "#a", "ircs://u:${PW}@c.example/#c", "junk"],
                 "other_channels": [A + "#b"]}
        got = config.resolve_targets(lists, {"HOME": "/x"}, "me", logs.append)
        self.assertEqual([(t.server.host, t.channel) for t in got],
                         [("a.example", "#a"), ("a.example", "#b")])
        self.assertEqual(len(logs), 2)
        self.assertIn("${PW} is not set", logs[0])
        self.assertIn("junk", logs[1])

    def test_resolve_expands_env(self):
        got = config.resolve_targets({"channels": ["ircs://${USER}:${PW}@h/#c"]}, {"USER": "me", "PW": "s"}, "x")
        self.assertEqual((got[0].server.user, got[0].server.password), ("me", "s"))

    def test_resolve_logs_redact_expanded_password(self):
        logs = []
        got = config.resolve_targets({"channels": ["ircs://u:${PW}@h:notaport/#c"]}, {"PW": "p@ss:word"}, "x", logs.append)
        self.assertEqual(got, [])
        self.assertEqual(len(logs), 1)
        self.assertNotIn("ss:word", logs[0])
        self.assertIn("***@h", logs[0])


class LoadConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = os.path.join(self.tmp.name, "home")
        self.cwd = os.path.join(self.tmp.name, "proj")
        for d in (".claude", ".codex"):
            os.makedirs(os.path.join(self.home, d))
            os.makedirs(os.path.join(self.cwd, d))

    def write(self, rel, content):
        path = os.path.join(self.tmp.name, rel)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content if isinstance(content, str) else json.dumps(content))

    def trust(self):
        self.write("home/.claude.json", {"projects": {self.cwd: {"hasTrustDialogAccepted": True}}})
        with open(os.path.join(self.home, ".codex", "config.toml"), "a") as f:
            f.write('\n[projects."%s"]\ntrust_level = "trusted"\n' % self.cwd)

    def test_claude_layers(self):
        self.write("home/.claude/settings.json", {"agent-irc": {"channels": [A + "#agents"], "log_channels": [A + "#log"]}})
        self.write("proj/.claude/settings.json", {"agent-irc": {"channels": [B + "#foo"]}})
        self.write("proj/.claude/settings.local.json", {"agent-irc": {"level": "full", "log_channels": []}})
        self.trust()
        cfg = config.load_config("claude", self.cwd, self.home, {"USER": "me"})
        self.assertEqual(targets(cfg), [("b.example", "#foo")])
        self.assertEqual(cfg.level, "full")

    def test_claude_untrusted_ignores_project(self):
        self.write("home/.claude/settings.json", {"agent-irc": {"channels": [A + "#agents"]}})
        self.write("proj/.claude/settings.json", {"agent-irc": {"channels": [B + "#evil"], "level": "full"}})
        logs = []
        cfg = config.load_config("claude", self.cwd, self.home, {"USER": "me"}, logs.append)
        self.assertEqual(targets(cfg), [("a.example", "#agents")])
        self.assertEqual(cfg.level, "activity")
        self.assertTrue(any("not trusted" in l for l in logs))

    def test_codex_layers(self):
        self.write("home/.codex/config.toml", '[agent-irc]\nchannels = ["%s#agents"]\nlog_channels = ["%s#log"]\n' % (A, A))
        self.write("proj/.codex/config.toml", '[agent-irc]\nsimpici_channels = ["%s#simpici"]\nlevel = "subactivity"\n' % A)
        self.trust()
        cfg = config.load_config("codex", self.cwd, self.home, {"USER": "me"})
        self.assertEqual(targets(cfg), [("a.example", "#agents"), ("a.example", "#log"), ("a.example", "#simpici")])
        self.assertEqual(cfg.level, "subactivity")

    def test_no_config_at_all(self):
        cfg = config.load_config("claude", self.cwd, self.home, {})
        self.assertEqual(cfg.targets, [])
        self.assertEqual(cfg.level, "activity")

    def test_default_user_from_env(self):
        self.write("home/.claude/settings.json", {"agent-irc": {"channels": [A + "#a"]}})
        cfg = config.load_config("claude", self.cwd, self.home, {"USER": "getty"})
        self.assertEqual(cfg.targets[0].server.user, "getty")
        cfg = config.load_config("claude", self.cwd, self.home, {})
        self.assertEqual(cfg.targets[0].server.user, "agent")

    def test_codex_untrusted_ignores_project(self):
        self.write("home/.codex/config.toml", '[agent-irc]\nchannels = ["%s#agents"]\n' % A)
        self.write("proj/.codex/config.toml", '[agent-irc]\nchannels = ["%s#evil"]\nlevel = "full"\n' % B)
        logs = []
        cfg = config.load_config("codex", self.cwd, self.home, {"USER": "me"}, logs.append)
        self.assertEqual(targets(cfg), [("a.example", "#agents")])
        self.assertEqual(cfg.level, "activity")
        self.assertTrue(any("not trusted" in l for l in logs))


if __name__ == "__main__":
    unittest.main()
