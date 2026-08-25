/*
 * kiln smoke test. Boots a server on its own port with its own data directory,
 * dispatches cards as bare shells (KILN_TEST_PLAIN=1, so no agent runs and no
 * tokens are spent), and checks the parts that are easy to break and quiet
 * about it: the hook settings file, project env loading, the memory budget and
 * its pruning, and that a connection's secret never comes back out of the API.
 *
 *   npm test
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const PORT = 5991;
const DATA = path.join(os.tmpdir(), 'kiln-smoke-data');
const PROJ = path.join(os.tmpdir(), 'kiln-smoke-project');
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(PROJ, { recursive: true, force: true });
fs.mkdirSync(PROJ, { recursive: true });
fs.writeFileSync(path.join(PROJ, '.env'), 'SMOKE_TOKEN=abcdefghij123\n');

const WebSocket = require(path.join(ROOT, 'node_modules/ws'));
const base = `http://127.0.0.1:${PORT}`;
const api = async (p, opt) => {
  const r = await fetch(base + p, opt);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
  env: { ...process.env, KILN_PORT: String(PORT), KILN_DATA: DATA, KILN_TEST_PLAIN: '1', KILN_PROJECTS_ROOT: os.tmpdir() },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
child.stderr.on('data', (d) => process.stderr.write('[server!] ' + d));

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};

(async () => {
  await wait(1500);
  // hooks file written where the CLI can find it
  check('hook settings written', fs.existsSync(path.join(DATA, 'claude-hooks.json')));
  check('starter prompts seeded', fs.readdirSync(path.join(DATA, 'prompts')).length > 5);

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let init = null;
  const seen = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'init') init = m;
    seen.push(m);
  });
  await wait(600);
  check('init frame', !!init, init ? `engines=${JSON.stringify(init.engines)}` : '');
  check('two engines in catalog', Object.keys(init.catalog).join(',') === 'claude,codex');

  ws.send(JSON.stringify({ type: 'addProject', path: PROJ, name: 'smoke' }));
  await wait(400);
  const proj = seen.find((m) => m.type === 'projectAdded')?.project;
  check('project added', !!proj);
  check('memory seeded with headings',
    fs.readFileSync(path.join(PROJ, '.kiln/index.md'), 'utf8').includes('## Decisions'));

  // dispatch a plain shell card (no agent, no tokens)
  ws.send(JSON.stringify({ type: 'spawn', projectId: proj.id, engine: 'claude', task: 'smoke' }));
  await wait(1500);
  const card = seen.find((m) => m.type === 'spawned')?.session;
  check('card dispatched', !!card, card ? `${card.codename} env=${card.envCount}` : '');
  check('project .env reached the card', card && card.envCount === 1);
  const out = seen.filter((m) => m.type === 'data' && m.id === card.id).map((m) => m.data).join('');
  check('pty produced output', out.length > 0, `${out.length} bytes`);

  // memory budget
  const mem = await api(`/api/memory/${proj.id}`);
  check('memory reports a budget', mem.j.cap > 0 && mem.j.used > 0, `${mem.j.used}/${mem.j.cap}`);
  const over = await api(`/api/memory/${proj.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: 'x'.repeat(mem.j.cap + 1) }),
  });
  check('oversized index refused', over.status === 400, over.j.error || '');
  const ok = await api(`/api/memory/${proj.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: '# tight\n' }),
  });
  check('index within budget saves', ok.status === 200);

  // run-note pruning: 25 notes in, 20 survive the next dispatch
  const runs = path.join(PROJ, '.kiln/runs');
  fs.mkdirSync(runs, { recursive: true });
  for (let i = 0; i < 25; i++) {
    fs.writeFileSync(path.join(runs, `note-${String(i).padStart(2, '0')}.md`), `# note ${i}\n`);
    fs.utimesSync(path.join(runs, `note-${String(i).padStart(2, '0')}.md`), new Date(), new Date(Date.now() - (25 - i) * 60000));
  }
  const big = path.join(runs, 'huge.md');
  fs.writeFileSync(big, '# huge\n' + 'y'.repeat(20000));
  ws.send(JSON.stringify({ type: 'spawn', projectId: proj.id, engine: 'codex', task: 'prune' }));
  await wait(1200);
  const left = fs.readdirSync(runs);
  check('run notes pruned to the keep count', left.length === 20, `${left.length} left`);
  check('oversized run note truncated', !fs.existsSync(big) || fs.statSync(big).size < 5000);

  // connections
  const put = await api('/api/connections/linear', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'npx', args: ['-y', '@acme/mcp'], env: { TOKEN: 'secret-value-here' } }),
  });
  check('connection saved', put.status === 200);
  const list = await api('/api/connections');
  const c = list.j.connections[0];
  check('connection listed', c && c.name === 'linear' && c.command === 'npx');
  check('connection secret masked', c && c.env[0].masked.endsWith('here') && !JSON.stringify(list.j).includes('secret-value-here'));
  const del = await api('/api/connections/linear', { method: 'DELETE' });
  check('connection removed', del.status === 200 && (await api('/api/connections')).j.connections.length === 0);

  ws.close();
  child.kill();
  await wait(300);
  console.log(fails.length ? `\n${fails.length} failing: ${fails.join(', ')}` : '\nall good');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); child.kill(); process.exit(1); });
