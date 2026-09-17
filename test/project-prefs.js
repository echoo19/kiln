/*
 * A project's settings outlive the project record.
 *
 * Removing a project from the canvas leaves the folder on disk and the profile
 * on disk alone, so adding the same folder back should not ask which profile it
 * was again. Boots its own server over a throwaway data dir.
 *
 *   node test/project-prefs.js
 */
const WebSocket = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 5394;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-prefs-'));
const DATA = path.join(tmp, 'data');
const PROJ = path.join(tmp, 'proj');
fs.mkdirSync(path.join(DATA, 'profiles'), { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });
fs.writeFileSync(path.join(DATA, 'profiles', 'testprof.env'), 'FOO=bar\n');

let fails = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : '  — ' + detail}`);
  if (!ok) fails++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let server, ws;
const cleanup = () => {
  try { ws?.close(); } catch { /* gone */ }
  try { server?.kill(); } catch { /* gone */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* still held */ }
};

(async () => {
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

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = [];
  ws.on('message', (raw) => inbox.push(JSON.parse(raw)));
  await new Promise((r) => ws.on('open', r));
  const next = async (type) => {
    for (let i = 0; i < 60; i++) {
      const m = inbox.find((x) => x.type === type);
      if (m) { inbox.splice(inbox.indexOf(m), 1); return m; }
      await wait(100);
    }
    throw new Error(`never saw ${type}`);
  };
  const say = (msg) => ws.send(JSON.stringify(msg));

  await next('init');
  say({ type: 'addProject', path: PROJ });
  const first = (await next('projectAdded')).project;
  check('a fresh folder starts with no profile', !first.envProfile, String(first.envProfile));

  say({
    type: 'updateProject', projectId: first.id, envProfile: 'testprof',
    defaults: { engine: 'claude', model: 'opus', effort: 'high' },
  });
  const updated = (await next('projectUpdated')).project;
  check('the profile is set', updated.envProfile === 'testprof', updated.envProfile);

  say({ type: 'removeProject', projectId: first.id });
  await next('projectRemoved');
  say({ type: 'addProject', path: PROJ });
  const again = (await next('projectAdded')).project;
  check('re-adding the same folder brings the profile back',
    again.envProfile === 'testprof', String(again.envProfile));
  check('and its engine defaults with it',
    again.defaults?.engine === 'claude' && again.defaults?.effort === 'high',
    JSON.stringify(again.defaults));
  check('it is a new record, not a resurrected one', again.id !== first.id);

  // A profile deleted while the project was gone must not come back as a name
  // that resolves to nothing.
  say({ type: 'removeProject', projectId: again.id });
  await next('projectRemoved');
  await fetch(`http://127.0.0.1:${PORT}/api/profiles/testprof`, { method: 'DELETE' });
  say({ type: 'addProject', path: PROJ });
  const third = (await next('projectAdded')).project;
  check('a profile that no longer exists is not restored',
    !third.envProfile, String(third.envProfile));

  cleanup();
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); cleanup(); process.exit(1); });
