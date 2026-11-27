// Port of tests/test_events_full.py: describe = the Python TestCase, test = its method.
import { beforeEach, describe, expect, test } from "bun:test";
import { Session, toolSummary } from "../src/events.js";

const HOME = "/home/g";
const CWD = "/home/g/dev/proj";
const clock = () => 1000.0;

describe("FullSummaryTests", () => {
  const f = (name: string, inp: unknown) => toolSummary(name, inp, CWD, HOME, null);

  test("test_a_long_value_is_not_cut", () => {
    expect(f("Bash", { command: "x".repeat(300) })).toBe("x".repeat(300));
    expect(f("WebFetch", { url: "https://x.y/" + "z".repeat(300) })).toBe("https://x.y/" + "z".repeat(300));
    expect(f("Agent", { subagent_type: "Explore", description: "d".repeat(300) })).toBe("Explore: " + "d".repeat(300));
  });

  test("test_the_head_is_the_first_line_not_the_folded_whole", () => {
    expect(f("Bash", { command: "ls -la\nfind ." })).toBe("ls -la [+1 line]");
    expect(f("Bash", { command: "head\n" + "x".repeat(300) })).toBe("head [+1 line]");
  });

  test("test_shorter_levels_still_cut", () => {
    expect([...toolSummary("Bash", { command: "x".repeat(300) }, CWD, HOME)].length).toBe(120);
  });
});

describe("FullBodyTests", () => {
  let s: Session;
  beforeEach(() => {
    s = new Session("claude", "full", CWD, HOME, { clock });
    s.handle({ event: "UserPromptSubmit", session_id: "abc12345", cwd: CWD, prompt: "go" });
  });

  const tool = (name: string, toolInput: unknown) =>
    s.handle({ event: "PostToolUse", session_id: "abc12345", tool_name: name, tool_use_id: "t1", tool_input: toolInput });

  test("test_a_written_file_goes_out_whole", () => {
    expect(tool("Write", { file_path: CWD + "/x.py", content: "one\ntwo" })).toEqual([
      "⚙ Write: x.py",
      "  file_path: /home/g/dev/proj/x.py",
      "  content:",
      "    one",
      "    two",
    ]);
  });

  test("test_a_shell_command_is_one_field_among_the_others", () => {
    expect(tool("Bash", { command: "cat <<'EOF'\nhi\nEOF", description: "demo" })).toEqual([
      "⚙ Bash: cat <<'EOF' [+2 lines]",
      "  command:",
      "    cat <<'EOF'",
      "    hi",
      "    EOF",
      "  description: demo",
    ]);
  });

  test("test_an_unknown_tool_renders_every_field", () => {
    expect(tool("mcp__x__y", { a: "1", b: "2" })).toEqual(["⚙ y: 1", "  a: 1", "  b: 2"]);
  });

  test("test_values_that_are_not_strings_are_json", () => {
    expect(tool("TodoWrite", { todos: [{ c: "a" }], n: 2 })).toEqual(["⚙ TodoWrite", '  todos: [{"c": "a"}]', "  n: 2"]);
  });

  test("test_a_raw_string_input_is_a_block_of_its_own", () => {
    const patch = "*** Begin Patch\n*** Update File: a.py\n*** End Patch";
    expect(tool("apply_patch", patch)).toEqual([
      "⚙ apply_patch: a.py",
      "  *** Begin Patch",
      "  *** Update File: a.py",
      "  *** End Patch",
    ]);
  });

  test("test_a_body_that_repeats_the_head_is_left_out", () => {
    expect(tool("Read", { file_path: CWD + "/x.py" })).toEqual(["⚙ Read: x.py"]);
    expect(tool("Bash", { command: "ls -la" })).toEqual(["⚙ Bash: ls -la"]);
  });

  test("test_a_prompt_is_not_cut_either", () => {
    const fresh = new Session("claude", "full", CWD, HOME, { clock });
    const lines = fresh.handle({ event: "UserPromptSubmit", session_id: "abc12345", cwd: CWD, prompt: "y".repeat(300) });
    expect(lines.slice(1)).toEqual(["» " + "y".repeat(300)]);
  });

  test("test_a_single_line_prompt_is_not_repeated_as_a_body", () => {
    const fresh = new Session("claude", "full", CWD, HOME, { clock });
    const lines = fresh.handle({ event: "UserPromptSubmit", session_id: "abc12345", cwd: CWD, prompt: "fix the bug" });
    expect(lines.slice(1)).toEqual(["» fix the bug"]);
  });

  test("test_a_multiline_prompt_keeps_its_first_line_only_in_the_head", () => {
    const fresh = new Session("claude", "full", CWD, HOME, { clock });
    const lines = fresh.handle({
      event: "UserPromptSubmit",
      session_id: "abc12345",
      cwd: CWD,
      prompt: "first line\nsecond line",
    });
    expect(lines.slice(1)).toEqual(["» first line", "  second line"]);
  });

  test("test_shorter_levels_send_no_body", () => {
    const sub = new Session("claude", "subactivity", CWD, HOME, { clock });
    sub.handle({ event: "UserPromptSubmit", session_id: "abc12345", cwd: CWD, prompt: "go" });
    expect(
      sub.handle({
        event: "PostToolUse",
        session_id: "abc12345",
        tool_name: "Write",
        tool_use_id: "t1",
        tool_input: { file_path: "/x", content: "a\nb" },
      }),
    ).toEqual(["⚙ Write: /x"]);
  });
});

// Not in the Python suite: a tool input arrives as a JSON string (the hook
// template substitutes ${tool_input} that way), and json.loads keeps what
// JSON.parse would lose -- key order and the float in 1.0 -- while json.dumps
// writes Python's spelling of them.
describe("JsonToolInputSemantics", () => {
  test("keys keep their order, integer-like ones included", () => {
    const s = new Session("claude", "full", CWD, HOME, { clock });
    s.handle({ event: "UserPromptSubmit", session_id: "abc12345", cwd: CWD, prompt: "go" });
    expect(
      s.handle({
        event: "PostToolUse",
        session_id: "abc12345",
        tool_name: "mcp__x__y",
        tool_input: '{"b": "first", "2": "x", "1": [1.0, 1e16, 1e-5, 0.1, -0.0, true, null, "\\u00e4\\n"]}',
      }),
    ).toEqual([
      "⚙ y: first",
      "  b: first",
      "  2: x",
      '  1: [1.0, 1e+16, 1e-05, 0.1, -0.0, true, null, "ä\\n"]',
    ]);
  });

  test("a list as the whole input sends the head alone", () => {
    const s = new Session("claude", "full", CWD, HOME, { clock });
    s.handle({ event: "UserPromptSubmit", session_id: "abc12345", cwd: CWD, prompt: "go" });
    expect(
      s.handle({ event: "PostToolUse", session_id: "abc12345", tool_name: "x", tool_input: `["a", 1, {"k": "it's"}]` }),
    ).toEqual(["⚙ x"]);
  });

  test("a value that is not a string is shown as Python's str() of it", () => {
    expect(toolSummary("Bash", '{"command": {"k": ["it\'s", 1.5, true, null]}}', CWD, HOME, null)).toBe(
      `{"command": {"k": ["it's", 1.5, true, null]}}`,
    );
    expect(toolSummary("Bash", { command: new Map<string, unknown>([["k", ["it's", 1.5, true, null]]]) }, CWD, HOME)).toBe(
      `{'k': ["it's", 1.5, True, None]}`,
    );
  });
});
