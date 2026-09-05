# agent-irc — design

*Status: draft for review · 2026-09-05*

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
session ends. If the harness dies, stdin closes and the server quits. There is
no detached process, no watchdog, no socket, no PID discovery.

**Every hook is an `mcp_tool` hook** that calls the server's single tool
`event` with the fields of the hook payload. Both harnesses support this hook
type with `${field}` substitution from the payload. Formatting, transcript
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

Anything else in the namespace is ignored.

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

Both markers were verified to be inherited from ancestors (`/home/getty/dev`
covers its subdirectories). Untrusted: project and local files are ignored,
one log line on stderr says so. Unreadable marker file: treated as untrusted.

### 5.6 TOML parsing

`tomllib` is Python 3.11+. On older interpreters a minimal parser reads
exactly the `[agent-irc]` table: string values, string arrays (single or
multi-line), until the next table header. Everything else in the file is
skipped. Also used for the `[projects."…"]` trust lookup, which is one key.

## 6. Transport

### 6.1 MCP server

`bin/agent-irc` speaks the MCP subset both harnesses need over stdio,
newline-delimited JSON-RPC 2.0:

| method | response |
|---|---|
| `initialize` | `protocolVersion` echoed from the request, `capabilities: {tools: {}}`, `serverInfo: {name: "agent-irc", version}` |
| `notifications/initialized` | none |
| `ping` | `{}` |
| `tools/list` | one tool, `event` |
| `tools/call` `event` | `{content: [], isError: false}` immediately |
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
`CLAUDE.md` once observed (§14). Stdin EOF means the harness is gone: every connection sends
`QUIT` with the session summary, the process exits within two seconds.

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
  500 lines across reconnects; beyond that the oldest are dropped and one
  `… dropped N lines` is queued.
- **Flood control:** token bucket per connection, burst 4 lines, then one
  line every 2 seconds. Every line goes as `PRIVMSG` to every channel of the
  connection, each copy counts against the bucket.
- **Line length:** the message part of a `PRIVMSG` is at most 400 bytes of
  UTF-8, cut at a character boundary; §8 says what gets truncated with `…`
  and what gets split into several lines.
- **Quit:** `QUIT :<summary>` where the summary is
  `session ended · 1h12m · 8 turns · 412 tools · 1.2M in / 40k out`. On
  `SessionEnd` the reason is appended when the harness gives one.

## 8. Events and lines

Glyphs: `▶` session start · `■` session end / interrupt · `»` prompt ·
`⚙` tool · `✖` failure · `⇢` subagent start · `⇠` subagent stop ·
`✔` turn done · `⚠` permission · `…` idle / dropped · `⟲` compaction ·
`⇄` model switch.

Numbers: durations as `1.2s`, `42s`, `3m12s`, `1h12m`; tokens as `31k`,
`1.2M`; token line as `<in> in (<cached> cached) / <out> out`, the cached
part omitted when zero.

### 8.1 Level `activity`

| Event | Line |
|---|---|
| first event with `session_id` | `▶ session e873ddde · claude claude-fable-5-1 · ~/dev/agent-irc` — Codex payloads carry `model`; Claude's do not, so the model comes from the transcript's last assistant record and is omitted when there is none yet |
| UserPromptSubmit | `» <first line of prompt, ≤ 200 chars>` |
| PreToolUse | nothing; records start time by `tool_use_id` |
| PostToolUse | `⚙ Bash 1.2s: ls -la && find . -maxdepth 3` |
| PostToolUseFailure (Claude) | `✖ Bash 0.3s: <summary> — <first line of error_message>` |
| SubagentStart | `⇢ subagent Explore: find hook payloads` |
| SubagentStop | `⇠ subagent Explore done · 42s · 18 tools · 31k in / 2k out · claude-sonnet-5` |
| Stop | `✔ turn · 3m12s · 24 tools · 210k in (190k cached) / 6k out · claude-fable-5-1` — duration from the `UserPromptSubmit` to the `Stop` on the server clock; tool count = completed tool calls without `agent_id` since that prompt, i.e. `PostToolUse` plus `PostToolUseFailure` events — a failed call is still a call, and Codex has no failure event to tell them apart |
| StopFailure (Claude) | `✖ turn failed: rate_limit — <first line of error_message>` |
| PermissionRequest | `⚠ permission: Bash: rm -rf build` |
| Notification `idle_prompt` (Claude) | `… waiting for input` |
| Interrupt (Codex) | `■ interrupted` |
| PostCompact | `⟲ compacted (auto)` |
| PostModelSwitch (Claude) | `⇄ model claude-fable-5-1 → claude-opus-5` |
| SessionEnd | `■ session ended (<reason>) · <summary as in §7>` then `QUIT` |
| stdin EOF | `QUIT` with the summary, no `PRIVMSG` |

**Tool summaries** (`⚙ <tool> <duration>: <summary>`), `summary` cut at 120
characters:

| tool | summary |
|---|---|
| Bash, shell, `Bash` on Codex | `command`, first line; a list command is joined with spaces |
| Read, Edit, Write, MultiEdit, NotebookEdit | `file_path` relative to `cwd` |
| Grep, Glob | `pattern`, plus `path` if given |
| Agent | `<subagent_type>: <description>` |
| WebFetch, WebSearch | `url` or `query` |
| Skill | `skill` |
| apply_patch (Codex) | file names from `*** Update File:` / `*** Add File:` / `*** Delete File:` headers |
| `mcp__…` tools | the part after the last `__`, plus the first string argument |
| anything else | the first string-valued argument, or nothing |

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

- the **full prompt** after the `»` line, split into `PRIVMSG` lines of at
  most 400 bytes at word boundaries, paragraph breaks preserved as line
  breaks, each line prefixed with `  `;
- the **full final answer** (`last_assistant_message`) after the `✔` line,
  same splitting, each line prefixed with `  `.

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
- Tool outputs are never sent. Tool inputs are only sent as truncated
  summaries (§8.1); full commands are visible in a Bash summary of up to 120
  characters, which is the point of the feature.
- The server never executes anything it receives, from the harness or from
  IRC. Incoming IRC traffic is only parsed for `PING`, numerics and `433`/`432`.

## 12. Testing

`python3 -m unittest discover tests`, stdlib only.

- **config**: URL parsing incl. `#`, percent-encoding, `${VAR}`, `insecure`;
  the five merge scenarios of §5.3 in both file formats; trust with and
  without ancestor markers; TOML fallback parser forced by a shadowing
  `tomllib` module like `briefing` does.
- **events**: every row of §8 as a formatting test with a fixed clock;
  truncation, splitting at 400 bytes with multi-byte characters, path
  shortening; subagent description FIFO; the same subagent tool event at all
  three levels (hidden, shown with id, shown with id).
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

## 13. Distribution

Repository `Getty/agent-irc`, added to `Getty/marketplace` in both
`.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`, like
`briefing`. License Artistic-2.0 to match `briefing`; change before the first
release if MIT is preferred. Conventional commits, `--signoff`. A `CLAUDE.md`
documents the two-harness traps found in §14 the way `briefing`'s does.

## 14. Verified against a real harness before release

Documentation leaves these open; each is checked live in the implementation
phase and the answer recorded in `CLAUDE.md`:

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
