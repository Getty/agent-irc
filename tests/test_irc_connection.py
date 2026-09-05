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

    def test_long_payload_is_cut(self):
        fake = FakeIrcServer()
        self.addCleanup(fake.close)
        conn = self.connect(fake, channels=("#a",))
        self.assertTrue(fake.wait_for(lambda ls: "JOIN #a" in ls))
        conn.send_message("ä" * 300)
        self.assertTrue(fake.wait_for(lambda ls: any(l.startswith("PRIVMSG #a :ä") for l in ls)))
        line = [l for l in fake.lines() if l.startswith("PRIVMSG #a :")][0]
        self.assertEqual(line, "PRIVMSG #a :" + "ä" * 200)

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
