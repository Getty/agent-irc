// Port of tests/test_irc_helpers.py: describe = the Python TestCase, test = its method.
import { describe, expect, test } from "bun:test";
import { Server } from "../src/config.js";
import * as irc from "../src/irc.js";
import { FloodBucket, IrcConnection, LINELEN, nickCandidate, parseLine } from "../src/irc.js";

class Clock {
  t = 100.0;
  readonly now = () => this.t;
}

describe("FloodBucketTests", () => {
  test("test_burst_then_wait", () => {
    const clock = new Clock();
    const b = new FloodBucket(4, 2.0, clock.now);
    expect([0, 1, 2, 3].map(() => b.acquireDelay())).toEqual([0.0, 0.0, 0.0, 0.0]);
    expect(b.acquireDelay()).toBeCloseTo(2.0);
    clock.t += 1.0;
    expect(b.acquireDelay()).toBeCloseTo(1.0);
    clock.t += 1.0;
    expect(b.acquireDelay()).toBe(0.0);
    expect(b.acquireDelay()).toBeCloseTo(2.0);
  });

  test("test_refill_caps_at_burst", () => {
    const clock = new Clock();
    const b = new FloodBucket(2, 1.0, clock.now);
    clock.t += 100;
    expect([0, 1, 2].map(() => b.acquireDelay())).toEqual([0.0, 0.0, 1.0]);
  });

  test("test_backward_clock_never_locks_the_bucket", () => {
    const clock = new Clock();
    const b = new FloodBucket(2, 1.0, clock.now);
    expect([0, 1].map(() => b.acquireDelay())).toEqual([0.0, 0.0]);
    clock.t -= 3600;
    expect(b.acquireDelay()).toBeLessThanOrEqual(1.0);
    clock.t += 1.0;
    expect(b.acquireDelay()).toBe(0.0);
  });
});

describe("ParseLineTests", () => {
  test("test_prefix_and_trailing", () => {
    expect(parseLine(":srv 433 * agent-irc-1 :Nickname is already in use")).toEqual([
      "srv",
      "433",
      ["*", "agent-irc-1", "Nickname is already in use"],
    ]);
  });

  test("test_ping", () => {
    expect(parseLine("PING :abc")).toEqual([null, "PING", ["abc"]]);
    expect(parseLine("PING abc")).toEqual([null, "PING", ["abc"]]);
  });

  test("test_empty", () => {
    expect(parseLine("")).toEqual([null, "", []]);
  });

  test("test_nick_change", () => {
    expect(parseLine(":old!u@h NICK :new")).toEqual(["old!u@h", "NICK", ["new"]]);
  });
});

describe("NickCandidateTests", () => {
  test("test_suffix_and_truncation", () => {
    expect(nickCandidate("agent-irc", 1, 30)).toBe("agent-irc-1");
    expect(nickCandidate("agent-irc", 12, 30)).toBe("agent-irc-12");
    expect(nickCandidate("agent-irc", 1, 9)).toBe("agent-i-1");
    expect(nickCandidate("a-very-long-project-name-indeed-x", 7, 30)).toBe("a-very-long-project-name-ind-7");
    expect(nickCandidate("abc", 1, 2)).toBe("a-1");
  });
});

describe("IsupportTests", () => {
  const conn = () => {
    const c = new IrcConnection(new Server("irc", "h", 6667, "u", null, false), ["#a"], "agent-irc", "rn", () => {});
    c.nick = "agent-irc-1";
    return c;
  };

  test("test_tokens_values_and_negation", () => {
    const c = conn();
    c.noteIsupport(["agent-irc-1", "LINELEN=1024", "SAFELIST", "NICKLEN=32", "are supported by this server"].slice(1));
    expect(c.isupport).toEqual({ LINELEN: "1024", SAFELIST: "", NICKLEN: "32" });
    expect(c.linelen).toBe(1024);
    c.noteIsupport(["-LINELEN"]);
    expect("LINELEN" in c.isupport).toBe(false);
    expect(c.linelen).toBe(LINELEN);
  });

  test("test_implausible_linelen_falls_back", () => {
    const c = conn();
    for (const value of ["12", "0", "-5", "999999", "lots", ""]) {
      c.noteIsupport(["LINELEN=" + value]);
      expect([value, c.linelen]).toEqual([value, LINELEN]);
    }
  });

  test("test_payload_limit_shrinks_with_the_mask_and_the_channel", () => {
    const c = conn();
    const before = c.payloadLimit("#a");
    c.mask = "agent-irc-1!~getty@10.20.23.1";
    expect(c.payloadLimit("#a")).toBe(512 - ":agent-irc-1!~getty@10.20.23.1 PRIVMSG #a :".length - 2);
    expect(c.payloadLimit("#a")).toBeGreaterThan(before); // the guess is the pessimistic one
    expect(c.payloadLimit("#a") - c.payloadLimit("#agents")).toBe("gents".length);
  });

  test("test_payload_limit_never_goes_below_the_floor", () => {
    const c = conn();
    c.linelen = 128;
    expect(c.payloadLimit("#" + "x".repeat(60))).toBe(80);
  });

  test("payload limit counts the worst-case 76-byte mask before the JOIN echo", () => {
    const c = conn();
    expect(c.payloadLimit("#a")).toBe(512 - `:agent-irc-1!${"u".repeat(75)} PRIVMSG #a :`.length - 2);
  });
});

// Python's SendTimeoutTests check that sendall() is not bounded by the TLS
// read timeout. A Node socket neither blocks on write nor has a read timeout
// to inherit, so that pair has no counterpart; what is left of the raw
// writer to pin down is the bytes it hands the socket.
describe("RawWriterTests", () => {
  class Recorder {
    sent: Uint8Array[] = [];
    write(data: Uint8Array): boolean {
      this.sent.push(data);
      return true;
    }
  }
  const conn = () => {
    const c = new IrcConnection(new Server("ircs", "h", 6697, "u", null, false), ["#a"], "agent-irc", "rn", () => {});
    const rec = new Recorder();
    c.sock = rec as never;
    return { c, rec };
  };
  const text = (rec: Recorder) => rec.sent.map((d) => Buffer.from(d).toString("utf8"));

  test("a line goes out once, with CRLF", () => {
    const { c, rec } = conn();
    c.raw("PRIVMSG #a :hello");
    expect(text(rec)).toEqual(["PRIVMSG #a :hello\r\n"]);
  });

  test("line breaks become spaces and control characters go", () => {
    const { c, rec } = conn();
    c.raw("QUIT :a\r\nb\x01c\x7f");
    expect(text(rec)).toEqual(["QUIT :a  bc\r\n"]);
  });

  test("cut_bytes is the last-resort guard: a raw line never exceeds LINELEN", () => {
    const { c, rec } = conn();
    c.raw("QUIT :" + "ä".repeat(400)); // 806 bytes
    const [data] = rec.sent;
    expect(data!.length).toBeLessThanOrEqual(LINELEN);
    expect(text(rec)[0]).toBe("QUIT :" + "ä".repeat(252) + "\r\n"); // 6 + 504 = 510, no torn ä
  });

  // Python's str.encode("utf-8") raises on a lone surrogate (one can arrive
  // through a JSON "\ud800" escape in a hook payload); the exception takes
  // the connection down and the line with it. On IRC the line should go out:
  // the port sends U+FFFD in its place, counted as the 3 bytes it is.
  test("a lone surrogate goes out as U+FFFD instead of failing the line", () => {
    const { c, rec } = conn();
    c.raw("PRIVMSG #a :a\ud800b\udc00");
    expect(text(rec)).toEqual(["PRIVMSG #a :a�b�\r\n"]);
  });

  test("a lone surrogate at the cut is not torn", () => {
    const { c, rec } = conn();
    c.raw("QUIT :" + "x".repeat(503) + "\ud800" + "y".repeat(10));
    const bytes = rec.sent[0]!;
    expect(bytes.length).toBe(6 + 503 + 2); // the 3-byte U+FFFD would end at 512, past the 510 of room
    expect(text(rec)[0]).toBe("QUIT :" + "x".repeat(503) + "\r\n");
  });
});

describe("QueueLimitTests", () => {
  const conn = (channels: string[] = ["#a"], queueLimit?: number) =>
    new IrcConnection(
      new Server("irc", "h", 6667, "u", null, false),
      channels,
      "agent-irc",
      "rn",
      () => {},
      queueLimit === undefined ? {} : { queueLimit },
    );

  test("test_the_default_cap_drops_the_oldest", () => {
    const c = conn();
    for (let i = 0; i < irc.QUEUE_LIMIT + 3; i++) c.sendMessage(`m${i}`);
    expect([c.queue.length, c.dropped]).toEqual([irc.QUEUE_LIMIT, 3]);
  });

  test("test_zero_means_no_cap", () => {
    const c = conn(["#a"], 0);
    for (let i = 0; i < irc.QUEUE_LIMIT + 300; i++) c.sendMessage(`m${i}`);
    expect([c.queue.length, c.dropped]).toEqual([irc.QUEUE_LIMIT + 300, 0]);
  });

  test("test_an_explicit_cap_is_honoured", () => {
    const c = conn(["#a"], 10);
    for (let i = 0; i < 13; i++) c.sendMessage(`m${i}`);
    expect([c.queue.length, c.dropped]).toEqual([10, 3]);
  });

  test("test_the_cap_counts_logical_lines_not_channel_copies", () => {
    const c = conn(["#a", "#b"], 10);
    for (let i = 0; i < 13; i++) c.sendMessage(`m${i}`);
    expect([c.queue.length, c.dropped]).toEqual([10, 3]);
  });
});
