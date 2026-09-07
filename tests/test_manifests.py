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
        self.assertEqual(m["mcpServers"], "./.mcp.codex.json")
        self.assertEqual(m["hooks"], "./hooks/codex.json")

    def test_codex_mcp_json_is_a_self_locating_bootstrap(self):
        m = load(".mcp.codex.json")
        self.assertEqual(m["irc"]["command"], "python3")
        # "-I" (isolated mode) keeps the session cwd off sys.path -- without
        # it, a cloned repo with a top-level glob.py/runpy.py would shadow
        # the stdlib modules this bootstrap imports and execute on Codex
        # startup (see CLAUDE.md).
        self.assertEqual(m["irc"]["args"][0], "-I")
        self.assertEqual(m["irc"]["args"][1], "-c")
        code = m["irc"]["args"][2]
        self.assertIn("plugins", code)
        self.assertIn("agent-irc", code)
        self.assertIn("CODEX_HOME", code)
        self.assertNotIn("${", code)

    def test_codex_hooks_address_the_bare_server_name(self):
        # Live verification (2026-09-05, Codex 0.153.4) found that an
        # mcp_tool hook whose "server" is the plugin-qualified form used by
        # Claude Code ("plugin:agent-irc:irc") never calls tools/call at
        # all -- Codex silently marks the hook "Failed" with no diagnostic.
        # Codex wants the bare name declared in .mcp.codex.json instead.
        codex = load("hooks/codex.json")["hooks"]
        for event, groups in codex.items():
            for group in groups:
                for hook in group["hooks"]:
                    self.assertEqual(hook["server"], "irc", event)

    def test_codex_hooks_use_a_per_event_field_whitelist(self):
        # Live verification (2026-09-05, Codex 0.153.4) found a second,
        # independent failure mode: an mcp_tool hook's "input" template is
        # rejected outright -- again with no tools/call ever sent and no
        # diagnostic beyond "Failed" -- if it references a `${name}`
        # placeholder Codex doesn't statically recognize for that event.
        # Unlike Claude Code (which substitutes an empty string for a field
        # an event doesn't carry), Codex hard-fails the whole hook, and
        # "recognized" is narrower than "present in the event's own JSON":
        # agent_id/agent_type DO appear in Codex's raw PreToolUse/
        # PostToolUse payload for a subagent's own tool call (confirmed by
        # dumping it to a "type": "command" hook), yet using them in a
        # PreToolUse/PostToolUse *mcp_tool* template still hard-fails the
        # hook -- so each set below is only what was actually confirmed
        # live, via that same dump technique, to work for THAT hook type.
        # Separately (also live-confirmed, not covered by this test):
        # SubagentStart/SubagentStop's mcp_tool hooks never call tools/call
        # at all under Codex 0.153.4, with *any* input map including the
        # base fields alone -- a live, undiagnosed Codex limitation, not a
        # field-naming problem, so their fields are kept as the most useful
        # set on the chance a future Codex fixes the dispatch (see
        # CLAUDE.md). Interrupt, PermissionRequest and PostCompact could
        # not be triggered from `codex exec` and conservatively get only
        # the fields common to every other event.
        base = {"event", "session_id", "cwd", "transcript_path", "model", "turn_id"}
        fields = {
            "UserPromptSubmit": base | {"prompt"},
            "PreToolUse": base | {"tool_name", "tool_input", "tool_use_id"},
            "PostToolUse": base | {"tool_name", "tool_input", "tool_use_id"},
            "SubagentStart": base | {"agent_id", "agent_type"},
            "SubagentStop": base | {"agent_id", "agent_type", "agent_transcript_path", "last_assistant_message"},
            "Stop": base | {"last_assistant_message"},
            "Interrupt": base,
            "PermissionRequest": base,
            "PostCompact": base,
        }
        shared = load("hooks/hooks.json")["hooks"]
        codex = load("hooks/codex.json")["hooks"]
        self.assertEqual(set(codex), set(fields))
        for event, keys in fields.items():
            hook = codex[event][0]["hooks"][0]
            self.assertEqual(hook["type"], "mcp_tool", event)
            self.assertEqual(hook["tool"], "event", event)
            self.assertTrue(hook["async"], event)
            # Codex bounds Interrupt hooks at 3s and logs "warning: clamping
            # Interrupt hook timeout to 3s" on every session that asks for
            # more; asking for the bound it enforces keeps the run quiet.
            self.assertEqual(hook["timeout"], 3 if event == "Interrupt" else 5, event)
            self.assertEqual(set(hook["input"]), keys, event)
            # Every value codex does send stays the same substitution as the
            # shared Claude Code hooks file, just fewer keys -- except
            # Interrupt, which that file no longer declares (Claude Code has
            # no such event), so it is checked against the same convention.
            for key in keys:
                expected = ("${hook_event_name}" if key == "event" else "${%s}" % key)
                if event in shared:
                    expected = shared[event][0]["hooks"][0]["input"][key]
                self.assertEqual(hook["input"][key], expected, (event, key))

    def test_versions_match(self):
        import agent_irc
        self.assertEqual(load(".claude-plugin/plugin.json")["version"], agent_irc.__version__)
        self.assertEqual(load(".codex-plugin/plugin.json")["version"], agent_irc.__version__)

    def test_mcp_json(self):
        # The documented shape wraps the servers in "mcpServers" (plugins
        # reference, "MCP servers"). A bare {"irc": ...} map also loads in
        # 2.1.263, but nothing documents that, so the plugin ships the shape
        # the reference shows.
        m = load(".mcp.json")
        self.assertEqual(set(m), {"mcpServers"})
        self.assertEqual(m["mcpServers"]["irc"]["command"], "python3")
        self.assertEqual(m["mcpServers"]["irc"]["args"], ["${CLAUDE_PLUGIN_ROOT}/bin/agent-irc"])

    def test_hooks(self):
        # Interrupt is Codex's event, not Claude Code's: `claude plugin
        # validate` answers a shared file declaring it with "hooks.Interrupt:
        # unknown hook event; entry ignored at runtime", and the 2.1.263
        # binary contains no such string at all (checked 2026-09-07). It
        # lives in hooks/codex.json only.
        hooks = load("hooks/hooks.json")["hooks"]
        self.assertEqual(set(hooks), CLAUDE_EVENTS)
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
