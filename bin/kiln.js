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

(async () => {
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
