// Port of tests/test_end_to_end.py: the bundled server as the getty-bun
// starter runs it -- `bun --no-install --config=/dev/null --no-env-file
// dist/server.js <host>` -- against the fake ircd. dist/server.js is the
// committed bundle; `bun run build` refreshes it after a change in src/.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeIrcServer, type FakeOptions } from "./fakeirc.js";

const ROOT = join(import.meta.dir, "..");
const SERVER = join(ROOT, "dist", "server.js");
const SID = "01a06850-1f0d-7970-a9c5-da84c99a6ef7";

const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

function rpc(id: number, method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

const event = (id: number, args: Record<string, unknown>) => rpc(id, "tools/call", { name: "event", arguments: args });

/**
 * The server's environment: ours, with `home` as HOME and no moved config dir.
 *
 * config.configHome takes CLAUDE_CONFIG_DIR / CODEX_HOME over HOME, so either
 * one inherited from the session running the tests points the server at a
 * real config instead of the one written into `home`. The variables the
 * starter removes from Bun's environment go as well.
 */
function serverEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const drop = new Set([
    "CLAUDE_CONFIG_DIR", "CODEX_HOME", "AGENT_IRC_DEBUG",
    "BUN_OPTIONS", "BUN_INSPECT_PRELOAD", "BUN_INSPECT", "BUN_INSPECT_CONNECT_TO",
    "NODE_PATH", "NODE_COMPILE_CACHE", "BUN_RUNTIME_TRANSPILER_CACHE_PATH", "BUN_INTERNAL_WEBVIEW_HOST",
  ]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !drop.has(k)) env[k] = v;
  return { ...env, ...extra, HOME: home };
}

/** stdout as lines, read one at a time. */
class LineReader {
  private buffer = "";
  private readonly reader: { read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>; cancel(): Promise<void> };
  private readonly decoder = new TextDecoder();
  all = "";
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async line(): Promise<string | null> {
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) return null;
      const text = this.decoder.decode(value, { stream: true });
      this.all += text;
      this.buffer += text;
    }
  }

  /** Let go of the pipe: the server's next write meets a closed reader. */
  async cancel(): Promise<void> {
    await this.reader.cancel();
  }

  async rest(): Promise<string> {
    while ((await this.line()) !== null);
    return this.all;
  }
}

class ServerProcess {
  readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly out: LineReader;
  readonly err: Promise<string>;

  constructor(cwd: string, env: Record<string, string>, args: string[]) {
    this.proc = Bun.spawn([process.execPath, "--no-install", "--config=/dev/null", "--no-env-file", SERVER, ...args], {
      cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.out = new LineReader(this.proc.stdout);
    this.err = new Response(this.proc.stderr).text();
  }

  write(text: string): void {
    this.proc.stdin.write(text);
    void this.proc.stdin.flush();
  }

  async call(id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.write(rpc(id, method, params));
    return JSON.parse((await this.out.line())!) as Record<string, unknown>;
  }

  /** Close stdin (unless already closed) and collect: exit code, stdout, stderr. */
  async communicate(closeStdin = true): Promise<{ code: number | null; signal: string | number | null; out: string; err: string }> {
    if (closeStdin) await this.proc.stdin.end();
    const [out, err, code] = await Promise.all([this.out.rest(), this.err, this.proc.exited]);
    return { code, signal: this.proc.signalCode, out, err };
  }
}

/** addCleanup: run in reverse order after each test. */
const stack: (() => unknown)[] = [];
afterEach(async () => {
  while (stack.length) await stack.pop()!();
});

async function fakeIrc(options: FakeOptions = {}): Promise<FakeIrcServer> {
  const fake = await FakeIrcServer.create(options);
  stack.push(() => fake.close());
  return fake;
}

function tempDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), "airts-e2e-"));
  stack.push(() => rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

function start(cwd: string, env: Record<string, string>, args: string[] = []): ServerProcess {
  const server = new ServerProcess(cwd, env, args);
  stack.push(() => server.proc.kill("SIGKILL"));
  return server;
}

const quitSeen = (ls: string[]) => ls.some((l) => l.startsWith("QUIT :session ended"));

/** A claude-code session on #sig; `stalled`: the fake stops reading after the JOIN. */
async function startSession(fake: FakeIrcServer, { stalled = false } = {}): Promise<ServerProcess> {
  const tmp = tempDir();
  const home = join(tmp, "home");
  const cwd = join(tmp, "proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(cwd);
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ "agent-irc": { channels: [`irc://127.0.0.1:${fake.port}/#sig`] } }),
  );
  const server = start(cwd, serverEnv(home, { USER: "getty" }), ["claude-code"]);
  server.write(
    rpc(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } }) +
      event(2, { event: "UserPromptSubmit", session_id: SID, cwd, prompt: "hi" }),
  );
  expect(await fake.waitFor((ls) => ls.includes(stalled ? "JOIN #sig" : "PRIVMSG #sig :» hi"))).toBe(true);
  return server;
}

/**
 * Send `signals`, `gap` seconds apart, and check the one QUIT and the exit code.
 *
 * With a gap, the fake stops reading after the JOIN until all signals are
 * out: the connection then waits out its stop budget for a server that does
 * not answer the QUIT, so the later signals land while shutdown() is still
 * under way -- the race of Task 20 -- instead of after the process is gone.
 */
async function assertQuitsOn(signals: string[], gap: number, code: number): Promise<string> {
  const fake = await fakeIrc({ stallAfterJoin: gap > 0 ? 1 : 0 });
  const server = await startSession(fake, { stalled: gap > 0 });
  for (const [i, signal] of signals.entries()) {
    if (i > 0 && gap > 0) await sleep(gap);
    server.proc.kill(signal as NodeJS.Signals);
  }
  if (gap > 0) {
    await sleep(gap);
    fake.resumeAll();
  }
  expect(await fake.waitFor(quitSeen, 5)).toBe(true);
  // stdin stays open: the signal alone ends the server, as the harnesses do it
  const result = await server.communicate(false);
  expect([result.code, result.signal]).toEqual([code, null]);
  expect(fake.lines().filter((l) => l.startsWith("QUIT "))).toHaveLength(1);
  return result.err;
}

describe("ServerEnvTests", () => {
  test("drops the running session's config dirs", () => {
    const saved = [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME];
    process.env.CLAUDE_CONFIG_DIR = "/real/claude";
    process.env.CODEX_HOME = "/real/codex";
    try {
      const env = serverEnv("/tmp/fake-home", { USER: "getty" });
      // Compare names only: a failure must not print the environment.
      expect(["CLAUDE_CONFIG_DIR", "CODEX_HOME"].filter((k) => k in env)).toEqual([]);
      expect(env.HOME).toBe("/tmp/fake-home");
      expect(env.USER).toBe("getty");
    } finally {
      if (saved[0] === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved[0];
      if (saved[1] === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved[1];
    }
  });
});

describe("EndToEndTests", () => {
  test(
    "full level sends a large tool input whole",
    async () => {
      // The point of level full: a 600-line Write reaches IRC as 600 lines.
      // Needs all three tuning numbers and a LINELEN that fits 5000 bytes.
      const fake = await fakeIrc({ isupport: ["LINELEN=8192"] });
      const tmp = tempDir();
      const home = join(tmp, "home");
      const cwd = join(tmp, "proj");
      mkdirSync(join(home, ".codex"), { recursive: true });
      mkdirSync(cwd);
      writeFileSync(
        join(home, ".codex", "config.toml"),
        `[agent-irc]\nchannels = ["irc://getty@127.0.0.1:${fake.port}/#agents"]\n` +
          'level = "full"\nflood_burst = 2000\nflood_interval = 0.0005\nqueue_limit = 0\n',
      );
      const server = start(cwd, serverEnv(home, { USER: "getty" }), ["codex"]);
      const content = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n") + "\n" + "y".repeat(5000);
      server.write(
        rpc(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "codex" } }) +
          event(2, { event: "UserPromptSubmit", session_id: SID, cwd, prompt: "write it" }) +
          event(3, {
            event: "PostToolUse",
            session_id: SID,
            tool_name: "Write",
            tool_use_id: "w1",
            tool_input: { file_path: cwd + "/big.txt", content },
          }),
      );
      expect(await fake.waitFor((ls) => ls.includes("PRIVMSG #agents :    line 599"), 30)).toBe(true);
      expect(await fake.waitFor((ls) => ls.includes("PRIVMSG #agents :    " + "y".repeat(5000)), 30)).toBe(true);
      const { code, err } = await server.communicate();
      expect([code, err.includes("Traceback")]).toEqual([0, false]);
      const sent = new Set(fake.lines().filter((l) => l.startsWith("PRIVMSG #agents :")));
      const missing = Array.from({ length: 600 }, (_, i) => `PRIVMSG #agents :    line ${i}`).filter((l) => !sent.has(l));
      expect(missing).toEqual([]);
      expect([...sent].filter((l) => l.includes("dropped"))).toEqual([]);
    },
    60_000,
  );

  test(
    "subprocess mirrors session and quits on eof",
    async () => {
      const fake = await fakeIrc({ password: "pw" });
      const tmp = tempDir();
      const home = join(tmp, "home");
      const cwd = join(tmp, "simpici");
      mkdirSync(join(home, ".codex"), { recursive: true });
      mkdirSync(cwd);
      writeFileSync(
        join(home, ".codex", "config.toml"),
        `[agent-irc]\nchannels = ["irc://getty:\${IRC_PW}@127.0.0.1:${fake.port}/#agents"]\n`,
      );
      const server = start(cwd, serverEnv(home, { IRC_PW: "pw", USER: "getty" }));
      server.write(
        [
          rpc(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "codex", version: "0.153" } }),
          rpc(2, "tools/list", {}),
          event(3, { event: "UserPromptSubmit", session_id: SID, cwd, model: "gpt-5.6-sol", prompt: "hi" }),
          event(4, {
            event: "PreToolUse",
            session_id: SID,
            tool_name: "shell",
            tool_use_id: "c1",
            tool_input: { command: ["bash", "-lc", "ls"] },
          }),
          event(5, { event: "PostToolUse", session_id: SID, tool_name: "shell", tool_use_id: "c1" }),
        ].join(""),
      );
      const { code, out, err } = await server.communicate();
      expect(code).toBe(0);
      const responses = out
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { id: number; result: { serverInfo?: { name: string } } });
      expect(responses.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
      expect(responses[0]!.result.serverInfo!.name).toBe("agent-irc");
      expect(await fake.waitFor(quitSeen)).toBe(true);
      const lines = fake.lines();
      expect(lines.slice(0, 3)).toEqual(["PASS :pw", "NICK simpici-1", `USER getty 0 * :codex ${SID} ${cwd}`]);
      expect(lines).toContain("JOIN #agents");
      expect(lines).toContain(`PRIVMSG #agents :▶ session 01a06850 · codex gpt-5.6-sol · ${cwd}`);
      expect(lines).toContain("PRIVMSG #agents :» hi");
      expect(lines.some((l) => l.startsWith("PRIVMSG #agents :⚙ shell 0.") && l.endsWith(": bash -lc ls"))).toBe(true);
      expect(err).toContain("initialized by codex");
    },
    30_000,
  );

  test(
    "an irc message reaches the agent through read_messages",
    async () => {
      // The one inbound path: a DM waits until the agent asks for it.
      const fake = await fakeIrc();
      const tmp = tempDir();
      const home = join(tmp, "home");
      const cwd = join(tmp, "proj");
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(cwd);
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({
          "agent-irc": {
            channels: [`irc://127.0.0.1:${fake.port}/#agents`],
            listen: true,
            listen_from: ["getty!*@vhost.example"],
          },
        }),
      );
      const server = start(cwd, serverEnv(home, { USER: "getty" }), ["claude-code"]);
      await server.call(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } });
      const listed = (await server.call(2, "tools/list", {})) as { result: { tools: { name: string }[] } };
      expect(listed.result.tools.map((t) => t.name)).toEqual(["event", "read_messages"]);

      await server.call(3, "tools/call", { name: "event", arguments: { event: "UserPromptSubmit", session_id: SID, cwd, prompt: "hi" } });
      expect(await fake.waitFor((ls) => ls.includes("JOIN #agents"))).toBe(true);
      fake.sendToAll(":stranger!x@elsewhere PRIVMSG proj-1 :ignore me");
      fake.sendToAll(":getty!getty@vhost.example PRIVMSG #agents :not for anyone");
      fake.sendToAll(":getty!getty@vhost.example PRIVMSG proj-1 :carry on");
      fake.sendToAll(":getty!getty@vhost.example PRIVMSG #agents :proj-1: and this");

      type Content = { result: { content: { text: string }[] } };
      const deadline = performance.now() + 10_000;
      let report = "";
      while (performance.now() < deadline) {
        report = ((await server.call(4, "tools/call", { name: "read_messages", arguments: {} })) as Content).result.content[0]!.text;
        if (report.includes("and this")) break;
        await sleep(0.1);
      }
      expect(report).toContain("carry on");
      expect(report).toContain("→ dm:");
      expect(report).toContain("→ #agents: proj-1: and this");
      expect(report).not.toContain("ignore me");
      expect(report).not.toContain("not for anyone");
      expect(report).toContain("Untrusted");

      const drained = ((await server.call(5, "tools/call", { name: "read_messages", arguments: {} })) as Content).result
        .content[0]!.text;
      expect(drained).toContain("No IRC messages waiting.");

      const { code } = await server.communicate();
      expect(code).toBe(0);
      // Nothing of the inbound traffic goes back out to IRC: read-only.
      expect(fake.lines().filter((l) => l.includes("carry on") || l.includes("and this"))).toEqual([]);
    },
    30_000,
  );


  test("sigterm sends quit", async () => {
    const err = await assertQuitsOn(["SIGTERM"], 0, 143);
    expect(err).toContain("agent-irc: signal 15, shutting down");
  }, 20_000);

  test("sigint sends quit", async () => {
    await assertQuitsOn(["SIGINT"], 0, 130);
  }, 20_000);

  test("sighup sends quit", async () => {
    await assertQuitsOn(["SIGHUP"], 0, 129);
  }, 20_000);

  test("sigint then sigterm still sends quit", async () => {
    // Live-observed (Task 20, 2026-09-05): Claude Code sends SIGINT and,
    // ~100ms later, SIGTERM -- landing while shutdown() waits for the QUIT.
    const err = await assertQuitsOn(["SIGINT", "SIGTERM"], 0.1, 130);
    expect(err).toContain("agent-irc: signal 15, already shutting down");
  }, 20_000);

  test("sigterm then sigint: the first one counts", async () => {
    const err = await assertQuitsOn(["SIGTERM", "SIGINT"], 0.1, 143);
    expect(err).toContain("agent-irc: signal 2, already shutting down");
  }, 20_000);

  test("sigint and sigterm at once: one QUIT, the exit code of whichever Bun delivered first", async () => {
    const fake = await fakeIrc();
    const server = await startSession(fake);
    server.proc.kill("SIGINT");
    server.proc.kill("SIGTERM");
    expect(await fake.waitFor(quitSeen, 5)).toBe(true);
    const { code, err } = await server.communicate(false);
    const first = /agent-irc: signal (\d+), shutting down/.exec(err)?.[1];
    expect(first === "2" || first === "15").toBe(true);
    expect(code).toBe(128 + Number(first));
    expect(err).toMatch(/agent-irc: signal (2|15), already shutting down/);
    expect(fake.lines().filter((l) => l.startsWith("QUIT "))).toHaveLength(1);
  }, 20_000);

  test("a signal during an EOF shutdown neither cuts the QUIT short nor changes the exit code", async () => {
    // The fake stops reading after the JOIN, so the EOF's shutdown waits out
    // its stop budget (1.5s) for an answer to the QUIT; 0.3s into it the
    // SIGTERM lands. Python's is_stopped check: logged, nothing more.
    const fake = await fakeIrc({ stallAfterJoin: 1 });
    const server = await startSession(fake, { stalled: true });
    await server.proc.stdin.end();
    await sleep(0.3);
    server.proc.kill("SIGTERM");
    await sleep(0.1);
    fake.resumeAll();
    const { code, err } = await server.communicate(false);
    expect(await fake.waitFor(quitSeen, 5)).toBe(true);
    expect(err).toContain("agent-irc: signal 15, already shutting down");
    expect(code).toBe(0);
    expect(fake.lines().filter((l) => l.startsWith("QUIT "))).toHaveLength(1);
  }, 20_000);

  test("SessionEnd as the first event of a fresh process stays quiet", async () => {
    const fake = await fakeIrc();
    const tmp = tempDir();
    const home = join(tmp, "home");
    const cwd = join(tmp, "proj");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ "agent-irc": { channels: [`irc://127.0.0.1:${fake.port}/#q`] } }),
    );
    const server = start(cwd, serverEnv(home, { USER: "getty" }), ["claude-code"]);
    server.write(
      rpc(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } }) +
        event(2, { event: "SessionEnd", session_id: SID, cwd, reason: "other" }),
    );
    const { code, out, err } = await server.communicate();
    expect(code).toBe(0);
    expect(out.split("\n").filter(Boolean)).toHaveLength(2);
    expect(err).toContain("SessionEnd with no prior state");
    await sleep(0.2);
    expect(fake.lines()).toEqual([]);
  }, 20_000);

  test("the host word decides the harness over clientInfo", async () => {
    const fake = await fakeIrc();
    const tmp = tempDir();
    const home = join(tmp, "home");
    const cwd = join(tmp, "proj");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ "agent-irc": { channels: [`irc://127.0.0.1:${fake.port}/#h`] } }),
    );
    // clientInfo says codex, which has no config here; the host word says claude-code.
    const server = start(cwd, serverEnv(home, { USER: "getty" }), ["claude-code"]);
    server.write(
      rpc(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "codex-mcp-client" } }) +
        event(2, { event: "UserPromptSubmit", session_id: SID, cwd, prompt: "hi" }),
    );
    expect(await fake.waitFor((ls) => ls.includes("PRIVMSG #h :» hi"))).toBe(true);
    const { code, err } = await server.communicate();
    expect(code).toBe(0);
    expect(err).toContain("initialized by claude");
    expect(fake.lines()).toContain(`PRIVMSG #h :▶ session 01a06850 · claude · ${cwd}`);
  }, 20_000);
});

// The long-lived stdio server rules (Getty G2), checked on the real process.
describe("StdioRulesTests", () => {
  test("stdout carries JSON-RPC answers and nothing else, through a whole session", async () => {
    // AGENT_IRC_DEBUG, an unknown extra argument, a junk line, a bad config
    // and a signal: everything that logs, logs to stderr.
    const fake = await fakeIrc();
    const tmp = tempDir();
    const home = join(tmp, "home");
    const cwd = join(tmp, "proj");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        "agent-irc": {
          channels: [`irc://127.0.0.1:${fake.port}/#out`, "irc://broken url", "irc://x@127.0.0.1:${MISSING}/#y"],
          level: "full",
          listen: true,
          listen_from: ["*"],
        },
      }),
    );
    const server = start(cwd, serverEnv(home, { USER: "getty", AGENT_IRC_DEBUG: "1" }), ["claude-code", "extra"]);
    const transcript = join(tmp, "t.jsonl");
    writeFileSync(transcript, "not a transcript\n");
    server.write(
      [
        rpc(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } }),
        "this is not json\n",
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
        rpc(2, "tools/list", {}),
        event(3, { event: "UserPromptSubmit", session_id: SID, cwd, transcript_path: transcript, prompt: "hi\nthere" }),
        event(4, { event: "PreToolUse", session_id: SID, tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "ls" } }),
        event(5, { event: "PostToolUse", session_id: SID, tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "ls" } }),
        rpc(6, "tools/call", { name: "read_messages", arguments: {} }),
        rpc(7, "tools/call", { name: "nope" }),
        rpc(8, "resources/list", {}),
        event(9, { event: "Stop", session_id: SID, transcript_path: transcript }),
      ].join(""),
    );
    expect(await fake.waitFor((ls) => ls.some((l) => l.startsWith("PRIVMSG #out :✔ turn")), 10)).toBe(true);
    server.proc.kill("SIGTERM");
    const { code, out, err } = await server.communicate(false);
    expect(code).toBe(143);
    expect(err).toContain("agent-irc: event ");
    expect(err).toContain("not JSON");
    expect(out.endsWith("\n")).toBe(true);
    const lines = out.slice(0, -1).split("\n");
    expect(lines).toHaveLength(9);
    for (const line of lines) {
      const msg = JSON.parse(line) as Record<string, unknown>;
      expect(msg.jsonrpc).toBe("2.0");
      expect(typeof msg.id).toBe("number");
      expect("result" in msg !== "error" in msg).toBe(true);
    }
    expect(lines.map((l) => (JSON.parse(l) as { id: number }).id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  }, 20_000);

  test("stdin EOF before anything: exit 0, nothing on stdout", async () => {
    const tmp = tempDir();
    const server = start(tmp, serverEnv(join(tmp, "home")), ["codex"]);
    const { code, out } = await server.communicate();
    expect([code, out]).toEqual([0, ""]);
  });

  test("stdout gone: the loop stops, the QUIT still goes out, exit 0", async () => {
    const fake = await fakeIrc();
    const server = await startSession(fake);
    await server.out.line(); // initialize's answer
    await server.out.line(); // the event's
    // The reader's end of the pipe goes away; the next answer meets EPIPE.
    await server.out.cancel();
    server.write(rpc(3, "ping", {}));
    const [code, err] = await Promise.all([server.proc.exited, server.err]);
    expect(code).toBe(0);
    expect(err).toMatch(/agent-irc: stdout gone \(EPIPE\), stopping/);
    expect(await fake.waitFor(quitSeen, 5)).toBe(true);
  }, 20_000);
});
