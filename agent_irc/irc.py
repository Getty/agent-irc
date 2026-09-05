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
        elapsed = max(0.0, now - self.last)
        self.tokens = min(self.burst, self.tokens + elapsed / self.interval)
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


class IrcConnection(threading.Thread):
    """One IRC server: connects, registers, joins channels, delivers queued lines."""

    def __init__(self, server, channels, nick_base, realname, log, wait=None,
                 clock=time.monotonic, bucket=None):
        super().__init__(daemon=True, name="irc-" + server.label)
        self.server = server
        self.channels = list(channels)
        self.nick_base = nick_base
        self.realname = realname
        self.log = log
        self.clock = clock
        self.bucket = bucket or FloodBucket(clock=clock)
        self.stop_event = threading.Event()
        self.wait = wait or self.stop_event.wait
        self.quit_message = "bye"
        self.lock = threading.Lock()
        self.queue = collections.deque()
        self.dropped = 0
        self.attempts = 0
        self.sock = None
        self.buffer = b""
        self.nick = None
        self.nick_try = 1
        self.nick_limit = NICK_LIMITS[0]
        self.registered = False

    # -- public -------------------------------------------------------------

    def send_message(self, text):
        with self.lock:
            for channel in self.channels:
                if len(self.queue) >= QUEUE_LIMIT:
                    self.queue.popleft()
                    self.dropped += 1
                self.queue.append((channel, text))

    def close(self, quit_message, timeout=2.0):
        self.quit_message = quit_message
        self.stop_event.set()
        self.join(timeout)

    # -- thread body --------------------------------------------------------

    def run(self):
        while not self.stop_event.is_set():
            try:
                self._connect()
                self._session()
            except GiveUp as e:
                self.log("agent-irc: %s: giving up: %s" % (self.server.label, e))
                return
            except Exception as e:
                self.log("agent-irc: %s: %s" % (self.server.label, e))
            finally:
                self._close_socket()
            if self.stop_event.is_set():
                return
            delay = BACKOFF[min(self.attempts, len(BACKOFF) - 1)]
            self.attempts += 1
            self.log("agent-irc: %s: reconnecting in %ds" % (self.server.label, delay))
            self.wait(delay)

    def _connect(self):
        sock = socket.create_connection((self.server.host, self.server.port), timeout=REGISTRATION_TIMEOUT)
        if self.server.tls:
            context = ssl.create_default_context()
            if self.server.insecure:
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
            sock = context.wrap_socket(sock, server_hostname=self.server.host)
        sock.settimeout(REGISTRATION_TIMEOUT)
        self.sock = sock
        self.buffer = b""
        self.registered = False
        self.nick_try = 1
        self.nick_limit = NICK_LIMITS[0]
        if self.server.password:
            self._raw("PASS :" + self.server.password)
        self._send_nick()
        self._raw("USER %s 0 * :%s" % (self.server.user.replace(" ", "_"), self.realname))

    def _send_nick(self):
        self.nick = nick_candidate(self.nick_base, self.nick_try, self.nick_limit)
        self._raw("NICK " + self.nick)

    def _session(self):
        deadline = self.clock() + REGISTRATION_TIMEOUT
        while True:
            if self.stop_event.is_set():
                self._drain(self.clock() + 1.5)
                self._raw("QUIT :" + self.quit_message)
                return
            if not self.registered and self.clock() > deadline:
                raise ConnectionError("registration timed out")
            timeout = 0.2
            if self.registered:
                delay = self._pump()
                if delay > 0:
                    timeout = min(timeout, delay)
            self._read(timeout)

    def _drain(self, deadline):
        while self.registered and self.clock() < deadline:
            with self.lock:
                if not self.queue:
                    return
            delay = self._pump()
            if delay > 0:
                self._read(min(delay, max(deadline - self.clock(), 0.0)))

    def _pump(self):
        """Send queued lines as the bucket allows; return the delay until the next may go."""
        while True:
            with self.lock:
                if not self.queue:
                    return 0.0
                channel, text = self.queue[0]
            delay = self.bucket.acquire_delay()
            if delay > 0:
                return delay
            with self.lock:
                self.queue.popleft()
                dropped, self.dropped = self.dropped, 0
            self._raw("PRIVMSG %s :%s" % (channel, cut_bytes(text, MAX_PAYLOAD)))
            if dropped:
                self.send_message("… dropped %d lines" % dropped)

    def _read(self, timeout):
        sock = self.sock
        if not getattr(sock, "pending", lambda: 0)():
            readable, _, _ = select.select([sock], [], [], timeout)
            if not readable:
                return
        try:
            data = sock.recv(4096)
        except ssl.SSLWantReadError:
            return
        if not data:
            raise ConnectionError("connection closed by server")
        self.buffer += data
        while b"\n" in self.buffer:
            line, _, self.buffer = self.buffer.partition(b"\n")
            self._dispatch(line.rstrip(b"\r").decode("utf-8", errors="replace"))

    def _dispatch(self, line):
        prefix, command, params = parse_line(line)
        if command == "PING":
            self._raw("PONG :" + (params[-1] if params else ""))
        elif command == "001":
            self.registered = True
            self.attempts = 0
            self.log("agent-irc: %s: registered as %s" % (self.server.label, self.nick))
            for channel in self.channels:
                self._raw("JOIN " + channel)
        elif command == "433" and not self.registered:
            self.nick_try += 1
            if self.nick_try > MAX_NICK_TRIES:
                raise GiveUp("no free nick after %d tries" % MAX_NICK_TRIES)
            self._send_nick()
        elif command == "432" and not self.registered:
            if self.nick_limit != NICK_LIMITS[1]:
                self.nick_limit = NICK_LIMITS[1]
                self._send_nick()
            else:
                raise GiveUp("nick rejected: " + line)
        elif command == "NICK" and prefix and prefix.split("!")[0] == self.nick and params:
            self.nick = params[-1]
        elif command == "ERROR":
            raise ConnectionError(line)

    def _raw(self, line):
        data = line.replace("\r", " ").replace("\n", " ").encode("utf-8") + b"\r\n"
        self.sock.sendall(data)

    def _close_socket(self):
        sock, self.sock = self.sock, None
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
        self.registered = False
