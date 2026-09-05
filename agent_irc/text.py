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
    if seconds < 10:
        return "%.1fs" % seconds
    if seconds < 60:
        return "%ds" % round(seconds)
    if seconds < 3600:
        m, s = divmod(int(round(seconds)), 60)
        return "%dm%02ds" % (m, s)
    h, rest = divmod(int(round(seconds)), 3600)
    return "%dh%02dm" % (h, rest // 60)


def fmt_tokens(n):
    n = int(n or 0)
    if n < 1000:
        return str(n)
    if n < 1000000:
        return "%dk" % round(n / 1000.0)
    m = n / 1000000.0
    s = "%.1f" % m
    if s.endswith(".0"):
        s = s[:-2]
    return s + "M"


def nick_base(cwd):
    base = os.path.basename(str(cwd or "").rstrip("/")).lower()
    base = re.sub(r"[^a-z0-9-]+", "-", base).strip("-")
    base = re.sub(r"-{2,}", "-", base)
    if not base:
        return "agent"
    if base[0].isdigit():
        base = "p-" + base
    return base
