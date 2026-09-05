"""Turn hook events into IRC lines (spec §8)."""

import collections
import json
import re
import time

from agent_irc.text import first_line, fmt_duration, short_path, split_message, truncate
from agent_irc.usage import ClaudeTranscript, CodexTranscript, Usage, claude_subagent_path

G = {
    "start": "▶", "end": "■", "prompt": "»", "tool": "⚙", "fail": "✖",
    "sub_start": "⇢", "sub_stop": "⇠", "turn": "✔", "perm": "⚠", "idle": "…",
    "compact": "⟲", "model": "⇄",
}

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


def tool_summary(tool_name, tool_input, cwd, home):
    lname = str(tool_name or "").lower()
    d = tool_input if isinstance(tool_input, dict) else {}
    raw = tool_input if isinstance(tool_input, str) else ""
    if lname in _SHELL_TOOLS:
        cmd = d.get("command", d.get("cmd", raw))
        if isinstance(cmd, list):
            cmd = " ".join(str(c) for c in cmd)
        return truncate(first_line(cmd), SUMMARY_LIMIT)
    if lname in _FILE_TOOLS:
        path = d.get("file_path") or d.get("path") or d.get("notebook_path") or raw
        return truncate(short_path(path, cwd, home), SUMMARY_LIMIT)
    if lname in ("grep", "glob"):
        text = str(d.get("pattern") or raw)
        if d.get("path"):
            text += " " + short_path(d["path"], cwd, home)
        return truncate(text, SUMMARY_LIMIT)
    if lname in ("agent", "task"):
        kind = d.get("subagent_type") or "agent"
        what = d.get("description") or d.get("prompt") or ""
        return truncate("%s: %s" % (kind, first_line(what)) if what else kind, SUMMARY_LIMIT)
    if lname in ("webfetch", "websearch"):
        return truncate(d.get("url") or d.get("query") or raw, SUMMARY_LIMIT)
    if lname == "skill":
        return truncate(d.get("skill") or raw, SUMMARY_LIMIT)
    if lname == "apply_patch":
        patch = d.get("patch") or d.get("input") or raw
        files = _PATCH_FILE_RE.findall(str(patch))
        return truncate(", ".join(short_path(f.strip(), cwd, home) for f in files), SUMMARY_LIMIT)
    return truncate(first_line(_first_string(d) or raw), SUMMARY_LIMIT)


def _snake(name):
    return re.sub(r"(?<!^)(?=[A-Z])", "_", str(name or "")).lower()


class Session:
    """State for one harness session: turns, tools, subagents, totals."""

    def __init__(self, harness, level, cwd, home, clock=time.time):
        self.harness = harness
        self.level = level
        self.cwd = cwd
        self.home = home
        self.clock = clock
        self.session_id = None
        self.model = None
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
        return lines

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
            except Exception:
                pass
        if ev.get("model"):
            self.model = ev["model"]
        who = " ".join(x for x in (self.harness, self.model) if x)
        return [" · ".join([G["start"] + " session " + self.session_id[:8], who,
                            short_path(self.cwd, "", self.home)])]

    # -- prompt and turn ----------------------------------------------------

    def _on_user_prompt_submit(self, ev):
        self.turn_started = self.clock()
        self.turn_tools = 0
        self.turns += 1
        prompt = str(ev.get("prompt") or "")
        lines = [G["prompt"] + " " + truncate(first_line(prompt), PROMPT_LIMIT)]
        if self.level == "full":
            lines.extend("  " + line for line in split_message(prompt))
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
        except Exception:
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
        lines = [" · ".join(parts)]
        if self.level == "full" and ev.get("last_assistant_message"):
            lines.extend("  " + line for line in split_message(str(ev["last_assistant_message"])))
        self.turn_started = None
        return lines

    # -- tools --------------------------------------------------------------

    def _on_pre_tool_use(self, ev):
        name = str(ev.get("tool_name") or "tool")
        summary = tool_summary(name, ev.get("tool_input"), self.cwd, self.home)
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
            summary = tool_summary(name, ev.get("tool_input"), self.cwd, self.home)
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
        return [line]

    def _on_post_tool_use(self, ev):
        return self._finish_tool(ev, G["tool"])

    def _on_post_tool_use_failure(self, ev):
        error = truncate(first_line(ev.get("error_message")) or "failed", SUMMARY_LIMIT)
        return self._finish_tool(ev, G["fail"], error)

    # -- subagents ----------------------------------------------------------

    def _on_subagent_start(self, ev):
        agent_id = str(ev.get("agent_id") or "?")
        agent_type = str(ev.get("agent_type") or "agent")
        description = self.agent_descriptions.popleft() if self.agent_descriptions else ""
        self.subagents[agent_id] = {"type": agent_type, "desc": description, "started": self.clock(), "tools": 0}
        line = "%s subagent %s" % (G["sub_start"], agent_type)
        if description:
            line += ": " + truncate(description, SUMMARY_LIMIT)
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
        except Exception:
            pass
        return Usage()

    def _on_subagent_stop(self, ev):
        agent_id = str(ev.get("agent_id") or "?")
        sub = self.subagents.pop(agent_id, None)
        agent_type = str(ev.get("agent_type") or (sub["type"] if sub else "agent"))
        usage = self._subagent_usage(ev)
        duration = self.clock() - sub["started"] if sub else usage.duration
        tools = usage.tools or (sub["tools"] if sub else 0)
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
