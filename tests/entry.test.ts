// bin/agent-irc, what .mcp.json starts under Claude Code: a POSIX sh wrapper
// that finds the plugin root from its own path and execs the getty-bun
// starter with `run dist/server.js claude-code`. On Windows Claude Code starts
// bin/agent-irc.exe (mcpoff) instead, which reads the "# mcpoff: tools" line
// out of the first 16 KB of this file (winlaunch/mcpoff.c, tools_from_script).
import { afterEach, describe, expect, test } from "bun:test";
import { accessSync, constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ENTRY = join(ROOT, "bin", "agent-irc");
const STUB = "printf '%s\\n' \"$0\" \"$@\"\n";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A plugin root holding a copy of bin/agent-irc and a stub starter. */
function fakeRoot(name = "plug in"): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "airentry.")));
  temps.push(base);
  const root = join(base, name);
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "bootstrap"));
  copyFileSync(ENTRY, join(root, "bin", "agent-irc")); // keeps the mode
  writeFileSync(join(root, "bootstrap", "getty-bun.sh"), STUB);
  return root;
}

function run(argv0: string, cwd: string) {
  const r = Bun.spawnSync([argv0], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("bin/agent-irc", () => {
  test("is an executable POSIX sh script", () => {
    expect(() => accessSync(ENTRY, constants.X_OK)).not.toThrow();
    expect(readFileSync(ENTRY, "utf8").split("\n", 1)[0]).toBe("#!/bin/sh");
  });

  test("keeps the mcpoff tools line where mcpoff.exe reads it", () => {
    const head = readFileSync(ENTRY).subarray(0, 16383).toString("latin1");
    const at = head.indexOf("# mcpoff: tools ");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(head.slice(at).split("\n", 1)[0]).toBe("# mcpoff: tools event");
  });

  test("execs the starter beside it with run dist/server.js claude-code", () => {
    const root = fakeRoot();
    const r = run(join(root, "bin", "agent-irc"), tmpdir());
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${root}/bootstrap/getty-bun.sh\nrun\ndist/server.js\nclaude-code\n`);
  });

  test("finds its root from a relative path, whatever the cwd", () => {
    const root = fakeRoot();
    const r = run("./agent-irc", join(root, "bin"));
    expect(r.out.split("\n")[0]).toBe(`${root}/bootstrap/getty-bun.sh`);
  });

  test("follows a chain of symlinks to the real plugin root", () => {
    const root = fakeRoot();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "airlink.")));
    temps.push(elsewhere);
    mkdirSync(join(elsewhere, "a"));
    symlinkSync(join(root, "bin", "agent-irc"), join(elsewhere, "a", "one")); // absolute target
    symlinkSync("a/one", join(elsewhere, "two")); // relative target
    const r = run(join(elsewhere, "two"), tmpdir());
    expect(r.err).toBe("");
    expect(r.out.split("\n")[0]).toBe(`${root}/bootstrap/getty-bun.sh`);
  });

  test("resolves a symlinked bin/ directory physically, not lexically", () => {
    // The file itself is no link here, only the directory it is reached
    // through: `cd "$dir/.."` would land in the link's parent.
    const root = fakeRoot();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "airlink.")));
    temps.push(elsewhere);
    symlinkSync(join(root, "bin"), join(elsewhere, "linkbin"));
    const r = run(join(elsewhere, "linkbin", "agent-irc"), tmpdir());
    expect(r.err).toBe("");
    expect(r.out.split("\n")[0]).toBe(`${root}/bootstrap/getty-bun.sh`);
  });

  test("passes the starter's exit code through", () => {
    const root = fakeRoot();
    writeFileSync(join(root, "bootstrap", "getty-bun.sh"), "exit 143\n");
    expect(run(join(root, "bin", "agent-irc"), tmpdir()).code).toBe(143);
  });

  test("hands the starter no argument of its own", () => {
    // The starter contract: no entry argument begins with '-'. Claude Code
    // passes none (.mcp.json args: []); anything else stays out.
    const root = fakeRoot();
    const r = Bun.spawnSync([join(root, "bin", "agent-irc"), "--debug", "x"], { stdout: "pipe" });
    expect(r.stdout.toString()).toBe(`${root}/bootstrap/getty-bun.sh\nrun\ndist/server.js\nclaude-code\n`);
  });
});
