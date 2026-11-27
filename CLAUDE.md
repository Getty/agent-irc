# agent-irc — CLAUDE.md

This is the **agent-irc** plugin, for Claude Code *and* Codex. It mirrors a
session's activity into IRC. Product documentation is in [README.md](README.md);
the design is `docs/superpowers/specs/2026-09-05-agent-irc-design.md`. This
file is guidance for working on the plugin itself.

## Shape

The session process is the plugin's own MCP server, a TypeScript program
bundled into `dist/server.js` and run on Bun 1.4.5. Claude Code starts
`bin/agent-irc`, Codex the `sh -c` locator in `.mcp.codex.json`; both exec
the getty-bun starter (`bootstrap/getty-bun.sh run dist/server.js
<claude-code|codex>`), which installs the pinned Bun on first use and then
execs it -- one process, one PID, from the harness's spawn to Bun. The harness
starts it at session start and kills it at session end; a harness crash closes
stdin and the server quits. Hooks are `mcp_tool` hooks that call the server's
`event` tool; the opt-in `read_messages` is the only other one, and the agent
calls that itself. Nothing else runs. The Python server this replaced
(`agent_irc/`, removed in `09a3af3`) is in the history and in
`docs/superpowers/plans/`.

```
.claude-plugin/plugin.json   Claude Code manifest — no `version`: Claude Code takes it from the commit
.codex-plugin/plugin.json    Codex manifest — its own .mcp.codex.json and hooks/codex.json
.mcp.json                    Claude Code server: ${CLAUDE_PLUGIN_ROOT}/bin/agent-irc, no args
.mcp.codex.json              Codex server: sh -c locator, newest $CODEX_HOME/plugins/cache/*/agent-irc/*/bootstrap/getty-bun.sh
hooks/hooks.json             Claude Code hooks (loaded by convention, not named in the manifest)
hooks/codex.json             Codex hooks: bare server name `irc`, one per-event field whitelist
                              (Codex rejects unknown ${…} placeholders), no SessionEnd
bin/agent-irc                POSIX sh entry: finds the plugin root from its own path, execs the starter
bin/agent-irc.exe            Windows: mcpoff, a server that does nothing (copy, see winlaunch/)
bootstrap/getty-bun.sh .ps1  getty-bun starters, rendered; byte-equal to the getty-bun-install render
dist/server.js               the bundle of src/server.ts, committed; what users run
scripts/dist.sh              `bun run build` / `bun run check` (bundle, cmp with the committed one)
package.json                 gettyBun.bunVersion 1.4.5, dev dependencies only; bunfig.toml: dev only
src/text.ts                  string helpers            src/irc.ts           IRC connection
src/config.ts                settings, trust, merge    src/mcp.ts           JSON-RPC loop
src/usage.ts                 transcript readers        src/server.ts        wiring, queue, signals, main
src/events.ts                event → lines             src/inbound.ts       inbox, allowlist
src/py.ts                    the Python semantics the output depends on
src/version.ts               VERSION (the release manager's)
tests/*.test.ts              bun:test; tests/fakeirc.ts is the fake ircd,
                              `bun tests/run_fakeirc.ts [port] [--tls] [--isupport TOKEN]…` the standalone one
```

## Rules

- Bun 1.4.5, pinned in `package.json` (`gettyBun.bunVersion`, and
  `@types/bun` at the same version); no runtime dependencies. Users run the
  committed `dist/server.js` and never `bun install` (the starter passes
  `--no-install`). It is built with `bun build --target=bun`, whose `// @bun`
  pragma makes Bun run it without transpiling, so nothing is written to the
  user's transpiler cache. After any change under `src/`, `bun run build`;
  `bun run check` rebuilds into a temp dir and `cmp`s, and both refuse any Bun
  but the pinned one, because the bytes are only reproducible with it.
  Comments do not survive bundling, so a comment-only change leaves
  `dist/server.js` as it is.
- `bootstrap/getty-bun.sh` and `bootstrap/getty-bun.ps1` are rendered, never
  edited: they must stay byte-equal to the render in
  `.claude/skills/getty-bun-install/bootstrap/` (skill `getty-bun-install`;
  `cmp` both). Mode 100644 is right: they are always run as `sh <file>`.
- TOML is read by `Bun.TOML.parse`, which replaced both of Python's readers,
  `tomllib` and the one-table fallback below 3.11 that twice dropped a whole
  value type silently (the tuning integers and floats in 0.1.x, the `listen`
  boolean in 0.2.0). There is no fallback any more, but the lesson stands:
  a setting with a new kind of value gets a test that reads it through the
  real reader (`tests/config_files.test.ts`, `test_toml_namespace_fallback`
  asserts every tuning key). Bun is not `tomllib`, though: it reads TOML 1.1,
  so a whole class of files `tomllib` refused is accepted -- `\x` and `\e`
  escapes, times without seconds (`10:30`), multi-line inline tables, a
  trailing comma in an inline table (all checked on Bun 1.4.5, 2026-11-27,
  the K4 review). It refuses an integer beyond ±2^53 (the whole file,
  trust markers included; `tomllib` reads it), and gives a whole-valued float
  such as `flood_burst = 4.0` as the number 4, so the integer settings take it
  where Python ignored it. A leading byte order mark Bun would skip;
  `parseToml` refuses it, as `tomllib` did. An invalid file is skipped whole.
  `settings.json` has no such gap: `src/py.ts`'s `loads` keeps `4.0` a float,
  as Python's `json` does. Where Python 3.9 and 3.11+ differed (`fnmatch`
  ranges, `datetime.fromisoformat`), the port follows 3.13.
- `src/irc.ts` is the Python `irc.py` without its thread: one async loop on
  Bun's event loop, `read(timeout)` waking on socket data, a queued line or
  `beginClose` instead of `select()`. Bytes, order and the greeting/drain/QUIT budgets are
  Python's; a differential run (2026-11-27, Bun 1.4.5, Python 3.13) put both
  clients against the same fake ircd, 22 scenarios x 3 seeds, and got
  identical lines in 64 of 66. The two that differ are LINELEN=140 with the
  mask still unknown and a burst of 1000 that runs dry: TS writes faster, so
  it reads the JOIN echo (and with it the real, shorter mask) at a different
  point of the burst and splits a few lines elsewhere -- a timing effect,
  every line within its 140 bytes either way. What changed shape:
  `start()`/`isAlive()`/`join()`/`close()` are `Thread`'s, `join` and
  `close` return Promises; `TLS_READ_TIMEOUT` is gone, since a Node socket
  never blocks in a read. Nor does it block in a write, and that is
  `SEND_TIMEOUT`'s trap: a socket whose server stopped reading takes every
  `write()` into its buffer (the K5 review, 2026-11-27, before the fix:
  50,000 lines, 18 MB, no `queue_limit` drop, all lost on close). So `raw()` notes a `write()`
  returning false, `pump()` writes nothing more until the socket's `drain`
  -- the backlog stays in the queue, where `queue_limit` drops with its
  notice -- and `SEND_TIMEOUT` (10s, `sendTimeout` for tests) without a
  `drain` is Python's `socket.timeout`: logged as `timed out`, reconnect,
  queue and pending parts kept. Lost on that reconnect is what the dead
  socket's kernel buffer had already accepted, in both: Python's
  `sendall()` blocks only once that buffer is full, so it loses it too
  (the K5 re-review, 2026-11-27, Python 3.13, `SEND_TIMEOUT` patched to
  1s, a localhost server that stopped reading after the JOIN, 200 lines
  of 30 KB: m0 to m61 lost, ~1.9 MB; Bun 1.4.5 measured ~2.6 MB there).
  The TS client loses on top only Node's own stream buffer: at most its
  64 KB high-water mark plus the one `write()` that crossed it. A lone UTF-16 surrogate (a JSON `"\ud800"` in a hook payload
  can carry one) goes out as U+FFFD, counted as its 3 bytes, where Python's
  `encode()` raises inside `_pump`, loses the line and drops the connection
  into a 5s backoff; socket errors surface as `ConnectionError`, so one
  during the post-`QUIT` wait is swallowed as Python swallows its own
  `ConnectionError` there. The socket is closed with `end()` before
  `destroy()`: Python's `sendall()` had the bytes in the kernel, a Node
  write may still be queued in the stream and `destroy()` alone would drop
  the `QUIT`. That flush shares the stop's 1.5s budget (`STOP_BUDGET`), so
  `close()` against a server that reads nothing still ends within it.
  Covered by `tests/irc_connection.test.ts`'s `BackpressureTests`, against
  the fake's `stallAfterJoin`. The fake ircd is
  `tests/fakeirc.ts`, `bun tests/run_fakeirc.ts [port] [--tls] [--isupport
  TOKEN]…` the standalone one.
- `src/mcp.ts` and `src/server.ts` are the Python `mcp.py` and `server.py`
  on one event loop; `dist/server.js` is the bundle the getty-bun starter runs as
  `run dist/server.js <claude-code|codex>`. The host word wins over
  `clientInfo`, which stays the fallback (no argument; an unknown one is
  logged). `onEvent` only queues and starts the drain a macrotask later, so
  a `tools/call` is answered before its event is formatted; `shutdown()`
  waits for what is still queued first, as Python's worker does before its
  `None`, but at most `DRAIN_BUDGET` (2s, `worker.join(2.0)`), and hands
  every caller the same promise. Requests are read with
  `py.loads` (key order, `4.0`) and answered with `py.dumps(…, {ensureAscii:
  true})`, Python's `json.dumps` bytes; stdout is written with
  `fs.writeSync(1)`, diagnostics with `writeSync(2)`. Exit codes are
  Python's: 0 on EOF or a gone stdout, 128 + the first signal (130, 143,
  129). Two Bun behaviours this relies on, measured on Bun 1.4.5,
  2026-11-27: Bun ignores `SIGPIPE`, so a reader that went away shows as
  `EPIPE` from `writeSync` and the loop stops with 0
  (`tests/end_to_end.test.ts`, "stdout gone"); and a SIGINT and SIGTERM
  sent back to back reach the listeners in no fixed order -- 7 of 10
  SIGTERM first, whichever was sent first (part A saw 3 of 3) -- where
  Python always runs SIGINT's handler first, by signal number. Only the
  first signal counts either way (20 of 20: one QUIT, the second logged),
  so the exit code of such a pair is 130 or 143. The same probe sent to the
  Python server hung 1 run in 10: neither handler ran and the process went
  on reading stdin until a third signal. An oracle (same JSON-RPC and hook
  sequences, same fake ircd, six scenarios: full level with every Claude
  event, Codex with a password and SIGTERM, listen + `read_messages`,
  `/clear` rollover with late events and SIGINT-then-SIGTERM, `SessionEnd`
  first, no config) found stdout byte-identical (`read_messages`' clock
  aside) and the ircd's lines identical once durations are masked, exit
  codes included.
- The MCP loop is the only writer to stdout. Everything else logs to stderr.
- `tools/call` must return immediately. Formatting, transcript reads and IRC
  I/O happen after the answer. There is one thread, so the rule holds by
  giving way: the drain handles one event after
  another, in arrival order, and before each `Session.handle` runs
  `Session.prepare`, which reads every transcript that event will read
  (the priming of a new or rolled-over session, `Stop`'s turn,
  `SubagentStop`'s subagent) ahead with `Tail.readAhead` -- 512 KB
  (`READ_AHEAD`) parsed at a time, a `setImmediate` turn between chunks,
  chunks cut at line ends so `records()` returns exactly what one read
  would. Without it the priming parsed a whole resumed transcript in one go
  (about 34 ms/MB): a `ping` sent right after the first `UserPromptSubmit`
  waited 0.23 s at 5 MB, 0.71 s at 20 MB, 1.72 s at 50 MB, so a ~150 MB one
  would push the next hook past its 5 s timeout and hold signals and IRC
  I/O as long. With it the same probe answers in 0.026 s at 5, 20 and 50 MB
  (Python: 0.000 s; Bun 1.4.5, 2026-11-27). `server.test.ts`, "a call
  arriving while a large transcript is primed is answered at once", holds
  it under 100 ms on 50 MB. What is left is synchronous: after `prepare()`,
  `Session.handle` walks the parsed records in one go -- 85-97 ms for a 52 MB
  transcript, about 1.7 ms/MB, the loop stalled up to ~120 ms in all (the K6
  re-review, Bun 1.4.5, 2026-11-27) -- so a call that lands then waits that
  long; at ~150 MB that is still a quarter second, far from the 5 s hook
  timeout. The model peek stays synchronous too: it parses 256 KB at most.
- Never block, deny or rewrite anything in a hook. The hook returns no
  decision on any event.
- The check: `bun run typecheck`, `bun test` (twice, for the timing tests),
  `bun run check`, and the starters `cmp`ed against the render. No network
  beyond localhost. CI is Ubuntu; macOS and Windows run in no CI.
- Commits: summary imperative or `<component>: <what>`, no Conventional Commits type (`feat:`, `fix:` …), no `--signoff`.

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
the `▶ session` line cannot name it. `Session.modelLine` announces it as
`⇄ model …` on the first event where the transcript does name it, which in
practice is the first `PreToolUse` — the assistant message carrying the tool
call is written before the tool runs. That read goes through
`Tail.peek()`/`peekModel()`, which reads only the last 256 KB and leaves the
offset alone: the turn totals are read exactly once, at `Stop`, and a peek that
consumed records would silently zero them.

**The line we send is not the line that has to fit.** A server relays our
`PRIVMSG #chan :text` as `:nick!user@host PRIVMSG #chan :text`, and it is
*that* line the 512-byte RFC 1459 limit (or the server's advertised `LINELEN`)
applies to. The sender therefore has to budget for a prefix it never writes.
`IrcConnection.payloadLimit()` does it exactly: `LINELEN` from `RPL_ISUPPORT`
(005) when advertised, else 512, minus the mask, minus `PRIVMSG <channel> :`,
minus CRLF. The mask is not guessable — it is read off the `JOIN` the server
echoes back with our own prefix (`dispatch()` picks up any prefix whose nick is
ours) — so until it arrives a worst-case 76 bytes is assumed. This is also why
`src/events.ts` must not split by bytes: only the connection knows its server's
limit, so the formatter emits *logical* lines of any length and `pump()`
splits each into as many `PRIVMSG`s as that connection needs, one flood-bucket
token each, indent preserved on continuations. Two things follow: the
connection's `drain()` has to check `pending` as well as `queue`, and a line is
never truncated — `cutBytes` survives only as a last-resort guard in `raw()`
for the lines we build ourselves (a long `QUIT` summary). One timing trap
follows from this, and it has nothing to do with threads, so the port kept
it: `LINELEN` arrives in the `005` burst *after* `001`, and a server sends the
two as separate writes that can land in separate reads -- separate `data`
events on a Bun socket just as separate `recv()`s in Python. A line already
queued before registration would then be pumped the instant `001` sets
`registered`, splitting it to the 512 fallback before `005` raised the limit —
measured flaky 3/15 in the large-`Write` end-to-end test (Python). So the
first pump waits for `greetingSettled()`: ISUPPORT in hand, or a
`GREETING_GRACE` (0.5s) lapse for a server that sends none. Covered by
`tests/irc_connection.test.ts`, `test_early_line_waits_for_a_delayed_isupport_linelen`.

**`full` shortens nothing, which moves the real limit to the sender.**
`SUMMARY_LIMIT`/`PROMPT_LIMIT` apply below `full` only: there a tool call is
one line, so the whole input has to be folded into it and cut. At `full`
`Session.summaryLimit` is `null`, `head()` keeps the value's *first* line
whole (folding an 800-line file into the head would send it twice), and
`renderInput()` puts the entire `tool_input` underneath -- every field, every
line, for every tool, not just the shell ones the Python `_command_body()`
used to handle. A body of a single line is dropped: the head line already is
that line. What then decides whether those lines arrive is the connection,
and its defaults are sized for a public server: a `FloodBucket` of burst 4,
interval 2.0 releases one line every two seconds and `QUEUE_LIMIT = 500`
drops the oldest beyond that, so a 600-line `Write` loses the first 107 lines
and needs 20 minutes. Hence `flood_burst`, `flood_interval` and `queue_limit`
(0 = never drop) in the config, merged by `mergeLayers` and handed to the
connection by `App.connect`. Remove `queue_limit = 0` from
`tests/end_to_end.test.ts`, "full level sends a large tool input whole", and
it fails with `… dropped 107 lines` -- that is the whole point of the test.

**SessionStart fires before MCP servers are connected**, in both harnesses.
The server announces the session itself on the first event that carries a
`session_id`, which is the first `UserPromptSubmit`.

**Placeholders.** `hooks.json` passes every field any event can carry. A field
missing from an event may arrive as an empty string or as the literal
`${name}`; `events.clean()` drops both.

**Trust.** Project-level config is honoured only when the harness trusts the
directory (Claude: `~/.claude.json` `projects[*].hasTrustDialogAccepted`,
Codex: `[projects."…"] trust_level = "trusted"`), inherited from ancestors;
both markers are looked for under `CLAUDE_CONFIG_DIR` / `CODEX_HOME` first
(see the moved-config-directory trap below). Otherwise a cloned repo could point `full`-level prompts at its own server.

**Codex hooks need trust too.** Until the user accepts the hook trust prompt,
hooks are skipped silently. `codex exec` needs
`--dangerously-bypass-hook-trust`.

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
prompt never appears in IRC either way. `App.handle` recognizes a
`SessionEnd` as literally the first event a fresh process sees and stays
quiet instead of announcing anything.

**`/clear`, by contrast, delivers `SessionEnd` to the *running* process, and
the next prompt rolls the session over on the same connection.** Verified live
2026-09-08 by driving a real interactive `claude` through a pty in a throwaway
directory: the channel showed `▶ session 47926732 …`, the turn, then
`■ session ended (clear) · 41s · 1 turns · 0 tools`, then
`▶ session 3cde7677 …` — with no JOIN between them, so it is one process and
one IRC connection throughout. One `/clear` therefore exercises both paths in
`App.handle`, in that order: the `SessionEnd` for the id it is running, then
the rollover on a `UserPromptSubmit` carrying an id it has never seen.
Not re-run on the Bun port; the oracle runs of the port (Rules, above) cover
the rollover sequence against the fake ircd.

**`Interrupt` is Codex's hook event, not Claude Code's.** `claude plugin
validate` answers a shared hooks file that declares it with
`hooks.Interrupt: unknown hook event; entry ignored at runtime`, and the
2.1.263 binary contains no such string at all (checked 2026-09-07) — the entry
never did anything there, it only made a published plugin validate with a
warning. It lives in `hooks/codex.json` alone, where its `timeout` asks for the
3s Codex enforces anyway (`warning: clamping Interrupt hook timeout to 3s` on
every session that asks for more) — after the change that warning is gone from
a real `codex exec` run, verified live 2026-09-08 with the plugin reinstalled
from this repo's HEAD.

**`.mcp.json` ships the documented `mcpServers` wrapper.** A bare
`{"irc": …}` map loads too — that is what 0.1.0 shipped, and the copy in the
published catalog still runs on it (confirmed live 2026-09-08) — but the
plugins reference documents `{"mcpServers": {…}}` and nothing documents the
bare form. Changed and verified live the same day: a session in a throwaway
directory started the server and produced the whole run in IRC.

**`ircs://` to an ircd with a self-signed certificate needs `?insecure=1`.**
Live 2026-09-08 against ergo's 6697 on `irc.cihq`: with verification on the
connection fails cleanly and retries with backoff
(`[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self-signed
certificate`), which is the behaviour to want; with `?insecure=1` it registers
over TLSv1.3 (`TLS_AES_128_GCM_SHA256`), joins, delivers its line and quits.
That was the Python server's `ssl`; the port's `node:tls` (`rejectUnauthorized`
off only with `insecure=1`, SNI for host names only) is covered against the
fake ircd's TLS mode with the self-signed pair in `tests/fixtures/`, not
re-run against ergo.

**Codex substitutes nothing in a plugin's `.mcp.json`.** `${CLAUDE_PLUGIN_ROOT}`
and `${PLUGIN_ROOT}` arrive verbatim, the server starts in the session's cwd,
and no environment variable names the install root. The only thing the plugin
knows is its own name, so `.mcp.codex.json` locates itself. Until 0.2.x that
was a `python3 -c` bootstrap globbing `bin/agent-irc` (verified live
2026-09-05, Task 19). Without Python it is `sh -c`: the newest (by mtime, `-nt`)
of `$CODEX_HOME/plugins/cache/*/agent-irc/*/bootstrap/getty-bun.sh`,
`$CODEX_HOME` defaulting to `~/.codex`, exec'd as `sh <starter> run
dist/server.js codex`; none found, it says so on stderr and exits 1. The
starter takes the plugin root from its own path, so the cwd does not matter.
Live 2026-11-27 with `codex` 0.148.0 the locator found the copy, the server
started and logged `initialized by codex` (see the Bun port table below).
On Windows there is no `sh` to run it: Codex cannot start the server there
(G4, not tried live). Covered by `tests/codex_bootstrap.test.ts`. Codex also
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
see `tests/manifests.test.ts`, "codex hooks use a per event field whitelist",
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
event could be triggered live to confirm a wider whitelist is safe. Older
than all of that, `codex` 0.148.0 runs no `mcp_tool` hook at all: it skips
each one at config load with `skipping MCP tool hook in …/hooks/codex.json:
MCP invocation is not available yet` (8 per run, warm and cold; live
2026-11-27), so nothing reaches IRC from it although the server starts. The
Bun port has not been run under Codex ≥ 0.153 yet; the hook file is
byte-identical to the one verified there.

**Harnesses end the server by signal, not by EOF.** Task 19 assumed Codex's
missing closing line meant it drops the pipe without the stdin loop ever
observing an EOF; live re-verification (2026-09-05, Task 20) with
`RUST_LOG=debug` found the real mechanism instead: `MCP server stderr
(python3): agent-irc: signal 15, shutting down` — Codex just sends the
server a plain `SIGTERM` at session end, exactly like Claude Code. Neither
harness closes stdin. Claude Code sends `SIGINT` and, roughly 100ms later if
the process hasn't exited, escalates to `SIGTERM` (Task 18). In the Python
server that second signal could unwind a `shutdown()` already in progress
before the `QUIT` was written (reproduced 3/3), hence the rule that has
carried over to the port: `installSignalHandlers` in `src/server.ts` stops
on the *first* of `SIGTERM`/`SIGINT`/`SIGHUP` with exit code 128 + signum,
and a later one is only logged (`signal N, already shutting down`), so it
cannot cut the `QUIT` short; `shutdown()` is idempotent and hands every
caller the same promise. Two things differ under Bun: the handlers run on
the event loop, not by unwinding a blocked read, and a SIGINT/SIGTERM pair
sent back to back reaches them in no fixed order, so the exit code of such
a pair is 130 or 143 (Rules, above). The signals reach Bun directly because
the starter `exec`s it: `bin/agent-irc` → `sh getty-bun.sh` → Bun is one PID
(next trap). Live 2026-11-27 (`claude` 2.1.332): SIGINT then SIGTERM 0.1 s
apart through `bin/agent-irc` → starter → Bun gave exactly one `QUIT`; under
`codex` 0.148.0 the server logged `signal 15, shutting down` at session end.
Covered by `tests/end_to_end.test.ts` ("sigterm sends quit", "sigint sends
quit", "sighup sends quit", "sigint then sigterm still sends quit", "sigint
and sigterm at once: …") and `tests/server.test.ts`, "shutdown is
idempotent".

**Inbound is a pull, and that is not a design preference.** Neither harness
lets an MCP server wake a session that is idle at its prompt: there is no
server→client notification either one turns into a turn, and a hook only fires
when the session is already doing something. So `listen` collects into
the `Inbox` of `src/inbound.ts` and the agent has to call `read_messages` to get
anything — which only a looping session does. Two consequences worth keeping
in mind when touching this: the inbox has to be bounded (a session may never
call, and a channel keeps talking — 200 messages, oldest dropped), and the
allowlist has to deny by default, because everything in there is text a
stranger typed that ends up in the agent's context. `listen_from` is matched
against the whole `nick!user@host` with `fnmatch`, so a bare `vhost.example`
matches nothing; it takes `*!*@vhost.example`.

**`tools/list` happens before any event, so the listen decision cannot wait
for one.** The harness asks what tools the server has right after
`initialize`, long before the first `UserPromptSubmit` names a session or a
cwd. That is why `App.onInitialize` loads the config a second time, off the
process's own cwd (`App.cwd`, injectable for tests), purely to decide whether
`read_messages` is listed at all — quietly, since the session's own load does
the logging with the cwd the harness reports. A session whose real cwd
disagrees would still be answered by `read_messages` (the call is gated on the
inbox, not on the tool list); it just would not see the tool offered.

**Codex does not pass `CODEX_HOME` to the MCP server it starts; Claude Code
does pass `CLAUDE_CONFIG_DIR`.** Live 2026-09-08, `codex` 0.154.0-alpha.6:
a session started with `CODEX_HOME` pointing at an isolated home used that
home for everything of its own (auth, sessions, `models_cache.json`) and
still started an `agent-irc` that reported version 0.1.0 — the copy in
`~/.codex`, not the 0.1.1 installed in the isolated one. The same bootstrap
line run by hand picks the right copy when the variable is in its
environment, so the variable simply is not there for the child (that run
used the Python bootstrap; the `sh -c` locator reads the same variable the
same way):

    echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
      | CODEX_HOME=/tmp/x python3 -I -c "$(…the .mcp.codex.json bootstrap…)"
    → agent-irc 0.1.1: initialized      # with the variable
    → agent-irc 0.1.0: initialized      # without it, from ~/.codex

Consequences: under a custom `CODEX_HOME` the bootstrap either finds nothing
(and the server exits saying so) or, worse, silently runs a *stale* copy from
`~/.codex` — which then also reads `~/.codex/config.toml`, i.e. somebody
else's channels. Nothing in the plugin can fix this from inside; the
`CODEX_HOME` support in the locator and in `config.configHome` stays for
the day Codex passes it. Claude Code has no such problem: the same test with
`CLAUDE_CONFIG_DIR` (an isolated config dir, its own `settings.json`, its own
`.claude.json`, the plugin installed into it) produced a session that read
exactly that config and mirrored into the ircd it named — live 2026-09-08
against `claude` 2.1.263. The same holds for the starter's own variables:
`codex` 0.148.0 passes neither `GETTY_HOME` nor `GETTY_BUN_MIRROR` to the
server (live 2026-11-27: one run fetched Bun from github.com because the
mirror variable never arrived), so under Codex the slot is always
`~/.getty/runtimes/bun` and the download always GitHub.

**`SubagentStart`/`SubagentStop` are still not delivered in `codex`
0.154.0-alpha.6.** Re-checked 2026-09-08 the way Task 19 did, with a real
`spawn_agent` + `wait_agent` round trip: `codex exec` printed
`UserPromptSubmit`, `PreToolUse`/`PostToolUse` twice (the two collab tool
calls) and `Stop` — and no subagent hook at all. So the Codex limitations in
the README are not a 0.153 artefact; they are unchanged in the next version's
alpha.

**In `-p` (print) mode Claude Code refuses the `SessionEnd` mcp_tool hook
outright**, with `SessionEnd hook [plugin:agent-irc:irc/event] failed:
mcp_tool hooks are not available for the 'SessionEnd' hook event (no MCP
client context)` on stderr (2.1.263, live 2026-09-08); 2.1.332 words it
`SessionEnd hook … failed: MCP server … is not connected` (live 2026-11-27,
Bun port). Nothing is lost — the
closing summary comes from the signal handler either way — and the entry has
to stay, because in an *interactive* session `/clear` does deliver
`SessionEnd` to the running process (see the rollover trap above). It is
noise in headless runs only.

## The starter and Bun

**The starter `exec`s; it is not a parent.** `bin/agent-irc` (and the Codex
locator) `exec sh bootstrap/getty-bun.sh run dist/server.js <host>`, and the
starter ends in `exec "$slot/bin/bun" … "$root/dist/server.js" <host>`: the
harness's child is Bun itself, same PID (part A probe 3.3b), so signals and
stdin EOF reach the server with nothing in between. The starter's own `trap`s
(clean up staging and `.installing`, print `getty-bun: stopped by a signal
before Bun started`, exit 1) hold only until that `exec`, i.e. during an
install. `bin/agent-irc` resolves its directory physically (`cd -P` before
`..`), so a symlinked `bin/` or a symlink to the file still finds the real
plugin root (`tests/entry.test.ts`).

**stdout stays clean through an install.** The harness reads JSON-RPC from
the first byte, so the starter writes nothing to stdout in `run` (only
`status` prints there): its messages go to stderr, the fetcher's output into a
variable. Part A probe 3.3a: a first start with install produced exactly the
157-byte `initialize` answer on stdout. A failed install (mirror unreachable,
checksum mismatch, unsupported target) exits 1 with stdout empty and one
`getty-bun: …` line on stderr, which the harness logs as a server that did
not start.

**Bun runs isolated from the cwd and the environment.** The cwd is the
harness's (the project the session is in), so the starter runs Bun with
`--no-install --config=/dev/null --no-env-file` -- no auto-install, no
`bunfig.toml` (preload, `[define]`) and no `.env*` of the user's project --
and unsets `BUN_OPTIONS`, `BUN_INSPECT*`, `NODE_PATH` and the other variables
that would inject code. This repository's `bunfig.toml` is development-only
for the same reason: the shipped server never reads it.

**The curl guard.** The download runs `curl -q -fsS -L --connect-timeout 30
--speed-limit 1024 --speed-time 60` (`wget -T 60` without curl): a
connection that cannot be made in 30 s, or that stays below 1 KB/s for 60 s,
fails the install with the fetcher's exit code (28 for curl's stall). Under
Claude Code that shows as a server exiting during `initialize`, which Claude
Code restarts once (live 2026-11-27).

**The first start installs, and both harnesses give it about 30 s.** The
slot is per user and shared by every getty-bun plugin
(`~/.getty/runtimes/bun/1.4.5/<target>/`, `GETTY_HOME` moves `~/.getty`;
an install lock under `.locks/`, `GETTY_BUN_LOCK_WAIT` default 300 s), so
only the very first getty-bun start on a machine downloads (~51 MB for
linux-x64), and two concurrent cold starts share one download (live
2026-11-27). Locally, from a file mirror, a first start takes ~1.7 s and a
warm one ~57 ms to exit (part A, 3.3d). From GitHub it may not fit: a session
whose server is not up in time is **not mirrored** (G3 (b); README, "The
first start"). What the harnesses do then, live 2026-11-27 in a temp `HOME`
with a throttling local mirror:

- *Claude Code 2.1.332:* connect timeout 30000 ms by default (debug log),
  `MCP_TIMEOUT` honoured (90000 let a 65 s install connect at 66.8 s). A 5 s
  delay connected at 6.8 s, 15 s at 16.8 s; 35 s gave up at 30.03 s
  (`CONNECT_TIMEOUT … timed out after 30000ms`; `claude mcp list` the same
  after 30.95 s). The `mcp_tool` hook waits only 5 s for a connecting server
  (`waiting up to 5000ms`, then `skipped — MCP server not connected`, status
  1): in the 15 s run the first `UserPromptSubmit` and the event after it
  were skipped, and since the IRC connection starts on the first event the
  server sees, a session whose first prompt comes before the slot is ready
  is not mirrored at all. On giving up Claude Code sends SIGINT, SIGTERM
  ~0.1 s later and SIGKILL ~0.5 s later; the SIGKILL kills the starter's `sh`
  before its trap runs, the orphaned curl finishes, and the 51 MB
  `archive.zip` plus a stale `.installing` stay in `.staging/<id>/` -- no
  later successful install sweeps them. There is no reconnect within the
  session (the server installed by hand 20 s after the timeout: no reconnect
  within 51 s). And after a timeout Claude Code writes
  `mcp-needs-auth-cache.json` and does not start the server in new sessions
  for about 15 minutes (skipped at 14 min, started at 16 min). A server that
  exits during `initialize` is restarted once. Warm connect ~90 ms.
- *Codex 0.148.0:* handshake timeout 29.999 s (`timed out handshaking with MCP
  server after 29.999999777s`, logged only at session shutdown); a 15 s start
  connected at 16.8 s. `startup_timeout_sec` works only on a user-level
  `[mcp_servers.irc]` that repeats the plugin's command (`= 60` let a 45 s
  install connect at 46.9 s); `-c mcp_servers.irc.startup_timeout_sec=60`
  alone is rejected (no command). On giving up Codex kills starter and curl
  together at +30 s, leaving an empty staging dir and a stale `.installing`.
  No needs-auth cache: the next session starts and installs. Warm start ~40 ms.

**macOS and Windows.** The starter in `bootstrap/` (getty-bun at
`vars.bun_version = 1.4.5`) knows only `linux-x64`, `linux-x64-baseline` and
`linux-aarch64` (glibc); on macOS or musl it exits 1 with `unsupported
target`, so the plugin does not mirror there. macOS follows when getty-bun
ships darwin targets (the merge of `getty-bun` waits for that, hub F5).
Windows stays off (G4 (a)): under Claude Code `bin/agent-irc.exe` (mcpoff)
starts instead of the script and answers the hooks quietly; under Codex the
`sh -c` command has no `sh` to run in and the server does not start.

## Verified against real harnesses

The first table is the Python server's. The hooks are byte-identical in the
Bun port, so its hook-side rows still describe what the harness does; the
server-side rows were re-checked for the port where the second table says so.

Filled in by the live verification (plan Task 18), 2026-09-05, against
`claude` 2.1.261 and `codex` 0.153.4, with the Claude Code column extended
2026-09-08 against `claude` 2.1.263 (the rows below the `async: true` one); the Codex column was re-verified
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
| `async: true` keeps delivery order | not always: `PostToolUse` for a parent Agent tool call was observed to arrive before `SubagentStart` for the very subagent it spawned; handled without crashing (2026-09-05) | not observed the same way: `SubagentStart`/`SubagentStop` `mcp_tool` hooks never fired at all in any configuration tried, so there was nothing to compare ordering against (2026-09-05, see trap above); still true in 0.154.0-alpha.6 (2026-09-08) |
| `/clear` session rollover | live, interactive through a pty, 2026-09-08: `SessionEnd` reaches the *running* process (`■ session ended (clear)`), the next prompt announces a new session id over the same connection, no re-JOIN | n/a — Codex has no `/clear` reaching an `mcp_tool` hook, and refuses `SessionEnd` outright |
| idle notification (`Notification`, matcher `idle_prompt`) | yes — `==== … WAITING FOR INPUT ====` exactly 60s after the turn ended, live 2026-09-08 | not observed |
| `PermissionRequest` reaches IRC | yes — `⚠ permission: AskUserQuestion`, live 2026-09-08 | not observed: could not be triggered from `codex exec` (2026-09-05), which is why its field whitelist stays at the base set |
| `ircs://` to a self-signed ircd | live 2026-09-08 against ergo's 6697: refused with verification on (clean failure, backoff retry), TLSv1.3 with `?insecure=1`, line delivered | not tested — same connection code, nothing harness-specific |
| a moved config directory (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) | passed through to the MCP server: an isolated config dir with its own `settings.json` was the one the session used, live 2026-09-08 | **not** passed: the server started under an isolated `CODEX_HOME` resolved its own copy, and its config, out of `~/.codex` (2026-09-08, see trap above) |
| inbound `read_messages` | live 2026-09-08: `listen` + `listen_from` in an isolated config, seven DMs from the allowed mask returned in order, the disallowed sender's never; the call itself shows in the mirror as `⚙ read_messages` | not tested — same code path, nothing harness-specific beyond the tool listing |
| install from the published catalog | live 2026-09-08 in an isolated `CLAUDE_CONFIG_DIR`: `plugin marketplace add Getty/marketplace` + `plugin install agent-irc@getty`, then a real session produced session line, prompt, turn summary and QUIT in the channel | `codex plugin add agent-irc@getty` verified live 2026-09-06 |

### The Bun port (K9, 2026-11-27)

`claude` 2.1.332 (newer than the rows above) and `codex` 0.148.0 (**older**
than the 0.153/0.154 above). Method: a temp `HOME`, a scratch
`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, the plugin installed from a working-tree
copy, the fake ircd (`bun tests/run_fakeirc.ts`) as the only IRC server, a
local throttling mirror for the Bun download; no credentials (`claude -p`
unauthenticated still runs the hooks; Codex against a local stub
`/v1/responses` provider). Not run: an interactive `/mcp` reconnect, the idle
notification, `/clear` on the Bun port, anything on macOS or Windows.

| Item | Claude Code 2.1.332 | Codex 0.148.0 |
|---|---|---|
| server starts through the starter, `initialize` logged | `initialized by claude`; warm connect ~90 ms | `initialized by codex`; warm start ~40 ms |
| MCP start timeout | 30000 ms; `MCP_TIMEOUT` honoured (90000: a 65 s install connected at 66.8 s) | 29.999 s handshake, logged only at session shutdown; `startup_timeout_sec` only via a user-level `[mcp_servers.irc]` with the command (60: a 45 s install connected at 46.9 s) |
| slow first start | 5 s → connected at 6.8 s, 15 s → 16.8 s, 35 s → gave up at 30.03 s | 15 s → connected at 16.8 s |
| hook while the server is still connecting | waits 5 s, then `skipped — MCP server not connected`; 15 s run: first `UserPromptSubmit` and the next event skipped, session not mirrored | not observable: every `mcp_tool` hook is skipped anyway (row below) |
| after the timeout | SIGINT, SIGTERM +0.1 s, SIGKILL +0.5 s; orphaned curl, 51 MB `archive.zip` + stale `.installing` left in `.staging/<id>/`; no reconnect in the session; `mcp-needs-auth-cache.json`, no server start for ~15 min | starter and curl killed together at +30 s; empty staging dir + stale `.installing`; next session starts and installs |
| server exits during `initialize` (curl guard, exit 28) | restarted once | not observed |
| two concurrent cold starts | one download, shared | not tested |
| hooks reach the server | yes: NICK/USER/JOIN, `▶ session`, `» hi`, `✖ turn failed` (no credential), one `QUIT` | **no**: `skipping MCP tool hook in …/hooks/codex.json: MCP invocation is not available yet`, 8 per run, warm and cold; re-check on ≥ 0.153 |
| SIGINT then SIGTERM 0.1 s apart through `bin/agent-irc` → starter → Bun | exactly one `QUIT` | session end: `signal 15, shutting down` |
| `-p` `SessionEnd` | `SessionEnd hook … failed: MCP server … is not connected` (2.1.263 said `mcp_tool hooks are not available …`) | n/a, no `SessionEnd` hook |
| `GETTY_HOME` / `GETTY_BUN_MIRROR` reach the server | not separately recorded | **no**: one run fetched Bun from github.com because of it |

## The agent team

Start Claude in this folder. The session you talk to hands the work to the right agent.

- `agent-irc-worker`: server code, hooks, manifests, the Codex bootstrap and their tests,
  and the README, `CLAUDE.md` or spec lines that record what it found.
- `agent-irc-live-check`: live runs against real `claude`/`codex` and an ircd, in scratch
  config directories; reports what it saw, writes no repository file.
- `agent-irc-reviewer`: checks a finished card independently and runs the check (Rules)
  itself; changes nothing.
- `agent-irc-release-manager`: commits reviewed work, keeps `Changes`, stamps a version and
  checks a release on request.

`OWNERS` is the authoritative write-path map. Work is tracked with karr (`karr board`); rules
in `.claude/rules/agent-irc-rules.md`. `agent-irc-release-manager` commits reviewed work.
Nothing is pushed, released or posted without your word, unless the project rules allow it:
the karr board, which goes to `origin` with every change.
