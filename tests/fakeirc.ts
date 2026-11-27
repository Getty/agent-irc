// A minimal fake IRC server for tests: scripted registration, records every
// line (port of tests/fakeirc.py).
//
// Python serves each client on its own thread and sleeps in it for the
// scripted delays; here every client gets a serial async loop instead, so a
// delay holds back that client's later lines exactly as the sleeping thread
// did, and the client under test shares the event loop with the fake.
import { readFileSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import * as tls from "node:tls";

export const FIXTURES = join(import.meta.dir, "fixtures");
export const TLS_CERT = join(FIXTURES, "test-cert.pem");
export const TLS_KEY = join(FIXTURES, "test-key.pem");

export interface FakeOptions {
  takenNicks?: string[];
  /** Answered with 437, as a server does for a nick it is holding. */
  heldNicks?: string[];
  password?: string | null;
  maxNick?: number | null;
  /** Seconds between USER and 001. */
  welcomeDelay?: number;
  tls?: boolean;
  /** Extra RPL_ISUPPORT tokens after NICKLEN=30, e.g. "LINELEN=1024". */
  isupport?: string[];
  /** Seconds between 001 and 005, so the two land in separate reads. */
  isupportDelay?: number;
  /** Send no 005 at all, as a server without RPL_ISUPPORT does. */
  noIsupport?: boolean;
  /**
   * The first this-many connections stop reading once their first JOIN is
   * answered, as a hung server does: the client's writes back up into its
   * socket. resumeAll() makes them read again.
   */
  stallAfterJoin?: number;
  host?: string;
  /** Fixed port; 0 (the default) lets the system choose. */
  port?: number;
  /** Called with every line as it is recorded (run_fakeirc.ts prints them). */
  onLine?: (line: string) => void;
}

const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export class FakeIrcServer {
  readonly taken: Set<string>;
  readonly held: Set<string>;
  readonly password: string | null;
  readonly maxNick: number | null;
  readonly welcomeDelay: number;
  readonly isupportDelay: number;
  readonly tls: boolean;
  readonly isupport: string[] | null;
  readonly host: string;
  readonly received: string[] = [];
  connections: net.Socket[] = [];
  stallsLeft: number;
  port = 0;
  private readonly server: net.Server;
  private readonly onLine: ((line: string) => void) | undefined;

  private constructor(options: FakeOptions) {
    this.taken = new Set(options.takenNicks ?? []);
    this.held = new Set(options.heldNicks ?? []);
    this.password = options.password ?? null;
    this.maxNick = options.maxNick ?? null;
    this.welcomeDelay = options.welcomeDelay ?? 0;
    this.isupportDelay = options.isupportDelay ?? 0;
    this.tls = options.tls ?? false;
    this.isupport = options.noIsupport ? null : ["NICKLEN=30", ...(options.isupport ?? [])];
    this.host = options.host ?? "127.0.0.1";
    this.stallsLeft = options.stallAfterJoin ?? 0;
    this.onLine = options.onLine;
    const serve = (conn: net.Socket) => this.serve(conn);
    if (this.tls) {
      const server = tls.createServer({ cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) }, serve);
      // A client that refuses the handshake (verification on, as with a
      // self-signed certificate) aborts only its own connection.
      server.on("tlsClientError", () => {});
      this.server = server;
    } else {
      this.server = net.createServer(serve);
    }
  }

  static async create(options: FakeOptions = {}): Promise<FakeIrcServer> {
    const fake = new FakeIrcServer(options);
    await new Promise<void>((resolve, reject) => {
      fake.server.once("error", reject);
      fake.server.listen(options.port ?? 0, fake.host, () => resolve());
    });
    fake.port = (fake.server.address() as net.AddressInfo).port;
    return fake;
  }

  private send(conn: net.Socket, line: string): void {
    if (!conn.destroyed) conn.write(line + "\r\n", () => {});
  }

  private serve(conn: net.Socket): void {
    this.connections.push(conn);
    conn.on("error", () => {});
    const lines: string[] = [];
    let buffer = Buffer.alloc(0);
    let wake: (() => void) | null = null;
    let ended = false;
    const poke = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    conn.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let nl: number;
      while ((nl = buffer.indexOf(0x0a)) >= 0) {
        let end = nl;
        if (end > 0 && buffer[end - 1] === 0x0d) end--;
        lines.push(decoder.decode(buffer.subarray(0, end)));
        buffer = buffer.subarray(nl + 1);
      }
      poke();
    });
    conn.on("close", () => {
      ended = true;
      this.connections = this.connections.filter((c) => c !== conn);
      poke();
    });
    const next = async (): Promise<string | null> => {
      while (lines.length === 0) {
        if (ended) return null;
        await new Promise<void>((resolve) => (wake = resolve));
      }
      return lines.shift()!;
    };
    // As Python's sendall() then close(): what was written (the closing
    // ERROR) goes out before the connection does.
    void this.script(conn, next).finally(() => {
      conn.end();
      setTimeout(() => conn.destroy(), 1000).unref();
    });
  }

  private async script(conn: net.Socket, next: () => Promise<string | null>): Promise<void> {
    let nick: string | null = null;
    let user: string | null = null;
    let passed: string | null = null;
    let welcomed = false;
    let stall = this.stallsLeft > 0;
    if (stall) this.stallsLeft--;
    for (let line = await next(); line !== null; line = await next()) {
      this.received.push(line);
      this.onLine?.(line);
      const parts = line.split(" ");
      const cmd = parts[0]!.toUpperCase();
      if (cmd === "PASS") {
        passed = line.split(" ").slice(1).join(" ").replace(/^:+/, "");
      } else if (cmd === "NICK") {
        const candidate = (parts[1] ?? "").replace(/^:+/, "");
        if (this.taken.has(candidate)) {
          this.send(conn, `:srv 433 * ${candidate} :Nickname is already in use`);
          continue;
        }
        if (this.held.has(candidate)) {
          this.send(conn, `:srv 437 * ${candidate} :Nick is temporarily unavailable`);
          continue;
        }
        if (this.maxNick && candidate.length > this.maxNick) {
          this.send(conn, `:srv 432 * ${candidate} :Erroneous nickname`);
          continue;
        }
        nick = candidate;
      } else if (cmd === "USER") {
        user = parts[1] ?? "";
      } else if (cmd === "PING") {
        const i = line.indexOf(":");
        this.send(conn, ":srv PONG srv :" + (i >= 0 ? line.slice(i + 1) : line));
      } else if (cmd === "JOIN") {
        this.send(conn, `:${nick}!u@h JOIN ${parts[1]}`);
        if (stall) {
          stall = false;
          conn.pause();
        }
      } else if (cmd === "QUIT") {
        this.send(conn, "ERROR :Closing Link");
        return;
      }
      if (nick && user && !welcomed) {
        welcomed = true;
        if (this.password !== null && passed !== this.password) {
          this.send(conn, ":srv 464 * :Password incorrect");
          this.send(conn, "ERROR :Closing Link: bad password");
          return;
        }
        if (this.welcomeDelay) await sleep(this.welcomeDelay);
        this.send(conn, `:srv 001 ${nick} :Welcome`);
        // A real burst puts 001 and 005 back to back; this gap lets a test
        // reproduce the case where they arrive in separate reads, so LINELEN
        // is not yet known at 001.
        if (this.isupportDelay) await sleep(this.isupportDelay);
        if (this.isupport) this.send(conn, `:srv 005 ${nick} ${this.isupport.join(" ")} :are supported by this server`);
      }
    }
  }

  lines(): string[] {
    return [...this.received];
  }

  /** Push one raw line at every connected client (inbound traffic). */
  sendToAll(line: string): void {
    for (const conn of [...this.connections]) this.send(conn, line);
  }

  async waitFor(predicate: (lines: string[]) => boolean, timeout = 5.0): Promise<boolean> {
    const deadline = performance.now() + timeout * 1000;
    while (performance.now() < deadline) {
      if (predicate(this.lines())) return true;
      await sleep(0.02);
    }
    return false;
  }

  /** Read again on every connection a stall paused. */
  resumeAll(): void {
    for (const conn of this.connections) conn.resume();
  }

  dropAll(): void {
    const conns = this.connections;
    this.connections = [];
    for (const conn of conns) conn.destroy();
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
