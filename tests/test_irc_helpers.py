import unittest

from agent_irc import irc
from agent_irc.config import Server
from agent_irc.irc import (LINELEN, FloodBucket, IrcConnection, nick_candidate,
                           parse_line)


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


class FloodBucketTests(unittest.TestCase):
    def test_burst_then_wait(self):
        clock = Clock()
        b = FloodBucket(burst=4, interval=2.0, clock=clock)
        self.assertEqual([b.acquire_delay() for _ in range(4)], [0.0, 0.0, 0.0, 0.0])
        self.assertAlmostEqual(b.acquire_delay(), 2.0)
        clock.t += 1.0
        self.assertAlmostEqual(b.acquire_delay(), 1.0)
        clock.t += 1.0
        self.assertEqual(b.acquire_delay(), 0.0)
        self.assertAlmostEqual(b.acquire_delay(), 2.0)

    def test_refill_caps_at_burst(self):
        clock = Clock()
        b = FloodBucket(burst=2, interval=1.0, clock=clock)
        clock.t += 100
        self.assertEqual([b.acquire_delay() for _ in range(3)], [0.0, 0.0, 1.0])

    def test_backward_clock_never_locks_the_bucket(self):
        clock = Clock()
        b = FloodBucket(burst=2, interval=1.0, clock=clock)
        self.assertEqual([b.acquire_delay() for _ in range(2)], [0.0, 0.0])
        clock.t -= 3600
        self.assertLessEqual(b.acquire_delay(), 1.0)
        clock.t += 1.0
        self.assertEqual(b.acquire_delay(), 0.0)


class ParseLineTests(unittest.TestCase):
    def test_prefix_and_trailing(self):
        self.assertEqual(parse_line(":srv 433 * agent-irc-1 :Nickname is already in use"),
                         ("srv", "433", ["*", "agent-irc-1", "Nickname is already in use"]))

    def test_ping(self):
        self.assertEqual(parse_line("PING :abc"), (None, "PING", ["abc"]))
        self.assertEqual(parse_line("PING abc"), (None, "PING", ["abc"]))

    def test_empty(self):
        self.assertEqual(parse_line(""), (None, "", []))

    def test_nick_change(self):
        self.assertEqual(parse_line(":old!u@h NICK :new"), ("old!u@h", "NICK", ["new"]))


class NickCandidateTests(unittest.TestCase):
    def test_suffix_and_truncation(self):
        self.assertEqual(nick_candidate("agent-irc", 1, 30), "agent-irc-1")
        self.assertEqual(nick_candidate("agent-irc", 12, 30), "agent-irc-12")
        self.assertEqual(nick_candidate("agent-irc", 1, 9), "agent-i-1")
        self.assertEqual(nick_candidate("a-very-long-project-name-indeed-x", 7, 30), "a-very-long-project-name-ind-7")
        self.assertEqual(nick_candidate("abc", 1, 2), "a-1")


class IsupportTests(unittest.TestCase):
    def conn(self):
        c = IrcConnection(Server("irc", "h", 6667, "u", None, False), ["#a"], "agent-irc", "rn", lambda m: None)
        c.nick = "agent-irc-1"
        return c

    def test_tokens_values_and_negation(self):
        c = self.conn()
        c._note_isupport(["agent-irc-1", "LINELEN=1024", "SAFELIST", "NICKLEN=32",
                          "are supported by this server"][1:])
        self.assertEqual(c.isupport, {"LINELEN": "1024", "SAFELIST": "", "NICKLEN": "32"})
        self.assertEqual(c.linelen, 1024)
        c._note_isupport(["-LINELEN"])
        self.assertNotIn("LINELEN", c.isupport)
        self.assertEqual(c.linelen, LINELEN)

    def test_implausible_linelen_falls_back(self):
        c = self.conn()
        for value in ("12", "0", "-5", "999999", "lots", ""):
            c._note_isupport(["LINELEN=" + value])
            self.assertEqual(c.linelen, LINELEN, value)

    def test_payload_limit_shrinks_with_the_mask_and_the_channel(self):
        c = self.conn()
        before = c.payload_limit("#a")
        c.mask = "agent-irc-1!~getty@10.20.23.1"
        self.assertEqual(c.payload_limit("#a"), 512 - len(":agent-irc-1!~getty@10.20.23.1 PRIVMSG #a :") - 2)
        self.assertGreater(c.payload_limit("#a"), before)  # the guess is the pessimistic one
        self.assertEqual(c.payload_limit("#a") - c.payload_limit("#agents"), len("gents"))

    def test_payload_limit_never_goes_below_the_floor(self):
        c = self.conn()
        c.linelen = 128
        self.assertEqual(c.payload_limit("#" + "x" * 60), 80)


class SendTimeoutTests(unittest.TestCase):
    """The socket timeout is set for reading; sending must not inherit it."""

    class Recorder:
        def __init__(self):
            self.timeout = None
            self.while_sending = []
            self.sent = []

        def settimeout(self, value):
            self.timeout = value

        def sendall(self, data):
            self.while_sending.append(self.timeout)
            self.sent.append(data)

    def conn(self, scheme="ircs"):
        c = IrcConnection(Server(scheme, "h", 6697, "u", None, False), ["#a"], "agent-irc", "rn",
                          lambda m: None)
        c.sock = self.Recorder()
        c.read_timeout = irc.TLS_READ_TIMEOUT
        c.sock.settimeout(c.read_timeout)
        return c

    def test_a_send_is_not_cut_short_by_the_read_timeout(self):
        """A TLS read may not block longer than 2s or the stop path hangs on
        it -- but that same timeout also bounds sendall, so a peer whose
        receive window is full for two seconds would kill the connection."""
        c = self.conn()
        c._raw("PRIVMSG #a :hello")
        self.assertEqual(c.sock.while_sending, [irc.SEND_TIMEOUT])
        self.assertGreater(irc.SEND_TIMEOUT, irc.TLS_READ_TIMEOUT)

    def test_the_read_timeout_is_back_in_place_after_a_send(self):
        c = self.conn()
        c._raw("PRIVMSG #a :hello")
        self.assertEqual(c.sock.timeout, irc.TLS_READ_TIMEOUT)


class QueueLimitTests(unittest.TestCase):
    def conn(self, channels=("#a",), **kw):
        return IrcConnection(Server("irc", "h", 6667, "u", None, False), list(channels), "agent-irc", "rn",
                             lambda m: None, **kw)

    def test_the_default_cap_drops_the_oldest(self):
        c = self.conn()
        for i in range(irc.QUEUE_LIMIT + 3):
            c.send_message("m%d" % i)
        self.assertEqual((len(c.queue), c.dropped), (irc.QUEUE_LIMIT, 3))

    def test_zero_means_no_cap(self):
        """At level full one Write can be thousands of lines -- a cap would drop
        exactly the part that makes full full."""
        c = self.conn(queue_limit=0)
        for i in range(irc.QUEUE_LIMIT + 300):
            c.send_message("m%d" % i)
        self.assertEqual((len(c.queue), c.dropped), (irc.QUEUE_LIMIT + 300, 0))

    def test_an_explicit_cap_is_honoured(self):
        c = self.conn(queue_limit=10)
        for i in range(13):
            c.send_message("m%d" % i)
        self.assertEqual((len(c.queue), c.dropped), (10, 3))

    def test_the_cap_counts_logical_lines_not_channel_copies(self):
        """A second channel must not halve the queue. One send_message is one
        line however many channels it goes to; a cap counting per-channel
        copies would drop twice as early and, worse, drop a line from one
        channel while keeping it in the other."""
        c = self.conn(channels=("#a", "#b"), queue_limit=10)
        for i in range(13):
            c.send_message("m%d" % i)
        self.assertEqual((len(c.queue), c.dropped), (10, 3))


if __name__ == "__main__":
    unittest.main()
