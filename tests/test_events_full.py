"""Level "full" shortens nothing: every tool input reaches IRC whole (spec §8)."""

import unittest

from agent_irc.events import Session, tool_summary

HOME = "/home/g"
CWD = "/home/g/dev/proj"


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


class FullSummaryTests(unittest.TestCase):
    def f(self, name, inp):
        return tool_summary(name, inp, CWD, HOME, limit=None)

    def test_a_long_value_is_not_cut(self):
        self.assertEqual(self.f("Bash", {"command": "x" * 300}), "x" * 300)
        self.assertEqual(self.f("WebFetch", {"url": "https://x.y/" + "z" * 300}), "https://x.y/" + "z" * 300)
        self.assertEqual(self.f("Agent", {"subagent_type": "Explore", "description": "d" * 300}),
                         "Explore: " + "d" * 300)

    def test_the_head_is_the_first_line_not_the_folded_whole(self):
        """The body underneath carries every line; folding them into the head too
        would send an 800-line file twice."""
        self.assertEqual(self.f("Bash", {"command": "ls -la\nfind ."}), "ls -la [+1 line]")
        self.assertEqual(self.f("Bash", {"command": "head\n" + "x" * 300}), "head [+1 line]")

    def test_shorter_levels_still_cut(self):
        self.assertEqual(len(tool_summary("Bash", {"command": "x" * 300}, CWD, HOME)), 120)


class FullBodyTests(unittest.TestCase):
    def setUp(self):
        self.s = Session("claude", "full", CWD, HOME, clock=Clock())
        self.s.handle({"event": "UserPromptSubmit", "session_id": "abc12345", "cwd": CWD, "prompt": "go"})

    def tool(self, name, tool_input):
        return self.s.handle({"event": "PostToolUse", "session_id": "abc12345", "tool_name": name,
                              "tool_use_id": "t1", "tool_input": tool_input})

    def test_a_written_file_goes_out_whole(self):
        self.assertEqual(self.tool("Write", {"file_path": CWD + "/x.py", "content": "one\ntwo"}),
                         ["⚙ Write: x.py",
                          "  file_path: /home/g/dev/proj/x.py",
                          "  content:",
                          "    one",
                          "    two"])

    def test_a_shell_command_is_one_field_among_the_others(self):
        self.assertEqual(self.tool("Bash", {"command": "cat <<'EOF'\nhi\nEOF", "description": "demo"}),
                         ["⚙ Bash: cat <<'EOF' [+2 lines]",
                          "  command:",
                          "    cat <<'EOF'",
                          "    hi",
                          "    EOF",
                          "  description: demo"])

    def test_an_unknown_tool_renders_every_field(self):
        self.assertEqual(self.tool("mcp__x__y", {"a": "1", "b": "2"}), ["⚙ y: 1", "  a: 1", "  b: 2"])

    def test_values_that_are_not_strings_are_json(self):
        self.assertEqual(self.tool("TodoWrite", {"todos": [{"c": "a"}], "n": 2}),
                         ["⚙ TodoWrite", '  todos: [{"c": "a"}]', "  n: 2"])

    def test_a_raw_string_input_is_a_block_of_its_own(self):
        patch = "*** Begin Patch\n*** Update File: a.py\n*** End Patch"
        self.assertEqual(self.tool("apply_patch", patch),
                         ["⚙ apply_patch: a.py", "  *** Begin Patch", "  *** Update File: a.py", "  *** End Patch"])

    def test_a_body_that_repeats_the_head_is_left_out(self):
        self.assertEqual(self.tool("Read", {"file_path": CWD + "/x.py"}), ["⚙ Read: x.py"])
        self.assertEqual(self.tool("Bash", {"command": "ls -la"}), ["⚙ Bash: ls -la"])

    def test_a_prompt_is_not_cut_either(self):
        s = Session("claude", "full", CWD, HOME, clock=Clock())
        lines = s.handle({"event": "UserPromptSubmit", "session_id": "abc12345", "cwd": CWD, "prompt": "y" * 300})
        self.assertEqual(lines[1:], ["» " + "y" * 300])

    def test_a_single_line_prompt_is_not_repeated_as_a_body(self):
        """The » head already is the whole one-line prompt; a body under it sent it twice."""
        s = Session("claude", "full", CWD, HOME, clock=Clock())
        lines = s.handle({"event": "UserPromptSubmit", "session_id": "abc12345", "cwd": CWD,
                          "prompt": "fix the bug"})
        self.assertEqual(lines[1:], ["» fix the bug"])

    def test_a_multiline_prompt_keeps_its_first_line_only_in_the_head(self):
        s = Session("claude", "full", CWD, HOME, clock=Clock())
        lines = s.handle({"event": "UserPromptSubmit", "session_id": "abc12345", "cwd": CWD,
                          "prompt": "first line\nsecond line"})
        self.assertEqual(lines[1:], ["» first line", "  second line"])

    def test_shorter_levels_send_no_body(self):
        s = Session("claude", "subactivity", CWD, HOME, clock=Clock())
        s.handle({"event": "UserPromptSubmit", "session_id": "abc12345", "cwd": CWD, "prompt": "go"})
        self.assertEqual(s.handle({"event": "PostToolUse", "session_id": "abc12345", "tool_name": "Write",
                                   "tool_use_id": "t1", "tool_input": {"file_path": "/x", "content": "a\nb"}}),
                         ["⚙ Write: /x"])


if __name__ == "__main__":
    unittest.main()
