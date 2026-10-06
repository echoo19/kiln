#!/usr/bin/env node
/*
 * kiln launcher.
 *
 * `kiln` starts the server if nothing is on the port yet, then opens the canvas
 * in a browser window. Running it twice is safe and is the intended way to get
 * the window back: it never starts a second server, and it waits for the one
 * that is running to actually answer before opening anything, so you do not get
 * an empty window racing a server that is still booting.
 */
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.KILN_PORT ? Number(process.env.KILN_PORT) : 5456;
const URL = `http://127.0.0.1:${PORT}`;
const args = process.argv.slice(2);

function help() {
  console.log(`kiln — terminals and agents as live nodes on a canvas

  kiln              start the server if it is down, then open the canvas
  kiln server       run the server in this terminal (logs to stdout, ctrl-c stops)
  kiln open         open the canvas, without starting anything
  kiln --version    print the version

  from inside a card:
  kiln who [--all]            other agents live on this project (or everywhere)
  kiln msg <codename> "..."   send one of them a message (or pipe it in)

  KILN_PORT             port to listen on (default ${PORT})
  KILN_PROJECTS_ROOT    folder the project picker lists (default ~/projects)
  KILN_DATA             where state lives (default ~/.kiln)
`);
}

// Answering on the port is the only fact worth acting on: a pid file lies after
// a crash, and a lock file lies after a reboot.
function alive() {
  return new Promise((resolve) => {
    const req = http.get(URL + '/api/history', { timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const argv = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  spawn(cmd, argv, { detached: true, stdio: 'ignore' }).unref();
}

async function waitFor(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await alive()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ---------------------------------------------------------------------------
// From inside a card: who else is here, and a message to one of them. A card
// proves it is one with KILN_SESSION, which only a pty kiln spawned carries.
// ---------------------------------------------------------------------------
function api(method, route, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: route, method, timeout: 20_000,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({ ok: false, error: `HTTP ${res.statusCode}` }); } });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.code || err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (data) req.write(data);
    req.end();
  });
}
function die(msg) { console.error(`kiln: ${msg}`); process.exit(1); }
const WHY = {
  unknown_session: 'this shell is not a kiln card',
  no_such_agent: 'no live agent by that name (try: kiln who --all)',
  self: 'that is you',
  empty: 'nothing to send',
  too_long: 'message is over 8000 characters',
  ECONNREFUSED: 'the kiln server is not running',
};
function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
  });
}

async function who(argv) {
  const all = argv.includes('--all');
  const res = await api('GET', `/api/peers?sessionId=${encodeURIComponent(SESSION)}${all ? '&all=1' : ''}`);
  if (!res.ok) die(WHY[res.error] || res.error || 'failed');
  if (!res.peers.length) {
    console.log(all ? 'Nobody else is running.' : `Nobody else is on ${res.project || 'this project'} right now.`);
    return;
  }
  for (const p of res.peers) {
    const where = all && p.project ? ` [${p.project}]` : '';
    console.log(`${p.codename}${where} — ${p.status}, ${p.minutes}m, ${[p.engine, p.model].filter(Boolean).join(' ')}`);
    console.log(`    ${p.task || 'no task recorded'}`);
  }
}

async function msg(argv) {
  const [to, ...rest] = argv;
  if (!to) die('usage: kiln msg <codename> "message"  (or pipe the message in)');
  const text = (rest.join(' ') || await readStdin()).trim();
  const res = await api('POST', '/api/msg', { sessionId: SESSION, to, text });
  if (!res.ok) die(WHY[res.error] || res.error || 'failed');
  console.log(`sent to ${res.to}`);
}
const SESSION = process.env.KILN_SESSION;

(async () => {
  if (args[0] === 'who' || args[0] === 'msg') {
    if (!SESSION) die('no KILN_SESSION — run this from inside a kiln card');
    return args[0] === 'who' ? who(args.slice(1)) : msg(args.slice(1));
  }
  if (args.includes('-h') || args.includes('--help') || args[0] === 'help') return help();
  if (args.includes('-v') || args.includes('--version')) {
    return console.log(require(path.join(ROOT, 'package.json')).version);
  }

  const server = path.join(ROOT, 'server', 'index.js');
  if (args[0] === 'server') {
    // Foreground: this is the shape you want in a terminal you are watching,
    // and the shape a launchd/systemd unit wants too.
    require(server);
    return;
  }
  if (args[0] === 'open') return openBrowser(URL);

  if (await alive()) {
    openBrowser(URL);
    return;
  }
  // Detached, so closing the terminal you started it from does not take your
  // terminals with it. Logs go to the data directory, not to this shell.
  const fs = require('fs');
  const dataDir = process.env.KILN_DATA || path.join(require('os').homedir(), '.kiln');
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.openSync(path.join(dataDir, 'server.log'), 'a');
  const child = spawn(process.execPath, [server], {
    detached: true, stdio: ['ignore', log, log], cwd: ROOT,
    env: { ...process.env, KILN_PORT: String(PORT) },
  });
  child.unref();

  if (await waitFor(30_000)) {
    openBrowser(URL);
  } else {
    // A dead window says nothing. The end of the log says why.
    console.error(`kiln did not answer on ${URL} within 30s. The end of the log:\n`);
    try {
      const text = fs.readFileSync(path.join(dataDir, 'server.log'), 'utf8');
      console.error(text.split('\n').slice(-15).join('\n'));
    } catch { console.error('(no log was written — is node able to run server/index.js?)'); }
    process.exit(1);
  }
})();
