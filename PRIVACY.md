# Privacy

agent-irc sends information about your coding session to the IRC servers and
channels **you** configure. Nothing else. There is no telemetry, no third
party, no phone-home.

What leaves the machine depends on `level`:

- `activity`: the first line of each prompt (200 characters), tool names with
  a short argument summary such as the first 120 characters of a shell
  command or a file path, durations, token counts, model names, the session's
  working directory, permission requests, error messages' first lines.
- `subactivity`: the same for tool calls inside subagents.
- `full`: additionally the complete text of every prompt and every final
  answer.

Tool outputs — file contents, command output — are never sent at any level.

Use `ircs://` so the transport is encrypted. Keep passwords in your user-level
settings, in `.claude/settings.local.json`, or in the environment via
`${VAR}`; a project file that is committed should not contain them.

The plugin reads: your harness settings files, the harness trust markers
(`~/.claude.json`, `~/.codex/config.toml`), and the session transcripts the
harness names in its hook events. It writes nothing to disk.
