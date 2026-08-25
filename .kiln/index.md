# kiln memory

Kept under 8KB on purpose. Every agent reads this before it works, so adding
something means editing or replacing something — not appending.

## Decisions

- kiln is the general-purpose fork of jakeos (`C:\JakeOS\jakeos`, Windows-only,
  five engines). Here: macOS + Linux + Windows, Claude Code and Codex only,
  installed with `npm i -g kiln`. Fixes worth sharing belong in both trees.
- Everything platform-shaped lives in one place — the shell layer in
  `server/index.js` (`quote`, `shellArgs`, `withHidden`, `SHELL_BIN`) plus
  `killTree` and `openExternal`. The rest of the file reads the same everywhere.
- State lives in `~/.kiln`, not next to the code: a global npm install is
  read-only. `KILN_DATA` overrides it.
- Project memory is a working set with an enforced budget: 8KB index, 4KB run
  notes, newest 20 kept, pruned at dispatch, index-cited notes exempt. The server
  refuses an oversized save — tightening is the normal state, not a chore.
- One MCP list for both engines (`$KILN_DATA/mcp.json`, the **links** drawer).
  Claude Code gets `--mcp-config`, Codex gets `-c mcp_servers.*` overrides. kiln
  never edits `~/.claude.json` or `~/.codex/config.toml` — those are the user's.
- No identity toggle: both CLIs authenticate as themselves. `CATALOG[engine]`
  still carries an empty `auths` array so an engine that grows one later fits.

## Components

- `server/index.js` — pty dispatch, hook relay, status engine, memory, prompts,
  skills, secrets, connections, usage, file API. `public/app.js` — the canvas.
  No build step.
- `bin/kiln.js` — the launcher. `kiln` starts the server only if the port is not
  answering, waits for a real response, then opens the browser; `kiln server`
  runs in the foreground.
- Port **5456** ("KILN"), both loopback stacks so nothing can shadow half of it.
- `$KILN_DATA/claude-hooks.json` is generated at startup, not shipped: the hook
  commands are absolute paths to `hooks/relay.js` and kiln installs anywhere.
  Paths inside it use forward slashes — Git Bash eats backslashes.
- Starter prompts ship in `prompts/` and are copied into `$KILN_DATA/prompts`
  on first run only.
- `test/smoke.js` (`npm test`) boots a throwaway server with `KILN_TEST_PLAIN=1`,
  so cards are bare shells and no tokens are spent.

## Conventions

- Server edits need a restart; `public/` is served from disk, so client edits
  need only a refresh.
- The trailing interactive shell is deliberately `--norc` / `-NoProfile` with a
  fixed `kiln>` prompt: the status engine reads a bare prompt as "no agent has
  the foreground", and a themed dotfile prompt makes that unreadable.
- Status comes from hooks, never from scraping the screen. Claude Code via
  `hooks/relay.js`, Codex via its notify program (`hooks/codex-notify.js`).
- Secrets go out masked, always. Values reach pty environments and nothing else,
  and are scrubbed from scrollback before it is written to disk.
- README stays short and human; `AGENTS.md` is the full setup guide.

## Gotchas

- CLIs are resolved once at startup. Installing `claude` or `codex` while the
  server is running does not reach it — restart, or the engine stays missing.
- An ambient `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` beats the subscription the
  user logged in with, silently and on a metered bill. `withHidden()` strips the
  relevant one per engine and hands it back to the shell after the agent exits.
  `KILN_KEEP_API_KEYS=1` opts out.
- Terminal output only renders at the width it was written at, so `cols`/`rows`
  travel with the scrollback and a restarted card reuses its own geometry.
- Nothing on a card may render grey: agent TUIs mark their own chrome with SGR 2
  and xterm draws that at half alpha. `termWrite()` strips it; anything faint
  server-side must use a colour (`ESC[90m`).
- On POSIX the pty child is a session leader, so `process.kill(-pid)` reaps the
  whole tree; Windows needs `taskkill /T /F`. Both matter — orphaned dev servers
  were the single largest source of wasted CPU in jakeos.
- Codex's `-c` values need their inner double quotes escaped on Windows
  (PowerShell eats bare ones) and plain elsewhere — that is what `DQ` is for.
