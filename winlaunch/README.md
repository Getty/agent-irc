# mcpoff

agent-irc is off on Windows. Its hooks are of type `mcp_tool`, and Claude Code
reports "not connected" for every hook event when the MCP server does not
start. So on Windows the server is `bin/agent-irc.exe`, which Claude Code finds
for the extensionless `.mcp.json` command: an MCP server that connects, offers
the tools named on the `# mcpoff: tools` line of `bin/agent-irc` and answers
every call with an empty result. Linux and macOS run `bin/agent-irc` itself.

- `build.py OUT.exe --src mcpoff.c` builds it reproducibly with zig 0.13
  (`pip install ziglang==0.13.0.post1`); the same source gives the same bytes
  on Windows and Linux.
- `.cicd/python+3.12+test.mcpoff.sh` rebuilds it in CI and compares it with the
  committed `bin/agent-irc.exe`.

The source of truth is `tools/winlaunch` in the windows-developer hub; this is
a copy.
