// Port of tests/test_config_merge.py: describe = the Python TestCase, test = its method.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../src/config.js";

const A = "ircs://a.example/";
const B = "ircs://b.example/";

const targets = (cfg: config.Config) => cfg.targets.map((t) => [t.server.host, t.channel]);

describe("MergeTests", () => {
  test("test_named_lists_override_by_name", () => {
    const user = { channels: [A + "#agents"], log_channels: [A + "#log"], level: "activity" };
    const cases: [Record<string, unknown>, string[]][] = [
      [{}, ["#agents", "#log"]],
      [{ simpici_channels: [A + "#simpici"] }, ["#agents", "#log", "#simpici"]],
      [{ channels: [B + "#foo"] }, ["#foo", "#log"]],
      [{ channels: [B + "#foo"], log_channels: [] }, ["#foo"]],
      [{ channels: [], log_channels: [] }, []],
    ];
    for (const [project, expected] of cases) {
      const { lists, level } = config.mergeLayers([user, project]);
      const got = [...lists.values()].flatMap((urls) => urls.map((u) => config.parseUrl(u, "x").channel));
      expect(got).toEqual(expected);
      expect(level).toBe("activity");
    }
  });

  test("test_level_most_specific_wins_and_validates", () => {
    expect(config.mergeLayers([{ level: "full" }, { level: "subactivity" }]).level).toBe("subactivity");
    expect(config.mergeLayers([{ level: "full" }, { level: "bogus" }]).level).toBe("full");
    expect(config.mergeLayers([{}]).level).toBe("activity");
  });

  test("test_tuning_numbers_are_read_and_validated", () => {
    let { values } = config.mergeLayers([{ flood_burst: 50, flood_interval: 0.05, queue_limit: 0 }]);
    expect(values).toEqual({ flood_burst: 50, flood_interval: 0.05, queue_limit: 0 });
    ({ values } = config.mergeLayers([{ flood_burst: 50 }, { flood_burst: 9 }]));
    expect(values).toEqual({ flood_burst: 9 });
  });

  test("test_tuning_nonsense_is_ignored", () => {
    const { values } = config.mergeLayers([{ flood_burst: "many", flood_interval: -1, queue_limit: -5, level: true }]);
    expect(values).toEqual({});
  });

  test("test_listen_is_off_until_a_layer_says_otherwise", () => {
    expect(config.mergeLayers([{}]).values).toEqual({});
    expect(config.mergeLayers([{ listen: true }]).values).toEqual({ listen: true });
    expect(config.mergeLayers([{ listen: true }, { listen: false }]).values).toEqual({ listen: false });
  });

  test("test_listen_from_is_one_list_and_the_last_layer_wins", () => {
    const { values } = config.mergeLayers([{ listen_from: ["a!*@b.example"] }, { listen_from: ["c!*@d.example", 5] }]);
    expect(values).toEqual({ listen_from: ["c!*@d.example"] });
  });

  test("test_listen_nonsense_is_ignored", () => {
    expect(config.mergeLayers([{ listen: "yes", listen_from: "getty!*@vhost" }]).values).toEqual({});
  });

  test("test_ignores_junk", () => {
    const { lists } = config.mergeLayers([
      { channels: "notalist", Channels: [], x_channels_y: [], foo: 1 },
      null,
      { team_channels: [A + "#t", 5] },
    ]);
    expect([...lists.entries()]).toEqual([["team_channels", [A + "#t"]]]);
  });

  test("test_resolve_dedupes_and_skips_bad_entries", () => {
    const logs: string[] = [];
    const lists = new Map([
      ["channels", [A + "#a", A + "#a", "ircs://u:${PW}@c.example/#c", "junk"]],
      ["other_channels", [A + "#b"]],
    ]);
    const got = config.resolveTargets(lists, { HOME: "/x" }, "me", (line) => logs.push(line));
    expect(got.map((t) => [t.server.host, t.channel])).toEqual([
      ["a.example", "#a"],
      ["a.example", "#b"],
    ]);
    expect(logs.length).toBe(2);
    expect(logs[0]).toContain("${PW} is not set");
    expect(logs[1]).toContain("junk");
  });

  test("test_resolve_expands_env", () => {
    const got = config.resolveTargets(new Map([["channels", ["ircs://${USER}:${PW}@h/#c"]]]), { USER: "me", PW: "s" }, "x");
    expect([got[0]!.server.user, got[0]!.server.password]).toEqual(["me", "s"]);
  });

  test("test_resolve_logs_redact_expanded_password", () => {
    const logs: string[] = [];
    const got = config.resolveTargets(
      new Map([["channels", ["ircs://u:${PW}@h:notaport/#c"]]]),
      { PW: "p@ss:word" },
      "x",
      (line) => logs.push(line),
    );
    expect(got).toEqual([]);
    expect(logs.length).toBe(1);
    expect(logs[0]).not.toContain("ss:word");
    expect(logs[0]).toContain("***@h");
  });
});

describe("LoadConfigTests", () => {
  let tmp = "";
  let home = "";
  let cwd = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "airk7-load-"));
    home = join(tmp, "home");
    cwd = join(tmp, "proj");
    for (const d of [".claude", ".codex"]) {
      mkdirSync(join(home, d), { recursive: true });
      mkdirSync(join(cwd, d), { recursive: true });
    }
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const write = (rel: string, content: unknown) =>
    writeFileSync(join(tmp, rel), typeof content === "string" ? content : JSON.stringify(content));

  function trust(): void {
    write("home/.claude.json", { projects: { [cwd]: { hasTrustDialogAccepted: true } } });
    appendFileSync(join(home, ".codex", "config.toml"), `\n[projects."${cwd}"]\ntrust_level = "trusted"\n`);
  }

  test("test_claude_layers", () => {
    write("home/.claude/settings.json", { "agent-irc": { channels: [A + "#agents"], log_channels: [A + "#log"] } });
    write("proj/.claude/settings.json", { "agent-irc": { channels: [B + "#foo"] } });
    write("proj/.claude/settings.local.json", { "agent-irc": { level: "full", log_channels: [] } });
    trust();
    const cfg = config.loadConfig("claude", cwd, home, { USER: "me" });
    expect(targets(cfg)).toEqual([["b.example", "#foo"]]);
    expect(cfg.level).toBe("full");
  });

  test("test_claude_untrusted_ignores_project", () => {
    write("home/.claude/settings.json", { "agent-irc": { channels: [A + "#agents"] } });
    write("proj/.claude/settings.json", { "agent-irc": { channels: [B + "#evil"], level: "full" } });
    const logs: string[] = [];
    const cfg = config.loadConfig("claude", cwd, home, { USER: "me" }, (line) => logs.push(line));
    expect(targets(cfg)).toEqual([["a.example", "#agents"]]);
    expect(cfg.level).toBe("activity");
    expect(logs.some((l) => l.includes("not trusted"))).toBe(true);
  });

  test("test_codex_layers", () => {
    write("home/.codex/config.toml", `[agent-irc]\nchannels = ["${A}#agents"]\nlog_channels = ["${A}#log"]\n`);
    write("proj/.codex/config.toml", `[agent-irc]\nsimpici_channels = ["${A}#simpici"]\nlevel = "subactivity"\n`);
    trust();
    const cfg = config.loadConfig("codex", cwd, home, { USER: "me" });
    expect(targets(cfg)).toEqual([
      ["a.example", "#agents"],
      ["a.example", "#log"],
      ["a.example", "#simpici"],
    ]);
    expect(cfg.level).toBe("subactivity");
  });

  test("test_listen_settings_reach_the_config", () => {
    write("home/.claude/settings.json", {
      "agent-irc": { channels: [A + "#agents"], listen: true, listen_from: ["getty!*@vhost.example"] },
    });
    const cfg = config.loadConfig("claude", cwd, home, { USER: "me" });
    expect(cfg.listen).toBe(true);
    expect(cfg.listenFrom).toEqual(["getty!*@vhost.example"]);
  });

  test("test_listen_is_off_and_empty_by_default", () => {
    const cfg = config.loadConfig("claude", cwd, home, {});
    expect(cfg.listen).toBe(false);
    expect(cfg.listenFrom).toEqual([]);
  });

  test("test_a_project_may_not_widen_the_allowlist_untrusted", () => {
    write("home/.claude/settings.json", {
      "agent-irc": { channels: [A + "#agents"], listen: true, listen_from: ["getty!*@vhost.example"] },
    });
    write("proj/.claude/settings.json", { "agent-irc": { listen_from: ["*"] } });
    const cfg = config.loadConfig("claude", cwd, home, { USER: "me" });
    expect(cfg.listenFrom).toEqual(["getty!*@vhost.example"]);
  });

  test("test_codex_home_moves_the_settings_file", () => {
    const moved = join(tmp, "elsewhere");
    mkdirSync(moved);
    writeFileSync(join(moved, "config.toml"), `[agent-irc]\nchannels = ["${A}#moved"]\n`);
    write("home/.codex/config.toml", `[agent-irc]\nchannels = ["${A}#home"]\n`);
    const cfg = config.loadConfig("codex", cwd, home, { USER: "me", CODEX_HOME: moved });
    expect(targets(cfg)).toEqual([["a.example", "#moved"]]);
  });

  test("test_claude_config_dir_moves_the_settings_file", () => {
    const moved = join(tmp, "cc");
    mkdirSync(moved);
    writeFileSync(join(moved, "settings.json"), JSON.stringify({ "agent-irc": { channels: [A + "#moved"] } }));
    write("home/.claude/settings.json", { "agent-irc": { channels: [A + "#home"] } });
    const cfg = config.loadConfig("claude", cwd, home, { USER: "me", CLAUDE_CONFIG_DIR: moved });
    expect(targets(cfg)).toEqual([["a.example", "#moved"]]);
  });

  test("test_no_config_at_all", () => {
    const cfg = config.loadConfig("claude", cwd, home, {});
    expect(cfg.targets).toEqual([]);
    expect(cfg.level).toBe("activity");
  });

  test("test_default_user_from_env", () => {
    write("home/.claude/settings.json", { "agent-irc": { channels: [A + "#a"] } });
    let cfg = config.loadConfig("claude", cwd, home, { USER: "getty" });
    expect(cfg.targets[0]!.server.user).toBe("getty");
    cfg = config.loadConfig("claude", cwd, home, {});
    expect(cfg.targets[0]!.server.user).toBe("agent");
  });

  test("test_codex_untrusted_ignores_project", () => {
    write("home/.codex/config.toml", `[agent-irc]\nchannels = ["${A}#agents"]\n`);
    write("proj/.codex/config.toml", `[agent-irc]\nchannels = ["${B}#evil"]\nlevel = "full"\n`);
    const logs: string[] = [];
    const cfg = config.loadConfig("codex", cwd, home, { USER: "me" }, (line) => logs.push(line));
    expect(targets(cfg)).toEqual([["a.example", "#agents"]]);
    expect(cfg.level).toBe("activity");
    expect(logs.some((l) => l.includes("not trusted"))).toBe(true);
  });
});

describe("TuningDefaultTests", () => {
  test("test_defaults_match_the_connection", () => {
    const cfg = config.makeConfig([], "activity");
    expect([cfg.floodBurst, cfg.floodInterval, cfg.queueLimit]).toEqual([4, 2.0, 500]);
  });
});
