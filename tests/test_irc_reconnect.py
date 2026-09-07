import threading
import time
import unittest

from agent_irc import irc
from agent_irc.config import Server
from agent_irc.irc import FloodBucket, IrcConnection
from tests.fakeirc import FakeIrcServer


class ReconnectTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeIrcServer()
        self.addCleanup(self.fake.close)
        self.delays = []
        self.logs = []
        self.conn = IrcConnection(Server("irc", "127.0.0.1", self.fake.port, "u", None, False), ["#a"],
                                  "proj", "codex 01a ~/p", self.logs.append,
                                  wait=self.delays.append, bucket=FloodBucket(burst=10000, interval=0.0001))
        self.conn.start()
        self.addCleanup(self.conn.close, "bye", 2.0)

    def test_reconnects_and_delivers_queued_lines(self):
        self.assertTrue(self.fake.wait_for(lambda ls: "JOIN #a" in ls))
        self.fake.drop_all()
        self.assertTrue(self.fake.wait_for(lambda ls: ls.count("JOIN #a") == 2))
        self.conn.send_message("after reconnect")
        self.assertTrue(self.fake.wait_for(lambda ls: "PRIVMSG #a :after reconnect" in ls))
        self.assertEqual(self.delays[:1], [5])
        self.assertEqual(self.conn.attempts, 0)

    def test_backoff_sequence_when_server_is_gone(self):
        self.assertTrue(self.fake.wait_for(lambda ls: "JOIN #a" in ls))
        self.fake.close()
        deadline = 200
        while len(self.delays) < 6 and deadline:
            deadline -= 1
            time.sleep(0.02)
        self.assertEqual(self.delays[:6], [5, 10, 20, 40, 60, 60])

    def test_lines_queued_while_disconnected_are_delivered_after_rejoin(self):
        self.conn.close("unused", 2.0)
        gate = threading.Event()
        delays = []

        def gated_wait(seconds):
            delays.append(seconds)
            gate.wait(10)

        conn = IrcConnection(Server("irc", "127.0.0.1", self.fake.port, "u", None, False), ["#g"],
                             "proj", "codex 01a ~/p", self.logs.append,
                             wait=gated_wait, bucket=FloodBucket(burst=10000, interval=0.0001))
        conn.start()
        self.addCleanup(conn.close, "bye", 2.0)
        self.addCleanup(gate.set)
        self.assertTrue(self.fake.wait_for(lambda ls: "JOIN #g" in ls))
        self.fake.drop_all()
        deadline = time.time() + 5
        while not delays and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(delays, [5])            # the thread is in backoff: disconnected
        conn.send_message("queued while down")
        self.assertNotIn("PRIVMSG #g :queued while down", self.fake.lines())
        gate.set()
        self.assertTrue(self.fake.wait_for(lambda ls: ls.count("JOIN #g") == 2))
        self.assertTrue(self.fake.wait_for(lambda ls: "PRIVMSG #g :queued while down" in ls))
        lines = self.fake.lines()
        self.assertLess(lines.index("JOIN #g", lines.index("JOIN #g") + 1), lines.index("PRIVMSG #g :queued while down"))

    def test_queue_cap_drops_oldest_and_notes_it(self):
        # Fill the queue before the thread starts, so the cap is hit deterministically.
        self.conn.close("unused", 2.0)
        conn = IrcConnection(Server("irc", "127.0.0.1", self.fake.port, "u", None, False), ["#q"],
                             "proj", "codex 01a ~/p", self.logs.append,
                             wait=self.delays.append, bucket=FloodBucket(burst=10000, interval=0.0001))
        for i in range(irc.QUEUE_LIMIT + 5):
            conn.send_message("m%d" % i)
        self.assertEqual(conn.dropped, 5)
        conn.start()
        self.addCleanup(conn.close, "bye", 2.0)
        self.assertTrue(self.fake.wait_for(lambda ls: "PRIVMSG #q :… dropped 5 lines" in ls, timeout=15))
        lines = [l for l in self.fake.lines() if l.startswith("PRIVMSG #q")]
        self.assertEqual(lines[0], "PRIVMSG #q :m5")
        self.assertEqual(lines[-1], "PRIVMSG #q :… dropped 5 lines")
        self.assertIn("PRIVMSG #q :m%d" % (irc.QUEUE_LIMIT + 4), lines)
        self.assertNotIn("PRIVMSG #q :m4", lines)

    def test_a_cap_drops_whole_lines_not_single_channel_copies(self):
        """Every channel on a connection must see the same lines. A cap that
        counts per-channel copies drops the tail of one channel's stream while
        the other keeps it -- the two logs then disagree about what happened."""
        self.conn.close("unused", 2.0)
        conn = IrcConnection(Server("irc", "127.0.0.1", self.fake.port, "u", None, False), ["#q", "#r"],
                             "proj", "codex 01a ~/p", self.logs.append, queue_limit=11,
                             wait=self.delays.append, bucket=FloodBucket(burst=10000, interval=0.0001))
        for i in range(13):
            conn.send_message("m%d" % i)
        self.assertEqual(conn.dropped, 2)
        conn.start()
        self.addCleanup(conn.close, "bye", 2.0)
        self.assertTrue(self.fake.wait_for(lambda ls: "PRIVMSG #r :… dropped 2 lines" in ls, timeout=15))
        sent = self.fake.lines()
        q = [l.split(" :", 1)[1] for l in sent if l.startswith("PRIVMSG #q :")]
        r = [l.split(" :", 1)[1] for l in sent if l.startswith("PRIVMSG #r :")]
        self.assertEqual(q, r)
        self.assertEqual(q[0], "m2")


if __name__ == "__main__":
    unittest.main()
