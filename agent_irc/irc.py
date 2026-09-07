"""IRC connection thread: register, keep alive, deliver lines (spec §7)."""

import collections
import re
import select
import socket
import ssl
import threading
import time

from agent_irc.text import cut_bytes, wrap_payload

# RFC 1459: the whole line, CRLF included, must fit 512 bytes -- and the line
# the receiver has to fit is not the one we send: the server prepends our own
# ":nick!user@host " to it. Servers that allow more advertise LINELEN in their
# RPL_ISUPPORT (005); ergo and InspIRCd both do.
LINELEN = 512
MIN_PAYLOAD = 80  # a server claiming less room than this is not believed
# "!ident@host" at the RFC's worst case, used until the server has shown us the
# mask it actually puts in front of our messages.
UNKNOWN_USERHOST = 75
QUEUE_LIMIT = 500
# After 001 the server sends its ISUPPORT (005) in the same burst; the first
# pump waits this long for it, so a line queued before registration is split to
# the advertised LINELEN, not the 512 fallback. Bounded, because a server may
# send no ISUPPORT at all -- then the first pump proceeds on the fallback.
GREETING_GRACE = 0.5
BACKOFF = (5, 10, 20, 40, 60)
REGISTRATION_TIMEOUT = 30.0
NICK_LIMITS = (30, 9)
MAX_NICK_TRIES = 99

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")  # besides \r/\n, stripped from every line body before send


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
                 clock=time.monotonic, bucket=None, queue_limit=QUEUE_LIMIT):
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
        self.queue_limit = queue_limit
        self.dropped = 0
        self.attempts = 0
        self.sock = None
        self.buffer = b""
        self.nick = None
        self.nick_try = 1
        self.nick_limit = NICK_LIMITS[0]
        self.registered = False
        self.mask = None
        self.isupport = {}
        self.linelen = LINELEN
        self.pending = []
        self.greeting_deadline = None

    # -- public -------------------------------------------------------------

    def send_message(self, text, channels=None):
        """Queue one logical line for every channel (or just `channels`).

        The queue holds logical lines, not per-channel copies: a cap counting
        copies would drop twice as early on a two-channel connection, and drop
        a line from one channel while leaving it in the other.
        """
        with self.lock:
            if self.queue_limit and len(self.queue) >= self.queue_limit:
                self.queue.popleft()
                self.dropped += 1
            self.queue.append((channels, text))

    def begin_close(self, quit_message):
        """Ask the thread to drain, QUIT and exit; returns at once.

        close() = begin_close() + join().
        """
        self.quit_message = quit_message
        self.stop_event.set()

    def close(self, quit_message, timeout=2.0):
        self.begin_close(quit_message)
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
            # A partial TLS record can leave select() reporting the socket
            # readable while recv() still blocks waiting for the rest of
            # it. REGISTRATION_TIMEOUT (30s) on that recv would block the
            # stop path for up to 30s; 2s is enough for any real peer and
            # keeps _read()'s per-call timeout error bounded.
            sock.settimeout(2.0)
        else:
            sock.settimeout(REGISTRATION_TIMEOUT)
        self.sock = sock
        self.buffer = b""
        self.registered = False
        self.nick_try = 1
        self.nick_limit = NICK_LIMITS[0]
        self.mask = None
        self.isupport = {}
        self.linelen = LINELEN
        self.greeting_deadline = None
        with self.lock:
            # Chunks cut to the old connection's budget go back to the queue:
            # this server may answer with a different LINELEN than the last one.
            # Each goes back addressed to its own channel -- the other channels
            # on this connection already had that part.
            self.queue.extendleft(reversed([((channel,), part) for channel, part in self.pending]))
            self.pending = []
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
                self._finish()
                return
            if not self.registered and self.clock() > deadline:
                raise ConnectionError("registration timed out")
            timeout = 0.2
            if self.registered and self._greeting_settled():
                delay = self._pump()
                if delay > 0:
                    timeout = min(timeout, delay)
            self._read(timeout)

    def _greeting_settled(self):
        """True once the post-001 burst has had its chance: as soon as ISUPPORT
        (005) is in, or after GREETING_GRACE if the server sends none. Until
        then the first pump holds off so LINELEN is known before it splits."""
        if self.isupport:
            return True
        return self.greeting_deadline is not None and self.clock() >= self.greeting_deadline

    def _finish(self):
        """On stop: let registration in flight complete, flush the queue,
        quit, then wait for the peer to close -- all within one 1.5s budget.

        Without waiting for registration, a close() requested before the 001
        arrives would never read it, so the connection would quit without
        ever joining or delivering the messages already queued for it.
        Without waiting for the close afterwards, unread data left in the
        receive buffer (a delayed JOIN ack, the server's closing ERROR) makes
        Linux answer close() with an RST instead of a clean FIN, which can
        make the peer drop the very bytes -- JOIN, PRIVMSG, QUIT -- we just
        sent it.
        """
        deadline = self.clock() + 1.5
        while not self.registered and self.clock() < deadline:
            self._read(min(0.2, max(deadline - self.clock(), 0.0)))
        self._drain(deadline)
        self._raw("QUIT :" + self.quit_message)
        self._wait_for_close(deadline)

    def _wait_for_close(self, deadline):
        """Drain anything still arriving until the peer closes the
        connection, the shared stop deadline passes, or 0.5s elapses --
        whichever comes first.
        """
        stop = min(deadline, self.clock() + 0.5)
        try:
            while self.clock() < stop:
                self._read(min(0.2, max(stop - self.clock(), 0.0)))
        except ConnectionError:
            pass

    def _drain(self, deadline):
        while self.registered and self.clock() < deadline:
            with self.lock:
                if not self.queue and not self.pending:
                    return
            delay = self._pump()
            if delay > 0:
                self._read(min(delay, max(deadline - self.clock(), 0.0)))

    def _pump(self):
        """Send queued lines as the bucket allows; return the delay until the next may go.

        A queued line is one logical line; what goes on the wire is however many
        PRIVMSGs this server's line budget needs for it, each costing its own
        token from the flood bucket.
        """
        while True:
            with self.lock:
                if not self.pending:
                    if not self.queue:
                        return 0.0
                    channels, text = self.queue.popleft()
                    self.pending = [(channel, part)
                                    for channel in (self.channels if channels is None else channels)
                                    for part in wrap_payload(text, self.payload_limit(channel))]
                    if not self.pending:
                        continue
            delay = self.bucket.acquire_delay()
            if delay > 0:
                return delay
            with self.lock:
                channel, part = self.pending.pop(0)
                dropped = 0
                if not self.pending:
                    dropped, self.dropped = self.dropped, 0
            self._raw("PRIVMSG %s :%s" % (channel, part))
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
        except (ssl.SSLWantReadError, socket.timeout):
            return
        if not data:
            raise ConnectionError("connection closed by server")
        self.buffer += data
        while b"\n" in self.buffer:
            line, _, self.buffer = self.buffer.partition(b"\n")
            self._dispatch(line.rstrip(b"\r").decode("utf-8", errors="replace"))

    def payload_limit(self, channel):
        """Bytes of text this server relays to `channel` in one PRIVMSG.

        What has to fit is not the line we send but the one the receiver gets:
        the server prepends `:nick!user@host ` to it. We learn that mask from
        the JOIN the server echoes back to us and budget for the RFC's worst
        case until it arrives.
        """
        mask = self.mask or (self.nick or "") + "!" + "u" * UNKNOWN_USERHOST
        head = ":%s PRIVMSG %s :" % (mask, channel)
        return max(self.linelen - len(head.encode("utf-8")) - 2, MIN_PAYLOAD)

    def _note_isupport(self, tokens):
        """RPL_ISUPPORT: `TOKEN=value` or `TOKEN`, `-TOKEN` to take one back.

        The numeric ends in a human sentence ("are supported by this server")
        and begins with our own nick; neither is a token, and the sentence is
        the only part with spaces in it.
        """
        for token in tokens:
            if not token or " " in token:
                continue
            name, _, value = token.partition("=")
            if name.startswith("-"):
                self.isupport.pop(name[1:].upper(), None)
            else:
                self.isupport[name.upper()] = value
        self.linelen = self._advertised("LINELEN", LINELEN, low=128, high=65535)

    def _advertised(self, name, fallback, low, high):
        try:
            value = int(self.isupport.get(name, ""))
        except ValueError:
            return fallback
        return value if low <= value <= high else fallback

    def _dispatch(self, line):
        prefix, command, params = parse_line(line)
        if prefix and self.nick and prefix.split("!", 1)[0] == self.nick and "@" in prefix:
            self.mask = prefix  # our own JOIN, echoed back with the prefix the server uses
        if command == "PING":
            self._raw("PONG :" + (params[-1] if params else ""))
        elif command == "001":
            self.registered = True
            self.greeting_deadline = self.clock() + GREETING_GRACE
            self.attempts = 0
            self.log("agent-irc: %s: registered as %s" % (self.server.label, self.nick))
            for channel in self.channels:
                self._raw("JOIN " + channel)
        elif command == "005":
            self._note_isupport(params[1:])
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
            if self.mask:
                self.mask = self.nick + "!" + self.mask.split("!", 1)[-1]
        elif command == "ERROR":
            raise ConnectionError(line)

    def _raw(self, line):
        line = line.replace("\r", " ").replace("\n", " ")
        line = _CONTROL_RE.sub("", line)
        data = cut_bytes(line, self.linelen - 2).encode("utf-8") + b"\r\n"
        self.sock.sendall(data)

    def _close_socket(self):
        sock, self.sock = self.sock, None
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
        self.registered = False
