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
.codex-plugin/plugin.json    Codex manifest — its own .mcp.codex.json and hooks/codex.json
.mcp.json                    Claude Code server: python3 ${CLAUDE_PLUGIN_ROOT}/bin/agent-irc
.mcp.codex.json              Codex server: python3 -c bootstrap that globs $CODEX_HOME/plugins/cache/*/agent-irc/*/bin/agent-irc
hooks/hooks.json             Claude Code hooks (loaded by convention, not named in the manifest)
hooks/codex.json             Codex hooks: bare server name `irc`, one per-event field whitelist
                              (Codex rejects unknown ${…} placeholders), no SessionEnd
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

**Claude Code hook payloads carry no `model` at all.** The base hook-input
schema in `claude` 2.1.261 is `session_id`, `transcript_path`, `cwd` plus the
optional `prompt_id`, `permission_mode`, `agent_id`, `agent_type` and `effort`
— `model` is in none of them; only `PreModelSwitch`/`PostModelSwitch` carry
`from_model`/`to_model` (read out of the 2.1.261 binary's own schemas,
2026-09-05). `hooks/hooks.json`'s `"model": "${model}"` is therefore always an
empty string there and always dropped by `clean()`; Codex, by contrast, does
populate it. So on Claude Code the model can only come from the transcript —
and a *fresh* session has no assistant record yet when the first
`UserPromptSubmit` fires (measured on three real transcripts: the first record
naming a model lands 6s later, with the first assistant message), which is why
the `▶ session` line cannot name it. `Session._model_line` announces it as
`⇄ model …` on the first event where the transcript does name it, which in
practice is the first `PreToolUse` — the assistant message carrying the tool
call is written before the tool runs. That read goes through
`_Tail.peek()`/`peek_model()`, which reads only the last 256 KB and leaves the
offset alone: the turn totals are read exactly once, at `Stop`, and a peek that
consumed records would silently zero them.

**The line we send is not the line that has to fit.** A server relays our
`PRIVMSG #chan :text` as `:nick!user@host PRIVMSG #chan :text`, and it is
*that* line the 512-byte RFC 1459 limit (or the server's advertised `LINELEN`)
applies to. The sender therefore has to budget for a prefix it never writes.
`IrcConnection.payload_limit()` does it exactly: `LINELEN` from `RPL_ISUPPORT`
(005) when advertised, else 512, minus the mask, minus `PRIVMSG <channel> :`,
minus CRLF. The mask is not guessable — it is read off the `JOIN` the server
echoes back with our own prefix (`_dispatch` picks up any prefix whose nick is
ours) — so until it arrives a worst-case 76 bytes is assumed. This is also why
`events.py` must not split by bytes: only the connection knows its server's
limit, so the formatter emits *logical* lines of any length and `_pump()`
splits each into as many `PRIVMSG`s as that connection needs, one flood-bucket
token each, indent preserved on continuations. Two things follow: `_drain()`
has to check `pending` as well as `queue`, and a line is never truncated —
`cut_bytes` survives only as a last-resort guard in `_raw()` for the lines we
build ourselves (a long `QUIT` summary).

**`full` shortens nothing, which moves the real limit to the sender.**
`SUMMARY_LIMIT`/`PROMPT_LIMIT` apply below `full` only: there a tool call is
one line, so the whole input has to be folded into it and cut. At `full`
`Session.summary_limit` is `None`, `_head()` keeps the value's *first* line
whole (folding an 800-line file into the head would send it twice), and
`render_input()` puts the entire `tool_input` underneath -- every field, every
line, for every tool, not just the shell ones `_command_body()` used to
handle. A body of a single line is dropped: the head line already is that
line. What then decides whether those lines arrive is the connection, and its
defaults are sized for a public server: `FloodBucket(burst=4, interval=2.0)`
releases one line every two seconds and `QUEUE_LIMIT = 500` drops the oldest
beyond that, so a 600-line `Write` loses the first 107 lines and needs 20
minutes. Hence `flood_burst`, `flood_interval` and `queue_limit` (0 = never
drop) in the config, merged by `merge_layers` and handed to the connection by
`App._connect`. Remove `queue_limit = 0` from
`tests/test_end_to_end.py::test_full_level_sends_a_large_tool_input_whole`
and it fails with `… dropped 107 lines` -- that is the whole point of the
test.

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
solely to call `SessionEnd`. A process whose first event is `SessionEnd` has
no session to summarise — either it is that teardown reconnect, or a session
that never received a prompt, and by design (spec §3) a session without a
prompt never appears in IRC either way. `App._handle` recognizes a
`SessionEnd` as literally the first event a fresh process sees and stays
quiet instead of announcing anything.

**Codex substitutes nothing in a plugin's `.mcp.json`.** `${CLAUDE_PLUGIN_ROOT}`
and `${PLUGIN_ROOT}` arrive verbatim, the server starts in the session's cwd,
and no environment variable names the install root. The only thing the plugin
knows is its own name, so `.mcp.codex.json` runs an inline bootstrap that
globs the newest `plugins/cache/*/agent-irc/*/bin/agent-irc` under
`$CODEX_HOME` (default `~/.codex`). Verified live 2026-09-05 (Task 19): the
bootstrap works, the server starts and real events reach IRC. Codex also
refuses `mcp_tool` hooks on `SessionEnd`; `hooks/codex.json` leaves it out.

**Codex's `mcp_tool` hook must address the server by its bare name, not the
plugin-qualified form.** `hooks/hooks.json`'s `"server": "plugin:agent-irc:irc"`
addresses the server correctly for Claude Code, but under Codex 0.153.4 that
exact same value makes the hook silently never call `tools/call` at all — no
warning, no error, just `hook: X` immediately followed by `hook: X Failed` in
`codex exec`'s own text UI, verified with `RUST_LOG=debug` showing no
`tools/call` JSON-RPC message ever leaves the process. Codex wants the bare
name declared as the key in `.mcp.codex.json` (`"irc"`) instead. Verified live
2026-09-05 (Task 19): switching just this field is what turns the identical
"Failed" into "Completed" and produces the first real `tools/call`.

**Codex hard-fails an `mcp_tool` hook whose `input` references a placeholder
it doesn't recognise for that event — no partial substitution.** Unlike
Claude Code (which fills an absent field with `""`), Codex rejects the whole
hook, with the same silent `Failed`/no-`tools/call` symptom as the server
address bug above, if `input` contains `"${name}"` for a `name` that isn't
part of that specific event's own schema. This is *narrower* than "the field
is present in the event's JSON": a `type: "command"` hook dump showed
`agent_id`/`agent_type` genuinely present in a `PreToolUse` payload for a
subagent's own tool call, yet an `mcp_tool` hook using `"${agent_id}"` in
`PreToolUse`'s `input` still hard-fails every time, including the *main*
turn's tool calls where `agent_id` is legitimately absent. `hooks/codex.json`
therefore gives each event only the field names confirmed live (by dumping
the real payload to a temporary `command` hook) to be safe for that event —
see `tests/test_manifests.py`'s `test_codex_hooks_use_a_per_event_field_whitelist`
for the exact sets and how they were obtained. Interrupt, PermissionRequest
and PostCompact couldn't be triggered from `codex exec` and conservatively
get only the fields every other event was confirmed to share (`event`,
`session_id`, `cwd`, `transcript_path`, `model`, `turn_id`).

**`SubagentStart`/`SubagentStop` `mcp_tool` hooks never fire under Codex
0.153.4, regardless of `input` content.** Live-verified 2026-09-05 (Task 19):
spawning a real sub-agent (`spawn_agent` + `wait_agent`) produces no
`tools/call` and no IRC line for either event, with the base field set alone
(known-safe everywhere else), with the fuller `agent_id`/`agent_type` set, and
with no fields at all — so this is not the placeholder-whitelist bug above,
it looks like these two event types just aren't wired to the `mcp_tool` hook
dispatch path at all in this Codex version (`type: "command"` hooks for the
same two events, by contrast, do fire and were how the payload shapes above
were confirmed). No workaround found; `hooks/codex.json` keeps the fuller
field set anyway on the chance a future Codex build fixes the dispatch.
Because Codex runs one MCP server for the whole session regardless (see the
table below), the main turn's own tool calls and IRC lines are unaffected —
only subagent start/stop announcements are silently missing.

**Codex 0.153 limitations, summarized.** The traps above add up to three
things a Codex user sees in IRC that a Claude Code user doesn't: no `⇢`/`⇠`
subagent start/stop lines at all; a Codex subagent's own tool calls appear
as, and count toward, the *main* turn instead of the subagent, because
`agent_id` cannot be added to `PreToolUse`/`PostToolUse`'s field whitelist
without Codex hard-failing the hook; and `PermissionRequest`/`PostCompact`
carry only the base field set (no tool or trigger detail), since neither
event could be triggered live to confirm a wider whitelist is safe.

**Harnesses end the server by signal, not by EOF.** Task 19 assumed Codex's
missing closing line meant it drops the pipe without the `for raw in stdin`
loop ever observing an EOF; live re-verification (2026-09-05, Task 20) with
`RUST_LOG=debug` found the real mechanism instead: `MCP server stderr
(python3): agent-irc: signal 15, shutting down` — Codex just sends the
server a plain `SIGTERM` at session end, exactly like Claude Code. Neither
harness closes stdin. Claude Code sends `SIGINT` and, roughly 100ms later if
the process hasn't exited, escalates to `SIGTERM` (Task 18); that gap is
tight enough that, once the first signal is caught and `shutdown()` is
running, a second signal arriving mid-`join()` can unwind `shutdown()` via a
fresh exception before the connection thread `begin_close()` only *asked* to
send `QUIT` has actually written it — reproduced locally by sending SIGINT
then SIGTERM 0.1s apart against a real subprocess (failed 3/3 runs). Fix,
both live-verified 2026-09-05: `install_signal_handlers` in
`agent_irc/server.py` turns `SIGTERM`/`SIGINT`/`SIGHUP` into a `SystemExit`
raised in the main thread, so `mcp.serve`'s blocking stdin read unwinds
through `App.run()`'s `finally` into `shutdown()` regardless of which signal
arrived; and only the *first* signal raises — a later one just logs, so it
can't cut a `shutdown()` already in progress short before the `QUIT` is
written. `shutdown()` itself also gained an idempotency guard (`self.stopped`)
for the case where it might otherwise run twice. Covered by
`tests/test_end_to_end.py`'s `test_sigterm_sends_quit`, `test_sigint_sends_quit`
and `test_sigint_then_sigterm_still_sends_quit`, and
`tests/test_server.py::AppTests::test_shutdown_is_idempotent`.

## Verified against real harnesses

Filled in by the live verification (plan Task 18), 2026-09-05, against
`claude` 2.1.261 and `codex` 0.153.4; the Codex column was re-verified
2026-09-05 (Task 19) after the self-locating bootstrap and the hook fixes
below, and the `SessionEnd` row for both columns was re-verified again
2026-09-05 (Task 20) after adding signal handling. Each item records the
observed behaviour and the date; "not observed" means the prerequisite step
never produced the evidence (noted why).

| Item | Claude Code | Codex |
|---|---|---|
| `clientInfo.name` in `initialize` | `"claude-code"` (2026-09-05) | `"codex-mcp-client"` (2026-09-05); `detect_harness()` maps it to `"codex"` |
| `model` in the hook payload | absent from every event's schema (2026-09-05); the model comes from the transcript instead | present, and `hooks/codex.json` whitelists it for every event (2026-09-05) |
| `${tool_input}` substitution: object or string | string, JSON-encoded (`clean()` parses it) (2026-09-05) | same: a JSON-encoded string once inside the `mcp_tool` `input` template; confirmed by a correctly-formatted `⚙ Bash 0.1s: echo verify-ok` IRC line (2026-09-05) |
| absent field: empty string or literal placeholder | empty string, never `${name}` (2026-09-05) | not independently confirmed — Codex's per-event field whitelist (see trap above) is a static, all-or-nothing check, not a per-instance one; no test exercised a field that's valid for an event but unpopulated in one particular instance of it (2026-09-05) |
| `server` reference for the plugin MCP server in `mcp_tool` hooks | `plugin:agent-irc:irc` | must be the bare name from `.mcp.codex.json` (`"irc"`); the plugin-qualified form silently never calls `tools/call` (2026-09-05, see trap above) |
| `${CLAUDE_PLUGIN_ROOT}` substituted in `.mcp.json` args | yes, server starts and runs (2026-09-05) | n/a — Codex never substitutes it; `.mcp.codex.json`'s self-locating bootstrap works instead, confirmed live: server starts, `tools/list` succeeds, and real `tools/call` traffic for `UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`Stop` reaches IRC (2026-09-05) |
| MCP server started at session start, shared by subagents | yes — one process served the main turn and its Explore subagent's own tool call (2026-09-05) | yes — one `irc` MCP connection for the whole session served the main turn's `Bash` call and the spawned sub-agent's own `wait_agent`/tool calls alike (2026-09-05) |
| hook-triggered `tools/call` passes without approval | yes, no approval prompt across 5 runs, no config needed (2026-09-05) | yes, no approval prompt across every `codex exec --dangerously-bypass-hook-trust` run once the server-name and field-whitelist fixes were in place (2026-09-05) |
| `SessionEnd` reaches the server before stdin closes | no — never delivered to a live process: either a *fresh, stateless* reconnect that stays quiet (see trap above), or the original process ended by signal before any `SessionEnd` hook could fire; the harness kills the server with `SIGINT` then `SIGTERM` instead, and `install_signal_handlers` still sends the `QUIT` summary from there — confirmed live, real numbers, 4/4 runs (2026-09-05, Task 20, see trap above) | no — Codex rejects `mcp_tool` hooks on `SessionEnd` outright; the harness ends the server with a plain `SIGTERM` instead (not a dropped pipe, as Task 19 assumed), and `install_signal_handlers` sends the `QUIT` summary from there — confirmed live, real numbers, 3/3 runs (2026-09-05, Task 20, see trap above) |
| `async: true` keeps delivery order | not always: `PostToolUse` for a parent Agent tool call was observed to arrive before `SubagentStart` for the very subagent it spawned; handled without crashing (2026-09-05) | not observed the same way: `SubagentStart`/`SubagentStop` `mcp_tool` hooks never fired at all in any configuration tried, so there was nothing to compare ordering against (2026-09-05, see trap above) |
