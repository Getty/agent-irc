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
        return "%s:%d" % (self.host, self.port)


@dataclass(frozen=True)
class Target:
    server: Server
    channel: str


@dataclass
class Config:
    targets: List[Target]
    level: str


_URL_RE = re.compile(
    r"^(ircs?)://(?:([^@/]*)@)?([^/:?#@]+)(?::(\d+))?/([^?]*)(?:\?(.*))?$"
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
    insecure = False
    for part in (query or "").split("&"):
        key, _, value = part.partition("=")
        if key == "insecure" and (value or "1").lower() in ("1", "true", "yes"):
            insecure = True
    return Target(Server(scheme, host.lower(), port, user, password, insecure), channel)


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


def parse_toml_table(text, table):
    """Minimal TOML: string and string-array values of one table. Fallback for Python < 3.11."""
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
        else:
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


def claude_trusted(home, cwd):
    try:
        with open(os.path.join(home, ".claude.json"), encoding="utf-8") as f:
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


def codex_trusted(home, cwd):
    path = os.path.join(home, ".codex", "config.toml")
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


def is_trusted(harness, cwd, home):
    if harness == "codex":
        return codex_trusted(home, cwd)
    return claude_trusted(home, cwd)


def merge_layers(layers):
    """Named lists: last definition of a name wins whole. Level: last valid wins."""
    lists = {}
    level = "activity"
    for layer in layers:
        if not isinstance(layer, dict):
            continue
        for key, value in layer.items():
            if LIST_KEY_RE.match(key) and isinstance(value, list):
                lists[key] = [v for v in value if isinstance(v, str)]
            elif key == "level" and value in LEVELS:
                level = value
    return lists, level


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


def config_files(harness, cwd, home, trusted):
    if harness == "codex":
        files = [os.path.join(home, ".codex", "config.toml")]
        if trusted:
            files.append(os.path.join(cwd, ".codex", "config.toml"))
        return files
    files = [os.path.join(home, ".claude", "settings.json")]
    if trusted:
        files.append(os.path.join(cwd, ".claude", "settings.json"))
        files.append(os.path.join(cwd, ".claude", "settings.local.json"))
    return files


def load_config(harness, cwd, home, env, log=None):
    trusted = is_trusted(harness, cwd, home)
    if not trusted:
        _log(log, "agent-irc: %s is not trusted by %s, project config ignored" % (cwd, harness))
    reader = read_toml_namespace if harness == "codex" else read_json_namespace
    layers = [reader(path, log) for path in config_files(harness, cwd, home, trusted)]
    lists, level = merge_layers(layers)
    default_user = env.get("USER") or env.get("LOGNAME") or "agent"
    return Config(resolve_targets(lists, env, default_user, log), level)
