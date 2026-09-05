import json
import os
import tempfile
import unittest

from agent_irc.usage import ClaudeTranscript, Usage, claude_subagent_path


def assistant(req, usage, model="claude-fable-5-1", blocks=("text",), ts="2026-09-05T03:31:09.342Z"):
    return {"type": "assistant", "requestId": req, "timestamp": ts,
            "message": {"model": model, "usage": usage,
                        "content": [{"type": b, "name": "Bash"} for b in blocks]}}


USAGE_A = {"input_tokens": 2, "cache_creation_input_tokens": 14564, "cache_read_input_tokens": 26445, "output_tokens": 198}
USAGE_B = {"input_tokens": 5, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 41009, "output_tokens": 349}


class UsageTests(unittest.TestCase):
    def test_add_and_text(self):
        u = Usage(input=1000, cached=400, output=50).add(Usage(input=200000, cached=190000, output=6000, tools=3, model="m"))
        self.assertEqual((u.input, u.cached, u.output, u.tools, u.model), (201000, 190400, 6050, 3, "m"))
        self.assertEqual(u.tokens_text(), "201k in (190k cached) / 6k out")
        self.assertEqual(Usage(input=31000, output=2000).tokens_text(), "31k in / 2k out")
        self.assertTrue(u.has_tokens())
        self.assertFalse(Usage(tools=2).has_tokens())


class ClaudeTranscriptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "s.jsonl")

    def append(self, *records):
        with open(self.path, "a", encoding="utf-8") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")

    def test_dedupes_per_request_and_counts_tools(self):
        self.append({"type": "user", "message": {"role": "user", "content": "hi"}},
                    assistant("req1", USAGE_A, blocks=("thinking",)),
                    assistant("req1", USAGE_A, blocks=("text",)),
                    assistant("req1", USAGE_A, blocks=("tool_use",)),
                    assistant("req2", USAGE_B, blocks=("tool_use", "tool_use")))
        u = ClaudeTranscript(self.path).read_new()
        self.assertEqual(u.input, 2 + 14564 + 26445 + 5 + 41009)
        self.assertEqual(u.cached, 26445 + 41009)
        self.assertEqual(u.output, 198 + 349)
        self.assertEqual(u.tools, 3)
        self.assertEqual(u.model, "claude-fable-5-1")

    def test_incremental_reads_only_new_complete_lines(self):
        self.append(assistant("req1", USAGE_A))
        t = ClaudeTranscript(self.path)
        self.assertEqual(t.read_new().output, 198)
        self.assertEqual(t.read_new().output, 0)
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(assistant("req2", USAGE_B)))  # no newline yet
        self.assertEqual(t.read_new().output, 0)
        with open(self.path, "a", encoding="utf-8") as f:
            f.write("\n")
        self.assertEqual(t.read_new().output, 349)

    def test_missing_file_and_junk_lines(self):
        self.assertEqual(ClaudeTranscript(self.path).read_new(), Usage())
        with open(self.path, "w") as f:
            f.write("not json\n\n")
        self.assertEqual(ClaudeTranscript(self.path).read_new(), Usage())

    def test_read_whole_duration(self):
        self.append(assistant("r1", USAGE_A, ts="2026-09-05T03:31:09.000Z"),
                    assistant("r2", USAGE_B, ts="2026-09-05T03:31:51.500Z", model="claude-sonnet-5"))
        u = ClaudeTranscript.read_whole(self.path)
        self.assertAlmostEqual(u.duration, 42.5)
        self.assertEqual(u.model, "claude-sonnet-5")
        self.assertEqual(u.output, 198 + 349)

    def test_subagent_path(self):
        self.assertEqual(claude_subagent_path("/h/.claude/projects/p/sess.jsonl", "sess", "a293"),
                         "/h/.claude/projects/p/sess/subagents/agent-a293.jsonl")


if __name__ == "__main__":
    unittest.main()
