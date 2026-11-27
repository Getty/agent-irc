// Port of tests/test_config_files.py: describe = the Python TestCase, test = its method.
//
// The Python reader has two TOML paths: tomllib (3.11+) and a fallback parser
// for one table (3.9, 3.10) whose value types had to be grown twice after a
// setting went missing there. The port has one path, Bun.TOML.parse, so
// TomlFallbackTests run the fallback's inputs through it instead: every value
// form the fallback knows has to come out of Bun.TOML.parse the same way.
// Where the fallback and tomllib disagree (an unterminated array, a bare
// date), the port follows tomllib.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../src/config.js";

const CODEX_TOML = `
approval_policy = "on-request"

[projects."/home/g"]
trust_level = "trusted"

[agent-irc]
channels = ["ircs://u:p@h/#a", 'irc://h/#b']
log_channels = [
  "ircs://u:p@h/#log",  # comment
]
level = "full"
flood_burst = 2000
flood_interval = 0.0005
queue_limit = 0
listen = true
listen_from = ["getty!*@vhost.example"]
ignored = 3

[other]
channels = ["irc://h/#not-ours"]
`;

const table = (text: string) => config.tomlNamespace(config.parseToml(text));

describe("TomlFallbackTests", () => {
  test("test_parse_table", () => {
    const t = table(CODEX_TOML);
    expect(t.channels).toEqual(["ircs://u:p@h/#a", "irc://h/#b"]);
    expect(t.log_channels).toEqual(["ircs://u:p@h/#log"]);
    expect(t.level).toBe("full");
    expect(t.flood_burst).toBe(2000);
    expect(t.flood_interval).toBe(0.0005);
    expect(t.queue_limit).toBe(0);
    expect(t.listen).toBe(true);
    expect(t.listen_from).toEqual(["getty!*@vhost.example"]);
    expect(t.ignored).toBe(3); // parsed here, dropped by merge_layers
  });

  test("test_parse_quoted_table_name", () => {
    const doc = config.parseToml(CODEX_TOML) as { projects: Record<string, unknown> };
    expect(doc.projects["/home/g"]).toEqual({ trust_level: "trusted" });
  });

  test("test_missing_table", () => {
    expect(table("[nothing]\nx = 1\n")).toEqual({});
  });

  test("test_escapes", () => {
    expect(table('[agent-irc]\nx = "a\\"b\\\\c"\n').x).toBe('a"b\\c');
  });

  test("test_bracket_inside_quoted_string", () => {
    expect(table('[agent-irc]\nchannels = ["irc://h/#a]b", "irc://h/#c"]\n').channels).toEqual([
      "irc://h/#a]b",
      "irc://h/#c",
    ]);
  });

  test("test_comment_with_quotes_inside_array", () => {
    const text = '[agent-irc]\nchannels = [\n  "irc://h/#a",  # not "this" one\n  "irc://h/#b",\n]\nlevel = "full"\n';
    const t = table(text);
    expect(t.channels).toEqual(["irc://h/#a", "irc://h/#b"]);
    expect(t.level).toBe("full");
  });

  test("test_numbers", () => {
    const text = "[agent-irc]\na = 0\nb = -7\nc = 1_000\nd = 0.5\ne = 2.5e-3\nf = 12  # trailing comment\n";
    // The isinstance(int/float) half of this test has no JavaScript
    // counterpart: a TOML number is a JS number either way.
    expect(table(text)).toEqual({ a: 0, b: -7, c: 1000, d: 0.5, e: 2.5e-3, f: 12 });
  });

  test("test_booleans", () => {
    const t = table("[agent-irc]\nlisten = true\nother = false  # comment\n");
    expect(t).toEqual({ listen: true, other: false });
    expect(typeof t.listen).toBe("boolean");
  });

  test("test_values_of_a_type_we_cannot_represent_are_skipped", () => {
    // tomllib reads a date and a time as such, never as a number or string;
    // merge_layers then has no key that takes them. Bun gives Temporal values.
    const t = table('[agent-irc]\nd = 1979-05-27\nt = 07:32:00\nlevel = "full"\n');
    expect(t.level).toBe("full");
    for (const key of ["d", "t"]) {
      expect(typeof t[key]).toBe("object");
      expect(Array.isArray(t[key])).toBe(false);
    }
    expect(config.mergeLayers([t]).values).toEqual({});
  });

  test("test_unterminated_array_keeps_what_it_read", () => {
    // The fallback kept the half-read array; tomllib rejects the file, and
    // so does the port: the whole file is skipped with a log line.
    const dir = mkdtempSync(join(tmpdir(), "airk7-toml-"));
    try {
      const path = join(dir, "config.toml");
      writeFileSync(path, '[agent-irc]\nchannels = ["irc://h/#a"\n');
      const logs: string[] = [];
      expect(config.readTomlNamespace(path, (line) => logs.push(line))).toEqual({});
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain("invalid TOML");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "airk7-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("ReaderTests", () => {
  test("test_json_namespace", () => {
    const p = write("s.json", JSON.stringify({ "agent-irc": { channels: ["irc://h/#a"] }, model: "x" }));
    expect(config.readJsonNamespace(p)).toEqual({ channels: ["irc://h/#a"] });
  });

  test("test_json_missing_or_invalid", () => {
    expect(config.readJsonNamespace(join(dir, "nope.json"))).toEqual({});
    let p = write("bad.json", "{not json");
    const logs: string[] = [];
    expect(config.readJsonNamespace(p, (line) => logs.push(line))).toEqual({});
    expect(logs.length > 0 && logs[0]!.includes("invalid JSON")).toBe(true);
    p = write("wrong.json", JSON.stringify({ "agent-irc": "string" }));
    expect(config.readJsonNamespace(p)).toEqual({});
  });

  test("test_toml_namespace_with_tomllib_if_available", () => {
    const p = write("config.toml", CODEX_TOML);
    const t = config.readTomlNamespace(p);
    expect(t.channels).toEqual(["ircs://u:p@h/#a", "irc://h/#b"]);
    expect(t.level).toBe("full");
    expect(t.listen).toBe(true);
  });

  test("test_toml_namespace_fallback", () => {
    // No fallback to force: the same keys through the one reader there is.
    const p = write("config.toml", CODEX_TOML);
    const t = config.readTomlNamespace(p);
    expect(t.log_channels).toEqual(["ircs://u:p@h/#log"]);
    expect(t.flood_burst).toBe(2000);
    expect(t.flood_interval).toBe(0.0005);
    expect(t.queue_limit).toBe(0);
  });

  test("test_toml_missing", () => {
    expect(config.readTomlNamespace(join(dir, "nope.toml"))).toEqual({});
  });
});

describe("TrustTests", () => {
  let home = "";
  beforeEach(() => {
    home = dir;
    mkdirSync(join(home, ".codex"));
  });

  test("test_ancestors", () => {
    expect(config.ancestors("/a/b/c")).toEqual(["/a/b/c", "/a/b", "/a", "/"]);
  });

  test("test_claude_trust_inherited", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        projects: { "/home/g/dev": { hasTrustDialogAccepted: true }, "/home/g/other": { hasTrustDialogAccepted: false } },
      }),
    );
    expect(config.isTrusted("claude", "/home/g/dev/proj", home)).toBe(true);
    expect(config.isTrusted("claude", "/home/g/other", home)).toBe(false);
    expect(config.isTrusted("claude", "/tmp/x", home)).toBe(false);
  });

  test("test_claude_trust_missing_file", () => {
    expect(config.isTrusted("claude", "/home/g/dev", home)).toBe(false);
  });

  test("test_codex_trust_inherited", () => {
    writeFileSync(join(home, ".codex", "config.toml"), CODEX_TOML);
    expect(config.isTrusted("codex", "/home/g/dev/proj", home)).toBe(true);
    expect(config.isTrusted("codex", "/home/other", home)).toBe(false);
  });

  test("test_codex_trust_follows_codex_home", () => {
    const elsewhere = join(home, "moved");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "config.toml"), CODEX_TOML);
    expect(config.isTrusted("codex", "/home/g/dev/proj", home, { CODEX_HOME: elsewhere })).toBe(true);
    // and nothing is read from ~/.codex any more
    expect(config.isTrusted("codex", "/home/g/dev/proj", home, { CODEX_HOME: "/nowhere" })).toBe(false);
  });

  test("test_claude_trust_follows_claude_config_dir", () => {
    const elsewhere = join(home, "cc");
    mkdirSync(elsewhere);
    writeFileSync(
      join(elsewhere, ".claude.json"),
      JSON.stringify({ projects: { "/home/g/dev": { hasTrustDialogAccepted: true } } }),
    );
    expect(config.isTrusted("claude", "/home/g/dev/proj", home, { CLAUDE_CONFIG_DIR: elsewhere })).toBe(true);
    expect(config.isTrusted("claude", "/home/g/dev/proj", home, { CLAUDE_CONFIG_DIR: "/nowhere" })).toBe(false);
  });

  test("test_claude_trust_stays_in_home_without_the_variable", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { "/home/g/dev": { hasTrustDialogAccepted: true } } }),
    );
    expect(config.isTrusted("claude", "/home/g/dev/proj", home, {})).toBe(true);
  });

  test("test_codex_trust_fallback_parser", () => {
    // No fallback parser in the port; the same document through Bun.TOML.parse.
    writeFileSync(join(home, ".codex", "config.toml"), CODEX_TOML);
    expect(config.isTrusted("codex", "/home/g/dev/proj", home)).toBe(true);
    expect(config.isTrusted("codex", "/home/other", home)).toBe(false);
  });
});

// Not in the Python suite: where JSON.parse and Python's json disagree.
describe("JsonSemantics", () => {
  test("a whole-valued float is still a float to the integer settings", () => {
    const p = write("s.json", '{"agent-irc": {"flood_burst": 4.0, "queue_limit": 1e2, "flood_interval": 1}}');
    expect(config.mergeLayers([config.readJsonNamespace(p)]).values).toEqual({ flood_interval: 1 });
  });

  test("NaN and Infinity are JSON to Python", () => {
    const p = write("s.json", '{"agent-irc": {"flood_interval": Infinity, "flood_burst": NaN, "level": "full"}}');
    const ns = config.readJsonNamespace(p);
    expect(ns.level).toBe("full");
    expect(config.mergeLayers([ns]).values).toEqual({ flood_interval: Infinity });
  });

  test("invalid UTF-8 makes the file invalid, as it does for Python", () => {
    const path = join(dir, "s.json");
    writeFileSync(path, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
    const logs: string[] = [];
    expect(config.readJsonNamespace(path, (line) => logs.push(line))).toEqual({});
    expect(logs[0]).toContain("invalid JSON");
  });

  test("a byte order mark makes the file invalid, as it does for json.load", () => {
    const p = write("s.json", '\ufeff{"agent-irc": {"level": "full"}}');
    const logs: string[] = [];
    expect(config.readJsonNamespace(p, (line) => logs.push(line))).toEqual({});
    expect(logs[0]).toContain("invalid JSON");
  });
});

// Not in the Python suite: where Bun.TOML.parse and tomllib disagree, and the
// port can follow tomllib.
describe("TomlSemantics", () => {
  test("a byte order mark makes the file invalid, as it does for tomllib", () => {
    const p = write("config.toml", '\ufeff[agent-irc]\nlevel = "full"\n');
    const logs: string[] = [];
    expect(config.readTomlNamespace(p, (line) => logs.push(line))).toEqual({});
    expect(logs[0]).toContain("invalid TOML");
  });
});
