// Port of tests/test_inbound.py: describe = the Python TestCase, test = its method.
import { beforeEach, describe, expect, test } from "bun:test";
import { INBOX_LIMIT, Inbox, allowed, mentions, unwrapCtcp } from "../src/inbound.js";

const MASK = "getty!getty@vhost.example";

describe("AllowedTests", () => {
  test("test_nothing_is_allowed_without_patterns", () => {
    expect(allowed(MASK, [])).toBe(false);
    expect(allowed(MASK, null)).toBe(false);
  });

  test("test_star_allows_everyone", () => {
    expect(allowed(MASK, ["*"])).toBe(true);
    expect(allowed("stranger!x@somewhere", ["*"])).toBe(true);
  });

  test("test_host_pattern", () => {
    const patterns = ["*!*@vhost.example"];
    expect(allowed(MASK, patterns)).toBe(true);
    expect(allowed("someone!other@vhost.example", patterns)).toBe(true);
    expect(allowed("getty!getty@evil.example", patterns)).toBe(false);
  });

  test("test_matching_ignores_case", () => {
    expect(allowed("Getty!Getty@VHost.Example", ["getty!*@vhost.example"])).toBe(true);
  });

  test("test_any_pattern_may_match", () => {
    const patterns = ["op!*@a.example", "getty!*@b.example"];
    expect(allowed("getty!getty@b.example", patterns)).toBe(true);
    expect(allowed("getty!getty@c.example", patterns)).toBe(false);
  });

  test("test_a_pattern_matches_the_whole_mask_not_a_part_of_it", () => {
    expect(allowed(MASK, ["vhost.example"])).toBe(false);
  });

  test("test_junk_patterns_are_ignored", () => {
    expect(allowed(MASK, [null, 7, { a: 1 }])).toBe(false);
  });
});

// Not in the Python suite: fnmatch's own syntax, which Python's fnmatch.translate
// (3.13) defines and the port reimplements. Each expectation was taken from
// Python's fnmatch.fnmatchcase.
describe("FnmatchSemantics", () => {
  test("? is one character, * any run including none", () => {
    expect(allowed("ab", ["a?"])).toBe(true);
    expect(allowed("a", ["a?"])).toBe(false);
    expect(allowed("a", ["a*"])).toBe(true);
    expect(allowed("a\nb", ["a*"])).toBe(true);
  });

  test("[seq], [!seq] and ranges", () => {
    expect(allowed("b", ["[abc]"])).toBe(true);
    expect(allowed("d", ["[abc]"])).toBe(false);
    expect(allowed("d", ["[!abc]"])).toBe(true);
    expect(allowed("m", ["[a-z]"])).toBe(true);
    expect(allowed("-", ["[a-]"])).toBe(true);
    expect(allowed("]", ["[]]"])).toBe(true);
    expect(allowed("x", ["[!]]"])).toBe(true);
  });

  test("an unclosed [ is a literal, an empty range matches nothing", () => {
    expect(allowed("[a", ["[a"])).toBe(true);
    expect(allowed("a", ["[z-a]"])).toBe(false);
    expect(allowed("!", ["[!]"])).toBe(false);
    expect(allowed("[!]", ["[!]"])).toBe(true);
  });

  test("a backslash is an ordinary character, not an escape", () => {
    expect(allowed("\\*", ["\\*"])).toBe(true);
    expect(allowed("\\x", ["\\*"])).toBe(true);
    expect(allowed("\\", ["[\\]"])).toBe(true);
  });

  test("a mask is lowered the way str.lower() lowers it", () => {
    expect(allowed("İ!x@y", ["i̇!x@y"])).toBe(true);
  });
});

describe("MentionTests", () => {
  test("test_addressed_at_the_start", () => {
    expect(mentions("agent-irc-1: status?", "agent-irc-1")).toBe(true);
  });

  test("test_named_in_the_middle", () => {
    expect(mentions("i think agent-irc-1 is stuck", "agent-irc-1")).toBe(true);
  });

  test("test_case_is_ignored", () => {
    expect(mentions("AGENT-IRC-1 hello", "agent-irc-1")).toBe(true);
  });

  test("test_a_longer_word_is_not_a_mention", () => {
    expect(mentions("agent-irc-11 is the other one", "agent-irc-1")).toBe(false);
    expect(mentions("xagent-irc-1", "agent-irc-1")).toBe(false);
  });

  test("test_punctuation_around_the_nick_still_counts", () => {
    expect(mentions("(agent-irc-1), look", "agent-irc-1")).toBe(true);
    expect(mentions("ping agent-irc-1.", "agent-irc-1")).toBe(true);
  });

  test("test_nick_with_regex_characters", () => {
    expect(mentions("hey foo[bar], hi", "foo[bar]")).toBe(true);
    expect(mentions("hey foo bar", "foo[bar]")).toBe(false);
  });

  test("test_no_nick_no_mention", () => {
    expect(mentions("anything", "")).toBe(false);
  });

  // Python's re.IGNORECASE lets the ASCII letters match İ, ı, ſ and K (Kelvin)
  // as well; JavaScript's /iu knows only ſ and K.
  test("ignore-case follows Python's re, dotted and dotless i included", () => {
    expect(mentions("hi agent-İrc", "agent-irc")).toBe(true);
    expect(mentions("hi agent-ırc", "agent-irc")).toBe(true);
    expect(mentions("xagent-irc", "agent-irc")).toBe(false);
    expect(mentions("ıagent-irc", "agent-irc")).toBe(false);
  });
});

describe("CtcpTests", () => {
  test("test_plain_text_passes_through", () => {
    expect(unwrapCtcp("hello")).toBe("hello");
  });

  test("test_action_becomes_a_readable_line", () => {
    expect(unwrapCtcp("\x01ACTION waves at agent-irc-1\x01")).toBe("* waves at agent-irc-1");
  });

  test("test_other_ctcp_is_dropped", () => {
    expect(unwrapCtcp("\x01VERSION\x01")).toBeNull();
    expect(unwrapCtcp("\x01PING 12345\x01")).toBeNull();
  });
});

describe("InboxTests", () => {
  let inbox: Inbox;
  beforeEach(() => {
    let tick = 0;
    inbox = new Inbox({ clock: () => 1757000000 + tick++ });
  });

  test("test_off_by_default", () => {
    expect(inbox.listening).toBe(false);
    expect(inbox.add(MASK, "agent-irc-1", "hi")).toBe(false);
    expect(inbox.report()).toContain("listen");
  });

  test("test_enabled_inbox_keeps_allowed_senders", () => {
    inbox.enable(["*!*@vhost.example"]);
    expect(inbox.listening).toBe(true);
    expect(inbox.add(MASK, "agent-irc-1", "carry on")).toBe(true);
    const report = inbox.report();
    expect(report).toContain("carry on");
    expect(report).toContain(MASK);
    expect(report).toContain("dm");
  });

  test("test_a_channel_message_names_its_channel", () => {
    inbox.enable(["*"]);
    inbox.add(MASK, "#agents", "agent-irc-1: status?");
    expect(inbox.report()).toContain("#agents");
  });

  test("test_report_drains", () => {
    inbox.enable(["*"]);
    inbox.add(MASK, "agent-irc-1", "once");
    expect(inbox.report()).toContain("once");
    expect(inbox.report()).not.toContain("once");
  });

  test("test_report_warns_that_the_content_is_untrusted", () => {
    inbox.enable(["*"]);
    inbox.add(MASK, "agent-irc-1", "hi");
    expect(inbox.report()).toContain("Untrusted");
  });

  test("test_senders_outside_the_allowlist_are_dropped", () => {
    inbox.enable(["getty!*@vhost.example"]);
    expect(inbox.add("stranger!x@elsewhere", "agent-irc-1", "rm -rf /")).toBe(false);
    expect(inbox.report()).not.toContain("rm -rf");
  });

  test("test_listen_without_an_allowlist_accepts_nothing", () => {
    const logs: string[] = [];
    inbox = new Inbox({ log: (line) => logs.push(line) });
    inbox.enable([]);
    expect(inbox.add(MASK, "agent-irc-1", "hi")).toBe(false);
    expect(logs.some((line) => line.includes("listen_from"))).toBe(true);
  });

  test("test_disable_turns_it_off_again", () => {
    inbox.enable(["*"]);
    inbox.disable();
    expect(inbox.listening).toBe(false);
    expect(inbox.add(MASK, "agent-irc-1", "hi")).toBe(false);
  });

  test("test_the_queue_is_bounded_and_says_what_it_dropped", () => {
    const small = new Inbox({ limit: 3 });
    small.enable(["*"]);
    for (let i = 0; i < 5; i++) small.add(MASK, "agent-irc-1", `message ${i}`);
    const report = small.report();
    expect(report).not.toContain("message 0");
    expect(report).not.toContain("message 1");
    expect(report).toContain("message 4");
    expect(report).toContain("2 older");
  });

  test("test_the_drop_count_resets_with_the_report", () => {
    const one = new Inbox({ limit: 1 });
    one.enable(["*"]);
    one.add(MASK, "agent-irc-1", "a");
    one.add(MASK, "agent-irc-1", "b");
    expect(one.report()).toContain("1 older");
    one.add(MASK, "agent-irc-1", "c");
    expect(one.report()).not.toContain("older");
  });

  test("test_an_empty_inbox_says_so", () => {
    inbox.enable(["*"]);
    const report = inbox.report();
    expect(report).toContain("No");
    expect(report).not.toContain("Untrusted");
  });

  test("test_the_default_limit_is_bounded", () => {
    expect(INBOX_LIMIT > 0 && INBOX_LIMIT <= 1000).toBe(true);
    expect(INBOX_LIMIT).toBe(200);
  });
});
