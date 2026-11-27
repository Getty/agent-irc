// Turn hook events into IRC lines (spec §8; port of agent_irc/events.py).
import * as py from "./py.js";
import { firstLine, fmtDuration, lineCount, shortPath, splitBlock, truncate } from "./text.js";
import { ClaudeTranscript, CodexTranscript, Usage, claudeSubagentPath } from "./usage.js";

export const G = {
  start: "▶",
  end: "■",
  prompt: "»",
  tool: "⚙",
  fail: "✖",
  sub_start: "⇢",
  sub_stop: "⇠",
  turn: "✔",
  perm: "⚠",
  idle: "…",
  compact: "⟲",
  model: "⇄",
  notify: "↩",
} as const;

export const IDLE_RULE = "====";
export const SUMMARY_LIMIT = 120;
export const PROMPT_LIMIT = 200;
export const AGENT_DESCRIPTIONS = 64; // Agent calls whose description is still waiting for a SubagentStart

// Python's $ also matches before one trailing newline.
const PLACEHOLDER_RE = /^\$\{[^}]*\}\n?$/;
const SHELL_TOOLS = new Set(["bash", "shell", "shell_command", "exec_command", "local_shell", "unified_exec"]);
const FILE_TOOLS = new Set(["read", "edit", "write", "multiedit", "notebookedit", "read_file", "write_file", "edit_file"]);
// re.MULTILINE: a line starts after \n and ends before \n, nothing else (a
// JavaScript /m would also break at \r, U+2028 and U+2029).
const PATCH_FILE_RE = /(?<=^|\n)\*\*\* (?:Update|Add|Delete) File: ([^\n]+)(?=\n|$)/g;

/** A cleaned event: the fields that carry something, in their order. */
export type Event = Map<string, unknown>;

/** ev.get(key): null for a missing field, as Python's None. */
function get(ev: Event, key: string): unknown {
  return ev.get(key) ?? null;
}

function field(d: py.PyDict, key: string): unknown {
  return py.dictGet(d, key) ?? null;
}

export function clean(ev: unknown): Event {
  const out: Event = new Map();
  if (!py.isDict(ev)) return out;
  for (const [key, value] of py.dictEntries(ev)) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "string" && PLACEHOLDER_RE.test(value)) continue;
    out.set(key, value);
  }
  const toolInput = out.get("tool_input");
  if (typeof toolInput === "string" && (toolInput.startsWith("{") || toolInput.startsWith("["))) {
    try {
      out.set("tool_input", py.loads(toolInput, { ordered: true }));
    } catch (e) {
      if (!(e instanceof py.PyValueError)) throw e;
    }
  }
  return out;
}

export function displayToolName(name: unknown): string {
  const s = py.str(py.or(name, ""));
  if (s.startsWith("mcp__")) return s.slice(s.lastIndexOf("__") + 2);
  return s;
}

function firstString(d: py.PyDict): string {
  for (const [, value] of py.dictEntries(d)) {
    if (typeof value === "string" && py.strip(value) !== "") return value;
  }
  return "";
}

function command(d: py.PyDict, raw: string): string {
  let cmd = py.dictHas(d, "command") ? field(d, "command") : py.dictHas(d, "cmd") ? field(d, "cmd") : raw;
  if (Array.isArray(cmd)) cmd = cmd.map((c) => py.str(c)).join(" ");
  return py.str(py.or(cmd, ""));
}

/** `[+3 lines]` for what the folded summary cannot show as lines. */
function extraLines(text: string): string {
  const extra = lineCount(text) - 1;
  if (extra < 1) return "";
  return ` [+${extra} line${extra === 1 ? "" : "s"}]`;
}

/**
 * The head line for one value.
 *
 * Below `full` there is no body under the head, so the whole value has to be
 * squeezed into it: truncate() folds newlines into spaces, and a multi-line
 * command reaches IRC whole-but-shortened rather than ending at its first
 * line -- `python3 -c "` says nothing about what was run. At `full` (limit
 * null) the body carries every line, so the head takes the first line whole
 * instead of repeating an 800-line file folded into one.
 */
function head(text: unknown, limit: number | null): string {
  if (limit === null) return firstLine(text);
  return truncate(text, limit);
}

/** One line for a tool call; `limit = null` shortens nothing (level full). */
export function toolSummary(
  toolName: unknown,
  toolInput: unknown,
  cwd: unknown,
  home: unknown,
  limit: number | null = SUMMARY_LIMIT,
): string {
  const lname = py.lower(py.str(py.or(toolName, "")));
  const d: py.PyDict = py.isDict(toolInput) ? toolInput : {};
  const raw = typeof toolInput === "string" ? toolInput : "";
  const get = (key: string) => field(d, key);
  if (SHELL_TOOLS.has(lname)) return head(command(d, raw), limit) + extraLines(command(d, raw));
  if (FILE_TOOLS.has(lname)) {
    const path = py.or(py.or(py.or(get("file_path"), get("path")), get("notebook_path")), raw);
    return head(shortPath(path, cwd, home), limit);
  }
  if (lname === "grep" || lname === "glob") {
    let text = py.str(py.or(get("pattern"), raw));
    if (py.truthy(get("path"))) text += " " + shortPath(get("path"), cwd, home);
    return head(text, limit);
  }
  if (lname === "agent" || lname === "task") {
    const kind = py.or(get("subagent_type"), "agent");
    const what = py.or(py.or(get("description"), get("prompt")), "");
    return head(py.truthy(what) ? `${py.str(kind)}: ${py.str(what)}` : kind, limit);
  }
  if (lname === "webfetch" || lname === "websearch") return head(py.or(py.or(get("url"), get("query")), raw), limit);
  if (lname === "skill") return head(py.or(get("skill"), raw), limit);
  if (lname === "apply_patch") {
    const patch = py.or(py.or(get("patch"), get("input")), raw);
    const files = [...py.str(patch).matchAll(PATCH_FILE_RE)].map((m) => m[1]!);
    return head(files.map((f) => shortPath(py.strip(f), cwd, home)).join(", "), limit);
  }
  return head(py.or(firstString(d), raw), limit);
}

/**
 * A whole tool input as body lines, for level full.
 *
 * A string keeps its own line breaks; anything else is JSON on one line.
 * Nothing here guesses a width: the connection is the only thing that knows
 * its server's, and it splits whatever does not fit.
 */
export function renderInput(value: unknown, indent = "  "): string[] {
  if (!py.isDict(value)) return splitBlock(value).map((line) => indent + line);
  const out: string[] = [];
  for (const [key, f] of py.dictEntries(value)) {
    const text = typeof f === "string" ? f : py.dumps(f);
    const block = splitBlock(text);
    if (block.length === 1) out.push(`${indent}${key}: ${block[0]}`);
    else if (block.length > 0) {
      out.push(`${indent}${key}:`);
      out.push(...block.map((line) => indent + "  " + line));
    }
  }
  return out;
}

const NOTIFY_RE = /<task-notification>([\s\S]*)<\/task-notification>/;
const QUOTED_RE = /"([^"]+)"/;

export interface NotificationFields {
  status: string;
  summary: string;
  result: string;
}

/**
 * Fields of a harness-injected <task-notification>, or null for a plain prompt.
 *
 * Claude Code wakes an agent whose background child stopped by injecting a
 * <task-notification> block as the prompt. Raw, that block reaches IRC as a
 * dozen tag lines; here it becomes a status, a summary and (when the child
 * reported one) a result to fold into a single readable line.
 */
export function parseTaskNotification(text: unknown): NotificationFields | null {
  const m = NOTIFY_RE.exec(py.str(py.or(text, "")));
  if (!m) return null;
  const body = m[1]!;
  const tag = (name: string): string => {
    const fm = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
    return fm ? py.strip(fm[1]!) : "";
  };
  return { status: tag("status"), summary: tag("summary"), result: tag("result") };
}

/**
 * A parsed task-notification as lines: a head naming the agent and status,
 * and at full the result -- or, when a stopped child left no result, the
 * summary that explains why.
 */
export function renderNotification(fields: NotificationFields, level: string, limit: number | null): string[] {
  const status = fields.status || "notification";
  const summary = fields.summary || "";
  const result = fields.result || "";
  const m = QUOTED_RE.exec(summary);
  const name = m ? m[1]! : "";
  let line: string;
  if (name) {
    const shown = limit !== null ? truncate(name, limit) : name;
    line = `${G.notify} agent "${shown}" ${status}`;
  } else {
    line = `${G.notify} ${status}`;
    const headline = firstLine(summary);
    if (headline) line += ": " + head(headline, limit);
  }
  const lines = [line];
  if (level === "full") {
    let body = result;
    if (!body && !summary.startsWith('Agent "')) body = summary;
    lines.push(...splitBlock(body).map((l) => "  " + l));
  }
  return lines;
}

function snake(name: unknown): string {
  return py.lower(py.str(py.or(name, "")).replace(/(?<!^)(?=[A-Z])/g, "_"));
}

/** "%r" % e, near enough for a debug line. */
function errorRepr(e: unknown): string {
  if (e instanceof Error) return `${e.name}(${py.repr(e.message)})`;
  return py.repr(e);
}

interface Subagent {
  type: string;
  desc: string;
  started: number;
  tools: number;
}

type ToolStart = [number, string, string, unknown];
type Transcript = ClaudeTranscript | CodexTranscript;

export interface SessionOptions {
  clock?: () => number;
  debug?: ((line: string) => void) | null;
}

/** State for one harness session: turns, tools, subagents, totals. */
export class Session {
  readonly harness: string;
  readonly level: string;
  readonly summaryLimit: number | null;
  readonly promptLimit: number | null;
  cwd: unknown;
  readonly home: string;
  readonly clock: () => number;
  readonly debug: ((line: string) => void) | null;
  sessionId: string | null = null;
  model: unknown = null;
  modelAnnounced = false;
  started: number | null = null;
  turns = 0;
  turnStarted: number | null = null;
  turnTools = 0;
  total = new Usage();
  totalTools = 0;
  toolStarts = new Map<unknown, ToolStart>();
  /**
   * [tool_use_id, description] per Agent call, drained by SubagentStart.
   * Bounded because Codex never delivers SubagentStart at all, so there
   * nothing ever drains it.
   */
  agentDescriptions: [unknown, string][] = [];
  subagents = new Map<string, Subagent>();
  transcript: Transcript | null = null;
  ended = false;

  private readonly handlers: Record<string, (ev: Event) => string[]> = {
    user_prompt_submit: (ev) => this.onUserPromptSubmit(ev),
    stop: (ev) => this.onStop(ev),
    pre_tool_use: (ev) => this.onPreToolUse(ev),
    post_tool_use: (ev) => this.finishTool(ev, G.tool),
    post_tool_use_failure: (ev) => this.onPostToolUseFailure(ev),
    subagent_start: (ev) => this.onSubagentStart(ev),
    subagent_stop: (ev) => this.onSubagentStop(ev),
    stop_failure: (ev) => this.onStopFailure(ev),
    permission_request: (ev) => this.onPermissionRequest(ev),
    notification: (ev) => this.onNotification(ev),
    interrupt: () => this.onInterrupt(),
    post_compact: (ev) => [`${G.compact} compacted (${py.str(py.or(get(ev, "trigger"), "auto"))})`],
    post_model_switch: (ev) => this.onPostModelSwitch(ev),
    session_end: (ev) => this.onSessionEnd(ev),
  };

  constructor(harness: string, level: string, cwd: unknown, home: string, { clock, debug = null }: SessionOptions = {}) {
    this.harness = harness;
    this.level = level;
    // At full nothing is shortened: the head keeps its line whole and the
    // body under it carries the rest.
    this.summaryLimit = level === "full" ? null : SUMMARY_LIMIT;
    this.promptLimit = level === "full" ? null : PROMPT_LIMIT;
    this.cwd = cwd;
    this.home = home;
    this.clock = clock ?? (() => Date.now() / 1000);
    this.debug = debug;
  }

  // -- dispatch -----------------------------------------------------------

  handle(raw: unknown): string[] {
    const ev = clean(raw);
    const lines: string[] = [];
    if (this.sessionId === null && py.truthy(get(ev, "session_id"))) lines.push(...this.start(ev));
    const name = snake(get(ev, "event"));
    const handler = Object.prototype.hasOwnProperty.call(this.handlers, name) ? this.handlers[name] : undefined;
    if (handler !== undefined) lines.push(...handler(ev));
    lines.push(...this.modelLine());
    return lines;
  }

  /**
   * The model on its own line, once, when the session line went out without it.
   *
   * Claude Code's hook payloads carry no model at all and a fresh session's
   * transcript has no assistant record yet when the first UserPromptSubmit
   * fires, so the model is unknown at announce time. It shows up in the
   * transcript with the first assistant message, which is written before the
   * first tool call -- one line after the prompt, in practice.
   */
  private modelLine(): string[] {
    if (this.modelAnnounced || this.sessionId === null) return [];
    if (this.model === null) {
      // Only worth looking during the first turn: from the first Stop on,
      // the turn usage names the model anyway.
      if (this.transcript === null || this.turns > 1) return [];
      try {
        this.model = this.transcript.peekModel() ?? null;
      } catch (e) {
        if (this.debug) this.debug(`agent-irc: transcript peek failed: ${errorRepr(e)}`);
      }
      if (this.model === null) return [];
    }
    this.modelAnnounced = true;
    return [`${G.model} model ${py.str(this.model)}`];
  }

  private newTranscript(path: unknown): Transcript {
    if (this.harness === "codex") return new CodexTranscript(py.str(path));
    return new ClaudeTranscript(py.str(path));
  }

  private start(ev: Event): string[] {
    this.sessionId = py.str(get(ev, "session_id"));
    this.started = this.clock();
    if (py.truthy(get(ev, "cwd"))) this.cwd = get(ev, "cwd");
    if (py.truthy(get(ev, "transcript_path"))) {
      this.transcript = this.newTranscript(get(ev, "transcript_path"));
      try {
        const primed =
          this.transcript instanceof CodexTranscript ? this.transcript.readTurn(null) : this.transcript.readNew();
        if (py.truthy(primed.model)) this.model = primed.model;
      } catch (e) {
        if (this.debug) this.debug(`agent-irc: transcript read failed: ${errorRepr(e)}`);
      }
    }
    if (py.truthy(get(ev, "model"))) this.model = get(ev, "model");
    const who = py.join(" ", [this.harness, this.model].filter((x) => py.truthy(x)));
    this.modelAnnounced = py.truthy(this.model);
    return [[`${G.start} session ${py.slice(this.sessionId, 0, 8)}`, who, shortPath(this.cwd, "", this.home)].join(" · ")];
  }

  // -- prompt and turn ----------------------------------------------------

  private onUserPromptSubmit(ev: Event): string[] {
    this.turnStarted = this.clock();
    this.turnTools = 0;
    this.turns += 1;
    const prompt = py.str(py.or(get(ev, "prompt"), ""));
    const notification = parseTaskNotification(prompt);
    if (notification !== null) return renderNotification(notification, this.level, this.summaryLimit);
    const lines = [`${G.prompt} ${head(firstLine(prompt), this.promptLimit)}`];
    if (this.level === "full") {
      // The » head already is the first line; the body carries only what
      // follows it, so a one-line prompt is not sent again under itself.
      lines.push(...splitBlock(prompt).slice(1).map((line) => "  " + line));
    }
    return lines;
  }

  private turnUsage(ev: Event): Usage {
    if (this.transcript === null && py.truthy(get(ev, "transcript_path"))) {
      this.transcript = this.newTranscript(get(ev, "transcript_path"));
    }
    if (this.transcript === null) return new Usage();
    try {
      if (this.transcript instanceof CodexTranscript) return this.transcript.readTurn(get(ev, "turn_id"));
      return this.transcript.readNew();
    } catch (e) {
      if (this.debug) this.debug(`agent-irc: transcript read failed: ${errorRepr(e)}`);
      return new Usage();
    }
  }

  private onStop(ev: Event): string[] {
    const usage = this.turnUsage(ev);
    const parts: unknown[] = [`${G.turn} turn`];
    if (this.turnStarted !== null) parts.push(fmtDuration(this.clock() - this.turnStarted));
    parts.push(`${this.turnTools} tools`);
    if (usage.hasTokens()) {
      parts.push(usage.tokensText());
      this.total.add(new Usage({ input: usage.input, cached: usage.cached, output: usage.output }));
    }
    if (py.truthy(usage.model)) this.model = usage.model;
    else if (py.truthy(get(ev, "model"))) this.model = get(ev, "model");
    if (py.truthy(this.model)) {
      parts.push(this.model);
      this.modelAnnounced = true;
    }
    const lines = [py.join(" · ", parts)];
    if (this.level === "full" && py.truthy(get(ev, "last_assistant_message"))) {
      lines.push(...splitBlock(get(ev, "last_assistant_message")).map((line) => "  " + line));
    }
    this.turnStarted = null;
    return lines;
  }

  // -- tools --------------------------------------------------------------

  private onPreToolUse(ev: Event): string[] {
    const name = py.str(py.or(get(ev, "tool_name"), "tool"));
    const summary = toolSummary(name, get(ev, "tool_input"), this.cwd, this.home, this.summaryLimit);
    const toolUseId = get(ev, "tool_use_id");
    if (py.truthy(toolUseId)) this.toolStarts.set(toolUseId, [this.clock(), name, summary, get(ev, "agent_id")]);
    const lname = py.lower(name);
    if ((lname === "agent" || lname === "task") && !py.truthy(get(ev, "agent_id"))) {
      const input = get(ev, "tool_input");
      const toolInput: py.PyDict = py.isDict(input) ? input : {};
      this.agentDescriptions.push([toolUseId, py.str(py.or(field(toolInput, "description"), ""))]);
      if (this.agentDescriptions.length > AGENT_DESCRIPTIONS) this.agentDescriptions.shift();
    }
    return [];
  }

  private finishTool(ev: Event, glyph: string, suffix = ""): string[] {
    let name = py.str(py.or(get(ev, "tool_name"), "tool"));
    let agentId = get(ev, "agent_id");
    const key = get(ev, "tool_use_id");
    const started = this.toolStarts.get(key);
    this.toolStarts.delete(key);
    let duration: string | null = null;
    let summary: string;
    if (started !== undefined) {
      const [t0, startedName, startedSummary, startedAgent] = started;
      name = startedName;
      summary = startedSummary;
      agentId = py.or(agentId, startedAgent);
      duration = fmtDuration(this.clock() - t0);
    } else {
      summary = toolSummary(name, get(ev, "tool_input"), this.cwd, this.home, this.summaryLimit);
    }
    let prefix = "";
    if (py.truthy(agentId)) {
      const sub = typeof agentId === "string" ? this.subagents.get(agentId) : undefined;
      if (sub !== undefined) sub.tools += 1;
      if (this.level === "activity") return [];
      prefix = `[${py.slice(py.str(agentId), 0, 4)}] `;
    } else {
      this.turnTools += 1;
      this.totalTools += 1;
    }
    let line = `${glyph} ${prefix}${displayToolName(name)}`;
    if (duration) line += " " + duration;
    if (summary) line += ": " + summary;
    if (suffix) line += " — " + suffix;
    return [line, ...this.inputBody(ev)];
  }

  /**
   * At level full the whole tool input goes out under its head line.
   *
   * Every field, every line: a heredoc, the content of a Write, an Edit's
   * two strings, the prompt of a subagent, whatever an unknown MCP tool
   * carries. A body of one line is dropped -- the head line already is
   * that line, and saying it twice is not saying it fully.
   */
  private inputBody(ev: Event): string[] {
    if (this.level !== "full") return [];
    const lines = renderInput(get(ev, "tool_input"));
    return lines.length > 1 ? lines : [];
  }

  private onPostToolUseFailure(ev: Event): string[] {
    const error = head(py.or(firstLine(get(ev, "error_message")), "failed"), this.summaryLimit);
    this.forgetAgentDescription(get(ev, "tool_use_id"));
    return this.finishTool(ev, G.fail, error);
  }

  /**
   * A failed Agent call never reaches SubagentStart, so its description has
   * to leave the queue here. Left in, it would be handed to the next
   * subagent that does start, and to every one after that.
   */
  private forgetAgentDescription(toolUseId: unknown): void {
    if (!py.truthy(toolUseId)) return;
    const i = this.agentDescriptions.findIndex((entry) => entry[0] === toolUseId);
    if (i >= 0) this.agentDescriptions.splice(i, 1);
  }

  // -- subagents ----------------------------------------------------------

  private onSubagentStart(ev: Event): string[] {
    const agentId = py.str(py.or(get(ev, "agent_id"), "?"));
    const agentType = py.str(py.or(get(ev, "agent_type"), "agent"));
    const description = this.agentDescriptions.length > 0 ? this.agentDescriptions.shift()![1] : "";
    this.subagents.set(agentId, { type: agentType, desc: description, started: this.clock(), tools: 0 });
    let line = `${G.sub_start} subagent ${agentType}`;
    if (description) line += ": " + head(description, this.summaryLimit);
    return [line];
  }

  private subagentUsage(ev: Event): Usage {
    try {
      if (this.harness === "codex") {
        const path = get(ev, "agent_transcript_path");
        return py.truthy(path) ? CodexTranscript.readWhole(py.str(path)) : new Usage();
      }
      const main = this.transcript !== null ? this.transcript.path : get(ev, "transcript_path");
      if (py.truthy(main) && py.truthy(this.sessionId) && py.truthy(get(ev, "agent_id"))) {
        return ClaudeTranscript.readWhole(
          claudeSubagentPath(py.str(main), this.sessionId!, py.str(get(ev, "agent_id"))),
        );
      }
    } catch (e) {
      if (this.debug) this.debug(`agent-irc: transcript read failed: ${errorRepr(e)}`);
    }
    return new Usage();
  }

  private onSubagentStop(ev: Event): string[] {
    const agentId = py.str(py.or(get(ev, "agent_id"), "?"));
    const sub = this.subagents.get(agentId) ?? null;
    this.subagents.delete(agentId);
    const agentType = py.str(py.or(get(ev, "agent_type"), sub ? sub.type : "agent"));
    const usage = this.subagentUsage(ev);
    const duration = sub ? this.clock() - sub.started : usage.duration;
    const tools = Math.max(usage.tools, sub ? sub.tools : 0); // each source undercounts in a different failure mode
    const parts: unknown[] = [`${G.sub_stop} subagent ${agentType} done`];
    if (duration !== null) parts.push(fmtDuration(duration));
    parts.push(`${tools} tools`);
    this.totalTools += tools;
    if (usage.hasTokens()) {
      parts.push(usage.tokensText());
      this.total.add(new Usage({ input: usage.input, cached: usage.cached, output: usage.output }));
    }
    if (py.truthy(usage.model)) parts.push(usage.model);
    return [py.join(" · ", parts)];
  }

  // -- everything else ----------------------------------------------------

  private onStopFailure(ev: Event): string[] {
    this.turnStarted = null;
    const what = py.join(
      " — ",
      [get(ev, "error_type"), firstLine(get(ev, "error_message"))].filter((x) => py.truthy(x)),
    );
    return [`${G.fail} turn failed: ${head(what || "unknown", this.promptLimit)}`];
  }

  private onPermissionRequest(ev: Event): string[] {
    const name = displayToolName(py.or(get(ev, "tool_name"), "tool"));
    const summary = toolSummary(get(ev, "tool_name"), get(ev, "tool_input"), this.cwd, this.home);
    return [`${G.perm} permission: ${name}${summary ? ": " + summary : ""}`];
  }

  private onNotification(ev: Event): string[] {
    if (get(ev, "notification_type") === "idle_prompt") {
      // The only line that asks the reader for something, so it is the one
      // line that has to survive being skimmed in a busy channel.
      return [`${IDLE_RULE} ${G.idle} WAITING FOR INPUT ${IDLE_RULE}`];
    }
    return [];
  }

  private onInterrupt(): string[] {
    this.turnStarted = null;
    return [`${G.end} interrupted`];
  }

  private onPostModelSwitch(ev: Event): string[] {
    const previous = py.or(py.or(get(ev, "from_model"), this.model), "?");
    const target = py.or(get(ev, "to_model"), "?");
    if (py.truthy(get(ev, "to_model"))) this.model = get(ev, "to_model");
    this.modelAnnounced = true; // the switch line names it
    return [`${G.model} model ${py.str(previous)} → ${py.str(target)}`];
  }

  private onSessionEnd(ev: Event): string[] {
    this.ended = true;
    const reason = get(ev, "reason");
    const line = `${G.end} session ended` + (py.truthy(reason) ? ` (${py.str(reason)})` : "");
    return [line + " · " + this.summary()];
  }

  summary(): string {
    const parts: string[] = [];
    if (this.started !== null) parts.push(fmtDuration(this.clock() - this.started));
    parts.push(`${this.turns} turns`);
    parts.push(`${this.totalTools} tools`);
    if (this.total.hasTokens()) parts.push(this.total.tokensText());
    return parts.join(" · ");
  }
}
