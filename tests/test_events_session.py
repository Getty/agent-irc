import json
import os
import tempfile
import unittest
from unittest import mock

from agent_irc.events import Session

HOME = "/home/g"
CWD = "/home/g/dev/agent-irc"


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t

    def tick(self, seconds):
        self.t += seconds


def assistant(req, usage, model="claude-fable-5-1", tools=0):
    return {"type": "assistant", "requestId": req, "timestamp": "2026-09-05T03:31:09.342Z",
            "message": {"model": model, "usage": usage,
                        "content": [{"type": "tool_use"}] * tools or [{"type": "text"}]}}


class SessionCoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.transcript = os.path.join(self.tmp.name, "sess.jsonl")
        self.clock = Clock()
        self.s = Session("claude", "activity", CWD, HOME, clock=self.clock)

    def base(self, **kw):
        ev = {"session_id": "e873ddde-2247-4f84-9e15-527db0caf191", "cwd": CWD,
              "transcript_path": self.transcript}
        ev.update(kw)
        return ev

    def append(self, *records):
        with open(self.transcript, "a", encoding="utf-8") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")

    def test_session_line_on_first_event_without_model(self):
        lines = self.s.handle(self.base(event="UserPromptSubmit", prompt="hello\nworld"))
        self.assertEqual(lines, ["▶ session e873ddde · claude · ~/dev/agent-irc", "» hello"])
        self.assertEqual(self.s.session_id, "e873ddde-2247-4f84-9e15-527db0caf191")
        self.assertEqual(self.s.turns, 1)

    def test_session_line_learns_model_from_existing_transcript(self):
        self.append(assistant("r0", {"input_tokens": 1, "output_tokens": 1}))
        lines = self.s.handle(self.base(event="UserPromptSubmit", prompt="hi"))
        self.assertEqual(lines[0], "▶ session e873ddde · claude claude-fable-5-1 · ~/dev/agent-irc")

    def test_codex_session_line_uses_payload_model(self):
        s = Session("codex", "activity", "/home/g/dev/simpici", HOME, clock=self.clock)
        lines = s.handle({"event": "UserPromptSubmit", "session_id": "01a06850-1f0d", "cwd": "/home/g/dev/simpici",
                          "model": "gpt-5.6-sol", "prompt": "x"})
        self.assertEqual(lines[0], "▶ session 01a06850 · codex gpt-5.6-sol · ~/dev/simpici")

    def test_model_is_announced_once_the_transcript_names_it(self):
        """UserPromptSubmit fires before the first assistant record exists, so the
        session line cannot carry the model; it goes out on its own line instead."""
        lines = self.s.handle(self.base(event="UserPromptSubmit", prompt="hi"))
        self.assertEqual(lines, ["▶ session e873ddde · claude · ~/dev/agent-irc", "» hi"])
        self.append(assistant("r0", {"input_tokens": 1000, "output_tokens": 20}))
        self.assertEqual(self.s.handle(self.base(event="PreToolUse", tool_name="Bash", tool_use_id="t1",
                                                 tool_input={"command": "ls"})),
                         ["⇄ model claude-fable-5-1"])
        self.assertEqual(self.s.model, "claude-fable-5-1")
        self.assertEqual(self.s.handle(self.base(event="PreToolUse", tool_name="Bash", tool_use_id="t2",
                                                 tool_input={"command": "ls"})), [])

    def test_the_model_peek_leaves_the_turn_usage_alone(self):
        self.s.handle(self.base(event="UserPromptSubmit", prompt="hi"))
        self.append(assistant("r0", {"input_tokens": 1000, "output_tokens": 20}))
        self.s.handle(self.base(event="PreToolUse", tool_name="Bash", tool_use_id="t1",
                                tool_input={"command": "ls"}))
        self.assertEqual(self.s.handle(self.base(event="Stop")),
                         ["✔ turn · 0.0s · 0 tools · 1k in / 20 out · claude-fable-5-1"])

    def test_no_model_line_when_the_session_line_already_had_it(self):
        self.append(assistant("r0", {"input_tokens": 1, "output_tokens": 1}))
        lines = self.s.handle(self.base(event="UserPromptSubmit", prompt="hi"))
        self.assertEqual(lines[0], "▶ session e873ddde · claude claude-fable-5-1 · ~/dev/agent-irc")
        self.assertEqual(self.s.handle(self.base(event="PreToolUse", tool_name="Bash", tool_use_id="t1",
                                                 tool_input={"command": "ls"})), [])

    def test_no_model_line_when_the_turn_line_carries_it(self):
        self.s.handle(self.base(event="UserPromptSubmit", prompt="hi"))
        self.append(assistant("r0", {"input_tokens": 1, "output_tokens": 1}))
        lines = self.s.handle(self.base(event="Stop"))
        self.assertEqual(lines, ["✔ turn · 0.0s · 0 tools · 1 in / 1 out · claude-fable-5-1"])
        self.assertEqual(self.s.handle(self.base(event="PreToolUse", tool_name="Bash", tool_use_id="t1",
                                                 tool_input={"command": "ls"})), [])

    def test_no_session_line_without_session_id(self):
        self.assertEqual(self.s.handle({"event": "PreToolUse", "tool_name": "Bash"}), [])

    def test_tool_lines_with_measured_duration(self):
        self.s.handle(self.base(event="UserPromptSubmit", prompt="go"))
        self.assertEqual(self.s.handle(self.base(event="PreToolUse", tool_name="Bash", tool_use_id="t1",
                                                 tool_input={"command": "ls -la"})), [])
        self.clock.tick(1.2)
        self.assertEqual(self.s.handle(self.base(event="PostToolUse", tool_name="Bash", tool_use_id="t1",
                                                 tool_input={"command": "ls -la"})),
                         ["⚙ Bash 1.2s: ls -la"])
        self.assertEqual(self.s.turn_tools, 1)

    def test_tool_failure_line(self):
        self.s.handle(self.base(event="UserPromptSubmit", prompt="go"))
        self.s.handle(self.base(event="PreToolUse", tool_name="Bash", tool_use_id="t1", tool_input={"command": "make"}))
        self.clock.tick(0.3)
        self.assertEqual(self.s.handle(self.base(event="PostToolUseFailure", tool_name="Bash", tool_use_id="t1",
                                                 tool_input={"command": "make"}, error_message="exit 2\nmore")),
                         ["✖ Bash 0.3s: make — exit 2"])

    def test_post_without_pre_has_no_duration(self):
        self.s.handle(self.base(event="UserPromptSubmit", prompt="go"))
        self.assertEqual(self.s.handle(self.base(event="PostToolUse", tool_name="Read", tool_use_id="zz",
                                                 tool_input={"file_path": CWD + "/a.py"})),
                         ["⚙ Read: a.py"])

    def test_mcp_tool_name_shortened(self):
        self.s.handle(self.base(event="UserPromptSubmit", prompt="go"))
        lines = self.s.handle(self.base(event="PostToolUse", tool_name="mcp__context7__query-docs",
                                        tool_input={"libraryId": "/x"}))
        self.assertEqual(lines, ["⚙ query-docs: /x"])

    def test_stop_line_reads_turn_usage(self):
        self.append(assistant("old", {"input_tokens": 999, "output_tokens": 999}))
        self.s.handle(self.base(event="UserPromptSubmit", prompt="go"))
        self.s.handle(self.base(event="PreToolUse", tool_name="Bash", tool_use_id="t1", tool_input={"command": "ls"}))
        self.s.handle(self.base(event="PostToolUse", tool_name="Bash", tool_use_id="t1", tool_input={"command": "ls"}))
        self.append(assistant("r1", {"input_tokens": 10, "cache_read_input_tokens": 190000,
                                     "cache_creation_input_tokens": 20000, "output_tokens": 6000}, tools=1))
        self.clock.tick(192)
        lines = self.s.handle(self.base(event="Stop", last_assistant_message="done"))
        self.assertEqual(lines, ["✔ turn · 3m12s · 1 tools · 210k in (190k cached) / 6k out · claude-fable-5-1"])
        self.assertEqual(self.s.total.output, 6000)
        self.assertEqual(self.s.total_tools, 1)

    def test_stop_logs_transcript_failure_when_debug_is_set(self):
        # A transcript_path that is a directory (e.g. an unreadable path)
        # never actually reaches this handler in practice: usage.py's
        # _Tail.records() already catches OSError, including
        # IsADirectoryError, and returns [] -- confirmed by pointing a real
        # Session at a directory and observing zero debug output. Mocking
        # the read itself is what actually exercises the debug call the
        # three `except Exception` fallbacks in _start/_turn_usage/
        # _subagent_usage gained.
        debug = []
        s = Session("claude", "activity", CWD, HOME, clock=self.clock, debug=debug.append)
        s.handle(self.base(event="UserPromptSubmit", prompt="go"))
        with mock.patch.object(s.transcript, "read_new", side_effect=OSError(21, "Is a directory")):
            lines = s.handle(self.base(event="Stop"))
        self.assertEqual(lines, ["✔ turn · 0.0s · 0 tools"])
        self.assertTrue(any("agent-irc: transcript read failed" in l for l in debug))

    def test_stop_without_transcript(self):
        s = Session("claude", "activity", CWD, HOME, clock=self.clock)
        s.handle({"event": "UserPromptSubmit", "session_id": "abc", "cwd": CWD, "prompt": "go"})
        self.clock.tick(5)
        self.assertEqual(s.handle({"event": "Stop", "session_id": "abc"}), ["✔ turn · 5.0s · 0 tools"])

    def test_codex_stop_uses_turn_id(self):
        s = Session("codex", "activity", CWD, HOME, clock=self.clock)
        base = {"session_id": "01a", "cwd": CWD, "transcript_path": self.transcript, "model": "gpt-5.6-sol"}
        s.handle(dict(base, event="UserPromptSubmit", prompt="go", turn_id="t1"))
        self.append({"type": "token_usage_record", "payload": {"turn_id": "t1",
                     "turn_token_usage": {"input_tokens": 15392, "cached_input_tokens": 10880, "output_tokens": 237}}})
        self.clock.tick(7)
        self.assertEqual(s.handle(dict(base, event="Stop", turn_id="t1")),
                         ["✔ turn · 7.0s · 0 tools · 15k in (11k cached) / 237 out · gpt-5.6-sol"])

    def test_full_level_sends_prompt_and_answer_text(self):
        s = Session("claude", "full", CWD, HOME, clock=self.clock)
        lines = s.handle(self.base(event="UserPromptSubmit", prompt="first line\n\nsecond paragraph"))
        self.assertEqual(lines[1:], ["» first line", "  second paragraph"])
        lines = s.handle(self.base(event="Stop", last_assistant_message="All done.\nBye."))
        self.assertEqual(lines[1:], ["  All done.", "  Bye."])

    def test_full_level_sends_the_whole_multiline_command(self):
        s = Session("claude", "full", CWD, HOME, clock=self.clock)
        s.handle(self.base(event="UserPromptSubmit", prompt="go"))
        cmd = "cat > x <<'EOF'\nhello\nEOF"
        s.handle(self.base(event="PreToolUse", tool_name="Bash", tool_use_id="t1", tool_input={"command": cmd}))
        self.assertEqual(s.handle(self.base(event="PostToolUse", tool_name="Bash", tool_use_id="t1",
                                            tool_input={"command": cmd})),
                         ["⚙ Bash 0.0s: cat > x <<'EOF' [+2 lines]",
                          "  command:", "    cat > x <<'EOF'", "    hello", "    EOF"])

    def test_single_line_command_has_no_body_at_full_level(self):
        s = Session("claude", "full", CWD, HOME, clock=self.clock)
        s.handle(self.base(event="UserPromptSubmit", prompt="go"))
        self.assertEqual(s.handle(self.base(event="PostToolUse", tool_name="Bash", tool_use_id="t1",
                                            tool_input={"command": "ls -la"})),
                         ["⚙ Bash: ls -la"])

    def test_activity_level_keeps_the_command_on_one_line(self):
        self.s.handle(self.base(event="UserPromptSubmit", prompt="go"))
        self.assertEqual(self.s.handle(self.base(event="PostToolUse", tool_name="Bash", tool_use_id="t1",
                                                 tool_input={"command": "a\nb"})),
                         ["⚙ Bash: a b [+1 line]"])

    def test_full_level_body_lines_are_logical_lines(self):
        # Fitting a line to a server is the connection's job: it is the only
        # thing that knows that server's LINELEN and the ":nick!user@host "
        # the server puts in front of what we send. A session that split at a
        # guessed 400 bytes would cap every server at the guess.
        s = Session("claude", "full", CWD, HOME, clock=self.clock)
        paragraph = "x" * 900
        # lines[0] is the session-start line, lines[1] the "» " prompt summary,
        # lines[2] the body -- the second prompt line, kept as one logical line.
        lines = s.handle(self.base(event="UserPromptSubmit", prompt="head\n" + paragraph))
        self.assertEqual(lines[2:], ["  " + paragraph])
        lines = s.handle(self.base(event="Stop", last_assistant_message=paragraph))
        self.assertEqual(lines[1:], ["  " + paragraph])

    def test_subactivity_does_not_send_texts(self):
        s = Session("claude", "subactivity", CWD, HOME, clock=self.clock)
        self.assertEqual(len(s.handle(self.base(event="UserPromptSubmit", prompt="a\nb"))), 2)
        self.assertEqual(len(s.handle(self.base(event="Stop", last_assistant_message="x"))), 1)


if __name__ == "__main__":
    unittest.main()
