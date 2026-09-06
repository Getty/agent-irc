import json
import os
import tempfile
import unittest

from agent_irc.usage import CodexTranscript, Usage


def rec(kind, payload, ts=None):
    return {"timestamp": ts, "type": kind, "payload": payload}


def tokens(i, c, o):
    return {"input_tokens": i, "cached_input_tokens": c, "cache_write_input_tokens": 0,
            "output_tokens": o, "reasoning_output_tokens": 0, "total_tokens": i + o}


def usage_record(turn, turn_usage, thread_usage):
    return rec("token_usage_record", {"turn_id": turn, "turn_token_usage": turn_usage,
                                      "thread_token_usage": thread_usage})


class CodexTranscriptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "rollout.jsonl")

    def append(self, *records):
        with open(self.path, "a", encoding="utf-8") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")

    def test_turn_usage_is_last_record_of_that_turn(self):
        self.append(rec("turn_context", {"turn_id": "t1", "model": "gpt-5.6-sol"}),
                    rec("response_item", {"type": "function_call", "name": "shell"}),
                    usage_record("t1", tokens(100, 50, 10), tokens(100, 50, 10)),
                    rec("response_item", {"type": "custom_tool_call", "name": "apply_patch"}),
                    rec("response_item", {"type": "message"}),
                    usage_record("t1", tokens(250, 120, 30), tokens(250, 120, 30)),
                    usage_record("t2", tokens(7, 0, 1), tokens(257, 120, 31)))
        u = CodexTranscript(self.path).read_turn("t1")
        self.assertEqual((u.input, u.cached, u.output, u.tools, u.model), (250, 120, 30, 2, "gpt-5.6-sol"))

    def test_peek_model_leaves_the_turn_read_alone(self):
        self.append(rec("turn_context", {"turn_id": "t1", "model": "gpt-5.6-sol"}),
                    usage_record("t1", tokens(100, 50, 10), tokens(100, 50, 10)))
        t = CodexTranscript(self.path)
        self.assertEqual(t.peek_model(), "gpt-5.6-sol")
        self.assertEqual(t.offset, 0)
        self.assertEqual(t.read_turn("t1").input, 100)

    def test_turn_id_none_takes_last_record(self):
        self.append(usage_record("t1", tokens(1, 0, 1), tokens(1, 0, 1)),
                    usage_record("t2", tokens(9, 0, 2), tokens(10, 0, 3)))
        self.assertEqual(CodexTranscript(self.path).read_turn(None).input, 9)

    def test_incremental(self):
        self.append(usage_record("t1", tokens(1, 0, 1), tokens(1, 0, 1)))
        t = CodexTranscript(self.path)
        self.assertEqual(t.read_turn("t1").input, 1)
        self.append(rec("response_item", {"type": "function_call"}),
                    usage_record("t2", tokens(5, 0, 1), tokens(6, 0, 2)))
        u = t.read_turn("t2")
        self.assertEqual((u.input, u.tools), (5, 1))

    def test_read_whole_uses_thread_usage_and_span(self):
        self.append(rec("session_meta", {"id": "x"}, ts="2026-09-03T17:00:00.000Z"),
                    rec("response_item", {"type": "function_call"}),
                    usage_record("t1", tokens(1, 0, 1), tokens(1, 0, 1)),
                    usage_record("t2", tokens(5, 2, 1), tokens(6, 2, 2)),
                    rec("event_msg", {"type": "task_complete"}, ts="2026-09-03T17:00:42.000Z"))
        u = CodexTranscript.read_whole(self.path)
        self.assertEqual((u.input, u.cached, u.output, u.tools), (6, 2, 2, 1))
        self.assertAlmostEqual(u.duration, 42.0)

    def test_missing_file(self):
        self.assertEqual(CodexTranscript(self.path).read_turn("t"), Usage())


if __name__ == "__main__":
    unittest.main()
