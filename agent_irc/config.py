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

_USERINFO_RE = re.compile(r"^([A-Za-z]+://)[^@/]*@")


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
