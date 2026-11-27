// Port of tests/test_irc_connection.py: describe = the Python TestCase, test = its method.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { Server, parseUrl } from "../src/config.js";
import { FloodBucket, IrcConnection, type ConnectionOptions } from "../src/irc.js";
import { FakeIrcServer, type FakeOptions } from "./fakeirc.js";

const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

async function hasIpv6Loopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(0, "::1", () => s.close(() => resolve(true)));
  });
}
const IPV6 = await hasIpv6Loopback();

const fastBucket = () => new FloodBucket(1000, 0.001);

async function waitUntil(predicate: () => unknown, timeout = 5.0): Promise<boolean> {
  const deadline = performance.now() + timeout * 1000;
  while (performance.now() < deadline) {
    if (predicate()) return true;
    await sleep(0.02);
  }
  return false;
}

/** addCleanup: run in reverse order after each test. */
function cleanups() {
  const stack: (() => unknown)[] = [];
  afterEach(async () => {
    while (stack.length) await stack.pop()!();
  });
  return (fn: () => unknown) => stack.push(fn);
}

describe("ConnectionTests", () => {
  let logs: string[];
  const addCleanup = cleanups();
  beforeEach(() => {
    logs = [];
  });

  async function fakeServer(options: FakeOptions = {}): Promise<FakeIrcServer> {
    const fake = await FakeIrcServer.create(options);
    addCleanup(() => fake.close());
    return fake;
  }

  function server(fake: FakeIrcServer, password: string | null = null): Server {
    return new Server("irc", "127.0.0.1", fake.port, "getty", password, false);
  }

  function start(target: Server, channels: string[], options: ConnectionOptions = {}): IrcConnection {
    const conn = new IrcConnection(target, channels, "agent-irc", "claude e873 ~/dev/agent-irc", (l) => logs.push(l), {
      wait: () => {},
      bucket: fastBucket(),
      ...options,
    });
    conn.start();
    addCleanup(() => conn.close("test over", 2.0));
    return conn;
  }

  function connect(fake: FakeIrcServer, password: string | null = null, channels = ["#a", "#b"]): IrcConnection {
    return start(server(fake, password), channels);
  }

  function privmsgs(fake: FakeIrcServer, channel = "#a"): string[] {
    const head = `PRIVMSG ${channel} :`;
    return fake
      .lines()
      .filter((l) => l.startsWith(head))
      .map((l) => l.slice(head.length));
  }

  test("test_registration_join_privmsg_quit", async () => {
    const fake = await fakeServer({ password: "s3cret" });
    const conn = connect(fake, "s3cret");
    expect(await fake.waitFor((ls) => ls.includes("JOIN #b"))).toBe(true);
    expect(fake.lines().slice(0, 3)).toEqual([
      "PASS :s3cret",
      "NICK agent-irc-1",
      "USER getty 0 * :claude e873 ~/dev/agent-irc",
    ]);
    expect(conn.nick).toBe("agent-irc-1");
    conn.sendMessage("▶ session e873ddde · claude · ~/dev/agent-irc");
    expect(await fake.waitFor((ls) => ls.includes("PRIVMSG #b :▶ session e873ddde · claude · ~/dev/agent-irc"))).toBe(true);
    expect(fake.lines()).toContain("PRIVMSG #a :▶ session e873ddde · claude · ~/dev/agent-irc");
    await conn.close("session ended · 5.0s · 1 turns · 0 tools");
    expect(await fake.waitFor((ls) => ls.includes("QUIT :session ended · 5.0s · 1 turns · 0 tools"))).toBe(true);
    expect(conn.isAlive()).toBe(false);
  });

  test("test_nick_in_use_increments", async () => {
    const fake = await fakeServer({ takenNicks: ["agent-irc-1", "agent-irc-2"] });
    const conn = connect(fake);
    expect(await fake.waitFor((ls) => ls.includes("JOIN #a"))).toBe(true);
    expect(fake.lines().filter((l) => l.startsWith("NICK"))).toEqual(["NICK agent-irc-1", "NICK agent-irc-2", "NICK agent-irc-3"]);
    expect(conn.nick).toBe("agent-irc-3");
  });

  // The whole chain: an IPv6 URL parses, the bare address reaches the
  // socket, and the label brackets it again.
  test.skipIf(!IPV6)("test_connects_to_a_bracketed_ipv6_literal", async () => {
    const fake = await fakeServer({ host: "::1" });
    const target = parseUrl(`irc://[::1]:${fake.port}/#a`, "getty");
    start(target.server, [target.channel]);
    expect([await fake.waitFor((ls) => ls.includes("JOIN #a")), logs]).toEqual([true, logs]);
    expect(target.server.label).toBe(`[::1]:${fake.port}`);
  });

  // 437 is what a server answers for a nick it is holding (after a netsplit
  // or a recent QUIT). Like 433 it means "not this one, try another" --
  // without it registration just times out.
  test("test_a_held_nick_tries_the_next_one", async () => {
    const fake = await fakeServer({ heldNicks: ["agent-irc-1", "agent-irc-2"] });
    const conn = connect(fake);
    expect(await fake.waitFor((ls) => ls.includes("JOIN #a"))).toBe(true);
    expect(fake.lines().filter((l) => l.startsWith("NICK"))).toEqual(["NICK agent-irc-1", "NICK agent-irc-2", "NICK agent-irc-3"]);
    expect(conn.nick).toBe("agent-irc-3");
  });

  // 464 says the PASS is wrong. Reconnecting cannot fix that, so the
  // connection stops instead of retrying the same password forever.
  test("test_a_rejected_server_password_gives_up", async () => {
    const fake = await fakeServer({ password: "s3cret" });
    const conn = connect(fake, "wrong");
    expect(await waitUntil(() => !conn.isAlive())).toBe(true);
    expect(logs.filter((l) => l.includes("giving up") && l.toLowerCase().includes("password"))).not.toEqual([]);
  });

  test("test_erroneous_nick_shortens", async () => {
    const fake = await fakeServer({ maxNick: 9 });
    const conn = connect(fake);
    expect(await fake.waitFor((ls) => ls.includes("JOIN #a"))).toBe(true);
    expect(conn.nick).toBe("agent-i-1");
  });

  test("test_ping_pong", async () => {
    const fake = await fakeServer();
    connect(fake);
    expect(await fake.waitFor((ls) => ls.includes("JOIN #a"))).toBe(true);
    fake.sendToAll("PING :keepalive");
    expect(await fake.waitFor((ls) => ls.includes("PONG :keepalive"))).toBe(true);
  });

  test("test_no_password_no_pass_line", async () => {
    const fake = await fakeServer();
    connect(fake);
    expect(await fake.waitFor((ls) => ls.includes("JOIN #a"))).toBe(true);
    expect(fake.lines().some((l) => l.startsWith("PASS"))).toBe(false);
  });

  // Nothing is cut: the server's own ":nick!user@host " goes in front of
  // what we send, and the whole of that has to fit the 512-byte line.
  test("test_long_payload_is_split_to_fit_the_line_the_receiver_gets", async () => {
    const fake = await fakeServer();
    const conn = connect(fake, null, ["#a"]);
    expect(await waitUntil(() => conn.mask)).toBe(true); // learned from the echoed JOIN
    expect(conn.mask).toBe("agent-irc-1!u@h");
    expect(conn.payloadLimit("#a")).toBe(512 - ":agent-irc-1!u@h PRIVMSG #a :".length - 2);
    conn.sendMessage("ä".repeat(300));
    expect(await waitUntil(() => privmsgs(fake).length === 2)).toBe(true);
    const parts = privmsgs(fake);
    expect(parts.join("")).toBe("ä".repeat(300));
    for (const part of parts) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(conn.payloadLimit("#a"));
  });

  test("test_isupport_linelen_is_used", async () => {
    const fake = await fakeServer({ isupport: ["LINELEN=1024"] });
    const conn = connect(fake, null, ["#a"]);
    expect(await waitUntil(() => conn.mask)).toBe(true);
    expect(conn.linelen).toBe(1024);
    conn.sendMessage("ä".repeat(300));
    expect(await waitUntil(() => privmsgs(fake).length)).toBe(true);
    expect(privmsgs(fake)).toEqual(["ä".repeat(300)]); // 600 bytes, one line
  });

  // A line queued before registration must not be pumped with the 512
  // fallback while the server's LINELEN (in a 005 that lands in a later read
  // than 001) is still in flight -- else it is needlessly split.
  test("test_early_line_waits_for_a_delayed_isupport_linelen", async () => {
    const fake = await fakeServer({ isupport: ["LINELEN=8192"], isupportDelay: 0.05 });
    const conn = connect(fake, null, ["#a"]);
    conn.sendMessage("ä".repeat(300)); // 600 bytes: one line at 8192, two at 512
    expect(await waitUntil(() => privmsgs(fake).length)).toBe(true);
    expect(privmsgs(fake)).toEqual(["ä".repeat(300)]);
  });

  // The other half of the grace: a server that sends no 005 at all must not
  // hold the first line back for longer than GREETING_GRACE.
  test("a server without ISUPPORT gets the first line after the grace", async () => {
    const fake = await fakeServer({ noIsupport: true });
    const conn = connect(fake, null, ["#a"]);
    conn.sendMessage("ä".repeat(300));
    expect(await waitUntil(() => conn.registered)).toBe(true);
    const registered = performance.now();
    expect(await waitUntil(() => privmsgs(fake).length === 2, 2.0)).toBe(true); // split at the 512 fallback
    const waited = (performance.now() - registered) / 1000;
    expect(waited).toBeGreaterThan(0.4);
    expect(waited).toBeLessThan(1.5);
  });

  test("test_nonsense_linelen_is_ignored", async () => {
    const fake = await fakeServer({ isupport: ["LINELEN=12", "CHANTYPES=#"] });
    const conn = connect(fake, null, ["#a"]);
    expect(await waitUntil(() => conn.registered && Object.keys(conn.isupport).length)).toBe(true);
    expect(conn.linelen).toBe(512);
    expect(conn.isupport["CHANTYPES"]).toBe("#");
  });

  test("test_continuation_keeps_the_body_indent", async () => {
    const fake = await fakeServer({ isupport: ["LINELEN=140"] });
    const conn = connect(fake, null, ["#a"]);
    expect(await waitUntil(() => conn.mask)).toBe(true);
    conn.sendMessage("  " + Array(40).fill("word").join(" "));
    expect(await waitUntil(() => privmsgs(fake).length >= 2)).toBe(true);
    for (const part of privmsgs(fake)) {
      expect(part.startsWith("  ")).toBe(true);
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(conn.payloadLimit("#a"));
    }
  });

  // The queue holds logical lines; the parts of one split line wait in
  // `pending`. A close that drained only the queue would QUIT with the
  // tail of the last line still unsent.
  test("close drains the pending parts of a split line, not just the queue", async () => {
    const fake = await fakeServer();
    const conn = start(server(fake), ["#a"], { bucket: new FloodBucket(1, 0.1) });
    expect(await waitUntil(() => conn.mask)).toBe(true);
    conn.sendMessage("ä".repeat(600)); // 1200 bytes: three parts at 512, one token each
    await conn.close("done", 3.0);
    expect(await fake.waitFor((ls) => ls.includes("QUIT :done"))).toBe(true);
    const parts = privmsgs(fake);
    expect(parts.length).toBe(3);
    expect(parts.join("")).toBe("ä".repeat(600));
    expect(fake.lines().at(-1)).toBe("QUIT :done");
  });

  test("test_messages_before_registration_are_delivered_after", async () => {
    const fake = await fakeServer();
    const conn = connect(fake, null, ["#a"]);
    conn.sendMessage("early");
    expect(await fake.waitFor((ls) => ls.includes("PRIVMSG #a :early"))).toBe(true);
    const lines = fake.lines();
    expect(lines.indexOf("JOIN #a")).toBeLessThan(lines.indexOf("PRIVMSG #a :early"));
  });

  test("test_control_characters_are_stripped", async () => {
    const fake = await fakeServer();
    const conn = connect(fake, null, ["#a"]);
    expect(await fake.waitFor((ls) => ls.includes("JOIN #a"))).toBe(true);
    conn.sendMessage("hello\x01\x03\x00world");
    expect(await fake.waitFor((ls) => ls.some((l) => l.startsWith("PRIVMSG #a :")))).toBe(true);
    expect(fake.lines().filter((l) => l.startsWith("PRIVMSG #a :"))[0]).toBe("PRIVMSG #a :helloworld");
  });

  test("a lone surrogate in a queued line is delivered as U+FFFD", async () => {
    const fake = await fakeServer();
    const conn = connect(fake, null, ["#a"]);
    conn.sendMessage("a\ud800b");
    conn.sendMessage("after");
    expect(await fake.waitFor((ls) => ls.includes("PRIVMSG #a :after"))).toBe(true);
    expect(privmsgs(fake)).toEqual(["a�b", "after"]);
    expect(fake.lines().filter((l) => l === "JOIN #a").length).toBe(1); // the connection survived it
  });

  test("test_ircs_insecure_registers_and_delivers_over_tls", async () => {
    const fake = await fakeServer({ tls: true });
    const conn = start(new Server("ircs", "127.0.0.1", fake.port, "getty", null, true), ["#a"]);
    expect(await fake.waitFor((ls) => ls.includes("JOIN #a"))).toBe(true);
    conn.sendMessage("secure hello");
    expect(await fake.waitFor((ls) => ls.includes("PRIVMSG #a :secure hello"))).toBe(true);
  });

  test("test_ircs_secure_fails_certificate_verification", async () => {
    const fake = await fakeServer({ tls: true });
    // A paced wait keeps the reconnect loop from hammering the fake server
    // while the assertion below polls for the first failure.
    const conn = start(new Server("ircs", "127.0.0.1", fake.port, "getty", null, false), ["#a"], { wait: () => sleep(0.05) });
    expect(await waitUntil(() => logs.some((l) => /DEPTH_ZERO_SELF_SIGNED_CERT|self[- ]signed certificate/.test(l)))).toBe(true);
    expect(conn.registered).toBe(false);
    expect(fake.lines()).toEqual([]);
  });

  test("test_close_before_welcome_still_joins_and_quits", async () => {
    const fake = await fakeServer({ welcomeDelay: 0.4 });
    const conn = connect(fake, null, ["#late"]);
    conn.sendMessage("queued early");
    expect(await fake.waitFor((ls) => ls.some((l) => l.startsWith("USER ")))).toBe(true);
    await conn.close("bye early", 3.0); // 001 has not been sent yet (0.4 s delay)
    expect(await fake.waitFor((ls) => ls.includes("QUIT :bye early"))).toBe(true);
    const lines = fake.lines();
    expect(lines).toContain("JOIN #late");
    expect(lines).toContain("PRIVMSG #late :queued early");
    expect(lines.indexOf("JOIN #late")).toBeLessThan(lines.indexOf("PRIVMSG #late :queued early"));
    expect(lines.indexOf("PRIVMSG #late :queued early")).toBeLessThan(lines.indexOf("QUIT :bye early"));
  });
});

// A server that stops reading. Python's sendall() blocks then, for up to
// SEND_TIMEOUT, so the backlog stays in the queue (where queue_limit applies)
// and a server that never reads again is reconnected to with the queue kept.
// A Node socket buffers instead of blocking; the connection has to stop
// itself. The kernel takes some MB before a write reports back-pressure,
// hence the long lines on a LINELEN=65535 server.
describe("BackpressureTests", () => {
  let logs: string[];
  const addCleanup = cleanups();
  beforeEach(() => {
    logs = [];
  });

  const LONG = "x".repeat(30000);

  async function stalledServer(): Promise<FakeIrcServer> {
    const fake = await FakeIrcServer.create({ isupport: ["LINELEN=65535"], stallAfterJoin: 1 });
    addCleanup(() => fake.close());
    return fake;
  }

  function start(fake: FakeIrcServer, options: ConnectionOptions = {}): IrcConnection {
    const conn = new IrcConnection(
      new Server("irc", "127.0.0.1", fake.port, "getty", null, false),
      ["#a"],
      "agent-irc",
      "claude e873 ~/dev/agent-irc",
      (l) => logs.push(l),
      { wait: () => {}, bucket: fastBucket(), ...options },
    );
    conn.start();
    addCleanup(() => conn.close("test over", 2.0));
    return conn;
  }

  /** Queue `count` long lines a few at a time, so the connection gets to write between them. */
  async function feed(conn: IrcConnection, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      conn.sendMessage(`m${i} ${LONG}`);
      if (i % 4 === 3) await sleep(0.002);
    }
  }

  const index = (line: string) => Number(/^PRIVMSG #a :m(\d+) /.exec(line)?.[1] ?? -1);

  test("a server that stops reading backs lines up in the queue, where queue_limit drops them", async () => {
    const fake = await stalledServer();
    const conn = start(fake, { queueLimit: 20, sendTimeout: 60 }); // no reconnect: "drain" resumes it
    expect(await waitUntil(() => conn.mask && conn.greetingSettled())).toBe(true);
    await feed(conn, 400); // 12 MB
    expect(conn.queue.length).toBeLessThanOrEqual(20);
    const dropped = conn.dropped;
    expect(dropped).toBeGreaterThan(0);
    fake.resumeAll();
    expect(await fake.waitFor((ls) => ls.includes(`PRIVMSG #a :… dropped ${dropped} lines`), 10)).toBe(true);
    const sent = fake.lines().filter((l) => l.startsWith("PRIVMSG #a :m")).map(index);
    expect(sent.at(-1)).toBe(399);
    expect(sent.length).toBe(400 - dropped);
    expect(fake.lines().filter((l) => l === "JOIN #a").length).toBe(1);
  }, 20_000);

  test("a server that reads nothing for SEND_TIMEOUT is reconnected to, the unsent lines kept", async () => {
    const fake = await stalledServer();
    const conn = start(fake, { queueLimit: 0, sendTimeout: 0.5 });
    expect(await waitUntil(() => conn.mask && conn.greetingSettled())).toBe(true);
    await feed(conn, 200); // 6 MB
    conn.sendMessage("last");
    expect(await fake.waitFor((ls) => ls.filter((l) => l === "JOIN #a").length === 2, 10)).toBe(true);
    expect(await fake.waitFor((ls) => ls.includes("PRIVMSG #a :last"), 10)).toBe(true);
    expect(logs).toContain(`agent-irc: 127.0.0.1:${fake.port}: timed out`);
    // What the second connection got is the queue as it stood: one unbroken
    // run up to the last line. Only what the dead socket had taken is gone.
    const lines = fake.lines();
    const second = lines.slice(lines.lastIndexOf("JOIN #a"));
    const sent = second.filter((l) => l.startsWith("PRIVMSG #a :m")).map(index);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).toEqual(Array.from({ length: sent.length }, (_, i) => 200 - sent.length + i));
    expect(second.at(-1)).toBe("PRIVMSG #a :last");
  }, 20_000);

  test("close() against a server that stops reading ends within the 1.5s stop budget", async () => {
    const fake = await stalledServer();
    const conn = start(fake, { queueLimit: 0 });
    expect(await waitUntil(() => conn.mask && conn.greetingSettled())).toBe(true);
    await feed(conn, 200);
    expect(conn.queue.length).toBeGreaterThan(0); // backed up, not all handed to the socket
    const t0 = performance.now();
    expect(await conn.close("bye", 3.0)).toBe(true);
    expect((performance.now() - t0) / 1000).toBeLessThan(1.5 + 0.25);
  });

  // QUIT can land behind a full send buffer. closeSocket() end()s before it
  // destroy()s, so the buffer still goes out if the server reads again in
  // time; destroy() alone discards it, QUIT included.
  test("a QUIT written into a full send buffer reaches a server that reads again during the close", async () => {
    const fake = await stalledServer();
    const conn = start(fake);
    expect(await waitUntil(() => conn.mask && conn.greetingSettled())).toBe(true);
    let full = false;
    for (let i = 0; i < 1000 && !full; i++) {
      conn.sendMessage(`m${i} ${LONG}`);
      expect(await waitUntil(() => !conn.queue.length && !conn.pending.length)).toBe(true);
      full = conn.sock?.writableNeedDrain ?? false;
    }
    expect(full).toBe(true);
    conn.beginClose("bye now");
    expect(await waitUntil(() => conn.sock === null)).toBe(true); // closeSocket() has begun
    fake.resumeAll();
    expect(await fake.waitFor((ls) => ls.includes("QUIT :bye now"))).toBe(true);
    expect(await conn.join(2.0)).toBe(true);
  });
});

// What the connection hands to the inbox: DMs, and channel lines naming us.
describe("InboundTests", () => {
  let logs: string[];
  let got: [string, string, string][];
  let fake: FakeIrcServer;
  let conn: IrcConnection;

  beforeEach(async () => {
    logs = [];
    got = [];
    fake = await FakeIrcServer.create();
    conn = new IrcConnection(
      new Server("irc", "127.0.0.1", fake.port, "getty", null, false),
      ["#a"],
      "agent-irc",
      "claude e873 ~/dev/agent-irc",
      (l) => logs.push(l),
      { wait: () => {}, bucket: fastBucket(), onMessage: (...m) => void got.push(m) },
    );
    conn.start();
    expect(await fake.waitFor((ls) => ls.includes("JOIN #a"))).toBe(true);
  });

  afterEach(async () => {
    await conn.close("test over", 2.0);
    await fake.close();
  });

  const send = (line: string) => fake.sendToAll(line);

  test("test_a_direct_message_arrives", async () => {
    send(":getty!getty@vhost.example PRIVMSG agent-irc-1 :carry on");
    expect(await waitUntil(() => got.length)).toBe(true);
    expect(got).toEqual([["getty!getty@vhost.example", "agent-irc-1", "carry on"]]);
  });

  test("test_a_channel_line_arrives_only_when_it_names_us", async () => {
    send(":getty!getty@vhost.example PRIVMSG #a :something unrelated");
    send(":getty!getty@vhost.example PRIVMSG #a :agent-irc-1: status?");
    expect(await waitUntil(() => got.length)).toBe(true);
    expect(got).toEqual([["getty!getty@vhost.example", "#a", "agent-irc-1: status?"]]);
  });

  test("test_our_own_line_is_never_inbound", async () => {
    send(":agent-irc-1!u@h PRIVMSG #a :agent-irc-1 said this");
    send(":getty!getty@vhost.example PRIVMSG agent-irc-1 :after");
    expect(await waitUntil(() => got.length)).toBe(true);
    expect(got.map((m) => m[2])).toEqual(["after"]);
  });

  test("test_ctcp_is_filtered_and_an_action_is_unwrapped", async () => {
    send(":getty!getty@vhost.example PRIVMSG agent-irc-1 :\x01VERSION\x01");
    send(":getty!getty@vhost.example PRIVMSG agent-irc-1 :\x01ACTION waves\x01");
    expect(await waitUntil(() => got.length)).toBe(true);
    expect(got.map((m) => m[2])).toEqual(["* waves"]);
  });

  test("test_a_failing_inbox_does_not_kill_the_connection", async () => {
    conn.onMessage = () => {
      throw new Error("boom");
    };
    send(":getty!getty@vhost.example PRIVMSG agent-irc-1 :boom");
    expect(await waitUntil(() => logs.some((l) => l.includes("inbound message dropped")))).toBe(true);
    conn.sendMessage("still here");
    expect(await fake.waitFor((ls) => ls.includes("PRIVMSG #a :still here"))).toBe(true);
  });
});
