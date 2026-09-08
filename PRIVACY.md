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
- `full`: additionally the complete text of every prompt, the complete final
  answer of every turn, **and the complete input of every tool call** — every
  field, every line, nothing shortened. A `Write` therefore sends the whole
  file it writes, an `Edit` both of its strings, a patch its whole diff, an
  MCP tool call all of its arguments. `full` is for an ircd of your own.

Tool outputs — file contents read, command output — are never sent at any
level. What a tool *is asked to do* is; at `full` that is the entire request.

Every session also tells the channel who it is: the nick is the project
directory's name plus a counter (`agent-irc-1`), and the IRC realname carries
the harness, the session id and the full working directory, which anyone on
the server can read with `/whois`.

With `listen` on (off by default), information also flows the other way: the
plugin keeps the direct messages sent to the session's nick and the channel
lines that name it, and hands them to the agent when it calls `read_messages`.
Only senders matching `listen_from` are kept, and that list accepts nobody
until you fill it in. Those messages live in memory, are never written to disk
and are never sent back to IRC -- but they do become part of what the agent
reads, so whoever you allow can put text in front of it. Everyone in a channel
can see the nick, so treat `listen_from` as the whole boundary. The plugin has
no way to say anything in the channel on the agent's behalf.

Use `ircs://` so the transport is encrypted. Keep passwords in your user-level
settings, in `.claude/settings.local.json`, or in the environment via
`${VAR}`; a project file that is committed should not contain them.

The plugin reads: your harness settings files, the harness trust markers
(`~/.claude.json`, `~/.codex/config.toml`), and the session transcripts the
harness names in its hook events. It writes nothing to disk itself — but its
stderr goes wherever the harness keeps its MCP server logs, and with
`AGENT_IRC_DEBUG=1` that stderr includes every raw hook event, prompt texts
among them.
