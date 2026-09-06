# agent-irc

Mirrors a Claude Code or Codex session into IRC: what the agent does, how long
it takes, what it costs in tokens, and what its subagents consumed. One IRC
nick per session, lines in one or more channels, optionally the full prompt
and answer texts.

```
<agent-irc-1> ▶ session e873ddde · claude claude-fable-5-1 · ~/dev/agent-irc
<agent-irc-1> » ok ich würde gern ein codex und claude plugin machen…
<agent-irc-1> ⚙ Bash 1.2s: ls -la && find . -maxdepth 3
<agent-irc-1> ⇢ subagent Explore: find hook payloads
<agent-irc-1> ⇠ subagent Explore done · 42s · 18 tools · 31k in / 2k out · claude-sonnet-5
<agent-irc-1> ⚠ permission: Bash: rm -rf build
<agent-irc-1> ✔ turn · 3m12s · 24 tools · 210k in (190k cached) / 6k out · claude-fable-5-1
```

No dependencies: Python 3.9+ standard library. Works in Claude Code and Codex
from the same code.

## Install

From the [Getty marketplace](https://github.com/Getty/marketplace):

```
# Claude Code
/plugin marketplace add Getty/marketplace
/plugin install agent-irc@getty

# Codex
codex plugin marketplace add Getty/marketplace
codex plugin add agent-irc@getty
```

Codex asks once to trust the plugin's hooks. Until you do, nothing happens.
Codex does not deliver `SessionEnd` to MCP tool hooks, but the server still
ends the session with the same closing `QUIT` summary line as Claude Code:
both harnesses end the server process with a signal rather than a
`SessionEnd` event, and the server catches that signal to send it. See
`CLAUDE.md` for details.

## Configure

Configuration lives in the harness's own settings, under the key `agent-irc`.
There is no separate config file.

Claude Code, `~/.claude/settings.json`:

```json
{
  "agent-irc": {
    "channels": ["ircs://getty:${IRCD_PASSWORD}@irc.example.org:6697/#agents"],
    "level": "activity"
  }
}
```

Codex, `~/.codex/config.toml`:

```toml
[agent-irc]
channels = ["ircs://getty:${IRCD_PASSWORD}@irc.example.org:6697/#agents"]
level = "activity"
```

### Server URLs

```
ircs://[user[:password]@]host[:port]/channel[?insecure=1]
irc://[user[:password]@]host[:port]/channel
```

`ircs` is TLS (default port 6697), `irc` is plaintext (6667). `user` becomes
the IRC username in the hostmask, `password` is sent as the ircd `PASS`. The
channel may be written with or without `#`. `${VAR}` is replaced from the
environment, so a committed project file never has to contain a password.
`?insecure=1` skips certificate verification.

### Channel lists

Every key named `channels` or `<name>_channels` is a list of server URLs.
Lists are resolved by name across the config levels, user first, then the
project:

| Claude Code | Codex |
|---|---|
| `~/.claude/settings.json` | `~/.codex/config.toml` |
| `<project>/.claude/settings.json` | `<project>/.codex/config.toml` |
| `<project>/.claude/settings.local.json` | |

**Same name overrides, new name adds.** The session joins the union of all
lists. So with user-level `channels` and `log_channels`:

| project sets | result |
|---|---|
| nothing | both user lists |
| `simpici_channels = [...]` | both user lists plus `#simpici` |
| `channels = ["ircs://…other-server…/#foo"]` | `#foo` on the other server, plus the user's `log_channels` |
| `channels = [...]`, `log_channels = []` | only the project's `channels` |
| `channels = []`, `log_channels = []` | silent |

Project-level files are read only when the harness trusts the directory,
so a cloned repository cannot redirect your sessions.

### Levels

| `level` | sends |
|---|---|
| `activity` (default) | session start/end, first line of each prompt, tool calls with duration, subagent start/stop with duration and tokens, turn end with duration and tokens, permission requests, failures, compaction, the model as soon as the session knows it, model switches |
| `subactivity` | plus the tool calls inside subagents, prefixed with the subagent's id |
| `full` | plus the full prompt, the full final answer of every turn, and the complete input of every tool call -- every field, every line, nothing shortened |

Tool outputs are never sent.

When a background agent stops, the harness wakes the session with a
`<task-notification>` block as the prompt. Rather than relay the raw XML, the
plugin folds it into one line -- `↩ agent "..." completed` -- and at `full`
puts the agent's own result (or, for a stopped agent, the reason it gives)
underneath.

At `activity` and `subactivity` a tool call is one line, so a long or
multi-line input is folded into spaces and cut at 120 characters. At `full`
that line keeps its first line whole and the input follows underneath, field
by field:

```
<agent-irc-1> ⚙ Write 0.3s: agent_irc/events.py [+812 lines]
<agent-irc-1>   file_path: /home/getty/dev/agent-irc/agent_irc/events.py
<agent-irc-1>   content:
<agent-irc-1>     """Turn hook events into IRC lines (spec §8)."""
<agent-irc-1>     …
```

A body that would only repeat its head line is left out, so a plain
`Read` or a one-line `Bash` still costs a single line.

### Sending rate

`full` can mean thousands of lines from one tool call, which the defaults --
sized for a public server -- will not deliver: they send one line every two
seconds and drop everything past 500 queued. On your own ircd, raise them.

| key | default | means |
|---|---|---|
| `flood_burst` | `4` | lines that may go out back to back |
| `flood_interval` | `2.0` | seconds per line after that |
| `queue_limit` | `500` | lines that may wait; `0` never drops |

```json
{
  "agent-irc": {
    "channels": ["ircs://getty:${IRCD_PASSWORD}@irc.example.org:6697/#agents"],
    "level": "full",
    "flood_burst": 200,
    "flood_interval": 0.05,
    "queue_limit": 0
  }
}
```

A line longer than the server takes is split across as many `PRIVMSG`s as it
needs, never truncated; servers that advertise `LINELEN` (8192 is common) are
taken at their word, so on those there is far less splitting to do.

### Clients and server

Any IRC client works, but two are easy to recommend: [Halloy](https://halloy.chat)
(modern, cross-platform, and comfortable with long lines) and, on Windows, the
classic [mIRC](https://www.mirc.com). For your own ircd, [ergo](https://ergo.chat)
is the one this plugin is developed against: a single self-contained binary that
advertises a large `LINELEN` (8192), so a `full`-level line -- a whole file, a
long answer -- is split into far fewer messages than a stock 512-byte server
would need. Running your own also lets you raise the sending rate (see above)
without antagonising a public server.

**Codex 0.153 limitations:** no `⇢`/`⇠` subagent start/stop lines at any
level (Codex never delivers the hooks for them); a Codex subagent's own tool
calls appear as, and count toward, the main turn instead of the subagent;
and `PermissionRequest`/`PostCompact` carry less detail than on Claude Code.
See `CLAUDE.md` for why.

## How it works

The plugin bundles one MCP server, `irc`, which the harness starts with the
session and stops with it. Every hook is an `mcp_tool` hook that hands the
event to that server, which formats a line and delivers it over the IRC
connections it keeps open. Token counts come from the session transcript.
Details in `docs/superpowers/specs/2026-09-05-agent-irc-design.md`.

## Development

```
python3 -m unittest discover tests
```

Tests use an in-process fake IRC server and never touch the network beyond
`127.0.0.1`. See `CLAUDE.md` for the two-harness traps.

**Debugging:** set `AGENT_IRC_DEBUG=1` in the environment the harness starts
the server with to log every raw event, and any transcript read that fails
unexpectedly; stderr lands in the harness's MCP log.

## License

Copyright (c) 2026 Torsten Raudssus.

This is free software; you can redistribute it and/or modify it under the
terms of the [Artistic License 2.0](LICENSE).
