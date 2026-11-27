// Port of tests/test_events_misc.py: describe = the Python TestCase, test = its method.
import { beforeEach, describe, expect, test } from "bun:test";
import { Session } from "../src/events.js";
import { Usage } from "../src/usage.js";

const HOME = "/home/g";
const CWD = "/home/g/dev/agent-irc";

class Clock {
  constructor(public t = 1000.0) {}
  readonly now = () => this.t;
  tick(seconds: number): void {
    this.t += seconds;
  }
}

describe("MiscEventTests", () => {
  let clock: Clock;
  let s: Session;
  beforeEach(() => {
    clock = new Clock();
    s = new Session("claude", "activity", CWD, HOME, { clock: clock.now });
    s.handle({ event: "UserPromptSubmit", session_id: "abc12345", cwd: CWD, prompt: "go" });
  });

  const ev = (kw: Record<string, unknown> = {}) => s.handle({ ...kw, session_id: "abc12345" });

  test("test_stop_failure", () => {
    expect(ev({ event: "StopFailure", error_type: "rate_limit", error_message: "Too many\nrequests" })).toEqual([
      "✖ turn failed: rate_limit — Too many",
    ]);
    expect(s.turnStarted).toBeNull();
    expect(ev({ event: "StopFailure" })).toEqual(["✖ turn failed: unknown"]);
  });

  test("test_permission_request", () => {
    expect(ev({ event: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf build" } })).toEqual([
      "⚠ permission: Bash: rm -rf build",
    ]);
    expect(ev({ event: "PermissionRequest", tool_name: "mcp__x__y" })).toEqual(["⚠ permission: y"]);
  });

  test("test_notification_only_idle", () => {
    expect(ev({ event: "Notification", notification_type: "idle_prompt", message: "m" })).toEqual([
      "==== … WAITING FOR INPUT ====",
    ]);
    expect(ev({ event: "Notification", notification_type: "permission_prompt", message: "m" })).toEqual([]);
  });

  test("test_interrupt_compact_model_switch", () => {
    expect(ev({ event: "Interrupt" })).toEqual(["■ interrupted"]);
    expect(s.turnStarted).toBeNull();
    expect(ev({ event: "PostCompact", trigger: "auto" })).toEqual(["⟲ compacted (auto)"]);
    expect(ev({ event: "PostCompact" })).toEqual(["⟲ compacted (auto)"]);
    expect(ev({ event: "PostModelSwitch", from_model: "claude-fable-5-1", to_model: "claude-opus-5" })).toEqual([
      "⇄ model claude-fable-5-1 → claude-opus-5",
    ]);
    expect(s.model).toBe("claude-opus-5");
    expect(ev({ event: "PostModelSwitch", to_model: "claude-sonnet-5" })).toEqual([
      "⇄ model claude-opus-5 → claude-sonnet-5",
    ]);
  });

  test("test_unknown_event_is_ignored", () => {
    expect(ev({ event: "SomethingNew", foo: "bar" })).toEqual([]);
    expect(ev()).toEqual([]);
  });

  test("test_summary_and_session_end", () => {
    s.total.add(new Usage({ input: 1200000, cached: 1000000, output: 40000 }));
    s.totalTools = 412;
    s.turns = 8;
    clock.tick(4320);
    expect(s.summary()).toBe("1h12m · 8 turns · 412 tools · 1.2M in (1M cached) / 40k out");
    expect(ev({ event: "SessionEnd", reason: "prompt_input_exit" })).toEqual([
      "■ session ended (prompt_input_exit) · 1h12m · 8 turns · 412 tools · 1.2M in (1M cached) / 40k out",
    ]);
    expect(s.ended).toBe(true);
  });

  test("test_summary_before_start", () => {
    const fresh = new Session("claude", "activity", CWD, HOME, { clock: clock.now });
    expect(fresh.summary()).toBe("0 turns · 0 tools");
  });
});

// Not in the Python suite: the handler is found by the event name's snake
// form, the way getattr(self, "_on_" + _snake(name)) finds it.
describe("DispatchSemantics", () => {
  test("an event name is matched by its snake form, not by its spelling", () => {
    const s = new Session("claude", "activity", CWD, HOME, { clock: () => 1000 });
    s.handle({ event: "UserPromptSubmit", session_id: "abc12345", cwd: CWD, prompt: "go" });
    expect(s.handle({ event: "interrupt", session_id: "abc12345" })).toEqual(["■ interrupted"]);
    expect(s.handle({ event: "post_compact", session_id: "abc12345" })).toEqual(["⟲ compacted (auto)"]);
    expect(s.handle({ event: "INTERRUPT", session_id: "abc12345" })).toEqual([]);
    expect(s.handle({ event: "constructor", session_id: "abc12345" })).toEqual([]);
  });
});
