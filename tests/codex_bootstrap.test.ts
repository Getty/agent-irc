// Port of tests/test_codex_bootstrap.py to the `sh -c` locator in
// .mcp.codex.json. Codex substitutes nothing in a plugin's MCP config and
// passes the server no install root (CLAUDE.md), so the command finds the
// newest installed copy under $CODEX_HOME (default ~/.codex) itself, by the
// mtime of its starter -- the rule the Python bootstrap applied to
// bin/agent-irc -- and hands it `run dist/server.js codex`.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
// Prints what the real starter would get: its own path, then its arguments.
const STUB = "printf '%s\\n' \"$0\" \"$@\"\n";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "airboot."): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function server(): { command: string; args: string[] } {
  return JSON.parse(readFileSync(join(ROOT, ".mcp.codex.json"), "utf8")).irc;
}

/** One installed copy: <home>/plugins/cache/<marketplace>/agent-irc/<version>/bootstrap/getty-bun.sh. */
function install(home: string, marketplace: string, version: string, mtime?: number): string {
  const dir = join(home, "plugins", "cache", marketplace, "agent-irc", version, "bootstrap");
  mkdirSync(dir, { recursive: true });
  const starter = join(dir, "getty-bun.sh");
  writeFileSync(starter, STUB); // mode 0644, as cp -p of the rendered starter leaves it
  if (mtime !== undefined) utimesSync(starter, mtime, mtime);
  return starter;
}

function runLocator(env: Record<string, string | undefined>, cwd?: string) {
  const { command, args } = server();
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "CODEX_HOME") base[k] = v;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  const r = Bun.spawnSync([command, ...args], { env: base, cwd: cwd ?? tempDir("aircwd."), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("CodexBootstrapTests", () => {
  test("runs the newest cached copy", () => {
    const home = tempDir();
    install(home, "getty", "0.0.9", 1);
    const newer = install(home, "getty", "0.1.0");
    install(home, "other", "9.9.9", 1000); // a name that sorts last loses to the newer mtime
    const r = runLocator({ CODEX_HOME: home });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${newer}\nrun\ndist/server.js\ncodex\n`);
  });

  test("the newest wins whatever order the glob lists the copies in", () => {
    const home = tempDir();
    const newest = install(home, "a", "0.0.1", 3000);
    install(home, "b", "0.0.2", 2000);
    install(home, "c", "0.0.3", 1000);
    expect(runLocator({ CODEX_HOME: home }).out.split("\n")[0]).toBe(newest);
  });

  test("fails loudly when not installed", () => {
    const home = tempDir();
    const r = runLocator({ CODEX_HOME: home });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toBe(`agent-irc: no installed copy under ${home}/plugins/cache\n`);
  });

  test("an installed copy without a starter does not count", () => {
    // An old Python-era copy has bin/agent-irc but no bootstrap/.
    const home = tempDir();
    mkdirSync(join(home, "plugins", "cache", "getty", "agent-irc", "0.2.1", "bin"), { recursive: true });
    writeFileSync(join(home, "plugins", "cache", "getty", "agent-irc", "0.2.1", "bin", "agent-irc"), "#!/usr/bin/env python3\n");
    const r = runLocator({ CODEX_HOME: home });
    expect(r.code).toBe(1);
    expect(r.err).toContain("agent-irc: no installed copy under");
  });

  test("without CODEX_HOME it looks in ~/.codex", () => {
    const home = tempDir();
    const starter = install(join(home, ".codex"), "getty", "0.3.0");
    const r = runLocator({ CODEX_HOME: undefined, HOME: home });
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe(starter);
  });

  test("an empty CODEX_HOME counts as unset, as in the Python bootstrap", () => {
    const home = tempDir();
    const starter = install(join(home, ".codex"), "getty", "0.3.0");
    expect(runLocator({ CODEX_HOME: "", HOME: home }).out.split("\n")[0]).toBe(starter);
  });

  test("a CODEX_HOME with spaces and glob characters", () => {
    const home = join(tempDir(), "my codex [home]*");
    const starter = install(home, "getty", "0.3.0");
    const r = runLocator({ CODEX_HOME: home });
    expect(r.err).toBe("");
    expect(r.out.split("\n")[0]).toBe(starter);
  });

  test("passes the starter's exit code through", () => {
    const home = tempDir();
    const starter = install(home, "getty", "0.3.0");
    writeFileSync(starter, "exit 7\n");
    expect(runLocator({ CODEX_HOME: home }).code).toBe(7);
  });

  test("does not read anything from the session cwd", () => {
    // The Python bootstrap needed -I so a glob.py in the cwd could not run.
    // sh -c reads no file from the cwd; a planted getty-bun.sh or bootstrap/
    // there must not be what runs.
    const home = tempDir();
    const starter = install(home, "getty", "0.1.0");
    const cwd = tempDir("aircwd.");
    mkdirSync(join(cwd, "bootstrap"));
    writeFileSync(join(cwd, "bootstrap", "getty-bun.sh"), "echo planted\n");
    writeFileSync(join(cwd, "getty-bun.sh"), "echo planted\n");
    const r = runLocator({ CODEX_HOME: home }, cwd);
    expect(r.out.split("\n")[0]).toBe(starter);
    expect(r.out).not.toContain("planted");
  });
});
