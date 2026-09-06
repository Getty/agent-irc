import time
import unittest

from agent_irc.config import Server
from agent_irc.irc import FloodBucket, IrcConnection
from tests.fakeirc import FakeIrcServer


def fast_bucket():
    return FloodBucket(burst=1000, interval=0.001)


def wait_until(predicate, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.logs = []

    def server(self, fake, password=None):
        return Server("irc", "127.0.0.1", fake.port, "getty", password, False)

    def connect(self, fake, password=None, channels=("#a", "#b"), taken=()):
        conn = IrcConnection(self.server(fake, password), list(channels), "agent-irc", "claude e873 ~/dev/agent-irc",
                             self.logs.append, wait=lambda seconds: None, bucket=fast_bucket())
        conn.start()
        self.addCleanup(conn.close, "test over", 2.0)
        return conn

    def test_registration_join_privmsg_quit(self):
        fake = FakeIrcServer(password="s3cret")
        self.addCleanup(fake.close)
        conn = self.connect(fake, password="s3cret")
        self.assertTrue(fake.wait_for(lambda ls: "JOIN #b" in ls))
        lines = fake.lines()
        self.assertEqual(lines[:3], ["PASS :s3cret", "NICK agent-irc-1", "USER getty 0 * :claude e873 ~/dev/agent-irc"])
        self.assertEqual(conn.nick, "agent-irc-1")
        conn.send_message("▶ session e873ddde · claude · ~/dev/agent-irc")
        self.assertTrue(fake.wait_for(lambda ls: "PRIVMSG #b :▶ session e873ddde · claude · ~/dev/agent-irc" in ls))
        self.assertIn("PRIVMSG #a :▶ session e873ddde · claude · ~/dev/agent-irc", fake.lines())
        conn.close("session ended · 5.0s · 1 turns · 0 tools")
        self.assertTrue(fake.wait_for(lambda ls: "QUIT :session ended · 5.0s · 1 turns · 0 tools" in ls))
        self.assertFalse(conn.is_alive())

    def test_nick_in_use_increments(self):
        fake = FakeIrcServer(taken_nicks=["agent-irc-1", "agent-irc-2"])
        self.addCleanup(fake.close)
        conn = self.connect(fake)
        self.assertTrue(fake.wait_for(lambda ls: "JOIN #a" in ls))
        self.assertEqual([l for l in fake.lines() if l.startswith("NICK")],
                         ["NICK agent-irc-1", "NICK agent-irc-2", "NICK agent-irc-3"])
        self.assertEqual(conn.nick, "agent-irc-3")

    def test_erroneous_nick_shortens(self):
        fake = FakeIrcServer(max_nick=9)
        self.addCleanup(fake.close)
        conn = self.connect(fake)
        self.assertTrue(fake.wait_for(lambda ls: "JOIN #a" in ls))
        self.assertEqual(conn.nick, "agent-i-1")

    def test_ping_pong(self):
        fake = FakeIrcServer()
        self.addCleanup(fake.close)
        self.connect(fake)
        self.assertTrue(fake.wait_for(lambda ls: "JOIN #a" in ls))
        for c in list(fake.connections):
            fake._send(c, "PING :keepalive")
        self.assertTrue(fake.wait_for(lambda ls: "PONG :keepalive" in ls))

    def test_no_password_no_pass_line(self):
        fake = FakeIrcServer()
        self.addCleanup(fake.close)
        self.connect(fake)
        self.assertTrue(fake.wait_for(lambda ls: "JOIN #a" in ls))
        self.assertFalse(any(l.startswith("PASS") for l in fake.lines()))

    def privmsgs(self, fake, channel="#a"):
        head = "PRIVMSG %s :" % channel
        return [l[len(head):] for l in fake.lines() if l.startswith(head)]

    def test_long_payload_is_split_to_fit_the_line_the_receiver_gets(self):
        """Nothing is cut: the server's own ":nick!user@host " goes in front of
        what we send, and the whole of that has to fit the 512-byte line."""
        fake = FakeIrcServer()
        self.addCleanup(fake.close)
        conn = self.connect(fake, channels=("#a",))
        self.assertTrue(wait_until(lambda: conn.mask))  # learned from the echoed JOIN
        self.assertEqual(conn.mask, "agent-irc-1!u@h")
        self.assertEqual(conn.payload_limit("#a"), 512 - len(":agent-irc-1!u@h PRIVMSG #a :") - 2)
        conn.send_message("ä" * 300)
        self.assertTrue(wait_until(lambda: len(self.privmsgs(fake)) == 2))
        parts = self.privmsgs(fake)
        self.assertEqual("".join(parts), "ä" * 300)
        for part in parts:
            self.assertLessEqual(len(part.encode("utf-8")), conn.payload_limit("#a"))

    def test_isupport_linelen_is_used(self):
        fake = FakeIrcServer(isupport=("LINELEN=1024",))
        self.addCleanup(fake.close)
        conn = self.connect(fake, channels=("#a",))
        self.assertTrue(wait_until(lambda: conn.mask))
        self.assertEqual(conn.linelen, 1024)
        conn.send_message("ä" * 300)
        self.assertTrue(wait_until(lambda: self.privmsgs(fake)))
        self.assertEqual(self.privmsgs(fake), ["ä" * 300])  # 600 bytes, one line

    def test_nonsense_linelen_is_ignored(self):
        fake = FakeIrcServer(isupport=("LINELEN=12", "CHANTYPES=#"))
        self.addCleanup(fake.close)
        conn = self.connect(fake, channels=("#a",))
        self.assertTrue(wait_until(lambda: conn.registered and conn.isupport))
        self.assertEqual(conn.linelen, 512)
        self.assertEqual(conn.isupport["CHANTYPES"], "#")

    def test_continuation_keeps_the_body_indent(self):
        fake = FakeIrcServer(isupport=("LINELEN=140",))
        self.addCleanup(fake.close)
        conn = self.connect(fake, channels=("#a",))
        self.assertTrue(wait_until(lambda: conn.mask))
        conn.send_message("  " + " ".join(["word"] * 40))
        self.assertTrue(wait_until(lambda: len(self.privmsgs(fake)) >= 2))
        for part in self.privmsgs(fake):
            self.assertTrue(part.startswith("  "), part)
            self.assertLessEqual(len(part.encode("utf-8")), conn.payload_limit("#a"))

    def test_messages_before_registration_are_delivered_after(self):
        fake = FakeIrcServer()
        self.addCleanup(fake.close)
        conn = self.connect(fake, channels=("#a",))
        conn.send_message("early")
        self.assertTrue(fake.wait_for(lambda ls: "PRIVMSG #a :early" in ls))
        lines = fake.lines()
        self.assertLess(lines.index("JOIN #a"), lines.index("PRIVMSG #a :early"))

    def test_control_characters_are_stripped(self):
        fake = FakeIrcServer()
        self.addCleanup(fake.close)
        conn = self.connect(fake, channels=("#a",))
        self.assertTrue(fake.wait_for(lambda ls: "JOIN #a" in ls))
        conn.send_message("hello\x01\x03\x00world")
        self.assertTrue(fake.wait_for(lambda ls: any(l.startswith("PRIVMSG #a :") for l in ls)))
        line = [l for l in fake.lines() if l.startswith("PRIVMSG #a :")][0]
        self.assertEqual(line, "PRIVMSG #a :helloworld")

    def test_ircs_insecure_registers_and_delivers_over_tls(self):
        fake = FakeIrcServer(tls=True)
        self.addCleanup(fake.close)
        server = Server("ircs", "127.0.0.1", fake.port, "getty", None, True)
        conn = IrcConnection(server, ["#a"], "agent-irc", "claude e873 ~/dev/agent-irc",
                             self.logs.append, wait=lambda seconds: None, bucket=fast_bucket())
        conn.start()
        self.addCleanup(conn.close, "test over", 2.0)
        self.assertTrue(fake.wait_for(lambda ls: "JOIN #a" in ls))
        conn.send_message("secure hello")
        self.assertTrue(fake.wait_for(lambda ls: "PRIVMSG #a :secure hello" in ls))

    def test_ircs_secure_fails_certificate_verification(self):
        fake = FakeIrcServer(tls=True)
        self.addCleanup(fake.close)
        server = Server("ircs", "127.0.0.1", fake.port, "getty", None, False)
        # A paced wait keeps the reconnect loop from hammering the fake
        # server while the assertion below polls for the first failure.
        conn = IrcConnection(server, ["#a"], "agent-irc", "claude e873 ~/dev/agent-irc",
                             self.logs.append, wait=lambda seconds: time.sleep(0.05), bucket=fast_bucket())
        conn.start()
        self.addCleanup(conn.close, "test over", 2.0)
        self.assertTrue(wait_until(lambda: any(
            "CERTIFICATE_VERIFY_FAILED" in l or "certificate verify failed" in l for l in self.logs)))
        self.assertFalse(conn.registered)
        self.assertEqual(fake.lines(), [])

    def test_close_before_welcome_still_joins_and_quits(self):
        fake = FakeIrcServer(welcome_delay=0.4)
        self.addCleanup(fake.close)
        conn = self.connect(fake, channels=("#late",))
        conn.send_message("queued early")
        self.assertTrue(fake.wait_for(lambda ls: any(l.startswith("USER ") for l in ls)))
        conn.close("bye early", 3.0)   # 001 has not been sent yet (0.4 s delay)
        self.assertTrue(fake.wait_for(lambda ls: "QUIT :bye early" in ls))
        lines = fake.lines()
        self.assertIn("JOIN #late", lines)
        self.assertIn("PRIVMSG #late :queued early", lines)
        self.assertLess(lines.index("JOIN #late"), lines.index("PRIVMSG #late :queued early"))
        self.assertLess(lines.index("PRIVMSG #late :queued early"), lines.index("QUIT :bye early"))


if __name__ == "__main__":
    unittest.main()
