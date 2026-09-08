"""Configuration: URL parsing, harness settings files, trust, layer merge (spec §5)."""

import json
import os
import re
from dataclasses import dataclass, field
from typing import List, Optional
from urllib.parse import unquote

NAMESPACE = "agent-irc"
LEVELS = ("activity", "subactivity", "full")
LIST_KEY_RE = re.compile(r"^(?:[a-z0-9]+_)?channels$")
# How fast we may send and how much may wait. The defaults are the safe ones
# for a public server; an ircd of one's own takes far more, and level "full"
# wants it -- one Write can be a thousand lines.
TUNING_KEYS = ("flood_burst", "flood_interval", "queue_limit")


@dataclass(frozen=True)
class Server:
    scheme: str
    host: str
    port: int
    user: str
    password: Optional[str]
    insecure: bool = field(compare=False)

    @property
    def tls(self):
        return self.scheme == "ircs"

    @property
    def label(self):
        # host holds the bare address, the way socket.create_connection wants
        # it; an IPv6 literal gets its brackets back for anything human-read.
        host = "[%s]" % self.host if ":" in self.host else self.host
        return "%s:%d" % (host, self.port)


@dataclass(frozen=True)
class Target:
    server: Server
    channel: str


@dataclass
class Config:
    targets: List[Target]
    level: str
    flood_burst: int = 4
    flood_interval: float = 2.0
    queue_limit: int = 500  # 0 = never drop
    listen: bool = False  # accept DMs and mentions for the read_messages tool
    listen_from: List[str] = field(default_factory=list)  # hostmask patterns; empty = nobody


# The host is either a name/IPv4, or an IPv6 literal in brackets -- which is
# the only place a colon may appear before the port.
_URL_RE = re.compile(
    r"^(ircs?)://(?:([^@/]*)@)?(\[[0-9A-Fa-f:.]+\]|[^/:?#@]+)(?::(\d+))?/([^?]*)(?:\?(.*))?$"
)

_USERINFO_RE = re.compile(r"^([A-Za-z]+://).*@")


def redact_url(url):
    """The URL with any user:password part replaced by ***, for log and error text."""
    return _USERINFO_RE.sub(r"\1***@", str(url))


def parse_url(url, default_user):
    m = _URL_RE.match(str(url).strip())
    if not m:
        raise ValueError("not an irc:// or ircs:// URL with a channel: %r" % redact_url(url))
    scheme, userinfo, host, port, path, query = m.groups()
    user, password = default_user, None
    if userinfo is not None:
        if ":" in userinfo:
            raw_user, raw_password = userinfo.split(":", 1)
            password = unquote(raw_password)
        else:
            raw_user = userinfo
        if raw_user:
            user = unquote(raw_user)
    port = int(port) if port else (6697 if scheme == "ircs" else 6667)
    channel = unquote(path).strip()
    if not channel:
        raise ValueError("URL has no channel: %r" % redact_url(url))
    if channel[0] not in "#&+!":
        channel = "#" + channel
    host = host.lower()
    if host.startswith("["):
        host = host[1:-1]  # bare address for socket.create_connection
    insecure = False
    for part in (query or "").split("&"):
        key, _, value = part.partition("=")
        if key == "insecure" and (value or "1").lower() in ("1", "true", "yes"):
            insecure = True
    return Target(Server(scheme, host, port, user, password, insecure), channel)


_VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def expand_env(s, env):
    def repl(m):
        name = m.group(1)
        if name not in env:
            raise KeyError(name)
        return env[name]

    return _VAR_RE.sub(repl, s)


def _log(log, message):
    if log is not None:
        log(message)


def read_json_namespace(path, log=None):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except OSError:
        return {}
    except ValueError as e:
        _log(log, "agent-irc: %s: invalid JSON (%s), skipped" % (path, e))
        return {}
    ns = data.get(NAMESPACE) if isinstance(data, dict) else None
    return ns if isinstance(ns, dict) else {}


_HEADER_RE = re.compile(r"^\s*\[([^\]]+)\]\s*(?:#.*)?$")
_STRING_RE = re.compile(r'"((?:[^"\\]|\\.)*)"|\'([^\']*)\'')
_KEY_RE = re.compile(r"^[ \t]*([A-Za-z0-9_-]+)[ \t]*=[ \t]*", re.MULTILINE)
_BOOL_RE = re.compile(r"(?:true|false)(?=[ \t]*(?:#|$))", re.MULTILINE)
# A number only when nothing but blanks or a comment follow it, so a bare
# TOML date (1979-05-27) is skipped rather than read as its year.
_NUMBER_RE = re.compile(r"[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?"
                        r"(?:[eE][+-]?[0-9](?:_?[0-9])*)?(?=[ \t]*(?:#|$))", re.MULTILINE)
_ESCAPES = {'"': '"', "\\": "\\", "n": "\n", "t": "\t"}


def _toml_table_body(text, table):
    lines = []
    inside = False
    for line in text.splitlines():
        m = _HEADER_RE.match(line)
        if m:
            name = m.group(1).strip()
            inside = name == table or name == '"%s"' % table
            continue
        if inside:
            lines.append(line)
    return "\n".join(lines)


def _toml_unescape(m):
    raw = m.group(1)
    if raw is None:
        return m.group(2)
    return re.sub(r'\\(["\\nt])', lambda e: _ESCAPES[e.group(1)], raw)


def _parse_array(body, start):
    """Parse the string array opening at body[start] == '['; return (values, index after ']')."""
    values = []
    pos = start + 1
    while pos < len(body):
        ch = body[pos]
        if ch == "]":
            return values, pos + 1
        if ch in "\"'":
            m = _STRING_RE.match(body, pos)
            if not m:
                return values, len(body)
            values.append(_toml_unescape(m))
            pos = m.end()
            continue
        if ch == "#":
            nl = body.find("\n", pos)
            pos = len(body) if nl < 0 else nl
            continue
        pos += 1
    return values, len(body)


def _toml_number(text):
    text = text.replace("_", "")
    return float(text) if ("." in text or "e" in text or "E" in text) else int(text)


def parse_toml_table(text, table):
    """Minimal TOML: string, boolean, number and string-array values of one table.

    Fallback for Python < 3.11, which has no tomllib. Every value type a
    config key can take has to be in here: without the numbers the tuning keys
    vanished there and the connection silently ran on the default flood bucket
    and queue cap; without booleans `listen` would vanish the same way and
    inbound would never turn on.
    """
    body = _toml_table_body(text, table)
    result = {}
    pos = 0
    while True:
        m = _KEY_RE.search(body, pos)
        if not m:
            return result
        key, pos = m.group(1), m.end()
        if body.startswith("[", pos):
            result[key], pos = _parse_array(body, pos)
            continue
        sm = _STRING_RE.match(body, pos)
        if sm:
            result[key] = _toml_unescape(sm)
            pos = sm.end()
            continue
        bm = _BOOL_RE.match(body, pos)
        if bm:
            result[key] = bm.group(0) == "true"
            pos = bm.end()
            continue
        nm = _NUMBER_RE.match(body, pos)
        if nm:
            result[key] = _toml_number(nm.group(0))
            pos = nm.end()
            continue
        nl = body.find("\n", pos)
        pos = len(body) if nl < 0 else nl + 1


def _load_toml(path, log=None):
    """Whole file via tomllib, {} on read/parse error, None when tomllib is unavailable."""
    try:
        import tomllib
    except ImportError:
        return None
    try:
        with open(path, "rb") as f:
            return tomllib.load(f)
    except OSError:
        return {}
    except Exception as e:  # tomllib.TOMLDecodeError
        _log(log, "agent-irc: %s: invalid TOML (%s), skipped" % (path, e))
        return {}


def _read_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def read_toml_namespace(path, log=None):
    data = _load_toml(path, log)
    if data is not None:
        ns = data.get(NAMESPACE) if isinstance(data, dict) else None
        return ns if isinstance(ns, dict) else {}
    text = _read_text(path)
    if text is None:
        return {}
    return parse_toml_table(text, NAMESPACE)


def ancestors(path):
    path = os.path.abspath(path)
    out = []
    while True:
        out.append(path)
        parent = os.path.dirname(path)
        if parent == path:
            return out
        path = parent


def config_home(harness, home, env=None):
    """The directory the harness keeps its own settings in.

    Both harnesses let the user move it -- Codex with `CODEX_HOME`, Claude
    Code with `CLAUDE_CONFIG_DIR` -- and then keep everything there, settings
    and trust markers alike. Reading `~/.codex` or `~/.claude` regardless is
    how a session with a moved config runs with no configuration at all, and
    silently: no configuration is a legitimate state, so nothing complains.
    Found the hard way while testing Codex in an isolated `CODEX_HOME`
    (2026-09-08): the hooks fired, the server started -- the bootstrap in
    `.mcp.codex.json` does honour `CODEX_HOME` -- and not one line reached
    IRC, because the config it read was the one in the real home.
    """
    env = env or {}
    if harness == "codex":
        return env.get("CODEX_HOME") or os.path.join(home, ".codex")
    return env.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude")


def claude_trust_file(home, env=None):
    """`<config dir>/.claude.json` when it is there, else `~/.claude.json`.

    Claude Code moves this file into `CLAUDE_CONFIG_DIR` along with the rest
    (verified live 2026-09-08: an isolated config dir gets its own
    `.claude.json`), but with no variable set it sits next to `~/.claude`,
    not inside it.
    """
    moved = os.path.join(config_home("claude", home, env), ".claude.json")
    return moved if os.path.exists(moved) else os.path.join(home, ".claude.json")


def claude_trusted(home, cwd, env=None):
    try:
        with open(claude_trust_file(home, env), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return False
    projects = data.get("projects") if isinstance(data, dict) else None
    if not isinstance(projects, dict):
        return False
    for p in ancestors(cwd):
        entry = projects.get(p)
        if isinstance(entry, dict) and entry.get("hasTrustDialogAccepted") is True:
            return True
    return False


def codex_trusted(home, cwd, env=None):
    path = os.path.join(config_home("codex", home, env), "config.toml")
    data = _load_toml(path)
    if data is not None:
        projects = data.get("projects") if isinstance(data, dict) else None
        if not isinstance(projects, dict):
            return False
        for p in ancestors(cwd):
            entry = projects.get(p)
            if isinstance(entry, dict) and entry.get("trust_level") == "trusted":
                return True
        return False
    text = _read_text(path)
    if text is None:
        return False
    for p in ancestors(cwd):
        if parse_toml_table(text, 'projects."%s"' % p).get("trust_level") == "trusted":
            return True
    return False


def is_trusted(harness, cwd, home, env=None):
    if harness == "codex":
        return codex_trusted(home, cwd, env)
    return claude_trusted(home, cwd, env)


def tuning_value(key, value):
    """One tuning number, or None if it is not a number this key can take."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if key == "flood_interval":
        return float(value) if value >= 0 else None
    if not isinstance(value, int):
        return None
    return value if value >= (1 if key == "flood_burst" else 0) else None


def merge_layers(layers):
    """Named lists: last definition of a name wins whole. Level, tuning numbers
    and the listen settings: last valid value wins.

    The third return value is whatever Config takes as keywords, so a new
    setting only has to be read here and declared there.
    """
    lists = {}
    level = "activity"
    values = {}
    for layer in layers:
        if not isinstance(layer, dict):
            continue
        for key, value in layer.items():
            if LIST_KEY_RE.match(key) and isinstance(value, list):
                lists[key] = [v for v in value if isinstance(v, str)]
            elif key == "level" and value in LEVELS:
                level = value
            elif key in TUNING_KEYS:
                number = tuning_value(key, value)
                if number is not None:
                    values[key] = number
            elif key == "listen" and isinstance(value, bool):
                values[key] = value
            elif key == "listen_from" and isinstance(value, list):
                values[key] = [v for v in value if isinstance(v, str)]
    return lists, level, values


def resolve_targets(lists, env, default_user, log=None):
    targets = []
    seen = set()
    for name, urls in lists.items():
        for url in urls:
            try:
                target = parse_url(expand_env(url, env), default_user)
            except KeyError as e:
                _log(log, "agent-irc: %s: ${%s} is not set, entry skipped" % (name, e.args[0]))
                continue
            except ValueError as e:
                _log(log, "agent-irc: %s: %s, entry skipped" % (name, e))
                continue
            if target in seen:
                continue
            seen.add(target)
            targets.append(target)
    return targets


def config_files(harness, cwd, home, trusted, env=None):
    """User-level file first, then the project's -- which are always relative
    to the project, whatever the user-level directory is."""
    if harness == "codex":
        files = [os.path.join(config_home("codex", home, env), "config.toml")]
        if trusted:
            files.append(os.path.join(cwd, ".codex", "config.toml"))
        return files
    files = [os.path.join(config_home("claude", home, env), "settings.json")]
    if trusted:
        files.append(os.path.join(cwd, ".claude", "settings.json"))
        files.append(os.path.join(cwd, ".claude", "settings.local.json"))
    return files


def load_config(harness, cwd, home, env, log=None):
    trusted = is_trusted(harness, cwd, home, env)
    if not trusted:
        _log(log, "agent-irc: %s is not trusted by %s, project config ignored" % (cwd, harness))
    reader = read_toml_namespace if harness == "codex" else read_json_namespace
    layers = [reader(path, log) for path in config_files(harness, cwd, home, trusted, env)]
    lists, level, values = merge_layers(layers)
    default_user = env.get("USER") or env.get("LOGNAME") or "agent"
    return Config(resolve_targets(lists, env, default_user, log), level, **values)
