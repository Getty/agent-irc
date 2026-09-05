import unittest

from agent_irc.irc import FloodBucket, nick_candidate, parse_line


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


if __name__ == "__main__":
    unittest.main()
