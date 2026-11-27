// Wire the MCP loop, the event queue, configuration, session and IRC
// connections (spec §3, §6; port of agent_irc/server.py).
//
// The Python server ran the MCP loop on the main thread and handed events to a
// dispatcher thread; here both share Bun's event loop. onEvent only queues
// and starts the drain a macrotask later, so a tools/call is answered before
// its event is formatted, its transcript read or a line sent to IRC. The
// drain handles one event after another, in arrival order, and reads every
// transcript ahead in chunks with a macrotask turn between them
// (Session.prepare), so reading and parsing a resumed transcript never holds
// a later call -- or a signal, or IRC I/O -- for more than one chunk. What
// follows prepare() is not chunked: emit() then walks the parsed records
// synchronously, measured at 85-97 ms for a 52 MB transcript (about
// 1.7 ms/MB, the loop stalled up to ~120 ms in all), so a call arriving then
// waits that long.
import { writeSync } from "node:fs";
import { constants, homedir } from "node:os";
import { loadConfig, type Config, type Env, type Server } from "./config.js";
import { Session } from "./events.js";
import { Inbox } from "./inbound.js";
import { FloodBucket, IrcConnection, type ConnectionOptions } from "./irc.js";
import * as mcp from "./mcp.js";
import * as py from "./py.js";
import { nickBase } from "./text.js";
import { VERSION } from "./version.js";

type Log = (line: string) => void;

/** What the App needs of an IrcConnection; tests substitute a recorder. */
export interface ConnectionLike {
  start(): void;
  sendMessage(text: string): void;
  beginClose(quitMessage: string): void;
  join(timeout?: number): Promise<boolean> | boolean | void;
}

export type ConnectionFactory = (
  server: Server,
  channels: string[],
  nickBase: string,
  realname: string,
  log: Log,
  options: ConnectionOptions,
) => ConnectionLike;

const realConnection: ConnectionFactory = (...args) => new IrcConnection(...args);

/** The budget shutdown() gives the connections to send their QUIT, all together. */
export const SHUTDOWN_BUDGET = 2.0;

/**
 * What shutdown() waits for the queued events before the QUIT goes out,
 * Python's worker.join(2.0). An object so a test can shrink it.
 */
export const DRAIN_BUDGET = { seconds: 2.0 };

const nextTask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function detectHarness(clientInfo: unknown): string {
  const name = py.isDict(clientInfo) ? py.dictGet(clientInfo, "name") : undefined;
  const text = py.lower(py.str(py.or(name ?? null, "")));
  if (text.includes("claude")) return "claude";
  if (text.includes("codex")) return "codex";
  return text || "agent";
}

/**
 * The host word the getty-bun starter passes: `run dist/server.js <host>`.
 * It names the harness outright and so wins over clientInfo; without it (a
 * direct start, the tests) clientInfo decides, as it did in Python. An
 * unknown word is logged and changes nothing.
 */
export const HOST_WORDS: Record<string, string> = { "claude-code": "claude", codex: "codex" };

export function hostWord(args: string[], log: Log): string | null {
  const [word, ...extra] = args;
  let harness: string | null = null;
  if (word !== undefined) {
    if (Object.prototype.hasOwnProperty.call(HOST_WORDS, word)) harness = HOST_WORDS[word]!;
    else log(`agent-irc: unknown host argument ${py.repr(word)}, the harness comes from clientInfo`);
  }
  if (extra.length > 0) log(`agent-irc: extra arguments ignored: ${extra.map(py.repr).join(" ")}`);
  return harness;
}

function usableSessionId(value: unknown): boolean {
  return py.truthy(value) && !py.str(value).startsWith("${");
}

function get(ev: py.PyDict, key: string): unknown {
  return py.dictGet(ev, key) ?? null;
}

export interface AppOptions {
  home: string;
  env: Env;
  stdin: AsyncIterable<Uint8Array | string>;
  stdout: mcp.Output;
  log: Log;
  connectionFactory?: ConnectionFactory;
  debug?: Log | null;
  /** The process's own cwd: the tools/list decision is made off it. */
  cwd?: string;
  /** The harness from the host word; null leaves it to clientInfo. */
  harness?: string | null;
}

export class App {
  readonly home: string;
  readonly env: Env;
  readonly stdin: AsyncIterable<Uint8Array | string>;
  readonly stdout: mcp.Output;
  readonly log: Log;
  readonly debug: Log | null;
  readonly connectionFactory: ConnectionFactory;
  readonly cwd: string;
  readonly forcedHarness: string | null;
  readonly inbox: Inbox;
  harness = "agent";
  level: string | null = null;
  session: Session | null = null;
  retired = new Set<string>();
  connections: ConnectionLike[] = [];
  stopped = false;
  readonly queue: py.PyDict[] = [];
  /** The drain under way, or null when the queue is idle. */
  private draining: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;

  constructor(options: AppOptions) {
    this.home = options.home;
    this.env = options.env;
    this.stdin = options.stdin;
    this.stdout = options.stdout;
    this.log = options.log;
    this.debug = options.debug ?? null;
    this.connectionFactory = options.connectionFactory ?? realConnection;
    this.cwd = options.cwd ?? process.cwd();
    this.forcedHarness = options.harness ?? null;
    this.inbox = new Inbox({ log: this.log });
  }

  // -- MCP callbacks --------------------------------------------------------

  onInitialize(params: py.PyDict): void {
    this.harness = this.forcedHarness ?? detectHarness(py.dictGet(params, "clientInfo"));
    this.log(`agent-irc ${VERSION}: initialized by ${this.harness}`);
    // tools/list follows initialize and is the only time the harness asks
    // what this server offers, long before the first event names a session
    // -- so whether read_messages exists has to be decided from the config
    // here, off the process's own cwd. Quietly: the session's own load
    // does the logging, and does it with the cwd the harness reports.
    this.listen(loadConfig(this.harness, this.cwd, this.home, this.env));
  }

  onEvent(args: py.PyDict): void {
    if (this.stopped) return;
    this.queue.push(args instanceof Map ? new Map(args) : { ...args });
    if (this.draining === null) this.draining = this.drain();
  }

  async run(): Promise<void> {
    try {
      await mcp.serve(this.stdin, this.stdout, {
        onInitialize: (p) => this.onInitialize(p),
        onEvent: (a) => this.onEvent(a),
        log: this.log,
        version: VERSION,
        inbox: this.inbox,
        stopped: () => this.stopped,
      });
    } finally {
      await this.shutdown();
    }
  }

  // -- the event queue ----------------------------------------------------------

  /**
   * Python's dispatcher thread: every queued event in order, each on its own.
   * An event is done -- its transcript read, its lines sent -- before the
   * next one starts; only the waits inside its read-ahead let the loop
   * answer calls, take signals and do IRC I/O.
   */
  private async drain(): Promise<void> {
    await nextTask(); // the answer to the call that queued it goes out first
    while (this.queue.length > 0) {
      const ev = this.queue.shift()!;
      try {
        const session = this.route(ev);
        if (session !== null) {
          await session.prepare(ev);
          this.emit(session, ev);
        }
      } catch (e) {
        this.log(`agent-irc: event dropped: ${mcp.errorRepr(e)}`);
      }
    }
    this.draining = null;
  }

  /**
   * Python's App._handle, all at once with no read-ahead; public for the
   * tests that drive it directly. The drain does the same in two halves.
   */
  handle(ev: py.PyDict): void {
    const session = this.route(ev);
    if (session !== null) this.emit(session, ev);
  }

  private emit(session: Session, ev: py.PyDict): void {
    for (const line of session.handle(ev)) {
      for (const connection of this.connections) connection.sendMessage(line);
    }
  }

  /** Everything _handle does before Session.handle: the session the event belongs to, or null to drop it. */
  private route(ev: py.PyDict): Session | null {
    if (this.debug) this.debug(`agent-irc: event ${py.slice(py.dumps(ev, { ensureAscii: true, sortKeys: true }), 0, 2000)}`);
    const sessionId = get(ev, "session_id");
    const current = this.session !== null ? this.session.sessionId : null;
    if (current !== null && usableSessionId(sessionId) && py.str(sessionId) !== current) {
      const kind = get(ev, "event");
      if (this.retired.has(py.str(sessionId)) || kind === "SessionEnd") {
        // Async hooks keep no order: a trailing Stop or SessionEnd for a
        // session this process already replaced, or a SessionEnd for an id
        // it never ran, must neither resurrect the old session nor announce
        // a new one -- that would be the phantom start+end pair the
        // no-prior-state guard below exists to prevent.
        this.log(`agent-irc: ${py.str(kind)} for other session ${py.slice(py.str(sessionId), 0, 8)} ignored`);
        return null;
      }
      if (kind === "UserPromptSubmit") {
        // /clear or /resume hands the running server a new session_id (and
        // transcript_path) without restarting it. Only a prompt starts a
        // session (spec 3); any other event with a foreign id stays with the
        // running session. Config level and connections are kept; only the
        // per-session state resets.
        this.log(`agent-irc: new session ${py.slice(py.str(sessionId), 0, 8)} replaces ${py.slice(current, 0, 8)}`);
        this.retired.add(current);
        const cwd = py.str(py.or(get(ev, "cwd"), this.session!.cwd));
        this.session = new Session(this.harness, this.level!, cwd, this.home, { debug: this.debug });
      }
    }
    if (this.session === null) {
      if (!usableSessionId(sessionId)) return null;
      if (get(ev, "event") === "SessionEnd") {
        // A harness may start a fresh server process to deliver SessionEnd
        // after the process holding the real session state already exited
        // (Claude Code print mode). Announcing a session here would be a
        // phantom start+end with a false "0 turns" summary. Stay quiet.
        this.log("agent-irc: SessionEnd with no prior state, staying quiet");
        return null;
      }
      const cwd = py.str(py.or(get(ev, "cwd"), this.cwd));
      const config = loadConfig(this.harness, cwd, this.home, this.env, this.log);
      this.level = config.level;
      this.listen(config);
      this.session = new Session(this.harness, this.level, cwd, this.home, { debug: this.debug });
      this.connect(config, cwd, py.str(sessionId));
    }
    return this.session;
  }

  /** Inbound is opt-in and denies by default (see inbound.ts). */
  private listen(config: Config): void {
    if (config.listen) this.inbox.enable(config.listenFrom);
    else this.inbox.disable();
  }

  private connect(config: Config, cwd: string, sessionId: string): void {
    const byServer = new Map<string, [Server, string[]]>();
    for (const target of config.targets) {
      const entry = byServer.get(target.server.key);
      if (entry) entry[1].push(target.channel);
      else byServer.set(target.server.key, [target.server, [target.channel]]);
    }
    if (byServer.size === 0) {
      this.log("agent-irc: no channels configured, staying quiet");
      return;
    }
    const realname = `${this.harness} ${sessionId} ${cwd}`;
    for (const [server, channels] of byServer.values()) {
      const connection = this.connectionFactory(server, channels, nickBase(cwd), realname, this.log, {
        bucket: new FloodBucket(config.floodBurst, config.floodInterval),
        queueLimit: config.queueLimit,
        onMessage: (prefix, target, text) => void this.inbox.add(prefix, target, text),
      });
      connection.start();
      this.connections.push(connection);
      this.log(`agent-irc: connecting to ${server.label} for ${channels.join(" ")}`);
    }
  }

  // -- teardown -------------------------------------------------------------------

  /**
   * Handle what is still queued, then QUIT every connection with the summary.
   *
   * Idempotent, and every caller gets the same promise: a signal arriving
   * while an EOF's shutdown is under way waits for that one's QUIT instead
   * of exiting underneath it.
   */
  shutdown(): Promise<void> {
    if (this.stopping === null) this.stopping = this.stop();
    return this.stopping;
  }

  private async stop(): Promise<void> {
    this.stopped = true;
    // worker.join(2.0): a drain still busy after that goes on unawaited,
    // and the QUIT goes out with the summary as it stands.
    if (this.draining !== null) await within(this.draining, DRAIN_BUDGET.seconds);
    if (this.session === null) return;
    const message = "session ended · " + this.session.summary();
    for (const connection of this.connections) connection.beginClose(message);
    const joined = Promise.all(this.connections.map((c) => Promise.resolve(c.join(SHUTDOWN_BUDGET)).catch(() => false)));
    await within(joined, SHUTDOWN_BUDGET);
  }
}

/** Wait for `work`, but no longer than `seconds`. */
async function within(work: Promise<unknown>, seconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => (timer = setTimeout(resolve, seconds * 1000)));
  await Promise.race([work, budget]);
  clearTimeout(timer);
}

/** Something that delivers signals by name: `process`, or an EventEmitter in the tests. */
export interface SignalSource {
  on(signal: "SIGTERM" | "SIGINT" | "SIGHUP", listener: () => void): unknown;
}

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/**
 * SIGTERM, SIGINT and SIGHUP stop the server: onStop(128 + signum).
 *
 * Only the first signal counts. Claude Code sends SIGINT and ~100ms later
 * SIGTERM (live-observed 2026-09-05, Task 20). Bun, given both back to back,
 * keeps no fixed order: SIGTERM came first in 3/3 part A probes (report
 * §3.3), but the exit code of such a pair is 130 or 143 -- either way the
 * second one lands while shutdown() is still waiting for the QUIT, and is
 * only logged.
 * isStopped covers an EOF-triggered shutdown already under way: a signal then
 * is logged too, and the exit code stays the EOF's 0.
 */
export function installSignalHandlers(
  log: Log,
  isStopped: (() => boolean) | null,
  onStop: (code: number) => void,
  source: SignalSource = process,
): void {
  let stopping = false;
  for (const name of SIGNALS) {
    const signum = constants.signals[name];
    source.on(name, () => {
      if (stopping || (isStopped !== null && isStopped())) {
        log(`agent-irc: signal ${signum}, already shutting down`);
        return;
      }
      stopping = true;
      log(`agent-irc: signal ${signum}, shutting down`);
      onStop(128 + signum);
    });
  }
}

/** write(2) the whole text, waiting out EAGAIN on a non-blocking pipe. */
function writeAll(fd: number, text: string): void {
  let data = Buffer.from(text, "utf8");
  while (data.length > 0) {
    try {
      const n = writeSync(fd, data);
      data = data.subarray(n);
    } catch (e) {
      if ((e as { code?: unknown }).code !== "EAGAIN") throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
}

/**
 * The entry: `bun dist/server.js [claude-code|codex]`.
 *
 * Exit codes are Python's: 0 when stdin ends (or stdout is gone), 128 +
 * signum after a signal -- 130, 143, 129. stdout carries the JSON-RPC
 * answers and nothing else; every diagnostic goes to stderr.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<never> {
  const log: Log = (message) => {
    try {
      writeAll(2, message + "\n");
    } catch {
      // stderr gone too: nothing left to tell
    }
  };
  const debug = process.env.AGENT_IRC_DEBUG === "1" ? log : null;
  const harness = hostWord(argv, log);
  const app = new App({
    home: process.env.HOME || homedir(),
    env: { ...process.env },
    stdin: process.stdin,
    stdout: { write: (text) => writeAll(1, text) },
    log,
    debug,
    harness,
  });
  let exitCode = 0;
  installSignalHandlers(log, () => app.stopped, (code) => {
    exitCode = code;
    void app.shutdown().then(() => process.exit(exitCode));
  });
  await app.run();
  process.exit(exitCode);
}

if (import.meta.main) await main();
