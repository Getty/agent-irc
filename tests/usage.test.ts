// Port of tests/test_usage_claude.py and tests/test_usage_codex.py:
// describe = the Python TestCase, test = its method.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeTranscript,
  CodexTranscript,
  PEEK,
  READ_AHEAD,
  Tail,
  Usage,
  claudeSubagentPath,
} from "../src/usage.js";

type Rec = Record<string, unknown>;

function assistant(
  req: string,
  usage: Rec,
  { model = "claude-fable-5-1", blocks = ["text"], ts = "2026-09-05T03:31:09.342Z" } = {},
): Rec {
  return {
    type: "assistant",
    requestId: req,
    timestamp: ts,
    message: { model, usage, content: blocks.map((b) => ({ type: b, name: "Bash" })) },
  };
}

const USAGE_A = { input_tokens: 2, cache_creation_input_tokens: 14564, cache_read_input_tokens: 26445, output_tokens: 198 };
const USAGE_B = { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 41009, output_tokens: 349 };

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "airk7-usage-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  PEEK.bytes = 256 * 1024;
  READ_AHEAD.bytes = 512 * 1024;
});

function appendTo(path: string, ...records: Rec[]): void {
  appendFileSync(path, records.map((r) => JSON.stringify(r) + "\n").join(""));
}

describe("UsageTests", () => {
  test("test_add_and_text", () => {
    const u = new Usage({ input: 1000, cached: 400, output: 50 }).add(
      new Usage({ input: 200000, cached: 190000, output: 6000, tools: 3, model: "m" }),
    );
    expect([u.input, u.cached, u.output, u.tools, u.model]).toEqual([201000, 190400, 6050, 3, "m"]);
    expect(u.tokensText()).toBe("201k in (190k cached) / 6k out");
    expect(new Usage({ input: 31000, output: 2000 }).tokensText()).toBe("31k in / 2k out");
    expect(u.hasTokens()).toBe(true);
    expect(new Usage({ tools: 2 }).hasTokens()).toBe(false);
  });
});

describe("ClaudeTranscriptTests", () => {
  const path = () => join(dir, "s.jsonl");
  const append = (...records: Rec[]) => appendTo(path(), ...records);

  test("test_dedupes_per_request_and_counts_tools", () => {
    append(
      { type: "user", message: { role: "user", content: "hi" } },
      assistant("req1", USAGE_A, { blocks: ["thinking"] }),
      assistant("req1", USAGE_A, { blocks: ["text"] }),
      assistant("req1", USAGE_A, { blocks: ["tool_use"] }),
      assistant("req2", USAGE_B, { blocks: ["tool_use", "tool_use"] }),
    );
    const u = new ClaudeTranscript(path()).readNew();
    expect(u.input).toBe(2 + 14564 + 26445 + 5 + 41009);
    expect(u.cached).toBe(26445 + 41009);
    expect(u.output).toBe(198 + 349);
    expect(u.tools).toBe(3);
    expect(u.model).toBe("claude-fable-5-1");
  });

  test("test_incremental_reads_only_new_complete_lines", () => {
    append(assistant("req1", USAGE_A));
    const t = new ClaudeTranscript(path());
    expect(t.readNew().output).toBe(198);
    expect(t.readNew().output).toBe(0);
    appendFileSync(path(), JSON.stringify(assistant("req2", USAGE_B))); // no newline yet
    expect(t.readNew().output).toBe(0);
    appendFileSync(path(), "\n");
    expect(t.readNew().output).toBe(349);
  });

  test("test_missing_file_and_junk_lines", () => {
    expect(new ClaudeTranscript(path()).readNew()).toEqual(new Usage());
    writeFileSync(path(), "not json\n\n");
    expect(new ClaudeTranscript(path()).readNew()).toEqual(new Usage());
  });

  test("test_read_whole_duration", () => {
    append(
      assistant("r1", USAGE_A, { ts: "2026-09-05T03:31:09.000Z" }),
      assistant("r2", USAGE_B, { ts: "2026-09-05T03:31:51.500Z", model: "claude-sonnet-5" }),
    );
    const u = ClaudeTranscript.readWhole(path());
    expect(u.duration).toBeCloseTo(42.5, 7);
    expect(u.model).toBe("claude-sonnet-5");
    expect(u.output).toBe(198 + 349);
  });

  test("test_rewritten_shorter_file_is_read_from_the_start", () => {
    append(assistant("r1", USAGE_A), assistant("r2", USAGE_B));
    const t = new ClaudeTranscript(path());
    expect(t.readNew().output).toBe(198 + 349);
    writeFileSync(path(), JSON.stringify(assistant("r3", { input_tokens: 1, output_tokens: 7 })) + "\n");
    expect(t.readNew().output).toBe(7);
    expect(t.readNew().output).toBe(0);
  });

  test("test_peek_model_reads_the_tail_and_leaves_the_offset_alone", () => {
    append(assistant("r1", USAGE_A), assistant("r2", USAGE_B, { model: "claude-sonnet-5" }));
    const t = new ClaudeTranscript(path());
    PEEK.bytes = 400; // cuts into the first record
    expect(t.peekModel()).toBe("claude-sonnet-5");
    PEEK.bytes = 256 * 1024;
    expect(t.offset).toBe(0);
    expect(t.readNew().output).toBe(198 + 349);
  });

  test("test_peek_model_without_a_readable_transcript", () => {
    expect(new ClaudeTranscript(path()).peekModel()).toBeNull();
    append(assistant("r1", USAGE_A));
    PEEK.bytes = 20; // every complete line is cut away
    expect(new ClaudeTranscript(path()).peekModel()).toBeNull();
  });

  test("test_subagent_path", () => {
    expect(claudeSubagentPath("/h/.claude/projects/p/sess.jsonl", "sess", "a293")).toBe(
      "/h/.claude/projects/p/sess/subagents/agent-a293.jsonl",
    );
  });
});

function rec(kind: string, payload: Rec, ts: string | null = null): Rec {
  return { timestamp: ts, type: kind, payload };
}

function tokens(i: number, c: number, o: number): Rec {
  return {
    input_tokens: i,
    cached_input_tokens: c,
    cache_write_input_tokens: 0,
    output_tokens: o,
    reasoning_output_tokens: 0,
    total_tokens: i + o,
  };
}

function usageRecord(turn: string, turnUsage: Rec, threadUsage: Rec): Rec {
  return rec("token_usage_record", { turn_id: turn, turn_token_usage: turnUsage, thread_token_usage: threadUsage });
}

describe("CodexTranscriptTests", () => {
  const path = () => join(dir, "rollout.jsonl");
  const append = (...records: Rec[]) => appendTo(path(), ...records);

  test("test_turn_usage_is_last_record_of_that_turn", () => {
    append(
      rec("turn_context", { turn_id: "t1", model: "gpt-5.6-sol" }),
      rec("response_item", { type: "function_call", name: "shell" }),
      usageRecord("t1", tokens(100, 50, 10), tokens(100, 50, 10)),
      rec("response_item", { type: "custom_tool_call", name: "apply_patch" }),
      rec("response_item", { type: "message" }),
      usageRecord("t1", tokens(250, 120, 30), tokens(250, 120, 30)),
      usageRecord("t2", tokens(7, 0, 1), tokens(257, 120, 31)),
    );
    const u = new CodexTranscript(path()).readTurn("t1");
    expect([u.input, u.cached, u.output, u.tools, u.model]).toEqual([250, 120, 30, 2, "gpt-5.6-sol"]);
  });

  test("test_peek_model_leaves_the_turn_read_alone", () => {
    append(
      rec("turn_context", { turn_id: "t1", model: "gpt-5.6-sol" }),
      usageRecord("t1", tokens(100, 50, 10), tokens(100, 50, 10)),
    );
    const t = new CodexTranscript(path());
    expect(t.peekModel()).toBe("gpt-5.6-sol");
    expect(t.offset).toBe(0);
    expect(t.readTurn("t1").input).toBe(100);
  });

  test("test_turn_id_none_takes_last_record", () => {
    append(usageRecord("t1", tokens(1, 0, 1), tokens(1, 0, 1)), usageRecord("t2", tokens(9, 0, 2), tokens(10, 0, 3)));
    expect(new CodexTranscript(path()).readTurn(null).input).toBe(9);
  });

  test("test_incremental", () => {
    append(usageRecord("t1", tokens(1, 0, 1), tokens(1, 0, 1)));
    const t = new CodexTranscript(path());
    expect(t.readTurn("t1").input).toBe(1);
    append(rec("response_item", { type: "function_call" }), usageRecord("t2", tokens(5, 0, 1), tokens(6, 0, 2)));
    const u = t.readTurn("t2");
    expect([u.input, u.tools]).toEqual([5, 1]);
  });

  test("test_read_whole_uses_thread_usage_and_span", () => {
    append(
      rec("session_meta", { id: "x" }, "2026-09-03T17:00:00.000Z"),
      rec("response_item", { type: "function_call" }),
      usageRecord("t1", tokens(1, 0, 1), tokens(1, 0, 1)),
      usageRecord("t2", tokens(5, 2, 1), tokens(6, 2, 2)),
      rec("event_msg", { type: "task_complete" }, "2026-09-03T17:00:42.000Z"),
    );
    const u = CodexTranscript.readWhole(path());
    expect([u.input, u.cached, u.output, u.tools]).toEqual([6, 2, 2, 1]);
    expect(u.duration).toBeCloseTo(42.0, 7);
  });

  test("test_missing_file", () => {
    expect(new CodexTranscript(path()).readTurn("t")).toEqual(new Usage());
  });
});

// Not in the Python suite: the timestamp forms datetime.fromisoformat (3.11+)
// reads, including microseconds JavaScript's Date would round away.
describe("TimestampSemantics", () => {
  test("microseconds and offsets count, as datetime.timestamp() counts them", () => {
    const path = join(dir, "ts.jsonl");
    appendTo(
      path,
      { type: "x", timestamp: "2026-09-05T03:31:09.000001+02:00" },
      { type: "x", timestamp: "2026-09-05T01:31:09.500002Z" },
    );
    expect(ClaudeTranscript.readWhole(path).duration).toBe(0.5000009536743164);
  });

  test("numbers in milliseconds and seconds both count", () => {
    const path = join(dir, "ms.jsonl");
    appendTo(path, { type: "x", timestamp: 1757000000000 }, { type: "x", timestamp: 1757000003 });
    expect(ClaudeTranscript.readWhole(path).duration).toBe(3);
  });
});

// Not in the Python suite: what json.loads refuses in a record is skipped.
describe("RecordSemantics", () => {
  test("a record behind a byte order mark is skipped, as json.loads refuses it", () => {
    const path = join(dir, "bom.jsonl");
    writeFileSync(path, "\ufeff" + JSON.stringify(assistant("r1", USAGE_A)) + "\n" + JSON.stringify(assistant("r2", USAGE_B)) + "\n");
    expect(new ClaudeTranscript(path).readNew().output).toBe(349);
  });

  test("NaN in a record is JSON to Python, so the record counts", () => {
    const path = join(dir, "nan.jsonl");
    writeFileSync(path, '{"type": "assistant", "requestId": "r", "message": {"usage": {"output_tokens": 5, "input_tokens": NaN}}}\n');
    const u = new ClaudeTranscript(path).readNew();
    expect([u.input, u.output]).toEqual([0, 5]);
  });
});

// -- what the port adds: the read-ahead ------------------------------------------------

describe("ReadAheadTests", () => {
  const path = () => join(dir, "t.jsonl");
  // lines of differing lengths, a blank one, a broken one and one far longer than a chunk
  const body = [
    JSON.stringify({ n: 1 }),
    "",
    JSON.stringify({ n: 2, pad: "y".repeat(50) }),
    "{broken",
    JSON.stringify({ n: 3, pad: "z".repeat(300) }),
    JSON.stringify({ n: 4 }),
  ].join("\n") + "\n" + JSON.stringify({ n: 5 }); // the last record is still being written

  test("records after a read-ahead are the records of a plain read, whatever the chunk", async () => {
    writeFileSync(path(), body);
    const plain = new Tail(path());
    const expected = plain.records();
    for (const bytes of [1, 7, 40, 64, 1000, 1 << 20]) {
      READ_AHEAD.bytes = bytes;
      const t = new Tail(path());
      let turns = 0;
      await t.readAhead(async () => void (turns += 1));
      expect(t.offset).toBe(0); // nothing consumed yet
      expect(t.records()).toEqual(expected);
      expect(t.offset).toBe(plain.offset);
      expect(turns).toBeGreaterThan(0);
    }
  });

  test("lines appended after the read-ahead come with it, in order", async () => {
    writeFileSync(path(), body);
    const t = new Tail(path());
    await t.readAhead();
    appendFileSync(path(), "\n" + JSON.stringify({ n: 6 }) + "\n");
    expect(t.records()).toEqual([{ n: 1 }, { n: 2, pad: "y".repeat(50) }, { n: 3, pad: "z".repeat(300) }, { n: 4 }, { n: 5 }, { n: 6 }]);
    expect(t.records()).toEqual([]);
  });

  test("a file rewritten shorter after the read-ahead is read from the start", async () => {
    writeFileSync(path(), body);
    const t = new Tail(path());
    t.records();
    appendFileSync(path(), "\n" + JSON.stringify({ n: 6, pad: "q".repeat(400) }) + "\n");
    await t.readAhead();
    writeFileSync(path(), JSON.stringify({ n: 7 }) + "\n");
    expect(t.records()).toEqual([{ n: 7 }]);
  });

  test("a read-ahead continues from the offset and a missing file reads nothing", async () => {
    writeFileSync(path(), body);
    const t = new Tail(path());
    t.records();
    appendFileSync(path(), "\n");
    await t.readAhead();
    expect(t.records()).toEqual([{ n: 5 }]);
    const gone = new Tail(join(dir, "missing.jsonl"));
    await gone.readAhead();
    expect(gone.records()).toEqual([]);
  });

  test("whole-file reads take a read-ahead tail", async () => {
    appendFileSync(path(), JSON.stringify(assistant("r1", USAGE_A)) + "\n");
    const t = new ClaudeTranscript(path());
    await t.readAhead();
    expect(ClaudeTranscript.readWhole(path(), t).output).toBe(198);
  });
});
