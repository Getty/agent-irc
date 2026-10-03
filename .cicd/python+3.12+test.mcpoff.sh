#!/bin/sh
# Rebuild mcpoff.exe from winlaunch/mcpoff.c and check that bin/agent-irc.exe,
# what Claude Code starts on Windows in place of the MCP server, is byte for
# byte that build. See winlaunch/README.md.
set -eu
python3 -m venv "$CICD_OUTPUT/venv"
"$CICD_OUTPUT/venv/bin/pip" install --quiet ziglang==0.13.0.post1
"$CICD_OUTPUT/venv/bin/python" "$CICD_WORKSPACE/winlaunch/build.py" "$CICD_OUTPUT/mcpoff.exe" --src mcpoff.c
sha256sum "$CICD_OUTPUT/mcpoff.exe"
if cmp -s "$CICD_WORKSPACE/bin/agent-irc.exe" "$CICD_OUTPUT/mcpoff.exe"; then
	echo "ok   bin/agent-irc.exe"
else
	echo "FAIL bin/agent-irc.exe is not a build of winlaunch/mcpoff.c"
	exit 1
fi
