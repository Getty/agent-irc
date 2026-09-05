import json
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CLAUDE_EVENTS = {
    "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
    "SubagentStart", "SubagentStop", "Stop", "StopFailure", "PermissionRequest",
    "Notification", "PostCompact", "PostModelSwitch", "SessionEnd",
}
CODEX_ONLY_EVENTS = {"Interrupt"}
INPUT_KEYS = {
    "event", "session_id", "cwd", "transcript_path", "model", "turn_id",
    "agent_id", "agent_type", "agent_transcript_path", "tool_name",
    "tool_use_id", "tool_input", "prompt", "last_assistant_message", "message",
    "notification_type", "error_type", "error_message", "trigger", "reason",
    "source", "from_model", "to_model", "duration",
}


def load(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return json.load(f)


class ManifestTests(unittest.TestCase):
    def test_claude_manifest(self):
        m = load(".claude-plugin/plugin.json")
        self.assertEqual(m["name"], "agent-irc")
        self.assertEqual(m["mcpServers"], "./.mcp.json")
        # Claude Code auto-loads hooks/hooks.json from its standard location;
        # declaring it again in manifest.hooks makes Claude Code treat it as
        # an additional file pointing at the same path and log "Duplicate
        # hooks file detected", which flags the whole plugin's hook loading
        # as failed (observed live 2026-09-05, see CLAUDE.md).
        self.assertNotIn("hooks", m)

    def test_codex_manifest(self):
        m = load(".codex-plugin/plugin.json")
        self.assertEqual(m["name"], "agent-irc")
        self.assertEqual(m["mcpServers"], "./.mcp.json")
        self.assertEqual(m["hooks"], "./hooks/hooks.json")

    def test_versions_match(self):
        import agent_irc
        self.assertEqual(load(".claude-plugin/plugin.json")["version"], agent_irc.__version__)
        self.assertEqual(load(".codex-plugin/plugin.json")["version"], agent_irc.__version__)

    def test_mcp_json(self):
        m = load(".mcp.json")
        self.assertEqual(m["irc"]["command"], "python3")
        self.assertEqual(m["irc"]["args"], ["${CLAUDE_PLUGIN_ROOT}/bin/agent-irc"])

    def test_hooks(self):
        hooks = load("hooks/hooks.json")["hooks"]
        self.assertEqual(set(hooks), CLAUDE_EVENTS | CODEX_ONLY_EVENTS)
        for event, groups in hooks.items():
            for group in groups:
                for hook in group["hooks"]:
                    self.assertEqual(hook["type"], "mcp_tool", event)
                    self.assertEqual(hook["server"], "plugin:agent-irc:irc", event)
                    self.assertEqual(hook["tool"], "event", event)
                    self.assertTrue(hook["async"], event)
                    self.assertEqual(hook["timeout"], 5, event)
                    self.assertEqual(set(hook["input"]), INPUT_KEYS, event)
                    self.assertEqual(hook["input"]["event"], "${hook_event_name}")
        self.assertEqual(hooks["Notification"][0]["matcher"], "idle_prompt")


if __name__ == "__main__":
    unittest.main()
