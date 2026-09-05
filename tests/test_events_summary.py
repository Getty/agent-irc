import unittest

from agent_irc.events import G, clean, display_tool_name, tool_summary

CWD = "/home/g/dev/proj"
HOME = "/home/g"


class CleanTests(unittest.TestCase):
    def test_drops_empty_and_placeholders(self):
        ev = {"event": "Stop", "prompt": "", "model": None, "agent_id": "${agent_id}", "cwd": "/x"}
        self.assertEqual(clean(ev), {"event": "Stop", "cwd": "/x"})

    def test_parses_json_tool_input_string(self):
        self.assertEqual(clean({"tool_input": '{"command": "ls"}'})["tool_input"], {"command": "ls"})
        self.assertEqual(clean({"tool_input": "{broken"})["tool_input"], "{broken")
        self.assertEqual(clean({"tool_input": {"a": 1}})["tool_input"], {"a": 1})

    def test_none(self):
        self.assertEqual(clean(None), {})


class ToolSummaryTests(unittest.TestCase):
    def s(self, name, inp):
        return tool_summary(name, inp, CWD, HOME)

    def test_shell(self):
        self.assertEqual(self.s("Bash", {"command": "ls -la\nfind ."}), "ls -la")
        self.assertEqual(self.s("shell", {"command": ["bash", "-lc", "make test"]}), "bash -lc make test")
        self.assertEqual(self.s("exec_command", {"cmd": "pwd"}), "pwd")
        self.assertEqual(len(self.s("Bash", {"command": "x" * 300})), 120)

    def test_files(self):
        self.assertEqual(self.s("Read", {"file_path": CWD + "/hooks/hooks.json"}), "hooks/hooks.json")
        self.assertEqual(self.s("Edit", {"file_path": HOME + "/x.py"}), "~/x.py")
        self.assertEqual(self.s("NotebookEdit", {"notebook_path": "/etc/n.ipynb"}), "/etc/n.ipynb")

    def test_grep_glob(self):
        self.assertEqual(self.s("Grep", {"pattern": "hook_event", "path": CWD + "/agent_irc"}), "hook_event agent_irc")
        self.assertEqual(self.s("Glob", {"pattern": "**/*.py"}), "**/*.py")

    def test_agent(self):
        self.assertEqual(self.s("Agent", {"subagent_type": "Explore", "description": "find hook payloads", "prompt": "long"}),
                         "Explore: find hook payloads")
        self.assertEqual(self.s("Agent", {"prompt": "do it"}), "agent: do it")

    def test_web_and_skill(self):
        self.assertEqual(self.s("WebFetch", {"url": "https://x.y/z", "prompt": "p"}), "https://x.y/z")
        self.assertEqual(self.s("WebSearch", {"query": "irc numerics"}), "irc numerics")
        self.assertEqual(self.s("Skill", {"skill": "brainstorming", "args": "x"}), "brainstorming")

    def test_apply_patch(self):
        patch = "*** Begin Patch\n*** Update File: lib/a.py\n@@\n*** Add File: /home/g/dev/proj/b.py\n*** End Patch"
        self.assertEqual(self.s("apply_patch", {"patch": patch}), "lib/a.py, b.py")
        self.assertEqual(self.s("apply_patch", patch), "lib/a.py, b.py")

    def test_mcp_and_fallback(self):
        self.assertEqual(display_tool_name("mcp__context7__query-docs"), "query-docs")
        self.assertEqual(display_tool_name("Bash"), "Bash")
        self.assertEqual(self.s("mcp__context7__query-docs", {"libraryId": "/x/y", "n": 3}), "/x/y")
        self.assertEqual(self.s("TodoWrite", {"todos": [1, 2]}), "")
        self.assertEqual(self.s("Unknown", None), "")
        self.assertEqual(self.s("Unknown", "raw text\nmore"), "raw text")


class GlyphTests(unittest.TestCase):
    def test_glyphs(self):
        self.assertEqual([G[k] for k in ("start", "end", "prompt", "tool", "fail", "sub_start", "sub_stop",
                                         "turn", "perm", "idle", "compact", "model")],
                         ["▶", "■", "»", "⚙", "✖", "⇢", "⇠", "✔", "⚠", "…", "⟲", "⇄"])


if __name__ == "__main__":
    unittest.main()
