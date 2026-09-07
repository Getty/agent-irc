# Changelog

## Unreleased

- Fix: the queue cap counted one entry per channel, so a connection with two
  channels filled up after half as many lines and a drop could remove a line
  from one channel while the other kept it. The queue now holds logical
  lines and fans each out to every channel.
- Fix: `437` (nick held by the server after a netsplit or a recent QUIT) is
  answered like `433` by trying the next nick, instead of letting
  registration run into its timeout; `464` (wrong server password) now stops
  the connection instead of retrying the same password forever.
- Fix: a failed `Agent` tool call left its queued description in the FIFO, so
  every later subagent was announced with the description of the call before
  it. Descriptions are keyed by `tool_use_id` now, and the queue is bounded.
- Fix: IPv6 literals in server URLs (`irc://[2001:db8::1]:6667/#c`) parse.
- Fix: the 2s timeout that keeps a partial TLS record from blocking the stop
  path no longer bounds sending as well.
- Fix: `.mcp.json` uses the documented `{"mcpServers": {…}}` shape.
- Fix: `hooks/hooks.json` no longer declares `Interrupt`, which Claude Code
  does not know (it was ignored at runtime and made `claude plugin validate`
  warn); Codex's copy asks for the 3s timeout Codex enforces there anyway.

## 0.1.0 — 2026-09-06

- First version: MCP server as session process, `mcp_tool` hooks for Claude
  Code and Codex, named channel lists in the harness settings, three levels
  (`activity`, `subactivity`, `full`), token usage from transcripts, one nick
  per session.
- Fix: the Codex MCP server bootstrap (`.mcp.codex.json`) now runs Python in
  isolated mode (`-I`), so a cloned repo's own top-level `glob.py`/`runpy.py`
  can no longer shadow the stdlib modules the bootstrap imports and execute
  on Codex startup.
- Fix: both harnesses end the server process with a signal (`SIGINT` and/or
  `SIGTERM`), not by closing stdin or delivering `SessionEnd`; the server
  now catches the signal and still sends the closing `QUIT` summary, even
  when a second signal lands while the first is still shutting down.
- Fix: a new `session_id` arriving in the same running MCP server (a
  `/clear` or `/resume`) now starts a fresh session — with its own `▶`
  announcement and its own turn/tool/token counters — instead of the old
  session silently absorbing the new one's events.
- Add: TLS (`ircs://`) connections are now covered by tests, against a real
  self-signed certificate, for both the insecure and certificate-verifying
  cases; a partial TLS record can no longer block the stop path for up to
  the full 30s registration timeout.
- Add: `AGENT_IRC_DEBUG=1` logs every raw event, and any transcript read
  that fails unexpectedly, to stderr (spec §6.1, §9.3).
