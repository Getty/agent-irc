"""Pure string helpers shared by formatting and IRC code."""

import os
import re

ELLIPSIS = "…"


def first_line(s):
    if not s:
        return ""
    for line in str(s).splitlines():
        if line.strip():
            return line.strip()
    return ""


def line_count(s):
    """Lines with something on them -- what a reader would count."""
    return sum(1 for line in str(s or "").splitlines() if line.strip())


def truncate(s, limit):
    s = " ".join(str(s or "").split())
    if len(s) <= limit:
        return s
    return s[: max(limit - 1, 0)].rstrip() + ELLIPSIS


def cut_bytes(s, max_bytes):
    data = s.encode("utf-8")
    if len(data) <= max_bytes:
        return s
    return data[:max_bytes].decode("utf-8", errors="ignore")


def _split_long_word(word, max_bytes):
    out = []
    while word:
        head = cut_bytes(word, max_bytes)
        if not head:
            break
        out.append(head)
        word = word[len(head):]
    return out


def split_message(text, max_bytes=400):
    lines = []
    for paragraph in str(text or "").split("\n"):
        words = paragraph.split()
        if not words:
            continue
        current = ""
        for word in words:
            if len(word.encode("utf-8")) > max_bytes:
                if current:
                    lines.append(current)
                    current = ""
                lines.extend(_split_long_word(word, max_bytes))
                continue
            candidate = word if not current else current + " " + word
            if len(candidate.encode("utf-8")) <= max_bytes:
                current = candidate
            else:
                lines.append(current)
                current = word
        if current:
            lines.append(current)
    return lines


def split_block(text):
    """Text whose line breaks and indentation mean something -- a command, not
    prose -- as one output line per source line. Blank lines go, tabs become
    spaces (the sender strips control characters, and a Makefile recipe without
    its tab is a lie); fitting the line to the server is the sender's job."""
    out = []
    for line in str(text or "").split("\n"):
        line = line.expandtabs(4).rstrip()
        if line.strip():
            out.append(line)
    return out


def wrap_payload(text, max_bytes):
    """One logical line as the payload chunks one server will relay intact.

    A continuation keeps the line's leading indent, so a wrapped body line
    still reads as a body line rather than as a new event.
    """
    text = str(text or "").rstrip()
    if not text.strip():
        return []
    if len(text.encode("utf-8")) <= max_bytes:
        return [text]
    indent = text[: len(text) - len(text.lstrip(" "))]
    room = max(max_bytes - len(indent.encode("utf-8")), 1)
    return [indent + part for part in split_message(text.strip(), room)]


def short_path(path, cwd, home):
    path = str(path or "")
    if cwd and (path == cwd or path.startswith(cwd.rstrip("/") + "/")):
        return os.path.relpath(path, cwd)
    if home:
        home = home.rstrip("/")
        if path == home:
            return "~"
        if path.startswith(home + "/"):
            return "~" + path[len(home):]
    return path


def fmt_duration(seconds):
    seconds = max(float(seconds or 0), 0.0)
    if seconds < 9.95:
        return "%.1fs" % seconds
    total = int(round(seconds))
    if total < 60:
        return "%ds" % total
    if total < 3600:
        return "%dm%02ds" % divmod(total, 60)
    hours, rest = divmod(total, 3600)
    return "%dh%02dm" % (hours, rest // 60)


def fmt_tokens(n):
    n = int(n or 0)
    if n < 1000:
        return str(n)
    thousands = int(round(n / 1000.0))
    if thousands < 1000:
        return "%dk" % thousands
    text = "%.1f" % (n / 1000000.0)
    if text.endswith(".0"):
        text = text[:-2]
    return text + "M"


def nick_base(cwd):
    base = os.path.basename(str(cwd or "").rstrip("/")).lower()
    base = re.sub(r"[^a-z0-9-]+", "-", base).strip("-")
    base = re.sub(r"-{2,}", "-", base)
    if not base:
        return "agent"
    if base[0].isdigit():
        base = "p-" + base
    return base
