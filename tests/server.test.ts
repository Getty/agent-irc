// Port of tests/test_server.py: describe = the Python TestCase, test = its method.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "../src/config.js";
import type { ConnectionOptions } from "../src/irc.js";
import { App, DRAIN_BUDGET, detectHarness, hostWord, installSignalHandlers, type ConnectionLike } from "../src/server.js";
import { VERSION } from "../src/version.js";

const A = "irc://u:p@a.example/";

class FakeConnection implements ConnectionLike {
  static instances: FakeConnection[] = [];
  messages: string[] = [];
  quit: string | null = null;
  beginCloseCalls = 0;
  constructor(
    readonly server: Server,
    readonly channels: string[],
    readonly nickBase: string,
    readonly realname: string,
    readonly log: (line: string) => void,
    readonly kw: ConnectionOptions,
  ) {
    FakeConnection.instances.push(this);
  }

  start(): void {}

  sendMessage(text: string): void {
    this.messages.push(text);
  }

  beginClose(quitMessage: string): void {
    this.beginCloseCalls += 1;
    this.quit = quitMessage;
  }

  join(_timeout?: number): Promise<boolean> | boolean {
    return true;
  }
}

const factory = (...a: ConstructorParameters<typeof FakeConnection>) => new FakeConnection(...a);

function rpc(id: unknown, method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

const call = (id: number, args: Record<string, unknown>) => rpc(id, "tools/call", { name: "event", arguments: args });

async function* lines(text: string): AsyncGenerator<string> {
  yield text;
}

describe("DetectTests", () => {
  test("names", () => {
    expect(detectHarness({ name: "claude-code", version: "2.1" })).toBe("claude");
    expect(detectHarness({ name: "Codex CLI" })).toBe("codex");
    expect(detectHarness({ name: "other" })).toBe("other");
    expect(detectHarness(null)).toBe("agent");
    expect(detectHarness(new Map([["name", "codex-mcp-client"]]))).toBe("codex");
  });
});

describe("HostWordTests", () => {
  test("the starter's host word names the harness", () => {
    const logs: string[] = [];
    expect(hostWord(["claude-code"], (l) => logs.push(l))).toBe("claude");
    expect(hostWord(["codex"], (l) => logs.push(l))).toBe("codex");
    expect(logs).toEqual([]);
  });

  test("no argument leaves it to clientInfo, quietly", () => {
    const logs: string[] = [];
    expect(hostWord([], (l) => logs.push(l))).toBeNull();
    expect(logs).toEqual([]);
  });

  test("an unknown argument is logged and falls back to clientInfo", () => {
    const logs: string[] = [];
    expect(hostWord(["claude"], (l) => logs.push(l))).toBeNull();
    expect(hostWord(["codex", "extra"], (l) => logs.push(l))).toBe("codex");
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("'claude'");
    expect(logs[1]).toContain("'extra'");
  });
});

describe("AppTests", () => {
  let tmp: string;
  let home: string;
  let cwd: string;
  let logs: string[];

  beforeEach(() => {
    FakeConnection.instances = [];
    tmp = mkdtempSync(join(tmpdir(), "airts-server-"));
    home = join(tmp, "home");
    cwd = join(tmp, "agent-irc");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ "agent-irc": { channels: [A + "#agents", A + "#log"], level: "activity" } }),
    );
    logs = [];
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    DRAIN_BUDGET.seconds = 2.0;
  });

  function makeApp(
    stdin: string,
    {
      connectionFactory = factory,
      debug = null,
      harness = null,
    }: {
      connectionFactory?: ConstructorParameters<typeof App>[0]["connectionFactory"];
      debug?: ((l: string) => void) | null;
      harness?: string | null;
    } = {},
  ) {
    let out = "";
    const app = new App({
      home,
      env: { USER: "getty" },
      stdin: lines(stdin),
      stdout: { write: (s: string) => void (out += s) },
      log: (l) => logs.push(l),
      connectionFactory,
      debug,
      cwd,
      harness,
    });
    return { app, out: () => out };
  }

  async function runApp(input: string[], options: Parameters<typeof makeApp>[1] = {}) {
    const { app, out } = makeApp(input.join(""), options);
    await app.run();
    return { app, out: out() };
  }

  function settings(extra: Record<string, unknown> = {}): void {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ "agent-irc": { channels: [A + "#agents"], level: "activity", ...extra } }),
    );
  }

  const tools = (out: string) =>
    (JSON.parse(out.split("\n")[1]!) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);

  test("session flow", async () => {
    const sid = "e873ddde-2247-4f84-9e15-527db0caf191";
    const { app, out } = await runApp([
      rpc(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } }),
      call(2, { event: "PreToolUse", tool_name: "Bash" }),
      call(3, { event: "UserPromptSubmit", session_id: sid, cwd, prompt: "hello" }),
      call(4, { event: "PostToolUse", session_id: sid, tool_name: "Bash", tool_input: { command: "ls" } }),
      call(5, { event: "SessionEnd", session_id: sid, reason: "other" }),
    ]);
    expect(app.harness).toBe("claude");
    expect(FakeConnection.instances).toHaveLength(1);
    const conn = FakeConnection.instances[0]!;
    expect(conn.channels).toEqual(["#agents", "#log"]);
    expect(conn.nickBase).toBe("agent-irc");
    expect(conn.realname).toBe(`claude ${sid} ${cwd}`);
    expect(conn.messages[0]).toBe(`▶ session e873ddde · claude · ${cwd}`);
    expect(conn.messages[1]).toBe("» hello");
    expect(conn.messages[2]).toBe("⚙ Bash: ls");
    expect(conn.messages[3]!.startsWith("■ session ended (other) · ")).toBe(true);
    expect(conn.quit!.startsWith("session ended · ")).toBe(true);
    expect(conn.quit).toContain("1 turns · 1 tools");
    expect(out.split("\n").filter(Boolean)).toHaveLength(5);
    expect(JSON.parse(out.split("\n")[0]!).result.serverInfo).toEqual({ name: "agent-irc", version: VERSION });
  });

  test("read_messages is not offered unless listening", async () => {
    const { app, out } = await runApp([rpc(1, "initialize", { clientInfo: { name: "claude-code" } }), rpc(2, "tools/list")]);
    expect(tools(out)).toEqual(["event"]);
    expect(app.inbox.listening).toBe(false);
  });

  test("listen in the settings offers read_messages", async () => {
    settings({ listen: true, listen_from: ["getty!*@vhost.example"] });
    const { app, out } = await runApp([rpc(1, "initialize", { clientInfo: { name: "claude-code" } }), rpc(2, "tools/list")]);
    expect(tools(out)).toEqual(["event", "read_messages"]);
    expect(app.inbox.listening).toBe(true);
  });

  test("the connection feeds the inbox through the allowlist", () => {
    settings({ listen: true, listen_from: ["getty!*@vhost.example"] });
    const { app } = makeApp("");
    app.onInitialize(new Map([["clientInfo", new Map([["name", "claude-code"]])]]));
    app.handle(new Map<string, unknown>([["event", "UserPromptSubmit"], ["session_id", "s1"], ["cwd", cwd], ["prompt", "hi"]]));
    const onMessage = FakeConnection.instances[0]!.kw.onMessage!;
    onMessage("getty!getty@vhost.example", "agent-irc-1", "carry on");
    onMessage("stranger!x@elsewhere", "agent-irc-1", "ignore me");
    const report = app.inbox.report();
    expect(report).toContain("carry on");
    expect(report).not.toContain("ignore me");
  });

  test("a session config without listen turns it off again", () => {
    settings({ listen: true, listen_from: ["*"] });
    const { app } = makeApp("");
    app.onInitialize({ clientInfo: { name: "claude-code" } });
    expect(app.inbox.listening).toBe(true);
    settings(); // the session's own load reads the file again
    app.handle({ event: "UserPromptSubmit", session_id: "s1", cwd, prompt: "hi" });
    expect(app.inbox.listening).toBe(false);
  });

  test("no config means no connections", async () => {
    unlinkSync(join(home, ".claude", "settings.json"));
    await runApp([
      rpc(1, "initialize", { clientInfo: { name: "claude-code" } }),
      call(2, { event: "UserPromptSubmit", session_id: "s", cwd, prompt: "x" }),
    ]);
    expect(FakeConnection.instances).toEqual([]);
    expect(logs.some((l) => l.includes("no channels configured"))).toBe(true);
  });

  test("orphan session end stays quiet", async () => {
    // A harness may spin up a fresh server process solely to deliver
    // SessionEnd after the process that held the real session state is
    // already gone (observed live against Claude Code, 2026-09-05). With no
    // prior activity, this process must not announce a phantom session.
    const { app } = await runApp([
      rpc(1, "initialize", { clientInfo: { name: "claude-code" } }),
      call(2, { event: "SessionEnd", session_id: "s", cwd, reason: "other" }),
    ]);
    expect(app.session).toBeNull();
    expect(FakeConnection.instances).toEqual([]);
    expect(logs.some((l) => l.includes("SessionEnd with no prior state"))).toBe(true);
  });

  test("new session id replaces the running session", async () => {
    // /clear or /resume hand the running MCP server a new session_id (and
    // transcript_path) without restarting it.
    const otherCwd = join(tmp, "other-project");
    mkdirSync(otherCwd);
    const t1 = join(tmp, "s1.jsonl");
    const t2 = join(tmp, "s2.jsonl");
    const { app } = await runApp([
      rpc(1, "initialize", { clientInfo: { name: "claude-code" } }),
      call(2, { event: "UserPromptSubmit", session_id: "s1", cwd, transcript_path: t1, prompt: "first" }),
      call(3, { event: "SessionEnd", session_id: "s1", reason: "clear" }),
      call(4, { event: "UserPromptSubmit", session_id: "s2", cwd: otherCwd, transcript_path: t2, prompt: "second" }),
    ]);
    expect(app.session!.sessionId).toBe("s2");
    expect(app.session!.turns).toBe(1);
    // The connections opened for s1 are kept, not reopened, for s2.
    expect(FakeConnection.instances).toHaveLength(1);
    const sessionLines = FakeConnection.instances[0]!.messages.filter((m) => m.startsWith("▶ session"));
    expect(sessionLines).toHaveLength(2);
    expect(sessionLines[1]).toContain(`▶ session s2 · claude · ${otherCwd}`);
    expect(logs.some((l) => l.includes("new session s2") && l.includes("s1"))).toBe(true);
  });

  test("late events for a replaced session do not resurrect it", async () => {
    const t1 = join(tmp, "s1.jsonl");
    const t2 = join(tmp, "s2.jsonl");
    const { app } = await runApp([
      rpc(1, "initialize", { clientInfo: { name: "claude-code" } }),
      call(2, { event: "UserPromptSubmit", session_id: "s1", cwd, transcript_path: t1, prompt: "one" }),
      call(3, { event: "UserPromptSubmit", session_id: "s2", cwd, transcript_path: t2, prompt: "two" }),
      call(4, { event: "Stop", session_id: "s1", transcript_path: t1 }),
      call(5, { event: "SessionEnd", session_id: "s1", reason: "clear" }),
      call(6, { event: "SessionEnd", session_id: "never-seen", reason: "other" }),
      call(7, { event: "Stop", session_id: "s2", transcript_path: t2 }),
    ]);
    expect(app.session!.sessionId).toBe("s2");
    expect(app.session!.turns).toBe(1);
    const msgs = FakeConnection.instances[0]!.messages;
    const starts = msgs.filter((m) => m.startsWith("▶ session"));
    expect(starts).toHaveLength(2);
    expect(starts[0]!.startsWith("▶ session s1")).toBe(true);
    expect(starts[1]!.startsWith("▶ session s2")).toBe(true);
    expect(msgs.filter((m) => m.startsWith("■"))).toEqual([]);
    expect(msgs.filter((m) => m.startsWith("✔ turn"))).toHaveLength(1);
    expect(FakeConnection.instances[0]!.quit).toContain("1 turns");
  });

  test("foreign id tool events stay with the running session", async () => {
    const t1 = join(tmp, "s1.jsonl");
    const { app } = await runApp([
      rpc(1, "initialize", { clientInfo: { name: "claude-code" } }),
      call(2, { event: "UserPromptSubmit", session_id: "s1", cwd, transcript_path: t1, prompt: "one" }),
      call(3, { event: "PreToolUse", session_id: "sub-1", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } }),
      call(4, { event: "PostToolUse", session_id: "sub-1", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } }),
    ]);
    expect(app.session!.sessionId).toBe("s1");
    const msgs = FakeConnection.instances[0]!.messages;
    expect(msgs.filter((m) => m.startsWith("▶ session"))).toHaveLength(1);
    expect(msgs.some((m) => m.startsWith("⚙ Bash"))).toBe(true);
  });

  test("failed connect does not wedge the session", async () => {
    const t1 = join(tmp, "s1.jsonl");
    const { app } = await runApp(
      [
        rpc(1, "initialize", { clientInfo: { name: "claude-code" } }),
        call(2, { event: "UserPromptSubmit", session_id: "s1", cwd, transcript_path: t1, prompt: "one" }),
        call(3, { event: "Stop", session_id: "s1", transcript_path: t1 }),
      ],
      {
        connectionFactory: () => {
          throw new Error("can't start thread");
        },
      },
    );
    expect(app.session!.sessionId).toBe("s1");
    expect(app.session!.turns).toBe(0);
    expect(logs.some((l) => l.includes("event dropped") && l.includes("can't start thread"))).toBe(true);
    expect(logs.some((l) => l.includes("null") || l.includes("undefined"))).toBe(false);
  });

  test("flood and queue settings reach the connection", async () => {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        "agent-irc": { channels: [A + "#agents"], level: "full", flood_burst: 50, flood_interval: 0.05, queue_limit: 0 },
      }),
    );
    await runApp([
      rpc(1, "initialize", { clientInfo: { name: "claude-code" } }),
      call(2, { event: "UserPromptSubmit", session_id: "s", cwd, prompt: "x" }),
    ]);
    const kw = FakeConnection.instances[0]!.kw;
    expect(kw.queueLimit).toBe(0);
    expect([kw.bucket!.burst, kw.bucket!.interval]).toEqual([50.0, 0.05]);
  });

  test("flood and queue default when unconfigured", async () => {
    await runApp([
      rpc(1, "initialize", { clientInfo: { name: "claude-code" } }),
      call(2, { event: "UserPromptSubmit", session_id: "s", cwd, prompt: "x" }),
    ]);
    const kw = FakeConnection.instances[0]!.kw;
    expect(kw.queueLimit).toBe(500);
    expect([kw.bucket!.burst, kw.bucket!.interval]).toEqual([4.0, 2.0]);
  });

  test("debug logs the raw event", async () => {
    const debug: string[] = [];
    await runApp(
      [
        rpc(1, "initialize", { clientInfo: { name: "claude-code" } }),
        call(2, { event: "UserPromptSubmit", session_id: "s", cwd, prompt: "x" }),
      ],
      { debug: (l) => debug.push(l) },
    );
    expect(debug.some((l) => l.includes("agent-irc: event") && l.includes('"event": "UserPromptSubmit"'))).toBe(true);
    // sort_keys=True, as Python logs it
    expect(debug.find((l) => l.startsWith("agent-irc: event "))).toBe(
      `agent-irc: event {"cwd": "${cwd}", "event": "UserPromptSubmit", "prompt": "x", "session_id": "s"}`,
    );
  });

  test("events before session id are ignored", async () => {
    const { app } = await runApp([
      rpc(1, "initialize", { clientInfo: { name: "codex" } }),
      call(2, { event: "PreToolUse", session_id: "${session_id}" }),
    ]);
    expect(app.session).toBeNull();
    expect(FakeConnection.instances).toEqual([]);
  });

  test("one connection per server", async () => {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ "agent-irc": { channels: [A + "#a", "irc://u:p@b.example/#b", A + "#c"] } }),
    );
    await runApp([
      rpc(1, "initialize", { clientInfo: { name: "claude-code" } }),
      call(2, { event: "UserPromptSubmit", session_id: "s", cwd, prompt: "x" }),
    ]);
    expect(FakeConnection.instances.map((c) => [c.server.host, c.channels])).toEqual([
      ["a.example", ["#a", "#c"]],
      ["b.example", ["#b"]],
    ]);
  });

  test("shutdown delivers quit to every connection", async () => {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ "agent-irc": { channels: [A + "#a", "irc://u:p@b.example/#b"] } }),
    );
    await runApp([
      rpc(1, "initialize", { clientInfo: { name: "claude-code" } }),
      call(2, { event: "UserPromptSubmit", session_id: "s", cwd, prompt: "x" }),
    ]);
    expect(FakeConnection.instances).toHaveLength(2);
    const quits = FakeConnection.instances.map((c) => c.quit);
    expect(quits.every((q) => q !== null)).toBe(true);
    expect(quits[0]).toBe(quits[1]!);
    expect(quits[0]!.startsWith("session ended · ")).toBe(true);
  });

  test("shutdown is bounded", async () => {
    class SlowJoinConnection extends FakeConnection {
      override join(): Promise<boolean> {
        // ignores its timeout altogether
        return new Promise((resolve) => setTimeout(() => resolve(true), 5000));
      }
    }
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ "agent-irc": { channels: [A + "#a", "irc://u:p@b.example/#b"] } }),
    );
    const start = performance.now();
    await runApp(
      [
        rpc(1, "initialize", { clientInfo: { name: "claude-code" } }),
        call(2, { event: "UserPromptSubmit", session_id: "s", cwd, prompt: "x" }),
      ],
      { connectionFactory: (...a) => new SlowJoinConnection(...a) },
    );
    expect(FakeConnection.instances).toHaveLength(2);
    expect(performance.now() - start).toBeLessThan(3000);
  });

  test("shutdown is idempotent", async () => {
    const { app } = await runApp([
      rpc(1, "initialize", { clientInfo: { name: "claude-code" } }),
      call(2, { event: "UserPromptSubmit", session_id: "s", cwd, prompt: "x" }),
    ]);
    expect(FakeConnection.instances.map((c) => c.beginCloseCalls)).toEqual([1]);
    await app.shutdown();
    await app.shutdown();
    expect(FakeConnection.instances.map((c) => c.beginCloseCalls)).toEqual([1]);
  });

  // -- what the port adds ---------------------------------------------------

  test("concurrent shutdowns share one: the second waits for the first's QUIT", async () => {
    class SlowJoin extends FakeConnection {
      joined = false;
      override join(): Promise<boolean> {
        return new Promise((resolve) =>
          setTimeout(() => {
            this.joined = true;
            resolve(true);
          }, 100),
        );
      }
    }
    const { app } = makeApp("", { connectionFactory: (...a) => new SlowJoin(...a) });
    app.onInitialize({ clientInfo: { name: "claude-code" } });
    app.handle({ event: "UserPromptSubmit", session_id: "s", cwd, prompt: "x" });
    const first = app.shutdown();
    await app.shutdown();
    expect((FakeConnection.instances[0] as SlowJoin).joined).toBe(true);
    await first;
    expect(FakeConnection.instances.map((c) => c.beginCloseCalls)).toEqual([1]);
  });

  test("the host word wins over clientInfo", async () => {
    const { app } = await runApp(
      [
        rpc(1, "initialize", { clientInfo: { name: "codex-mcp-client" } }),
        call(2, { event: "UserPromptSubmit", session_id: "s", cwd, prompt: "x" }),
      ],
      { harness: "claude" },
    );
    expect(app.harness).toBe("claude");
    // the claude settings were read: a codex harness would have found no config
    expect(FakeConnection.instances).toHaveLength(1);
    expect(FakeConnection.instances[0]!.realname.startsWith("claude s ")).toBe(true);
    expect(logs.some((l) => l.includes("initialized by claude"))).toBe(true);
  });

  test("onEvent only queues: the event is handled after the answer, on a later turn", async () => {
    const { app } = makeApp("");
    app.onInitialize({ clientInfo: { name: "claude-code" } });
    app.onEvent(new Map<string, unknown>([["event", "UserPromptSubmit"], ["session_id", "s"], ["cwd", cwd], ["prompt", "x"]]));
    expect(app.session).toBeNull();
    expect(FakeConnection.instances).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(app.session).not.toBeNull();
    await app.shutdown();
  });

  test("shutdown handles what is still queued first, as Python's worker drains before None", async () => {
    const { app } = makeApp("");
    app.onInitialize({ clientInfo: { name: "claude-code" } });
    app.onEvent({ event: "UserPromptSubmit", session_id: "s", cwd, prompt: "x" });
    await app.shutdown();
    expect(FakeConnection.instances[0]!.messages).toEqual([`▶ session s · claude · ${cwd}`, "» x"]);
    expect(FakeConnection.instances[0]!.quit).toContain("1 turns");
  });

  /** A Claude Code transcript of about `mb` MB: one record per content block, three per requestId. */
  function bigTranscript(path: string, mb: number): number {
    const rec = {
      type: "assistant",
      requestId: "",
      message: {
        model: "claude-x",
        usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 7 },
        content: [{ type: "text", text: "x".repeat(900) }],
      },
    };
    const parts: string[] = [];
    let size = 0;
    let i = 0;
    while (size < mb * 1024 * 1024) {
      rec.requestId = `r${Math.floor(i / 3)}`;
      i += 1;
      const line = JSON.stringify(rec) + "\n";
      parts.push(line);
      size += line.length;
    }
    writeFileSync(path, parts.join(""));
    return i;
  }

  test(
    "a call arriving while a large transcript is primed is answered at once",
    async () => {
      // Python reads the transcript on its dispatcher thread; here the read
      // shares the loop that answers JSON-RPC, so it has to give way to it.
      const transcript = join(tmp, "t.jsonl");
      bigTranscript(transcript, 50);
      let pingDue = 0;
      let answered = 0;
      let out = "";
      async function* input(): AsyncGenerator<string> {
        yield rpc(1, "initialize", { clientInfo: { name: "claude-code" } }) +
          call(2, { event: "UserPromptSubmit", session_id: "s", cwd, transcript_path: transcript, prompt: "x" });
        pingDue = performance.now() + 30;
        await new Promise((r) => setTimeout(r, 30));
        yield rpc(3, "ping");
        // the next event waits for the priming, and then reads only what is new
        yield call(4, { event: "Stop", session_id: "s", transcript_path: transcript });
      }
      const app = new App({
        home,
        env: { USER: "getty" },
        stdin: input(),
        stdout: {
          write: (s: string) => {
            out += s;
            if (answered === 0 && s.includes('"id": 3')) answered = performance.now();
          },
        },
        log: (l) => logs.push(l),
        connectionFactory: factory,
        cwd,
      });
      await app.run();
      expect(answered).toBeGreaterThan(0);
      expect(answered - pingDue).toBeLessThan(100);
      const messages = FakeConnection.instances[0]!.messages;
      expect(messages[0]).toBe(`▶ session s · claude claude-x · ${cwd}`);
      expect(messages[1]).toBe("» x");
      // primed: the backlog's tokens are not this turn's
      expect(messages[2]).toMatch(/^✔ turn · .* · 0 tools · claude-x$/);
    },
    30000,
  );

  test(
    "shutdown waits for a busy drain no longer than its budget, as worker.join(2.0)",
    async () => {
      const transcript = join(tmp, "t.jsonl");
      bigTranscript(transcript, 50);
      DRAIN_BUDGET.seconds = 0.1;
      const { app } = makeApp("");
      app.onInitialize({ clientInfo: { name: "claude-code" } });
      app.onEvent({ event: "UserPromptSubmit", session_id: "s", cwd, transcript_path: transcript, prompt: "x" });
      while (app.session === null) await new Promise((r) => setTimeout(r, 1)); // the priming is under way
      const start = performance.now();
      await app.shutdown();
      expect(performance.now() - start).toBeLessThan(600);
      // the QUIT went out with the summary as it stood: the prompt still unhandled
      expect(FakeConnection.instances[0]!.quit).toBe("session ended · 0 turns · 0 tools");
    },
    30000,
  );
});

describe("SignalHandlerTests", () => {
  test("signal is ignored once the app is already stopped", () => {
    // An EOF-triggered shutdown() sets App.stopped immediately, before it
    // finishes sending the QUIT. A signal landing after that point must not
    // start a second stop -- even though it is the first signal seen.
    const logs: string[] = [];
    const codes: number[] = [];
    const target = new EventEmitter();
    installSignalHandlers((l) => logs.push(l), () => true, (c) => codes.push(c), target);
    target.emit("SIGTERM", "SIGTERM");
    expect(codes).toEqual([]);
    expect(logs.some((l) => l.includes("already shutting down"))).toBe(true);
  });

  test("signal stops when the app is not stopped", () => {
    const logs: string[] = [];
    const codes: number[] = [];
    const target = new EventEmitter();
    installSignalHandlers((l) => logs.push(l), () => false, (c) => codes.push(c), target);
    target.emit("SIGTERM", "SIGTERM");
    expect(codes).toEqual([143]);
    expect(logs).toEqual(["agent-irc: signal 15, shutting down"]);
  });

  test("only the first signal counts, in either order", () => {
    for (const [first, second, code] of [
      ["SIGINT", "SIGTERM", 130],
      ["SIGTERM", "SIGINT", 143],
      ["SIGHUP", "SIGHUP", 129],
    ] as const) {
      const logs: string[] = [];
      const codes: number[] = [];
      const target = new EventEmitter();
      installSignalHandlers((l) => logs.push(l), () => false, (c) => codes.push(c), target);
      target.emit(first, first);
      target.emit(second, second);
      expect(codes).toEqual([code]);
      expect(logs[1]).toContain("already shutting down");
    }
  });
});
