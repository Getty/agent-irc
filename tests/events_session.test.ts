// Port of tests/test_events_session.py: describe = the Python TestCase, test = its method.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/events.js";

const HOME = "/home/g";
const CWD = "/home/g/dev/agent-irc";

class Clock {
  constructor(public t = 1000.0) {}
  readonly now = () => this.t;
  tick(seconds: number): void {
    this.t += seconds;
  }
}

type Rec = Record<string, unknown>;

function assistant(req: string, usage: Rec, model = "claude-fable-5-1", tools = 0): Rec {
  return {
    type: "assistant",
    requestId: req,
    timestamp: "2026-09-05T03:31:09.342Z",
    message: {
      model,
      usage,
      content: tools ? Array.from({ length: tools }, () => ({ type: "tool_use" })) : [{ type: "text" }],
    },
  };
}

describe("SessionCoreTests", () => {
  let tmp = "";
  let transcript = "";
  let clock: Clock;
  let s: Session;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "airk7-session-"));
    transcript = join(tmp, "sess.jsonl");
    clock = new Clock();
    s = new Session("claude", "activity", CWD, HOME, { clock: clock.now });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const base = (kw: Rec): Rec => ({
    session_id: "e873ddde-2247-4f84-9e15-527db0caf191",
    cwd: CWD,
    transcript_path: transcript,
    ...kw,
  });
  const append = (...records: Rec[]) => appendFileSync(transcript, records.map((r) => JSON.stringify(r) + "\n").join(""));

  test("test_session_line_on_first_event_without_model", () => {
    const lines = s.handle(base({ event: "UserPromptSubmit", prompt: "hello\nworld" }));
    expect(lines).toEqual(["▶ session e873ddde · claude · ~/dev/agent-irc", "» hello"]);
    expect(s.sessionId).toBe("e873ddde-2247-4f84-9e15-527db0caf191");
    expect(s.turns).toBe(1);
  });

  test("test_session_line_learns_model_from_existing_transcript", () => {
    append(assistant("r0", { input_tokens: 1, output_tokens: 1 }));
    const lines = s.handle(base({ event: "UserPromptSubmit", prompt: "hi" }));
    expect(lines[0]).toBe("▶ session e873ddde · claude claude-fable-5-1 · ~/dev/agent-irc");
  });

  test("test_codex_session_line_uses_payload_model", () => {
    const codex = new Session("codex", "activity", "/home/g/dev/simpici", HOME, { clock: clock.now });
    const lines = codex.handle({
      event: "UserPromptSubmit",
      session_id: "01a06850-1f0d",
      cwd: "/home/g/dev/simpici",
      model: "gpt-5.6-sol",
      prompt: "x",
    });
    expect(lines[0]).toBe("▶ session 01a06850 · codex gpt-5.6-sol · ~/dev/simpici");
  });

  test("test_model_is_announced_once_the_transcript_names_it", () => {
    const lines = s.handle(base({ event: "UserPromptSubmit", prompt: "hi" }));
    expect(lines).toEqual(["▶ session e873ddde · claude · ~/dev/agent-irc", "» hi"]);
    append(assistant("r0", { input_tokens: 1000, output_tokens: 20 }));
    expect(s.handle(base({ event: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } }))).toEqual([
      "⇄ model claude-fable-5-1",
    ]);
    expect(s.model).toBe("claude-fable-5-1");
    expect(s.handle(base({ event: "PreToolUse", tool_name: "Bash", tool_use_id: "t2", tool_input: { command: "ls" } }))).toEqual(
      [],
    );
  });

  test("test_the_model_peek_leaves_the_turn_usage_alone", () => {
    s.handle(base({ event: "UserPromptSubmit", prompt: "hi" }));
    append(assistant("r0", { input_tokens: 1000, output_tokens: 20 }));
    s.handle(base({ event: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } }));
    expect(s.handle(base({ event: "Stop" }))).toEqual(["✔ turn · 0.0s · 0 tools · 1k in / 20 out · claude-fable-5-1"]);
  });

  test("test_no_model_line_when_the_session_line_already_had_it", () => {
    append(assistant("r0", { input_tokens: 1, output_tokens: 1 }));
    const lines = s.handle(base({ event: "UserPromptSubmit", prompt: "hi" }));
    expect(lines[0]).toBe("▶ session e873ddde · claude claude-fable-5-1 · ~/dev/agent-irc");
    expect(s.handle(base({ event: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } }))).toEqual(
      [],
    );
  });

  test("test_no_model_line_when_the_turn_line_carries_it", () => {
    s.handle(base({ event: "UserPromptSubmit", prompt: "hi" }));
    append(assistant("r0", { input_tokens: 1, output_tokens: 1 }));
    expect(s.handle(base({ event: "Stop" }))).toEqual(["✔ turn · 0.0s · 0 tools · 1 in / 1 out · claude-fable-5-1"]);
    expect(s.handle(base({ event: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } }))).toEqual(
      [],
    );
  });

  test("test_no_session_line_without_session_id", () => {
    expect(s.handle({ event: "PreToolUse", tool_name: "Bash" })).toEqual([]);
  });

  test("test_tool_lines_with_measured_duration", () => {
    s.handle(base({ event: "UserPromptSubmit", prompt: "go" }));
    expect(s.handle(base({ event: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls -la" } }))).toEqual(
      [],
    );
    clock.tick(1.2);
    expect(s.handle(base({ event: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls -la" } }))).toEqual([
      "⚙ Bash 1.2s: ls -la",
    ]);
    expect(s.turnTools).toBe(1);
  });

  test("test_tool_failure_line", () => {
    s.handle(base({ event: "UserPromptSubmit", prompt: "go" }));
    s.handle(base({ event: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "make" } }));
    clock.tick(0.3);
    expect(
      s.handle(
        base({
          event: "PostToolUseFailure",
          tool_name: "Bash",
          tool_use_id: "t1",
          tool_input: { command: "make" },
          error_message: "exit 2\nmore",
        }),
      ),
    ).toEqual(["✖ Bash 0.3s: make — exit 2"]);
  });

  test("test_post_without_pre_has_no_duration", () => {
    s.handle(base({ event: "UserPromptSubmit", prompt: "go" }));
    expect(
      s.handle(base({ event: "PostToolUse", tool_name: "Read", tool_use_id: "zz", tool_input: { file_path: CWD + "/a.py" } })),
    ).toEqual(["⚙ Read: a.py"]);
  });

  test("test_mcp_tool_name_shortened", () => {
    s.handle(base({ event: "UserPromptSubmit", prompt: "go" }));
    const lines = s.handle(base({ event: "PostToolUse", tool_name: "mcp__context7__query-docs", tool_input: { libraryId: "/x" } }));
    expect(lines).toEqual(["⚙ query-docs: /x"]);
  });

  test("test_stop_line_reads_turn_usage", () => {
    append(assistant("old", { input_tokens: 999, output_tokens: 999 }));
    s.handle(base({ event: "UserPromptSubmit", prompt: "go" }));
    s.handle(base({ event: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } }));
    s.handle(base({ event: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } }));
    append(
      assistant(
        "r1",
        { input_tokens: 10, cache_read_input_tokens: 190000, cache_creation_input_tokens: 20000, output_tokens: 6000 },
        "claude-fable-5-1",
        1,
      ),
    );
    clock.tick(192);
    const lines = s.handle(base({ event: "Stop", last_assistant_message: "done" }));
    expect(lines).toEqual(["✔ turn · 3m12s · 1 tools · 210k in (190k cached) / 6k out · claude-fable-5-1"]);
    expect(s.total.output).toBe(6000);
    expect(s.totalTools).toBe(1);
  });

  test("test_stop_logs_transcript_failure_when_debug_is_set", () => {
    // Python mocks read_new with side_effect=OSError; here the method is
    // replaced on the instance, which is what mock.patch.object does.
    const debug: string[] = [];
    const d = new Session("claude", "activity", CWD, HOME, { clock: clock.now, debug: (line) => debug.push(line) });
    d.handle(base({ event: "UserPromptSubmit", prompt: "go" }));
    const t = d.transcript as { readNew: () => unknown };
    t.readNew = () => {
      throw new Error("[Errno 21] Is a directory");
    };
    expect(d.handle(base({ event: "Stop" }))).toEqual(["✔ turn · 0.0s · 0 tools"]);
    expect(debug.some((l) => l.includes("agent-irc: transcript read failed"))).toBe(true);
  });

  test("test_stop_without_transcript", () => {
    const bare = new Session("claude", "activity", CWD, HOME, { clock: clock.now });
    bare.handle({ event: "UserPromptSubmit", session_id: "abc", cwd: CWD, prompt: "go" });
    clock.tick(5);
    expect(bare.handle({ event: "Stop", session_id: "abc" })).toEqual(["✔ turn · 5.0s · 0 tools"]);
  });

  test("test_codex_stop_uses_turn_id", () => {
    const codex = new Session("codex", "activity", CWD, HOME, { clock: clock.now });
    const b = { session_id: "01a", cwd: CWD, transcript_path: transcript, model: "gpt-5.6-sol" };
    codex.handle({ ...b, event: "UserPromptSubmit", prompt: "go", turn_id: "t1" });
    append({
      type: "token_usage_record",
      payload: { turn_id: "t1", turn_token_usage: { input_tokens: 15392, cached_input_tokens: 10880, output_tokens: 237 } },
    });
    clock.tick(7);
    expect(codex.handle({ ...b, event: "Stop", turn_id: "t1" })).toEqual([
      "✔ turn · 7.0s · 0 tools · 15k in (11k cached) / 237 out · gpt-5.6-sol",
    ]);
  });

  test("test_full_level_sends_prompt_and_answer_text", () => {
    const full = new Session("claude", "full", CWD, HOME, { clock: clock.now });
    let lines = full.handle(base({ event: "UserPromptSubmit", prompt: "first line\n\nsecond paragraph" }));
    expect(lines.slice(1)).toEqual(["» first line", "  second paragraph"]);
    lines = full.handle(base({ event: "Stop", last_assistant_message: "All done.\nBye." }));
    expect(lines.slice(1)).toEqual(["  All done.", "  Bye."]);
  });

  test("test_full_level_sends_the_whole_multiline_command", () => {
    const full = new Session("claude", "full", CWD, HOME, { clock: clock.now });
    full.handle(base({ event: "UserPromptSubmit", prompt: "go" }));
    const cmd = "cat > x <<'EOF'\nhello\nEOF";
    full.handle(base({ event: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: cmd } }));
    expect(full.handle(base({ event: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: cmd } }))).toEqual([
      "⚙ Bash 0.0s: cat > x <<'EOF' [+2 lines]",
      "  command:",
      "    cat > x <<'EOF'",
      "    hello",
      "    EOF",
    ]);
  });

  test("test_single_line_command_has_no_body_at_full_level", () => {
    const full = new Session("claude", "full", CWD, HOME, { clock: clock.now });
    full.handle(base({ event: "UserPromptSubmit", prompt: "go" }));
    expect(full.handle(base({ event: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls -la" } }))).toEqual(
      ["⚙ Bash: ls -la"],
    );
  });

  test("test_activity_level_keeps_the_command_on_one_line", () => {
    s.handle(base({ event: "UserPromptSubmit", prompt: "go" }));
    expect(s.handle(base({ event: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "a\nb" } }))).toEqual([
      "⚙ Bash: a b [+1 line]",
    ]);
  });

  test("test_full_level_body_lines_are_logical_lines", () => {
    const full = new Session("claude", "full", CWD, HOME, { clock: clock.now });
    const paragraph = "x".repeat(900);
    let lines = full.handle(base({ event: "UserPromptSubmit", prompt: "head\n" + paragraph }));
    expect(lines.slice(2)).toEqual(["  " + paragraph]);
    lines = full.handle(base({ event: "Stop", last_assistant_message: paragraph }));
    expect(lines.slice(1)).toEqual(["  " + paragraph]);
  });

  test("test_subactivity_does_not_send_texts", () => {
    const sub = new Session("claude", "subactivity", CWD, HOME, { clock: clock.now });
    expect(sub.handle(base({ event: "UserPromptSubmit", prompt: "a\nb" })).length).toBe(2);
    expect(sub.handle(base({ event: "Stop", last_assistant_message: "x" })).length).toBe(1);
  });
});

// -- what the port adds: prepare() reads ahead what handle() will read ---------------

describe("SessionPrepareTests", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "airk9-prepare-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const SID = "e873ddde-2247-4f84-9e15-527db0caf191";

  /** The same events through prepare()+handle() and through handle() alone; pauses per event. */
  async function both(harness: string, events: (Rec | (() => void))[]): Promise<number[]> {
    const plainClock = new Clock();
    const readClock = new Clock();
    const plain = new Session(harness, "activity", CWD, HOME, { clock: plainClock.now });
    const ahead = new Session(harness, "activity", CWD, HOME, { clock: readClock.now });
    const pauses: number[] = [];
    for (const ev of events) {
      if (typeof ev === "function") {
        ev(); // something the harness writes between two events
        continue;
      }
      let n = 0;
      await ahead.prepare(ev, async () => void (n += 1));
      pauses.push(n);
      expect(ahead.handle(ev)).toEqual(plain.handle(ev));
      plainClock.tick(1);
      readClock.tick(1);
    }
    expect(ahead.summary()).toBe(plain.summary());
    return pauses;
  }

  test("claude: the priming, the turn and a subagent are read ahead, nothing else", async () => {
    const transcript = join(tmp, "sess.jsonl");
    const usage = { input_tokens: 10, output_tokens: 20 };
    appendFileSync(transcript, JSON.stringify(assistant("r0", usage)) + "\n");
    // the subagent's transcript hangs off the main transcript's directory
    const sub = join(tmp, SID, "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-a1.jsonl"), JSON.stringify(assistant("s1", usage, "claude-sub", 2)) + "\n");
    const base = { session_id: SID, cwd: CWD, transcript_path: transcript };
    const pauses = await both("claude", [
      { ...base, event: "UserPromptSubmit", prompt: "hi" },
      { ...base, event: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" },
      { ...base, event: "SubagentStart", agent_id: "a1", agent_type: "Explore" },
      { ...base, event: "SubagentStop", agent_id: "a1", agent_type: "Explore" },
      // the turn's own record arrives before Stop
      () => appendFileSync(transcript, JSON.stringify(assistant("r1", usage)) + "\n"),
      { ...base, event: "Stop" },
    ]);
    expect(pauses).toEqual([1, 0, 0, 1, 1]);
  });

  test("codex: the priming, the turn and a subagent are read ahead", async () => {
    const transcript = join(tmp, "rollout.jsonl");
    const sub = join(tmp, "sub.jsonl");
    const record = (key: string) =>
      JSON.stringify({ type: "token_usage_record", payload: { turn_id: "t", [key]: { input_tokens: 5000, output_tokens: 400 } } }) + "\n";
    writeFileSync(transcript, record("turn_token_usage"));
    writeFileSync(sub, record("thread_token_usage"));
    const base = { session_id: SID, cwd: CWD, transcript_path: transcript, turn_id: "t" };
    const pauses = await both("codex", [
      { ...base, event: "UserPromptSubmit", prompt: "hi" },
      { ...base, event: "SubagentStop", agent_id: "c1", agent_type: "worker", agent_transcript_path: sub },
      () => appendFileSync(transcript, record("turn_token_usage")),
      { ...base, event: "Stop" },
    ]);
    expect(pauses).toEqual([1, 1, 1]);
  });
});
