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

**Claude Code auto-loads `hooks/hooks.json`; don't also declare it.** Declaring
`"hooks": "./hooks/hooks.json"` in `.claude-plugin/plugin.json` points at the
same file Claude Code loads automatically by convention. Claude Code then
logs `Duplicate hooks file detected: ... The standard hooks/hooks.json is
loaded automatically, so manifest.hooks should only reference additional
hook files` and marks that plugin's hook loading failed (verified live
2026-09-05: hooks still ran via the auto-discovered copy, but the error is
real and pointless). `.claude-plugin/plugin.json` has no `hooks` key;
`.codex-plugin/plugin.json` keeps it, since Codex needs it explicit.

**A harness can deliver `SessionEnd` to a brand-new, stateless process.**
Claude Code (`-p` mode) tears down the original MCP connection (SIGINT then
SIGTERM) right after the last turn, then reconnects a fresh server process
solely to call `SessionEnd`. That process never saw any of the session's
activity, so it must not announce a summary — `App._handle` recognizes a
`SessionEnd` as literally the first event a fresh process sees and stays
quiet instead of a false "0 turns · 0 tools" line.

**Codex won't substitute `${CLAUDE_PLUGIN_ROOT}` (or `${PLUGIN_ROOT}`) in
`.mcp.json`.** For a plugin registered via `"mcpServers": "./.mcp.json"`,
Codex 0.153.4 passes the string through literally, resolves a relative arg
against the *session's* cwd (not the plugin root), and exposes no
environment variable a plugin could read instead. The bundled server
therefore never starts under Codex; see spec §14 item 7 and the table below.

**Codex refuses `mcp_tool` hooks on `SessionEnd`.** Independent of the above:
`warning: skipping MCP tool hook ...: SessionEnd MCP hooks are not
supported`. Even a working server would never receive it from Codex via this
hook type.

## Verified against real harnesses

Filled in by the live verification (plan Task 18), 2026-09-05, against
`claude` 2.1.261 and `codex` 0.153.4. Each item records the observed
behaviour and the date; "not observed" means the prerequisite step never
produced the evidence (noted why).

| Item | Claude Code | Codex |
|---|---|---|
| `clientInfo.name` in `initialize` | `"claude-code"` (2026-09-05) | not observed: MCP handshake never completes (item 7) |
| `${tool_input}` substitution: object or string | string, JSON-encoded (`clean()` parses it) (2026-09-05) | not observed (item 7) |
| absent field: empty string or literal placeholder | empty string, never `${name}` (2026-09-05) | not observed (item 7) |
| `server` reference for the plugin MCP server in `mcp_tool` hooks | `plugin:agent-irc:irc` | `plugin:agent-irc:irc` — same value addresses the server correctly; only the server itself fails to start (2026-09-05) |
| `${CLAUDE_PLUGIN_ROOT}` substituted in `.mcp.json` args | yes, server starts and runs (2026-09-05) | no — confirmed broken; `${PLUGIN_ROOT}` and a `cwd`-based form also fail; no workaround found (2026-09-05) |
| MCP server started at session start, shared by subagents | yes — one process served the main turn and its Explore subagent's own tool call (2026-09-05) | not observed (item 7) |
| hook-triggered `tools/call` passes without approval | yes, no approval prompt across 5 runs, no config needed (2026-09-05) | not observed: blocked by item 7 before any approval gate is reached |
| `SessionEnd` reaches the server before stdin closes | reaches a *fresh, stateless* process (see trap above); fixed to stay silent instead of a false summary (2026-09-05) | no — Codex rejects `mcp_tool` hooks on `SessionEnd` outright (2026-09-05) |
| `async: true` keeps delivery order | not always: `PostToolUse` for a parent Agent tool call was observed to arrive before `SubagentStart` for the very subagent it spawned; handled without crashing (2026-09-05) | not observed (item 7) |
