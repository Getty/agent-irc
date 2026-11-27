// Port of tests/test_manifests.py: describe = the Python TestCase, test = its method.
// The hook files and manifests are the same ones the Python suite checks;
// only test_versions_match changes, from agent_irc.__version__ to src/version.ts.
import { describe, expect, test } from "bun:test";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/version.js";

const ROOT = join(import.meta.dir, "..");

const CLAUDE_EVENTS = new Set([
  "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "SubagentStart", "SubagentStop", "Stop", "StopFailure", "PermissionRequest",
  "Notification", "PostCompact", "PostModelSwitch", "SessionEnd",
]);
const INPUT_KEYS = new Set([
  "event", "session_id", "cwd", "transcript_path", "model", "turn_id",
  "agent_id", "agent_type", "agent_transcript_path", "tool_name",
  "tool_use_id", "tool_input", "prompt", "last_assistant_message", "message",
  "notification_type", "error_type", "error_message", "trigger", "reason",
  "source", "from_model", "to_model", "duration",
]);

type Hook = { type: string; server: string; tool: string; async: boolean; timeout: number; input: Record<string, string> };
type Hooks = Record<string, { matcher?: string; hooks: Hook[] }[]>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function load(rel: string): any {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("ManifestTests", () => {
  test("claude manifest", () => {
    const m = load(".claude-plugin/plugin.json");
    expect(m.name).toBe("agent-irc");
    expect(m.mcpServers).toBe("./.mcp.json");
    // Claude Code auto-loads hooks/hooks.json; declaring it again makes it
    // log "Duplicate hooks file detected" (observed live 2026-09-05).
    expect("hooks" in m).toBe(false);
  });

  test("codex manifest", () => {
    const m = load(".codex-plugin/plugin.json");
    expect(m.name).toBe("agent-irc");
    expect(m.mcpServers).toBe("./.mcp.codex.json");
    expect(m.hooks).toBe("./hooks/codex.json");
  });

  test("codex mcp json is a self locating bootstrap", () => {
    const m = load(".mcp.codex.json");
    expect(m.irc.command).toBe("python3");
    // "-I" keeps the session cwd off sys.path (see CLAUDE.md).
    expect(m.irc.args[0]).toBe("-I");
    expect(m.irc.args[1]).toBe("-c");
    const code: string = m.irc.args[2];
    expect(code).toContain("plugins");
    expect(code).toContain("agent-irc");
    expect(code).toContain("CODEX_HOME");
    expect(code).not.toContain("${");
  });

  test("codex hooks address the bare server name", () => {
    // Codex 0.153.4: the plugin-qualified form never calls tools/call (2026-09-05).
    const codex: Hooks = load("hooks/codex.json").hooks;
    for (const [event, groups] of Object.entries(codex)) {
      for (const group of groups) for (const hook of group.hooks) expect([event, hook.server]).toEqual([event, "irc"]);
    }
  });

  test("codex hooks use a per event field whitelist", () => {
    // Codex hard-fails an mcp_tool hook whose input names a placeholder it
    // does not recognise for that event; each set is what was confirmed live
    // (2026-09-05, Codex 0.153.4). See the Python test for the full story.
    const base = ["event", "session_id", "cwd", "transcript_path", "model", "turn_id"];
    const fields: Record<string, string[]> = {
      UserPromptSubmit: [...base, "prompt"],
      PreToolUse: [...base, "tool_name", "tool_input", "tool_use_id"],
      PostToolUse: [...base, "tool_name", "tool_input", "tool_use_id"],
      SubagentStart: [...base, "agent_id", "agent_type"],
      SubagentStop: [...base, "agent_id", "agent_type", "agent_transcript_path", "last_assistant_message"],
      Stop: [...base, "last_assistant_message"],
      Interrupt: base,
      PermissionRequest: base,
      PostCompact: base,
    };
    const shared: Hooks = load("hooks/hooks.json").hooks;
    const codex: Hooks = load("hooks/codex.json").hooks;
    expect(sorted(Object.keys(codex))).toEqual(sorted(Object.keys(fields)));
    for (const [event, keys] of Object.entries(fields)) {
      const hook = codex[event]![0]!.hooks[0]!;
      expect([event, hook.type]).toEqual([event, "mcp_tool"]);
      expect([event, hook.tool]).toEqual([event, "event"]);
      expect([event, hook.async]).toEqual([event, true]);
      // Codex clamps Interrupt hooks to 3s and warns on every session that asks for more.
      expect([event, hook.timeout]).toEqual([event, event === "Interrupt" ? 3 : 5]);
      expect([event, sorted(Object.keys(hook.input))]).toEqual([event, sorted(keys)]);
      for (const key of keys) {
        let expected = key === "event" ? "${hook_event_name}" : "${" + key + "}";
        if (event in shared) expected = shared[event]![0]!.hooks[0]!.input[key]!;
        expect([event, key, hook.input[key]]).toEqual([event, key, expected]);
      }
    }
  });

  test("versions match", () => {
    expect("version" in load(".claude-plugin/plugin.json")).toBe(false);
    expect(load(".codex-plugin/plugin.json").version).toBe(VERSION);
  });

  test("version.ts is the Python server's version while both exist", () => {
    const init = join(ROOT, "agent_irc", "__init__.py");
    if (!existsSync(init)) return;
    const m = /__version__ = "([^"]+)"/.exec(readFileSync(init, "utf8"));
    expect(m?.[1]).toBe(VERSION);
  });

  test("mcp json", () => {
    // The documented shape wraps the servers in "mcpServers".
    const m = load(".mcp.json");
    expect(Object.keys(m)).toEqual(["mcpServers"]);
    expect(m.mcpServers.irc.command).toBe("${CLAUDE_PLUGIN_ROOT}/bin/agent-irc");
    expect(m.mcpServers.irc.args).toEqual([]);
  });

  test("windows gets the off server", () => {
    expect(statSync(join(ROOT, "bin", "agent-irc.exe")).isFile()).toBe(true);
    expect(() => accessSync(join(ROOT, "bin", "agent-irc"), constants.X_OK)).not.toThrow();
    expect(readFileSync(join(ROOT, "bin", "agent-irc"), "utf8")).toContain("# mcpoff: tools event\n");
  });

  test("hooks", () => {
    // Interrupt is Codex's event, not Claude Code's (checked 2026-09-07); it
    // lives in hooks/codex.json only.
    const hooks: Hooks = load("hooks/hooks.json").hooks;
    expect(sorted(Object.keys(hooks))).toEqual(sorted(CLAUDE_EVENTS));
    for (const [event, groups] of Object.entries(hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect([event, hook.type, hook.server, hook.tool, hook.async, hook.timeout]).toEqual([
            event, "mcp_tool", "plugin:agent-irc:irc", "event", true, 5,
          ]);
          expect([event, sorted(Object.keys(hook.input))]).toEqual([event, sorted(INPUT_KEYS)]);
          expect(hook.input.event).toBe("${hook_event_name}");
        }
      }
    }
    expect(hooks.Notification![0]!.matcher).toBe("idle_prompt");
  });
});
