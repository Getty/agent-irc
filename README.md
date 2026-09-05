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

**Codex 0.153.x cannot run this plugin yet.** Codex does not substitute
`${CLAUDE_PLUGIN_ROOT}` (or `${PLUGIN_ROOT}`) inside a plugin's `.mcp.json`,
so the bundled MCP server never starts ("MCP client for `irc` failed to
start: ... connection closed: initialize response") and no event reaches
IRC. Verified live 2026-09-05; see `CLAUDE.md`'s verification table. Claude
Code is unaffected.

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
| `activity` (default) | session start/end, first line of each prompt, tool calls with duration, subagent start/stop with duration and tokens, turn end with duration and tokens, permission requests, failures, compaction, model switches |
| `subactivity` | plus the tool calls inside subagents, prefixed with the subagent's id |
| `full` | plus the full prompt and the full final answer of every turn |

Tool outputs are never sent.

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

## License

Artistic License 2.0.
