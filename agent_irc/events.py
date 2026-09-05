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
    out = {}
    for key, value in (ev or {}).items():
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
