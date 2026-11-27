// Port of tests/test_events_subagents.py: describe = the Python TestCase, test = its method.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Session } from "../src/events.js";

const HOME = "/home/g";
const CWD = "/home/g/dev/agent-irc";
const SID = "e873ddde-2247-4f84-9e15-527db0caf191";

class Clock {
  constructor(public t = 1000.0) {}
  readonly now = () => this.t;
  tick(seconds: number): void {
    this.t += seconds;
  }
}

type Rec = Record<string, unknown>;

describe("SubagentTests", () => {
  let tmp = "";
  let transcript = "";
  let clock: Clock;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "airk7-sub-"));
    transcript = join(tmp, SID + ".jsonl");
    clock = new Clock();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function session(level = "activity", harness = "claude"): Session {
    const s = new Session(harness, level, CWD, HOME, { clock: clock.now });
    s.handle({
      event: "UserPromptSubmit",
      session_id: SID,
      cwd: CWD,
      transcript_path: transcript,
      prompt: "go",
      model: harness === "codex" ? "gpt-5.6-sol" : null,
    });
    return s;
  }

  function writeSubagent(agentId: string, records: Rec[]): string {
    const path = join(tmp, SID, "subagents", `agent-${agentId}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, records.map((r) => JSON.stringify(r) + "\n").join(""));
    return path;
  }

  test("test_start_line_pairs_description_from_agent_tool", () => {
    const s = session();
    s.handle({
      event: "PreToolUse",
      session_id: SID,
      tool_name: "Agent",
      tool_use_id: "t1",
      tool_input: { subagent_type: "Explore", description: "find hook payloads", prompt: "..." },
    });
    let lines = s.handle({ event: "SubagentStart", session_id: SID, agent_id: "a293f253", agent_type: "Explore" });
    expect(lines).toEqual(["⇢ subagent Explore: find hook payloads"]);
    lines = s.handle({ event: "SubagentStart", session_id: SID, agent_id: "b111", agent_type: "Plan" });
    expect(lines).toEqual(["⇢ subagent Plan"]);
  });

  test("test_a_failed_agent_call_does_not_shift_later_descriptions", () => {
    const s = session();
    s.handle({
      event: "PreToolUse",
      session_id: SID,
      tool_name: "Agent",
      tool_use_id: "t1",
      tool_input: { subagent_type: "Explore", description: "never runs", prompt: "..." },
    });
    s.handle({ event: "PostToolUseFailure", session_id: SID, tool_name: "Agent", tool_use_id: "t1", error_message: "no such agent type" });
    s.handle({
      event: "PreToolUse",
      session_id: SID,
      tool_name: "Agent",
      tool_use_id: "t2",
      tool_input: { subagent_type: "Explore", description: "the real one", prompt: "..." },
    });
    const lines = s.handle({ event: "SubagentStart", session_id: SID, agent_id: "a1", agent_type: "Explore" });
    expect(lines).toEqual(["⇢ subagent Explore: the real one"]);
  });

  test("test_the_description_queue_stays_bounded", () => {
    const s = session("activity", "codex");
    for (let i = 0; i < 200; i++) {
      s.handle({
        event: "PreToolUse",
        session_id: SID,
        tool_name: "Agent",
        tool_use_id: `t${i}`,
        tool_input: { description: `d${i}`, prompt: "..." },
      });
    }
    expect(s.agentDescriptions.length).toBeLessThan(100);
    expect(s.agentDescriptions.length).toBe(64);
    expect(s.agentDescriptions[0]).toEqual(["t136", "d136"]);
  });

  test("test_stop_line_with_transcript_usage", () => {
    const s = session();
    s.handle({ event: "SubagentStart", session_id: SID, agent_id: "a293f253", agent_type: "Explore" });
    writeSubagent("a293f253", [
      {
        type: "assistant",
        requestId: "r1",
        timestamp: "2026-09-05T03:31:09.000Z",
        message: {
          model: "claude-sonnet-5",
          usage: { input_tokens: 31000, output_tokens: 2000 },
          content: [{ type: "tool_use" }, { type: "tool_use" }],
        },
      },
    ]);
    clock.tick(42);
    const lines = s.handle({
      event: "SubagentStop",
      session_id: SID,
      agent_id: "a293f253",
      agent_type: "Explore",
      transcript_path: transcript,
    });
    expect(lines).toEqual(["⇠ subagent Explore done · 42s · 2 tools · 31k in / 2k out · claude-sonnet-5"]);
    expect(s.total.input).toBe(31000);
    expect(s.totalTools).toBe(2);
    expect(s.subagents.has("a293f253")).toBe(false);
  });

  test("test_stop_without_transcript_counts_own_tools", () => {
    const s = session();
    s.handle({ event: "SubagentStart", session_id: SID, agent_id: "a1", agent_type: "Explore" });
    s.handle({ event: "PostToolUse", session_id: SID, agent_id: "a1", tool_name: "Read", tool_input: { file_path: "x" } });
    clock.tick(3);
    const lines = s.handle({ event: "SubagentStop", session_id: SID, agent_id: "a1", agent_type: "Explore" });
    expect(lines).toEqual(["⇠ subagent Explore done · 3.0s · 1 tools"]);
  });

  test("test_stop_for_unknown_agent", () => {
    const s = session();
    const lines = s.handle({ event: "SubagentStop", session_id: SID, agent_id: "zz", agent_type: "Explore" });
    expect(lines).toEqual(["⇠ subagent Explore done · 0 tools"]);
  });

  test("test_codex_stop_uses_agent_transcript_path", () => {
    const s = session("activity", "codex");
    const path = join(tmp, "sub.jsonl");
    writeFileSync(
      path,
      JSON.stringify({
        type: "token_usage_record",
        payload: { turn_id: "t", thread_token_usage: { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 400 } },
      }) +
        "\n" +
        JSON.stringify({ type: "response_item", payload: { type: "function_call" } }) +
        "\n",
    );
    s.handle({ event: "SubagentStart", session_id: SID, agent_id: "c1", agent_type: "worker" });
    clock.tick(10);
    const lines = s.handle({
      event: "SubagentStop",
      session_id: SID,
      agent_id: "c1",
      agent_type: "worker",
      agent_transcript_path: path,
    });
    expect(lines).toEqual(["⇠ subagent worker done · 10s · 1 tools · 5k in / 400 out"]);
  });

  test("test_subagent_tool_lines_per_level", () => {
    const cases: [string, string[]][] = [
      ["activity", []],
      ["subactivity", ["⚙ [a293] Read 0.1s: hooks/hooks.json"]],
      ["full", ["⚙ [a293] Read 0.1s: hooks/hooks.json"]],
    ];
    for (const [level, expected] of cases) {
      const s = session(level);
      s.handle({ event: "SubagentStart", session_id: SID, agent_id: "a293f253", agent_type: "Explore" });
      s.handle({
        event: "PreToolUse",
        session_id: SID,
        agent_id: "a293f253",
        tool_name: "Read",
        tool_use_id: "t9",
        tool_input: { file_path: CWD + "/hooks/hooks.json" },
      });
      clock.tick(0.1);
      const lines = s.handle({
        event: "PostToolUse",
        session_id: SID,
        agent_id: "a293f253",
        tool_name: "Read",
        tool_use_id: "t9",
        tool_input: { file_path: CWD + "/hooks/hooks.json" },
      });
      expect(lines).toEqual(expected);
      expect(s.turnTools).toBe(0);
      expect(s.subagents.get("a293f253")!.tools).toBe(1);
    }
  });

  test("test_stop_takes_the_larger_tool_count", () => {
    const s = session();
    s.handle({ event: "SubagentStart", session_id: SID, agent_id: "a293f253", agent_type: "Explore" });
    for (const tid of ["t1", "t2", "t3"]) {
      s.handle({
        event: "PostToolUse",
        session_id: SID,
        agent_id: "a293f253",
        tool_name: "Read",
        tool_use_id: tid,
        tool_input: { file_path: "x" },
      });
    }
    // transcript exists but lags behind: it has usage and only one tool_use block
    writeSubagent("a293f253", [
      {
        type: "assistant",
        requestId: "r1",
        timestamp: "2026-09-05T03:31:09.000Z",
        message: { model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: "tool_use" }] },
      },
    ]);
    clock.tick(5);
    const lines = s.handle({
      event: "SubagentStop",
      session_id: SID,
      agent_id: "a293f253",
      agent_type: "Explore",
      transcript_path: transcript,
    });
    expect(lines).toEqual(["⇠ subagent Explore done · 5.0s · 3 tools · 100 in / 10 out · claude-sonnet-5"]);
    expect(s.totalTools).toBe(3);
  });

  test("test_stop_prefers_transcript_when_events_are_missing", () => {
    const s = session();
    s.handle({ event: "SubagentStart", session_id: SID, agent_id: "b1", agent_type: "worker" });
    writeSubagent("b1", [
      {
        type: "assistant",
        requestId: "r1",
        timestamp: "2026-09-05T03:31:09.000Z",
        message: {
          model: "claude-sonnet-5",
          usage: { input_tokens: 100, output_tokens: 10 },
          content: [{ type: "tool_use" }, { type: "tool_use" }],
        },
      },
    ]);
    clock.tick(2);
    const lines = s.handle({ event: "SubagentStop", session_id: SID, agent_id: "b1", agent_type: "worker", transcript_path: transcript });
    expect(lines).toEqual(["⇠ subagent worker done · 2.0s · 2 tools · 100 in / 10 out · claude-sonnet-5"]);
  });

  test("test_subagent_failure_line", () => {
    const s = session("subactivity");
    s.handle({ event: "SubagentStart", session_id: SID, agent_id: "a293f253", agent_type: "Explore" });
    const lines = s.handle({
      event: "PostToolUseFailure",
      session_id: SID,
      agent_id: "a293f253",
      tool_name: "Bash",
      tool_input: { command: "false" },
      error_message: "exit 1",
    });
    expect(lines).toEqual(["✖ [a293] Bash: false — exit 1"]);
  });
});
