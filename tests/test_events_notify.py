"""Harness-injected <task-notification> wrappers become one readable line (spec §8)."""

import unittest

from agent_irc.events import Session, parse_task_notification, render_notification

HOME = "/home/g"
CWD = "/home/g/dev/proj"


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


COMPLETED = (
    "<task-notification>\n"
    "<task-id>a0bcae15</task-id>\n"
    "<tool-use-id>toolu_01Vk</tool-use-id>\n"
    "<output-file>/tmp/tasks/a0bcae15.output</output-file>\n"
    "<status>completed</status>\n"
    '<summary>Agent "Vergleich CRD-Handling in K8s-Libraries" finished</summary>\n'
    "<note>A task-notification fires each time this agent stops.</note>\n"
    "<result>I have what I need.\nReport follows.</result>\n"
    "</task-notification>"
)

STOPPED = (
    "<task-notification>\n"
    "<task-id>a9d216</task-id>\n"
    "<status>stopped</status>\n"
    '<summary>No completion record was found for background agent "k118 Rollen-Import-Leak" '
    "after it was re-dispatched. Resume it via SendMessage.</summary>\n"
    "</task-notification>"
)


class ParseTests(unittest.TestCase):
    def test_plain_text_is_not_a_notification(self):
        self.assertIsNone(parse_task_notification("just a normal prompt"))
        self.assertIsNone(parse_task_notification("<command-name>/foo</command-name>"))

    def test_fields_are_pulled_out(self):
        fields = parse_task_notification(COMPLETED)
        self.assertEqual(fields["status"], "completed")
        self.assertEqual(fields["summary"], 'Agent "Vergleich CRD-Handling in K8s-Libraries" finished')
        self.assertEqual(fields["result"], "I have what I need.\nReport follows.")


class RenderTests(unittest.TestCase):
    def test_completed_activity_is_head_only(self):
        fields = parse_task_notification(COMPLETED)
        self.assertEqual(render_notification(fields, "activity", 120),
                         ['↩ agent "Vergleich CRD-Handling in K8s-Libraries" completed'])

    def test_completed_full_appends_the_result(self):
        fields = parse_task_notification(COMPLETED)
        self.assertEqual(render_notification(fields, "full", None),
                         ['↩ agent "Vergleich CRD-Handling in K8s-Libraries" completed',
                          "  I have what I need.",
                          "  Report follows."])

    def test_stopped_full_appends_the_explaining_summary(self):
        """A stopped notification carries its reason in the summary, not a result."""
        fields = parse_task_notification(STOPPED)
        self.assertEqual(render_notification(fields, "full", None),
                         ['↩ agent "k118 Rollen-Import-Leak" stopped',
                          "  No completion record was found for background agent "
                          '"k118 Rollen-Import-Leak" after it was re-dispatched. Resume it via SendMessage.'])

    def test_a_trivial_finished_summary_is_not_repeated_as_body(self):
        fields = {"status": "completed", "summary": 'Agent "X" finished', "result": ""}
        self.assertEqual(render_notification(fields, "full", None), ['↩ agent "X" completed'])

    def test_notification_without_a_quoted_name_falls_back_to_status_and_headline(self):
        fields = {"status": "stopped", "summary": "Background work could not be resumed.", "result": ""}
        self.assertEqual(render_notification(fields, "activity", 120),
                         ["↩ stopped: Background work could not be resumed."])


class SessionIntegrationTests(unittest.TestCase):
    def prompt(self, level, text):
        s = Session("claude", level, CWD, HOME, clock=Clock())
        return s.handle({"event": "UserPromptSubmit", "session_id": "abc12345", "cwd": CWD, "prompt": text})[1:]

    def test_a_notification_prompt_renders_as_a_notification_not_raw_xml(self):
        self.assertEqual(self.prompt("activity", COMPLETED),
                         ['↩ agent "Vergleich CRD-Handling in K8s-Libraries" completed'])

    def test_a_plain_prompt_is_still_a_prompt(self):
        self.assertEqual(self.prompt("activity", "please fix the bug"), ["» please fix the bug"])


if __name__ == "__main__":
    unittest.main()
