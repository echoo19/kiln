/*
 * The files panel, driven in a real browser over raw CDP.
 *
 * Three things it has to do and used to not: survive a rebuild with the same
 * folders open, remember them across a reload, and show what changed on disk
 * without anyone pressing refresh.
 *
 * Boots its own server on a throwaway port over a throwaway data dir and a
 * throwaway project tree, so it never touches the real one.
 *
 *   node test/files-panel.js
 */
const WebSocket = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 5392;
const CHROME = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
}[process.platform] || [
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];
const BROWSER = CHROME.find((p) => fs.existsSync(p));

let fails = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : '  — ' + detail}`);
  if (!ok) fails++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-files-'));
const DATA = path.join(tmp, 'data');
const PROJ = path.join(tmp, 'proj');
fs.mkdirSync(path.join(PROJ, 'src', 'deep'), { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(PROJ, 'top.txt'), 'top\n');
fs.writeFileSync(path.join(PROJ, 'src', 'one.js'), '1\n');
fs.writeFileSync(path.join(PROJ, 'src', 'deep', 'two.js'), '2\n');
fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({
  projects: [{ id: 'ptest', name: 'proj', path: PROJ, color: '#4cc2ff' }],
}));

let server, chrome, ws;
const cleanup = () => {
  try { ws?.close(); } catch { /* already gone */ }
  try { chrome?.kill(); } catch { /* already gone */ }
  try { server?.kill(); } catch { /* already gone */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* still held */ }
};

(async () => {
  if (!BROWSER) { console.log('no Chrome or Edge found'); cleanup(); process.exit(2); }

  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, KILN_PORT: String(PORT), KILN_DATA: DATA, KILN_TEST_PLAIN: '1' },
    stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await wait(250);
    try { up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { /* not yet */ }
  }
  if (!up) { console.log('server never came up'); cleanup(); process.exit(2); }

  const profile = path.join(tmp, 'chrome');
  chrome = spawn(BROWSER, [
    '--headless=new', '--remote-debugging-port=9335', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1400,900',
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await wait(250);
    try {
      const list = await (await fetch('http://127.0.0.1:9335/json/list')).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) { console.log('chrome never came up'); cleanup(); process.exit(2); }

  ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description || 'exception');
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push((m.params.args || []).map((a) => a.value || a.description).join(' '));
    }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  ws.on('message', async (raw) => {
    const m = JSON.parse(raw);
    if (m.method === 'Page.javascriptDialogOpening') await send('Page.handleJavaScriptDialog', { accept: true });
  });

  const load = async () => {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    for (let i = 0; i < 60; i++) {
      if (await evaluate('document.readyState === "complete" && !!document.querySelector("#brand")')) break;
      await wait(250);
    }
    // The tree is fetched, so the DOM being complete is not the tree being there.
    for (let i = 0; i < 40; i++) {
      if (await evaluate('!!document.querySelector("#files-body .tree li")')) break;
      await wait(250);
    }
  };
  const labels = () => evaluate(
    '[...document.querySelectorAll("#files-body .tree .label")].map((e) => e.textContent).join(",")'
  );

  await load();
  check('the tree renders the project root', /top\.txt/.test(await labels()), await labels());

  // --- expanding
  await evaluate(
    '[...document.querySelectorAll("#files-body .tree > li > .row")]'
    + '.find((r) => r.querySelector(".label").textContent === "src").click()'
  );
  for (let i = 0; i < 20; i++) {
    if (/one\.js/.test(await labels())) break;
    await wait(200);
  }
  check('expanding a folder reads it', /one\.js/.test(await labels()), await labels());

  // --- reload keeps it open
  await load();
  await wait(400);
  check('the open folder survives a reload', /one\.js/.test(await labels()), await labels());

  // --- a change on disk arrives on its own
  fs.writeFileSync(path.join(PROJ, 'src', 'appeared.js'), 'new\n');
  let arrived = false;
  for (let i = 0; i < 30 && !arrived; i++) {
    await wait(200);
    arrived = /appeared\.js/.test(await labels());
  }
  check('a new file shows up without pressing refresh', arrived, await labels());

  fs.rmSync(path.join(PROJ, 'src', 'appeared.js'));
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) {
    await wait(200);
    gone = !/appeared\.js/.test(await labels());
  }
  check('and a deleted one goes away the same way', gone, await labels());
  check('the folder is still open after the live refresh',
    /one\.js/.test(await labels()), await labels());

  // --- collapsing is remembered too
  await evaluate(
    '[...document.querySelectorAll("#files-body .tree > li > .row")]'
    + '.find((r) => r.querySelector(".label").textContent === "src").click()'
  );
  await wait(300);
  await load();
  await wait(400);
  check('a collapsed folder stays collapsed across a reload',
    !/one\.js/.test(await labels()), await labels());

  check('nothing threw', errors.length === 0, errors.slice(0, 3).join(' | '));

  cleanup();
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); cleanup(); process.exit(1); });
