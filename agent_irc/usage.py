"""Token usage read from harness transcripts (spec §9)."""

import json
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from agent_irc.text import fmt_tokens


@dataclass
class Usage:
    input: int = 0
    cached: int = 0
    output: int = 0
    tools: int = 0
    model: Optional[str] = None
    duration: Optional[float] = None

    def add(self, other):
        self.input += other.input
        self.cached += other.cached
        self.output += other.output
        self.tools += other.tools
        if other.model:
            self.model = other.model
        return self

    def has_tokens(self):
        return bool(self.input or self.output)

    def tokens_text(self):
        text = "%s in" % fmt_tokens(self.input)
        if self.cached:
            text += " (%s cached)" % fmt_tokens(self.cached)
        return text + " / %s out" % fmt_tokens(self.output)


def _parse_ts(value):
    if isinstance(value, (int, float)):
        return value / 1000.0 if value > 1e11 else float(value)
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _span(records):
    stamps = [_parse_ts(r.get("timestamp")) for r in records if isinstance(r, dict)]
    stamps = [s for s in stamps if s is not None]
    if len(stamps) < 2:
        return None
    return max(stamps) - min(stamps)


class _Tail:
    """Yields the complete JSON lines appended to a file since the previous call."""

    def __init__(self, path):
        self.path = path
        self.offset = 0

    def records(self):
        try:
            if os.path.getsize(self.path) < self.offset:
                self.offset = 0
            with open(self.path, "rb") as f:
                f.seek(self.offset)
                data = f.read()
        except OSError:
            return []
        end = data.rfind(b"\n")
        if end < 0:
            return []
        self.offset += end + 1
        out = []
        for line in data[:end].split(b"\n"):
            if not line.strip():
                continue
            try:
                out.append(json.loads(line.decode("utf-8")))
            except ValueError:
                continue
        return out


def _int(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _claude_usage(records):
    usage = Usage()
    seen = set()
    for rec in records:
        if not isinstance(rec, dict) or rec.get("type") != "assistant":
            continue
        msg = rec.get("message")
        if not isinstance(msg, dict):
            continue
        for block in msg.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                usage.tools += 1
        u = msg.get("usage")
        if not isinstance(u, dict):
            continue
        key = rec.get("requestId") or msg.get("id") or rec.get("uuid")
        if key in seen:
            continue
        seen.add(key)
        cached = _int(u.get("cache_read_input_tokens"))
        usage.input += _int(u.get("input_tokens")) + _int(u.get("cache_creation_input_tokens")) + cached
        usage.cached += cached
        usage.output += _int(u.get("output_tokens"))
        if msg.get("model"):
            usage.model = msg["model"]
    return usage


class ClaudeTranscript(_Tail):
    def read_new(self):
        return _claude_usage(self.records())

    @classmethod
    def read_whole(cls, path):
        records = cls(path).records()
        usage = _claude_usage(records)
        usage.duration = _span(records)
        return usage


def claude_subagent_path(transcript_path, session_id, agent_id):
    return os.path.join(os.path.dirname(transcript_path), session_id, "subagents",
                        "agent-%s.jsonl" % agent_id)
