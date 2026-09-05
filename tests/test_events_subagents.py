import json
import os
import tempfile
import unittest

from agent_irc.events import Session

HOME = "/home/g"
CWD = "/home/g/dev/agent-irc"
SID = "e873ddde-2247-4f84-9e15-527db0caf191"


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t

    def tick(self, seconds):
        self.t += seconds


class SubagentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.transcript = os.path.join(self.tmp.name, SID + ".jsonl")
        self.clock = Clock()

    def session(self, level="activity", harness="claude"):
        s = Session(harness, level, CWD, HOME, clock=self.clock)
        s.handle({"event": "UserPromptSubmit", "session_id": SID, "cwd": CWD, "transcript_path": self.transcript,
                  "prompt": "go", "model": "gpt-5.6-sol" if harness == "codex" else None})
        return s

    def write_subagent(self, agent_id, records):
        path = os.path.join(self.tmp.name, SID, "subagents", "agent-%s.jsonl" % agent_id)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")
        return path

    def test_start_line_pairs_description_from_agent_tool(self):
        s = self.session()
        s.handle({"event": "PreToolUse", "session_id": SID, "tool_name": "Agent", "tool_use_id": "t1",
                  "tool_input": {"subagent_type": "Explore", "description": "find hook payloads", "prompt": "..."}})
        lines = s.handle({"event": "SubagentStart", "session_id": SID, "agent_id": "a293f253", "agent_type": "Explore"})
        self.assertEqual(lines, ["⇢ subagent Explore: find hook payloads"])
        lines = s.handle({"event": "SubagentStart", "session_id": SID, "agent_id": "b111", "agent_type": "Plan"})
        self.assertEqual(lines, ["⇢ subagent Plan"])

    def test_stop_line_with_transcript_usage(self):
        s = self.session()
        s.handle({"event": "SubagentStart", "session_id": SID, "agent_id": "a293f253", "agent_type": "Explore"})
        self.write_subagent("a293f253", [
            {"type": "assistant", "requestId": "r1", "timestamp": "2026-09-05T03:31:09.000Z",
             "message": {"model": "claude-sonnet-5", "usage": {"input_tokens": 31000, "output_tokens": 2000},
                         "content": [{"type": "tool_use"}, {"type": "tool_use"}]}}])
        self.clock.tick(42)
        lines = s.handle({"event": "SubagentStop", "session_id": SID, "agent_id": "a293f253", "agent_type": "Explore",
                          "transcript_path": self.transcript})
        self.assertEqual(lines, ["⇠ subagent Explore done · 42s · 2 tools · 31k in / 2k out · claude-sonnet-5"])
        self.assertEqual(s.total.input, 31000)
        self.assertEqual(s.total_tools, 2)
        self.assertNotIn("a293f253", s.subagents)

    def test_stop_without_transcript_counts_own_tools(self):
        s = self.session()
        s.handle({"event": "SubagentStart", "session_id": SID, "agent_id": "a1", "agent_type": "Explore"})
        s.handle({"event": "PostToolUse", "session_id": SID, "agent_id": "a1", "tool_name": "Read",
                  "tool_input": {"file_path": "x"}})
        self.clock.tick(3)
        lines = s.handle({"event": "SubagentStop", "session_id": SID, "agent_id": "a1", "agent_type": "Explore"})
        self.assertEqual(lines, ["⇠ subagent Explore done · 3.0s · 1 tools"])

    def test_stop_for_unknown_agent(self):
        s = self.session()
        lines = s.handle({"event": "SubagentStop", "session_id": SID, "agent_id": "zz", "agent_type": "Explore"})
        self.assertEqual(lines, ["⇠ subagent Explore done · 0 tools"])

    def test_codex_stop_uses_agent_transcript_path(self):
        s = self.session(harness="codex")
        path = os.path.join(self.tmp.name, "sub.jsonl")
        with open(path, "w") as f:
            f.write(json.dumps({"type": "token_usage_record", "payload": {"turn_id": "t",
                     "thread_token_usage": {"input_tokens": 5000, "cached_input_tokens": 0, "output_tokens": 400}}}) + "\n")
            f.write(json.dumps({"type": "response_item", "payload": {"type": "function_call"}}) + "\n")
        s.handle({"event": "SubagentStart", "session_id": SID, "agent_id": "c1", "agent_type": "worker"})
        self.clock.tick(10)
        lines = s.handle({"event": "SubagentStop", "session_id": SID, "agent_id": "c1", "agent_type": "worker",
                          "agent_transcript_path": path})
        self.assertEqual(lines, ["⇠ subagent worker done · 10s · 1 tools · 5k in / 400 out"])

    def test_subagent_tool_lines_per_level(self):
        for level, expected in (("activity", []), ("subactivity", ["⚙ [a293] Read 0.1s: hooks/hooks.json"]),
                                ("full", ["⚙ [a293] Read 0.1s: hooks/hooks.json"])):
            s = self.session(level)
            s.handle({"event": "SubagentStart", "session_id": SID, "agent_id": "a293f253", "agent_type": "Explore"})
            s.handle({"event": "PreToolUse", "session_id": SID, "agent_id": "a293f253", "tool_name": "Read",
                      "tool_use_id": "t9", "tool_input": {"file_path": CWD + "/hooks/hooks.json"}})
            self.clock.tick(0.1)
            lines = s.handle({"event": "PostToolUse", "session_id": SID, "agent_id": "a293f253", "tool_name": "Read",
                              "tool_use_id": "t9", "tool_input": {"file_path": CWD + "/hooks/hooks.json"}})
            self.assertEqual(lines, expected, level)
            self.assertEqual(s.turn_tools, 0, level)
            self.assertEqual(s.subagents["a293f253"]["tools"], 1, level)

    def test_stop_takes_the_larger_tool_count(self):
        s = self.session()
        s.handle({"event": "SubagentStart", "session_id": SID, "agent_id": "a293f253", "agent_type": "Explore"})
        for tid in ("t1", "t2", "t3"):
            s.handle({"event": "PostToolUse", "session_id": SID, "agent_id": "a293f253", "tool_name": "Read",
                      "tool_use_id": tid, "tool_input": {"file_path": "x"}})
        # transcript exists but lags behind: it has usage and only one tool_use block
        self.write_subagent("a293f253", [
            {"type": "assistant", "requestId": "r1", "timestamp": "2026-09-05T03:31:09.000Z",
             "message": {"model": "claude-sonnet-5", "usage": {"input_tokens": 100, "output_tokens": 10},
                         "content": [{"type": "tool_use"}]}}])
        self.clock.tick(5)
        lines = s.handle({"event": "SubagentStop", "session_id": SID, "agent_id": "a293f253", "agent_type": "Explore",
                          "transcript_path": self.transcript})
        self.assertEqual(lines, ["⇠ subagent Explore done · 5.0s · 3 tools · 100 in / 10 out · claude-sonnet-5"])
        self.assertEqual(s.total_tools, 3)

    def test_stop_prefers_transcript_when_events_are_missing(self):
        s = self.session()
        s.handle({"event": "SubagentStart", "session_id": SID, "agent_id": "b1", "agent_type": "worker"})
        self.write_subagent("b1", [
            {"type": "assistant", "requestId": "r1", "timestamp": "2026-09-05T03:31:09.000Z",
             "message": {"model": "claude-sonnet-5", "usage": {"input_tokens": 100, "output_tokens": 10},
                         "content": [{"type": "tool_use"}, {"type": "tool_use"}]}}])
        self.clock.tick(2)
        lines = s.handle({"event": "SubagentStop", "session_id": SID, "agent_id": "b1", "agent_type": "worker",
                          "transcript_path": self.transcript})
        self.assertEqual(lines, ["⇠ subagent worker done · 2.0s · 2 tools · 100 in / 10 out · claude-sonnet-5"])

    def test_subagent_failure_line(self):
        s = self.session("subactivity")
        s.handle({"event": "SubagentStart", "session_id": SID, "agent_id": "a293f253", "agent_type": "Explore"})
        lines = s.handle({"event": "PostToolUseFailure", "session_id": SID, "agent_id": "a293f253", "tool_name": "Bash",
                          "tool_input": {"command": "false"}, "error_message": "exit 1"})
        self.assertEqual(lines, ["✖ [a293] Bash: false — exit 1"])


if __name__ == "__main__":
    unittest.main()
