// Token usage read from harness transcripts (spec §9; port of agent_irc/usage.py).
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import * as py from "./py.js";
import { fmtTokens } from "./text.js";

/**
 * A transcript grows without bound; the model is named in every assistant
 * record, so the tail is always enough to find it. An object so a test can
 * shrink it, the way the Python tests patch PEEK_BYTES.
 */
export const PEEK = { bytes: 256 * 1024 };

export interface UsageFields {
  input?: number;
  cached?: number;
  output?: number;
  tools?: number;
  model?: unknown;
  duration?: number | null;
}

export class Usage {
  input: number;
  cached: number;
  output: number;
  tools: number;
  /** A str in practice; whatever the transcript holds, as Python keeps it. */
  model: unknown;
  duration: number | null;

  constructor({ input = 0, cached = 0, output = 0, tools = 0, model = null, duration = null }: UsageFields = {}) {
    this.input = input;
    this.cached = cached;
    this.output = output;
    this.tools = tools;
    this.model = model;
    this.duration = duration;
  }

  add(other: Usage): this {
    this.input += other.input;
    this.cached += other.cached;
    this.output += other.output;
    this.tools += other.tools;
    if (py.truthy(other.model)) this.model = other.model;
    return this;
  }

  hasTokens(): boolean {
    return py.truthy(this.input) || py.truthy(this.output);
  }

  tokensText(): string {
    let text = `${fmtTokens(this.input)} in`;
    if (this.cached) text += ` (${fmtTokens(this.cached)} cached)`;
    return text + ` / ${fmtTokens(this.output)} out`;
  }
}

// -- timestamps: datetime.fromisoformat (3.11+) and .timestamp() ------------------------

// Python runs the C implementation (Modules/_datetimemodule.c), which is
// what is ported here; it differs from the pure-Python one in _pydatetime.py
// in a few corners (one stray character before an offset, the first of + and
// - marks the offset). The parse works on UTF-8 bytes, as the C one does.

function isDigitAt(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c >= 0x30 && c <= 0x39;
}

/** parse_digits(p, n): exactly n ASCII digits at `pos`, or null. */
function digitsAt(s: string, pos: number, n: number): number | null {
  let value = 0;
  for (let i = 0; i < n; i++) {
    if (!isDigitAt(s, pos + i)) return null;
    value = value * 10 + (s.charCodeAt(pos + i) - 0x30);
  }
  return value;
}

function isLeap(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function daysInMonth(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

/** Days since 1970-01-01 of a proleptic Gregorian date. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): [number, number, number] {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

/** _find_isoformat_datetime_separator, on code points. */
function separatorAt(s: string[]): number {
  const n = s.length;
  const digit = (i: number) => s[i] !== undefined && s[i]! >= "0" && s[i]! <= "9";
  if (n === 7) return 7;
  if (s[4] === "-") {
    if (s[5] === "W") {
      if (n > 8 && s[8] === "-") {
        if (n === 9) return -1;
        if (n > 10 && digit(10)) return 8;
        return 10;
      }
      return 8;
    }
    return 10;
  }
  if (s[4] === "W") {
    let idx = 7;
    while (idx < n && digit(idx)) idx++;
    if (idx < 9) return idx;
    return idx % 2 === 0 ? 7 : 8;
  }
  return 8;
}

/** iso_to_ymd. */
function isoWeekDate(year: number, week: number, day: number): [number, number, number] | null {
  if (year < 1 || year > 9999) return null;
  const jan1 = daysFromCivil(year, 1, 1);
  const jan1Weekday = (((jan1 + 3) % 7) + 7) % 7; // Monday = 0
  if (!(week > 0 && week < 53)) {
    // A 53rd week when the year starts on a Thursday, or on a Wednesday in a leap year.
    if (!(week === 53 && (jan1Weekday === 3 || (jan1Weekday === 2 && isLeap(year))))) return null;
  }
  if (!(day > 0 && day < 8)) return null;
  let week1Monday = jan1 - jan1Weekday;
  if (jan1Weekday > 3) week1Monday += 7;
  return civilFromDays(week1Monday + (week - 1) * 7 + (day - 1));
}

/** parse_isoformat_date: reads from the start of the whole string, bounded by `len` only for the weekday. */
function parseDate(s: string, len: number): [number, number, number] | null {
  let p = 0;
  const year = digitsAt(s, p, 4);
  if (year === null) return null;
  p += 4;
  const sep = s[p] === "-";
  if (sep) p++;
  if (s[p] === "W") {
    p++;
    const week = digitsAt(s, p, 2);
    if (week === null) return null;
    p += 2;
    let day = 1;
    if (p < len) {
      if (sep && s[p++] !== "-") return null;
      const d = digitsAt(s, p, 1);
      if (d === null) return null;
      day = d;
    }
    return isoWeekDate(year, week, day);
  }
  const month = digitsAt(s, p, 2);
  if (month === null) return null;
  p += 2;
  if (sep && s[p++] !== "-") return null;
  const day = digitsAt(s, p, 2);
  if (day === null) return null;
  return [year, month, day];
}

/** parse_hh_mm_ss_ff: [h, m, s, µs, rv] with rv 1 when a character was left over, or null. */
function parseClock(s: string, start: number, end: number): [number, number, number, number, number] | null {
  const vals = [0, 0, 0];
  let p = start;
  let hasSep = true;
  for (let i = 0; i < 3; i++) {
    const v = digitsAt(s, p, 2);
    if (v === null) return null;
    vals[i] = v;
    p += 2;
    const c = s[p++] ?? "\0";
    if (i === 0) hasSep = c === ":";
    if (p >= end) return [vals[0]!, vals[1]!, vals[2]!, 0, c !== "\0" ? 1 : 0];
    else if (hasSep && c === ":") continue;
    else if (c === "." || c === ",") break;
    else if (!hasSep) p--;
    else return null;
  }
  const remains = end - p;
  const toParse = Math.min(remains, 6);
  let micro = 0;
  if (toParse > 0) {
    const v = digitsAt(s, p, toParse);
    if (v === null) return null;
    micro = v * 10 ** (6 - toParse);
  }
  p += toParse;
  while (isDigitAt(s, p)) p++;
  return [vals[0]!, vals[1]!, vals[2]!, micro, p < s.length ? 1 : 0];
}

interface IsoDateTime {
  ymd: [number, number, number];
  clock: [number, number, number, number];
  offset: number | null; // µs east of UTC; null for a naive time
}

const utf8Bytes = new TextEncoder();

function byteString(cps: string[]): string {
  return String.fromCharCode(...utf8Bytes.encode(cps.join("")));
}

/** datetime.fromisoformat, or null where Python raises ValueError. */
function fromisoformat(value: string): IsoDateTime | null {
  const cps = [...value];
  if (cps.length < 7) return null;
  const at = separatorAt(cps);
  if (at < 0) return null;
  const full = byteString(cps.slice(0, at)) + (cps.length > at ? "T" + byteString(cps.slice(at + 1)) : "");
  const dateLen = byteString(cps.slice(0, at)).length;
  const ymd = parseDate(full, dateLen);
  if (ymd === null) return null;
  let clock: [number, number, number, number] = [0, 0, 0, 0];
  let offset: number | null = null;
  if (full.length > dateLen) {
    const start = dateLen + 1;
    const end = full.length;
    let tz = start;
    while (tz < end && full[tz] !== "+" && full[tz] !== "-" && full[tz] !== "Z") tz++;
    const t = parseClock(full, start, tz);
    if (t === null) return null;
    clock = [t[0], t[1], t[2], t[3]];
    if (tz === end) {
      if (t[4] === 1) return null;
    } else if (full[tz] === "Z") {
      if (tz + 1 !== end) return null;
      offset = 0;
    } else {
      const z = parseClock(full, tz + 1, end);
      if (z === null || z[4] !== 0) return null;
      const micros = ((z[0] * 60 + z[1]) * 60 + z[2]) * 1_000_000 + z[3];
      if (micros >= 86_400_000_000) return null;
      offset = full[tz] === "-" ? -micros : micros;
    }
  }
  const [y, mo, d] = ymd;
  if (y < 1 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  if (clock[0] > 23 || clock[1] > 59 || clock[2] > 59) return null;
  return { ymd, clock, offset };
}

/** Wall-clock seconds since the epoch, as if the wall clock were UTC. */
function wallSeconds(ymd: [number, number, number], clock: [number, number, number, number]): number {
  return daysFromCivil(...ymd) * 86400 + clock[0] * 3600 + clock[1] * 60 + clock[2];
}

/** time.localtime(u) as wall seconds -- `local()` in datetime._mktime. */
function localWall(u: number): number {
  const d = new Date(u * 1000);
  return (
    daysFromCivil(d.getFullYear(), d.getMonth() + 1, d.getDate()) * 86400 +
    d.getHours() * 3600 +
    d.getMinutes() * 60 +
    d.getSeconds()
  );
}

/** datetime._mktime for fold=0: the earlier of two solutions, the later side of a gap. */
function mktime(t: number): number {
  const a = localWall(t) - t;
  const u1 = t - a;
  const t1 = localWall(u1);
  let b: number;
  if (t1 === t) {
    const u2 = u1 - 24 * 3600;
    b = localWall(u2) - u2;
    if (a === b) return u1;
  } else {
    b = t1 - u1;
  }
  const u2 = t - b;
  const t2 = localWall(u2);
  if (t2 === t) return u2;
  if (t1 === t) return u1;
  return Math.max(u1, u2);
}

/** datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp(). */
function isoTimestamp(value: string): number | null {
  const dt = fromisoformat(value.replace(/Z/g, "+00:00"));
  if (dt === null) return null;
  const wall = wallSeconds(dt.ymd, dt.clock);
  const micro = dt.clock[3];
  if (dt.offset === null) return mktime(wall) + micro / 1e6;
  const total = BigInt(wall) * 1_000_000n + BigInt(micro) - BigInt(dt.offset);
  return Number(total) / 1e6;
}

function parseTs(value: unknown): number | null {
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint" || value instanceof py.PyFloat) {
    const n = typeof value === "boolean" ? (value ? 1 : 0) : py.numberOf(value);
    return n > 1e11 ? n / 1000.0 : n;
  }
  if (typeof value !== "string" || value === "") return null;
  return isoTimestamp(value);
}

function span(records: unknown[]): number | null {
  const stamps: number[] = [];
  for (const r of records) {
    if (!py.isDict(r)) continue;
    const s = parseTs(py.dictGet(r, "timestamp"));
    if (s !== null) stamps.push(s);
  }
  if (stamps.length < 2) return null;
  return Math.max(...stamps) - Math.min(...stamps);
}

// -- reading the transcript ---------------------------------------------------------

// ignoreBOM: json.loads refuses a BOM, so the record has to reach it.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isAsciiSpace(b: number): boolean {
  return b === 0x20 || (b >= 0x09 && b <= 0x0d);
}

function parseLines(data: Uint8Array): unknown[] {
  const out: unknown[] = [];
  let start = 0;
  while (start <= data.length) {
    let end = data.indexOf(0x0a, start);
    if (end < 0) end = data.length;
    const line = data.subarray(start, end);
    start = end + 1;
    if (line.every(isAsciiSpace)) continue;
    try {
      out.push(py.loads(utf8.decode(line)));
    } catch {
      continue; // ValueError, UnicodeDecodeError included
    }
  }
  return out;
}

function readFrom(path: string, position: number, limit = Infinity): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(Math.max(size - position, 0), limit);
    const buffer = new Uint8Array(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buffer, got, length - got, position + got);
      if (n === 0) break;
      got += n;
    }
    return buffer.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/**
 * How much transcript readAhead() parses before it lets the event loop run.
 * An object so a test can shrink it, as with PEEK.
 */
export const READ_AHEAD = { bytes: 512 * 1024 };

/** A macrotask turn: what is waiting on the loop (stdin, a signal, a socket) runs first. */
const nextTask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Yields the complete JSON lines appended to a file since the previous call. */
export class Tail {
  offset = 0;
  /** Records parsed ahead from `start` (the offset then) to `end`, not yet handed out. */
  private ahead: { start: number; end: number; records: unknown[] } | null = null;
  constructor(readonly path: string) {}

  records(): unknown[] {
    const ahead = this.ahead;
    this.ahead = null;
    let data: Uint8Array;
    let before: unknown[] = [];
    try {
      const size = statSync(this.path).size;
      if (size < this.offset) this.offset = 0;
      // Appended to since the read-ahead is fine; rewritten shorter is not,
      // and then the plain read below sees what a read without it would.
      if (ahead !== null && ahead.start === this.offset && size >= ahead.end) {
        before = ahead.records;
        data = readFrom(this.path, ahead.end);
        this.offset = ahead.end;
      } else {
        data = readFrom(this.path, this.offset);
      }
    } catch {
      return []; // OSError
    }
    const end = data.lastIndexOf(0x0a);
    if (end < 0) return before;
    this.offset += end + 1;
    const after = parseLines(data.subarray(0, end));
    return before.length === 0 ? after : before.concat(after);
  }

  /**
   * Parse what records() would return now, READ_AHEAD.bytes at a time,
   * waiting a macrotask turn between chunks; records() hands it out later.
   *
   * Python reads a transcript on its dispatcher thread. Here the read shares
   * the loop that answers JSON-RPC, and a resumed session's whole transcript
   * (tens of MB) parsed in one go kept every tools/call waiting for seconds.
   * A chunk ends at a line end, so the lines are exactly records()'s; a
   * single line longer than a chunk is parsed whole.
   */
  async readAhead(pause: () => Promise<void> = nextTask): Promise<void> {
    let ahead = this.ahead !== null && this.ahead.start === this.offset ? this.ahead : null;
    if (ahead === null) ahead = { start: this.offset, end: this.offset, records: [] };
    this.ahead = ahead;
    for (;;) {
      let size: number;
      try {
        size = statSync(this.path).size;
      } catch {
        return; // records() meets the same OSError
      }
      if (size < ahead.end) {
        this.ahead = null; // rewritten shorter: records() starts over
        return;
      }
      let data: Uint8Array;
      let end = -1;
      let want = READ_AHEAD.bytes;
      try {
        for (;;) {
          data = readFrom(this.path, ahead.end, want);
          end = data.lastIndexOf(0x0a);
          if (end >= 0 || data.length < want) break;
          want *= 2; // no line end yet: one line longer than a chunk
        }
      } catch {
        return;
      }
      if (end < 0) return;
      for (const record of parseLines(data.subarray(0, end))) ahead.records.push(record);
      ahead.end += end + 1;
      await pause();
      if (this.ahead !== ahead) return; // records() took it meanwhile
    }
  }

  /**
   * The last PEEK.bytes worth of complete records, without moving the offset.
   *
   * The turn totals are read once, at Stop, by records(); anything that wants
   * to look at the transcript earlier -- the model, which the hook payload of
   * neither harness carries -- has to leave that read untouched.
   */
  peek(): unknown[] {
    let data: Uint8Array;
    let start: number;
    try {
      const fd = openSync(this.path, "r");
      try {
        start = Math.max(0, fstatSync(fd).size - PEEK.bytes);
      } finally {
        closeSync(fd);
      }
      data = readFrom(this.path, start);
    } catch {
      return [];
    }
    if (start) {
      // the first line is a fragment of the record we cut into
      const head = data.indexOf(0x0a);
      data = head >= 0 ? data.subarray(head + 1) : new Uint8Array(0);
    }
    const end = data.lastIndexOf(0x0a);
    return end >= 0 ? parseLines(data.subarray(0, end)) : [];
  }
}

/** usage's _int: int(value or 0), 0 for what int() refuses (OverflowError still raises). */
function toInt(value: unknown): number {
  try {
    return py.int(py.or(value, 0));
  } catch (e) {
    if (e instanceof py.PyValueError || e instanceof py.PyTypeError) return 0;
    throw e;
  }
}

/** `for x in value` over what JSON can hold: a str by character, a dict by key. */
function iterate(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [...value];
  if (py.isDict(value)) return py.dictEntries(value).map(([k]) => k);
  throw new py.PyTypeError("object is not iterable");
}

const get = (d: unknown, key: string): unknown => (py.isDict(d) ? py.dictGet(d, key) : undefined);

function claudeUsage(records: unknown[]): Usage {
  const usage = new Usage();
  const seen = new Set<unknown>();
  for (const rec of records) {
    if (!py.isDict(rec) || get(rec, "type") !== "assistant") continue;
    const msg = get(rec, "message");
    if (!py.isDict(msg)) continue;
    for (const block of iterate(py.or(get(msg, "content"), []))) {
      if (py.isDict(block) && get(block, "type") === "tool_use") usage.tools += 1;
    }
    const u = get(msg, "usage");
    if (!py.isDict(u)) continue;
    const key = py.or(py.or(get(rec, "requestId"), get(msg, "id")), get(rec, "uuid")) ?? null;
    if (seen.has(key)) continue;
    seen.add(key);
    const cached = toInt(get(u, "cache_read_input_tokens"));
    usage.input += toInt(get(u, "input_tokens")) + toInt(get(u, "cache_creation_input_tokens")) + cached;
    usage.cached += cached;
    usage.output += toInt(get(u, "output_tokens"));
    if (py.truthy(get(msg, "model"))) usage.model = get(msg, "model");
  }
  return usage;
}

export class ClaudeTranscript extends Tail {
  readNew(): Usage {
    return claudeUsage(this.records());
  }

  peekModel(): unknown {
    return claudeUsage(this.peek()).model;
  }

  /** `tail`: a ClaudeTranscript of `path` that already read ahead, at offset 0. */
  static readWhole(path: string, tail: Tail = new ClaudeTranscript(path)): Usage {
    const records = tail.records();
    const usage = claudeUsage(records);
    usage.duration = span(records);
    return usage;
  }
}

export function claudeSubagentPath(transcriptPath: string, sessionId: string, agentId: string): string {
  return py.pathJoin(py.dirname(transcriptPath), sessionId, "subagents", `agent-${agentId}.jsonl`);
}

const CODEX_TOOL_ITEMS = ["function_call", "custom_tool_call"];

/** Scan records once: token totals from the last matching token_usage_record under `key`, tool count, model. */
function codexScan(records: unknown[], turnId: unknown, key: string): Usage {
  const usage = new Usage();
  let last: unknown = null;
  for (const r of records) {
    if (!py.isDict(r)) continue;
    const p = get(r, "payload");
    if (!py.isDict(p)) continue;
    const kind = get(r, "type");
    if (kind === "token_usage_record") {
      if (turnId === null || turnId === undefined || get(p, "turn_id") === turnId) {
        const t = get(p, key);
        if (py.isDict(t)) last = t;
      }
    } else if (kind === "response_item" && CODEX_TOOL_ITEMS.includes(get(p, "type") as string)) {
      usage.tools += 1;
    } else if (kind === "turn_context" && py.truthy(get(p, "model"))) {
      usage.model = get(p, "model");
    }
  }
  if (py.truthy(last)) {
    usage.input = toInt(get(last, "input_tokens"));
    usage.cached = toInt(get(last, "cached_input_tokens"));
    usage.output = toInt(get(last, "output_tokens"));
  }
  return usage;
}

export class CodexTranscript extends Tail {
  peekModel(): unknown {
    return codexScan(this.peek(), null, "turn_token_usage").model;
  }

  /**
   * Usage of one turn from the records appended since the previous read.
   *
   * Call it once, at Stop time, before any other read on this transcript: the
   * offset moves past the turn's records, so a second call for the same turn
   * sees nothing and returns an empty Usage.
   */
  readTurn(turnId: unknown): Usage {
    return codexScan(this.records(), turnId, "turn_token_usage");
  }

  /** Whole-file totals (thread_token_usage) and duration, for a subagent transcript. */
  static readWhole(path: string, tail: Tail = new CodexTranscript(path)): Usage {
    const records = tail.records();
    const usage = codexScan(records, null, "thread_token_usage");
    usage.duration = span(records);
    return usage;
  }
}
