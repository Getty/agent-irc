import unittest

from agent_irc.inbound import INBOX_LIMIT, Inbox, allowed, mentions, unwrap_ctcp


class AllowedTests(unittest.TestCase):
    def test_nothing_is_allowed_without_patterns(self):
        self.assertFalse(allowed("getty!getty@vhost.example", []))
        self.assertFalse(allowed("getty!getty@vhost.example", ()))

    def test_star_allows_everyone(self):
        self.assertTrue(allowed("getty!getty@vhost.example", ["*"]))
        self.assertTrue(allowed("stranger!x@somewhere", ["*"]))

    def test_host_pattern(self):
        patterns = ["*!*@vhost.example"]
        self.assertTrue(allowed("getty!getty@vhost.example", patterns))
        self.assertTrue(allowed("someone!other@vhost.example", patterns))
        self.assertFalse(allowed("getty!getty@evil.example", patterns))

    def test_matching_ignores_case(self):
        self.assertTrue(allowed("Getty!Getty@VHost.Example", ["getty!*@vhost.example"]))

    def test_any_pattern_may_match(self):
        patterns = ["op!*@a.example", "getty!*@b.example"]
        self.assertTrue(allowed("getty!getty@b.example", patterns))
        self.assertFalse(allowed("getty!getty@c.example", patterns))

    def test_a_pattern_matches_the_whole_mask_not_a_part_of_it(self):
        # "evil.example" as a pattern must not match by being contained in a mask
        self.assertFalse(allowed("getty!getty@vhost.example", ["vhost.example"]))

    def test_junk_patterns_are_ignored(self):
        self.assertFalse(allowed("getty!getty@vhost.example", [None, 7, {"a": 1}]))


class MentionTests(unittest.TestCase):
    def test_addressed_at_the_start(self):
        self.assertTrue(mentions("agent-irc-1: status?", "agent-irc-1"))

    def test_named_in_the_middle(self):
        self.assertTrue(mentions("i think agent-irc-1 is stuck", "agent-irc-1"))

    def test_case_is_ignored(self):
        self.assertTrue(mentions("AGENT-IRC-1 hello", "agent-irc-1"))

    def test_a_longer_word_is_not_a_mention(self):
        self.assertFalse(mentions("agent-irc-11 is the other one", "agent-irc-1"))
        self.assertFalse(mentions("xagent-irc-1", "agent-irc-1"))

    def test_punctuation_around_the_nick_still_counts(self):
        self.assertTrue(mentions("(agent-irc-1), look", "agent-irc-1"))
        self.assertTrue(mentions("ping agent-irc-1.", "agent-irc-1"))

    def test_nick_with_regex_characters(self):
        self.assertTrue(mentions("hey foo[bar], hi", "foo[bar]"))
        self.assertFalse(mentions("hey foo bar", "foo[bar]"))

    def test_no_nick_no_mention(self):
        self.assertFalse(mentions("anything", ""))


class CtcpTests(unittest.TestCase):
    def test_plain_text_passes_through(self):
        self.assertEqual(unwrap_ctcp("hello"), "hello")

    def test_action_becomes_a_readable_line(self):
        self.assertEqual(unwrap_ctcp("\x01ACTION waves at agent-irc-1\x01"), "* waves at agent-irc-1")

    def test_other_ctcp_is_dropped(self):
        self.assertIsNone(unwrap_ctcp("\x01VERSION\x01"))
        self.assertIsNone(unwrap_ctcp("\x01PING 12345\x01"))


class InboxTests(unittest.TestCase):
    def setUp(self):
        self.ticks = iter(range(1000))
        self.inbox = Inbox(clock=lambda: 1757000000 + next(self.ticks))

    def test_off_by_default(self):
        self.assertFalse(self.inbox.listening)
        self.assertFalse(self.inbox.add("getty!getty@vhost.example", "agent-irc-1", "hi"))
        self.assertIn("listen", self.inbox.report())

    def test_enabled_inbox_keeps_allowed_senders(self):
        self.inbox.enable(["*!*@vhost.example"])
        self.assertTrue(self.inbox.listening)
        self.assertTrue(self.inbox.add("getty!getty@vhost.example", "agent-irc-1", "carry on"))
        report = self.inbox.report()
        self.assertIn("carry on", report)
        self.assertIn("getty!getty@vhost.example", report)
        self.assertIn("dm", report)

    def test_a_channel_message_names_its_channel(self):
        self.inbox.enable(["*"])
        self.inbox.add("getty!getty@vhost.example", "#agents", "agent-irc-1: status?")
        self.assertIn("#agents", self.inbox.report())

    def test_report_drains(self):
        self.inbox.enable(["*"])
        self.inbox.add("getty!getty@vhost.example", "agent-irc-1", "once")
        self.assertIn("once", self.inbox.report())
        self.assertNotIn("once", self.inbox.report())

    def test_report_warns_that_the_content_is_untrusted(self):
        self.inbox.enable(["*"])
        self.inbox.add("getty!getty@vhost.example", "agent-irc-1", "hi")
        self.assertIn("Untrusted", self.inbox.report())

    def test_senders_outside_the_allowlist_are_dropped(self):
        self.inbox.enable(["getty!*@vhost.example"])
        self.assertFalse(self.inbox.add("stranger!x@elsewhere", "agent-irc-1", "rm -rf /"))
        self.assertNotIn("rm -rf", self.inbox.report())

    def test_listen_without_an_allowlist_accepts_nothing(self):
        logs = []
        self.inbox = Inbox(log=logs.append)
        self.inbox.enable([])
        self.assertFalse(self.inbox.add("getty!getty@vhost.example", "agent-irc-1", "hi"))
        self.assertTrue(any("listen_from" in line for line in logs), logs)

    def test_disable_turns_it_off_again(self):
        self.inbox.enable(["*"])
        self.inbox.disable()
        self.assertFalse(self.inbox.listening)
        self.assertFalse(self.inbox.add("getty!getty@vhost.example", "agent-irc-1", "hi"))

    def test_the_queue_is_bounded_and_says_what_it_dropped(self):
        inbox = Inbox(limit=3)
        inbox.enable(["*"])
        for i in range(5):
            inbox.add("getty!getty@vhost.example", "agent-irc-1", "message %d" % i)
        report = inbox.report()
        self.assertNotIn("message 0", report)
        self.assertNotIn("message 1", report)
        self.assertIn("message 4", report)
        self.assertIn("2 older", report)

    def test_the_drop_count_resets_with_the_report(self):
        inbox = Inbox(limit=1)
        inbox.enable(["*"])
        inbox.add("getty!getty@vhost.example", "agent-irc-1", "a")
        inbox.add("getty!getty@vhost.example", "agent-irc-1", "b")
        self.assertIn("1 older", inbox.report())
        inbox.add("getty!getty@vhost.example", "agent-irc-1", "c")
        self.assertNotIn("older", inbox.report())

    def test_an_empty_inbox_says_so(self):
        self.inbox.enable(["*"])
        report = self.inbox.report()
        self.assertIn("No", report)
        self.assertNotIn("Untrusted", report)

    def test_the_default_limit_is_bounded(self):
        self.assertTrue(0 < INBOX_LIMIT <= 1000)


if __name__ == "__main__":
    unittest.main()
