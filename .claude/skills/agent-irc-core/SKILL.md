---
name: agent-irc-core
description: Use when working in agent-irc, the Claude Code and Codex plugin that mirrors a session into IRC — where things are, the check on Python 3.13 and 3.9, the fake ircd, the version and Changes mechanics, the release path and how a live check is run.
---

# agent-irc: the repository

What it does: `README.md`. The design: `docs/superpowers/specs/2026-09-05-agent-irc-design.md`.
Guidance and every harness trap found so far: `CLAUDE.md` ("Rules", "Two-harness traps",
"Verified against real harnesses"). Before changing code, read the trap that names it;
most of them were found live and are not visible in the code.

## Layout

From `CLAUDE.md` "Shape" and `git ls-files`:

- `agent_irc/`: `text`, `config` (settings, trust, merge, the TOML fallback), `usage`
  (transcript readers), `events` (event to logical lines), `irc` (connection thread),
  `mcp` (JSON-RPC loop), `server` (wiring, signals), `inbound` (inbox, allowlist).
- `bin/agent-irc`: the entry point. `bin/agent-irc.exe`: the Windows `mcpoff` build, a copy
  whose source of truth is `tools/winlaunch` in the windows-developer hub (`winlaunch/README.md`).
- `hooks/hooks.json`: Claude Code, loaded by convention. `hooks/codex.json`: Codex, a
  per-event field whitelist, bare server name `irc`, no `SessionEnd`.
- `.claude-plugin/plugin.json` (no `version`), `.codex-plugin/plugin.json` (`version`),
  `.mcp.json`, `.mcp.codex.json` (the self-locating Codex bootstrap).
- `tests/`: `unittest`, one flat folder. `tests/fakeirc.py` is the fake ircd;
  `python3 tests/run_fakeirc.py [port]` runs it standalone, prints every line it receives
  and pushes stdin lines to every client (how inbound traffic is fed in). `tests/fixtures/`:
  the test TLS key pair.

## The check

- `python3 -m unittest discover tests`: about 13 s (298 tests on 3.13, 2026-11-26).
- `"$(uv python find 3.9)" -m unittest discover tests` (`uv python install 3.9` once): about
  12 s, and the one way the `tomllib` fallback in `agent_irc/config.py` runs on a 3.11+
  development Python. CI (`.github/workflows/test.yml`) runs 3.9 to 3.13 and has gone red
  on exactly that path.
- CI also runs `.github/workflows/ci.yml` (simpici), which executes
  `.cicd/python+3.12+test.mcpoff.sh`: it rebuilds `mcpoff.exe` with zig and compares it byte
  for byte with `bin/agent-irc.exe`.
- Tests use no network beyond localhost (`CLAUDE.md`, "Rules").

## Version, Changes, commits, release

- The version lives in `agent_irc/__init__.py` (`__version__`) and
  `.codex-plugin/plugin.json`; `tests/test_manifests.py::test_versions_match` keeps them
  equal and asserts that `.claude-plugin/plugin.json` has none (Claude Code takes the version
  from the commit since `d7f483c`).
- `Changes` is in the CPAN format (`566d8e3`): newest first, unreleased entries under
  `{{$NEXT}}`, a release line is the version, padded, and the UTC time of the release commit
  (`0.2.1     2026-10-06 05:22:18Z`). Only user-visible changes get an entry.
- Commits: skill `getty-git-commit-style`. History before `5f27895` carries Conventional
  Commits prefixes (`fix:`, `docs:`); they are not the norm any more.
- Tags are annotated and bare (`0.2.1`), message `<version> — <what>`.
- A push to `main` is a release for Claude Code users: the `getty` marketplace pins no
  version, and the plugin's version is the commit (`Changes`, `{{$NEXT}}`).

## A live check

Recorded in `CLAUDE.md`'s verification table, one row per item, with harness version and date.

- Isolated config: a scratch `CLAUDE_CONFIG_DIR` (Claude Code passes it to the server) with
  its own `settings.json`, the plugin installed into it from this repository. A scratch
  `CODEX_HOME` does **not** reach the MCP server (`CLAUDE.md`, the moved-config-directory
  trap): a Codex run then loads the copy and the config in the real `~/.codex`.
- Interactive-only behaviour (`/clear`, the idle notification) is driven through a pty
  (`python3`, `pty.openpty`, `subprocess`). The trust dialog starts on "No, exit": send
  `\x1b[B` before `\r`; its text arrives with spaces stripped, so match on `trust`.
- Evidence comes from the ircd's side: `tests/run_fakeirc.py` prints every line, or a
  second IRC client joins the channel as a witness.
- `codex exec` needs `--dangerously-bypass-hook-trust`; `-p` mode refuses the `SessionEnd`
  hook with a harmless error (`CLAUDE.md`).
