# agent-irc — CLAUDE.md

This is the **agent-irc** plugin, for Claude Code *and* Codex. It mirrors a
session's activity into IRC. Product documentation is in [README.md](README.md);
the design is `docs/superpowers/specs/2026-09-05-agent-irc-design.md`. This
file is guidance for working on the plugin itself.

## Shape

The session process is the plugin's own MCP server (`bin/agent-irc`). The
harness starts it at session start and kills it at session end; a harness
crash closes stdin and the server quits. Hooks are `mcp_tool` hooks that call
the server's single tool `event`. Nothing else runs.

```
.claude-plugin/plugin.json   Claude Code manifest
.codex-plugin/plugin.json    Codex manifest — same .mcp.json and hooks.json
.mcp.json                    the server: python3 ${CLAUDE_PLUGIN_ROOT}/bin/agent-irc
hooks/hooks.json             one file, both harnesses; unknown events are ignored
bin/agent-irc                entry point
agent_irc/text.py            string helpers            agent_irc/irc.py     connection thread
agent_irc/config.py          settings, trust, merge    agent_irc/mcp.py     JSON-RPC loop
agent_irc/usage.py           transcript readers        agent_irc/server.py  wiring
agent_irc/events.py          event → lines
tests/                       unittest; tests/fakeirc.py is the fake ircd
```

## Rules

- Python 3.9+, stdlib only. `tomllib` is imported inside a function with a
  fallback parser for the one table we need.
- The MCP loop is the only writer to stdout. Everything else logs to stderr.
- `tools/call` must return immediately. Formatting, transcript reads and IRC
  I/O happen on other threads.
- Never block, deny or rewrite anything in a hook. The hook returns no
  decision on any event.
- Tests: `python3 -m unittest discover tests`. No network beyond localhost.
- Conventional commits, `--signoff`.

## Two-harness traps

**Hook payloads carry no token counts.** Both harnesses leave them out. The
server reads the transcript named in the event. Claude Code writes one record
per content block, all with the same `requestId` and the same usage — sum per
distinct `requestId` or you count every response three times. Codex writes
`token_usage_record` with `turn_token_usage` per `turn_id`; take the last one
for the turn.

**SessionStart fires before MCP servers are connected**, in both harnesses.
The server announces the session itself on the first event that carries a
`session_id`, which is the first `UserPromptSubmit`.

**Placeholders.** `hooks.json` passes every field any event can carry. A field
missing from an event may arrive as an empty string or as the literal
`${name}`; `events.clean()` drops both.

**Trust.** Project-level config is honoured only when the harness trusts the
directory (Claude: `~/.claude.json` `projects[*].hasTrustDialogAccepted`,
Codex: `[projects."…"] trust_level = "trusted"`), inherited from ancestors.
Otherwise a cloned repo could point `full`-level prompts at its own server.

**Codex hooks need trust too.** Until the user accepts the hook trust prompt,
hooks are skipped silently. `codex exec` needs
`--dangerously-bypass-hook-trust`.

**`threading.Thread` owns `_handle`.** On Python 3.13 `Thread.__init__` sets an instance attribute `_handle`, which shadows any method of that name on a subclass; the connection thread's line handler is therefore called `_dispatch`. Do not name a `Thread` method `_handle`.

## Verified against real harnesses

Filled in by the live verification (plan Task 18). Each item records the
observed behaviour and the date.

| Item | Claude Code | Codex |
|---|---|---|
| `clientInfo.name` in `initialize` | | |
| `${tool_input}` substitution: object or string | | |
| absent field: empty string or literal placeholder | | |
| `server` reference for the plugin MCP server in `mcp_tool` hooks | `plugin:agent-irc:irc` | |
| `${CLAUDE_PLUGIN_ROOT}` substituted in `.mcp.json` args | | |
| MCP server started at session start, shared by subagents | | |
| hook-triggered `tools/call` passes without approval | | |
| `SessionEnd` reaches the server before stdin closes | | |
| `async: true` keeps delivery order | | |
