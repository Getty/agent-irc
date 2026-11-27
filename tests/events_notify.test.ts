// Port of tests/test_events_notify.py: describe = the Python TestCase, test = its method.
import { describe, expect, test } from "bun:test";
import { Session, parseTaskNotification, renderNotification } from "../src/events.js";

const HOME = "/home/g";
const CWD = "/home/g/dev/proj";
const clock = () => 1000.0;

const COMPLETED =
  "<task-notification>\n" +
  "<task-id>a0bcae15</task-id>\n" +
  "<tool-use-id>toolu_01Vk</tool-use-id>\n" +
  "<output-file>/tmp/tasks/a0bcae15.output</output-file>\n" +
  "<status>completed</status>\n" +
  '<summary>Agent "Vergleich CRD-Handling in K8s-Libraries" finished</summary>\n' +
  "<note>A task-notification fires each time this agent stops.</note>\n" +
  "<result>I have what I need.\nReport follows.</result>\n" +
  "</task-notification>";

const STOPPED =
  "<task-notification>\n" +
  "<task-id>a9d216</task-id>\n" +
  "<status>stopped</status>\n" +
  '<summary>No completion record was found for background agent "k118 Rollen-Import-Leak" ' +
  "after it was re-dispatched. Resume it via SendMessage.</summary>\n" +
  "</task-notification>";

describe("ParseTests", () => {
  test("test_plain_text_is_not_a_notification", () => {
    expect(parseTaskNotification("just a normal prompt")).toBeNull();
    expect(parseTaskNotification("<command-name>/foo</command-name>")).toBeNull();
  });

  test("test_fields_are_pulled_out", () => {
    const fields = parseTaskNotification(COMPLETED)!;
    expect(fields.status).toBe("completed");
    expect(fields.summary).toBe('Agent "Vergleich CRD-Handling in K8s-Libraries" finished');
    expect(fields.result).toBe("I have what I need.\nReport follows.");
  });
});

describe("RenderTests", () => {
  test("test_completed_activity_is_head_only", () => {
    expect(renderNotification(parseTaskNotification(COMPLETED)!, "activity", 120)).toEqual([
      '↩ agent "Vergleich CRD-Handling in K8s-Libraries" completed',
    ]);
  });

  test("test_completed_full_appends_the_result", () => {
    expect(renderNotification(parseTaskNotification(COMPLETED)!, "full", null)).toEqual([
      '↩ agent "Vergleich CRD-Handling in K8s-Libraries" completed',
      "  I have what I need.",
      "  Report follows.",
    ]);
  });

  test("test_stopped_full_appends_the_explaining_summary", () => {
    expect(renderNotification(parseTaskNotification(STOPPED)!, "full", null)).toEqual([
      '↩ agent "k118 Rollen-Import-Leak" stopped',
      "  No completion record was found for background agent " +
        '"k118 Rollen-Import-Leak" after it was re-dispatched. Resume it via SendMessage.',
    ]);
  });

  test("test_a_trivial_finished_summary_is_not_repeated_as_body", () => {
    const fields = { status: "completed", summary: 'Agent "X" finished', result: "" };
    expect(renderNotification(fields, "full", null)).toEqual(['↩ agent "X" completed']);
  });

  test("test_notification_without_a_quoted_name_falls_back_to_status_and_headline", () => {
    const fields = { status: "stopped", summary: "Background work could not be resumed.", result: "" };
    expect(renderNotification(fields, "activity", 120)).toEqual(["↩ stopped: Background work could not be resumed."]);
  });
});

describe("SessionIntegrationTests", () => {
  const prompt = (level: string, text: string) =>
    new Session("claude", level, CWD, HOME, { clock })
      .handle({ event: "UserPromptSubmit", session_id: "abc12345", cwd: CWD, prompt: text })
      .slice(1);

  test("test_a_notification_prompt_renders_as_a_notification_not_raw_xml", () => {
    expect(prompt("activity", COMPLETED)).toEqual(['↩ agent "Vergleich CRD-Handling in K8s-Libraries" completed']);
  });

  test("test_a_plain_prompt_is_still_a_prompt", () => {
    expect(prompt("activity", "please fix the bug")).toEqual(["» please fix the bug"]);
  });
});
