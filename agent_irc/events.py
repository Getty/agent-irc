"""Turn hook events into IRC lines (spec §8)."""

import collections
import json
import re
import time

from agent_irc.text import first_line, fmt_duration, line_count, short_path, split_block, truncate
from agent_irc.usage import ClaudeTranscript, CodexTranscript, Usage, claude_subagent_path

G = {
    "start": "▶", "end": "■", "prompt": "»", "tool": "⚙", "fail": "✖",
    "sub_start": "⇢", "sub_stop": "⇠", "turn": "✔", "perm": "⚠", "idle": "…",
    "compact": "⟲", "model": "⇄", "notify": "↩",
}

IDLE_RULE = "===="
SUMMARY_LIMIT = 120
PROMPT_LIMIT = 200

_PLACEHOLDER_RE = re.compile(r"^\$\{[^}]*\}$")
_SHELL_TOOLS = {"bash", "shell", "shell_command", "exec_command", "local_shell", "unified_exec"}
_FILE_TOOLS = {"read", "edit", "write", "multiedit", "notebookedit", "read_file", "write_file", "edit_file"}
_PATCH_FILE_RE = re.compile(r"^\*\*\* (?:Update|Add|Delete) File: (.+)$", re.MULTILINE)


def clean(ev):
    if not isinstance(ev, dict):
        return {}
    out = {}
    for key, value in ev.items():
        if value is None or value == "":
            continue
        if isinstance(value, str) and _PLACEHOLDER_RE.match(value):
            continue
        out[key] = value
    tool_input = out.get("tool_input")
    if isinstance(tool_input, str) and tool_input[:1] in "{[":
        try:
            out["tool_input"] = json.loads(tool_input)
        except ValueError:
            pass
    return out


def display_tool_name(name):
    name = str(name or "")
    if name.startswith("mcp__"):
        return name.rsplit("__", 1)[-1]
    return name


def _first_string(d):
    for value in d.values():
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _command(d, raw=""):
    cmd = d.get("command", d.get("cmd", raw))
    if isinstance(cmd, list):
        cmd = " ".join(str(c) for c in cmd)
    return str(cmd or "")


def _extra_lines(text):
    """`[+3 lines]` for what the folded summary cannot show as lines."""
    extra = line_count(text) - 1
    if extra < 1:
        return ""
    return " [+%d line%s]" % (extra, "" if extra == 1 else "s")


def _head(text, limit):
    """The head line for one value.

    Below `full` there is no body under the head, so the whole value has to be
    squeezed into it: truncate() folds newlines into spaces, and a multi-line
    command reaches IRC whole-but-shortened rather than ending at its first
    line -- `python3 -c "` says nothing about what was run. At `full` (limit
    None) the body carries every line, so the head takes the first line whole
    instead of repeating an 800-line file folded into one.
    """
    if limit is None:
        return first_line(text)
    return truncate(text, limit)


def tool_summary(tool_name, tool_input, cwd, home, limit=SUMMARY_LIMIT):
    """One line for a tool call; `limit=None` shortens nothing (level full)."""
    lname = str(tool_name or "").lower()
    d = tool_input if isinstance(tool_input, dict) else {}
    raw = tool_input if isinstance(tool_input, str) else ""
    if lname in _SHELL_TOOLS:
        return _head(_command(d, raw), limit) + _extra_lines(_command(d, raw))
    if lname in _FILE_TOOLS:
        path = d.get("file_path") or d.get("path") or d.get("notebook_path") or raw
        return _head(short_path(path, cwd, home), limit)
    if lname in ("grep", "glob"):
        text = str(d.get("pattern") or raw)
        if d.get("path"):
            text += " " + short_path(d["path"], cwd, home)
        return _head(text, limit)
    if lname in ("agent", "task"):
        kind = d.get("subagent_type") or "agent"
        what = d.get("description") or d.get("prompt") or ""
        return _head("%s: %s" % (kind, what) if what else kind, limit)
    if lname in ("webfetch", "websearch"):
        return _head(d.get("url") or d.get("query") or raw, limit)
    if lname == "skill":
        return _head(d.get("skill") or raw, limit)
    if lname == "apply_patch":
        patch = d.get("patch") or d.get("input") or raw
        files = _PATCH_FILE_RE.findall(str(patch))
        return _head(", ".join(short_path(f.strip(), cwd, home) for f in files), limit)
    return _head(_first_string(d) or raw, limit)


def render_input(value, indent="  "):
    """A whole tool input as body lines, for level full.

    A string keeps its own line breaks; anything else is JSON on one line.
    Nothing here guesses a width: the connection is the only thing that knows
    its server's, and it splits whatever does not fit.
    """
    if not isinstance(value, dict):
        return [indent + line for line in split_block(value)]
    out = []
    for key, field in value.items():
        text = field if isinstance(field, str) else json.dumps(field, ensure_ascii=False)
        block = split_block(text)
        if len(block) == 1:
            out.append("%s%s: %s" % (indent, key, block[0]))
        elif block:
            out.append("%s%s:" % (indent, key))
            out.extend(indent + "  " + line for line in block)
    return out


_NOTIFY_RE = re.compile(r"<task-notification>(.*)</task-notification>", re.S)
_QUOTED_RE = re.compile(r'"([^"]+)"')


def parse_task_notification(text):
    """Fields of a harness-injected <task-notification>, or None for a plain prompt.

    Claude Code wakes an agent whose background child stopped by injecting a
    <task-notification> block as the prompt. Raw, that block reaches IRC as a
    dozen tag lines; here it becomes a status, a summary and (when the child
    reported one) a result to fold into a single readable line.
    """
    m = _NOTIFY_RE.search(str(text or ""))
    if not m:
        return None
    body = m.group(1)

    def field(name):
        fm = re.search(r"<%s>(.*?)</%s>" % (name, name), body, re.S)
        return fm.group(1).strip() if fm else ""

    return {"status": field("status"), "summary": field("summary"), "result": field("result")}


def render_notification(fields, level, limit):
    """A parsed task-notification as lines: a head naming the agent and status,
    and at full the result -- or, when a stopped child left no result, the
    summary that explains why."""
    status = fields.get("status") or "notification"
    summary = fields.get("summary") or ""
    result = fields.get("result") or ""
    m = _QUOTED_RE.search(summary)
    name = m.group(1) if m else ""
    if name:
        shown = truncate(name, limit) if limit is not None else name
        head = '%s agent "%s" %s' % (G["notify"], shown, status)
    else:
        head = "%s %s" % (G["notify"], status)
        headline = first_line(summary)
        if headline:
            head += ": " + _head(headline, limit)
    lines = [head]
    if level == "full":
        body = result
        if not body and not summary.startswith('Agent "'):
            body = summary
        lines.extend("  " + line for line in split_block(body))
    return lines


def _snake(name):
    return re.sub(r"(?<!^)(?=[A-Z])", "_", str(name or "")).lower()


class Session:
    """State for one harness session: turns, tools, subagents, totals."""

    def __init__(self, harness, level, cwd, home, clock=time.time, debug=None):
        self.harness = harness
        self.level = level
        # At full nothing is shortened: the head keeps its line whole and the
        # body under it carries the rest.
        self.summary_limit = None if level == "full" else SUMMARY_LIMIT
        self.prompt_limit = None if level == "full" else PROMPT_LIMIT
        self.cwd = cwd
        self.home = home
        self.clock = clock
        self.debug = debug
        self.session_id = None
        self.model = None
        self.model_announced = False
        self.started = None
        self.turns = 0
        self.turn_started = None
        self.turn_tools = 0
        self.total = Usage()
        self.total_tools = 0
        self.tool_starts = {}
        self.agent_descriptions = collections.deque()
        self.subagents = {}
        self.transcript = None
        self.ended = False

    # -- dispatch -----------------------------------------------------------

    def handle(self, ev):
        ev = clean(ev)
        lines = []
        if self.session_id is None and ev.get("session_id"):
            lines.extend(self._start(ev))
        handler = getattr(self, "_on_" + _snake(ev.get("event")), None)
        if handler is not None:
            lines.extend(handler(ev) or [])
        lines.extend(self._model_line())
        return lines

    def _model_line(self):
        """The model on its own line, once, when the session line went out without it.

        Claude Code's hook payloads carry no model at all and a fresh session's
        transcript has no assistant record yet when the first UserPromptSubmit
        fires, so the model is unknown at announce time. It shows up in the
        transcript with the first assistant message, which is written before the
        first tool call -- one line after the prompt, in practice.
        """
        if self.model_announced or self.session_id is None:
            return []
        if self.model is None:
            # Only worth looking during the first turn: from the first Stop on,
            # the turn usage names the model anyway.
            if self.transcript is None or self.turns > 1:
                return []
            try:
                self.model = self.transcript.peek_model()
            except Exception as e:
                if self.debug:
                    self.debug("agent-irc: transcript peek failed: %r" % e)
            if self.model is None:
                return []
        self.model_announced = True
        return ["%s model %s" % (G["model"], self.model)]

    def _new_transcript(self, path):
        if self.harness == "codex":
            return CodexTranscript(path)
        return ClaudeTranscript(path)

    def _start(self, ev):
        self.session_id = str(ev["session_id"])
        self.started = self.clock()
        if ev.get("cwd"):
            self.cwd = ev["cwd"]
        if ev.get("transcript_path"):
            self.transcript = self._new_transcript(ev["transcript_path"])
            try:
                primed = (self.transcript.read_turn(None) if self.harness == "codex"
                          else self.transcript.read_new())
                if primed.model:
                    self.model = primed.model
            except Exception as e:
                if self.debug:
                    self.debug("agent-irc: transcript read failed: %r" % e)
        if ev.get("model"):
            self.model = ev["model"]
        who = " ".join(x for x in (self.harness, self.model) if x)
        self.model_announced = bool(self.model)
        return [" · ".join([G["start"] + " session " + self.session_id[:8], who,
                            short_path(self.cwd, "", self.home)])]

    # -- prompt and turn ----------------------------------------------------

    def _on_user_prompt_submit(self, ev):
        self.turn_started = self.clock()
        self.turn_tools = 0
        self.turns += 1
        prompt = str(ev.get("prompt") or "")
        notification = parse_task_notification(prompt)
        if notification is not None:
            return render_notification(notification, self.level, self.summary_limit)
        lines = [G["prompt"] + " " + _head(first_line(prompt), self.prompt_limit)]
        if self.level == "full":
            # The » head already is the first line; the body carries only what
            # follows it, so a one-line prompt is not sent again under itself.
            lines.extend("  " + line for line in split_block(prompt)[1:])
        return lines

    def _turn_usage(self, ev):
        if self.transcript is None and ev.get("transcript_path"):
            self.transcript = self._new_transcript(ev["transcript_path"])
        if self.transcript is None:
            return Usage()
        try:
            if self.harness == "codex":
                return self.transcript.read_turn(ev.get("turn_id"))
            return self.transcript.read_new()
        except Exception as e:
            if self.debug:
                self.debug("agent-irc: transcript read failed: %r" % e)
            return Usage()

    def _on_stop(self, ev):
        usage = self._turn_usage(ev)
        parts = [G["turn"] + " turn"]
        if self.turn_started is not None:
            parts.append(fmt_duration(self.clock() - self.turn_started))
        parts.append("%d tools" % self.turn_tools)
        if usage.has_tokens():
            parts.append(usage.tokens_text())
            self.total.add(Usage(input=usage.input, cached=usage.cached, output=usage.output))
        if usage.model:
            self.model = usage.model
        elif ev.get("model"):
            self.model = ev["model"]
        if self.model:
            parts.append(self.model)
            self.model_announced = True
        lines = [" · ".join(parts)]
        if self.level == "full" and ev.get("last_assistant_message"):
            lines.extend("  " + line for line in split_block(ev["last_assistant_message"]))
        self.turn_started = None
        return lines

    # -- tools --------------------------------------------------------------

    def _on_pre_tool_use(self, ev):
        name = str(ev.get("tool_name") or "tool")
        summary = tool_summary(name, ev.get("tool_input"), self.cwd, self.home, self.summary_limit)
        tool_use_id = ev.get("tool_use_id")
        if tool_use_id:
            self.tool_starts[tool_use_id] = (self.clock(), name, summary, ev.get("agent_id"))
        if name.lower() in ("agent", "task") and not ev.get("agent_id"):
            tool_input = ev.get("tool_input") if isinstance(ev.get("tool_input"), dict) else {}
            self.agent_descriptions.append(str(tool_input.get("description") or ""))
        return []

    def _finish_tool(self, ev, glyph, suffix=""):
        name = str(ev.get("tool_name") or "tool")
        agent_id = ev.get("agent_id")
        started = self.tool_starts.pop(ev.get("tool_use_id"), None)
        duration = None
        if started is not None:
            t0, name, summary, started_agent = started
            agent_id = agent_id or started_agent
            duration = fmt_duration(self.clock() - t0)
        else:
            summary = tool_summary(name, ev.get("tool_input"), self.cwd, self.home, self.summary_limit)
        prefix = ""
        if agent_id:
            sub = self.subagents.get(agent_id)
            if sub is not None:
                sub["tools"] += 1
            if self.level == "activity":
                return []
            prefix = "[%s] " % str(agent_id)[:4]
        else:
            self.turn_tools += 1
            self.total_tools += 1
        head = "%s %s%s" % (glyph, prefix, display_tool_name(name))
        if duration:
            head += " " + duration
        line = head + (": " + summary if summary else "")
        if suffix:
            line += " — " + suffix
        return [line] + self._input_body(ev)

    def _input_body(self, ev):
        """At level full the whole tool input goes out under its head line.

        Every field, every line: a heredoc, the content of a Write, an Edit's
        two strings, the prompt of a subagent, whatever an unknown MCP tool
        carries. A body of one line is dropped -- the head line already is
        that line, and saying it twice is not saying it fully.
        """
        if self.level != "full":
            return []
        lines = render_input(ev.get("tool_input"))
        return lines if len(lines) > 1 else []

    def _on_post_tool_use(self, ev):
        return self._finish_tool(ev, G["tool"])

    def _on_post_tool_use_failure(self, ev):
        error = _head(first_line(ev.get("error_message")) or "failed", self.summary_limit)
        return self._finish_tool(ev, G["fail"], error)

    # -- subagents ----------------------------------------------------------

    def _on_subagent_start(self, ev):
        agent_id = str(ev.get("agent_id") or "?")
        agent_type = str(ev.get("agent_type") or "agent")
        description = self.agent_descriptions.popleft() if self.agent_descriptions else ""
        self.subagents[agent_id] = {"type": agent_type, "desc": description, "started": self.clock(), "tools": 0}
        line = "%s subagent %s" % (G["sub_start"], agent_type)
        if description:
            line += ": " + _head(description, self.summary_limit)
        return [line]

    def _subagent_usage(self, ev):
        try:
            if self.harness == "codex":
                path = ev.get("agent_transcript_path")
                return CodexTranscript.read_whole(path) if path else Usage()
            main = self.transcript.path if self.transcript is not None else ev.get("transcript_path")
            if main and self.session_id and ev.get("agent_id"):
                return ClaudeTranscript.read_whole(
                    claude_subagent_path(main, self.session_id, str(ev["agent_id"])))
        except Exception as e:
            if self.debug:
                self.debug("agent-irc: transcript read failed: %r" % e)
        return Usage()

    def _on_subagent_stop(self, ev):
        agent_id = str(ev.get("agent_id") or "?")
        sub = self.subagents.pop(agent_id, None)
        agent_type = str(ev.get("agent_type") or (sub["type"] if sub else "agent"))
        usage = self._subagent_usage(ev)
        duration = self.clock() - sub["started"] if sub else usage.duration
        tools = max(usage.tools, sub["tools"] if sub else 0)  # each source undercounts in a different failure mode
        parts = ["%s subagent %s done" % (G["sub_stop"], agent_type)]
        if duration is not None:
            parts.append(fmt_duration(duration))
        parts.append("%d tools" % tools)
        self.total_tools += tools
        if usage.has_tokens():
            parts.append(usage.tokens_text())
            self.total.add(Usage(input=usage.input, cached=usage.cached, output=usage.output))
        if usage.model:
            parts.append(usage.model)
        return [" · ".join(parts)]

    # -- everything else ----------------------------------------------------

    def _on_stop_failure(self, ev):
        self.turn_started = None
        what = " — ".join(x for x in (ev.get("error_type"), first_line(ev.get("error_message"))) if x)
        return ["%s turn failed: %s" % (G["fail"], _head(what or "unknown", self.prompt_limit))]

    def _on_permission_request(self, ev):
        name = display_tool_name(ev.get("tool_name") or "tool")
        summary = tool_summary(ev.get("tool_name"), ev.get("tool_input"), self.cwd, self.home)
        return ["%s permission: %s%s" % (G["perm"], name, ": " + summary if summary else "")]

    def _on_notification(self, ev):
        if ev.get("notification_type") == "idle_prompt":
            # The only line that asks the reader for something, so it is the one
            # line that has to survive being skimmed in a busy channel.
            return ["%s %s WAITING FOR INPUT %s" % (IDLE_RULE, G["idle"], IDLE_RULE)]
        return []

    def _on_interrupt(self, ev):
        self.turn_started = None
        return [G["end"] + " interrupted"]

    def _on_post_compact(self, ev):
        return ["%s compacted (%s)" % (G["compact"], ev.get("trigger") or "auto")]

    def _on_post_model_switch(self, ev):
        previous = ev.get("from_model") or self.model or "?"
        target = ev.get("to_model") or "?"
        if ev.get("to_model"):
            self.model = ev["to_model"]
        self.model_announced = True  # the switch line names it
        return ["%s model %s → %s" % (G["model"], previous, target)]

    def _on_session_end(self, ev):
        self.ended = True
        reason = ev.get("reason")
        head = G["end"] + " session ended" + (" (%s)" % reason if reason else "")
        return [head + " · " + self.summary()]

    def summary(self):
        parts = []
        if self.started is not None:
            parts.append(fmt_duration(self.clock() - self.started))
        parts.append("%d turns" % self.turns)
        parts.append("%d tools" % self.total_tools)
        if self.total.has_tokens():
            parts.append(self.total.tokens_text())
        return " · ".join(parts)
