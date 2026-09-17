/*
 * kiln server.
 * PTY dispatch engine, hook-driven lifecycle, per-project memory,
 * preset prompts, skills inventory, usage accounting, file API.
 *
 * Runs on macOS, Linux and Windows: everything platform-shaped lives in the
 * shell layer below (quoting, the trailing interactive shell, process trees,
 * opening things in the desktop) so the rest of the file reads the same
 * everywhere.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { exec, execSync } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('@lydell/node-pty');

const ROOT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';
// Installed globally, kiln lives in a read-only npm prefix, so state goes to
// the user's home. KILN_DATA lets a test instance keep its own beside it.
const DATA = process.env.KILN_DATA ||
  (fs.existsSync(path.join(ROOT, '.kiln-dev')) ? path.join(ROOT, 'data')
    : path.join(os.homedir(), '.kiln'));
// 5456 ("KILN" on a phone keypad). Deliberately not 3000/5173/4173: those are
// dev-server defaults, and an agent running one would shadow kiln on localhost.
const PORT = process.env.KILN_PORT ? Number(process.env.KILN_PORT) : 5456;
// Claude Code's hook settings, handed to every claude card with --settings.
// Written at startup rather than shipped as a file: the commands inside it are
// absolute paths to hooks/relay.js, and kiln can be installed anywhere.
//
// Paths go in with forward slashes on purpose. Claude Code runs hook commands
// through a shell, and when that shell is Git Bash on Windows a backslash path
// loses its separators (C:\kiln becomes C:kiln) and node exits MODULE_NOT_FOUND.
// Forward slashes work in sh, PowerShell and cmd alike.
const HOOKS_FILE = path.join(DATA, 'claude-hooks.json');
function writeHooksFile() {
  const cmd = `node ${JSON.stringify(path.join(ROOT, 'hooks', 'relay.js').replace(/\\/g, '/'))}`;
  const one = () => [{ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }];
  // The matcher is a regex over the tool name. Task drives the subagent minis,
  // the mcp__ browser tools drive browser cards, and Bash is what keeps a card
  // reading RUNNING through a long build or test run. Widening it further costs
  // a node spawn per tool call.
  const tools = () => [{
    matcher: 'Task|Bash|mcp__.*(chrome|browser|playwright)',
    hooks: [{ type: 'command', command: cmd, timeout: 5 }],
  }];
  const hooks = {
    SessionStart: one(), SessionEnd: one(), UserPromptSubmit: one(),
    PreToolUse: tools(), PostToolUse: tools(),
    SubagentStop: one(), Notification: one(), Stop: one(),
  };
  try { fs.writeFileSync(HOOKS_FILE, JSON.stringify({ hooks }, null, 2)); }
  catch (err) { console.error('hook settings not written:', err.message); }
}

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_ROOT = process.env.KILN_PROJECTS_ROOT ||
  path.join(os.homedir(), WIN ? 'Projects' : 'projects');
try { fs.mkdirSync(PROJECTS_ROOT, { recursive: true }); } catch { /* non-fatal */ }

const SCROLLBACK_LIMIT = 300_000;
const WORKING_WINDOW_MS = 1600;
const NEEDS_YOU_SETTLE_MS = 6000;
const STATUS_TICK_MS = 500;
const STATUS_COMMIT_MS = 900;
const ECHO_GRACE_MS = 300;
const ECHO_MAX_BYTES = 12;
// Debounced output flush: wait for a quiet gap so a TUI redraw frame arrives
// as one write (a frame split mid-escape makes the cursor visibly wander),
// but never hold output longer than the max.
const DATA_FLUSH_MS = 10;
const DATA_FLUSH_MAX_MS = 50;
const SESSIONS_SAVE_MS = 3_000;
const SESSIONS_SAVE_MAX_MS = 20_000;
const SUBAGENT_LINGER_MS = 15_000;
const BROWSER_LINGER_MS = 180_000;
const HISTORY_CAP = 50;

// Project memory is a working set, not a log. Every dispatched agent reads the
// index, so its size is a tax on every run — an index left to grow becomes the
// most expensive file in the repo and the least trusted, because nobody prunes
// what nobody reads. So the budget is enforced here rather than requested in
// prose: the index has a byte cap, run notes have a cap and a keep count, and
// anything past either is trimmed at dispatch.
const MEM_DIR = '.kiln';          // per-project memory folder, lives with the repo
const MEMORY_INDEX_MAX = 8_000;   // ~2k tokens: one screen of durable facts
const MEMORY_RUN_MAX = 4_000;     // one run note
const MEMORY_RUNS_KEEP = 20;      // newest kept, older ones deleted

const PROJECT_COLORS = [
  '#e8845a', '#4cc2ff', '#3fd68c', '#e8a33d',
  '#a78bfa', '#e06c9f', '#38d4c3', '#cbd267',
];

const CODENAMES = [
  'atlas', 'orion', 'vega', 'lyra', 'argo', 'juno', 'rhea', 'kai',
  'nova', 'ember', 'sable', 'quill', 'baron', 'delta', 'echo', 'flint',
  'gale', 'harbor', 'indigo', 'jasper', 'koda', 'lumen', 'mesa', 'onyx',
];
function genCodename() {
  const name = CODENAMES[Math.floor(Math.random() * CODENAMES.length)];
  return `${name}-${10 + Math.floor(Math.random() * 90)}`;
}

for (const d of [DATA, path.join(DATA, 'prompts'), path.join(DATA, 'profiles')]) fs.mkdirSync(d, { recursive: true });
writeHooksFile();
// First run has no prompts. Copy the starters in rather than shipping an empty
// drawer; they are ordinary files afterwards, editable and deletable.
(() => {
  const src = path.join(ROOT, 'prompts');
  const dst = path.join(DATA, 'prompts');
  try {
    if (fs.readdirSync(dst).some((f) => f.endsWith('.md'))) return;
    for (const f of fs.readdirSync(src)) {
      if (f.endsWith('.md')) fs.copyFileSync(path.join(src, f), path.join(dst, f));
    }
  } catch { /* no starters shipped, or nothing to do */ }
})();

// ---------------------------------------------------------------------------
// Persistent state
// ---------------------------------------------------------------------------
const STATE_FILE = path.join(DATA, 'state.json');
const HISTORY_FILE = path.join(DATA, 'history.json');
let projects = [];
// Removing a project drops its record, but the folder on disk is untouched and
// so is the profile it was wired to — re-adding the same path should not ask
// again. Settings are remembered per lowercased path, outliving the record.
let projectPrefs = {};
(() => {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Array.isArray(raw.projects)) projects = raw.projects;
    if (raw.projectPrefs && typeof raw.projectPrefs === 'object') projectPrefs = raw.projectPrefs;
  } catch { /* first run */ }
  // migrate v1 state file location
  try {
    if (!projects.length && fs.existsSync(path.join(ROOT, 'state.json'))) {
      const old = JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8'));
      if (Array.isArray(old.projects)) { projects = old.projects; saveState(); }
      fs.unlinkSync(path.join(ROOT, 'state.json'));
    }
  } catch { /* ignore */ }
  // Projects registered before prefs existed have never been remembered, so
  // the first removal would still lose their profile. Backfill on boot.
  for (const p of projects) if (!projectPrefs[prefKey(p.path)]) rememberProjectPrefs(p);
})();
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ projects, projectPrefs }, null, 2)); }
  catch (err) { console.error('state save failed:', err.message); }
}
function prefKey(dir) { return String(dir || '').toLowerCase(); }
// Called on every change to a project's settings and once more as it is
// removed, so what comes back on a re-add is the last thing that was true.
function rememberProjectPrefs(p) {
  if (!p || !p.path) return;
  projectPrefs[prefKey(p.path)] = {
    envProfile: p.envProfile || null,
    defaults: p.defaults || null,
  };
}
function restoreProjectPrefs(p) {
  const pref = projectPrefs[prefKey(p.path)];
  if (!pref) return;
  if (pref.envProfile && fs.existsSync(path.join(PROFILES_DIR, `${pref.envProfile}.env`))) {
    p.envProfile = pref.envProfile;
  }
  if (pref.defaults) p.defaults = pref.defaults;
}
function nextProjectColor() {
  const used = new Set(projects.map((p) => p.color));
  return PROJECT_COLORS.find((c) => !used.has(c)) ||
    PROJECT_COLORS[projects.length % PROJECT_COLORS.length];
}
function project(id) { return projects.find((p) => p.id === id) || null; }
// A bare timestamp collides when two projects are added in the same
// millisecond, and then every card dispatched to the second one lands in the
// first. Salt it and check.
function uniqueProjectId() {
  let id;
  do {
    id = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  } while (projects.some((p) => p.id === id));
  return id;
}

// Canvas notes: markdown scratchpads that survive restarts (data/notes.json).
const NOTES_FILE = path.join(DATA, 'notes.json');
let notes = [];
try { notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')); if (!Array.isArray(notes)) notes = []; }
catch { /* none yet */ }
// Notes predate per-project workspaces. Park the ones written before that on
// the first project so they stay somewhere visible instead of nowhere.
if (notes.some((n) => !('projectId' in n))) {
  const fallback = projects[0]?.id || null;
  for (const n of notes) if (!('projectId' in n)) n.projectId = fallback;
  try { fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2)); }
  catch { /* it will be written on the next edit */ }
}
let notesTimer = null;
function saveNotes() {
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => {
    try { fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2)); }
    catch (err) { console.error('notes save failed:', err.message); }
  }, 400);
}
function note(id) { return notes.find((n) => n.id === id) || null; }

// Session cards survive the server (data/sessions.json). The pty itself cannot
// outlive us, so what comes back after a restart or a reboot is the card: same
// place on the canvas, same title, same scrollback, marked offline until you
// restart it. Claude sessions relaunch with --resume so the conversation
// continues rather than starting from scratch.
const SESSIONS_FILE = path.join(DATA, 'sessions.json');
const PERSIST_SCROLLBACK = 120_000; // chars kept on disk per card
let sessionsTimer = null;
let sessionsDue = 0;

// Scrollback is whatever was on the screen, and something may have echoed a
// token onto it. On screen that is the user's own terminal, but writing it to
// disk would leave secrets sitting in data/sessions.json, so scrub the values
// this session was given on the way out.
function redactSecrets(text, s) {
  let out = text;
  for (const value of Object.values(sessionEnvVars(s))) {
    if (typeof value === 'string' && value.length >= 8 && out.includes(value)) {
      out = out.split(value).join('[redacted]');
    }
  }
  return out;
}

function sessionRecord(s) {
  return {
    id: s.id, codename: s.codename, title: s.title, engine: s.engine,
    auth: s.auth || null,
    projectId: s.projectId, cmdLabel: s.cmdLabel, cwd: s.cwd,
    taskSummary: s.taskSummary, model: s.model, effort: s.effort,
    skipPermissions: s.skipPermissions, loadEnv: s.loadEnv,
    envProfile: s.envProfile, envCount: s.envCount,
    bootstrap: s.bootstrap, agentSessionId: s.agentSessionId,
    startedAt: s.startedAt, exitCode: s.exitCode,
    x: s.x, y: s.y, w: s.w, h: s.h,
    // The geometry the scrollback below was written at. Replaying it at any
    // other width shreds it, so it travels with the text.
    cols: s.cols, rows: s.rows,
    scrollback: redactSecrets(s.buffer.join('').slice(-PERSIST_SCROLLBACK), s),
  };
}

function saveSessions() {
  clearTimeout(sessionsTimer);
  sessionsTimer = null;
  sessionsDue = 0;
  const tmp = SESSIONS_FILE + '.tmp';
  try {
    const records = [...sessions.values()].map(sessionRecord);
    fs.writeFileSync(tmp, JSON.stringify({ nextSessionId, sessions: records }));
    fs.renameSync(tmp, SESSIONS_FILE); // never leave a half-written file behind
  } catch (err) {
    console.error('sessions save failed:', err.message);
  }
}

// Called on every chunk of output, so it has to be cheap: coalesce to one write
// every few seconds and never let a busy session postpone it forever.
function saveSessionsSoon() {
  const now = Date.now();
  if (!sessionsDue) sessionsDue = now;
  if (now - sessionsDue > SESSIONS_SAVE_MAX_MS) { saveSessions(); return; }
  clearTimeout(sessionsTimer);
  sessionsTimer = setTimeout(saveSessions, SESSIONS_SAVE_MS);
}

function loadSessions() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { return; }
  if (!raw || !Array.isArray(raw.sessions)) return;
  for (const r of raw.sessions) {
    const scrollback = typeof r.scrollback === 'string' ? r.scrollback : '';
    sessions.set(String(r.id), {
      ...r,
      id: String(r.id),
      proc: null,
      buffer: scrollback ? [scrollback] : [],
      bufferLen: scrollback.length,
      pending: '', flushTimer: null, pendingSince: 0,
      status: 'offline', note: null, hookState: null,
      toolsRunning: new Set(), browser: null,
      agentAlive: false, finished: true,
      lastActivity: 0, lastInput: 0, lastTail: '',
      hooksSeen: false, wantStatus: null, wantSince: 0,
    });
  }
  nextSessionId = Math.max(Number(raw.nextSessionId) || 1,
    ...[...sessions.keys()].map((k) => Number(k) + 1));
}

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}
function appendHistory(rec) {
  const hist = readHistory();
  hist.unshift(rec);
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(hist.slice(0, HISTORY_CAP), null, 2)); }
  catch (err) { console.error('history save failed:', err.message); }
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------
// A CLI is usable if it is on PATH, or if we know where its installer puts it.
// The PATH case matters less than it looks: the installers edit the user's
// shell profile, and a server process that was already running never sees that
// edit — so the fallbacks below are what make a freshly installed CLI work
// without a new login session.
function resolveCli(name, fallbacks = []) {
  try {
    execSync(WIN ? `where.exe ${name}` : `command -v ${name}`,
      { stdio: 'pipe', shell: WIN ? undefined : '/bin/sh' });
    return name;
  } catch { /* keep looking */ }
  for (const p of fallbacks) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}
const HOME = os.homedir();
const CLI = {
  claude: resolveCli('claude', [
    path.join(HOME, '.claude', 'local', 'claude'),
    path.join(HOME, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
    path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
  ]),
  codex: resolveCli('codex', [
    path.join(HOME, '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
    path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
  ]),
};
const engines = Object.fromEntries(Object.entries(CLI).map(([k, v]) => [k, !!v]));

// Native model + reasoning catalogs. Values feed real CLI flags, so anything
// outside these lists is rejected at spawn. `byAuth` keys on an identity for
// engines that have more than one; both of these have exactly one, so '*'.
const CATALOG = {
  claude: {
    label: 'claude code', auths: [],
    byAuth: {
      '*': {
        models: [
          { id: 'fable', label: 'fable' },
          { id: 'opus', label: 'opus' },
          { id: 'sonnet', label: 'sonnet' },
          { id: 'haiku', label: 'haiku' },
        ],
        defaultModel: 'opus',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'medium',
      },
    },
  },
  codex: {
    label: 'codex cli', auths: [],
    byAuth: {
      '*': {
        models: [
          { id: 'gpt-5.6-sol', label: 'sol · gpt-5.6' },
          { id: 'gpt-5.6-terra', label: 'terra · gpt-5.6' },
          { id: 'gpt-5.6-luna', label: 'luna · gpt-5.6' },
          { id: 'gpt-5.6-pro', label: 'pro · gpt-5.6' },
          { id: 'gpt-5.3-codex', label: 'gpt-5.3-codex' },
        ],
        defaultModel: 'gpt-5.6-sol',
        efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultEffort: 'medium',
      },
    },
  },
};

function pickEngine(requested) {
  if (CATALOG[requested] && engines[requested]) return requested;
  return ['claude', 'codex'].find((e) => engines[e]) || 'claude';
}
function pickAuth(engine, requested) {
  const cat = CATALOG[engine];
  if (!cat || !cat.auths.length) return null;
  return cat.auths.some((a) => a.id === requested) ? requested : cat.defaultAuth;
}
function authView(engine, auth) {
  const cat = CATALOG[engine] || CATALOG.claude;
  return cat.byAuth[auth || '*'] || cat.byAuth[cat.defaultAuth] || cat.byAuth['*'];
}
function pickModel(engine, auth, requested) {
  const v = authView(engine, auth);
  return v.models.some((m) => m.id === requested) ? requested : v.defaultModel;
}
function pickEffort(engine, auth, requested) {
  const v = authView(engine, auth);
  return v.efforts.includes(requested) ? requested : v.defaultEffort;
}

// ---------------------------------------------------------------------------
// .env / .envrc loading (direnv, translated)
// Values go into the PTY environment only — never to clients, never in prompts.
// ---------------------------------------------------------------------------
function parseEnvText(text) {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if (/[$`]/.test(val)) continue; // no shell evaluation — literals only
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[m[1]] = val;
  }
  return vars;
}

function loadProjectEnv(dir) {
  const vars = {};
  for (const file of ['.env', '.envrc']) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) continue;
    try { Object.assign(vars, parseEnvText(fs.readFileSync(p, 'utf8'))); } catch { /* skip */ }
  }
  return vars;
}

// Env profiles: named KEY=VALUE sets in data/profiles/<name>.env, chosen
// per project in its settings. Set a token once, point projects at it.
const PROFILES_DIR = path.join(DATA, 'profiles');
function profileSlug(name) { return String(name || '').replace(/[^a-z0-9-_]/gi, '').slice(0, 40); }
function loadProfileEnv(name) {
  const slug = profileSlug(name);
  if (!slug) return {};
  try { return parseEnvText(fs.readFileSync(path.join(PROFILES_DIR, `${slug}.env`), 'utf8')); }
  catch { return {}; }
}

// ---------------------------------------------------------------------------
// Bootstrap prompt assembly
// ---------------------------------------------------------------------------
function buildBootstrap({ codename, proj, task, envNames = [], envProfile = null }) {
  const lines = [];
  lines.push(`You are agent "${codename}"${proj ? ` dispatched on project "${proj.name}" at ${proj.path}` : ''}.`);
  if (task) lines.push('', 'Assignment:', task);
  lines.push('', 'Before working: read CLAUDE.md at the repository root if it exists.');
  if (envNames.length) {
    // Naming the variables is what makes them usable. An agent that only hears
    // "some secrets are loaded" will not think to reach for GITHUB_TOKEN, and
    // the names are not the secret; the values are.
    const shown = envNames.slice(0, 40);
    const more = envNames.length - shown.length;
    lines.push(
      `Credentials are already loaded into this shell${envProfile ? ` (profile "${envProfile}" plus project .env/.envrc)` : ' from .env/.envrc'}: ` +
      shown.join(', ') + (more > 0 ? `, and ${more} more` : '') + '.',
      `Use them by reference, never by value: ${WIN ? '$env:NAME' : '$NAME'}, and anything you launch ` +
      'from this terminal inherits them, so most CLIs pick them up with no extra work. ' +
      'Never print, echo or log a value, and never copy one into a prompt, note, file, or commit. ' +
      'If a tool needs one, pass the variable through rather than pasting what is in it.');
  }
  if (proj) {
    // The memory contract is written as a budget, not an invitation. "Append a
    // run note, update the index" produces a file that grows every dispatch and
    // is trusted less each time; "the index is capped, adding means replacing"
    // produces one that stays worth reading. The cap is enforced in code too
    // (pruneMemory), so this is the reason, not the mechanism.
    lines.push(
      `Project memory: ${path.join(proj.path, MEM_DIR)}/index.md — decisions, components, conventions and gotchas that stay true. Read it before you touch anything. It is curated prior context, ` +
      'not ground truth: verify anything that may have drifted.',
      `It is capped at ${Math.round(MEMORY_INDEX_MAX / 1000)}KB and stays that way. When you learn something ` +
      'durable, edit the fact it belongs to or replace one that is now wrong — do not append a new section, do not narrate what you did, and do not record what the code, tests, or git history already say. ' +
      'If it is only true this week, it does not go in.',
      `When your assignment is complete, write a short run note to ${MEM_DIR}/runs/${codename}-${Date.now().toString(36)}.md ` +
      `(what changed, why, gotchas — under ${Math.round(MEMORY_RUN_MAX / 1000)}KB), then fold anything durable ` +
      'from it into index.md. Run notes are evidence, kept newest-first and pruned automatically; never bulk-read them.');
  }
  // Long-running processes were the single largest source of wasted CPU on this
  // box: dev servers accumulated across dispatches, three copies of one Next
  // server spinning a core each with no agent left to own them. Closing a card
  // now reaps its whole process tree, but an agent that finishes and leaves the
  // card open still leaks — so ask for the explicit stop.
  lines.push(
    'Long-running processes are yours to clean up. If you start a dev server, watcher, tunnel ' +
    'or other background process, stop it once you are done with it — do not leave it running ' +
    'for the next agent. Before starting one, check whether an instance is already listening ' +
    'rather than adding another.');
  lines.push(
    'Subagents: delegate only independent, bounded work. Keep working while delegates run. ' +
    'Use cheaper models for simple subtasks.');
  if (!task) {
    lines.push('', 'No assignment yet. Reply with one short ready line and wait for instructions. [FV-ACK]');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Shell layer
// ---------------------------------------------------------------------------
// One card = one pty running one shell. The shell runs the agent, and when the
// agent exits it drops to an interactive prompt rather than closing the card,
// so whatever the agent left on screen stays readable and you can keep typing.
//
// That trailing shell deliberately skips your rc files and sets a fixed prompt
// string: the status engine reads "a bare prompt is the last thing on screen"
// as "no agent has the foreground", and a themed prompt from someone's dotfiles
// (starship, powerlevel10k) makes that unreadable.
const SHELL_MARK = 'kiln>';
// bash by default even on a zsh machine: it is the shell whose no-rc behaviour
// is predictable everywhere. KILN_SHELL overrides it for anyone who wants their
// own (zsh keeps its rc files out with -f, and anything else runs as-is).
const POSIX_SHELL = process.env.KILN_SHELL ||
  (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
const NO_RC = POSIX_SHELL.endsWith('bash') ? '--norc'
  : POSIX_SHELL.endsWith('zsh') ? '-f' : null;
const SHELL_BIN = WIN ? 'powershell.exe' : POSIX_SHELL;

// Single-quote for the shell we are about to spawn.
function quote(s) {
  const v = String(s);
  return WIN ? `'${v.replace(/'/g, "''")}'` : `'${v.split("'").join(`'\\''`)}'`;
}

// A command line becomes spawn arguments. Windows takes it base64'd as UTF-16
// (-EncodedCommand) because quoting survives nothing else intact.
function shellArgs(cmd) {
  if (WIN) {
    const full = `${cmd}; function prompt { '${SHELL_MARK} ' }`;
    return ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand',
      Buffer.from(full, 'utf16le').toString('base64')];
  }
  // PS1 and PROMPT are both exported: the shell being exec'd reads its prompt
  // from the environment, and with the rc files skipped there is no dotfile left
  // to override it. (zsh reads PROMPT, everything else PS1 — setting both costs
  // nothing and means one code path.)
  const tail = [POSIX_SHELL, NO_RC, '-i'].filter(Boolean).join(' ');
  const prompt = `export PS1='${SHELL_MARK} ' PROMPT='${SHELL_MARK} '`;
  return [...(NO_RC ? [NO_RC] : []), '-c', `${cmd}\n${prompt}\nexec ${tail}`];
}

// Hide a variable from the agent, hand it back to the shell afterwards.
function withHidden(keys, cmd) {
  if (WIN) {
    const save = keys.map((k, i) => `$kh${i}=$env:${k}; Remove-Item Env:${k} -ErrorAction SilentlyContinue;`).join(' ');
    const restore = keys.map((k, i) => `if ($kh${i}) { $env:${k}=$kh${i} }`).join('; ');
    return `${save} ${cmd}; ${restore}`;
  }
  const save = keys.map((k, i) => `kh${i}="$${k}"; unset ${k};`).join(' ');
  const restore = keys.map((k, i) => `[ -n "$kh${i}" ] && export ${k}="$kh${i}";`).join(' ');
  return `${save} ${cmd}; ${restore} true`;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
// Sessions// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
const sessions = new Map();
const subagents = new Map();
let nextSessionId = 1;

function publicSession(s) {
  return {
    id: s.id, codename: s.codename, title: s.title, engine: s.engine,
    auth: s.auth || null,
    projectId: s.projectId, cmdLabel: s.cmdLabel, cwd: s.cwd, task: s.taskSummary,
    envCount: s.envCount, model: s.model || null, effort: s.effort || null,
    envProfile: s.envProfile || null,
    status: s.status, exitCode: s.exitCode, note: s.note,
    alive: !!s.proc, canResume: !!resumableId(s),
    startedAt: s.startedAt, x: s.x, y: s.y, w: s.w, h: s.h,
    cols: s.cols || null, rows: s.rows || null,
    browser: s.browser ? {
      actions: s.browser.actions, lastUrl: s.browser.lastUrl,
      shot: s.browser.shot, lastTs: s.browser.lastTs,
    } : null,
  };
}
function publicSubagent(a) {
  return {
    id: a.id, parentId: a.parentId, title: a.title, type: a.type,
    status: a.status, startedAt: a.startedAt, endedAt: a.endedAt,
  };
}

// If the kiln server was started from inside an agent's terminal, its own
// process.env carries that agent's session markers, and every session we spawn
// inherits them. Claude Code reads CLAUDE_CODE_CHILD_SESSION as "you are a
// nested run" and turns transcript saving off, which is why dispatched agents
// were invisible to --resume. Strip the markers so each session is a real
// top-level one, and say so out loud rather than relying on inheritance.
const INHERITED_AGENT_VARS = [
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_SKIP_PROMPT_HISTORY',
  'CODEX_SESSION_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED',
];
function cleanAgentEnv(source) {
  const env = { ...source };
  for (const key of INHERITED_AGENT_VARS) delete env[key];
  // kiln is the terminal emulator for dispatched processes. A NO_COLOR from
  // whichever shell happened to start the server describes that parent shell,
  // not this truecolor xterm, and Codex honors it by flattening its whole TUI.
  // Remove the opt-out before advertising the capabilities below.
  delete env.NO_COLOR;
  env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1';
  return env;
}

// A session's secrets: the project's profile first, then the project's own
// .env/.envrc on top. Resolved fresh at every launch, so editing a profile and
// restarting a card is enough to pick up a new token.
function sessionEnvVars(s) {
  const proj = project(s.projectId);
  const profileVars = proj && proj.envProfile ? loadProfileEnv(proj.envProfile) : {};
  return { ...profileVars, ...(s.loadEnv === false ? {} : loadProjectEnv(s.cwd)) };
}

// Claude Code stores a session's transcript under a slug of its working
// directory. --resume on an id with no transcript behind it just errors out, so
// check before offering to continue a conversation.
// The slug rule is Claude Code's, and it is not only the separators: a dot
// becomes a dash too, so `/Users/j/my.app` and `C:\repo\.worktrees\x` both slug
// differently than a naive path-separator swap would guess. Getting it wrong is
// silent — the card simply never offers to resume — so when the computed name
// misses, look for the transcript by id across the project folders rather than
// trusting the rule.
function transcriptExists(cwd, sessionId) {
  if (!sessionId) return false;
  const dir = path.join(CLAUDE_DIR, 'projects');
  const slug = cwd.replace(/[\\/:.]/g, '-');
  if (fs.existsSync(path.join(dir, slug, `${sessionId}.jsonl`))) return true;
  try {
    return fs.readdirSync(dir).some((d) => fs.existsSync(path.join(dir, d, `${sessionId}.jsonl`)));
  } catch { return false; }
}

// The command line for a session. Split out from spawnSession because a
// restored card relaunches with the same spec, optionally handing claude a
// transcript id so the conversation picks up instead of starting over.
function buildArgs(s, resumeId) {
  const run = WIN ? '& ' : '';
  const mcp = mcpArgs(s.engine);
  if (s.engine === 'claude') {
    // Claude Code asks "use the ANTHROPIC_API_KEY found in your environment?"
    // on every start when that var is set, and projects routinely have one in
    // .env — which quietly turns a subscription login into a metered API bill.
    // Hide it from the CLI, then hand it back to the shell so anything you run
    // in the same terminal still sees it. KILN_KEEP_API_KEYS=1 if you really do
    // authenticate with the key.
    const parts = [`${run}${quote(CLI.claude)}`, '--settings', quote(HOOKS_FILE), ...mcp];
    if (s.skipPermissions !== false) parts.push('--dangerously-skip-permissions');
    parts.push('--model', quote(s.model), '--effort', quote(s.effort));
    // --resume carries the whole prior conversation, so re-sending the
    // bootstrap prompt would just repeat orders the agent already has.
    if (resumeId) parts.push('--resume', quote(resumeId));
    else parts.push(quote(s.bootstrap));
    const cmd = parts.join(' ');
    return shellArgs(process.env.KILN_KEEP_API_KEYS === '1' ? cmd
      : withHidden(['ANTHROPIC_API_KEY'], cmd));
  }
  const parts = [`${run}${quote(CLI.codex)}`];
  if (s.skipPermissions !== false) parts.push('--dangerously-bypass-approvals-and-sandbox');
  parts.push('-m', quote(s.model));
  parts.push('-c', quote(`model_reasoning_effort=${DQ}${s.effort}${DQ}`));
  // Codex has no hooks, but it can run an external notify program on
  // agent-turn-complete — that gives us a real READY signal.
  const notifyJs = path.join(ROOT, 'hooks', 'codex-notify.js').replace(/\\/g, '/');
  parts.push('-c', quote(`notify=[${DQ}node${DQ},${DQ}${notifyJs}${DQ}]`));
  parts.push(...mcp);
  parts.push(quote(s.bootstrap));
  const cmd = parts.join(' ');
  return shellArgs(process.env.KILN_KEEP_API_KEYS === '1' ? cmd
    : withHidden(['OPENAI_API_KEY'], cmd));
}
function clampDim(v, fallback, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 1 ? Math.min(n, max) : fallback;
}

// Give a session record a live pty and wire it up. Used both for a brand new
// session and for bringing a persisted card back after a restart.
function launch(s, { resumeId = null, cols = 0, rows = 0 } = {}) {
  // A restarted session keeps the geometry it had, so the agent redraws its
  // banner at the width of the card it is about to appear in rather than at a
  // default the client then has to correct out from under it.
  s.cols = clampDim(cols || s.cols, 110, 500);
  s.rows = clampDim(rows || s.rows, 30, 200);
  const envVars = sessionEnvVars(s);
  const env = {
    ...cleanAgentEnv(process.env), ...envVars,
    KILN_SESSION: s.id,
    KILN_PORT: String(PORT),
    // xterm.js renders truecolor; advertise it so CLIs actually emit color
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    CLICOLOR: '1',
    CLICOLOR_FORCE: '1',
  };
  s.envCount = Object.keys(envVars).length;
  s.envProfile = project(s.projectId)?.envProfile || null;

  let args = buildArgs(s, resumeId);
  // Test hook: spawn a bare shell instead of a real agent so the e2e suite
  // can exercise dispatch/status/hooks without burning tokens.
  if (process.env.KILN_TEST_PLAIN === '1') args = WIN ? ['-NoLogo'] : ['-i'];

  let proc;
  try {
    proc = pty.spawn(SHELL_BIN, args, {
      name: 'xterm-256color',
      cols: s.cols, rows: s.rows,
      cwd: fs.existsSync(s.cwd) ? s.cwd : os.homedir(),
      env,
    });
  } catch (err) {
    return `spawn failed: ${err.message}`;
  }

  s.proc = proc;
  s.finished = false;
  s.exitCode = null;
  s.note = null;
  s.hookState = null;
  s.agentAlive = true;
  s.toolsRunning = new Set();
  s.status = 'running';
  s.wantStatus = null;
  s.lastActivity = Date.now();

  proc.onData((data) => {
    s.buffer.push(data);
    s.bufferLen += data.length;
    while (s.bufferLen > SCROLLBACK_LIMIT && s.buffer.length > 1) {
      s.bufferLen -= s.buffer[0].length;
      s.buffer.shift();
    }
    const now = Date.now();
    const isEcho = now - s.lastInput < ECHO_GRACE_MS && data.length <= ECHO_MAX_BYTES;
    if (!isEcho && screenChanged(s)) s.lastActivity = now;
    s.pending += data;
    if (!s.pendingSince) s.pendingSince = now;
    if (s.pending.length > 65_536 || now - s.pendingSince > DATA_FLUSH_MAX_MS) {
      flushData(s);
    } else {
      clearTimeout(s.flushTimer);
      s.flushTimer = setTimeout(() => flushData(s), DATA_FLUSH_MS);
    }
    saveSessionsSoon();
  });

  proc.onExit(({ exitCode }) => {
    flushData(s);
    s.proc = null;
    s.exitCode = exitCode;
    finishSession(s, 'exited');
    broadcast({ type: 'exit', id: s.id, code: exitCode });
    saveSessionsSoon();
  });

  return null;
}

function spawnSession(opts) {
  const id = String(nextSessionId++);
  const proj = project(opts.projectId);
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd
    : proj && fs.existsSync(proj.path) ? proj.path
    : os.homedir();
  const engine = pickEngine(opts.engine);
  const auth = pickAuth(engine, opts.auth);
  const codename = genCodename();
  const task = (opts.task || '').trim();

  const s = {
    id, codename, engine, auth, proc: null,
    title: opts.title || codename,
    projectId: proj ? proj.id : null,
    cmdLabel: auth ? `${engine} · ${auth}` : engine, cwd,
    taskSummary: task ? task.slice(0, 140) : null,
    model: pickModel(engine, auth, opts.model),
    effort: pickEffort(engine, auth, opts.effort),
    skipPermissions: opts.skipPermissions !== false,
    loadEnv: opts.loadEnv !== false,
    envProfile: proj?.envProfile || null,
    envCount: 0,
    bootstrap: '',             // filled in below, once the env is known
    agentSessionId: null,      // the CLI's own session id, for --resume
    buffer: [], bufferLen: 0,
    pending: '', flushTimer: null, pendingSince: 0,
    status: 'running', exitCode: null, note: null,
    hookState: null,           // 'needs-you' | 'ready' (set by hooks)
    toolsRunning: new Set(),   // non-Task tool_use_ids between Pre and PostToolUse
    browser: null,             // live browser-tool activity (see trackBrowser)
    agentAlive: true,
    lastActivity: Date.now(), lastInput: 0,
    hooksSeen: false,          // set once a lifecycle hook actually reaches us
    wantStatus: null, wantSince: 0,
    startedAt: Date.now(),
    x: opts.x ?? 120, y: opts.y ?? 120, w: opts.w ?? 860, h: opts.h ?? 540,
  };

  // The bootstrap names the credentials the agent has, so it has to be built
  // before the launch that hands it over. A login card has no agent to brief.
  s.bootstrap = buildBootstrap({
    codename, proj, task,
    envNames: Object.keys(sessionEnvVars(s)),
    envProfile: s.envProfile,
  });

  if (proj) pruneMemory(proj.path);
  const err = launch(s, { cols: opts.cols, rows: opts.rows });
  if (err) return { error: err };
  sessions.set(id, s);
  saveSessionsSoon();
  return { session: s };
}

// A conversation can only be continued where the CLI hands us its own session
// id and takes it back on --resume. Claude Code writes a transcript to disk and
// its hooks tell us the id; a codex card restarts fresh.
function resumableId(s) {
  if (s.engine !== 'claude') return null;
  return transcriptExists(s.cwd, s.agentSessionId) ? s.agentSessionId : null;
}
// Bring a card whose process is gone back to life in place: same id, same spot
// on the canvas, same scrollback above the new prompt.
function restoreSession(s) {
  if (s.proc) return null;
  // Grey rather than dim: the client strips SGR 2 out of the stream (agents use
  // it to fade whole transcripts), so a dim marker would arrive at full weight.
  const marker = `\r\n\x1b[90m-- restarted ${new Date().toLocaleTimeString()} --\x1b[0m\r\n`;
  s.buffer.push(marker);
  s.bufferLen += marker.length;
  broadcast({ type: 'data', id: s.id, data: marker });
  // Pick up any credential the profile gained since this card was first
  // dispatched, and say so in the prompt if we are starting over.
  s.bootstrap = buildBootstrap({
    codename: s.codename, proj: project(s.projectId), task: s.taskSummary,
    envNames: Object.keys(sessionEnvVars(s)),
    envProfile: project(s.projectId)?.envProfile || null,
  });
  const err = launch(s, { resumeId: resumableId(s), cols: s.cols, rows: s.rows });
  if (err) return err;
  s.startedAt = Date.now();
  broadcast({ type: 'restored', session: publicSession(s) });
  saveSessionsSoon();
  return null;
}

function flushData(s) {
  if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null; }
  s.pendingSince = 0;
  if (!s.pending) return;
  broadcast({ type: 'data', id: s.id, data: s.pending });
  s.pending = '';
}

// Killing a card's shell has to take everything it started with it. `npm run
// dev` servers used to outlive every card close and accumulate across
// dispatches until the machine was audibly hot — three copies of one Next dev
// server at ~119% of a core each, with no agent left to own them.
//
// On Windows that means taskkill /T to walk the child tree (/F because a dev
// server holding the console in raw mode ignores a polite close). On macOS and
// Linux the pty child is a session leader, so the negative pid signals the
// whole process group. Best-effort by design: a tree that already exited
// returns an error, and that is not a failure.
function killTree(proc) {
  if (!proc) return;
  const pid = proc.pid;
  if (pid && WIN) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 5000 });
      return;
    } catch { /* already gone, or taskkill refused — fall through to the pty */ }
  } else if (pid) {
    try { process.kill(-pid, 'SIGKILL'); return; } catch { /* no group, or gone */ }
  }
  try { proc.kill(); } catch { /* gone */ }
}
function finishSession(s, outcome) {
  if (s.finished) return;
  s.finished = true;
  setStatus(s, 'done');
  clearBrowser(s);
  for (const a of subagents.values()) {
    if (a.parentId === s.id && a.status === 'running') endSubagent(a);
  }
  appendHistory({
    codename: s.codename, title: s.title, engine: s.engine,
    project: project(s.projectId)?.name || null,
    task: s.taskSummary, outcome,
    exitCode: s.exitCode,
    startedAt: s.startedAt, endedAt: Date.now(),
  });
}

function setStatus(s, status) {
  if (s.status === status) return;
  s.status = status;
  broadcast({ type: 'status', id: s.id, status, exitCode: s.exitCode, note: s.note });
}

// A bare shell prompt as the last thing on screen means no agent has the
// foreground — the only exit signal codex gives us (it has no lifecycle hooks).
// Both platforms are matched: the fixed prompt kiln sets on the trailing shell,
// and PowerShell's default, for a card that dropped out before kiln set its own.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>]|[\r\x07]/g;
const PROMPT_RE = new RegExp(`^(?:${SHELL_MARK}|PS\\s.*>)\\s*$`);
function atShellPrompt(s) {
  const tail = s.buffer.length ? s.buffer[s.buffer.length - 1].slice(-400) : '';
  const lines = tail.replace(ANSI_RE, '').split('\n').map((l) => l.trim()).filter(Boolean);
  return PROMPT_RE.test(lines[lines.length - 1] || '');
}
function screenTail(s) {
  const raw = s.buffer.slice(-4).join('');
  return raw.slice(-1200).replace(ANSI_RE, '').replace(/\s+/g, ' ').trim();
}
function screenChanged(s) {
  const tail = screenTail(s);
  if (tail === s.lastTail) return false;
  s.lastTail = tail;
  return true;
}

// Lifecycle hooks are the only thing that actually knows what an agent is doing;
// screen bytes are a guess. So once a session has proved its hooks reach us,
// hook state outranks activity and we never invent a transition from silence —
// the chip holds until something real happens. Sessions without hooks (codex,
// a plain shell) keep the old activity heuristic.
function classify(s) {
  const now = Date.now();
  const quiet = now - s.lastActivity;

  if (!s.agentAlive && atShellPrompt(s)) return 'idle';
  if (s.hookState === 'needs-you') return 'needs-you';
  if (s.agentAlive && s.toolsRunning.size) return 'running'; // quiet tool (build, tests)
  const hasLiveSubagents = [...subagents.values()]
    .some((a) => a.parentId === s.id && a.status === 'running');
  if (hasLiveSubagents) return 'bg-agents';
  // Above the activity check on purpose: an idle TUI still repaints itself, and
  // treating those repaints as work is what bounced the chip READY -> RUNNING.
  if (s.agentAlive && s.hookState === 'ready') return 'ready';
  if (quiet < WORKING_WINDOW_MS) return 'running';
  if (atShellPrompt(s)) return 'idle';
  if (!s.agentAlive) return 'idle';
  if (s.hooksSeen) return s.status; // hooks will tell us; don't guess
  return quiet > NEEDS_YOU_SETTLE_MS ? 'needs-you' : s.status;
}

// One more layer of anti-flap: a change has to survive STATUS_COMMIT_MS of ticks
// before it goes out. Becoming busy is exempt, because that should feel instant.
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.status === 'done' || s.status === 'offline') continue;
    const want = classify(s);
    if (want === s.status) { s.wantStatus = null; continue; }
    if (want === 'running' || want === 'bg-agents') { s.wantStatus = null; setStatus(s, want); continue; }
    if (s.wantStatus !== want) { s.wantStatus = want; s.wantSince = now; continue; }
    if (now - s.wantSince >= STATUS_COMMIT_MS) { s.wantStatus = null; setStatus(s, want); }
  }
}, STATUS_TICK_MS).unref();

// ---------------------------------------------------------------------------
// Browser activity cards (agents driving Chrome/Playwright via MCP tools).
// Hook telemetry carries the tool inputs (URLs, clicks, typed text) and, on
// PostToolUse, any screenshot the tool returned — enough to mirror what the
// agent's browser is doing next to its terminal.
// ---------------------------------------------------------------------------
const BROWSER_TOOL_RE = /^mcp__.*(chrome|browser|playwright)/i;

function browserActionSummary(toolName, input = {}) {
  const short = (toolName.startsWith('mcp__')
    ? toolName.split('__').slice(2).join('__') || toolName
    : toolName).replace(/_/g, ' ');
  if (input.url) return { summary: `${short} · ${input.url}`, url: input.url };
  if (short === 'computer' && input.action) {
    let extra = '';
    if (Array.isArray(input.coordinate)) extra = ` @ ${input.coordinate.join(',')}`;
    if (typeof input.text === 'string' && input.text) extra = ` "${input.text.slice(0, 40)}"`;
    return { summary: `${input.action.replace(/_/g, ' ')}${extra}` };
  }
  return { summary: short };
}

function findImageIn(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  if (obj.type === 'image' && typeof obj.data === 'string' && obj.data.length > 50) {
    const mime = obj.mimeType || obj.media_type || 'image/png';
    return `data:${mime};base64,${obj.data}`;
  }
  if (obj.source && typeof obj.source.data === 'string' && obj.source.data.length > 50) {
    return `data:${obj.source.media_type || 'image/png'};base64,${obj.source.data}`;
  }
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) {
    const hit = findImageIn(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function trackBrowser(s, event) {
  if (!BROWSER_TOOL_RE.test(event.tool_name || '')) return;
  if (!s.browser) s.browser = { actions: [], lastUrl: null, shot: null, lastTs: 0, timer: null };
  const b = s.browser;
  b.lastTs = Date.now();
  clearTimeout(b.timer);
  b.timer = setTimeout(() => clearBrowser(s), BROWSER_LINGER_MS);
  b.timer.unref?.();
  if (event.hook_event_name === 'PreToolUse') {
    const a = { ...browserActionSummary(event.tool_name, event.tool_input), ts: b.lastTs };
    if (a.url) b.lastUrl = a.url;
    b.actions.unshift(a);
    b.actions.length = Math.min(b.actions.length, 6);
    broadcast({ type: 'browserAction', id: s.id, action: a, lastUrl: b.lastUrl, lastTs: b.lastTs });
  } else {
    const shot = findImageIn(event.tool_response);
    if (shot && shot.length < 4_000_000) {
      b.shot = shot;
      broadcast({ type: 'browserShot', id: s.id, shot, lastTs: b.lastTs });
    }
  }
}

function clearBrowser(s) {
  if (!s.browser) return;
  clearTimeout(s.browser.timer);
  s.browser = null;
  broadcast({ type: 'browserEnded', id: s.id });
}

// ---------------------------------------------------------------------------
// Subagents (created by Claude Code hooks, never manually)
// ---------------------------------------------------------------------------
let nextSubagentId = 1;
function startSubagent(parent, toolUseId, input) {
  const id = toolUseId || `sa${nextSubagentId++}`;
  if (subagents.has(id)) return;
  const a = {
    id, parentId: parent.id,
    title: (input?.description || input?.subagent_type || 'subagent').slice(0, 80),
    type: input?.subagent_type || 'task',
    status: 'running', startedAt: Date.now(), endedAt: null,
  };
  subagents.set(id, a);
  broadcast({ type: 'subagentStarted', subagent: publicSubagent(a) });
}
function endSubagent(a) {
  if (a.status !== 'running') return;
  a.status = 'done';
  a.endedAt = Date.now();
  broadcast({ type: 'subagentEnded', subagent: publicSubagent(a) });
  setTimeout(() => {
    subagents.delete(a.id);
    broadcast({ type: 'subagentRemoved', id: a.id });
  }, SUBAGENT_LINGER_MS).unref();
}
function oldestRunningSubagent(parentId) {
  let best = null;
  for (const a of subagents.values()) {
    if (a.parentId === parentId && a.status === 'running' && (!best || a.startedAt < best.startedAt)) best = a;
  }
  return best;
}

// ---------------------------------------------------------------------------
// HTTP + WS
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg, except) {
  const raw = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1 && client !== except) client.send(raw);
  }
}

// ---------------------------------------------------------------------------
// File watching
// ---------------------------------------------------------------------------
// The files panel mirrors a project folder, so a pull, an agent’s edit or a
// rename has to land there without anyone pressing refresh. One recursive
// watcher per project; the client re-reads only the folders it has open.
const WATCH_NOISE =
  /(^|[\\/])(node_modules|\.git|\.next|\.turbo|\.cache|\.venv|__pycache__|dist|build|out|coverage|\.DS_Store)([\\/]|$)/i;
const watchers = new Map(); // projectId -> { watcher, path, timer }

function stopWatcher(pid) {
  const w = watchers.get(pid);
  if (!w) return;
  watchers.delete(pid);
  if (w.timer) clearTimeout(w.timer);
  try { w.watcher.close(); } catch { /* already gone */ }
}

function startWatcher(p) {
  let watcher;
  try {
    // Not persistent: a watcher must never be the reason the process stays up.
    watcher = fs.watch(p.path, { recursive: true, persistent: false });
  } catch (err) {
    console.log(`watch ${p.name}: ${err.message}`);
    return;
  }
  const w = { watcher, path: p.path.toLowerCase(), timer: null };
  watchers.set(p.id, w);
  watcher.on('error', () => stopWatcher(p.id));
  // A pull touches hundreds of files. Coalesce into one nudge per 250ms window,
  // counted from the first event — extending instead would let a long-running
  // write keep pushing the refresh out of reach.
  watcher.on('change', (_evt, name) => {
    if (WATCH_NOISE.test(typeof name === 'string' ? name : '')) return;
    if (w.timer) return;
    w.timer = setTimeout(() => {
      w.timer = null;
      broadcast({ type: 'fsChanged', projectId: p.id });
    }, 250);
  });
}

function syncWatchers() {
  for (const [pid, w] of [...watchers]) {
    const p = project(pid);
    if (!p || p.path.toLowerCase() !== w.path) stopWatcher(pid);
  }
  for (const p of projects) if (!watchers.has(p.id)) startWatcher(p);
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'init',
    engines,
    catalog: CATALOG,
    projects,
    sessions: [...sessions.values()].map((s) => ({
      ...publicSession(s), scrollback: s.buffer.join(''),
    })),
    subagents: [...subagents.values()].map(publicSubagent),
    notes,
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const s = msg.id ? sessions.get(String(msg.id)) : null;

    switch (msg.type) {
      case 'spawn': {
        const res = spawnSession(msg);
        if (res.error) ws.send(JSON.stringify({ type: 'error', message: res.error }));
        else broadcast({ type: 'spawned', session: publicSession(res.session) });
        break;
      }
      case 'input':
        if (s && s.proc) {
          s.lastInput = Date.now();
          // The user got there first; do not paste a prompt on top of them.
          // Typing answers a prompt, so it clears "needs you" — but it must not
          // clear "ready", or reading a finished session with the arrow keys
          // would knock the chip back into guesswork.
          if (s.hookState === 'needs-you' || s.status === 'needs-you') {
            s.hookState = null;
            s.note = null;
            s.lastActivity = Date.now();
            setStatus(s, 'running');
          }
          s.proc.write(msg.data);
        }
        break;
      case 'resize':
        if (s) {
          if (msg.w) s.w = msg.w;
          if (msg.h) s.h = msg.h;
          if (msg.cols > 1 && msg.rows > 1) {
            const cols = clampDim(msg.cols, s.cols, 500);
            const rows = clampDim(msg.rows, s.rows, 200);
            // Every pty resize makes the agent redraw its whole screen, so a
            // no-op resize is not free — it is a full repaint for nothing, and
            // several in a row arrive interleaved. Only reflow on a real change.
            if (cols !== s.cols || rows !== s.rows) {
              s.cols = cols; s.rows = rows;
              if (s.proc) {
                try { s.proc.resize(cols, rows); } catch { /* racing exit */ }
              }
            }
          }
          saveSessionsSoon();
        }
        break;
      case 'move':
        if (s) {
          s.x = msg.x; s.y = msg.y;
          broadcast({ type: 'moved', id: s.id, x: s.x, y: s.y }, ws);
          saveSessionsSoon();
        }
        break;
      case 'rename':
        if (s && msg.title) {
          s.title = String(msg.title).slice(0, 60);
          broadcast({ type: 'renamed', id: s.id, title: s.title });
          saveSessionsSoon();
        }
        break;
      case 'kill':
        if (s && s.proc) killTree(s.proc);
        break;
      case 'restore': {
        if (!s) break;
        const err = restoreSession(s);
        if (err) ws.send(JSON.stringify({ type: 'error', message: err }));
        break;
      }
      case 'close':
        if (s) {
          if (s.proc) {
            killTree(s.proc);
            finishSession(s, 'closed');
          }
          sessions.delete(s.id);
          broadcast({ type: 'closed', id: s.id });
          saveSessions();
        }
        break;
      case 'addProject': {
        const dir = String(msg.path || '').trim();
        if (!dir || !path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
          ws.send(JSON.stringify({ type: 'error', message: `Not a directory: ${dir}` }));
          break;
        }
        if (projects.some((p) => p.path.toLowerCase() === dir.toLowerCase())) {
          ws.send(JSON.stringify({ type: 'error', message: `Already a project: ${dir}` }));
          break;
        }
        const p = {
          id: uniqueProjectId(),
          name: msg.name || path.basename(dir),
          path: dir,
          color: nextProjectColor(),
        };
        restoreProjectPrefs(p);
        projects.push(p);
        seedMemory(p);
        saveState();
        syncWatchers();
        broadcast({ type: 'projectAdded', project: p });
        break;
      }
      case 'updateProject': {
        const p = project(msg.projectId);
        if (!p) break;
        p.envProfile = profileSlug(msg.envProfile) || null;
        if (msg.defaults && typeof msg.defaults === 'object') {
          const eng = pickEngine(msg.defaults.engine);
          const auth = pickAuth(eng, msg.defaults.auth);
          p.defaults = {
            engine: eng,
            auth,
            model: pickModel(eng, auth, msg.defaults.model),
            effort: pickEffort(eng, auth, msg.defaults.effort),
          };
        } else {
          p.defaults = null;
        }
        rememberProjectPrefs(p);
        saveState();
        broadcast({ type: 'projectUpdated', project: p });
        break;
      }
      // Removing a project takes its workspace with it. Anything left behind
      // would point at a project that no longer exists, and the client hides
      // what it cannot place — an orphan is invisible, not free.
      case 'removeProject': {
        const pid = msg.projectId;
        if (!project(pid)) break;
        rememberProjectPrefs(project(pid));
        for (const s of [...sessions.values()]) {
          if (s.projectId !== pid) continue;
          if (s.proc) {
            killTree(s.proc);
            finishSession(s, 'closed');
          }
          sessions.delete(s.id);
          broadcast({ type: 'closed', id: s.id });
        }
        for (const n of notes.filter((n) => n.projectId === pid)) {
          broadcast({ type: 'noteRemoved', noteId: n.id });
        }
        notes = notes.filter((n) => n.projectId !== pid);
        saveNotes();
        projects = projects.filter((p) => p.id !== pid);
        saveState();
        saveSessions();
        syncWatchers();
        broadcast({ type: 'projectRemoved', projectId: pid });
        break;
      }
      case 'addNote': {
        const n = {
          id: 'n' + Date.now().toString(36) + Math.floor(Math.random() * 1e3),
          title: String(msg.title || 'note').slice(0, 60),
          projectId: project(msg.projectId) ? msg.projectId : null,
          // `html` is what the rich editor writes; `content` is the legacy
          // markdown source, kept so old notes still render until first edit.
          html: '', content: '',
          x: msg.x ?? 200, y: msg.y ?? 200, w: msg.w ?? 440, h: msg.h ?? 340,
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        notes.push(n);
        saveNotes();
        broadcast({ type: 'noteAdded', note: n });
        break;
      }
      case 'updateNote': {
        const n = note(msg.noteId);
        if (!n) break;
        if (typeof msg.content === 'string') n.content = msg.content.slice(0, 200_000);
        if (typeof msg.html === 'string') n.html = msg.html.slice(0, 400_000);
        if (typeof msg.title === 'string' && msg.title.trim()) n.title = msg.title.trim().slice(0, 60);
        n.updatedAt = Date.now();
        saveNotes();
        broadcast({ type: 'noteUpdated', note: n }, ws);
        break;
      }
      case 'moveNote': {
        const n = note(msg.noteId);
        if (!n) break;
        if (Number.isFinite(msg.x)) { n.x = msg.x; n.y = msg.y; }
        if (Number.isFinite(msg.w)) { n.w = msg.w; n.h = msg.h; }
        saveNotes();
        broadcast({ type: 'noteMoved', note: n }, ws);
        break;
      }
      case 'removeNote':
        if (!note(msg.noteId)) break;
        notes = notes.filter((n) => n.id !== msg.noteId);
        saveNotes();
        broadcast({ type: 'noteRemoved', noteId: msg.noteId });
        break;
    }
  });
});

// ---------------------------------------------------------------------------
// Hook relay endpoint (Claude Code lifecycle, out-of-band)
// ---------------------------------------------------------------------------
// 8mb so PostToolUse hooks can carry browser screenshots through the relay
app.use(express.json({ limit: '8mb' }));

app.post('/api/hook', (req, res) => {
  res.json({ ok: true });
  const { sessionId, event } = req.body || {};
  const s = sessions.get(String(sessionId || ''));
  if (!s || !event) return;
  s.hooksSeen = true; // this session has real lifecycle signal; classify() trusts it
  // The CLI's own session id is the handle --resume needs later.
  if (event.session_id && s.agentSessionId !== event.session_id) {
    s.agentSessionId = event.session_id;
    saveSessionsSoon();
  }
  switch (event.hook_event_name) {
    case 'SessionStart':
      s.agentAlive = true;
      s.hookState = null;
      break;
    case 'SessionEnd':
      s.agentAlive = false;
      s.hookState = null;
      s.toolsRunning.clear();
      clearBrowser(s);
      for (const a of subagents.values()) {
        if (a.parentId === s.id) endSubagent(a);
      }
      break;
    case 'UserPromptSubmit':
      s.hookState = null;
      s.note = null;
      s.toolsRunning.clear();
      s.lastActivity = Date.now();
      break;
    case 'PreToolUse':
      // A tool is running, so whatever we were waiting for is answered.
      s.hookState = null;
      s.note = null;
      s.lastActivity = Date.now();
      if (event.tool_name === 'Task') startSubagent(s, event.tool_use_id, event.tool_input);
      else if (event.tool_use_id) s.toolsRunning.add(event.tool_use_id);
      trackBrowser(s, event);
      break;
    case 'PostToolUse':
      if (event.tool_name === 'Task') {
        const a = (event.tool_use_id && subagents.get(event.tool_use_id)) || oldestRunningSubagent(s.id);
        if (a) endSubagent(a);
      } else if (event.tool_use_id) {
        s.toolsRunning.delete(event.tool_use_id);
      }
      trackBrowser(s, event);
      break;
    case 'SubagentStop': {
      const a = oldestRunningSubagent(s.id);
      if (a) endSubagent(a);
      break;
    }
    case 'Notification':
      s.hookState = 'needs-you';
      s.note = (event.message || 'needs your attention').slice(0, 160);
      setStatus(s, classify(s));
      break;
    case 'Stop':
      s.hookState = 'ready';
      s.note = null;
      s.toolsRunning.clear();
      break;
    // Codex notify program (hooks/codex-notify.js) relays turn completion.
    case 'CodexNotify':
      if (event.notification_type === 'agent-turn-complete') {
        s.agentAlive = true;
        s.hookState = 'ready';
        s.note = null;
      }
      break;
  }
});

// ---------------------------------------------------------------------------
// Connections (MCP servers)
// ---------------------------------------------------------------------------
// One list of MCP servers, kept here, handed to every card at dispatch — so a
// connection added once is a connection every agent has. It is kiln's own file
// rather than an edit to ~/.claude.json or ~/.codex/config.toml: those are the
// user's, and a canvas that silently rewrites them is a canvas you cannot trust.
//
// Claude Code takes the file directly (--mcp-config, merged with whatever the
// user already has). Codex has no such flag, so each server is passed as -c
// overrides, which is the same thing its config.toml would have said.
const MCP_FILE = path.join(DATA, 'mcp.json');

function readMcp() {
  try {
    const j = JSON.parse(fs.readFileSync(MCP_FILE, 'utf8'));
    return j && typeof j.mcpServers === 'object' && j.mcpServers ? j.mcpServers : {};
  } catch { return {}; }
}
function writeMcp(servers) {
  fs.writeFileSync(MCP_FILE, JSON.stringify({ mcpServers: servers }, null, 2));
}

// Codex quoting: a -c value's inner quotes must reach the exe intact, and
// PowerShell eats bare double quotes on the way to a native command.
const DQ = WIN ? '\\"' : '"';
function tomlValue(v) {
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(',')}]`;
  if (typeof v === 'object' && v) {
    return `{${Object.entries(v).map(([k, x]) => `${k}=${tomlValue(x)}`).join(',')}}`;
  }
  return `${DQ}${String(v).replace(/"/g, '')}${DQ}`;
}

// The dispatch-side of the same list.
function mcpArgs(engine) {
  const servers = readMcp();
  const names = Object.keys(servers);
  if (!names.length) return [];
  if (engine === 'claude') return ['--mcp-config', quote(MCP_FILE)];
  const out = [];
  for (const name of names) {
    const s = servers[name];
    if (!s || !s.command) continue;
    out.push('-c', quote(`mcp_servers.${name}.command=${tomlValue(s.command)}`));
    if (Array.isArray(s.args) && s.args.length) out.push('-c', quote(`mcp_servers.${name}.args=${tomlValue(s.args)}`));
    if (s.env && Object.keys(s.env).length) out.push('-c', quote(`mcp_servers.${name}.env=${tomlValue(s.env)}`));
  }
  return out;
}

// Values can be secrets, so they go out masked, the same way profiles do.
app.get('/api/connections', (req, res) => {
  const servers = readMcp();
  res.json({
    connections: Object.entries(servers).map(([name, s]) => ({
      name,
      command: s.command || '',
      args: Array.isArray(s.args) ? s.args : [],
      env: Object.keys(s.env || {}).map((k) => ({ var: k, masked: maskValue(String(s.env[k])) })),
    })).sort((a, b) => a.name.localeCompare(b.name)),
  });
});

app.put('/api/connections/:name', (req, res) => {
  const name = String(req.params.name || '').replace(/[^a-z0-9-_]/gi, '').slice(0, 40);
  if (!name) return res.status(400).json({ error: 'bad connection name' });
  const command = String(req.body.command || '').trim();
  if (!command) return res.status(400).json({ error: 'a command is required' });
  const args = Array.isArray(req.body.args) ? req.body.args.map(String).slice(0, 30) : [];
  const env = {};
  for (const [k, v] of Object.entries(req.body.env || {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = String(v);
  }
  try {
    const servers = readMcp();
    servers[name] = { command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) };
    writeMcp(servers);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/connections/:name', (req, res) => {
  try {
    const servers = readMcp();
    delete servers[String(req.params.name)];
    writeMcp(servers);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ---------------------------------------------------------------------------
// Preset prompts
// ---------------------------------------------------------------------------
const PROMPTS_DIR = path.join(DATA, 'prompts');

function parsePrompt(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  let body = raw;
  if (m) {
    body = m[2].trim();
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
  }
  const params = [...new Set([...body.matchAll(/\{([A-Z][A-Z0-9_]*)\}/g)].map((x) => x[1]))];
  return {
    slug: path.basename(file, '.md'),
    name: meta.name || path.basename(file, '.md'),
    description: meta.description || '',
    params,
    body,
  };
}

app.get('/api/prompts', (req, res) => {
  try {
    const list = fs.readdirSync(PROMPTS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => parsePrompt(path.join(PROMPTS_DIR, f)))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ prompts: list });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/prompts/:slug', (req, res) => {
  const slug = String(req.params.slug).replace(/[^a-z0-9-]/gi, '');
  if (!slug) return res.status(400).json({ error: 'bad slug' });
  try {
    fs.writeFileSync(path.join(PROMPTS_DIR, `${slug}.md`), String(req.body.content || ''));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/prompts/:slug', (req, res) => {
  const slug = String(req.params.slug).replace(/[^a-z0-9-]/gi, '');
  try {
    fs.unlinkSync(path.join(PROMPTS_DIR, `${slug}.md`));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Project memory (<project>/.kiln/index.md + runs/)
// ---------------------------------------------------------------------------
// The index is what every dispatched agent reads before it starts, which makes
// its size a per-dispatch tax and its accuracy the whole point. Left alone it
// grows: each run appends, nothing is ever removed, and within a month it is a
// changelog nobody trusts. So the budget is enforced rather than requested —
// the index is capped, run notes are capped and counted, and a dispatch prunes
// what is over. Tightening is the normal state, not a cleanup task.
function memDir(p) { return path.join(p.path, MEM_DIR); }

// A new project gets the four headings and nothing else. Empty files invite an
// agent to invent a structure, and every agent invents a different one; four
// fixed sections are what makes "edit the fact this belongs to" a real
// instruction rather than a hope.
const MEMORY_TEMPLATE = `# <project> memory

Kept under ${Math.round(MEMORY_INDEX_MAX / 1000)}KB on purpose. Every agent reads this before it works, so
adding something means editing or replacing something — not appending.

## Decisions
<!-- what was chosen and why, so it is not re-litigated -->

## Components
<!-- the parts and what each one owns -->

## Conventions
<!-- how work is done here: style, workflow, what to never do -->

## Gotchas
<!-- things that will bite: the surprise, and what to do instead -->
`;

function seedMemory(p) {
  const file = path.join(memDir(p), 'index.md');
  if (fs.existsSync(file)) return;
  try {
    fs.mkdirSync(path.join(memDir(p), 'runs'), { recursive: true });
    fs.writeFileSync(file, MEMORY_TEMPLATE.replace('<project>', p.name));
  } catch { /* read-only checkout: memory just stays empty */ }
}

// Oldest run notes first, so what survives is what happened most recently.
function pruneMemory(projectPath) {
  const runs = path.join(projectPath, MEM_DIR, 'runs');
  let files;
  try { files = fs.readdirSync(runs).filter((x) => x.endsWith('.md')); } catch { return; }
  // A note the index points at is not old news, whatever its date: pruning it
  // would leave the index citing a file that no longer exists.
  let cited = '';
  try { cited = fs.readFileSync(path.join(projectPath, MEM_DIR, 'index.md'), 'utf8'); } catch { /* none */ }
  const stamped = files.map((name) => {
    const full = path.join(runs, name);
    let stat; try { stat = fs.statSync(full); } catch { return null; }
    // A run note over the cap is truncated rather than deleted: the top of a
    // note is the summary, the tail is usually transcript.
    if (stat.size > MEMORY_RUN_MAX) {
      try {
        const head = fs.readFileSync(full, 'utf8').slice(0, MEMORY_RUN_MAX);
        fs.writeFileSync(full, head.replace(/\n[^\n]*$/, '') + '\n\n_(truncated at the run-note cap)_\n');
      } catch { /* leave it */ }
    }
    return { full, mtime: stat.mtimeMs };
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  for (const old of stamped.slice(MEMORY_RUNS_KEEP)) {
    if (cited.includes(path.basename(old.full))) continue;
    try { fs.unlinkSync(old.full); } catch { /* already gone */ }
  }
}

app.get('/api/memory/:projectId', (req, res) => {
  const p = project(req.params.projectId);
  if (!p) return res.status(404).json({ error: 'unknown project' });
  const dir = memDir(p);
  let index = '';
  let runs = [];
  try { index = fs.readFileSync(path.join(dir, 'index.md'), 'utf8'); } catch { /* none yet */ }
  try {
    runs = fs.readdirSync(path.join(dir, 'runs'))
      .filter((x) => x.endsWith('.md'))
      .map((x) => ({ name: x, mtime: fs.statSync(path.join(dir, 'runs', x)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { /* none yet */ }
  // used/cap drives the budget bar in the drawer: the point is that the number
  // is visible while you edit, not discovered when something is trimmed.
  res.json({
    index, runs,
    used: Buffer.byteLength(index),
    cap: MEMORY_INDEX_MAX,
    runsKeep: MEMORY_RUNS_KEEP,
  });
});

app.put('/api/memory/:projectId', (req, res) => {
  const p = project(req.params.projectId);
  if (!p) return res.status(404).json({ error: 'unknown project' });
  const index = String(req.body.index || '');
  if (Buffer.byteLength(index) > MEMORY_INDEX_MAX) {
    return res.status(400).json({
      error: `over the ${Math.round(MEMORY_INDEX_MAX / 1000)}KB index budget — replace or merge a fact instead of adding one`,
      used: Buffer.byteLength(index), cap: MEMORY_INDEX_MAX,
    });
  }
  try {
    fs.mkdirSync(memDir(p), { recursive: true });
    fs.writeFileSync(path.join(memDir(p), 'index.md'), index);
    res.json({ ok: true, used: Buffer.byteLength(index), cap: MEMORY_INDEX_MAX });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/memory/:projectId/run', (req, res) => {
  const p = project(req.params.projectId);
  const name = path.basename(String(req.query.name || ''));
  if (!p || !name.endsWith('.md')) return res.status(400).json({ error: 'bad request' });
  try {
    res.json({ content: fs.readFileSync(path.join(memDir(p), 'runs', name), 'utf8') });
  } catch (err) { res.status(404).json({ error: err.message }); }
});
// ---------------------------------------------------------------------------
// Skills inventory + install
// ---------------------------------------------------------------------------
app.get('/api/skills', (req, res) => {
  const out = [];
  try {
    const skillsDir = path.join(CLAUDE_DIR, 'skills');
    for (const name of fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : []) {
      const f = path.join(skillsDir, name, 'SKILL.md');
      if (!fs.existsSync(f)) continue;
      const head = fs.readFileSync(f, 'utf8').slice(0, 2000);
      const desc = head.match(/^description:\s*["']?(.+?)["']?\s*$/mi);
      out.push({ name, kind: 'skill', description: desc ? desc[1].slice(0, 200) : '' });
    }
    const plugDir = path.join(CLAUDE_DIR, 'plugins', 'installed');
    for (const name of fs.existsSync(plugDir) ? fs.readdirSync(plugDir) : []) {
      const f = path.join(plugDir, name, 'plugin.json');
      if (!fs.existsSync(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        out.push({ name, kind: 'plugin', description: (j.description || '').slice(0, 200) });
      } catch { /* skip broken */ }
    }
  } catch (err) { return res.status(500).json({ error: err.message }); }
  out.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ skills: out });
});

app.post('/api/skills/install', (req, res) => {
  const source = String(req.body.source || '').trim();
  if (!source || !engines.claude) return res.status(400).json({ error: 'need a source and the claude CLI' });
  const task =
    `Install the agent skill from ${source} into ${path.join(CLAUDE_DIR, 'skills')}. ` +
    'Clone or download the source, find its SKILL.md (or skills/*/SKILL.md), and copy each skill folder ' +
    'into its own directory there. Verify SKILL.md frontmatter parses. Report what was installed. ' +
    'Do not install anything beyond skill folders.';
  // Installs are mechanical work — pin them to sonnet at medium reasoning.
  const r = spawnSession({
    engine: 'claude', model: 'sonnet', effort: 'medium', task, title: 'skill install',
    x: 160 + Math.random() * 120, y: 160 + Math.random() * 120, w: 860, h: 540,
  });
  if (r.error) return res.status(500).json({ error: r.error });
  broadcast({ type: 'spawned', session: publicSession(r.session) });
  res.json({ ok: true, sessionId: r.session.id });
});

// ---------------------------------------------------------------------------
// Usage accounting (Claude transcripts; request+message dedupe; I/O headline)
// ---------------------------------------------------------------------------
const RATES = { // USD per MTok [input, output] — list-price estimates
  opus: [15, 75], sonnet: [3, 15], haiku: [0.8, 4], fable: [15, 75],
  'gpt-5': [1.25, 10], default: [3, 15],
};
function rateFor(model) {
  const m = String(model || '').toLowerCase();
  for (const k of Object.keys(RATES)) if (k !== 'default' && m.includes(k)) return RATES[k];
  return RATES.default;
}
const usageCache = new Map(); // file -> {mtime, size, records}

function collectUsage(days) {
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  if (!fs.existsSync(projectsDir)) return [];
  const cutoff = Date.now() - days * 86_400_000;
  const records = [];
  const seen = new Set();
  for (const dir of fs.readdirSync(projectsDir)) {
    const full = path.join(projectsDir, dir);
    let files;
    try { files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(full, f);
      let stat;
      try { stat = fs.statSync(fp); } catch { continue; }
      if (stat.mtimeMs < cutoff) continue;
      let entry = usageCache.get(fp);
      if (!entry || entry.mtime !== stat.mtimeMs || entry.size !== stat.size) {
        const recs = [];
        try {
          for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
            if (!line.includes('"usage"')) continue;
            let j;
            try { j = JSON.parse(line); } catch { continue; }
            const u = j.message?.usage;
            if (j.type !== 'assistant' || !u) continue;
            recs.push({
              key: `${j.requestId || ''}:${j.message.id || ''}`,
              ts: Date.parse(j.timestamp) || 0,
              model: j.message.model || '',
              provider: 'claude',
              project: j.cwd ? path.basename(j.cwd) : dir.replace(/^C--/, '').split('-').pop(),
              input: u.input_tokens || 0,
              output: u.output_tokens || 0,
              cacheRead: u.cache_read_input_tokens || 0,
              cacheWrite: u.cache_creation_input_tokens || 0,
            });
          }
        } catch { continue; }
        entry = { mtime: stat.mtimeMs, size: stat.size, records: recs };
        usageCache.set(fp, entry);
      }
      for (const r of entry.records) {
        if (r.ts < cutoff || seen.has(r.key)) continue;
        seen.add(r.key);
        records.push(r);
      }
    }
  }
  return records;
}

// Codex rollout logs (~/.codex/sessions/**/*.jsonl): token_count events carry
// per-message usage; turn_context lines carry model + cwd. Best-effort parse.
const codexCache = new Map(); // file -> {mtime, size, records}

function collectCodexUsage(days) {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(root)) return [];
  const cutoff = Date.now() - days * 86_400_000;
  const files = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.jsonl')) files.push(full);
    }
  })(root);
  const records = [];
  for (const fp of files) {
    let stat;
    try { stat = fs.statSync(fp); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;
    let entry = codexCache.get(fp);
    if (!entry || entry.mtime !== stat.mtimeMs || entry.size !== stat.size) {
      const recs = [];
      let model = 'gpt-5';
      let projectName = 'codex';
      try {
        let n = 0;
        for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
          n++;
          if (!line) continue;
          if (line.includes('"model"') || line.includes('"cwd"')) {
            try {
              const j = JSON.parse(line);
              const p = j.payload || j;
              if (typeof p.model === 'string' && p.model) model = p.model;
              if (typeof p.cwd === 'string' && p.cwd) projectName = path.basename(p.cwd);
            } catch { /* not a context line */ }
          }
          if (!line.includes('token_count')) continue;
          let j;
          try { j = JSON.parse(line); } catch { continue; }
          const u = j.payload?.info?.last_token_usage;
          if (!u) continue;
          const cached = u.cached_input_tokens || 0;
          recs.push({
            key: `${fp}#${n}`,
            ts: Date.parse(j.timestamp) || stat.mtimeMs,
            model, provider: 'codex', project: projectName,
            input: Math.max(0, (u.input_tokens || 0) - cached),
            output: u.output_tokens || 0,
            cacheRead: cached, cacheWrite: 0,
          });
        }
      } catch { continue; }
      entry = { mtime: stat.mtimeMs, size: stat.size, records: recs };
      codexCache.set(fp, entry);
    }
    for (const r of entry.records) if (r.ts >= cutoff) records.push(r);
  }
  return records;
}

app.get('/api/usage', (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  try {
    const recs = [...collectUsage(days), ...collectCodexUsage(days)];
    const sum = { io: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: recs.length };
    const byProject = {};
    const byModel = {};
    const byDay = {};
    const byProvider = { claude: 0, codex: 0 };
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const today = { io: 0, cost: 0, turns: 0 };
    for (const r of recs) {
      const [inRate, outRate] = rateFor(r.model);
      const cost = (r.input * inRate + r.output * outRate +
        r.cacheWrite * inRate * 1.25 + r.cacheRead * inRate * 0.1) / 1e6;
      const io = r.input + r.output;
      sum.io += io; sum.cacheRead += r.cacheRead; sum.cacheWrite += r.cacheWrite; sum.cost += cost;
      byProject[r.project] = (byProject[r.project] || 0) + io;
      const shortModel = r.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
      byModel[shortModel] = (byModel[shortModel] || 0) + io;
      const day = new Date(r.ts).toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = { claude: 0, codex: 0 };
      byDay[day][r.provider] += io;
      byProvider[r.provider] += io;
      if (r.ts >= todayStart) { today.io += io; today.cost += cost; today.turns++; }
    }
    const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([name, io]) => ({ name, io }));
    res.json({
      days, ...sum, today, byProvider,
      topProjects: top(byProject, 6),
      topModels: top(byModel, 5),
      byDay: Object.entries(byDay).sort()
        .map(([date, v]) => ({ date, claude: v.claude, codex: v.codex })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Env profiles + secrets (named KEY=VALUE sets; local-only, loaded into PTY
// env at dispatch). The API only ever returns masked values — a pasted secret
// goes to disk and into terminals, never back to a browser.
// ---------------------------------------------------------------------------
// Secret types map to the env var(s) the common tools actually read.
const SECRET_TYPES = {
  github: ['GITHUB_TOKEN', 'GH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  vercel: ['VERCEL_TOKEN'],
  supabase: ['SUPABASE_ACCESS_TOKEN'],
  elevenlabs: ['ELEVENLABS_API_KEY'],
  npm: ['NPM_TOKEN'],
  huggingface: ['HF_TOKEN'],
};
function maskValue(v) {
  return v.length > 8 ? `····${v.slice(-4)}` : '····';
}
function profileVarsMasked(slug) {
  try {
    const vars = parseEnvText(fs.readFileSync(path.join(PROFILES_DIR, `${slug}.env`), 'utf8'));
    return Object.entries(vars).map(([k, v]) => ({ var: k, masked: maskValue(v) }));
  } catch { return []; }
}

app.get('/api/profiles', (req, res) => {
  try {
    const profiles = fs.readdirSync(PROFILES_DIR)
      .filter((f) => f.endsWith('.env'))
      .map((f) => {
        const name = path.basename(f, '.env');
        const vars = profileVarsMasked(name);
        return { name, count: vars.length, vars };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ profiles, types: Object.keys(SECRET_TYPES) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/profiles/:name', (req, res) => {
  const slug = profileSlug(req.params.name);
  if (!slug) return res.status(400).json({ error: 'bad profile name' });
  try {
    fs.writeFileSync(path.join(PROFILES_DIR, `${slug}.env`), String(req.body.content || ''));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add or replace one secret: {type, var?, value}. A known type picks the env
// var name(s); type "custom" uses the caller's var name.
app.post('/api/profiles/:name/secrets', (req, res) => {
  const slug = profileSlug(req.params.name);
  if (!slug) return res.status(400).json({ error: 'bad profile name' });
  const value = String(req.body.value || '');
  if (!value.trim()) return res.status(400).json({ error: 'paste a value first' });
  if (/[$`\r\n]/.test(value)) {
    return res.status(400).json({ error: 'values with $, backticks, or line breaks are not supported' });
  }
  const type = String(req.body.type || 'custom');
  let vars = SECRET_TYPES[type];
  if (!vars) {
    const v = String(req.body.var || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) {
      return res.status(400).json({ error: 'var name must look like MY_TOKEN' });
    }
    vars = [v];
  }
  try {
    const file = path.join(PROFILES_DIR, `${slug}.env`);
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
        .filter((l) => l.trim() && !vars.some((v) => l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1] === v));
    } catch { /* new profile */ }
    for (const v of vars) lines.push(`${v}=${value}`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    res.json({ ok: true, vars });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/profiles/:name/secrets/:var', (req, res) => {
  const slug = profileSlug(req.params.name);
  const key = String(req.params.var || '');
  if (!slug || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return res.status(400).json({ error: 'bad request' });
  try {
    const file = path.join(PROFILES_DIR, `${slug}.env`);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .filter((l) => l.trim() && l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1] !== key);
    fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/profiles/:name', (req, res) => {
  const slug = profileSlug(req.params.name);
  try {
    fs.unlinkSync(path.join(PROFILES_DIR, `${slug}.env`));
    for (const p of projects) if (p.envProfile === slug) p.envProfile = null;
    // A remembered profile that no longer exists would come back on a re-add
    // as a name that resolves to nothing.
    for (const pref of Object.values(projectPrefs)) {
      if (pref.envProfile === slug) pref.envProfile = null;
    }
    saveState();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Project discovery (folders under PROJECTS_ROOT not yet registered)
// ---------------------------------------------------------------------------
app.get('/api/projects/available', (req, res) => {
  const registered = new Set(projects.map((p) => p.path.toLowerCase()));
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: path.join(PROJECTS_ROOT, e.name) }))
      .filter((d) => !registered.has(d.path.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { /* root missing or unreadable */ }
  res.json({ root: PROJECTS_ROOT, dirs });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
app.get('/api/history', (req, res) => res.json({ history: readHistory() }));

// ---------------------------------------------------------------------------
// File API
// ---------------------------------------------------------------------------
app.get('/api/fs/list', (req, res) => {
  const dir = String(req.query.path || '');
  if (!path.isAbsolute(dir)) return res.status(400).json({ error: 'absolute path required' });
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isFile())
      .slice(0, 500)
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    res.json({ entries });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/fs/read', (req, res) => {
  const file = String(req.query.path || '');
  if (!path.isAbsolute(file)) return res.status(400).json({ error: 'absolute path required' });
  try {
    const stat = fs.statSync(file);
    if (stat.size > 262_144) return res.status(400).json({ error: 'file too large to preview (256 KB max)' });
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return res.status(400).json({ error: 'binary file' });
    res.json({ content: buf.toString('utf8'), size: stat.size });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Hand a url or a path to the desktop: the browser an agent is driving, or the
// file manager at a file you clicked. Each platform has its own opener, and the
// argument is validated before it gets anywhere near a shell.
function openExternal(target, reveal = false) {
  if (WIN) {
    exec(reveal ? `explorer.exe /select,"${target}"` : `cmd /c start "" "${target}"`);
  } else if (process.platform === 'darwin') {
    exec(`open ${reveal ? '-R ' : ''}${JSON.stringify(target)}`);
  } else {
    // Linux has no reveal-in-folder verb, so show the containing directory.
    exec(`xdg-open ${JSON.stringify(reveal ? path.dirname(target) : target)}`);
  }
}

app.post('/api/open-url', (req, res) => {
  const url = String(req.body.url || '');
  if (!/^https?:\/\/[^\s"']+$/.test(url)) return res.status(400).json({ error: 'not an http(s) url' });
  openExternal(url);
  res.json({ ok: true });
});

app.post('/api/fs/open', (req, res) => {
  const target = String(req.body.path || '');
  if (!path.isAbsolute(target) || !fs.existsSync(target)) {
    return res.status(400).json({ error: 'path not found' });
  }
  openExternal(target, true);
  res.json({ ok: true });
});
// ---------------------------------------------------------------------------
// Static
// ---------------------------------------------------------------------------
app.use('/vendor/xterm', express.static(path.join(ROOT, 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/addon-fit', express.static(path.join(ROOT, 'node_modules', '@xterm', 'addon-fit')));
app.use('/vendor/addon-webgl', express.static(path.join(ROOT, 'node_modules', '@xterm', 'addon-webgl')));
app.use(express.static(path.join(ROOT, 'public')));

loadSessions();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`kiln running at http://127.0.0.1:${PORT}`);
  console.log('engines: ' + Object.entries(engines).map(([k, v]) => `${k}=${v}`).join(' '));
  const offline = [...sessions.values()].filter((s) => s.status === 'offline').length;
  if (offline) console.log(`restored ${offline} card${offline === 1 ? '' : 's'} from the last run`);
  syncWatchers();
});

// Also hold ::1 on the same port so `localhost` (which some systems resolve to
// IPv6 first) always reaches kiln and nothing else can squat there. Best
// effort: machines with IPv6 disabled just skip it.
const server6 = http.createServer(app);
server6.on('upgrade', (req, socket, head) => {
  if (req.url.split('?')[0] !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
server6.on('error', (err) => console.log(`IPv6 loopback bind skipped: ${err.code}`));
server6.listen(PORT, '::1');

// Last write wins: get the cards on disk before the ptys go away, so a restart
// or a reboot brings the canvas back exactly as it was.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const s of sessions.values()) flushData(s);
  saveSessions();
  for (const s of sessions.values()) killTree(s.proc);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.on('exit', () => { if (!shuttingDown) saveSessions(); });
