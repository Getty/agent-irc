// The parts of Python's semantics the formatter's output depends on.
//
// The modules ported from agent_irc/ promise the same output bytes for the
// same input, and a handful of builtins differ between the two languages in
// ways that reach IRC: what counts as whitespace or a line break, string
// length (code points, not UTF-16 units), round() and "%.1f" on an exact
// tie, str() of a value, json.loads/json.dumps (key order, 1.0 vs 1), and
// os.path. Each function here is the Python behaviour, named after it.

// -- errors -------------------------------------------------------------------

/** What Python raises as ValueError. */
export class PyValueError extends Error {
  override name = "ValueError";
}

/** What Python raises as TypeError. */
export class PyTypeError extends Error {
  override name = "TypeError";
}

/** What Python raises as OverflowError (int() of an infinite float). */
export class PyOverflowError extends Error {
  override name = "OverflowError";
}

// -- values -------------------------------------------------------------------

/**
 * A float whose value happens to be whole. JSON's `4.0` is a float to
 * Python and an int to JavaScript; the settings that take only an int, and
 * json.dumps, need to tell them apart. A float that is not whole is a plain
 * number: no int can be mistaken for it.
 */
export class PyFloat {
  constructor(readonly value: number) {}
}

/** A Python dict as the port sees one: a Map (order kept) or a plain object. */
export type PyDict = Map<string, unknown> | Record<string, unknown>;

export function isDict(x: unknown): x is PyDict {
  if (x instanceof Map) return true;
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

export function dictHas(d: PyDict, key: string): boolean {
  return d instanceof Map ? d.has(key) : Object.prototype.hasOwnProperty.call(d, key);
}

/** dict.get(key): undefined stands for a missing key, null for None. */
export function dictGet(d: PyDict, key: string): unknown {
  if (d instanceof Map) return d.get(key);
  return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
}

export function dictEntries(d: PyDict): [string, unknown][] {
  return d instanceof Map ? [...d.entries()] : Object.entries(d);
}

export function dictSize(d: PyDict): number {
  return d instanceof Map ? d.size : Object.keys(d).length;
}

/** isinstance(x, int), bool excluded (every caller excludes it). */
export function isInt(x: unknown): x is number | bigint {
  return typeof x === "bigint" || (typeof x === "number" && Number.isInteger(x));
}

/** isinstance(x, float). */
export function isFloat(x: unknown): boolean {
  return x instanceof PyFloat || (typeof x === "number" && !Number.isInteger(x));
}

/** The number a float or int stands for. */
export function numberOf(x: unknown): number {
  if (x instanceof PyFloat) return x.value;
  if (typeof x === "bigint") return Number(x);
  return x as number;
}

/** Python truthiness. */
export function truthy(x: unknown): boolean {
  if (x === undefined || x === null || x === false) return false;
  if (typeof x === "number") return x !== 0; // NaN is true, as in Python
  if (typeof x === "bigint") return x !== 0n;
  if (typeof x === "string") return x.length > 0;
  if (x instanceof PyFloat) return x.value !== 0;
  if (Array.isArray(x)) return x.length > 0;
  if (x instanceof Map) return x.size > 0;
  if (isDict(x)) return Object.keys(x).length > 0;
  return true;
}

/** `a or b`. */
export function or(a: unknown, b: unknown): unknown {
  return truthy(a) ? a : b;
}

// -- strings ------------------------------------------------------------------

// str.isspace(): JavaScript's \s lacks \x1c-\x1f and \x85, and has U+FEFF.
const WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_RUN = new RegExp(`[${WS}]+`, "u");
const WS_LEAD = new RegExp(`^[${WS}]+`, "u");
const WS_TRAIL = new RegExp(`[${WS}]+$`, "u");
// str.splitlines() line boundaries.
const LINE_BREAK = new RegExp("\\r\\n|[\\n\\r\\x0b\\x0c\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]", "u");

/** str.split() with no argument. */
export function split(s: string): string[] {
  return s.split(WS_RUN).filter((part) => part !== "");
}

/** str.strip(), or str.strip(chars). */
export function strip(s: string, chars?: string): string {
  return rstrip(lstrip(s, chars), chars);
}

export function lstrip(s: string, chars?: string): string {
  if (chars === undefined) return s.replace(WS_LEAD, "");
  const cps = [...s];
  let i = 0;
  while (i < cps.length && chars.includes(cps[i]!)) i++;
  return cps.slice(i).join("");
}

export function rstrip(s: string, chars?: string): string {
  if (chars === undefined) return s.replace(WS_TRAIL, "");
  const cps = [...s];
  let j = cps.length;
  while (j > 0 && chars.includes(cps[j - 1]!)) j--;
  return cps.slice(0, j).join("");
}

/** str.splitlines(): no empty last element for a trailing break. */
export function splitlines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split(LINE_BREAK);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** len(s): code points. */
export function len(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** s[start:end] by code points, non-negative bounds. */
export function slice(s: string, start: number, end?: number): string {
  return [...s].slice(start, end).join("");
}

/** str.expandtabs(tabsize): the column restarts after \n and \r. */
export function expandtabs(s: string, tabsize = 8): string {
  let out = "";
  let column = 0;
  for (const ch of s) {
    if (ch === "\t") {
      if (tabsize > 0) {
        const pad = tabsize - (column % tabsize);
        out += " ".repeat(pad);
        column += pad;
      }
    } else {
      out += ch;
      column = ch === "\n" || ch === "\r" ? 0 : column + 1;
    }
  }
  return out;
}

/** str.lower(): full case mapping, final sigma included, like toLowerCase. */
export function lower(s: string): string {
  return s.toLowerCase();
}

/** str.upper(). */
export function upper(s: string): string {
  return s.toUpperCase();
}

/** sep.join(parts), with Python's refusal of anything that is not a str. */
export function join(sep: string, parts: unknown[]): string {
  for (const part of parts) {
    if (typeof part !== "string") throw new PyTypeError(`sequence item: expected str instance, ${typeName(part)} found`);
  }
  return parts.join(sep);
}

function typeName(x: unknown): string {
  if (x === null || x === undefined) return "NoneType";
  if (typeof x === "boolean") return "bool";
  if (isInt(x)) return "int";
  if (isFloat(x)) return "float";
  if (Array.isArray(x)) return "list";
  if (isDict(x)) return "dict";
  return typeof x;
}

// -- numbers ------------------------------------------------------------------

/** round(x) to an int: half to even, on the exact binary value. */
export function round(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * "%.1f" % x. Number.prototype.toFixed breaks an exact tie upwards, Python
 * to even; a tie at one decimal is a value whose quadruple is an odd integer.
 */
export function fixed1(x: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const q = x * 4;
  if (Number.isInteger(q) && q % 2 !== 0) {
    const tenths = round(x * 10); // x * 10 is exact here: a multiple of 2.5
    const sign = tenths < 0 || Object.is(tenths, -0) ? "-" : "";
    const abs = Math.abs(tenths);
    return `${sign}${Math.floor(abs / 10)}.${abs % 10}`;
  }
  return Object.is(x, -0) ? "-0.0" : x.toFixed(1);
}

/** "%02d" % n for a non-negative int. */
export function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** float.__repr__. */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  const [mantissa, exponent] = Math.abs(x).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const e = Number(exponent);
  if (e < -4 || e >= 16) {
    const head = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const abs = Math.abs(e);
    return `${sign}${head}e${e < 0 ? "-" : "+"}${abs < 10 ? "0" + abs : abs}`;
  }
  const point = e + 1; // digits before the decimal point
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function intRepr(x: number | bigint): string {
  return typeof x === "bigint" ? x.toString() : BigInt(x).toString();
}

// Python's int() and float() take any Unicode decimal digit, not only 0-9.
const DIGIT = /\p{Nd}/u;

/** The value of one Unicode decimal digit (Nd runs are contiguous 0..9). */
function digitValue(ch: string): number {
  let cp = ch.codePointAt(0)!;
  let start = cp;
  while (start > 0 && DIGIT.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

/** Unicode decimal digits as ASCII ones. */
export function asciiDigits(s: string): string {
  let out = "";
  for (const ch of s) out += ch >= "0" && ch <= "9" ? ch : DIGIT.test(ch) ? String(digitValue(ch)) : ch;
  return out;
}

const INT_TEXT = /^[+-]?\p{Nd}(?:_?\p{Nd})*$/u;

/** int(x): what usage's _int and fmt_tokens put a value through. */
export function int(x: unknown): number {
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "bigint") return Number(x);
  if (x instanceof PyFloat) return Math.trunc(x.value) || 0;
  if (typeof x === "number") {
    if (Number.isNaN(x)) throw new PyValueError("cannot convert float NaN to integer");
    if (!Number.isFinite(x)) throw new PyOverflowError("cannot convert float infinity to integer");
    return Math.trunc(x) || 0;
  }
  if (typeof x === "string") {
    const text = strip(x);
    if (!INT_TEXT.test(text)) throw new PyValueError(`invalid literal for int() with base 10: ${repr(x)}`);
    return Number(asciiDigits(text).replace(/_/g, "")) || 0;
  }
  throw new PyTypeError(`int() argument must be a string, a bytes-like object or a real number, not '${typeName(x)}'`);
}

const FLOAT_TEXT = /^[+-]?(?:(?:\p{Nd}(?:_?\p{Nd})*)?(?:\.(?:\p{Nd}(?:_?\p{Nd})*)?)?(?:[eE][+-]?\p{Nd}(?:_?\p{Nd})*)?)$/u;
const FLOAT_WORD = /^([+-]?)(inf|infinity|nan)$/i;

/** float(x). */
export function float(x: unknown): number {
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "number") return x;
  if (typeof x === "bigint") return Number(x);
  if (x instanceof PyFloat) return x.value;
  if (typeof x === "string") {
    const text = strip(x);
    const word = FLOAT_WORD.exec(text);
    if (word) return word[2]!.toLowerCase() === "nan" ? NaN : word[1] === "-" ? -Infinity : Infinity;
    if (text !== "" && FLOAT_TEXT.test(text) && /\p{Nd}/u.test(text.replace(/[eE].*$/, ""))) {
      return Number(asciiDigits(text).replace(/_/g, ""));
    }
    throw new PyValueError(`could not convert string to float: ${repr(x)}`);
  }
  throw new PyTypeError(`float() argument must be a string or a real number, not '${typeName(x)}'`);
}

// -- str() and repr() ------------------------------------------------------------

const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function hex(cp: number, width: number): string {
  return cp.toString(16).padStart(width, "0");
}

function strRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + hex(cp, 2);
    else if (cp < 0x7f) out += ch;
    else if (ch !== " " && NOT_PRINTABLE.test(ch)) {
      out += cp <= 0xff ? "\\x" + hex(cp, 2) : cp <= 0xffff ? "\\u" + hex(cp, 4) : "\\U" + hex(cp, 8);
    } else out += ch;
  }
  return out + quote;
}

/** repr(x) for the values JSON can produce. */
export function repr(x: unknown): string {
  if (x === null || x === undefined) return "None";
  if (x === true) return "True";
  if (x === false) return "False";
  if (typeof x === "string") return strRepr(x);
  if (typeof x === "bigint") return x.toString();
  if (x instanceof PyFloat) return floatRepr(x.value);
  if (typeof x === "number") return Number.isInteger(x) ? intRepr(x) : floatRepr(x);
  if (Array.isArray(x)) return "[" + x.map(repr).join(", ") + "]";
  if (isDict(x)) return "{" + dictEntries(x).map(([k, v]) => `${strRepr(k)}: ${repr(v)}`).join(", ") + "}";
  return String(x);
}

/** str(x). */
export function str(x: unknown): string {
  return typeof x === "string" ? x : repr(x);
}

// -- json -------------------------------------------------------------------------

export interface LoadsOptions {
  /** Objects as Map, which keeps every key's position; plain objects otherwise. */
  ordered?: boolean;
}

/**
 * json.loads. Beyond JSON.parse: NaN, Infinity and -Infinity are accepted,
 * a whole-valued float comes back as PyFloat, an int too large for a double
 * as a bigint, and with `ordered` an object's keys keep their order even when
 * they look like array indices.
 */
export function loads(text: string, options: LoadsOptions = {}): unknown {
  const parser = new JsonParser(text, options.ordered === true);
  parser.skip();
  const value = parser.value();
  parser.skip();
  if (parser.pos < text.length) parser.fail("Extra data");
  return value;
}

class JsonParser {
  pos = 0;
  constructor(
    readonly text: string,
    readonly ordered: boolean,
  ) {}

  fail(what: string): never {
    throw new PyValueError(`${what}: char ${this.pos}`);
  }

  skip(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t[this.pos];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.pos++;
      else break;
    }
  }

  value(): unknown {
    const t = this.text;
    const c = t[this.pos];
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"') return this.string();
    if (t.startsWith("null", this.pos)) return (this.pos += 4), null;
    if (t.startsWith("true", this.pos)) return (this.pos += 4), true;
    if (t.startsWith("false", this.pos)) return (this.pos += 5), false;
    if (t.startsWith("NaN", this.pos)) return (this.pos += 3), NaN;
    if (t.startsWith("Infinity", this.pos)) return (this.pos += 8), Infinity;
    if (t.startsWith("-Infinity", this.pos)) return (this.pos += 9), -Infinity;
    return this.number();
  }

  number(): unknown {
    const m = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
    m.lastIndex = this.pos;
    const found = m.exec(this.text);
    if (!found) this.fail("Expecting value");
    this.pos += found[0].length;
    if (found[1] !== undefined || found[2] !== undefined) {
      const v = Number(found[0]);
      return Number.isInteger(v) ? new PyFloat(v) : v;
    }
    const n = Number(found[0]);
    if (Number.isSafeInteger(n)) return n === 0 ? 0 : n;
    return BigInt(found[0]);
  }

  string(): string {
    const t = this.text;
    let out = "";
    this.pos++; // the opening quote
    for (;;) {
      if (this.pos >= t.length) this.fail("Unterminated string starting at");
      const c = t[this.pos]!;
      if (c === '"') {
        this.pos++;
        return out;
      }
      if (c < " ") this.fail("Invalid control character at");
      if (c !== "\\") {
        out += c;
        this.pos++;
        continue;
      }
      const e = t[this.pos + 1];
      const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (e !== undefined && e in simple) {
        out += simple[e];
        this.pos += 2;
      } else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(t.slice(this.pos + 2, this.pos + 6))) {
        out += String.fromCharCode(parseInt(t.slice(this.pos + 2, this.pos + 6), 16));
        this.pos += 6;
      } else {
        this.fail("Invalid \\escape");
      }
    }
  }

  array(): unknown[] {
    const out: unknown[] = [];
    this.pos++;
    this.skip();
    if (this.text[this.pos] === "]") return this.pos++, out;
    for (;;) {
      this.skip();
      out.push(this.value());
      this.skip();
      const c = this.text[this.pos];
      if (c === "]") return this.pos++, out;
      if (c !== ",") this.fail("Expecting ',' delimiter");
      this.pos++;
    }
  }

  object(): PyDict {
    const map = new Map<string, unknown>();
    this.pos++;
    this.skip();
    if (this.text[this.pos] === "}") return this.pos++, this.finish(map);
    for (;;) {
      this.skip();
      if (this.text[this.pos] !== '"') this.fail("Expecting property name enclosed in double quotes");
      const key = this.string();
      this.skip();
      if (this.text[this.pos] !== ":") this.fail("Expecting ':' delimiter");
      this.pos++;
      this.skip();
      map.set(key, this.value());
      this.skip();
      const c = this.text[this.pos];
      if (c === "}") return this.pos++, this.finish(map);
      if (c !== ",") this.fail("Expecting ',' delimiter");
      this.pos++;
    }
  }

  finish(map: Map<string, unknown>): PyDict {
    if (this.ordered) return map;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of map) Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
    return obj;
  }
}

function jsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const code = c.charCodeAt(0);
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (c === "\b") out += "\\b";
    else if (c === "\f") out += "\\f";
    else if (code < 0x20) out += "\\u" + hex(code, 4);
    else out += c; // ensure_ascii=False: everything else as it is, lone surrogates too
  }
  return out + '"';
}

function jsonFloat(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  return floatRepr(x);
}

/** json.dumps(x, ensure_ascii=False). */
export function dumps(x: unknown): string {
  if (x === null || x === undefined) return "null";
  if (x === true) return "true";
  if (x === false) return "false";
  if (typeof x === "string") return jsonString(x);
  if (typeof x === "bigint") return x.toString();
  if (x instanceof PyFloat) return jsonFloat(x.value);
  if (typeof x === "number") return Number.isInteger(x) ? intRepr(x) : jsonFloat(x);
  if (Array.isArray(x)) return "[" + x.map(dumps).join(", ") + "]";
  if (isDict(x)) return "{" + dictEntries(x).map(([k, v]) => `${jsonString(k)}: ${dumps(v)}`).join(", ") + "}";
  throw new PyTypeError(`Object of type ${typeName(x)} is not JSON serializable`);
}

// -- os.path (posixpath) ------------------------------------------------------------

export function isabs(p: string): boolean {
  return p.startsWith("/");
}

export function pathJoin(a: string, ...rest: string[]): string {
  let path = a;
  for (const b of rest) {
    if (b.startsWith("/")) path = b;
    else if (path === "" || path.endsWith("/")) path += b;
    else path += "/" + b;
  }
  return path;
}

export function normpath(path: string): string {
  if (path === "") return ".";
  let initial = path.startsWith("/") ? 1 : 0;
  if (initial && path.startsWith("//") && !path.startsWith("///")) initial = 2;
  const comps: string[] = [];
  for (const comp of path.split("/")) {
    if (comp === "" || comp === ".") continue;
    if (comp !== ".." || (!initial && comps.length === 0) || (comps.length > 0 && comps[comps.length - 1] === "..")) {
      comps.push(comp);
    } else if (comps.length > 0) {
      comps.pop();
    }
  }
  const out = "/".repeat(initial) + comps.join("/");
  return out || ".";
}

export function abspath(path: string): string {
  return normpath(isabs(path) ? path : pathJoin(process.cwd(), path));
}

export function relpath(path: string, start: string): string {
  if (path === "") throw new PyValueError("no path specified");
  const startList = abspath(start).split("/").filter((x) => x !== "");
  const pathList = abspath(path).split("/").filter((x) => x !== "");
  let i = 0;
  while (i < startList.length && i < pathList.length && startList[i] === pathList[i]) i++;
  const rel = [...Array<string>(startList.length - i).fill(".."), ...pathList.slice(i)];
  return rel.length === 0 ? "." : pathJoin(rel[0]!, ...rel.slice(1));
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/") + 1;
  let head = p.slice(0, i);
  if (head !== "" && head !== "/".repeat(head.length)) head = head.replace(/\/+$/, "");
  return head;
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}
