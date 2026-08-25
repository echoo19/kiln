# Setting up kiln

This file is written for an agent doing the setup, and it reads fine if a person
would rather do it by hand. Work through it in order. Anything that needs a
browser login or a pasted secret belongs to the human, so stop and ask instead
of trying to automate it.

kiln is a local web app. A Node server owns a set of pty sessions, and a canvas
in the browser draws them. Nothing leaves the machine except the agent CLIs
talking to their own vendors.

---

## 1. Check the ground

```sh
node -v          # must be v20 or newer
npm -v
```

If Node is missing: macOS `brew install node`, Debian or Ubuntu
`sudo apt install nodejs npm` (or nodesource for a current version), Windows
`winget install OpenJS.NodeJS.LTS`. Do not install Node through a script piped
from a URL without asking first.

## 2. Install kiln

```sh
npm install -g echoo19/kiln
kiln --version
```

That installs straight from GitHub, which is where kiln lives. (The bare name
`kiln` on npm belongs to someone else, so the published name, if it is ever
published, is `@echoo19/kiln`.)

From a clone instead, for development or to run a fork:

```sh
git clone https://github.com/echoo19/kiln.git && cd kiln
npm install
npm link          # puts `kiln` on PATH
```

`npm link` needs no sudo on a Node installed through a version manager (nvm,
fnm, volta). On a system Node it may. If it fails with EACCES, switch to a
version manager rather than running npm as root.

## 3. Install the agent CLIs

kiln drives two of them, and works with either one alone.

### Claude Code

```sh
curl -fsSL https://claude.ai/install.sh | bash     # macOS / Linux
npm install -g @anthropic-ai/claude-code           # any platform
```

On Windows: `irm https://claude.ai/install.ps1 | iex`, or the npm line above.

### Codex

```sh
npm install -g @openai/codex
# or: brew install codex
```

Check that both are on PATH:

```sh
claude --version
codex --version
```

Neither has to be present. kiln detects what is there at startup and only offers
those engines. `kiln server` prints `engines: claude=… codex=…` on its first
line.

> If you install a CLI while the kiln server is already running, restart the
> server. It resolves the CLIs once at startup, and a PATH edit made by an
> installer never reaches a process that started before it.

## 4. Log in, which is the human's part

Both CLIs authenticate through a browser. Do not try to paste tokens, capture
codes, or automate these:

```sh
claude          # then /login inside the TUI
codex login
```

Ask the human to run whichever one is not signed in, and wait. Claude Code
stores its credentials in `~/.claude`, Codex in `~/.codex`.

Watch for a subscription being billed as API usage. If `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` is set in the environment, a CLI may quietly use it instead of
the subscription the human logged in with. kiln hides those two variables from
the agent it launches and hands them back to the shell afterwards, so a card
started from kiln uses the login. Set `KILN_KEEP_API_KEYS=1` only if the human
actually intends to authenticate with the key.

## 5. Start it

```sh
kiln
```

- starts the server if the port is free, waits for it to answer, opens the canvas
- if a server is already up it only opens the window, so running `kiln` twice is safe
- `kiln server` runs in the foreground with logs on stdout, which is what you want when debugging
- `kiln open` opens the window without starting anything

Check that it is alive:

```sh
curl -s http://127.0.0.1:5456/api/history
```

Environment, all optional:

| variable | default | what it does |
|---|---|---|
| `KILN_PORT` | `5456` | port to listen on |
| `KILN_DATA` | `~/.kiln` | where state, tokens, prompts and the hook settings live |
| `KILN_PROJECTS_ROOT` | `~/projects` | the folder the **+** picker lists |
| `KILN_KEEP_API_KEYS` | unset | `1` leaves `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` visible to agents |
| `KILN_TEST_PLAIN` | unset | `1` dispatches bare shells instead of agents, used by the tests |
| `KILN_SHELL` | bash | the shell a card runs, on macOS and Linux |

## 6. Add projects

Drop repos under `~/projects` and they appear in the **+** menu in the top bar.
Anything outside that folder can be added by typing an absolute path in the same
menu.

Adding a project creates `<project>/.kiln/index.md` with four empty headings,
described in section 9. Nothing else in the repo is touched.

## 7. Tokens, in the secrets drawer

Tokens live in named profiles under `$KILN_DATA/profiles/<name>.env`. A project
picks one profile in project settings, and every card dispatched on that project
gets those variables in its environment, with the project's own `.env` or
`.envrc` layered on top.

In the UI: key icon in the rail, then pick a profile name, a type, and paste the
value. The type picks the variable name the tools actually read:

| type | sets |
|---|---|
| github | `GITHUB_TOKEN`, `GH_TOKEN` |
| openai | `OPENAI_API_KEY` |
| anthropic | `ANTHROPIC_API_KEY` |
| vercel | `VERCEL_TOKEN` |
| supabase | `SUPABASE_ACCESS_TOKEN` |
| elevenlabs | `ELEVENLABS_API_KEY` |
| npm | `NPM_TOKEN` |
| huggingface | `HF_TOKEN` |
| custom | whatever name you give it |

Never paste a secret yourself. If setup needs a token, ask the human to add it in
that drawer. You can confirm it landed without seeing it, because the API only
ever returns the last four characters:

```sh
curl -s http://127.0.0.1:5456/api/profiles
```

The bootstrap prompt tells every dispatched agent which variables exist by name,
and forbids echoing their values. Follow that: reference `$GITHUB_TOKEN`, never
its contents.

## 8. Connections, meaning MCP servers

The links drawer holds one list of MCP servers, and every card gets it, on both
engines. Add one with a name and the command that starts it:

```
name:     linear
command:  npx -y @acme/mcp-linear
env:      LINEAR_TOKEN=…        (optional, comma separated)
```

Or through the API:

```sh
curl -s -X PUT http://127.0.0.1:5456/api/connections/linear \
  -H 'content-type: application/json' \
  -d '{"command":"npx","args":["-y","@acme/mcp-linear"],"env":{"LINEAR_TOKEN":"…"}}'
```

The list is stored in `$KILN_DATA/mcp.json` and reaches the engines two
different ways. Claude Code takes the file directly as `--mcp-config`, merged
with whatever is already in the user's own config. Codex has no such flag, so
each server is passed as `-c mcp_servers.<name>.…` overrides, which is the same
thing its `config.toml` would have said.

kiln does not edit `~/.claude.json` or `~/.codex/config.toml`. Those belong to
the human, and a canvas that silently rewrites them is one you cannot trust. A
connection added here is additive and disappears cleanly when it is removed.

Values are masked everywhere they come back out. A connection whose token is a
secret should still take that token from a secrets profile where it can.

## 9. Project memory

Each project keeps a small memory beside the code:

```
<project>/.kiln/
├── index.md     what every agent reads before it starts
└── runs/*.md    one short note per finished assignment
```

`index.md` has four fixed headings, Decisions, Components, Conventions and
Gotchas, and a hard budget of 8KB. This is the part most worth getting right,
because it is the part that rots.

- The index is a working set rather than a log. Adding a fact means editing the
  fact it belongs to, or replacing one that is now wrong. Never append a new
  section, never narrate what you did, and never record what the code, tests or
  git history already say.
- If something is only true this week, it does not go in.
- The server refuses a save over the budget, so an index that has grown has to
  be tightened before it can be extended. That pressure is deliberate.
- Run notes are evidence: short, newest first, capped, and pruned to the newest
  20 at the next dispatch. A note the index links to is kept regardless of age.
  Never bulk-read them; open one only when the index points at it.

Read it, verify it against the code before trusting it, and leave it smaller and
truer than you found it.

## 10. Skills

The skills drawer lists what is installed in `~/.claude/skills` and
`~/.claude/plugins/installed`, and can dispatch an installer agent at a source
you paste. Skills are a Claude Code feature, so Codex cards ignore them.

## 11. Status, hooks, notifications

There is nothing to configure. kiln writes `$KILN_DATA/claude-hooks.json` at
startup and hands it to every Claude Code card with `--settings`, so card status
comes from real lifecycle events instead of scraping the screen. A card goes
NEEDS YOU when the agent asks something, READY when it finishes a turn, and
stays RUNNING through a quiet build. Subagents appear as small nodes wired to
their parent, and a browser card appears when an agent starts driving Chrome.

Codex has no hooks but does support a notify program, which kiln points at
`hooks/codex-notify.js`, so codex cards flip to READY on real telemetry too.

If a card never leaves RUNNING, check that `node` is on the PATH the CLI sees.
The hooks are node scripts.

## 12. Start it at login, if you want that

On macOS, write `~/Library/LaunchAgents/dev.kiln.server.plist` and
`launchctl load` it:

```xml
<plist version="1.0"><dict>
  <key>Label</key><string>dev.kiln.server</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/kiln</string><string>server</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

Use the real path from `which kiln`. A version-managed Node puts it elsewhere.

On Linux, write `~/.config/systemd/user/kiln.service` and
`systemctl --user enable --now kiln`:

```ini
[Unit]
Description=kiln
[Service]
ExecStart=%h/.local/bin/kiln server
Restart=on-failure
[Install]
WantedBy=default.target
```

On Windows, put a shortcut to `kiln` in `shell:startup` (Win+R, then
`shell:startup`).

Sessions do not survive a reboot, but the cards do. After a restart the canvas
comes back with every card in place, marked offline, and a click restarts one.
Claude Code cards resume their conversation rather than starting over.

## 13. Verify the whole thing

```sh
curl -s http://127.0.0.1:5456/api/history          # server answers
curl -s http://127.0.0.1:5456/api/connections      # connections list
curl -s http://127.0.0.1:5456/api/profiles         # profiles, masked
ls "$HOME/.kiln"                                   # state, prompts, hooks
```

Then dispatch one small task from the UI and watch the card. It should reach
READY on its own, and a run note should appear in `<project>/.kiln/runs/`.

To check the plumbing without spending tokens:

```sh
cd "$(npm root -g)/@echoo19/kiln" && npm test
```

## 14. When something is wrong

| symptom | cause |
|---|---|
| `kiln` opens an empty window | the server is not up; run `kiln server` and read the error |
| an engine is missing from the dispatch form | its CLI is not on the PATH the server saw, so restart the server after installing |
| a card dies at a shell prompt | the CLI exited immediately, and the reason is on screen, usually "not logged in" |
| a card is stuck on RUNNING | hooks are not reaching the server, so check that `node` is on PATH |
| "reached another local app" in the browser | something else took the port, so set `KILN_PORT` |
| terminal text selects at the wrong place | known limit: selection misaligns when canvas zoom is not 100% |

Logs go to `$KILN_DATA/server.log` when the `kiln` launcher started the server,
and to stdout when `kiln server` did.

## 15. Removing it

```sh
npm uninstall -g kiln
rm -rf ~/.kiln
```

Per-project memory lives in each repo's `.kiln/` folder and is left alone, so
delete those separately if you want them gone. Nothing else on the machine was
modified.
