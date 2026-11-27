// Port of tests/test_text.py: describe = the Python TestCase, test = its method.
import { describe, expect, test } from "bun:test";
import * as text from "../src/text.js";

describe("TextTests", () => {
  test("test_first_line", () => {
    expect(text.firstLine("  hello\nworld")).toBe("hello");
    expect(text.firstLine("")).toBe("");
    expect(text.firstLine(null)).toBe("");
  });

  test("test_truncate", () => {
    expect(text.truncate("a  b\n c", 10)).toBe("a b c");
    expect(text.truncate("abcdefghij", 10)).toBe("abcdefghij");
    expect(text.truncate("abcdefghijk", 10)).toBe("abcdefghi…");
    expect(text.truncate("abcdefg hij", 9)).toBe("abcdefg…");
  });

  test("test_cut_bytes_keeps_characters_whole", () => {
    const s = "aäöü"; // 1 + 2 + 2 + 2 bytes
    expect(text.cutBytes(s, 4)).toBe("aä");
    expect(text.cutBytes(s, 7)).toBe("aäöü");
    expect(text.cutBytes(s, 0)).toBe("");
  });

  test("test_split_message_words_and_paragraphs", () => {
    expect(text.splitMessage("one two three", 9)).toEqual(["one two", "three"]);
    expect(text.splitMessage("a\n\nb", 400)).toEqual(["a", "b"]);
    expect(text.splitMessage("", 400)).toEqual([]);
  });

  test("test_split_message_long_word", () => {
    expect(text.splitMessage("x".repeat(10), 4)).toEqual(["xxxx", "xxxx", "xx"]);
  });

  test("test_split_message_multibyte", () => {
    expect(text.splitMessage("ä".repeat(5), 4)).toEqual(["ää", "ää", "ä"]);
  });

  test("test_short_path", () => {
    expect(text.shortPath("/home/g/dev/p/a.py", "/home/g/dev/p", "/home/g")).toBe("a.py");
    expect(text.shortPath("/home/g/x/a.py", "/home/g/dev/p", "/home/g")).toBe("~/x/a.py");
    expect(text.shortPath("/home/g", "/home/g/dev/p", "/home/g")).toBe("~");
    expect(text.shortPath("/etc/hosts", "/home/g/dev/p", "/home/g")).toBe("/etc/hosts");
    expect(text.shortPath("rel.py", "/home/g/dev/p", "/home/g")).toBe("rel.py");
  });

  test("test_fmt_duration", () => {
    expect(text.fmtDuration(0.04)).toBe("0.0s");
    expect(text.fmtDuration(1.24)).toBe("1.2s");
    expect(text.fmtDuration(42.6)).toBe("43s");
    expect(text.fmtDuration(192)).toBe("3m12s");
    expect(text.fmtDuration(4320)).toBe("1h12m");
    expect(text.fmtDuration(9.96)).toBe("10s");
    expect(text.fmtDuration(59.6)).toBe("1m00s");
    expect(text.fmtDuration(3599.4)).toBe("59m59s");
    expect(text.fmtDuration(3599.6)).toBe("1h00m");
  });

  test("test_fmt_tokens", () => {
    expect(text.fmtTokens(0)).toBe("0");
    expect(text.fmtTokens(950)).toBe("950");
    expect(text.fmtTokens(1500)).toBe("2k");
    expect(text.fmtTokens(31000)).toBe("31k");
    expect(text.fmtTokens(210400)).toBe("210k");
    expect(text.fmtTokens(1200000)).toBe("1.2M");
    expect(text.fmtTokens(2000000)).toBe("2M");
    expect(text.fmtTokens(999499)).toBe("999k");
    expect(text.fmtTokens(999500)).toBe("1M");
    expect(text.fmtTokens(999999)).toBe("1M");
  });

  test("test_nick_base", () => {
    expect(text.nickBase("/home/g/dev/agent-irc")).toBe("agent-irc");
    expect(text.nickBase("/home/g/dev/My Project!")).toBe("my-project");
    expect(text.nickBase("/home/g/dev/2048")).toBe("p-2048");
    expect(text.nickBase("/")).toBe("agent");
    expect(text.nickBase("/home/g/dev/___")).toBe("agent");
  });
});

describe("SplitBlockTests", () => {
  test("test_keeps_indentation_and_expands_tabs", () => {
    const block = "def f():\n    if x:\n\t\treturn 1\n\n";
    expect(text.splitBlock(block)).toEqual(["def f():", "    if x:", "        return 1"]);
  });

  test("test_does_not_fit_lines_to_any_server", () => {
    expect(text.splitBlock("x".repeat(900))).toEqual(["x".repeat(900)]);
  });

  test("test_empty", () => {
    expect(text.splitBlock("")).toEqual([]);
    expect(text.splitBlock(null)).toEqual([]);
  });
});

describe("WrapPayloadTests", () => {
  test("test_short_line_stays_whole", () => {
    expect(text.wrapPayload("  hello world", 400)).toEqual(["  hello world"]);
    expect(text.wrapPayload("   ", 400)).toEqual([]);
  });

  test("test_continuations_keep_the_indent", () => {
    expect(text.wrapPayload("  aaa bbb ccc", 7)).toEqual(["  aaa", "  bbb", "  ccc"]);
  });

  test("test_word_longer_than_the_budget_is_cut_on_a_character_boundary", () => {
    expect(text.wrapPayload("ä".repeat(6), 4)).toEqual(["ää", "ää", "ää"]);
  });

  test("test_nothing_is_lost", () => {
    const line = "  " + Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const chunks = text.wrapPayload(line, 60);
    expect(chunks.map((c) => c.trim()).join(" ")).toBe(line.trim());
    for (const chunk of chunks) expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(60);
  });
});

// Not in the Python suite: the places where JavaScript's string model differs
// from Python's and the port has to follow Python's.
describe("PythonStringSemantics", () => {
  test("lengths count code points, not UTF-16 units", () => {
    expect(text.truncate("😀".repeat(5), 3)).toBe("😀😀…");
  });

  test("whitespace is Python's str.split() set", () => {
    // \x1c-\x1f and \x85 are whitespace to Python, U+FEFF is not.
    expect(text.truncate("a\x1cb\x85c\ufeffd", 20)).toBe("a b c\ufeffd");
  });

  test("first_line splits on every line boundary str.splitlines() knows", () => {
    expect(text.firstLine("\u2028 x\u2029y")).toBe("x");
    expect(text.lineCount("a\rb\x0bc\x0cd\x1ce\x85f\r\ng")).toBe(7);
  });

  test("fmt_duration rounds an exact tie half to even, as %.1f and round() do", () => {
    expect(text.fmtDuration(0.25)).toBe("0.2s");
    expect(text.fmtDuration(0.75)).toBe("0.8s");
    expect(text.fmtDuration(12.5)).toBe("12s");
    expect(text.fmtDuration(13.5)).toBe("14s");
  });

  test("expandtabs restarts its column after a carriage return", () => {
    expect(text.splitBlock("ab\tc\r\td")).toEqual(["ab  c\r    d"]);
  });

  test("short_path goes through relpath like os.path.relpath", () => {
    expect(text.shortPath("/home/g/dev/p/../x", "/home/g/dev/p", "/home/g")).toBe("../x");
    expect(text.shortPath("/home/g/dev/p", "/home/g/dev/p", "/home/g")).toBe(".");
  });

  test("a leading byte order mark is a character like any other", () => {
    expect(text.cutBytes("\ufeffab", 4)).toBe("\ufeffa");
    expect(text.cutBytes("\ufeffab", 2)).toBe("");
  });
});
