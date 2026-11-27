// Port of tests/test_events_summary.py: describe = the Python TestCase, test = its method.
import { describe, expect, test } from "bun:test";
import { G, clean, displayToolName, toolSummary } from "../src/events.js";

const CWD = "/home/g/dev/proj";
const HOME = "/home/g";

describe("CleanTests", () => {
  test("test_drops_empty_and_placeholders", () => {
    const ev = { event: "Stop", prompt: "", model: null, agent_id: "${agent_id}", cwd: "/x" };
    expect(Object.fromEntries(clean(ev))).toEqual({ event: "Stop", cwd: "/x" });
  });

  test("test_parses_json_tool_input_string", () => {
    expect(clean({ tool_input: '{"command": "ls"}' }).get("tool_input")).toEqual(new Map([["command", "ls"]]));
    expect(clean({ tool_input: "{broken" }).get("tool_input")).toBe("{broken");
    expect(clean({ tool_input: { a: 1 } }).get("tool_input")).toEqual({ a: 1 });
  });

  test("test_none_and_non_dicts", () => {
    for (const bad of [null, "nonempty", [1, 2, 3], 42, 0, ""]) expect(clean(bad).size).toBe(0);
  });

  // Python's $ also matches before a trailing newline.
  test("a placeholder with a trailing newline is still a placeholder", () => {
    expect(clean({ agent_id: "${agent_id}\n" }).size).toBe(0);
  });
});

describe("ToolSummaryTests", () => {
  const s = (name: string, inp: unknown) => toolSummary(name, inp, CWD, HOME);

  test("test_shell", () => {
    expect(s("Bash", { command: "ls -la\nfind ." })).toBe("ls -la find . [+1 line]");
    expect(s("shell", { command: ["bash", "-lc", "make test"] })).toBe("bash -lc make test");
    expect(s("exec_command", { cmd: "pwd" })).toBe("pwd");
    expect([...s("Bash", { command: "x".repeat(300) })].length).toBe(120);
  });

  test("test_multiline_shell_keeps_every_line", () => {
    const script = 'python3 -c "\nimport json\nprint(json.dumps({}))\n"';
    expect(s("Bash", { command: script })).toBe('python3 -c " import json print(json.dumps({})) " [+3 lines]');
    const heredoc = "cat > x <<'EOF'\nhello\nEOF";
    expect(s("Bash", { command: heredoc })).toBe("cat > x <<'EOF' hello EOF [+2 lines]");
    expect(s("Bash", { command: "a\nb" })).toBe("a b [+1 line]");
    expect(s("Bash", { command: "ls\n\n" })).toBe("ls");
    const summary = s("Bash", { command: "head\n" + "x".repeat(300) });
    expect(summary.startsWith("head x")).toBe(true);
    expect(summary.endsWith("… [+1 line]")).toBe(true);
    expect(s("Agent", { subagent_type: "Explore", description: "find\nthe hooks" })).toBe("Explore: find the hooks");
  });

  test("test_files", () => {
    expect(s("Read", { file_path: CWD + "/hooks/hooks.json" })).toBe("hooks/hooks.json");
    expect(s("Edit", { file_path: HOME + "/x.py" })).toBe("~/x.py");
    expect(s("NotebookEdit", { notebook_path: "/etc/n.ipynb" })).toBe("/etc/n.ipynb");
  });

  test("test_grep_glob", () => {
    expect(s("Grep", { pattern: "hook_event", path: CWD + "/agent_irc" })).toBe("hook_event agent_irc");
    expect(s("Glob", { pattern: "**/*.py" })).toBe("**/*.py");
  });

  test("test_agent", () => {
    expect(s("Agent", { subagent_type: "Explore", description: "find hook payloads", prompt: "long" })).toBe(
      "Explore: find hook payloads",
    );
    expect(s("Agent", { prompt: "do it" })).toBe("agent: do it");
  });

  test("test_web_and_skill", () => {
    expect(s("WebFetch", { url: "https://x.y/z", prompt: "p" })).toBe("https://x.y/z");
    expect(s("WebSearch", { query: "irc numerics" })).toBe("irc numerics");
    expect(s("Skill", { skill: "brainstorming", args: "x" })).toBe("brainstorming");
  });

  test("test_apply_patch", () => {
    const patch = "*** Begin Patch\n*** Update File: lib/a.py\n@@\n*** Add File: /home/g/dev/proj/b.py\n*** End Patch";
    expect(s("apply_patch", { patch })).toBe("lib/a.py, b.py");
    expect(s("apply_patch", patch)).toBe("lib/a.py, b.py");
  });

  test("test_mcp_and_fallback", () => {
    expect(displayToolName("mcp__context7__query-docs")).toBe("query-docs");
    expect(displayToolName("Bash")).toBe("Bash");
    expect(s("mcp__context7__query-docs", { libraryId: "/x/y", n: 3 })).toBe("/x/y");
    expect(s("TodoWrite", { todos: [1, 2] })).toBe("");
    expect(s("Unknown", null)).toBe("");
    expect(s("Unknown", "raw text\nmore")).toBe("raw text more");
  });

  // Python's re.MULTILINE knows only \n as a line end; a JavaScript /m regex
  // would also end the file name at a \r.
  test("a patch file name runs to the newline, a carriage return included", () => {
    expect(s("apply_patch", "*** Update File: a\rb.py\n")).toBe("a b.py");
  });
});

describe("GlyphTests", () => {
  test("test_glyphs", () => {
    const keys = ["start", "end", "prompt", "tool", "fail", "sub_start", "sub_stop", "turn", "perm", "idle", "compact", "model"] as const;
    expect(keys.map((k) => G[k])).toEqual(["▶", "■", "»", "⚙", "✖", "⇢", "⇠", "✔", "⚠", "…", "⟲", "⇄"]);
  });
});
