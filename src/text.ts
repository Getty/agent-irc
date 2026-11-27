// Pure string helpers shared by formatting and IRC code (port of agent_irc/text.py).
import * as py from "./py.js";

export const ELLIPSIS = "…";

const encoder = new TextEncoder();
// ignoreBOM: a leading U+FEFF is a character to Python; TextDecoder would drop it.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function utf8Length(s: string): number {
  return encoder.encode(s).length;
}

export function firstLine(s: unknown): string {
  if (!py.truthy(s)) return "";
  for (const line of py.splitlines(py.str(s))) {
    if (py.strip(line) !== "") return py.strip(line);
  }
  return "";
}

/** Lines with something on them -- what a reader would count. */
export function lineCount(s: unknown): number {
  return py.splitlines(py.str(py.or(s, ""))).filter((line) => py.strip(line) !== "").length;
}

export function truncate(s: unknown, limit: number): string {
  const folded = py.split(py.str(py.or(s, ""))).join(" ");
  if (py.len(folded) <= limit) return folded;
  return py.rstrip(py.slice(folded, 0, Math.max(limit - 1, 0))) + ELLIPSIS;
}

/** The longest prefix of `s` that fits `maxBytes` of UTF-8 without splitting a character. */
export function cutBytes(s: string, maxBytes: number): string {
  const data = encoder.encode(s);
  if (data.length <= maxBytes) return s;
  // data[:max_bytes] -- a negative bound counts from the end, as in Python.
  let end = maxBytes < 0 ? Math.max(data.length + maxBytes, 0) : maxBytes;
  // decode(errors="ignore") on a cut that only the tail can have broken.
  while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(data.subarray(0, end));
}

function splitLongWord(word: string, maxBytes: number): string[] {
  const out: string[] = [];
  while (word !== "") {
    const head = cutBytes(word, maxBytes);
    if (head === "") break;
    out.push(head);
    word = word.slice(head.length);
  }
  return out;
}

export function splitMessage(text: unknown, maxBytes = 400): string[] {
  const lines: string[] = [];
  for (const paragraph of py.str(py.or(text, "")).split("\n")) {
    const words = py.split(paragraph);
    if (words.length === 0) continue;
    let current = "";
    for (const word of words) {
      if (utf8Length(word) > maxBytes) {
        if (current) {
          lines.push(current);
          current = "";
        }
        lines.push(...splitLongWord(word, maxBytes));
        continue;
      }
      const candidate = current ? current + " " + word : word;
      if (utf8Length(candidate) <= maxBytes) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/**
 * Text whose line breaks and indentation mean something -- a command, not
 * prose -- as one output line per source line. Blank lines go, tabs become
 * spaces (the sender strips control characters, and a Makefile recipe without
 * its tab is a lie); fitting the line to the server is the sender's job.
 */
export function splitBlock(text: unknown): string[] {
  const out: string[] = [];
  for (const raw of py.str(py.or(text, "")).split("\n")) {
    const line = py.rstrip(py.expandtabs(raw, 4));
    if (py.strip(line) !== "") out.push(line);
  }
  return out;
}

/**
 * One logical line as the payload chunks one server will relay intact.
 *
 * A continuation keeps the line's leading indent, so a wrapped body line
 * still reads as a body line rather than as a new event.
 */
export function wrapPayload(text: unknown, maxBytes: number): string[] {
  const line = py.rstrip(py.str(py.or(text, "")));
  if (py.strip(line) === "") return [];
  if (utf8Length(line) <= maxBytes) return [line];
  const indent = line.slice(0, line.length - py.lstrip(line, " ").length);
  const room = Math.max(maxBytes - utf8Length(indent), 1);
  return splitMessage(py.strip(line), room).map((part) => indent + part);
}

export function shortPath(path: unknown, cwd: unknown, home: unknown): string {
  const p = py.str(py.or(path, ""));
  if (py.truthy(cwd)) {
    // Python calls cwd.rstrip(), which only a str has.
    if (typeof cwd !== "string") throw new py.PyTypeError("short_path: cwd is not a str");
    if (p === cwd || p.startsWith(py.rstrip(cwd, "/") + "/")) return py.relpath(p, cwd);
  }
  if (py.truthy(home)) {
    if (typeof home !== "string") throw new py.PyTypeError("short_path: home is not a str");
    const h = py.rstrip(home, "/");
    if (p === h) return "~";
    if (p.startsWith(h + "/")) return "~" + p.slice(h.length);
  }
  return p;
}

export function fmtDuration(seconds: unknown): string {
  const s = Math.max(py.float(py.or(seconds, 0)), 0.0);
  if (s < 9.95) return py.fixed1(s) + "s";
  const total = py.round(s);
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m${py.pad2(total % 60)}s`;
  const hours = Math.floor(total / 3600);
  const rest = total % 3600;
  return `${hours}h${py.pad2(Math.floor(rest / 60))}m`;
}

export function fmtTokens(n: unknown): string {
  const count = py.int(py.or(n, 0));
  if (count < 1000) return String(count);
  const thousands = py.round(count / 1000.0);
  if (thousands < 1000) return `${thousands}k`;
  let text = py.fixed1(count / 1000000.0);
  if (text.endsWith(".0")) text = text.slice(0, -2);
  return text + "M";
}

export function nickBase(cwd: unknown): string {
  let base = py.lower(py.basename(py.rstrip(py.str(py.or(cwd, "")), "/")));
  base = py.strip(base.replace(/[^a-z0-9-]+/g, "-"), "-");
  base = base.replace(/-{2,}/g, "-");
  if (!base) return "agent";
  if (base[0]! >= "0" && base[0]! <= "9") base = "p-" + base;
  return base;
}
