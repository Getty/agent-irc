// Configuration: URL parsing, harness settings files, trust, layer merge
// (spec §5; port of agent_irc/config.py).
//
// TOML comes from Bun.TOML.parse, which replaces both of Python's readers:
// tomllib and the one-table fallback for Python < 3.11. Where those two
// disagreed, the port follows tomllib (an invalid file is skipped whole).
import { existsSync, readFileSync } from "node:fs";
import * as py from "./py.js";

export const NAMESPACE = "agent-irc";
export const LEVELS = ["activity", "subactivity", "full"] as const;
// Python's $ also matches before one trailing newline.
const LIST_KEY_RE = /^(?:[a-z0-9]+_)?channels\n?$/;
// How fast we may send and how much may wait. The defaults are the safe ones
// for a public server; an ircd of one's own takes far more, and level "full"
// wants it -- one Write can be a thousand lines.
export const TUNING_KEYS = ["flood_burst", "flood_interval", "queue_limit"] as const;

export type Env = Record<string, string | undefined>;
export type Log = ((line: string) => void) | null | undefined;

export class Server {
  constructor(
    readonly scheme: string,
    readonly host: string,
    readonly port: number,
    readonly user: string,
    readonly password: string | null,
    /** Not part of the identity: the same server with and without it is one server. */
    readonly insecure: boolean,
  ) {}

  get tls(): boolean {
    return this.scheme === "ircs";
  }

  get label(): string {
    // host holds the bare address, the way a socket wants it; an IPv6 literal
    // gets its brackets back for anything human-read.
    const host = this.host.includes(":") ? `[${this.host}]` : this.host;
    return `${host}:${this.port}`;
  }

  /** The dataclass identity (eq and hash): everything but `insecure`. */
  get key(): string {
    return JSON.stringify([this.scheme, this.host, this.port, this.user, this.password]);
  }
}

export function sameServer(a: Server, b: Server): boolean {
  return a.key === b.key;
}

export interface Target {
  server: Server;
  channel: string;
}

function targetKey(t: Target): string {
  return JSON.stringify([t.server.key, t.channel]);
}

export interface Config {
  targets: Target[];
  level: string;
  floodBurst: number;
  floodInterval: number;
  /** 0 = never drop */
  queueLimit: number;
  /** accept DMs and mentions for the read_messages tool */
  listen: boolean;
  /** hostmask patterns; empty = nobody */
  listenFrom: string[];
}

/** The settings as merge_layers names them. */
export interface Values {
  flood_burst?: number;
  flood_interval?: number;
  queue_limit?: number;
  listen?: boolean;
  listen_from?: string[];
}

export function makeConfig(targets: Target[], level: string, values: Values = {}): Config {
  return {
    targets,
    level,
    floodBurst: values.flood_burst ?? 4,
    floodInterval: values.flood_interval ?? 2.0,
    queueLimit: values.queue_limit ?? 500,
    listen: values.listen ?? false,
    listenFrom: values.listen_from ?? [],
  };
}

// -- URLs ----------------------------------------------------------------------------

// The host is either a name/IPv4, or an IPv6 literal in brackets -- which is
// the only place a colon may appear before the port. Python's \d is any
// Unicode decimal digit and its . anything but \n.
const URL_RE =
  /^(ircs?):\/\/(?:([^@/]*)@)?(\[[0-9A-Fa-f:.]+\]|[^/:?#@]+)(?::(\p{Nd}+))?\/([^?]*)(?:\?([^\n]*))?\n?$/u;
const USERINFO_RE = /^([A-Za-z]+:\/\/)[^\n]*@/;

/** The URL with any user:password part replaced by ***, for log and error text. */
export function redactUrl(url: unknown): string {
  return py.str(url).replace(USERINFO_RE, "$1***@");
}

const HEX_PAIR = /^[0-9A-Fa-f]{2}/;
// ignoreBOM: a leading U+FEFF is text to Python, and TextDecoder would drop it.
const lenientUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** urllib.parse.unquote: %XX runs as UTF-8 (errors replaced), anything else as it is. */
export function unquote(s: string): string {
  if (!s.includes("%")) return s;
  // Python decodes each ASCII run on its own; a non-ASCII character between
  // two escapes ends the byte run.
  return s.replace(/[\x00-\x7f]+/g, (run) => {
    const bytes: number[] = [];
    const parts = run.split("%");
    for (const ch of parts[0]!) bytes.push(ch.charCodeAt(0));
    for (const part of parts.slice(1)) {
      if (HEX_PAIR.test(part)) {
        bytes.push(parseInt(part.slice(0, 2), 16));
        for (const ch of part.slice(2)) bytes.push(ch.charCodeAt(0));
      } else {
        bytes.push(0x25);
        for (const ch of part) bytes.push(ch.charCodeAt(0));
      }
    }
    return lenientUtf8.decode(new Uint8Array(bytes));
  });
}

/** What Python raises as ValueError from parse_url. */
export class UrlError extends py.PyValueError {}

export function parseUrl(url: unknown, defaultUser: string): Target {
  const m = URL_RE.exec(py.strip(py.str(url)));
  if (!m) throw new UrlError(`not an irc:// or ircs:// URL with a channel: ${py.repr(redactUrl(url))}`);
  const [, scheme, userinfo, rawHost, rawPort, path, query] = m as unknown as [
    string,
    string,
    string | undefined,
    string,
    string | undefined,
    string,
    string | undefined,
  ];
  let user = defaultUser;
  let password: string | null = null;
  if (userinfo !== undefined) {
    let rawUser = userinfo;
    const colon = userinfo.indexOf(":");
    if (colon >= 0) {
      rawUser = userinfo.slice(0, colon);
      password = unquote(userinfo.slice(colon + 1));
    }
    if (rawUser) user = unquote(rawUser);
  }
  const port = rawPort ? Number(py.asciiDigits(rawPort)) : scheme === "ircs" ? 6697 : 6667;
  let channel = py.strip(unquote(path));
  if (!channel) throw new UrlError(`URL has no channel: ${py.repr(redactUrl(url))}`);
  if (!"#&+!".includes([...channel][0]!)) channel = "#" + channel;
  let host = py.lower(rawHost);
  if (host.startsWith("[")) host = host.slice(1, -1); // bare address for the socket
  let insecure = false;
  for (const part of (query ?? "").split("&")) {
    const eq = part.indexOf("=");
    const key = eq < 0 ? part : part.slice(0, eq);
    const value = eq < 0 ? "" : part.slice(eq + 1);
    if (key === "insecure" && ["1", "true", "yes"].includes(py.lower(value || "1"))) insecure = true;
  }
  return { server: new Server(scheme, host, port, user, password, insecure), channel };
}

/** expand_env's KeyError: a ${NAME} with no NAME in the environment. */
export class MissingVariable extends Error {
  override name = "KeyError";
  constructor(readonly variable: string) {
    super(variable);
  }
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function expandEnv(s: string, env: Env): string {
  return s.replace(VAR_RE, (_, name: string) => {
    const value = Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
    if (value === undefined) throw new MissingVariable(name);
    return value;
  });
}

// -- reading the files ------------------------------------------------------------------

function logLine(log: Log, message: string): void {
  if (log) log(message);
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The file as text; null when it cannot be read (OSError). Throws on bad UTF-8. */
function readText(path: string): string | null {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch {
    return null;
  }
  return utf8.decode(data);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function readJsonNamespace(path: string, log?: Log): Record<string, unknown> {
  let data: unknown;
  try {
    const text = readText(path);
    if (text === null) return {};
    data = py.loads(text);
  } catch (e) {
    logLine(log, `agent-irc: ${path}: invalid JSON (${errorText(e)}), skipped`);
    return {};
  }
  const ns = py.isDict(data) ? py.dictGet(data, NAMESPACE) : undefined;
  return py.isDict(ns) && !(ns instanceof Map) ? ns : {};
}

/**
 * Bun.TOML.parse, the stand-in for tomllib.loads. Throws on invalid TOML.
 *
 * Bun skips a leading byte order mark that tomllib refuses ("Invalid
 * statement"), so that one is refused here. The disagreements left are in
 * CLAUDE.md: Bun also accepts a trailing comma in an inline table, refuses an
 * integer beyond 2^53, and gives `4.0` as the number 4.
 */
export function parseToml(text: string): unknown {
  if (text.startsWith("\ufeff")) throw new SyntaxError("TOML Parse error: Invalid statement (a byte order mark)");
  return Bun.TOML.parse(text);
}

/** The agent-irc table of a parsed document, {} when there is none. */
export function tomlNamespace(doc: unknown): Record<string, unknown> {
  const ns = py.isDict(doc) ? py.dictGet(doc, NAMESPACE) : undefined;
  return py.isDict(ns) && !(ns instanceof Map) ? ns : {};
}

/** The whole file, {} when it cannot be read or parsed (tomllib's _load_toml). */
export function loadToml(path: string, log?: Log): unknown {
  let text: string | null;
  try {
    text = readText(path);
    if (text === null) return {};
    return parseToml(text);
  } catch (e) {
    logLine(log, `agent-irc: ${path}: invalid TOML (${errorText(e)}), skipped`);
    return {};
  }
}

export function readTomlNamespace(path: string, log?: Log): Record<string, unknown> {
  return tomlNamespace(loadToml(path, log));
}

// -- trust -------------------------------------------------------------------------------

export function ancestors(path: string): string[] {
  let p = py.abspath(path);
  const out: string[] = [];
  for (;;) {
    out.push(p);
    const parent = py.dirname(p);
    if (parent === p) return out;
    p = parent;
  }
}

/**
 * The directory the harness keeps its own settings in.
 *
 * Both harnesses let the user move it -- Codex with `CODEX_HOME`, Claude
 * Code with `CLAUDE_CONFIG_DIR` -- and then keep everything there, settings
 * and trust markers alike. Reading `~/.codex` or `~/.claude` regardless is
 * how a session with a moved config runs with no configuration at all, and
 * silently: no configuration is a legitimate state, so nothing complains.
 * Found the hard way while testing Codex in an isolated `CODEX_HOME`
 * (2026-09-08): the hooks fired, the server started -- the bootstrap in
 * `.mcp.codex.json` does honour `CODEX_HOME` -- and not one line reached
 * IRC, because the config it read was the one in the real home.
 */
export function configHome(harness: string, home: string, env: Env = {}): string {
  if (harness === "codex") return env.CODEX_HOME || py.pathJoin(home, ".codex");
  return env.CLAUDE_CONFIG_DIR || py.pathJoin(home, ".claude");
}

/**
 * `<config dir>/.claude.json` when it is there, else `~/.claude.json`.
 *
 * Claude Code moves this file into `CLAUDE_CONFIG_DIR` along with the rest
 * (verified live 2026-09-08: an isolated config dir gets its own
 * `.claude.json`), but with no variable set it sits next to `~/.claude`,
 * not inside it.
 */
export function claudeTrustFile(home: string, env: Env = {}): string {
  const moved = py.pathJoin(configHome("claude", home, env), ".claude.json");
  return existsSync(moved) ? moved : py.pathJoin(home, ".claude.json");
}

export function claudeTrusted(home: string, cwd: string, env: Env = {}): boolean {
  let data: unknown;
  try {
    const text = readText(claudeTrustFile(home, env));
    if (text === null) return false;
    data = py.loads(text);
  } catch {
    return false;
  }
  const projects = py.isDict(data) ? py.dictGet(data, "projects") : undefined;
  if (!py.isDict(projects)) return false;
  for (const p of ancestors(cwd)) {
    const entry = py.dictGet(projects, p);
    if (py.isDict(entry) && py.dictGet(entry, "hasTrustDialogAccepted") === true) return true;
  }
  return false;
}

export function codexTrusted(home: string, cwd: string, env: Env = {}): boolean {
  const data = loadToml(py.pathJoin(configHome("codex", home, env), "config.toml"));
  const projects = py.isDict(data) ? py.dictGet(data, "projects") : undefined;
  if (!py.isDict(projects)) return false;
  for (const p of ancestors(cwd)) {
    const entry = py.dictGet(projects, p);
    if (py.isDict(entry) && py.dictGet(entry, "trust_level") === "trusted") return true;
  }
  return false;
}

export function isTrusted(harness: string, cwd: string, home: string, env: Env = {}): boolean {
  if (harness === "codex") return codexTrusted(home, cwd, env);
  return claudeTrusted(home, cwd, env);
}

// -- merging -------------------------------------------------------------------------

/** One tuning number, or null if it is not a number this key can take. */
export function tuningValue(key: string, value: unknown): number | null {
  if (typeof value === "boolean" || !(py.isInt(value) || py.isFloat(value))) return null;
  const n = py.numberOf(value);
  if (key === "flood_interval") return n >= 0 ? n : null;
  if (!py.isInt(value)) return null;
  return n >= (key === "flood_burst" ? 1 : 0) ? n : null;
}

export interface Merged {
  lists: Map<string, string[]>;
  level: string;
  values: Values;
}

/**
 * Named lists: last definition of a name wins whole. Level, tuning numbers
 * and the listen settings: last valid value wins.
 *
 * `values` is whatever makeConfig takes, so a new setting only has to be
 * read here and declared there.
 */
export function mergeLayers(layers: unknown[]): Merged {
  const lists = new Map<string, string[]>();
  let level = "activity";
  const values: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!py.isDict(layer)) continue;
    for (const [key, value] of py.dictEntries(layer)) {
      if (LIST_KEY_RE.test(key) && Array.isArray(value)) {
        lists.set(key, value.filter((v): v is string => typeof v === "string"));
      } else if (key === "level" && typeof value === "string" && (LEVELS as readonly string[]).includes(value)) {
        level = value;
      } else if ((TUNING_KEYS as readonly string[]).includes(key)) {
        const number = tuningValue(key, value);
        if (number !== null) values[key] = number;
      } else if (key === "listen" && typeof value === "boolean") {
        values[key] = value;
      } else if (key === "listen_from" && Array.isArray(value)) {
        values[key] = value.filter((v): v is string => typeof v === "string");
      }
    }
  }
  return { lists, level, values: values as Values };
}

export function resolveTargets(lists: Map<string, string[]>, env: Env, defaultUser: string, log?: Log): Target[] {
  const targets: Target[] = [];
  const seen = new Set<string>();
  for (const [name, urls] of lists) {
    for (const url of urls) {
      let target: Target;
      try {
        target = parseUrl(expandEnv(url, env), defaultUser);
      } catch (e) {
        if (e instanceof MissingVariable) {
          logLine(log, `agent-irc: ${name}: \${${e.variable}} is not set, entry skipped`);
          continue;
        }
        if (e instanceof py.PyValueError) {
          logLine(log, `agent-irc: ${name}: ${e.message}, entry skipped`);
          continue;
        }
        throw e;
      }
      const key = targetKey(target);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(target);
    }
  }
  return targets;
}

/**
 * User-level file first, then the project's -- which are always relative to
 * the project, whatever the user-level directory is.
 */
export function configFiles(harness: string, cwd: string, home: string, trusted: boolean, env: Env = {}): string[] {
  if (harness === "codex") {
    const files = [py.pathJoin(configHome("codex", home, env), "config.toml")];
    if (trusted) files.push(py.pathJoin(cwd, ".codex", "config.toml"));
    return files;
  }
  const files = [py.pathJoin(configHome("claude", home, env), "settings.json")];
  if (trusted) {
    files.push(py.pathJoin(cwd, ".claude", "settings.json"));
    files.push(py.pathJoin(cwd, ".claude", "settings.local.json"));
  }
  return files;
}

export function loadConfig(harness: string, cwd: string, home: string, env: Env, log?: Log): Config {
  const trusted = isTrusted(harness, cwd, home, env);
  if (!trusted) logLine(log, `agent-irc: ${cwd} is not trusted by ${harness}, project config ignored`);
  const reader = harness === "codex" ? readTomlNamespace : readJsonNamespace;
  const layers = configFiles(harness, cwd, home, trusted, env).map((path) => reader(path, log));
  const { lists, level, values } = mergeLayers(layers);
  const defaultUser = env.USER || env.LOGNAME || "agent";
  return makeConfig(resolveTargets(lists, env, defaultUser, log), level, values);
}
