// IRC connection: register, keep alive, deliver lines (spec §7; port of
// agent_irc/irc.py).
//
// Python runs each connection on a thread that blocks in select()/recv() and
// sendall(). Here the same loop is an async function on Bun's event loop:
// `read(timeout)` waits for input from the socket's "data" events (or a
// wake-up) instead of select(), and a write is a socket.write() that Node
// queues in order. The loop's structure, and with it the bytes on the wire
// and their order, follow the Python method by method.
import * as net from "node:net";
import * as tls from "node:tls";
import type { Server } from "./config.js";
import { isChannel, mentions, unwrapCtcp } from "./inbound.js";
import * as py from "./py.js";
import { cutBytes, wrapPayload } from "./text.js";

// RFC 1459: the whole line, CRLF included, must fit 512 bytes -- and the line
// the receiver has to fit is not the one we send: the server prepends our own
// ":nick!user@host " to it. Servers that allow more advertise LINELEN in their
// RPL_ISUPPORT (005); ergo and InspIRCd both do.
export const LINELEN = 512;
export const MIN_PAYLOAD = 80; // a server claiming less room than this is not believed
// "!ident@host" at the RFC's worst case, used until the server has shown us the
// mask it actually puts in front of our messages.
export const UNKNOWN_USERHOST = 75;
export const QUEUE_LIMIT = 500;
// After 001 the server sends its ISUPPORT (005) in the same burst; the first
// pump waits this long for it, so a line queued before registration is split
// to the advertised LINELEN, not the 512 fallback. Bounded, because a server
// may send no ISUPPORT at all -- then the first pump proceeds on the fallback.
export const GREETING_GRACE = 0.5;
export const BACKOFF = [5, 10, 20, 40, 60] as const;
export const REGISTRATION_TIMEOUT = 30.0;
export const NICK_LIMITS = [30, 9] as const;
export const MAX_NICK_TRIES = 99;
// How long a server may leave our writes unread before the connection counts
// as dead and is reconnected, the unsent lines kept. Python's sendall()
// blocks this long; a Node socket buffers instead and reports back-pressure,
// so the connection stops pumping until "drain" and counts from there.
// TLS_READ_TIMEOUT has no counterpart: a Node socket never blocks in a read.
export const SEND_TIMEOUT = 10.0;
// The whole stop -- registration, drain, QUIT, the wait for the server to
// close, the flush of what the socket still holds -- has this long.
export const STOP_BUDGET = 1.5;

// besides \r/\n, stripped from every line body before send
const CONTROL_RE = /[\x00-\x1f\x7f]/g;

const encoder = new TextEncoder();
const utf8Length = (s: string) => encoder.encode(s).length;

/** The connection cannot be established in a way a retry would fix. */
export class GiveUp extends Error {}

/** The socket went away or the server ended the session; a retry may help. */
export class ConnectionError extends Error {}

export type Clock = () => number;
/** Seconds of a monotonic clock, as Python's time.monotonic(). */
export const monotonic: Clock = () => performance.now() / 1000;

export class FloodBucket {
  readonly burst: number;
  readonly interval: number;
  readonly clock: Clock;
  tokens: number;
  last: number;

  constructor(burst = 4, interval = 2.0, clock: Clock = monotonic) {
    this.burst = Number(burst);
    this.interval = Number(interval);
    this.clock = clock;
    this.tokens = this.burst;
    this.last = clock();
  }

  /** Take a token and return 0, or return the seconds until the next token. */
  acquireDelay(): number {
    const now = this.clock();
    const elapsed = Math.max(0.0, now - this.last);
    this.tokens = Math.min(this.burst, this.tokens + elapsed / this.interval);
    this.last = now;
    if (this.tokens >= 1.0) {
      this.tokens -= 1.0;
      return 0.0;
    }
    return (1.0 - this.tokens) * this.interval;
  }
}

/** [prefix, COMMAND, params] of one line; prefix null when there is none. */
export function parseLine(line: string): [string | null, string, string[]] {
  let prefix: string | null = null;
  if (line.startsWith(":")) {
    const rest = line.slice(1);
    const space = rest.indexOf(" ");
    prefix = space < 0 ? rest : rest.slice(0, space);
    line = space < 0 ? "" : rest.slice(space + 1);
  }
  let params: string[];
  const colon = line.indexOf(" :");
  if (colon >= 0) {
    params = py.split(line.slice(0, colon));
    params.push(line.slice(colon + 2));
  } else if (line.startsWith(":")) {
    params = [line.slice(1)];
  } else {
    params = py.split(line);
  }
  const command = params.length ? py.upper(params.shift()!) : "";
  return [prefix, command, params];
}

export function nickCandidate(base: string, n: number, limit: number): string {
  const suffix = `-${n}`;
  return py.slice(base, 0, Math.max(limit - suffix.length, 1)) + suffix;
}

/** A logical line and the channels it goes to; null means every channel. */
type Queued = [string[] | null, string];

/** popleft/append/appendleft in O(1) amortised, as collections.deque. */
class Deque<T> {
  private items: T[] = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  append(item: T): void {
    this.items.push(item);
  }

  popleft(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head]!;
    this.head++;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }

  /** Put `items` in front, keeping their order. */
  prepend(items: T[]): void {
    if (!items.length) return;
    this.items = [...items, ...this.items.slice(this.head)];
    this.head = 0;
  }

  toArray(): T[] {
    return this.items.slice(this.head);
  }
}

/** What the connection needs of a socket; tests substitute a recorder. */
export interface Writable {
  write(data: Uint8Array): boolean;
}

export type Wait = (seconds: number) => void | Promise<void>;
export type OnMessage = (prefix: string, target: string, text: string) => void;

export interface ConnectionOptions {
  /** The backoff sleep; by default one that a close() cuts short. */
  wait?: Wait;
  clock?: Clock;
  bucket?: FloodBucket;
  /** 0 = never drop. */
  queueLimit?: number;
  /** Seconds of unrelieved back-pressure before a reconnect; SEND_TIMEOUT. */
  sendTimeout?: number;
  onMessage?: OnMessage | null;
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return typeof code === "string" && !e.message.includes(code) ? `[${code}] ${e.message}` : e.message;
  }
  return String(e);
}

const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(seconds, 0) * 1000));

/** One IRC server: connects, registers, joins channels, delivers queued lines. */
export class IrcConnection {
  readonly server: Server;
  readonly channels: string[];
  readonly nickBase: string;
  readonly realname: string;
  readonly log: (line: string) => void;
  readonly clock: Clock;
  readonly bucket: FloodBucket;
  readonly wait: Wait;
  onMessage: OnMessage | null;
  quitMessage = "bye";
  readonly queue = new Deque<Queued>();
  readonly queueLimit: number;
  readonly sendTimeout: number;
  dropped = 0;
  attempts = 0;
  sock: (net.Socket & Writable) | null = null;
  nick: string | null = null;
  nickTry = 1;
  nickLimit: number = NICK_LIMITS[0];
  registered = false;
  mask: string | null = null;
  isupport: Record<string, string> = {};
  linelen = LINELEN;
  pending: [string, string][] = [];
  greetingDeadline: number | null = null;
  /** When the socket last refused more (write() false) without a "drain" since. */
  blockedSince: number | null = null;

  private stopRequested = false;
  private stopWake: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private alive = false;
  // Input from the socket, handed from its events to read().
  private buffer: Buffer = Buffer.alloc(0);
  private eof = false;
  private failure: Error | null = null;
  private wakeRead: (() => void) | null = null;
  private stopDeadline: number | null = null;

  constructor(
    server: Server,
    channels: string[],
    nickBase: string,
    realname: string,
    log: (line: string) => void,
    options: ConnectionOptions = {},
  ) {
    this.server = server;
    this.channels = [...channels];
    this.nickBase = nickBase;
    this.realname = realname;
    this.log = log;
    this.clock = options.clock ?? monotonic;
    this.onMessage = options.onMessage ?? null;
    this.bucket = options.bucket ?? new FloodBucket(4, 2.0, this.clock);
    this.wait = options.wait ?? ((seconds) => this.stoppableSleep(seconds));
    this.queueLimit = options.queueLimit ?? QUEUE_LIMIT;
    this.sendTimeout = options.sendTimeout ?? SEND_TIMEOUT;
  }

  // -- public -------------------------------------------------------------

  /**
   * Queue one logical line for every channel (or just `channels`).
   *
   * The queue holds logical lines, not per-channel copies: a cap counting
   * copies would drop twice as early on a two-channel connection, and drop a
   * line from one channel while leaving it in the other.
   */
  sendMessage(text: string, channels: string[] | null = null): void {
    if (this.queueLimit && this.queue.length >= this.queueLimit) {
      this.queue.popleft();
      this.dropped++;
    }
    this.queue.append([channels, text]);
    this.poke();
  }

  /** Python's Thread.start(): begin connecting in the background. */
  start(): void {
    if (this.running) return;
    this.alive = true;
    this.running = this.run().finally(() => {
      this.alive = false;
    });
  }

  isAlive(): boolean {
    return this.alive;
  }

  /** Wait up to `timeout` seconds for the connection to end; true if it did. */
  async join(timeout = Infinity): Promise<boolean> {
    if (!this.running) return true;
    if (timeout === Infinity) {
      await this.running;
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([
      this.running.then(() => true),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), Math.max(timeout, 0) * 1000))),
    ]);
    clearTimeout(timer);
    return done;
  }

  /** Ask the connection to drain, QUIT and end; returns at once. close() = beginClose() + join(). */
  beginClose(quitMessage: string): void {
    this.quitMessage = quitMessage;
    this.stopRequested = true;
    const wake = this.stopWake;
    this.stopWake = null;
    wake?.();
    this.poke();
  }

  async close(quitMessage: string, timeout = 2.0): Promise<boolean> {
    this.beginClose(quitMessage);
    return this.join(timeout);
  }

  get stopping(): boolean {
    return this.stopRequested;
  }

  // -- the connection loop --------------------------------------------------

  private async run(): Promise<void> {
    while (!this.stopRequested) {
      try {
        await this.connect();
        await this.session();
      } catch (e) {
        if (e instanceof GiveUp) {
          this.log(`agent-irc: ${this.server.label}: giving up: ${e.message}`);
          await this.closeSocket();
          return;
        }
        this.log(`agent-irc: ${this.server.label}: ${describe(e)}`);
      }
      await this.closeSocket();
      if (this.stopRequested) return;
      const delay = BACKOFF[Math.min(this.attempts, BACKOFF.length - 1)]!;
      this.attempts++;
      this.log(`agent-irc: ${this.server.label}: reconnecting in ${delay}s`);
      await this.wait(delay);
    }
  }

  private stoppableSleep(seconds: number): Promise<void> {
    if (this.stopRequested) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, seconds * 1000);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.stopWake = done;
    });
  }

  private openSocket(): Promise<net.Socket> {
    const { host, port } = this.server;
    return new Promise<net.Socket>((resolve, reject) => {
      let sock: net.Socket;
      const event = this.server.tls ? "secureConnect" : "connect";
      if (this.server.tls) {
        const options: tls.ConnectionOptions = { host, port, rejectUnauthorized: !this.server.insecure };
        // SNI takes a name, never an address (RFC 6066); Node warns otherwise.
        if (net.isIP(host) === 0) options.servername = host;
        sock = tls.connect(options);
      } else {
        sock = net.connect({ host, port });
      }
      const timer = setTimeout(() => sock.destroy(new ConnectionError("timed out")), REGISTRATION_TIMEOUT * 1000);
      const fail = (e: Error) => {
        clearTimeout(timer);
        sock.destroy();
        reject(e);
      };
      sock.once("error", fail);
      sock.once(event, () => {
        clearTimeout(timer);
        sock.off("error", fail);
        resolve(sock);
      });
    });
  }

  private async connect(): Promise<void> {
    const sock = await this.openSocket();
    sock.setNoDelay(true);
    this.buffer = Buffer.alloc(0);
    this.eof = false;
    this.failure = null;
    sock.on("data", (chunk: Buffer) => {
      if (this.sock !== sock) return;
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.poke();
    });
    sock.on("end", () => {
      if (this.sock !== sock) return;
      this.eof = true;
      this.poke();
    });
    sock.on("close", () => {
      if (this.sock !== sock) return;
      this.eof = true;
      this.poke();
    });
    sock.on("drain", () => {
      if (this.sock !== sock) return;
      this.blockedSince = null;
      this.poke();
    });
    sock.on("error", (e: Error) => {
      if (this.sock !== sock) return;
      this.failure ??= e;
      this.poke();
    });
    this.sock = sock as net.Socket & Writable;
    this.registered = false;
    this.nickTry = 1;
    this.nickLimit = NICK_LIMITS[0];
    this.mask = null;
    this.isupport = {};
    this.linelen = LINELEN;
    this.greetingDeadline = null;
    this.blockedSince = null;
    // Chunks cut to the old connection's budget go back to the queue: this
    // server may answer with a different LINELEN than the last one. Each goes
    // back addressed to its own channel -- the other channels on this
    // connection already had that part.
    this.queue.prepend(this.pending.map(([channel, part]): Queued => [[channel], part]));
    this.pending = [];
    if (this.server.password) this.raw("PASS :" + this.server.password);
    this.sendNick();
    this.raw(`USER ${this.server.user.replaceAll(" ", "_")} 0 * :${this.realname}`);
  }

  private sendNick(): void {
    this.nick = nickCandidate(this.nickBase, this.nickTry, this.nickLimit);
    this.raw("NICK " + this.nick);
  }

  private async session(): Promise<void> {
    const deadline = this.clock() + REGISTRATION_TIMEOUT;
    for (;;) {
      if (this.stopRequested) {
        await this.finish();
        return;
      }
      if (!this.registered && this.clock() > deadline) throw new ConnectionError("registration timed out");
      // Python's socket.timeout out of sendall(), worded as Python logs it.
      if (this.blockedSince !== null && this.clock() - this.blockedSince >= this.sendTimeout) {
        throw new ConnectionError("timed out");
      }
      let timeout = 0.2;
      if (this.registered) {
        if (this.greetingSettled()) {
          const delay = this.pump();
          if (delay > 0) timeout = Math.min(timeout, delay);
        } else if (this.greetingDeadline !== null) {
          timeout = Math.min(timeout, Math.max(this.greetingDeadline - this.clock(), 0.0));
        }
      }
      await this.read(timeout);
    }
  }

  /**
   * True once the post-001 burst has had its chance: as soon as ISUPPORT (005)
   * is in, or after GREETING_GRACE if the server sends none. Until then the
   * first pump holds off so LINELEN is known before it splits.
   */
  greetingSettled(): boolean {
    if (Object.keys(this.isupport).length) return true;
    return this.greetingDeadline !== null && this.clock() >= this.greetingDeadline;
  }

  /**
   * On stop: let registration in flight complete, flush the queue, quit, then
   * wait for the peer to close -- all within one STOP_BUDGET (1.5s), which
   * closeSocket() then shares for flushing what the socket still holds.
   *
   * Without waiting for registration, a close() requested before the 001
   * arrives would never read it, so the connection would quit without ever
   * joining or delivering the messages already queued for it. Without waiting
   * for the close afterwards, unread data left in the receive buffer (a
   * delayed JOIN ack, the server's closing ERROR) makes Linux answer close()
   * with an RST instead of a clean FIN, which can make the peer drop the very
   * bytes -- JOIN, PRIVMSG, QUIT -- we just sent it.
   */
  private async finish(): Promise<void> {
    const deadline = this.clock() + STOP_BUDGET;
    this.stopDeadline = deadline;
    while (!this.registered && this.clock() < deadline) {
      await this.read(Math.min(0.2, Math.max(deadline - this.clock(), 0.0)));
    }
    await this.drain(deadline);
    this.raw("QUIT :" + this.quitMessage);
    await this.waitForClose(deadline);
  }

  /**
   * Drain anything still arriving until the peer closes the connection, the
   * shared stop deadline passes, or 0.5s elapses -- whichever comes first.
   */
  private async waitForClose(deadline: number): Promise<void> {
    const stop = Math.min(deadline, this.clock() + 0.5);
    try {
      while (this.clock() < stop) await this.read(Math.min(0.2, Math.max(stop - this.clock(), 0.0)));
    } catch (e) {
      if (!(e instanceof ConnectionError)) throw e;
    }
  }

  private async drain(deadline: number): Promise<void> {
    while (this.registered && this.clock() < deadline) {
      if (!this.queue.length && !this.pending.length) return;
      const delay = this.pump();
      if (delay > 0) await this.read(Math.min(delay, Math.max(deadline - this.clock(), 0.0)));
    }
  }

  /**
   * Send queued lines as the bucket allows; return the delay until the next may go.
   *
   * A queued line is one logical line; what goes on the wire is however many
   * PRIVMSGs this server's line budget needs for it, each costing its own
   * token from the flood bucket.
   *
   * While the socket holds more than it wants (write() returned false, no
   * "drain" yet) nothing is written: the backlog stays here, in the queue,
   * where queue_limit applies, and survives a reconnect. The delay returned
   * is the time left until SEND_TIMEOUT; a "drain" wakes the loop earlier.
   */
  pump(): number {
    for (;;) {
      if (this.blockedSince !== null) {
        return Math.max(this.blockedSince + this.sendTimeout - this.clock(), 0.001);
      }
      if (!this.pending.length) {
        const next = this.queue.popleft();
        if (next === undefined) return 0.0;
        const [channels, text] = next;
        this.pending = [];
        for (const channel of channels ?? this.channels) {
          for (const part of wrapPayload(text, this.payloadLimit(channel))) this.pending.push([channel, part]);
        }
        if (!this.pending.length) continue;
      }
      const delay = this.bucket.acquireDelay();
      if (delay > 0) return delay;
      const [channel, part] = this.pending.shift()!;
      let dropped = 0;
      if (!this.pending.length) {
        dropped = this.dropped;
        this.dropped = 0;
      }
      this.raw(`PRIVMSG ${channel} :${part}`);
      if (dropped) this.sendMessage(`… dropped ${dropped} lines`);
    }
  }

  private poke(): void {
    const wake = this.wakeRead;
    this.wakeRead = null;
    wake?.();
  }

  private inputReady(): boolean {
    return this.buffer.includes(0x0a) || this.eof || this.failure !== null;
  }

  /**
   * Python's select() + recv(): wait up to `timeout` for input, then
   * dispatch every complete line. A closed or failed socket raises once the
   * lines that arrived before it are dispatched.
   */
  private async read(timeout: number): Promise<void> {
    if (!this.inputReady()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        this.wakeRead = resolve;
        timer = setTimeout(resolve, Math.max(timeout, 0) * 1000);
      });
      clearTimeout(timer);
      this.wakeRead = null;
    }
    let nl: number;
    while ((nl = this.buffer.indexOf(0x0a)) >= 0) {
      let end = nl;
      while (end > 0 && this.buffer[end - 1] === 0x0d) end--;
      const line = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(nl + 1);
      this.dispatch(line);
    }
    if (this.failure) throw new ConnectionError(describe(this.failure));
    if (this.eof) throw new ConnectionError("connection closed by server");
  }

  /**
   * Bytes of text this server relays to `channel` in one PRIVMSG.
   *
   * What has to fit is not the line we send but the one the receiver gets:
   * the server prepends `:nick!user@host ` to it. We learn that mask from the
   * JOIN the server echoes back to us and budget for the RFC's worst case
   * until it arrives.
   */
  payloadLimit(channel: string): number {
    const mask = this.mask || (this.nick || "") + "!" + "u".repeat(UNKNOWN_USERHOST);
    const head = `:${mask} PRIVMSG ${channel} :`;
    return Math.max(this.linelen - utf8Length(head) - 2, MIN_PAYLOAD);
  }

  /**
   * RPL_ISUPPORT: `TOKEN=value` or `TOKEN`, `-TOKEN` to take one back.
   *
   * The numeric ends in a human sentence ("are supported by this server") and
   * begins with our own nick; neither is a token, and the sentence is the only
   * part with spaces in it.
   */
  noteIsupport(tokens: string[]): void {
    for (const token of tokens) {
      if (!token || token.includes(" ")) continue;
      const eq = token.indexOf("=");
      const name = eq < 0 ? token : token.slice(0, eq);
      const value = eq < 0 ? "" : token.slice(eq + 1);
      if (name.startsWith("-")) delete this.isupport[py.upper(name.slice(1))];
      else this.isupport[py.upper(name)] = value;
    }
    this.linelen = this.advertised("LINELEN", LINELEN, 128, 65535);
  }

  private advertised(name: string, fallback: number, low: number, high: number): number {
    let value: number;
    try {
      value = py.int(this.isupport[name] ?? "");
    } catch {
      return fallback;
    }
    return low <= value && value <= high ? value : fallback;
  }

  /** One line from the server. Python's `_dispatch` (a Thread owns `_handle`). */
  dispatch(line: string): void {
    const [prefix, command, params] = parseLine(line);
    const prefixNick = prefix === null ? null : prefix.split("!", 1)[0]!;
    if (prefix && this.nick && prefixNick === this.nick && prefix.includes("@")) {
      this.mask = prefix; // our own JOIN, echoed back with the prefix the server uses
    }
    if (command === "PING") {
      this.raw("PONG :" + (params.length ? params.at(-1)! : ""));
    } else if (command === "001") {
      this.registered = true;
      this.greetingDeadline = this.clock() + GREETING_GRACE;
      this.attempts = 0;
      this.log(`agent-irc: ${this.server.label}: registered as ${this.nick}`);
      for (const channel of this.channels) this.raw("JOIN " + channel);
    } else if (command === "005") {
      this.noteIsupport(params.slice(1));
    } else if (command === "464") {
      // Wrong server password: the same PASS will be refused on every retry,
      // so this is not something reconnecting can fix.
      throw new GiveUp("server rejected our password");
    } else if ((command === "433" || command === "437") && !this.registered) {
      // 433 in use, 437 held by the server (netsplit, recent QUIT): both mean
      // "not this nick" and both are answered the same way.
      this.nickTry++;
      if (this.nickTry > MAX_NICK_TRIES) throw new GiveUp(`no free nick after ${MAX_NICK_TRIES} tries`);
      this.sendNick();
    } else if (command === "432" && !this.registered) {
      if (this.nickLimit !== NICK_LIMITS[1]) {
        this.nickLimit = NICK_LIMITS[1];
        this.sendNick();
      } else {
        throw new GiveUp("nick rejected: " + line);
      }
    } else if (command === "NICK" && prefix && prefixNick === this.nick && params.length) {
      this.nick = params.at(-1)!;
      if (this.mask) {
        const bang = this.mask.indexOf("!");
        this.mask = this.nick + "!" + (bang < 0 ? this.mask : this.mask.slice(bang + 1));
      }
    } else if (command === "PRIVMSG" && this.onMessage !== null && prefix && params.length >= 2) {
      this.inbound(prefix, params[0]!, params.at(-1)!);
    } else if (command === "ERROR") {
      throw new ConnectionError(line);
    }
  }

  /**
   * One PRIVMSG someone else sent, kept only if it is addressed to us.
   *
   * A DM is anything whose target is our nick. In a channel we take only the
   * lines that name us: a busy channel is a room the session is reporting
   * into, not its input.
   */
  private inbound(prefix: string, target: string, text: string): void {
    const nick = this.nick;
    if (!nick || py.lower(prefix.split("!", 1)[0]!) === py.lower(nick)) return;
    const body = unwrapCtcp(text);
    if (body === null) return;
    if (py.lower(target) !== py.lower(nick) && !(isChannel(target) && mentions(body, nick))) return;
    try {
      this.onMessage!(prefix, target, body);
    } catch (e) {
      this.log(`agent-irc: inbound message dropped: ${String(e)}`);
    }
  }

  /**
   * Write one protocol line. Line breaks become spaces, other control
   * characters go, and the line is cut to LINELEN as a last resort (only
   * lines we build ourselves can be long: a QUIT summary). A lone surrogate
   * goes out as U+FFFD -- Python's encode() raises on it instead.
   */
  raw(line: string): void {
    line = line.replace(/[\r\n]/g, " ").replace(CONTROL_RE, "");
    const data = encoder.encode(cutBytes(line, this.linelen - 2) + "\r\n");
    const sock = this.sock;
    if (sock === null) throw new ConnectionError("not connected");
    if (!sock.write(data) && this.blockedSince === null) this.blockedSince = this.clock();
  }

  /**
   * end() first, so every line written is flushed before the socket goes:
   * Python's sendall() had the bytes in the kernel already; a Node write may
   * still sit in the stream's buffer, and destroy() alone would drop it.
   * The flush gets 0.5s, and on a stop no more than the stop budget has left.
   */
  private async closeSocket(): Promise<void> {
    const sock = this.sock;
    this.sock = null;
    this.registered = false;
    this.blockedSince = null;
    if (sock === null) return;
    let grace = 0.5;
    if (this.stopDeadline !== null) grace = Math.min(grace, Math.max(this.stopDeadline - this.clock(), 0.0));
    if (!sock.destroyed && grace > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, grace * 1000);
        sock.end(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    sock.destroy();
  }
}
