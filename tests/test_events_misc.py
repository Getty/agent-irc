import unittest

from agent_irc.events import Session

HOME = "/home/g"
CWD = "/home/g/dev/agent-irc"


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t

    def tick(self, seconds):
        self.t += seconds


class MiscEventTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.s = Session("claude", "activity", CWD, HOME, clock=self.clock)
        self.s.handle({"event": "UserPromptSubmit", "session_id": "abc12345", "cwd": CWD, "prompt": "go"})

    def ev(self, **kw):
        kw["session_id"] = "abc12345"
        return self.s.handle(kw)

    def test_stop_failure(self):
        self.assertEqual(self.ev(event="StopFailure", error_type="rate_limit", error_message="Too many\nrequests"),
                         ["✖ turn failed: rate_limit — Too many"])
        self.assertIsNone(self.s.turn_started)
        self.assertEqual(self.ev(event="StopFailure"), ["✖ turn failed: unknown"])

    def test_permission_request(self):
        self.assertEqual(self.ev(event="PermissionRequest", tool_name="Bash", tool_input={"command": "rm -rf build"}),
                         ["⚠ permission: Bash: rm -rf build"])
        self.assertEqual(self.ev(event="PermissionRequest", tool_name="mcp__x__y"), ["⚠ permission: y"])

    def test_notification_only_idle(self):
        self.assertEqual(self.ev(event="Notification", notification_type="idle_prompt", message="m"),
                         ["… waiting for input"])
        self.assertEqual(self.ev(event="Notification", notification_type="permission_prompt", message="m"), [])

    def test_interrupt_compact_model_switch(self):
        self.assertEqual(self.ev(event="Interrupt"), ["■ interrupted"])
        self.assertIsNone(self.s.turn_started)
        self.assertEqual(self.ev(event="PostCompact", trigger="auto"), ["⟲ compacted (auto)"])
        self.assertEqual(self.ev(event="PostCompact"), ["⟲ compacted (auto)"])
        self.assertEqual(self.ev(event="PostModelSwitch", from_model="claude-fable-5-1", to_model="claude-opus-5"),
                         ["⇄ model claude-fable-5-1 → claude-opus-5"])
        self.assertEqual(self.s.model, "claude-opus-5")
        self.assertEqual(self.ev(event="PostModelSwitch", to_model="claude-sonnet-5"),
                         ["⇄ model claude-opus-5 → claude-sonnet-5"])

    def test_unknown_event_is_ignored(self):
        self.assertEqual(self.ev(event="SomethingNew", foo="bar"), [])
        self.assertEqual(self.ev(), [])

    def test_summary_and_session_end(self):
        from agent_irc.usage import Usage
        self.s.total.add(Usage(input=1200000, cached=1000000, output=40000))
        self.s.total_tools = 412
        self.s.turns = 8
        self.clock.tick(4320)
        self.assertEqual(self.s.summary(), "1h12m · 8 turns · 412 tools · 1.2M in (1M cached) / 40k out")
        self.assertEqual(self.ev(event="SessionEnd", reason="prompt_input_exit"),
                         ["■ session ended (prompt_input_exit) · 1h12m · 8 turns · 412 tools · 1.2M in (1M cached) / 40k out"])
        self.assertTrue(self.s.ended)

    def test_summary_before_start(self):
        s = Session("claude", "activity", CWD, HOME, clock=self.clock)
        self.assertEqual(s.summary(), "0 turns · 0 tools")


if __name__ == "__main__":
    unittest.main()
