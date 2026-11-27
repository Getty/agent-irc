// The server as the harnesses start it, through the getty-bun starter and a
// real Bun install: bin/agent-irc (Claude Code, .mcp.json) and the sh -c
// locator of .mcp.codex.json (Codex), against the fake ircd.
//
// Runs only when AGENT_IRC_BUN_MIRROR names where the pinned Bun archive comes
// from; it becomes GETTY_BUN_MIRROR for the starter (<mirror>/bun-v<version>/
// <archive>). A local copy of the archives as file:///… keeps it offline;
// https://github.com/oven-sh/bun/releases/download is the starter's own
// default, the real download. Everything lives in a temp HOME and GETTY_HOME.
//
// One install for the whole file: the first test finds no slot and installs
// it, the later ones start warm. Timings go to stderr as "starter: …" lines.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeIrcServer } from "./fakeirc.js";

const ROOT = join(import.meta.dir, "..");
const MIRROR = process.env.AGENT_IRC_BUN_MIRROR ?? "";
const PIN = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { gettyBun: { bunVersion: string } }).gettyBun.bunVersion;
const SID = "5f0c8a41-7d2e-4b9a-9a37-0c6f2e1d4b10";
const INSTALL_TIMEOUT_MS = 300_000;

const rpc = (id: number, method: string, params: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

let base = "";
let home = "";
let getty = "";
let proj = "";

/** What a harness gives the server: a plain environment, no moved config dir. */
function env(): Record<string, string> {
  const out: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    GETTY_HOME: getty,
    GETTY_BUN_MIRROR: MIRROR,
    USER: "getty",
    LANG: "C.UTF-8",
  };
  if (process.env.TMPDIR) out.TMPDIR = process.env.TMPDIR;
  return out;
}

class Started {
  readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly t0 = performance.now();
  readonly err: Promise<string>;
  private readonly reader: { read(): Promise<{ done: boolean; value?: Uint8Array | undefined }> };
  private buffer = "";
  out = "";

  constructor(cmd: string[]) {
    this.proc = Bun.spawn(cmd, { cwd: proj, env: env(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.reader = this.proc.stdout.getReader();
    this.err = new Response(this.proc.stderr).text();
  }

  async line(): Promise<string | null> {
    const decoder = new TextDecoder();
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) return null;
      const text = decoder.decode(value);
      this.out += text;
      this.buffer += text;
    }
  }

  async call(id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.proc.stdin.write(rpc(id, method, params));
    await this.proc.stdin.flush();
    const line = await this.line();
    expect(line).not.toBeNull();
    return JSON.parse(line!) as Record<string, unknown>;
  }

  /** Signal it with stdin still open, as the harnesses do; collect the rest. */
  async stop(signal: NodeJS.Signals): Promise<{ code: number | null; out: string; err: string }> {
    this.proc.kill(signal);
    while ((await this.line()) !== null);
    const code = await this.proc.exited;
    return { code, out: this.out, err: await this.err };
  }
}

/** The command line of a running process, as /proc shows it (Linux). */
function cmdline(pid: number): string[] | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1);
  } catch {
    return null;
  }
}

/** initialize, tools/list and one tools/call event; returns ms to the initialize answer. */
async function session(server: Started, fake: FakeIrcServer, channel: string, clientName: string): Promise<number> {
  const init = await server.call(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: clientName } });
  const ms = performance.now() - server.t0;
  expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe("agent-irc");
  const list = await server.call(2, "tools/list", {});
  expect((list.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toContain("event");
  const call = await server.call(3, "tools/call", { name: "event", arguments: { event: "UserPromptSubmit", session_id: SID, cwd: proj, prompt: "hi via the starter" } });
  expect(call.id).toBe(3);
  expect(await fake.waitFor((ls) => ls.includes(`PRIVMSG ${channel} :» hi via the starter`), 10)).toBe(true);
  return ms;
}

function claudeEntry(): string[] {
  return [join(ROOT, "bin", "agent-irc")];
}

function codexCommand(): string[] {
  const { command, args } = JSON.parse(readFileSync(join(ROOT, ".mcp.codex.json"), "utf8")).irc as { command: string; args: string[] };
  return [command, ...args];
}

describe.skipIf(MIRROR === "")("StarterEndToEndTests", () => {
  let fake: FakeIrcServer;

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "airstarter.")));
    home = join(base, "home");
    getty = join(base, "getty");
    proj = join(base, "proj");
    fake = await FakeIrcServer.create();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ "agent-irc": { channels: [`irc://127.0.0.1:${fake.port}/#claude`] } }));
    // Codex does not pass CODEX_HOME to the server (CLAUDE.md), so the
    // installed copy and its config are in ~/.codex here.
    const copy = join(home, ".codex", "plugins", "cache", "getty", "agent-irc", "0.0.0-test");
    for (const path of ["bin", "bootstrap", "dist", "hooks", ".codex-plugin", ".mcp.codex.json", "package.json"]) {
      cpSync(join(ROOT, path), join(copy, path), { recursive: true, preserveTimestamps: true });
    }
    writeFileSync(join(home, ".codex", "config.toml"), `[agent-irc]\nchannels = ["irc://127.0.0.1:${fake.port}/#codex"]\n`);
    // A project that would change the server if Bun read it: a bunfig preload
    // that leaves a marker, and an .env that turns on the debug log.
    mkdirSync(proj);
    writeFileSync(join(proj, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    writeFileSync(join(proj, "preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(join(base, "preloaded"))}, "");\n`);
    writeFileSync(join(proj, ".env"), "AGENT_IRC_DEBUG=1\n");
  });

  afterAll(async () => {
    await fake?.close();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test(
    "claude code: the first start installs Bun and stdout carries only JSON-RPC",
    async () => {
      expect(existsSync(join(getty, "runtimes", "bun", PIN))).toBe(false);
      const server = new Started(claudeEntry());
      const ms = await session(server, fake, "#claude", "claude-code");
      console.error(`starter: claude code, first start with install: ${ms.toFixed(0)} ms to the initialize answer`);
      expect(existsSync(join(getty, "runtimes", "bun", PIN))).toBe(true);
      // exec, not a child: the PID the harness holds is Bun's, with the
      // starter's isolation flags and the host word as the only argument
      const argv = cmdline(server.proc.pid);
      if (argv) {
        expect(argv.slice(1)).toEqual(["--no-install", "--config=/dev/null", "--no-env-file", join(ROOT, "dist", "server.js"), "claude-code"]);
        expect(argv[0]!.startsWith(join(getty, "runtimes", "bun", PIN) + "/")).toBe(true);
      }
      const { code, out, err } = await server.stop("SIGTERM");
      expect(code).toBe(143);
      const lines = out.split("\n");
      expect(lines.pop()).toBe("");
      expect(lines.map((l) => (JSON.parse(l) as { id: number }).id)).toEqual([1, 2, 3]);
      expect(fake.lines().filter((l) => l.startsWith("QUIT :session ended"))).toHaveLength(1);
      expect(err).not.toContain("agent-irc: event "); // .env not loaded
      expect(err).not.toContain("getty-bun:");
      expect(existsSync(join(base, "preloaded"))).toBe(false); // bunfig.toml not read
    },
    INSTALL_TIMEOUT_MS,
  );

  test(
    "codex: the sh -c locator starts the newest installed copy with the host word",
    async () => {
      const quits = fake.lines().filter((l) => l.startsWith("QUIT ")).length;
      const server = new Started(codexCommand());
      // A client name that names no harness: only the host word "codex"
      // makes the server read ~/.codex/config.toml and join #codex.
      const ms = await session(server, fake, "#codex", "mystery-client");
      console.error(`starter: codex locator, warm: ${ms.toFixed(0)} ms to the initialize answer`);
      const argv = cmdline(server.proc.pid);
      if (argv) {
        const copy = join(home, ".codex", "plugins", "cache", "getty", "agent-irc", "0.0.0-test");
        expect(argv.slice(1)).toEqual(["--no-install", "--config=/dev/null", "--no-env-file", join(copy, "dist", "server.js"), "codex"]);
      }
      const { code, out, err } = await server.stop("SIGTERM");
      expect(code).toBe(143);
      expect(out.split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { id: number }).id)).toEqual([1, 2, 3]);
      expect(fake.lines().filter((l) => l.startsWith("QUIT "))).toHaveLength(quits + 1);
      expect(err).not.toContain("agent-irc: event ");
      expect(existsSync(join(base, "preloaded"))).toBe(false);
    },
    INSTALL_TIMEOUT_MS,
  );

  test(
    "warm starts, SIGINT passes 130 through, and nothing lands in HOME",
    async () => {
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const server = new Started(claudeEntry());
        const init = await server.call(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } });
        times.push(performance.now() - server.t0);
        expect(init.id).toBe(1);
        const { code } = await server.stop("SIGINT");
        expect(code).toBe(130);
      }
      times.sort((a, b) => a - b);
      console.error(`starter: claude code, warm, N=5: min ${times[0]!.toFixed(0)} / median ${times[2]!.toFixed(0)} / max ${times[4]!.toFixed(0)} ms to the initialize answer`);
      // The bundle carries // @bun: no transpiler cache, nothing written to HOME
      expect(readdirSync(home).sort()).toEqual([".claude", ".codex"]);
    },
    INSTALL_TIMEOUT_MS,
  );
});
