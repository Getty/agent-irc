# agent-irc — design

*Status: the design as built · written 2026-09-05, corrected 2026-09-08*

This is the design record, not the manual: [README.md](../../../README.md)
documents the plugin as it ships. Where a real harness disagreed with the
design, the text is corrected inline below and marked
**[corrected]**; every open question of §14 has since been answered live, and
the answers -- with the traps that came with them -- live in
[CLAUDE.md](../../../CLAUDE.md).

`agent-irc` is a plugin for Claude Code **and** Codex that mirrors a coding
session's activity into IRC: what the agent is doing, what it costs, how long
things take, and what its subagents consumed. One IRC nick per session, lines
in one or more channels, optionally the full prompt and answer texts.

The plugin has no external dependencies: Python 3.9+ standard library only,
same house style as `briefing`.

## 1. Goals

- Show a session's activity live in IRC: session start/end, prompts, tool
  calls with duration, subagent start/stop with duration and token usage, turn
  end with duration and token usage, permission requests, failures,
  compaction, model switches.
- Work identically for Claude Code and Codex from one code base.
- Configure everything inside the harnesses' own config files, with
  per-project override and per-project additions.
- Support an ircd connection password and TLS.
- Never slow a session down and never break one: every failure is logged and
  swallowed.

## 2. Non-goals (v1)

- No commands from IRC back into the session. Read-only mirror.
  **[corrected in 0.2.0]** Still nothing is *sent* to IRC and nothing wakes a
  session, but an opt-in `listen` collects DMs and mentions for the agent to
  fetch with a `read_messages` tool. The mirror stays one-way; the inbox is a
  pull. See README's "Listening back" and `agent_irc/inbound.py`.
- No cost in currency. Token counts only; pricing tables are not maintained.
- No SASL or NickServ. The ircd `PASS` password is the only authentication.
- No channel keys (`JOIN #chan key`).
- No live reload of configuration during a session.
- No mIRC colour codes.

## 3. Architecture

```
harness (claude / codex)
  │  spawns at session start, kills at session end
  ├── plugin MCP server  ── bin/agent-irc ──┐   one process per session
  │      stdio, JSON-RPC                     │   holds the IRC connections
  │                                          │
  └── hooks (type: mcp_tool) ── tools/call ──┘   one call per event, no
        UserPromptSubmit, PreToolUse,            hook processes at all
        PostToolUse, SubagentStart, ...
                                             ▼
                                  IRC server(s)  ← one connection per
                                  #agents #log     distinct server URL
```

**The session client is the plugin's MCP server.** Both harnesses start a
plugin-bundled stdio MCP server when the session starts and stop it when the
session ends. There is no detached process, no watchdog, no socket, no PID
discovery. **[corrected]** The design assumed a dying harness closes stdin;
neither does. Both end the server with a signal, which `install_signal_handlers`
catches to run the same shutdown.

**Every hook is an `mcp_tool` hook** that calls the server's `event` tool
with the fields of the hook payload -- the only tool a hook ever calls; the
opt-in `read_messages` of §6.1 is called by the agent itself. Both harnesses
support this hook type with `${field}` substitution from the payload. Formatting, transcript
reading and IRC I/O all happen inside the server.

**The IRC connection is opened lazily** on the first event that carries a
`session_id` (the first `UserPromptSubmit`). `SessionStart` fires before MCP
servers are connected in both harnesses, so the server announces the session
itself. A session that never receives a prompt never appears in IRC.

### Plan B

If `mcp_tool` hooks turn out unusable in one harness (see §14), that harness
falls back to `command` hooks talking to the same server over a Unix socket
under `$XDG_RUNTIME_DIR/agent-irc/`. Only the transport changes; formatting
and IRC code are shared. This is not built unless needed.

## 4. Plugin layout

```
.claude-plugin/plugin.json     Claude Code manifest: mcpServers + hooks
.codex-plugin/plugin.json      Codex manifest: "mcpServers": "./.mcp.json", hooks
.mcp.json                      the one MCP server, "irc", command bin/agent-irc
hooks/hooks.json               mcp_tool hooks for both harnesses (split into
                               hooks/claude.json + hooks/codex.json only if the
                               server reference must differ, see §14)
bin/agent-irc                  entry point: python3, adds plugin root to sys.path
agent_irc/__init__.py          version
agent_irc/mcp.py               stdio JSON-RPC loop, tool registration
agent_irc/config.py            config discovery, merge, URL parsing, trust
agent_irc/irc.py               IRC connection, registration, flood control
agent_irc/events.py            event → lines, session/turn/subagent state
agent_irc/usage.py             transcript readers for Claude and Codex
agent_irc/text.py              truncation, splitting, path shortening
tests/                         unittest, stdlib only
README.md  CLAUDE.md  PRIVACY.md  CHANGELOG.md  LICENSE
```

The MCP server name is `irc`, the plugin name `agent-irc`, so Claude Code
addresses it as `plugin:agent-irc:irc` and the model sees the tool as
`mcp__plugin_agent-irc_irc__event`.

## 5. Configuration

### 5.1 Where

Each harness reads its own files. The plugin reads them itself; it does not
rely on the harness merging anything.

| Level | Claude Code | Codex |
|---|---|---|
| user | `~/.claude/settings.json` | `~/.codex/config.toml` |
| project | `<cwd>/.claude/settings.json` | `<cwd>/.codex/config.toml` |
| project local | `<cwd>/.claude/settings.local.json` | — |

Levels are processed in that order, user first. `<cwd>` is the session's
working directory as reported in the event payload.

**[corrected in 0.2.0]** The user-level directory is the one the harness
itself uses: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` move it, and the plugin
follows (`config.config_home`). Codex, though, does not pass `CODEX_HOME` on
to the MCP server it starts, so there the variable never reaches the plugin
and `~/.codex` is read regardless -- see `CLAUDE.md`.

Both harnesses tolerate an unknown key. Verified: `claude doctor` and
`codex doctor` load files containing the namespace without complaint.

### 5.2 Namespace and keys

Claude Code, JSON:

```json
{
  "agent-irc": {
    "channels": ["ircs://getty:${IRCD_PASSWORD}@irc.example.org:6697/#agents"],
    "log_channels": ["ircs://getty:${IRCD_PASSWORD}@irc.example.org:6697/#log"],
    "level": "activity"
  }
}
```

Codex, TOML:

```toml
[agent-irc]
channels = ["ircs://getty:${IRCD_PASSWORD}@irc.example.org:6697/#agents"]
log_channels = ["ircs://getty:${IRCD_PASSWORD}@irc.example.org:6697/#log"]
level = "activity"
```

| Key | Type | Meaning |
|---|---|---|
| `channels`, `<name>_channels` | list of URL strings | a named channel list; any key matching `^([a-z0-9]+_)?channels$` |
| `level` | `"activity"` (default), `"subactivity"` or `"full"` | how much to send, see §8; each level includes the ones before it |
| `flood_burst`, `flood_interval`, `queue_limit` | integer ≥ 1, number ≥ 0, integer ≥ 0 | the sending rate and queue cap of §7: lines that may go out back to back (default 4), seconds per line after that (2.0), lines that may wait (500; `0` never drops). Added when `full` turned out to send more than a public server's rate delivers |
| `listen` | boolean, default `false` | **[0.2.0]** keep direct messages and mentions for the `read_messages` tool (§6.1, §7) |
| `listen_from` | list of `nick!user@host` patterns | **[0.2.0]** who is accepted: `fnmatch` wildcards, case-insensitive, matched against the whole mask; empty accepts nobody |

Anything else in the namespace is ignored, and so is a value of the wrong
type; the last valid value across the levels wins.

### 5.3 Merge rules

- **Every channel list is resolved by name.** The most specific level that
  defines a name wins for that name, whole list.
- **The targets are the union of all resolved lists.**
- `level`: most specific level wins.

So *replace* means reusing a name at a more specific level, *add* means using
a new name. `channels` is not special; it is just the name you use when you do
not need several lists.

With user-level `channels = [A/#agents]` and `log_channels = [A/#log]`:

| project sets | result |
|---|---|
| nothing | A/#agents, A/#log |
| `simpici_channels = [A/#simpici]` | A/#agents, A/#log, A/#simpici |
| `channels = [B/#foo]` | B/#foo, A/#log |
| `channels = [B/#foo]`, `log_channels = []` | B/#foo only |
| `channels = []`, `log_channels = []` | silent |

Duplicate targets (same server, same channel) collapse to one. Entries for the
same server (§5.4 identity) share one connection that joins all their
channels.

### 5.4 URL format

```
irc://[user[:password]@]host[:port]/channel[?insecure=1]
ircs://[user[:password]@]host[:port]/channel[?insecure=1]
```

- `irc` is plaintext, default port 6667. `ircs` is TLS, default port 6697.
- `user` becomes the IRC username in `USER` (visible in the hostmask
  `nick!user@host`). Default: the local login name.
- `password` is sent as `PASS` before registration. Absent: no `PASS`.
- `channel` is the path, with or without a leading `#`; `agents` and `#agents`
  are the same. `&`, `+`, `!` prefixes are kept as given. A literal `#` in the
  path is accepted even though URL grammar calls it a fragment; the plugin
  parses the URL itself and never uses `urllib` for the path.
- `?insecure=1` disables certificate verification for `ircs`.
- **Server identity** for connection sharing: scheme, host, port, user,
  password.
- `${NAME}` anywhere in the string is replaced from the MCP server's
  environment. An unset variable drops the entry with a log line; the plugin
  never connects with a literal placeholder.

Percent-encoding is honoured in user and password (`%40` → `@`).

### 5.5 Trust

A cloned repository must not be able to redirect a session's activity, at
`full` level including prompts, to a server it chose. Project-level files are
therefore honoured only when the harness itself trusts the directory,
following the same rule the harnesses apply to their own project settings:

- Claude Code: `~/.claude.json` → `projects[<path>].hasTrustDialogAccepted`
  is `true` for `<cwd>` or any ancestor directory.
- Codex: `~/.codex/config.toml` → `[projects."<path>"] trust_level =
  "trusted"` for `<cwd>` or any ancestor directory.

**[corrected in 0.2.0]** Both markers move with the config directory of §5.1:
`<CLAUDE_CONFIG_DIR>/.claude.json` when that file exists (Claude Code moves
it there along with the rest), `$CODEX_HOME/config.toml` when the variable is
set.

Both markers were verified to be inherited from ancestors (`/home/getty/dev`
covers its subdirectories). Untrusted: project and local files are ignored,
one log line on stderr says so. Unreadable marker file: treated as untrusted.

### 5.6 TOML parsing

`tomllib` is Python 3.11+. On older interpreters a minimal parser reads
exactly the `[agent-irc]` table: **[corrected]** string, boolean and number
values and string arrays (single or multi-line), until the next table header
-- every value type a key of §5.2 can take, because a type the parser does not
know is dropped silently there, and that happened twice (`CLAUDE.md`).
Everything else in the file is skipped. Also used for the `[projects."…"]` trust lookup, which is one key.

## 6. Transport

### 6.1 MCP server

`bin/agent-irc` speaks the MCP subset both harnesses need over stdio,
newline-delimited JSON-RPC 2.0:

| method | response |
|---|---|
| `initialize` | `protocolVersion` echoed from the request, `capabilities: {tools: {}}`, `serverInfo: {name: "agent-irc", version}` |
| `notifications/initialized` | none |
| `ping` | `{}` |
| `tools/list` | `event`; **[0.2.0]** plus `read_messages` when `listen` is on -- decided at `initialize` from the config read off the process's own cwd, because the harness asks before any event names a session |
| `tools/call` `event` | `{content: [], isError: false}` immediately |
| `tools/call` `read_messages` | **[0.2.0]** the waiting inbound messages as one text block, headed by a note that it is untrusted data, and the inbox emptied (§7, §11) |
| anything else | error `-32601` |

The `event` tool's description is *"Transport for agent-irc hooks. Not for
direct use."* Its `inputSchema` is an object with `event` required and
`additionalProperties: true`.

`tools/call` only appends the arguments to an internal queue and returns. A
single dispatcher thread consumes the queue in order: formats lines, reads
transcripts when needed, hands lines to the IRC connections. Event order is
preserved and the stdio loop never blocks on IRC or disk.

The harness is detected from `clientInfo.name` in `initialize` and shown as
`claude` or `codex` when the name contains one of those words; any other name
is shown verbatim. The exact names both harnesses send are recorded in
`CLAUDE.md` once observed (§14). **[corrected]** A signal -- not stdin EOF, and
not a `SessionEnd` event -- means the harness is done with us: every connection
sends `QUIT` with the session summary; the dispatcher drain and the connection
joins each have a two-second budget, four seconds worst case.

Log output goes to stderr only, which the harnesses capture in their MCP logs.
`AGENT_IRC_DEBUG=1` makes it verbose.

### 6.2 Hooks

`hooks/hooks.json` registers one `mcp_tool` hook per event, all with the same
`input` map that names every field any event can carry:

```json
{
  "type": "mcp_tool",
  "server": "plugin:agent-irc:irc",
  "tool": "event",
  "async": true,
  "timeout": 5,
  "input": {
    "event": "${hook_event_name}",
    "session_id": "${session_id}",
    "cwd": "${cwd}",
    "transcript_path": "${transcript_path}",
    "model": "${model}",
    "turn_id": "${turn_id}",
    "agent_id": "${agent_id}",
    "agent_type": "${agent_type}",
    "agent_transcript_path": "${agent_transcript_path}",
    "tool_name": "${tool_name}",
    "tool_use_id": "${tool_use_id}",
    "tool_input": "${tool_input}",
    "prompt": "${prompt}",
    "last_assistant_message": "${last_assistant_message}",
    "message": "${message}",
    "notification_type": "${notification_type}",
    "error_type": "${error_type}",
    "error_message": "${error_message}",
    "trigger": "${trigger}",
    "reason": "${reason}",
    "source": "${source}",
    "from_model": "${from_model}",
    "to_model": "${to_model}",
    "duration": "${duration}"
  }
}
```

The server treats an empty string or an unreplaced `${…}` literal as "field
absent". If a harness rejects unresolved placeholders (§14), the map is split
per event; the server code does not change.

Events subscribed:

| Claude Code | Codex |
|---|---|
| UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, Stop, StopFailure, PermissionRequest, Notification (matcher `idle_prompt`), PostCompact, PostModelSwitch, SessionEnd | UserPromptSubmit, PreToolUse, PostToolUse, SubagentStart, SubagentStop, Stop, Interrupt, PermissionRequest, PostCompact, SessionEnd |

Each harness ignores event names it does not know, so one file can carry
both lists. The hook returns no decision on any event; `Stop`,
`PermissionRequest` and `PreToolUse` are observed, never influenced.

## 7. IRC client

- **One connection per server identity** (§5.4), one thread each, own send
  queue. Connections are opened on the first event with a `session_id`.
- **Registration:** `PASS` if set, `NICK`, `USER <user> 0 * :<realname>`.
  Realname: `<harness> <session_id> <cwd>`. On `001` join every channel of
  that server. `PING` is answered. Registration timeout 30 s.
- **Nick:** `<project>-<n>`. `project` is the basename of `cwd`, lowercased,
  every character outside `[a-z0-9-]` replaced by `-`, runs collapsed, edges
  trimmed, prefixed with `p-` if it starts with a digit. `n` starts at 1 and
  is incremented on `433` (nick in use), giving concurrent sessions of one
  project consecutive numbers. The first attempt truncates `project` so the
  nick fits 30 characters; on `432` (erroneous nick) it retries at 9. After
  99 collisions the connection gives up with a log line.
- **TLS:** `ssl.create_default_context()`; `insecure=1` disables verification
  and hostname checking. SNI is sent.
- **Reconnect:** on any disconnect the thread retries with backoff 5, 10, 20,
  40, 60, 60… seconds until the session ends. The send queue keeps the last
  `queue_limit` lines (§5.2; default 500, `0` unlimited) across reconnects;
  beyond that the oldest are dropped and one `… dropped N lines` is queued.
  **[corrected]** It holds logical lines, not per-channel copies: a cap
  counting copies dropped twice as early on a two-channel connection (0.1.1).
- **Flood control:** token bucket per connection, `flood_burst` lines back
  to back, then one every `flood_interval` seconds (§5.2; defaults 4 and 2.0,
  sized for a public server). Every line goes as `PRIVMSG` to every channel of
  the connection, each copy counts against the bucket.
- **Line length:** negotiated per connection, never guessed. What has to fit
  is not the line the client sends but the one the server relays, with our own
  `:nick!user@host ` in front of it: `LINELEN` from the server's `RPL_ISUPPORT`
  (005) when it advertises one, else the RFC 1459 512 bytes, minus that prefix,
  minus `PRIVMSG <channel> :`, minus the CRLF. The mask is read off the `JOIN`
  the server echoes back to us; until it arrives the RFC's worst case
  (`nick` + 76 bytes) is assumed, and a server advertising less than 80 bytes
  of room is not believed. A queued line longer than the budget is **split**
  into as many `PRIVMSG`s as it needs, at word boundaries, each keeping the
  line's leading indent, each costing its own token from the flood bucket —
  never cut. §8 says what gets shortened with `…` before it ever gets here.
- **Inbound** **[0.2.0]**: with `listen` on, a `PRIVMSG` addressed to our
  nick, or to a channel with our nick in it as a whole word, goes to the inbox
  (`agent_irc/inbound.py`) if the sender's `nick!user@host` matches
  `listen_from`; a CTCP `ACTION` arrives as `* …`, any other CTCP is dropped,
  and our own lines are never taken. The inbox holds 200 messages in memory,
  drops the oldest beyond that and says so on the next read. Nothing is
  written back.
- **Quit:** `QUIT :<summary>` where the summary is
  `session ended · 1h12m · 8 turns · 412 tools · 1.2M in / 40k out`. On
  `SessionEnd` the reason is appended when the harness gives one.

## 8. Events and lines

Glyphs: `▶` session start · `■` session end / interrupt · `»` prompt ·
`⚙` tool · `✖` failure · `⇢` subagent start · `⇠` subagent stop ·
`✔` turn done · `⚠` permission · `…` idle / dropped · `⟲` compaction ·
`⇄` model (switch, or the model first becoming known) · `↩` background-agent
task-notification.

Numbers: durations as `1.2s`, `42s`, `3m12s`, `1h12m`; tokens as `31k`,
`1.2M`; token line as `<in> in (<cached> cached) / <out> out`, the cached
part omitted when zero.

### 8.1 Level `activity`

| Event | Line |
|---|---|
| first event with `session_id` | `▶ session e873ddde · claude claude-fable-5-1 · ~/dev/agent-irc` — Codex payloads carry `model`; Claude's do not, so the model comes from the transcript's last assistant record and is omitted when there is none yet |
| model first known | `⇄ model claude-opus-5` — only when the session line went out without it: a fresh Claude session has no assistant record to read at announce time, so the model is announced on its own line as soon as the transcript names it, which is before the first tool line. Never repeated, and skipped when the `✔ turn` or `⇄ model … → …` line has already named it |
| UserPromptSubmit | `» <first line of prompt, ≤ 200 chars>`; a prompt that is a harness-injected `<task-notification>` block renders instead as `↩ agent "<name>" <status>` (name from the summary, status from `<status>`), never as raw XML |
| PreToolUse | nothing; records start time by `tool_use_id` |
| PostToolUse | `⚙ Bash 1.2s: ls -la && find . -maxdepth 3` |
| PostToolUseFailure (Claude) | `✖ Bash 0.3s: <summary> — <first line of error_message>` |
| SubagentStart | `⇢ subagent Explore: find hook payloads` |
| SubagentStop | `⇠ subagent Explore done · 42s · 18 tools · 31k in / 2k out · claude-sonnet-5` |
| Stop | `✔ turn · 3m12s · 24 tools · 210k in (190k cached) / 6k out · claude-fable-5-1` — duration from the `UserPromptSubmit` to the `Stop` on the server clock; tool count = completed tool calls without `agent_id` since that prompt, i.e. `PostToolUse` plus `PostToolUseFailure` events — a failed call is still a call, and Codex has no failure event to tell them apart |
| StopFailure (Claude) | `✖ turn failed: rate_limit — <first line of error_message>` |
| PermissionRequest | `⚠ permission: Bash: rm -rf build` |
| Notification `idle_prompt` (Claude) | `==== … WAITING FOR INPUT ====` — the only line that asks the reader for something, so it is ruled off and shouted; every other line is meant to be skimmed |
| Interrupt (Codex) | `■ interrupted` |
| PostCompact | `⟲ compacted (auto)` |
| PostModelSwitch (Claude) | `⇄ model claude-fable-5-1 → claude-opus-5` |
| SessionEnd | `■ session ended (<reason>) · <summary as in §7>` then `QUIT` |
| `SIGTERM`/`SIGINT`/`SIGHUP` **[corrected]** | `QUIT` with the summary, no `PRIVMSG`. This, not `SessionEnd`, is how a session ends in both harnesses |

**Tool summaries** (`⚙ <tool> <duration>: <summary>`), `summary` cut at 120
characters:

| tool | summary |
|---|---|
| Bash, shell, `Bash` on Codex | `command` with newlines folded to spaces (a heredoc or `python3 -c "…"` is one command, not its first line), plus ` [+N lines]` when it had more than one; a list command is joined with spaces |
| Read, Edit, Write, MultiEdit, NotebookEdit | `file_path` relative to `cwd` |
| Grep, Glob | `pattern`, plus `path` if given |
| Agent | `<subagent_type>: <description>` |
| WebFetch, WebSearch | `url` or `query` |
| Skill | `skill` |
| apply_patch (Codex) | file names from `*** Update File:` / `*** Add File:` / `*** Delete File:` headers |
| `mcp__…` tools | the part after the last `__`, plus the first string argument |
| anything else | the first string-valued argument, or nothing |

Every summary is folded to one line before it is cut, so nothing is lost at the
first newline -- only at the 120-character mark.

Paths under the home directory are shown with `~`.

**Subagent-internal tool calls** (events that carry an `agent_id`) produce no
tool lines at this level; their count and cost appear in the `⇠` line. See
§8.2 for the level that shows them.

**Subagent descriptions:** Claude's `SubagentStart` carries `agent_type` but
not the `description` from the `Agent` tool input. The server keeps the
descriptions of pending `Agent` PreToolUse events in a FIFO and pairs them in
order; parallel spawns are issued sequentially, so order matches in practice.
No description on Codex.

### 8.2 Level `subactivity`

Everything from `activity`, plus **subagent-internal tool lines**, in the same
form as the main session's tool lines but prefixed with the subagent's short
id (first four characters of `agent_id`):

```
⇢ subagent Explore: find hook payloads
⚙ [a293] Grep 0.2s: hook_event_name
⚙ [a293] Read 0.1s: hooks/hooks.json
⇠ subagent Explore done · 42s · 18 tools · 31k in / 2k out · claude-sonnet-5
```

Failures inside a subagent are shown the same way with `✖ [a293] …`. Nested
subagents carry their own id; the nesting is not drawn.

### 8.3 Level `full`

Everything from `subactivity`, plus:

- the **full prompt** after the `»` line, one line per source line *from the
  second on* — the first line already is the `»` head, so a one-line prompt
  adds no body and is never sent twice — blank lines dropped, indentation kept
  and tabs expanded to spaces, each line prefixed with `  `; a task-notification
  prompt instead puts the agent's `<result>` (or a stopped agent's summary)
  under the `↩` head the same way;
- the **full final answer** (`last_assistant_message`) after the `✔` line,
  the same way;
- **[corrected]** the **complete `tool_input`** of every tool call after its
  `⚙`/`✖` line, field by field, each value the same way -- not only a shell
  command: a `Write` sends the whole file, an `Edit` both of its strings, an
  MCP call all of its arguments. The head line keeps the value's first line
  whole instead of the 120-character cut, and a body that would only repeat
  that head line is left out, so a one-line `Bash` or a plain `Read` still
  costs one line.

These are *logical* lines of any length. Fitting them to a server is §7's job,
because the connection is the only thing that knows that server's `LINELEN`
and the prefix it prepends.

Tool outputs are never sent at any level.

## 9. Usage accounting

Hook payloads carry no token counts in either harness. The server reads the
transcripts named in the payload. Reads are incremental: the byte offset per
file is remembered, so a `Stop` reads only what the turn appended.

### 9.1 Claude Code

- Main transcript: `transcript_path`, JSONL. Usage lives in records with
  `type == "assistant"` under `message.usage`, model under `message.model`.
- **One API response is written as several records**, one per content block,
  all carrying the same `requestId` and the same usage. Verified: 85 records,
  26 distinct `requestId`s in one session. Usage is summed per distinct
  `requestId`.
- in = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`,
  cached = `cache_read_input_tokens`, out = `output_tokens`. Model = the last
  record's model.
- Turn = records appended since the previous `Stop` (or since session start).
- Subagent transcript: `<dir of transcript_path>/<session_id>/subagents/agent-<agent_id>.jsonl`,
  read whole on `SubagentStop`. Tool count = `tool_use` content blocks.
  Duration = `duration` from the payload, else last minus first timestamp.
- Session totals accumulate in memory for the `QUIT` summary.

### 9.2 Codex

- Rollout: `transcript_path`, JSONL. Records with
  `type == "token_usage_record"` carry `turn_id`, `turn_token_usage`
  (cumulative within the turn) and `thread_token_usage` (cumulative for the
  thread).
- Turn = the last `token_usage_record` whose `turn_id` equals the `Stop`
  event's `turn_id`; take its `turn_token_usage`. in = `input_tokens`,
  cached = `cached_input_tokens`, out = `output_tokens`.
- Model = `model` from the hook payload, else the last `turn_context.model`.
- Tool count = `response_item` records of type `function_call` or
  `custom_tool_call` appended during the turn.
- Subagent: `agent_transcript_path` from `SubagentStop`, last
  `thread_token_usage` in that file; tools counted the same way.

### 9.3 Fallbacks

Unreadable or unexpected transcript: the line is sent without the token part,
one debug log line. Never an error to the harness.

## 10. Error handling

- The server starts and answers MCP even with no configuration; it simply
  never connects.
- Config parse errors: that file is skipped with a log line, the others still
  apply.
- IRC errors, TLS errors, DNS failures: logged, retried per §7, never
  propagated to the harness.
- Exceptions in the dispatcher thread are caught per event; the event is
  dropped, the thread keeps running.
- `tools/call` always returns success within milliseconds. The hook never
  blocks, denies or rewrites anything.

## 11. Security and privacy

- At `full` level prompts and answers leave the machine. Use `ircs://`.
  `PRIVACY.md` says so plainly, as in `briefing`.
- Passwords belong in user-level files or `.claude/settings.local.json`, or
  come from the environment via `${VAR}` so that a committed project file can
  stay free of secrets.
- Project-level configuration requires harness trust (§5.5).
- Tool outputs are never sent. **[corrected]** Tool inputs are truncated
  summaries below `full` only (§8.1) -- a Bash command is visible up to 120
  characters, which is the point of the feature; at `full` the whole
  `tool_input` of every call is sent, a written file's entire content
  included. `PRIVACY.md` says so.
- The server never executes anything it receives, from the harness or from
  IRC. Incoming IRC traffic is parsed for `PING`, numerics and the nick and
  password replies, and **[corrected in 0.2.0]** with `listen` on, for the
  `PRIVMSG`s the inbox takes (§7). Everything in there is text a stranger
  typed that ends up in the agent's context, so `listen_from` denies by
  default, `read_messages` labels what it returns as untrusted data, the inbox
  is bounded and in memory only, and nothing is ever sent back to IRC.

## 12. Testing

`python3 -m unittest discover tests`, stdlib only.

- **config**: URL parsing incl. `#`, percent-encoding, `${VAR}`, `insecure`;
  the five merge scenarios of §5.3 in both file formats; trust with and
  without ancestor markers; TOML fallback parser forced by a shadowing
  `tomllib` module like `briefing` does.
- **events**: every row of §8 as a formatting test with a fixed clock;
  truncation with multi-byte characters, path shortening; subagent description FIFO; the same subagent tool event at all
  three levels (hidden, shown with id, shown with id).
- **irc**: the payload budget from a fake server's `LINELEN` and from the
  echoed mask, an over-long line arriving as several `PRIVMSG`s that lose
  nothing and keep their indent, a nonsense `LINELEN` ignored.
- **usage**: fixture transcripts (anonymised excerpts of real Claude and Codex
  files) for the `requestId` dedupe, incremental offsets, turn selection by
  `turn_id`, subagent files.
- **irc**: a fake IRC server in a thread accepts a connection, checks the
  `PASS`/`NICK`/`USER`/`JOIN` sequence, answers `433` to force `-2`, answers
  `PING`, records `PRIVMSG`s and the `QUIT` line; flood bucket timing with an
  injected clock; reconnect after a dropped socket.
- **mcp**: the server as a subprocess driven with JSON-RPC over stdio:
  `initialize`, `tools/list`, a sequence of `tools/call` events, then stdin
  closed; the fake IRC server must have seen the expected lines and the
  `QUIT`.
- **inbound** (0.2.0): the allowlist against whole masks (a bare host matches
  nothing), whole-word mentions, CTCP, the cap and its drop notice,
  `read_messages` listed only with `listen` on, and end to end through the
  fake server: DMs from the allowed mask come back in order, a disallowed
  sender's never.

## 13. Distribution

Repository `Getty/agent-irc`, added to `Getty/marketplace` in both
`.claude-plugin/marketplace.json` and `.agents/plugins/api_marketplace.json`
(Codex's actual recognized marketplace manifest filename — verified live,
2026-09-05, Task 18; `.agents/plugins/marketplace.json` is not one Codex
looks for), like `briefing`. License Artistic-2.0 to match `briefing`;
change before the first release if MIT is preferred. Conventional commits,
`--signoff`. A `CLAUDE.md` documents the two-harness traps found in §14 the
way `briefing`'s does.

## 14. Verified against a real harness before release

Documentation leaves these open; each is checked live in the implementation
phase and the answer recorded in `CLAUDE.md`. All eight were answered against
`claude` 2.1.261/2.1.263 and `codex` 0.153.4 between 2026-09-05 and
2026-09-08; the table in `CLAUDE.md` holds the results, and question 5's
answer is the correction marked above -- neither harness delivers a usable
`SessionEnd`, and neither closes stdin:

1. Claude Code: does `"${tool_input}"` substitute an object or a string, and
   what happens to a placeholder whose field is absent? Determines whether
   one shared `input` map works or per-event maps are needed.
2. Codex: the `server` reference for a plugin-bundled MCP server in a
   `mcp_tool` hook (bare `irc` or a scoped name). Determines whether one
   `hooks.json` serves both or the file is split.
3. Codex: the bundled server starts at session start (not lazily), one
   process is shared by subagent threads, and hook-triggered `tools/call`
   does not go through tool approval. If it does, the remedy is documented
   (`[plugins."agent-irc".mcp_servers.irc]` approval settings).
4. Codex: hooks need one-time trust; `codex exec` needs
   `--dangerously-bypass-hook-trust`. Documented, as in `briefing`.
5. Both: `SessionEnd` still reaches the server, or stdin EOF is the only
   end signal in practice. Either is fine; the summary must appear once.
6. Both: `async: true` on an `mcp_tool` hook does not change delivery order.
7. Codex: whether `${CLAUDE_PLUGIN_ROOT}` (or `${PLUGIN_ROOT}`) is
   substituted inside `.mcp.json`. If not, `.mcp.json` is split per harness
   or the command is resolved another way; the server code does not change.
8. The user's ircd: `NICKLEN`, connection limit per IP for several parallel
   sessions, TLS certificate.

## 15. Decisions made during design

- One nick per session, not one per subagent and not one bot per machine.
- Nick is the project name plus a counter, without a harness prefix; the
  harness appears in the session line and the realname.
- Configuration lives in the harnesses' own files, not in a separate file,
  accepting that server entries are maintained once per harness.
- Channel lists are named; same name overrides, new name adds. No key that
  a project cannot override.
- Channel is part of the server URL, so a project switching servers cannot
  inherit channels that do not exist there.
- Python, one code base, standard library; not TypeScript plus Rust.
- The session process is the plugin's MCP server, owned by the harness;
  hooks deliver via `mcp_tool`. Socket transport is plan B only.
