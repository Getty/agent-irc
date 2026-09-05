# Changelog

## 0.1.0 — unreleased

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
- Add: `AGENT_IRC_DEBUG=1` logs every raw event and every transcript read
  failure to stderr (spec §6.1, §9.3).
