"""IRC connection thread: register, keep alive, deliver lines (spec §7)."""

import collections
import select
import socket
import ssl
import threading
import time

from agent_irc.text import cut_bytes

MAX_PAYLOAD = 400
QUEUE_LIMIT = 500
BACKOFF = (5, 10, 20, 40, 60)
REGISTRATION_TIMEOUT = 30.0
NICK_LIMITS = (30, 9)
MAX_NICK_TRIES = 99


class GiveUp(Exception):
    """The connection cannot be established in a way a retry would fix."""


class FloodBucket:
    def __init__(self, burst=4, interval=2.0, clock=time.monotonic):
        self.burst = float(burst)
        self.interval = float(interval)
        self.clock = clock
        self.tokens = float(burst)
        self.last = clock()

    def acquire_delay(self):
        """Take a token and return 0, or return the seconds until the next token."""
        now = self.clock()
        self.tokens = min(self.burst, self.tokens + (now - self.last) / self.interval)
        self.last = now
        if self.tokens >= 1.0:
            self.tokens -= 1.0
            return 0.0
        return (1.0 - self.tokens) * self.interval


def parse_line(line):
    prefix = None
    if line.startswith(":"):
        prefix, _, line = line[1:].partition(" ")
    if " :" in line:
        head, trailing = line.split(" :", 1)
        params = head.split()
        params.append(trailing)
    elif line.startswith(":"):
        params = [line[1:]]
    else:
        params = line.split()
    command = params.pop(0).upper() if params else ""
    return prefix, command, params


def nick_candidate(base, n, limit):
    suffix = "-%d" % n
    return base[: max(limit - len(suffix), 1)] + suffix
