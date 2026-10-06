/*
 * Agents knowing about each other, and reaching each other.
 *
 * Two agents in one file is the last writer winning, so a card is told who is
 * already on its project at dispatch, and `kiln who` refreshes that because the
 * roster goes stale as cards come and go. `kiln msg` puts a line in front of
 * one of them as its next prompt. Cards are bare shells (KILN_TEST_PLAIN=1), so
 * no agent runs and no tokens are spent.
 */
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const PORT = 5992;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-peers-data-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-peers-proj-'));
const OTHER = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-peers-other-'));
const CLI = path.join(ROOT, 'bin', 'kiln.js');

const WebSocket = require(path.join(ROOT, 'node_modules/ws'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
// The CLI as a card would run it: KILN_SESSION is the only proof it is one.
const kiln = (session, ...argv) => {
  try {
    return execFileSync(process.execPath, [CLI, ...argv], {
      env: { ...process.env, KILN_PORT: String(PORT), KILN_SESSION: session || '' },
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) { return `ERR ${err.stderr || err.message}`; }
};

const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
  env: { ...process.env, KILN_PORT: String(PORT), KILN_DATA: DATA, KILN_TEST_PLAIN: '1', KILN_PROJECTS_ROOT: os.tmpdir() },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write('[server!] ' + d));

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};

(async () => {
  await wait(1500);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const seen = [];
  ws.on('message', (raw) => seen.push(JSON.parse(raw)));
  await new Promise((r) => ws.on('open', r));

  const addProject = async (p, name) => {
    ws.send(JSON.stringify({ type: 'addProject', path: p, name }));
    await wait(400);
    return seen.filter((m) => m.type === 'projectAdded').pop().project;
  };
  const spawnCard = async (projectId, task) => {
    const before = seen.length;
    ws.send(JSON.stringify({ type: 'spawn', projectId, engine: 'claude', task }));
    await wait(1500);
    return seen.slice(before).find((m) => m.type === 'spawned')?.session;
  };
  const brief = (s) => {
    const recs = JSON.parse(fs.readFileSync(path.join(DATA, 'sessions.json'), 'utf8'));
    return ((recs.sessions || recs).find((r) => r.id === s.id) || {}).bootstrap || '';
  };

  const demo = await addProject(PROJ, 'demo');
  const away = await addProject(OTHER, 'elsewhere');

  const first = await spawnCard(demo.id, 'rewrite the billing flow with ultracode');
  check('a card spawned', !!first);
  await wait(2500); // the save is coalesced
  const b1 = brief(first);
  check('a lone card lists nobody', !/Already working on this project/.test(b1), b1.slice(0, 200));
  check('but is told how to check', /kiln\.js" who/.test(b1), b1.slice(-600));
  check('and how to message', /kiln\.js" msg/.test(b1));

  const second = await spawnCard(demo.id, 'add the invoice index');
  const elsewhere = await spawnCard(away.id, 'unrelated work');
  await wait(2500);
  const b2 = brief(second);
  check('the second card is told the first is here',
    new RegExp(`Already working on this project[\\s\\S]*${first.codename}`).test(b2), b2.slice(0, 300));
  check('and what it was asked for', /rewrite the billing flow/.test(b2));
  check('a peer\'s "ultracode" is quoted, not obeyed', /ultra-code/.test(b2) && !/\bultracode\b/i.test(b2));
  check('a card on another project is not a peer', !b2.includes(elsewhere.codename));

  const out = kiln(second.id, 'who');
  check('`kiln who` lists the peer', out.includes(first.codename), out);
  check('and never the caller', !out.includes(second.codename));
  check('and not another project', !out.includes(elsewhere.codename));
  const all = kiln(second.id, 'who', '--all');
  check('`--all` reaches across projects', all.includes(elsewhere.codename) && all.includes('[elsewhere]'), all);
  check('a shell that is not a card is refused', /not a kiln card/.test(kiln('nope', 'who')));

  const sent = kiln(second.id, 'msg', first.codename, 'heads up, I am in billing.ts');
  check('`kiln msg` reaches a live peer', /sent to/.test(sent), sent);
  check('`@codename` works too', /sent to/.test(kiln(second.id, 'msg', `@${first.codename}`, 'hi')));
  check('an unknown name is refused', /no live agent/.test(kiln(second.id, 'msg', 'ghost-0', 'hi')));
  check('messaging yourself is refused', /that is you/.test(kiln(second.id, 'msg', second.codename, 'hi')));
  const anon = await post('/api/msg', { sessionId: 'nope', to: first.codename, text: 'hi' });
  check('the API refuses a non-card', anon.status === 403);

  ws.send(JSON.stringify({ type: 'close', id: first.id }));
  await wait(800);
  check('a closed card stops being a peer', !kiln(second.id, 'who').includes(first.codename));

  ws.close();
  child.kill();
  console.log(fails.length ? `\n${fails.length} failed` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error(err); child.kill(); process.exit(1); });
