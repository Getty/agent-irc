// Port of tests/test_irc_reconnect.py: describe = the Python TestCase, test = its method.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Server } from "../src/config.js";
import * as irc from "../src/irc.js";
import { FloodBucket, IrcConnection } from "../src/irc.js";
import { FakeIrcServer } from "./fakeirc.js";

const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

describe("ReconnectTests", () => {
  let fake: FakeIrcServer;
  let delays: number[];
  let logs: string[];
  let conn: IrcConnection;
  const cleanup: (() => unknown)[] = [];

  const make = (channels: string[], options: irc.ConnectionOptions = {}) =>
    new IrcConnection(
      new Server("irc", "127.0.0.1", fake.port, "u", null, false),
      channels,
      "proj",
      "codex 01a ~/p",
      (l) => logs.push(l),
      { wait: (s) => void delays.push(s), bucket: new FloodBucket(10000, 0.0001), ...options },
    );

  beforeEach(async () => {
    fake = await FakeIrcServer.create();
    delays = [];
    logs = [];
    conn = make(["#a"]);
    conn.start();
  });

  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!();
    await conn.close("bye", 2.0);
    await fake.close();
  });

  test("test_reconnects_and_delivers_queued_lines", async () => {
    expect(await fake.waitFor((ls) => ls.includes("JOIN #a"))).toBe(true);
    fake.dropAll();
    expect(await fake.waitFor((ls) => ls.filter((l) => l === "JOIN #a").length === 2)).toBe(true);
    conn.sendMessage("after reconnect");
    expect(await fake.waitFor((ls) => ls.includes("PRIVMSG #a :after reconnect"))).toBe(true);
    expect(delays.slice(0, 1)).toEqual([5]);
    expect(conn.attempts).toBe(0);
  });

  test("test_backoff_sequence_when_server_is_gone", async () => {
    expect(await fake.waitFor((ls) => ls.includes("JOIN #a"))).toBe(true);
    await fake.close();
    for (let deadline = 200; delays.length < 6 && deadline; deadline--) await sleep(0.02);
    expect(delays.slice(0, 6)).toEqual([5, 10, 20, 40, 60, 60]);
  });

  test("test_lines_queued_while_disconnected_are_delivered_after_rejoin", async () => {
    await conn.close("unused", 2.0);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const gatedDelays: number[] = [];
    const gated = make(["#g"], {
      wait: (seconds) => {
        gatedDelays.push(seconds);
        return Promise.race([gate, sleep(10)]);
      },
    });
    gated.start();
    cleanup.push(() => gated.close("bye", 2.0));
    cleanup.push(() => open());
    expect(await fake.waitFor((ls) => ls.includes("JOIN #g"))).toBe(true);
    fake.dropAll();
    for (const deadline = performance.now() + 5000; !gatedDelays.length && performance.now() < deadline; ) await sleep(0.02);
    expect(gatedDelays).toEqual([5]); // the connection is in backoff: disconnected
    gated.sendMessage("queued while down");
    await sleep(0.1);
    expect(fake.lines()).not.toContain("PRIVMSG #g :queued while down");
    open();
    expect(await fake.waitFor((ls) => ls.filter((l) => l === "JOIN #g").length === 2)).toBe(true);
    expect(await fake.waitFor((ls) => ls.includes("PRIVMSG #g :queued while down"))).toBe(true);
    const lines = fake.lines();
    const secondJoin = lines.indexOf("JOIN #g", lines.indexOf("JOIN #g") + 1);
    expect(secondJoin).toBeLessThan(lines.indexOf("PRIVMSG #g :queued while down"));
  });

  test("test_queue_cap_drops_oldest_and_notes_it", async () => {
    // Fill the queue before the connection starts, so the cap is hit deterministically.
    await conn.close("unused", 2.0);
    const capped = make(["#q"]);
    for (let i = 0; i < irc.QUEUE_LIMIT + 5; i++) capped.sendMessage(`m${i}`);
    expect(capped.dropped).toBe(5);
    capped.start();
    cleanup.push(() => capped.close("bye", 2.0));
    expect(await fake.waitFor((ls) => ls.includes("PRIVMSG #q :… dropped 5 lines"), 15)).toBe(true);
    const lines = fake.lines().filter((l) => l.startsWith("PRIVMSG #q"));
    expect(lines[0]).toBe("PRIVMSG #q :m5");
    expect(lines.at(-1)).toBe("PRIVMSG #q :… dropped 5 lines");
    expect(lines).toContain(`PRIVMSG #q :m${irc.QUEUE_LIMIT + 4}`);
    expect(lines).not.toContain("PRIVMSG #q :m4");
  });

  // Every channel on a connection must see the same lines. A cap that counts
  // per-channel copies drops the tail of one channel's stream while the
  // other keeps it -- the two logs then disagree about what happened.
  test("test_a_cap_drops_whole_lines_not_single_channel_copies", async () => {
    await conn.close("unused", 2.0);
    const capped = make(["#q", "#r"], { queueLimit: 11 });
    for (let i = 0; i < 13; i++) capped.sendMessage(`m${i}`);
    expect(capped.dropped).toBe(2);
    capped.start();
    cleanup.push(() => capped.close("bye", 2.0));
    expect(await fake.waitFor((ls) => ls.includes("PRIVMSG #r :… dropped 2 lines"), 15)).toBe(true);
    const sent = fake.lines();
    const body = (l: string) => l.slice(l.indexOf(" :") + 2);
    const q = sent.filter((l) => l.startsWith("PRIVMSG #q :")).map(body);
    const r = sent.filter((l) => l.startsWith("PRIVMSG #r :")).map(body);
    expect(q).toEqual(r);
    expect(q[0]).toBe("m2");
  });
});
