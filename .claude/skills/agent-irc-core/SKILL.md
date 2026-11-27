---
name: agent-irc-core
description: Use when working in agent-irc, the Claude Code and Codex plugin that mirrors a session into IRC — where things are, the Bun check, the fake ircd, the getty-bun starter, the version and Changes mechanics, the release path and how a live check is run.
---

# agent-irc: the repository

What it does: `README.md`. The design: `docs/superpowers/specs/2026-09-05-agent-irc-design.md`.
Guidance and every harness trap found so far: `CLAUDE.md` ("Rules", "Two-harness traps",
"Verified against real harnesses"). Before changing code, read the trap that names it;
most of them were found live and are not visible in the code.

## Layout

From `CLAUDE.md` "Shape" and `git ls-files`:

- `src/` (TypeScript, a port of the former Python package): `text`, `py` (Python-compatible
  helpers), `config` (settings, trust, merge, TOML via `Bun.TOML.parse`), `usage` (transcript
  readers), `events` (event to logical lines), `irc` (connection, event loop), `mcp` (JSON-RPC
  loop), `server` (wiring, signals), `inbound` (inbox, allowlist), `version` (the release
  manager's). `dist/server.js`: the committed bundle (`bun build --target=bun`, `// @bun`).
- `bootstrap/getty-bun.sh`, `bootstrap/getty-bun.ps1`: the getty-bun starters, a byte-equal
  copy of the `getty-bun-install@agent-bun-runtime` render (`.claude/skilletor.json`: `ref`,
  `vars.bun_version`); never edited by hand. `package.json` `gettyBun.bunVersion` equals the pin.
- `bin/agent-irc`: the entry point, a `#!/bin/sh` wrapper that runs
  `sh bootstrap/getty-bun.sh run dist/server.js claude-code` (the starter `exec`s into Bun). `bin/agent-irc.exe`: the Windows `mcpoff` build, a copy
  whose source of truth is `tools/winlaunch` in the windows-developer hub (`winlaunch/README.md`).
- `hooks/hooks.json`: Claude Code, loaded by convention. `hooks/codex.json`: Codex, a
  per-event field whitelist, bare server name `irc`, no `SessionEnd`.
- `.claude-plugin/plugin.json` (no `version`), `.codex-plugin/plugin.json` (`version`),
  `.mcp.json`, `.mcp.codex.json` (the `sh -c` locator: newest `…/agent-irc/*/bootstrap/getty-bun.sh`
  under `${CODEX_HOME:-$HOME/.codex}/plugins/cache`, `run dist/server.js codex`).
- `tests/`: `bun:test`, one flat folder of `*.test.ts`. `tests/fakeirc.ts` is the fake ircd;
  `bun tests/run_fakeirc.ts [port] [--tls] [--isupport TOKEN]` runs it standalone, prints every line it receives
  and pushes stdin lines to every client (how inbound traffic is fed in). `tests/fixtures/`:
  the test TLS key pair.

## The check

On the pinned Bun 1.4.5 (on agent-lab: `~/dev/agent-bun-runtime/.dev/harness/bun`, linked as
`bun` into a temp bin dir; no Node needed, `bunfig.toml` runs `tsc` on Bun), with a temp `HOME`,
`XDG_CACHE_HOME` and `BUN_INSTALL_CACHE_DIR`:

- `bun install --frozen-lockfile`, then `bun run typecheck` (exit 0).
- `bun test`: 0 fail (402 pass, 5 skip, 8–16 s, 2026-11-27; run it
  twice when `src/irc.ts`, `src/server.ts` or their tests change: the timing tests). The skips include
  `tests/starter.test.ts`, which runs the real starter end to end only when
  `AGENT_IRC_BUN_MIRROR` names a Bun mirror (a `file://` copy of agent-bun-runtime's
  `.dev/fixtures`, or GitHub); run it whenever `bin/`, `bootstrap/` or `.mcp*.json` change.
- `bun run check`: `dist/server.js` equals a fresh build (`scripts/dist.sh`, refuses any Bun
  but the pin).
- The starters: `cmp bootstrap/getty-bun.sh .claude/skills/getty-bun-install/bootstrap/getty-bun.sh`,
  the same for `.ps1`, and `grep -qx "# version 1.4.5" bootstrap/getty-bun.sh`; the rendered copy
  comes from `skilletor trust agent-bun-runtime` + `skilletor sync --scope project`
  (skill `getty-bun-install`, §4).
- CI also runs `.github/workflows/ci.yml` (simpici), which executes
  `.cicd/python+3.12+test.mcpoff.sh`: it rebuilds `mcpoff.exe` with zig and compares it byte
  for byte with `bin/agent-irc.exe`.
- Tests use no network beyond localhost (`CLAUDE.md`, "Rules").

## Version, Changes, commits, release

- The version lives in `src/version.ts` (`VERSION`) and
  `.codex-plugin/plugin.json`; `tests/manifests.test.ts` ("versions match") keeps them
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
  trap): a Codex run then loads the copy and the config in `$HOME/.codex`, so `HOME` has to be a
  temp dir as well. `GETTY_HOME` and `GETTY_BUN_MIRROR` do not reach a Codex-started server either.
- Interactive-only behaviour (`/clear`, the idle notification) is driven through a pty
  (e.g. `python3` with `pty.openpty` and `subprocess`, a tool script outside the repository). The trust dialog starts on "No, exit": send
  `\x1b[B` before `\r`; its text arrives with spaces stripped, so match on `trust`.
- Evidence comes from the ircd's side: `bun tests/run_fakeirc.ts` prints every line, or a
  second IRC client joins the channel as a witness.
- `codex exec` needs `--dangerously-bypass-hook-trust`; `-p` mode refuses the `SessionEnd`
  hook with a harmless error (`CLAUDE.md`).
