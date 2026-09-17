/* kiln client — canvas, dispatch, hook-driven subagents, drawers. */
(() => {
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const viewport = $('#viewport');
const canvas = $('#canvas');
const edgesSvg = $('#edges');

const state = {
  engines: {},     // which engine CLIs this box actually has
  catalog: null,   // per-engine (and per-subscription) models + reasoning levels
  projects: [],
  sessions: new Map(),  // id -> {data, el, term, fit, queue, fitTimer, lastMoveSent}
  minis: new Map(),     // id -> {data, el}
  viewers: new Map(),   // id -> {id, path, el, x, y, w, h} — client-only file viewers
  notes: new Map(),     // id -> {data, el} — server-persisted rich-text notes
  editingNote: null,    // the one note whose editor currently has the caret
  browsers: new Map(),  // sessionId -> {el, lastUrl} — live browser activity cards
  cam: { x: 80, y: 60, z: 1 },
  selectedProject: localStorage.getItem('kiln.project') || null,
  home: localStorage.getItem('kiln.home') === '1',
  drawer: null,
  prompts: [],
  zTop: 10,
  expectSpawn: false,
  expectProjectAdd: false,
  expectNote: false,
  notify: localStorage.getItem('kiln.notify') === '1',
  // Status read-outs can be switched off wholesale while the classifier is
  // being trusted again. Off by default until someone turns them back on.
  showStatus: localStorage.getItem('kiln.status') === '1',
};
// Each project is its own workspace: its own cards, its own notes, its own
// patch of canvas. Switching tabs should feel like switching desks, so the
// camera is remembered per project too.
const camKey = (pid) => `kiln.cam.${pid || '_none'}`;
function loadCam(pid) {
  try {
    const cam = JSON.parse(localStorage.getItem(camKey(pid)));
    if (cam && Number.isFinite(cam.x) && cam.z > 0.1) return cam;
  } catch { /* defaults */ }
  return { x: 80, y: 60, z: 1 };
}
state.cam = loadCam(state.selectedProject);

const MIN_W = 480, MIN_H = 300;
const MINI_W = 250, MINI_H = 92, MINI_GAP = 14;

const STATUS_LABEL = {
  running: 'RUNNING', 'needs-you': 'NEEDS YOU', 'bg-agents': 'BG AGENTS',
  ready: 'READY', idle: 'IDLE', done: 'DONE', failed: 'FAILED',
  offline: 'OFFLINE',
};
const STATUS_COLOR = {
  running: '#3fd68c', 'needs-you': '#f0a840', 'bg-agents': '#a78bfa',
  ready: '#4d9fff', idle: '#6b7484', done: '#565660', failed: '#f2726f',
  offline: '#8a6a3f',
};
const ENGINE_COLOR = {
  claude: '#e8845a', codex: '#c3cdd9',
};
const ENGINE_LABEL = {
  claude: 'claude', codex: 'codex',
};
const ENGINE_SUB = {
  claude: 'claude code', codex: 'codex cli',
};
// The engine is a product, so it gets its own mark.
const ENGINE_GLYPH = {
  claude: 'claude', codex: 'openai',
};
const svgIcon = (glyph, size) =>
  `<svg class="ic" width="${size}" height="${size}" aria-hidden="true"><use href="#i-${glyph}"/></svg>`;
const engineIcon = (engine, size = 13) => svgIcon(ENGINE_GLYPH[engine] || 'claude', size);

const fontsReady = Promise.all(
  ['400', '500', '600', '700'].map((w) => document.fonts.load(`${w} 14px "JetBrains Mono"`)),
).catch(() => {});

// ---------------------------------------------------------------- helpers
function project(id) { return state.projects.find((p) => p.id === id) || null; }
function projectColor(id) { return project(id)?.color || '#3a3a42'; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
  return String(n);
}
function fmtBytes(n) {
  if (n >= 1_048_576) return (n / 1_048_576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}
function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}
function fmtAgo(ts) {
  const d = Date.now() - ts;
  if (d < 90_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}
function displayStatus(d) {
  if (d.status === 'done') {
    return d.exitCode ? { key: 'failed', label: `EXIT ${d.exitCode}` } : { key: 'done', label: 'DONE' };
  }
  return { key: d.status, label: STATUS_LABEL[d.status] || d.status.toUpperCase() };
}

function applyCamera() {
  const { x, y, z } = state.cam;
  canvas.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  const fine = `${26 * z}px ${26 * z}px`;
  const major = `${156 * z}px ${156 * z}px`;
  viewport.style.backgroundSize = `${fine}, ${fine}, ${major}, ${major}`;
  viewport.style.backgroundPosition = `${x}px ${y}px`;
  $('#zoom-reset').textContent = `${Math.round(z * 100)}%`;
  clearTimeout(applyCamera.t);
  applyCamera.t = setTimeout(
    () => localStorage.setItem(camKey(state.selectedProject), JSON.stringify(state.cam)), 300);
}

// ------------------------------------------------------------ workspaces
// Everything on the canvas belongs to exactly one project. Cards keep their
// state while hidden, so switching tabs and switching back costs nothing.
function inWorkspace(projectId) {
  return (projectId || null) === (state.selectedProject || null);
}
function applyWorkspace() {
  for (const e of state.sessions.values()) {
    e.el.hidden = !inWorkspace(e.data.projectId);
    if (e.el.hidden) e.staleSize = true;   // whatever it measures now is zero
  }
  for (const m of state.minis.values()) {
    const parent = state.sessions.get(String(m.data.parentId));
    m.el.hidden = !parent || parent.el.hidden;
  }
  for (const b of state.browsers.values()) {
    const parent = state.sessions.get(b.sessionId);
    b.el.hidden = !parent || parent.el.hidden;
  }
  for (const n of state.notes.values()) n.el.hidden = !inWorkspace(n.data.projectId);
  for (const v of state.viewers.values()) v.el.hidden = !inWorkspace(v.projectId);
  renderEdges();
}
function screenToCanvas(sx, sy) {
  const r = viewport.getBoundingClientRect();
  return { x: (sx - r.left - state.cam.x) / state.cam.z, y: (sy - r.top - state.cam.y) / state.cam.z };
}
function viewportCenter() {
  const r = viewport.getBoundingClientRect();
  return { sx: r.left + r.width / 2, sy: r.top + r.height / 2 };
}

// ---------------------------------------------------------------- websocket
let ws = null;
function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

// `public/` is served straight off disk, so an app window left open all day
// keeps running whatever app.js it loaded with — it speaks an older protocol to
// a newer server and looks like features simply do not exist. Compare the file
// on disk with the one this page loaded (Last-Modified, no server support
// needed) and reload once when they diverge. Every reconnect rechecks, so a
// server restart also picks up client changes.
let assetStamp = null;
async function checkClientFresh() {
  try {
    const res = await fetch('/app.js', { method: 'HEAD', cache: 'no-store' });
    const stamp = res.headers.get('last-modified');
    if (!stamp) return;
    if (!assetStamp) { assetStamp = stamp; return; }
    if (stamp !== assetStamp) location.reload();
  } catch { /* offline: nothing to compare against */ }
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    $('#conn-dot').classList.remove('off');
    $('#disconnected-banner').hidden = true;
    checkClientFresh();
  };
  ws.onclose = () => {
    $('#conn-dot').classList.add('off');
    $('#disconnected-banner').hidden = false;
    setTimeout(connect, 2000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const entry = msg.id ? state.sessions.get(String(msg.id)) : null;
    switch (msg.type) {
      case 'init':
        resetAll();
        state.engines = msg.engines || {};
        state.catalog = msg.catalog || null;
        state.projects = msg.projects;
        if (!project(state.selectedProject)) {
          state.selectedProject = state.projects[0]?.id || null;
          state.cam = loadCam(state.selectedProject);
          applyCamera();
        }
        for (const s of msg.sessions) addSession(s, s.scrollback);
        for (const a of msg.subagents || []) addMini(a);
        for (const n of msg.notes || []) addNote(n);
        renderPills();
        renderFilesPanel();
        applyWorkspace();
        restoreViewers();
        updateChrome();
        break;
      case 'spawned':
        addSession(msg.session);
        renderPills();
        applyWorkspace();
        updateChrome();
        if (state.expectSpawn) { state.expectSpawn = false; focusSession(msg.session.id); }
        break;
      case 'data':
        if (entry) { entry.term ? termWrite(entry, msg.data) : entry.queue.push(msg.data); }
        break;
      case 'status':
        if (entry) {
          const prev = entry.data.status;
          entry.data.status = msg.status;
          entry.data.exitCode = msg.exitCode;
          entry.data.note = msg.note;
          renderStatus(entry);
          updateChrome();
          if (msg.status === 'needs-you' && prev !== 'needs-you') notifyUser(entry.data, entry.data.note || 'needs your attention');
        }
        break;
      case 'restored':
        if (entry) {
          // Same card, live process behind it again. Keep the scrollback that
          // is already on screen; the server only sends the new status.
          Object.assign(entry.data, msg.session);
          entry.el.querySelector('.elapsed').dataset.start = msg.session.startedAt;
          delete entry.el.querySelector('.elapsed').dataset.end;
          renderStatus(entry);
          updateChrome();
          fitSoon(entry);
        }
        break;
      case 'exit':
        if (entry) {
          entry.data.status = 'done';
          entry.data.exitCode = msg.code;
          entry.el.querySelector('.elapsed').dataset.end = Date.now();
          renderStatus(entry);
          updateChrome();
          notifyUser(entry.data, `exited (${msg.code})`);
        }
        break;
      case 'moved':
        if (entry) { entry.data.x = msg.x; entry.data.y = msg.y; positionCard(entry); layoutMinis(entry.data.id); renderEdges(); }
        break;
      case 'renamed':
        if (entry) {
          entry.data.title = msg.title;
          $('.card-title', entry.el).textContent = msg.title;
          updateChrome();
        }
        break;
      case 'closed':
        removeSession(String(msg.id));
        updateChrome();
        break;
      case 'subagentStarted': {
        addMini(msg.subagent);
        const mini = state.minis.get(msg.subagent.id);
        const owner = state.sessions.get(String(msg.subagent.parentId));
        if (mini && owner) mini.el.hidden = owner.el.hidden;
        break;
      }
      case 'subagentEnded': {
        const m = state.minis.get(msg.subagent.id);
        if (m) {
          m.data = msg.subagent;
          m.el.dataset.status = 'done';
          m.el.querySelector('.elapsed').dataset.end = msg.subagent.endedAt;
        }
        break;
      }
      case 'subagentRemoved': {
        const m = state.minis.get(msg.id);
        if (m) {
          const pid = m.data.parentId;
          m.el.remove();
          state.minis.delete(msg.id);
          layoutMinis(pid);
          renderEdges();
        }
        break;
      }
      case 'projectAdded':
        state.projects.push(msg.project);
        if (state.expectProjectAdd || !state.selectedProject) {
          state.expectProjectAdd = false;
          selectProject(msg.project.id);
        }
        renderPills();
        renderFilesPanel();
        break;
      case 'projectUpdated': {
        const i = state.projects.findIndex((p) => p.id === msg.project.id);
        if (i >= 0) state.projects[i] = msg.project;
        break;
      }
      // The project folder changed on disk — a pull, an agent's edit, a rename.
      // Only the panel's own project is worth a re-read.
      case 'fsChanged':
        if (msg.projectId === state.selectedProject) renderFilesPanel();
        break;
      case 'projectRemoved':
        state.projects = state.projects.filter((p) => p.id !== msg.projectId);
        localStorage.removeItem(camKey(msg.projectId));
        if (state.selectedProject === msg.projectId) {
          state.selectedProject = state.projects[0]?.id || null;
          localStorage.setItem('kiln.project', state.selectedProject || '');
          state.cam = loadCam(state.selectedProject);
          applyCamera();
        }
        renderPills();
        renderFilesPanel();
        for (const e of state.sessions.values()) applyCardColors(e);
        applyWorkspace();
        updateChrome();
        break;
      case 'browserAction':
        if (entry) {
          const b = ensureBrowserCard(entry, msg.lastTs);
          b.lastUrl = msg.lastUrl;
          pushBrowserAction(b, msg.action);
          renderBrowserHead(b);
          b.el.hidden = entry.el.hidden;
        }
        break;
      case 'browserShot':
        if (entry) {
          const b = ensureBrowserCard(entry, msg.lastTs);
          setBrowserShot(b, msg.shot);
          b.el.hidden = entry.el.hidden;
        }
        break;
      case 'browserEnded':
        removeBrowserCard(String(msg.id));
        break;
      case 'noteAdded':
        addNote(msg.note, state.expectNote);
        state.expectNote = false;
        applyWorkspace();
        break;
      case 'noteUpdated': {
        const n = state.notes.get(msg.note.id);
        // Never redraw under a live caret; the editor holds the newer copy.
        if (n && n !== state.editingNote) { n.data = msg.note; renderNote(n); }
        break;
      }
      case 'noteMoved': {
        const n = state.notes.get(msg.note.id);
        if (n) { n.data = msg.note; positionNote(n); }
        break;
      }
      case 'noteRemoved': {
        const n = state.notes.get(msg.noteId);
        if (n) {
          if (state.editingNote === n) state.editingNote = null;
          n.el.remove();
          state.notes.delete(msg.noteId);
        }
        break;
      }
      case 'error':
        alert(msg.message);
        break;
    }
  };
}

function resetAll() {
  for (const e of state.sessions.values()) { e.ro?.disconnect(); dropWebgl(e); e.term?.dispose(); e.el.remove(); }
  for (const m of state.minis.values()) m.el.remove();
  for (const n of state.notes.values()) n.el.remove();
  for (const b of state.browsers.values()) b.el.remove();
  state.editingNote = null;
  state.sessions.clear();
  state.minis.clear();
  state.notes.clear();
  state.browsers.clear();
}

function removeSession(id) {
  const e = state.sessions.get(id);
  if (!e) return;
  e.ro?.disconnect();
  dropWebgl(e);
  e.term?.dispose();
  e.el.remove();
  state.sessions.delete(id);
  removeBrowserCard(id);
  for (const m of [...state.minis.values()]) {
    if (m.data.parentId === id) { m.el.remove(); state.minis.delete(m.data.id); }
  }
  renderPills();
  layoutAllAttachments();   // the space this card held just opened up
  updateChrome();
}

// ---------------------------------------------------------------- terminal cards
const TERM_THEME = {
  background: '#0a0a0c', foreground: '#e2e2e6',
  cursor: '#e8845a', cursorAccent: '#0a0a0c',
  selectionBackground: '#33404f',
  black: '#1a1a1e', red: '#f2726f', green: '#3fd68c', yellow: '#f0a840',
  blue: '#4d9fff', magenta: '#c792ea', cyan: '#38d4c3', white: '#e2e2e6',
  brightBlack: '#565660', brightRed: '#ff8a87', brightGreen: '#5fe8a5',
  brightYellow: '#ffc06a', brightBlue: '#7db8ff', brightMagenta: '#dab3f5',
  brightCyan: '#5fe8d8', brightWhite: '#ffffff',
};

// Every agent TUI dims its own chrome with SGR 2 — status lines, box rules,
// hints, and the whole replayed transcript a `--resume` prints. xterm draws a
// dim glyph at half alpha, and half alpha against #0a0a0c is barely there, so
// a resumed card reads as a wall of grey. There is no renderer knob for it
// (DIM_OPACITY is a constant inside the webgl addon), so the attribute is taken
// out of the stream instead: everything arrives at full strength, and colour is
// left exactly as the agent chose it.
const SGR = /\x1b\[([\x30-\x3f]*)m/g;

// Rewrite one SGR parameter list without its dim attribute, or return the list
// unchanged. The literal `2` is only dim when it stands alone as a parameter:
// in 38;2;R;G;B (and 48/58) it selects the truecolour form, and in 38;5;N it is
// inside a run this has to copy verbatim.
function withoutDim(params) {
  if (!params.includes('2')) return params;
  const p = params.split(';');
  const out = [];
  for (let i = 0; i < p.length; i++) {
    const tok = p[i];
    if (tok === '38' || tok === '48' || tok === '58') {
      const run = p[i + 1] === '2' ? 5 : p[i + 1] === '5' ? 3 : 1;
      for (let k = 0; k < run && i + k < p.length; k++) out.push(p[i + k]);
      i += run - 1;
      continue;
    }
    if (tok === '2') continue;                     // the dim attribute itself
    out.push(tok);
  }
  return out.join(';');
}

function undim(chunk) {
  if (!chunk.includes('\x1b[')) return chunk;
  return chunk.replace(SGR, (whole, params) => {
    const kept = withoutDim(params);
    if (kept === params) return whole;
    // A sequence that was nothing but dim has to vanish rather than become
    // ESC[m, which is a full reset and would drop the colour around it.
    return kept ? `\x1b[${kept}m` : '';
  });
}

// A chunk can end part way through an escape sequence, and half of ESC[2m
// matches nothing. Hold the fragment back until the rest of it arrives — the
// held bytes render nothing on their own, so this is what xterm's own parser
// would do with them anyway.
const ANSI_FRAGMENT = /\x1b(?:\[[\x30-\x3f]*)?$/;

function termWrite(entry, chunk) {
  let s = (entry.ansiTail || '') + chunk;
  entry.ansiTail = '';
  const cut = ANSI_FRAGMENT.exec(s);
  if (cut) { entry.ansiTail = cut[0]; s = s.slice(0, cut.index); }
  if (s) entry.term.write(undim(s));
}

function addSession(data, scrollback) {
  const el = $('#card-template').content.firstElementChild.cloneNode(true);
  canvas.appendChild(el);
  const entry = { data, el, term: null, fit: null, queue: [], fitTimer: 0, lastMoveSent: 0 };
  el.dataset.id = data.id;
  state.sessions.set(String(data.id), entry);

  $('.card-title', el).textContent = data.title;
  const eng = $('.engine-tag', el);
  eng.innerHTML = `${engineIcon(data.engine, 13)}<span></span>`;
  $('span', eng).textContent = (ENGINE_LABEL[data.engine] || data.engine) +
    (data.auth ? ` · ${data.auth}` : '');
  eng.style.setProperty('--engine-color', ENGINE_COLOR[data.engine] || 'var(--muted)');
  const modelInfo = [data.model, data.effort].filter(Boolean).join(' · ');
  eng.title = modelInfo;
  $('.env-tag', el).hidden = !data.envCount;
  $('.env-tag', el).title = `${data.envCount} env var${data.envCount === 1 ? '' : 's'} loaded` +
    (data.envProfile ? ` (profile "${data.envProfile}" + project files)` : ' from .env/.envrc');
  $('.foot-main', el).textContent = data.task || `${data.cmdLabel} · ${data.cwd}`;
  $('.foot-main', el).title = `${data.cmdLabel} · ${data.cwd}${modelInfo ? ' · ' + modelInfo : ''}`;
  $('.elapsed', el).dataset.start = data.startedAt;
  if (data.status === 'done' || data.status === 'offline') $('.elapsed', el).dataset.end = data.startedAt;

  applyCardColors(entry);
  positionCard(entry);
  renderStatus(entry);
  wireCard(entry);
  raise(entry);
  restoreBrowser(entry);

  fontsReady.then(() => {
    if (!el.isConnected) return;
    const term = new Terminal({
      theme: TERM_THEME,
      // JetBrains Mono has no braille (the ⠦⠴⠼ spinners every agent TUI uses)
      // and no geometric shapes (▰▱), so those fall back per glyph. Name the
      // fallbacks instead of leaving it to the browser: Cascadia Mono ships
      // with Windows and covers both at monospace metrics, so a spinner keeps
      // the cell width its neighbours have.
      fontFamily: '"JetBrains Mono", "Cascadia Mono", "Segoe UI Symbol", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.25,
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      scrollback: 5000,
      // A fallback glyph drawn from a wider font otherwise spills into the next
      // cell and paints over the character there.
      rescaleOverlappingGlyphs: true,
      // jcode and codex both emit truecolor; re-mapping bold onto the bright
      // palette repaints their chosen colours as something else.
      drawBoldTextInBrightColors: false,
      allowProposedApi: true,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    // Width tables: the agent decides where a glyph ends using current Unicode
    // data, so the terminal has to agree or every cell after it is off by one.
    try {
      term.loadAddon(new Unicode11Addon.Unicode11Addon());
      term.unicode.activeVersion = '11';
    } catch { /* addon missing: fall back to xterm's built-in tables */ }
    term.attachCustomKeyEventHandler((e) => termKeyEvent(term, e));
    term.open($('.term-body', el));
    entry.term = term;
    attachWebgl(entry);
    // Scrollback is raw terminal output, not text: it carries cursor moves,
    // line erases and redraw frames that only land where they were aimed if the
    // terminal is the width the pty was when it wrote them. Replaying a
    // 140-column transcript into an 80-column terminal is what shreds a card on
    // reload — text repeated at the wrong offsets, fragments stranded mid-line.
    // So restore the pty's own geometry, replay into it, and only then fit.
    if (data.cols > 1 && data.rows > 1) {
      try {
        term.resize(data.cols, data.rows);
        entry.sentCols = data.cols; entry.sentRows = data.rows;
      } catch { /* nonsense geometry; fit will sort it out */ }
    }
    if (scrollback) termWrite(entry, scrollback);
    for (const chunk of entry.queue) termWrite(entry, chunk);
    entry.queue.length = 0;
    term.onData((d) => send({ type: 'input', id: data.id, data: d }));
    entry.fit = fit;
    // Opened while its project was off screen? Then everything it just measured
    // is zero, and it needs the full repair the first time it is shown.
    entry.staleSize = !termVisible(entry);
    watchTermSize(entry);
    // Reflow once the replay above has actually been parsed — xterm writes are
    // async, and resizing mid-parse reflows a buffer that is still filling.
    term.write('', () => requestAnimationFrame(() => remeasure(entry, true)));
  });
}

// The GPU renderer is fast but fragile: a browser only keeps a handful of live
// WebGL contexts, and the oldest get evicted when a new one is created (a GPU
// driver reset or a long-backgrounded window does the same). xterm hands the
// terminal back to the DOM renderer when we dispose the addon, but the screen
// stays blank until something forces a repaint — that is the "card went empty
// while the agent is clearly still running" case. So: cap how many cards take a
// context, and always repaint after losing one.
const MAX_WEBGL = 6;
let webglLive = 0;

function attachWebgl(entry) {
  if (entry.gl || entry.noWebgl || !entry.term) return;
  if (webglLive >= MAX_WEBGL) return; // DOM renderer, still correct, just slower
  let gl;
  try {
    gl = new WebglAddon.WebglAddon();
    entry.term.loadAddon(gl);
  } catch {
    entry.noWebgl = true; // no GPU here at all
    return;
  }
  entry.gl = gl;
  webglLive++;
  gl.onContextLoss(() => {
    dropWebgl(entry);
    entry.noWebgl = true; // do not fight for a context we keep losing
    repaint(entry);
  });
}

function dropWebgl(entry) {
  if (!entry.gl) return;
  try { entry.gl.dispose(); } catch { /* already gone */ }
  entry.gl = null;
  webglLive = Math.max(0, webglLive - 1);
}

// Force the terminal to draw its whole viewport again. Cheap, and the only
// reliable cure for a renderer that has silently stopped painting.
function repaint(entry) {
  const term = entry?.term;
  if (!term || !entry.el.isConnected) return;
  if (!termVisible(entry)) { entry.staleSize = true; return; }
  try {
    remeasure(entry); // keeps the pty's idea of the size in step, and repairs
                      // the scroll area if this card has been hidden since
    term.refresh(0, term.rows - 1);
  } catch { /* card is mid-teardown */ }
  requestAnimationFrame(() => {
    try { term.refresh(0, term.rows - 1); } catch { /* ditto */ }
  });
}

function repaintAll() {
  for (const e of state.sessions.values()) repaint(e);
}

const isRepaintKey = (e) => e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 'r' || e.key === 'R');

// Clipboard. Pasting already works — xterm listens for the browser's own paste
// event and brackets the text — but copying does not: with the WebGL renderer
// the selection is not a DOM selection, so there is nothing for the browser to
// copy, and Ctrl+C has to keep meaning SIGINT to the agent underneath.
// So: Ctrl+C copies *only* when a selection exists, and clears it on the way
// out, which makes the second press an interrupt again (Windows Terminal does
// exactly this). Ctrl+Shift+C / Ctrl+Insert copy unconditionally where the
// browser lets them through — Chrome keeps Ctrl+Shift+C for DevTools.
function copySelection(term) {
  const text = term.getSelection();
  if (!text) return false;
  navigator.clipboard?.writeText(text).catch(() => { /* denied; selection stays */ });
  term.clearSelection();
  return true;
}

// The keyboard route into paste, for when the app has swallowed Ctrl+V or the
// pointer is nowhere near the card. Reading the clipboard needs a permission
// Chrome asks for once; if it is refused, plain Ctrl+V still works.
function pasteClipboard(term) {
  navigator.clipboard?.readText()
    .then((text) => { if (text) term.paste(text); })
    .catch(() => { /* no permission — Ctrl+V is unaffected */ });
}

// On a Mac the copy key is Cmd, and with the WebGL renderer the browser cannot
// see the terminal's selection, so a bare Cmd+C would copy nothing at all
// unless we handle it here. Cmd+V still reaches xterm's own paste listener.
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function termKeyEvent(term, e) {
  if (isRepaintKey(e)) return false; // redraw, do not type it
  if (MAC && e.metaKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
    copySelection(term);
    e.preventDefault();
    return false;
  }
  if (e.type !== 'keydown' || e.altKey || !(e.ctrlKey || e.shiftKey)) return true;
  const k = e.key.toLowerCase();
  const copy = (e.ctrlKey && e.shiftKey && k === 'c') || (e.ctrlKey && k === 'insert');
  const paste = (e.ctrlKey && e.shiftKey && k === 'v') || (e.shiftKey && k === 'insert');
  if (copy) { copySelection(term); e.preventDefault(); return false; }
  if (paste) { pasteClipboard(term); e.preventDefault(); return false; }
  // Bare Ctrl+C: copy if there is something selected, otherwise let it through
  // as the interrupt it normally is.
  if (e.ctrlKey && !e.shiftKey && k === 'c' && term.hasSelection()) {
    copySelection(term);
    e.preventDefault();
    return false;
  }
  return true;
}

function applyCardColors(entry) {
  const color = projectColor(entry.data.projectId);
  entry.el.style.setProperty('--proj', color);
  const tag = $('.proj-tag', entry.el);
  const p = project(entry.data.projectId);
  tag.hidden = !p;
  if (p) tag.textContent = p.name;
}

function positionCard(entry) {
  const { x, y, w, h } = entry.data;
  Object.assign(entry.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
}

function renderStatus(entry) {
  const info = displayStatus(entry.data);
  entry.el.dataset.status = info.key;
  $('.badge', entry.el).textContent = info.label;
  const note = $('.note-strip', entry.el);
  note.hidden = !(entry.data.status === 'needs-you' && entry.data.note);
  if (!note.hidden) note.textContent = entry.data.note;
  // A card with no process behind it can be restarted but not killed.
  const dead = entry.data.status === 'offline' || entry.data.status === 'done';
  const restore = $('[data-action="restore"]', entry.el);
  restore.hidden = !dead;
  restore.title = entry.data.canResume
    ? 'restart and resume this conversation'
    : 'restart this session';
  $('[data-action="kill"]', entry.el).hidden = dead;
}

function raise(entry) {
  entry.el.style.zIndex = ++state.zTop;
  for (const e of state.sessions.values()) e.el.classList.toggle('active', e === entry);
}

// Telling the pty its new size is the expensive half of a resize: the agent
// redraws its entire screen on every one, and a drag handle that fires sixty
// times a second produces sixty interleaved redraws — which is what leaves a
// card full of repeated and half-overwritten lines. xterm refits live so the
// card looks right while you drag; the pty only ever hears the size you land on.
const PTY_SETTLE_MS = 160;

function pushGeometry(entry, immediate) {
  if (!entry.term || !entry.el.isConnected) return;
  clearTimeout(entry.geoTimer);
  const flush = () => {
    entry.geoTimer = 0;
    const { term, data } = entry;
    if (!term || !entry.el.isConnected) return;
    if (entry.sentCols === term.cols && entry.sentRows === term.rows
      && entry.sentW === data.w && entry.sentH === data.h) return;
    entry.sentCols = term.cols; entry.sentRows = term.rows;
    entry.sentW = data.w; entry.sentH = data.h;
    send({ type: 'resize', id: data.id, cols: term.cols, rows: term.rows, w: data.w, h: data.h });
  };
  if (immediate) flush();
  else entry.geoTimer = setTimeout(flush, PTY_SETTLE_MS);
}

function fitNow(entry) {
  if (!entry.fit || !entry.el.isConnected) return;
  if (!termVisible(entry)) return;   // measuring a hidden card yields nonsense
  try { entry.fit.fit(); } catch { return; }
  pushGeometry(entry, true);
}
function fitSoon(entry) {
  clearTimeout(entry.fitTimer);
  entry.fitTimer = setTimeout(() => fitNow(entry), 120);
}

function termVisible(entry) {
  const body = entry.el.isConnected && $('.term-body', entry.el);
  return !!(body && body.clientWidth && body.clientHeight);
}

// A terminal on a hidden card measures itself as zero and then stops noticing.
// xterm caches the viewport height it last measured and only re-syncs the scroll
// area when that number changes, so a card hidden by a workspace switch (or one
// whose terminal opened while its project was not on screen) comes back with a
// scroll area that cannot reach the bottom — the prompt is there, you just can't
// scroll to it, and nudging the card's size by a pixel fixes it. This is that
// nudge, done deliberately at the moment the card gets its size back.
function remeasure(entry, force) {
  const { term, fit } = entry;
  if (!term || !fit || !entry.el.isConnected) return;
  if (!termVisible(entry)) { entry.staleSize = true; return; }
  const stale = force || entry.staleSize;
  entry.staleSize = false;
  const before = { cols: term.cols, rows: term.rows };
  try {
    fit.fit();
    if (stale && term.cols === before.cols && term.rows === before.rows) syncScrollArea(term);
    term.refresh(0, term.rows - 1);
    if (stale) settleBottom(entry);
  } catch { return; }   // card is mid-teardown
  // A repair is worth telling the pty about at once; a plain drag is not.
  pushGeometry(entry, !!stale);
}

// xterm only recomputes the scrollable height when the height it measured
// changes, so a card that comes back at exactly the size it left at keeps the
// zero-height scroll area it cached while hidden. Asking the viewport to re-sync
// is the direct fix, and it touches nothing else. The old cure — grow the
// terminal by a row and shrink it back — reflows the entire scrollback twice to
// provoke the same call, so it is only the fallback now, and it is skipped on
// the alternate screen, which has no scrollback to sync in the first place.
function syncScrollArea(term) {
  try {
    const vp = term._core?.viewport || term._core?._viewport;
    if (vp && typeof vp.syncScrollArea === 'function') { vp.syncScrollArea(true); return; }
  } catch { /* internals moved; fall through */ }
  if (term.buffer.active.type === 'alternate') return;
  const rows = term.rows;
  try {
    term.resize(term.cols, rows + 1);
    term.resize(term.cols, rows);
  } catch { /* absurd geometry */ }
}

// Setting scrollTop on a display:none element silently does nothing, but xterm
// caches the value it *tried* to set. Once the card is visible again the cache
// matches what it wants, so it never scrolls, and the terminal sits pinned at
// the top of a buffer it thinks it is at the bottom of. Move the real element,
// and do it again over the next couple of frames, because the scroll area keeps
// growing as the viewport catches up with the buffer.
function settleBottom(entry) {
  const go = () => {
    try {
      entry.term?.scrollToBottom();
      const vp = $('.xterm-viewport', entry.el);
      if (vp) vp.scrollTop = vp.scrollHeight;
    } catch { /* card is gone */ }
  };
  go();
  requestAnimationFrame(go);
  clearTimeout(entry.bottomTimer);
  entry.bottomTimer = setTimeout(go, 90);
}

// ResizeObserver fires on the display:none -> visible transition too, which is
// exactly the case fitSoon() never covered.
function watchTermSize(entry) {
  const body = $('.term-body', entry.el);
  entry.ro = new ResizeObserver(() => {
    const w = body.clientWidth, h = body.clientHeight;
    if (!w || !h) { entry.staleSize = true; return; }
    // Coming back from hidden usually restores the exact same size, so an
    // unchanged size is not a reason to skip the repair — only a reason to skip
    // the plain refit.
    if (w === entry.lastW && h === entry.lastH && !entry.staleSize) return;
    entry.lastW = w; entry.lastH = h;
    cancelAnimationFrame(entry.roFrame);
    entry.roFrame = requestAnimationFrame(() => remeasure(entry));
  });
  entry.ro.observe(body);
}

function focusSession(id) {
  const entry = state.sessions.get(String(id));
  if (!entry) return;
  // Jumping to a card in another project means going to that workspace first.
  if (!inWorkspace(entry.data.projectId)) selectProject(entry.data.projectId);
  const r = viewport.getBoundingClientRect();
  const { x, y, w, h } = entry.data;
  state.cam.x = r.width / 2 - (x + w / 2) * state.cam.z;
  state.cam.y = r.height / 2 - (y + h / 2) * state.cam.z;
  applyCamera();
  raise(entry);
  entry.term?.focus();
}

function wireCard(entry) {
  const { el, data } = entry;
  const head = $('.card-head', el);

  el.addEventListener('pointerdown', () => raise(entry));

  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input')) return;
    e.preventDefault();
    const start = { px: e.clientX, py: e.clientY, x: data.x, y: data.y };
    head.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      data.x = start.x + (ev.clientX - start.px) / state.cam.z;
      data.y = start.y + (ev.clientY - start.py) / state.cam.z;
      positionCard(entry);
      layoutMinis(data.id);
      renderEdges();
      const now = performance.now();
      if (now - entry.lastMoveSent > 90) {
        entry.lastMoveSent = now;
        send({ type: 'move', id: data.id, x: data.x, y: data.y });
      }
    };
    const onUp = () => {
      head.removeEventListener('pointermove', onMove);
      head.removeEventListener('pointerup', onUp);
      send({ type: 'move', id: data.id, x: data.x, y: data.y });
      // Attachments follow the card during the drag and re-settle into clear
      // space once it lands — resolving collisions mid-drag just makes them hop.
      layoutAllAttachments();
    };
    head.addEventListener('pointermove', onMove);
    head.addEventListener('pointerup', onUp);
  });

  $('.resize-handle', el).addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.target;
    const start = { px: e.clientX, py: e.clientY, w: data.w, h: data.h };
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      data.w = Math.max(MIN_W, start.w + (ev.clientX - start.px) / state.cam.z);
      data.h = Math.max(MIN_H, start.h + (ev.clientY - start.py) / state.cam.z);
      positionCard(entry);
      layoutMinis(data.id);
      renderEdges();
      fitSoon(entry);
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      fitNow(entry);
      layoutAllAttachments();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });

  $('.card-title', el).addEventListener('dblclick', () => {
    const h = $('.card-title', el);
    const input = document.createElement('input');
    input.value = data.title;
    h.textContent = '';
    h.appendChild(input);
    input.focus();
    input.select();
    const commit = () => {
      const title = input.value.trim() || data.title;
      h.textContent = title;
      if (title !== data.title) send({ type: 'rename', id: data.id, title });
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') { input.value = data.title; input.blur(); }
    });
  });

  $('[data-action="kill"]', el).addEventListener('click', () => send({ type: 'kill', id: data.id }));
  $('[data-action="restore"]', el).addEventListener('click', () => send({ type: 'restore', id: data.id }));
  $('[data-action="close"]', el).addEventListener('click', () => {
    const live = data.status !== 'done' && data.status !== 'offline';
    if (live && !confirm(`Close "${data.title}" and kill its process?`)) return;
    send({ type: 'close', id: data.id });
    removeSession(String(data.id));
  });
}

// ---------------------------------------------------------------- subagent minis
function addMini(data) {
  if (state.minis.has(data.id)) return;
  const el = $('#mini-template').content.firstElementChild.cloneNode(true);
  canvas.appendChild(el);
  el.dataset.status = data.status;
  $('.mini-type', el).textContent = data.type;
  $('.mini-title', el).textContent = data.title;
  $('.elapsed', el).dataset.start = data.startedAt;
  if (data.endedAt) $('.elapsed', el).dataset.end = data.endedAt;
  const parent = state.sessions.get(String(data.parentId));
  el.style.setProperty('--proj', parent ? projectColor(parent.data.projectId) : '#3a3a42');
  state.minis.set(data.id, { data, el });
  layoutMinis(data.parentId);
  renderEdges();
}

function minisOf(parentId) {
  return [...state.minis.values()]
    .filter((m) => m.data.parentId === parentId)
    .sort((a, b) => a.data.startedAt - b.data.startedAt);
}

// Attached nodes (subagent minis, browser cards) sit beside their terminal, but
// "beside" is only a preference: a canvas with several cards on it will happily
// put that spot underneath a neighbour. Everything below searches outward from
// the preferred spot until it finds air, so an attachment is never buried.
const SLOT_PAD = 16;      // breathing room counted as part of an obstacle
const SLOT_ROW = 40;      // vertical probe step
const SLOT_COLS = 8;      // how many columns out to try before giving up
const SLOT_ROWS = 24;     // how many vertical probes per column

function rectsOverlap(a, o) {
  return a.x < o.x + o.w + SLOT_PAD && o.x < a.x + a.w + SLOT_PAD
      && a.y < o.y + o.h + SLOT_PAD && o.y < a.y + a.h + SLOT_PAD;
}

// Everything currently taking up room on this workspace. `exclude` drops the
// attachment being placed, so it never collides with where it used to be.
function occupiedRects(exclude = {}) {
  const out = [];
  for (const { data: d, el } of state.sessions.values()) {
    if (!el.hidden) out.push({ x: d.x, y: d.y, w: d.w, h: d.h });
  }
  for (const v of state.viewers.values()) {
    if (!v.el.hidden) out.push({ x: v.x, y: v.y, w: v.w, h: v.h });
  }
  for (const { data: d, el } of state.notes.values()) {
    if (!el.hidden) out.push({ x: d.x, y: d.y, w: d.w, h: d.h });
  }
  for (const m of state.minis.values()) {
    if (m.el.hidden || m.x == null) continue;
    if (String(m.data.parentId) === String(exclude.minisOf)) continue;
    out.push({ x: m.x, y: m.y, w: MINI_W, h: MINI_H });
  }
  for (const b of state.browsers.values()) {
    if (b.el.hidden || b.x == null) continue;
    if (b.sessionId === String(exclude.browserOf)) continue;
    out.push({ x: b.x, y: b.y, w: BROWSER_W, h: b.el.offsetHeight || 120 });
  }
  return out;
}

// Probe a grid of candidate spots away from the terminal (dir +1 right, -1
// left) and keep the clear one nearest the preferred spot. Ranking by distance
// rather than taking the first hit matters: scanning a column top to bottom
// finds air hundreds of pixels above the parent long before it tries the next
// column over, and a stack floating off in space reads as unrelated to its card.
function freeSlot(pref, w, h, obstacles, dir) {
  const colStep = w + 60;
  let best = null;
  let bestCost = Infinity;
  for (let col = 0; col < SLOT_COLS; col++) {
    const dx = dir * col * colStep;
    // A column further out than the best distance so far cannot beat it.
    if (Math.abs(dx) >= bestCost) break;
    for (let k = 0; k < SLOT_ROWS; k++) {
      const dy = (k === 0 ? 0 : (k % 2 ? Math.ceil(k / 2) : -(k / 2))) * SLOT_ROW;
      const cost = Math.hypot(dx, dy);
      if (cost >= bestCost) continue;
      const cand = { x: pref.x + dx, y: pref.y + dy, w, h };
      if (obstacles.some((o) => rectsOverlap(cand, o))) continue;
      best = cand;
      bestCost = cost;
      if (cost === 0) return cand;
    }
  }
  return best || { x: pref.x, y: pref.y };   // canvas packed; fall back to ideal
}

function layoutMinis(parentId) {
  const parent = state.sessions.get(String(parentId));
  if (!parent) return;
  const list = minisOf(parentId);
  if (list.length) {
    // Place the stack as one block so a parent's subagents stay together.
    const stackH = list.length * MINI_H + (list.length - 1) * MINI_GAP;
    const pref = { x: parent.data.x + parent.data.w + 110, y: parent.data.y + 6 };
    const spot = freeSlot(pref, MINI_W, stackH, occupiedRects({ minisOf: parentId }), 1);
    list.forEach((m, i) => {
      m.x = spot.x;
      m.y = spot.y + i * (MINI_H + MINI_GAP);
      Object.assign(m.el.style, { left: `${m.x}px`, top: `${m.y}px` });
    });
  }
  const b = state.browsers.get(String(parentId));
  if (b) layoutBrowserCard(b);
}

// Re-place every attachment on the workspace. Called after a card settles from
// a drag or resize, so nodes shuffle out of the way instead of being sat on.
function layoutAllAttachments() {
  for (const id of state.sessions.keys()) layoutMinis(id);
  renderEdges();
}

// ---------------------------------------------------------------- file viewer cards
const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', json: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', md: 'markdown', markdown: 'markdown',
  py: 'python', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  sh: 'bash', bash: 'bash', zsh: 'bash', envrc: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', env: 'ini', conf: 'ini',
  sql: 'sql', rs: 'rust', go: 'go', java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
  diff: 'diff', patch: 'diff', txt: 'plaintext', log: 'plaintext', lock: 'json',
};
let viewerSeq = 1;

async function openFileViewer(fullPath, name, saved) {
  for (const v of state.viewers.values()) {
    if (v.path === fullPath && inWorkspace(v.projectId)) {
      raiseViewer(v); centerOnViewer(v); return;
    }
  }
  let j;
  try { j = await api(`/api/fs/read?path=${encodeURIComponent(fullPath)}`); }
  catch (err) {
    // A restored viewer whose file has since moved should just drop out.
    if (!saved) alert(`Can't open ${name}: ${err.message}`);
    if (saved) saveViewers();
    return;
  }

  const el = $('#viewer-template').content.firstElementChild.cloneNode(true);
  canvas.appendChild(el);
  const c = viewportCenter();
  const pt = screenToCanvas(c.sx, c.sy);
  const n = state.viewers.size;
  const v = {
    id: 'v' + viewerSeq++, path: fullPath, el,
    projectId: state.selectedProject || null,
    x: saved?.x ?? pt.x - 340 + (n % 4) * 38,
    y: saved?.y ?? pt.y - 250 + (n % 4) * 38,
    w: saved?.w ?? 680, h: saved?.h ?? 500,
  };
  state.viewers.set(v.id, v);

  $('.viewer-title', el).textContent = name;
  $('.viewer-icon', el).src = fileIconSrc(name, false, false);
  $('.viewer-path', el).textContent = fullPath;
  $('.viewer-path', el).title = fullPath;

  const content = j.content.replace(/\r\n/g, '\n');
  const lineCount = content.split('\n').length;
  const code = $('.viewer-code code', el);
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : name.toLowerCase();
  const lang = LANG_BY_EXT[ext] || null;
  let langLabel = 'text';
  try {
    if (window.hljs && lang && hljs.getLanguage(lang)) {
      code.innerHTML = hljs.highlight(content, { language: lang }).value;
      langLabel = lang;
    } else if (window.hljs && content.length < 120_000) {
      const auto = hljs.highlightAuto(content);
      code.innerHTML = auto.value;
      langLabel = auto.language || 'text';
    } else {
      code.textContent = content;
    }
  } catch { code.textContent = content; }
  $('.viewer-lang', el).textContent = langLabel;
  $('.viewer-meta', el).textContent = `${lineCount} lines · ${fmtBytes(j.size)}`;
  $('.viewer-gutter', el).textContent = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n');

  positionViewer(v);
  wireViewer(v);
  raiseViewer(v);
  saveViewers();
}

// File viewers are just a path plus a rectangle, so the browser can remember
// which ones each workspace had open and put them back.
const viewerKey = (pid) => `kiln.viewers.${pid || '_none'}`;
function saveViewers() {
  const list = [...state.viewers.values()]
    .filter((v) => inWorkspace(v.projectId))
    .map((v) => ({ path: v.path, x: v.x, y: v.y, w: v.w, h: v.h }));
  try { localStorage.setItem(viewerKey(state.selectedProject), JSON.stringify(list)); }
  catch { /* storage full; viewers are the least of it */ }
}
async function restoreViewers() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(viewerKey(state.selectedProject))) || []; }
  catch { return; }
  const pid = state.selectedProject;
  for (const item of list.slice(0, 12)) {
    if (state.selectedProject !== pid) return; // switched away mid-restore
    const already = [...state.viewers.values()]
      .some((v) => v.path === item.path && inWorkspace(v.projectId));
    if (already) continue;
    await openFileViewer(item.path, item.path.split(/[\\/]/).pop(), item);
  }
}

function positionViewer(v) {
  Object.assign(v.el.style, { left: `${v.x}px`, top: `${v.y}px`, width: `${v.w}px`, height: `${v.h}px` });
}
function raiseViewer(v) { v.el.style.zIndex = ++state.zTop; }
function centerOnViewer(v) {
  const r = viewport.getBoundingClientRect();
  state.cam.x = r.width / 2 - (v.x + v.w / 2) * state.cam.z;
  state.cam.y = r.height / 2 - (v.y + v.h / 2) * state.cam.z;
  applyCamera();
}
function closeViewer(v) {
  v.el.remove();
  state.viewers.delete(v.id);
  saveViewers();
}

function wireViewer(v) {
  const { el } = v;
  el.addEventListener('pointerdown', () => raiseViewer(v));
  const head = $('.viewer-head', el);
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const start = { px: e.clientX, py: e.clientY, x: v.x, y: v.y };
    head.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      v.x = start.x + (ev.clientX - start.px) / state.cam.z;
      v.y = start.y + (ev.clientY - start.py) / state.cam.z;
      positionViewer(v);
    };
    const onUp = () => {
      head.removeEventListener('pointermove', onMove);
      head.removeEventListener('pointerup', onUp);
      saveViewers();
    };
    head.addEventListener('pointermove', onMove);
    head.addEventListener('pointerup', onUp);
  });
  $('.resize-handle', el).addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.target;
    const start = { px: e.clientX, py: e.clientY, w: v.w, h: v.h };
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      v.w = Math.max(360, start.w + (ev.clientX - start.px) / state.cam.z);
      v.h = Math.max(220, start.h + (ev.clientY - start.py) / state.cam.z);
      positionViewer(v);
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      saveViewers();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
  $('[data-action="close"]', el).addEventListener('click', () => closeViewer(v));
}

// ---------------------------------------------------------------- browser activity cards
// When an agent drives a browser (claude-in-chrome MCP tools), hook telemetry
// mirrors it here: latest screenshot, recent actions, and a jump-out button.
const BROWSER_W = 380;

function ensureBrowserCard(entry, lastTs) {
  let b = state.browsers.get(String(entry.data.id));
  if (b) return b;
  const el = $('#browser-template').content.firstElementChild.cloneNode(true);
  canvas.appendChild(el);
  b = { sessionId: String(entry.data.id), el, lastUrl: null };
  state.browsers.set(b.sessionId, b);
  el.style.setProperty('--proj', projectColor(entry.data.projectId));
  $('.elapsed', el).dataset.start = lastTs || Date.now();
  $('[data-action="open"]', el).addEventListener('click', () => {
    if (!b.lastUrl) return;
    api('/api/open-url', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: b.lastUrl }),
    }).catch((err) => alert(err.message));
  });
  layoutBrowserCard(b);
  renderEdges();
  return b;
}

function pushBrowserAction(b, action) {
  const ul = $('.bcard-actions', b.el);
  const li = document.createElement('li');
  li.textContent = action.summary;
  li.title = action.summary;
  ul.prepend(li);
  while (ul.children.length > 4) ul.lastElementChild.remove();
  $('.elapsed', b.el).dataset.start = action.ts;
}

function renderBrowserHead(b) {
  let host = 'browser';
  try { if (b.lastUrl) host = new URL(b.lastUrl).host; } catch { /* keep default */ }
  $('.bcard-host', b.el).textContent = host;
  $('[data-action="open"]', b.el).hidden = !b.lastUrl;
}

function setBrowserShot(b, shot) {
  const wrap = $('.bcard-shot', b.el);
  wrap.hidden = false;
  $('img', wrap).src = shot;
  layoutBrowserCard(b);
}

function layoutBrowserCard(b) {
  const parent = state.sessions.get(b.sessionId);
  if (!parent) return;
  const pref = { x: parent.data.x - BROWSER_W - 110, y: parent.data.y + 6 };
  const h = b.el.offsetHeight || 200;
  const spot = freeSlot(pref, BROWSER_W, h, occupiedRects({ browserOf: b.sessionId }), -1);
  b.x = spot.x;
  b.y = spot.y;
  Object.assign(b.el.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${BROWSER_W}px` });
}

function removeBrowserCard(sessionId) {
  const b = state.browsers.get(sessionId);
  if (!b) return;
  b.el.remove();
  state.browsers.delete(sessionId);
  renderEdges();
}

function restoreBrowser(entry) {
  const snap = entry.data.browser;
  if (!snap) return;
  const b = ensureBrowserCard(entry, snap.lastTs);
  b.lastUrl = snap.lastUrl;
  for (const a of [...(snap.actions || [])].reverse()) pushBrowserAction(b, a);
  if (snap.shot) setBrowserShot(b, snap.shot);
  renderBrowserHead(b);
}

// ---------------------------------------------------------------- note cards
// Rich-text scratchpads that persist server-side (data/notes.json) as HTML.
// Notes written before the editor existed hold markdown in `content`; they are
// converted on the way in and rewritten as HTML the first time they are edited.
function mdRender(text) {
  const esc = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  try { return marked.parse(esc, { gfm: true, breaks: true }); }
  catch { return `<pre>${esc}</pre>`; }
}

// Everything that lands in a note goes through here: the editor's own output,
// anything pasted into it, and markdown converted from a legacy note. Tags
// outside the list are unwrapped (their text survives) and every attribute is
// dropped except the handful the formatting actually needs.
const NOTE_OK = new Set([
  'P', 'BR', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL',
  'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'HR',
  'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'FONT',
]);
const NOTE_DROP = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'SVG', 'MATH',
  'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'AUDIO', 'VIDEO', 'IMG',
]);
const NOTE_HREF = /^(https?:|mailto:|#|\/)/i;
// Tags, not inline styles: <b>/<i>/<u> survive the sanitizer, style= does not.
try { document.execCommand('styleWithCSS', false, false); } catch { /* older engines */ }

function sanitizeNoteHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  const clean = (parent) => {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === 3) continue;                       // text
      if (node.nodeType !== 1) { node.remove(); continue; }    // comments etc.
      if (NOTE_DROP.has(node.tagName)) { node.remove(); continue; }
      clean(node);
      if (!NOTE_OK.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        const ok = (node.tagName === 'A' && name === 'href' && NOTE_HREF.test(attr.value.trim()))
          || name === 'colspan' || name === 'rowspan';
        if (!ok) node.removeAttributeNode(attr);
      }
    }
  };
  clean(tpl.content);
  return tpl.innerHTML;
}

// One source of truth per note: `html` if it has ever been edited, otherwise the
// legacy markdown converted on the fly.
function noteHtml(data) {
  if (typeof data.html === 'string' && data.html.trim()) return sanitizeNoteHtml(data.html);
  if (data.content && data.content.trim()) return sanitizeNoteHtml(mdRender(data.content));
  return '';
}
function noteIsBlank(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  return !tpl.content.textContent.replace(/[\s\u00a0]/g, '') && !$('hr, table', tpl.content);
}

function addNote(data, startEditing) {
  if (state.notes.has(data.id)) return;
  const el = $('#note-template').content.firstElementChild.cloneNode(true);
  canvas.appendChild(el);
  const n = { data, el, saveTimer: 0, lastMoveSent: 0 };
  state.notes.set(data.id, n);
  renderNote(n);
  positionNote(n);
  wireNote(n);
  raiseNote(n);
  if (startEditing) enterNoteEdit(n);
}

function renderNote(n) {
  const { data, el } = n;
  $('.note-title', el).textContent = data.title;
  const render = $('.note-render', el);
  const html = noteHtml(data);
  if (html) {
    render.innerHTML = html;
    for (const a of $$('a', render)) { a.target = '_blank'; a.rel = 'noopener'; }
  } else {
    render.innerHTML = '<p class="note-empty">nothing yet</p>';
  }
  $('.note-meta', el).textContent = `edited ${fmtAgo(data.updatedAt)}`;
}

function positionNote(n) {
  const { x, y, w, h } = n.data;
  Object.assign(n.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
}
function raiseNote(n) { n.el.style.zIndex = ++state.zTop; }

// Editing happens in place: the same element that renders the note becomes
// contenteditable, so text does not reflow when you start typing.
function enterNoteEdit(n) {
  if (state.editingNote && state.editingNote !== n) exitNoteEdit(state.editingNote);
  if (n.el.classList.contains('editing')) return;
  const render = $('.note-render', n.el);
  if (!noteHtml(n.data)) render.innerHTML = '<p><br></p>';
  n.el.classList.add('editing');
  $('.note-tools', n.el).hidden = false;
  render.contentEditable = 'true';
  render.spellcheck = true;
  state.editingNote = n;
  render.focus();
  const sel = getSelection();
  if (sel && !render.contains(sel.anchorNode)) {
    const r = document.createRange();
    r.selectNodeContents(render);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  syncNoteTools(n);
}

function exitNoteEdit(n, save = true) {
  const render = $('.note-render', n.el);
  if (save) saveNoteHtml(n, true);
  render.contentEditable = 'false';
  render.spellcheck = false;
  n.el.classList.remove('editing');
  $('.note-tools', n.el).hidden = true;
  if (state.editingNote === n) state.editingNote = null;
  renderNote(n);
}

function saveNoteHtml(n, now = false) {
  clearTimeout(n.saveTimer);
  const write = () => {
    const raw = $('.note-render', n.el).innerHTML;
    const html = noteIsBlank(raw) ? '' : sanitizeNoteHtml(raw);
    if (html === (n.data.html || '') && !n.data.content) return;
    n.data.html = html;
    n.data.content = '';   // the HTML is the source of truth from here on
    n.data.updatedAt = Date.now();
    send({ type: 'updateNote', noteId: n.data.id, html, content: '' });
  };
  now ? write() : (n.saveTimer = setTimeout(write, 700));
}

// ------------------------------------------------- note formatting toolbar
const NOTE_BLOCKS = ['p', 'h1', 'h2', 'h3', 'blockquote', 'pre'];

function noteCmd(n, cmd, arg) {
  const render = $('.note-render', n.el);
  render.focus();
  if (cmd === 'inlineCode') toggleInlineCode(render);
  else if (cmd === 'createLink') {
    const sel = getSelection();
    if (!sel || sel.isCollapsed) return;
    const url = prompt('Link to:', 'https://');
    if (url === null) return;
    if (!url.trim()) document.execCommand('unlink');
    else if (NOTE_HREF.test(url.trim())) document.execCommand('createLink', false, url.trim());
  } else if (cmd === 'formatBlock') {
    document.execCommand('formatBlock', false, `<${arg}>`);
  } else {
    document.execCommand(cmd, false, arg);
  }
  stripNoteStyles(render);
  saveNoteHtml(n);
  syncNoteTools(n);
}

// execCommand has no inline-code command, so wrap or unwrap the selection here.
function toggleInlineCode(render) {
  const sel = getSelection();
  if (!sel || !sel.rangeCount) return;
  const inCode = closestTag(sel.anchorNode, 'CODE', render);
  if (inCode && !closestTag(sel.anchorNode, 'PRE', render)) {
    inCode.replaceWith(...inCode.childNodes);
    return;
  }
  if (sel.isCollapsed) return;
  const text = sel.toString();
  document.execCommand('insertHTML', false,
    `<code>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code>`);
}

// insertHTML re-decorates whatever it inserts with the computed styles of the
// spot it landed in ("font-size: 13px"), which then fights the note's own CSS.
// The sanitizer drops those on save; this drops them while you are still typing.
function stripNoteStyles(render) {
  for (const el of $$('[style], [class], [id]', render)) {
    el.removeAttribute('style');
    el.removeAttribute('class');
    el.removeAttribute('id');
  }
}

function closestTag(node, tag, stop) {
  let el = node && node.nodeType === 1 ? node : node?.parentElement;
  while (el && el !== stop) {
    if (el.tagName === tag) return el;
    el = el.parentElement;
  }
  return null;
}

function currentNoteBlock(render) {
  const sel = getSelection();
  let el = sel?.anchorNode;
  el = el && el.nodeType === 1 ? el : el?.parentElement;
  while (el && el !== render) {
    const t = el.tagName.toLowerCase();
    if (NOTE_BLOCKS.includes(t)) return t;
    if (t === 'li') return 'p';
    el = el.parentElement;
  }
  return 'p';
}

function syncNoteTools(n) {
  const tools = $('.note-tools', n.el);
  if (tools.hidden) return;
  for (const b of $$('.nt[data-cmd]', tools)) {
    let on = false;
    try { on = document.queryCommandState(b.dataset.cmd); } catch { /* custom cmd */ }
    if (b.dataset.cmd === 'inlineCode') {
      on = !!closestTag(getSelection()?.anchorNode, 'CODE', $('.note-render', n.el));
    }
    b.classList.toggle('on', !!on);
  }
  $('.nt-block', tools).value = currentNoteBlock($('.note-render', n.el));
}

document.addEventListener('selectionchange', () => {
  const n = state.editingNote;
  if (n) syncNoteTools(n);
});

function wireNote(n) {
  const { el, data } = n;
  el.addEventListener('pointerdown', () => raiseNote(n));

  const head = $('.note-head', el);
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input')) return;
    e.preventDefault();
    const start = { px: e.clientX, py: e.clientY, x: data.x, y: data.y };
    head.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      data.x = start.x + (ev.clientX - start.px) / state.cam.z;
      data.y = start.y + (ev.clientY - start.py) / state.cam.z;
      positionNote(n);
      const now = performance.now();
      if (now - n.lastMoveSent > 90) {
        n.lastMoveSent = now;
        send({ type: 'moveNote', noteId: data.id, x: data.x, y: data.y });
      }
    };
    const onUp = () => {
      head.removeEventListener('pointermove', onMove);
      head.removeEventListener('pointerup', onUp);
      send({ type: 'moveNote', noteId: data.id, x: data.x, y: data.y });
    };
    head.addEventListener('pointermove', onMove);
    head.addEventListener('pointerup', onUp);
  });

  $('.resize-handle', el).addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.target;
    const start = { px: e.clientX, py: e.clientY, w: data.w, h: data.h };
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      data.w = Math.max(280, start.w + (ev.clientX - start.px) / state.cam.z);
      data.h = Math.max(190, start.h + (ev.clientY - start.py) / state.cam.z);
      positionNote(n);
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      send({ type: 'moveNote', noteId: data.id, w: data.w, h: data.h });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });

  $('.note-title', el).addEventListener('dblclick', () => {
    const h = $('.note-title', el);
    const input = document.createElement('input');
    input.value = data.title;
    h.textContent = '';
    h.appendChild(input);
    input.focus();
    input.select();
    const commit = () => {
      const title = input.value.trim() || data.title;
      h.textContent = title;
      if (title !== data.title) {
        data.title = title;
        send({ type: 'updateNote', noteId: data.id, title });
      }
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') { input.value = data.title; input.blur(); }
    });
  });

  const render = $('.note-render', el);
  render.addEventListener('input', () => saveNoteHtml(n));
  render.addEventListener('blur', () => {
    // Clicking a toolbar button blurs the editor; that must not close it.
    if (el.contains(document.activeElement)) return;
    if (el.classList.contains('editing')) exitNoteEdit(n);
  });
  render.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (!el.classList.contains('editing')) return;
    if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey))) {
      ev.preventDefault();
      exitNoteEdit(n);
      return;
    }
    if (ev.key === 'Tab') {
      ev.preventDefault();
      noteCmd(n, ev.shiftKey ? 'outdent' : 'indent');
      return;
    }
    if (!(ev.ctrlKey || ev.metaKey)) return;
    // Digits come from ev.code, because shift+7 arrives as "&" and alt+1 as
    // whatever the layout decides — the physical key is the stable thing.
    const digit = /^Digit(\d)$/.exec(ev.code)?.[1];
    const k = ev.key.toLowerCase();
    if (k === 'k') { ev.preventDefault(); noteCmd(n, 'createLink'); return; }
    if (ev.altKey && '0123'.includes(digit)) {          // ctrl+alt+1..3, like docs
      ev.preventDefault();
      noteCmd(n, 'formatBlock', digit === '0' ? 'p' : `h${digit}`);
      return;
    }
    if (ev.shiftKey && digit === '7') { ev.preventDefault(); noteCmd(n, 'insertOrderedList'); return; }
    if (ev.shiftKey && digit === '8') { ev.preventDefault(); noteCmd(n, 'insertUnorderedList'); return; }
    // Chrome handles ctrl+B/I/U itself; just persist what it did.
    if ('biu'.includes(k)) {
      setTimeout(() => { stripNoteStyles(render); saveNoteHtml(n); syncNoteTools(n); }, 0);
    }
  });
  // Paste keeps formatting but only the formatting we allow.
  render.addEventListener('paste', (ev) => {
    if (!el.classList.contains('editing')) return;
    const html = ev.clipboardData?.getData('text/html');
    const text = ev.clipboardData?.getData('text/plain') || '';
    ev.preventDefault();
    if (html) document.execCommand('insertHTML', false, sanitizeNoteHtml(html));
    else document.execCommand('insertText', false, text);
    stripNoteStyles(render);
    saveNoteHtml(n);
  });
  render.addEventListener('click', (ev) => {
    if (el.classList.contains('editing')) return;
    if (ev.target.closest('a')) return;   // let links open
    enterNoteEdit(n);
  });

  const tools = $('.note-tools', el);
  // pointerdown, not click: preventing the default keeps the caret where it is.
  tools.addEventListener('pointerdown', (ev) => {
    const b = ev.target.closest('.nt');
    if (!b) return;
    ev.preventDefault();
    noteCmd(n, b.dataset.cmd);
  });
  $('.nt-block', tools).addEventListener('change', (ev) => noteCmd(n, 'formatBlock', ev.target.value));

  $('[data-action="edit"]', el).addEventListener('click', () => {
    el.classList.contains('editing') ? exitNoteEdit(n) : enterNoteEdit(n);
  });
  $('[data-action="close"]', el).addEventListener('click', () => {
    if (!noteIsBlank(noteHtml(data)) && !confirm(`Delete note "${data.title}"?`)) return;
    send({ type: 'removeNote', noteId: data.id });
    if (state.editingNote === n) state.editingNote = null;
    el.remove();
    state.notes.delete(data.id);
  });
}

$('#btn-note').addEventListener('click', () => {
  const c = viewportCenter();
  const pt = screenToCanvas(c.sx, c.sy);
  const k = state.notes.size;
  state.expectNote = true;
  send({
    type: 'addNote', projectId: state.selectedProject,
    x: pt.x - 220 + (k % 4) * 34, y: pt.y - 170 + (k % 4) * 34,
  });
});

// ---------------------------------------------------------------- edges
function renderEdges() {
  const paths = [];
  for (const b of state.browsers.values()) {
    const parent = state.sessions.get(b.sessionId);
    if (!parent || b.x == null || parent.el.hidden) continue;
    const color = projectColor(parent.data.projectId);
    const ax = parent.data.x;
    const ay = parent.data.y + 46;
    const bx = b.x + BROWSER_W;
    const by = b.y + (b.el.offsetHeight ? Math.min(b.el.offsetHeight / 2, 90) : 60);
    const k = Math.max(36, (ax - bx) / 2);
    paths.push(`<path d="M ${ax} ${ay} C ${ax - k} ${ay}, ${bx + k} ${by}, ${bx} ${by}" stroke="${color}"/>`);
  }
  for (const [pid, parent] of state.sessions) {
    const list = minisOf(pid);
    if (!list.length || parent.el.hidden) continue;
    const color = projectColor(parent.data.projectId);
    list.forEach((m, i) => {
      const ax = parent.data.x + parent.data.w;
      const ay = parent.data.y + Math.min(46 + i * 24, parent.data.h - 24);
      const bx = m.x ?? parent.data.x + parent.data.w + 110;
      const by = (m.y ?? parent.data.y) + (m.el.offsetHeight ? m.el.offsetHeight / 2 : 44);
      const k = Math.max(36, (bx - ax) / 2);
      paths.push(`<path d="M ${ax} ${ay} C ${ax + k} ${ay}, ${bx - k} ${by}, ${bx} ${by}" stroke="${color}"/>`);
    });
  }
  edgesSvg.innerHTML = paths.join('');
}

// ---------------------------------------------------------------- world bounds (zoom-to-fit)
// Only what is on this workspace counts, or zoom-to-fit would frame cards from
// a project you cannot even see.
function worldBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { data: d, el } of state.sessions.values()) {
    if (el.hidden) continue;
    minX = Math.min(minX, d.x); minY = Math.min(minY, d.y);
    maxX = Math.max(maxX, d.x + d.w); maxY = Math.max(maxY, d.y + d.h);
  }
  for (const m of state.minis.values()) {
    if (m.x == null || m.el.hidden) continue;
    minX = Math.min(minX, m.x); minY = Math.min(minY, m.y);
    maxX = Math.max(maxX, m.x + MINI_W); maxY = Math.max(maxY, m.y + MINI_H);
  }
  for (const v of state.viewers.values()) {
    if (v.el.hidden) continue;
    minX = Math.min(minX, v.x); minY = Math.min(minY, v.y);
    maxX = Math.max(maxX, v.x + v.w); maxY = Math.max(maxY, v.y + v.h);
  }
  for (const { data: d, el } of state.notes.values()) {
    if (el.hidden) continue;
    minX = Math.min(minX, d.x); minY = Math.min(minY, d.y);
    maxX = Math.max(maxX, d.x + d.w); maxY = Math.max(maxY, d.y + d.h);
  }
  for (const b of state.browsers.values()) {
    if (b.x == null || b.el.hidden) continue;
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + BROWSER_W); maxY = Math.max(maxY, b.y + (b.el.offsetHeight || 120));
  }
  if (minX === Infinity) return null;
  return { minX: minX - 120, minY: minY - 120, maxX: maxX + 120, maxY: maxY + 120 };
}

// ---------------------------------------------------------------- pan & zoom
viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  if (e.target !== viewport && e.target !== canvas && e.target !== edgesSvg) return;
  e.preventDefault();
  viewport.classList.add('panning');
  const start = { px: e.clientX, py: e.clientY, x: state.cam.x, y: state.cam.y };
  viewport.setPointerCapture(e.pointerId);
  const onMove = (ev) => {
    state.cam.x = start.x + (ev.clientX - start.px);
    state.cam.y = start.y + (ev.clientY - start.py);
    applyCamera();
  };
  const onUp = () => {
    viewport.classList.remove('panning');
    viewport.removeEventListener('pointermove', onMove);
    viewport.removeEventListener('pointerup', onUp);
  };
  viewport.addEventListener('pointermove', onMove);
  viewport.addEventListener('pointerup', onUp);
});

function zoomAt(sx, sy, factor) {
  const z = clamp(state.cam.z * factor, 0.2, 1.75);
  const r = viewport.getBoundingClientRect();
  const px = sx - r.left, py = sy - r.top;
  state.cam.x = px - ((px - state.cam.x) / state.cam.z) * z;
  state.cam.y = py - ((py - state.cam.y) / state.cam.z) * z;
  state.cam.z = z;
  applyCamera();
}

viewport.addEventListener('wheel', (e) => {
  if (e.target.closest('.term-body, .viewer-body, .note-body') && !e.ctrlKey) return;
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });

$('#zoom-in').addEventListener('click', () => { const c = viewportCenter(); zoomAt(c.sx, c.sy, 1.2); });
$('#zoom-out').addEventListener('click', () => { const c = viewportCenter(); zoomAt(c.sx, c.sy, 1 / 1.2); });
$('#zoom-reset').addEventListener('click', () => { const c = viewportCenter(); zoomAt(c.sx, c.sy, 1 / state.cam.z); });
$('#zoom-fit').addEventListener('click', () => fitAll());

function fitAll(only) {
  const b = worldBounds();
  if (!b) return;
  let { minX, minY, maxX, maxY } = b;
  if (only) {
    minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
    for (const { data: d } of state.sessions.values()) {
      if (d.projectId !== only) continue;
      minX = Math.min(minX, d.x); minY = Math.min(minY, d.y);
      maxX = Math.max(maxX, d.x + d.w); maxY = Math.max(maxY, d.y + d.h);
    }
    if (minX === Infinity) return;
  }
  const r = viewport.getBoundingClientRect();
  const pad = 70;
  const z = clamp(Math.min((r.width - pad) / (maxX - minX), (r.height - pad) / (maxY - minY), 1), 0.2, 1);
  state.cam.z = z;
  state.cam.x = (r.width - (maxX - minX) * z) / 2 - minX * z;
  state.cam.y = (r.height - (maxY - minY) * z) / 2 - minY * z;
  applyCamera();
}

// ---------------------------------------------------------------- project pills
function selectProject(id) {
  if (state.home) showHome(false);   // picking a desk means leaving the lobby
  if (state.selectedProject === id) return;
  // Park the camera where this workspace was left before moving desks.
  localStorage.setItem(camKey(state.selectedProject), JSON.stringify(state.cam));
  state.selectedProject = id;
  localStorage.setItem('kiln.project', id || '');
  state.cam = loadCam(id);
  applyCamera();
  applyWorkspace();
  restoreViewers();
  renderPills();
  renderFilesPanel();
  updateChrome();
  if (state.drawer === 'memory') openDrawer(state.drawer, true);
}

function renderPills() {
  const nav = $('#project-pills');
  nav.innerHTML = '';
  $('#pill-home').classList.toggle('selected', state.home);
  for (const p of state.projects) {
    const live = liveOf(p.id).length;
    const pill = document.createElement('button');
    pill.className = 'pill' + (!state.home && p.id === state.selectedProject ? ' selected' : '');
    pill.style.setProperty('--pill-color', p.color);
    pill.title = p.path;
    pill.innerHTML = `<span class="dot"></span><span class="name"></span>${live ? `<span class="n">${live}</span>` : ''}`
      + '<span class="pill-x" title="Remove this project">×</span>';
    $('.name', pill).textContent = p.name;
    pill.addEventListener('click', (e) => {
      if (e.target.closest('.pill-x')) { removeProject(p); return; }
      if (!state.home && state.selectedProject === p.id) fitAll(p.id);
      else selectProject(p.id);
    });
    nav.appendChild(pill);
  }
}

function liveOf(projectId) {
  return [...state.sessions.values()]
    .filter((e) => e.data.projectId === projectId && e.data.status !== 'done');
}

// Removing a project closes its terminals and deletes its notes server-side, so
// say so out loud before doing it — this is the one destructive button up here.
function removeProject(p) {
  const cards = [...state.sessions.values()].filter((e) => e.data.projectId === p.id);
  const notes = [...state.notes.values()].filter((n) => n.data.projectId === p.id);
  const bits = [];
  if (cards.length) bits.push(`${cards.length} terminal${cards.length === 1 ? '' : 's'} will be closed`);
  if (notes.length) bits.push(`${notes.length} note${notes.length === 1 ? '' : 's'} will be deleted`);
  const detail = bits.length ? `\n\n${bits.join('\n')}.` : '';
  if (!confirm(`Remove "${p.name}" from kiln?${detail}\n\nThe folder on disk is left alone.`)) return;
  send({ type: 'removeProject', projectId: p.id });
}

// ---------------------------------------------------------------- home screen
// A workspace-independent index of everything running, grouped by project. It
// sits over the canvas instead of replacing it, so terminals never resize.
const homeEl = $('#home');

function showHome(on) {
  state.home = on;
  localStorage.setItem('kiln.home', on ? '1' : '0');
  homeEl.hidden = !on;
  renderPills();
  if (on) renderHome();
}

function renderHome() {
  if (!state.home) return;
  const body = $('#home-body');
  const groups = [
    ...state.projects.map((p) => ({ project: p, entries: sessionsOf(p.id) })),
    { project: null, entries: sessionsOf(null) },
  ].filter((g) => g.entries.length || g.project);

  const live = [...state.sessions.values()].filter((e) => e.data.status !== 'done').length;
  const total = state.sessions.size;
  const counts = [
    state.showStatus ? `${live} running` : null,
    `${total} terminal${total === 1 ? '' : 's'}`,
    `${state.projects.length} project${state.projects.length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  $('#home-summary').textContent = total ? counts.join(' · ') : 'nothing here yet';

  body.innerHTML = '';
  if (!total) {
    const empty = document.createElement('p');
    empty.className = 'home-empty';
    empty.textContent = 'No terminals yet. Pick a project up top, then hit dispatch.';
    body.appendChild(empty);
    return;
  }
  for (const g of groups) {
    if (!g.entries.length && g.project) continue;   // quiet projects stay out of the way
    if (!g.entries.length) continue;
    body.appendChild(homeGroup(g.project, g.entries));
  }
}

// Live first, then by codename, so the thing you are waiting on is at the top.
const HOME_ORDER = ['needs-you', 'running', 'bg-agents', 'ready', 'idle', 'offline', 'done'];
function sessionsOf(projectId) {
  return [...state.sessions.values()]
    .filter((e) => (e.data.projectId || null) === projectId)
    .sort((a, b) => {
      const ra = HOME_ORDER.indexOf(displayStatus(a.data).key === 'failed' ? 'done' : a.data.status);
      const rb = HOME_ORDER.indexOf(displayStatus(b.data).key === 'failed' ? 'done' : b.data.status);
      return ra - rb || String(a.data.codename).localeCompare(String(b.data.codename));
    });
}

function homeGroup(p, entries) {
  const sec = document.createElement('section');
  sec.className = 'home-group';
  if (p) sec.style.setProperty('--proj', p.color);

  const head = document.createElement('header');
  head.className = 'home-group-head';
  head.innerHTML = '<span class="dot"></span><h2></h2><span class="home-count"></span>'
    + '<span class="home-path mono"></span>';
  $('h2', head).textContent = p ? p.name : 'no project';
  const live = entries.filter((e) => e.data.status !== 'done').length;
  $('.home-count', head).textContent = `${live} of ${entries.length} running`;
  $('.home-path', head).textContent = p ? p.path : '';
  if (p) $('.home-path', head).title = p.path;
  sec.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'home-grid';
  for (const e of entries) grid.appendChild(homeTile(e));
  sec.appendChild(grid);
  return sec;
}

function homeTile(entry) {
  const d = entry.data;
  const info = displayStatus(d);
  const tile = document.createElement('button');
  tile.className = 'home-tile';
  tile.dataset.id = d.id;
  tile.dataset.status = info.key;
  tile.title = `${d.cwd || ''}`;
  tile.innerHTML = `
    <span class="ht-head">
      <span class="s-dot"></span>
      <span class="ht-name"></span>
      ${engineIcon(d.engine, 12)}
      <span class="badge"></span>
    </span>
    <span class="ht-title"></span>
    <span class="ht-foot">
      <span class="ht-model mono"></span>
      <span class="elapsed" data-start="${d.startedAt || ''}"${d.status === 'done' ? ' data-end="' + Date.now() + '"' : ''}></span>
    </span>`;
  $('.ht-name', tile).textContent = d.codename || `#${d.id}`;
  $('.badge', tile).textContent = info.label;
  $('.ht-title', tile).textContent =
    state.showStatus && d.status === 'needs-you' && d.note ? d.note : (d.title || '');
  $('.ht-model', tile).textContent = [d.model, d.effort].filter(Boolean).join(' · ');
  tile.addEventListener('click', () => {
    showHome(false);
    focusSession(d.id);
  });
  return tile;
}

$('#pill-home').addEventListener('click', () => showHome(!state.home));

// "+" opens a picker over the projects root; typing a path is the fallback.
const addBtn = $('#pill-add');
let addMenu = null;

function closeAddMenu() {
  if (!addMenu) return;
  addMenu.remove();
  addMenu = null;
  document.removeEventListener('pointerdown', addMenuOutside, true);
}
function addMenuOutside(e) {
  if (addMenu && !addMenu.contains(e.target) && e.target !== addBtn) closeAddMenu();
}

function addMenuManualInput() {
  addMenu.innerHTML = '';
  const input = document.createElement('input');
  input.className = 'mono-input';
  input.style.cssText = 'margin:0;width:300px;';
  input.placeholder = state.projectsRoot
    ? `${state.projectsRoot}${state.projectsRoot.includes('\\') ? '\\' : '/'}folder`
    : 'full path to a folder';
  addMenu.appendChild(input);
  input.focus();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      state.expectProjectAdd = true;
      send({ type: 'addProject', path: input.value.trim() });
      closeAddMenu();
    }
    if (e.key === 'Escape') closeAddMenu();
  });
}

addBtn.addEventListener('click', async () => {
  if (addMenu) return closeAddMenu();
  const menu = document.createElement('div');
  menu.id = 'add-menu';
  menu.style.left = `${addBtn.offsetLeft}px`;
  menu.innerHTML = '<div class="menu-hint">looking around…</div>';
  $('#topbar').appendChild(menu);
  addMenu = menu;
  document.addEventListener('pointerdown', addMenuOutside, true);

  let root = '';
  let dirs = [];
  try { ({ root, dirs } = await api('/api/projects/available')); } catch { /* menu shows fallback */ }
  if (root) state.projectsRoot = root;
  if (menu !== addMenu) return; // closed while loading

  menu.innerHTML = '';
  const hint = document.createElement('div');
  hint.className = 'menu-hint mono';
  hint.textContent = root;
  hint.title = root;
  menu.appendChild(hint);

  if (dirs.length) {
    for (const d of dirs) {
      const b = document.createElement('button');
      b.className = 'menu-item';
      b.innerHTML = '<svg class="ic" width="14" height="14"><use href="#i-folder"/></svg><span class="mi-name"></span>';
      $('.mi-name', b).textContent = d.name;
      b.title = d.path;
      b.addEventListener('click', () => {
        state.expectProjectAdd = true;
        send({ type: 'addProject', path: d.path });
        closeAddMenu();
      });
      menu.appendChild(b);
    }
  } else {
    const none = document.createElement('div');
    none.className = 'menu-hint';
    none.textContent = 'Nothing new in here.';
    menu.appendChild(none);
  }

  const sep = document.createElement('div');
  sep.className = 'menu-sep';
  menu.appendChild(sep);
  const other = document.createElement('button');
  other.className = 'menu-item';
  other.innerHTML = '<span class="mi-name">another folder…</span>';
  other.addEventListener('click', addMenuManualInput);
  menu.appendChild(other);
});

// ---------------------------------------------------------------- chrome (attention + title + notifications)
function updateChrome() {
  const need = [...state.sessions.values()].filter((e) => e.data.status === 'needs-you');
  const badge = $('#attention');
  badge.hidden = need.length === 0 || !state.showStatus;
  if (need.length) badge.textContent = `${need.length} need${need.length === 1 ? 's' : ''} you`;
  document.title = need.length && state.showStatus ? `(${need.length}) kiln` : 'kiln';
  // Pills and home tiles both carry live status, but rebuilding their DOM on
  // every tick would flicker, so only redraw when what they show has changed.
  const sig = [...state.sessions.values()]
    .map((e) => `${e.data.id}:${e.data.status}:${e.data.exitCode}:${e.data.projectId}:${e.data.title}:${e.data.note || ''}`)
    .join('|') + `#${state.projects.map((p) => p.id + p.name).join(',')}`;
  if (sig !== updateChrome.sig) {
    updateChrome.sig = sig;
    renderPills();
    renderHome();
  }
}
$('#attention').addEventListener('click', () => {
  const need = [...state.sessions.values()].filter((e) => e.data.status === 'needs-you');
  if (!need.length) return;
  updateChrome.cycle = ((updateChrome.cycle || 0) + 1) % need.length;
  focusSession(need[updateChrome.cycle].data.id);
});

function notifyUser(data, body) {
  // Hiding the chips hides the pop-ups too — they are the same claim.
  if (!state.showStatus || !state.notify || Notification.permission !== 'granted') return;
  try {
    new Notification(`${data.title} — ${displayStatus(data).label}`, {
      body, tag: `kiln-${data.id}`, silent: false,
    });
  } catch { /* not fatal */ }
}
const statusBtn = $('#btn-status');
function applyShowStatus() {
  document.body.classList.toggle('no-status', !state.showStatus);
  statusBtn.classList.toggle('on', state.showStatus);
  statusBtn.title = state.showStatus ? 'hide status chips' : 'show status chips';
}
statusBtn.addEventListener('click', () => {
  state.showStatus = !state.showStatus;
  localStorage.setItem('kiln.status', state.showStatus ? '1' : '0');
  applyShowStatus();
  updateChrome();
  renderHome();   // its text is status-derived, and the signature has not moved
});
applyShowStatus();

const notifyBtn = $('#btn-notify');
function renderNotifyBtn() { notifyBtn.classList.toggle('on', state.notify && Notification.permission === 'granted'); }
notifyBtn.addEventListener('click', async () => {
  if (state.notify) { state.notify = false; }
  else {
    if (Notification.permission !== 'granted') await Notification.requestPermission();
    state.notify = Notification.permission === 'granted';
  }
  localStorage.setItem('kiln.notify', state.notify ? '1' : '0');
  renderNotifyBtn();
});
renderNotifyBtn();

// ---------------------------------------------------------------- elapsed ticker
setInterval(() => {
  for (const el of $$('.elapsed')) {
    const start = Number(el.dataset.start);
    if (!start) continue;
    const end = Number(el.dataset.end) || Date.now();
    el.textContent = fmtDur(end - start);
  }
}, 1000);

// ---------------------------------------------------------------- drawers
const DRAWERS = {
  prompts: renderPromptsDrawer,
  skills: renderSkillsDrawer,
  secrets: renderSecretsDrawer,
  memory: renderMemoryDrawer,
  connections: renderConnectionsDrawer,
  usage: renderUsageDrawer,
  history: renderHistoryDrawer,
};

function openDrawer(name, force) {
  if (state.drawer === name && !force) return closeDrawer();
  state.drawer = name;
  $$('.drawer-btn').forEach((b) => b.classList.toggle('active', b.dataset.drawer === name));
  $('#drawer-title').textContent = name;
  const body = $('#drawer-body');
  body.innerHTML = '';
  $('#drawer').hidden = false;
  DRAWERS[name](body);
}
function closeDrawer() {
  state.drawer = null;
  $('#drawer').hidden = true;
  $$('.drawer-btn').forEach((b) => b.classList.remove('active'));
}
$$('.drawer-btn').forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.drawer)));
$('#drawer-close').addEventListener('click', closeDrawer);

async function api(url, opts) {
  const res = await fetch(url, opts);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error('The kiln API reached another local app. Close this window and start kiln again.');
  }
  const json = await res.json().catch(() => { throw new Error('The kiln API returned invalid JSON.'); });
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

// ---- file type icons (vscode-icons, self-hosted)
const VSICON_BY_EXT = {
  js: 'js_official', mjs: 'js_official', cjs: 'js_official',
  jsx: 'reactjs', tsx: 'reactjs', ts: 'typescript_official',
  json: 'json_official', css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'xml', svg: 'svg',
  md: 'markdown', markdown: 'markdown',
  py: 'python', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', conf: 'ini',
  sql: 'sql', rs: 'rust', go: 'go', java: 'java', c: 'c', h: 'c',
  cpp: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php',
  swift: 'swift', kt: 'kotlin', lua: 'lua', diff: 'diff', patch: 'diff',
  txt: 'text', log: 'log', pdf: 'pdf', zip: 'zip',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image',
  woff: 'font', woff2: 'font', ttf: 'font', otf: 'font',
  mp3: 'audio', wav: 'audio', mp4: 'video', mov: 'video',
};
const VSICON_BY_NAME = {
  'package.json': 'npm', 'package-lock.json': 'npm',
  '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git',
  '.env': 'dotenv', '.envrc': 'dotenv',
  license: 'license', 'license.md': 'license', 'license.txt': 'license',
};
function fileIconSrc(name, isDir, open) {
  if (isDir) return `/vendor/vsicons/default_folder${open ? '_opened' : ''}.svg`;
  const lower = name.toLowerCase();
  let icon = VSICON_BY_NAME[lower];
  if (!icon && lower.startsWith('.env')) icon = 'dotenv';
  if (!icon) icon = VSICON_BY_EXT[lower.split('.').pop()];
  return icon ? `/vendor/vsicons/file_type_${icon}.svg` : '/vendor/vsicons/default_file.svg';
}

// ---- files panel (always visible, left side)
// The tree is a view of the folder, not a snapshot of it: the server watches
// each project and sends `fsChanged`, and the panel re-reads the folders it has
// open. Which folders those are lives outside the DOM so a rebuild — or a
// reload — puts the tree back the way it was found.
const filesOpen = new Set();   // full paths of expanded directories
let filesToken = 0;            // guards against an older rebuild landing last
let filesPanelProject = null;  // which project the open-set currently describes

// The server is the only one that knows which platform these paths are from.
function joinPath(dir, name) {
  return `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`;
}

function filesOpenKey(p) { return `kiln.filesOpen.${p.id}`; }

function loadFilesOpen(p) {
  filesOpen.clear();
  try {
    for (const d of JSON.parse(localStorage.getItem(filesOpenKey(p)) || '[]')) filesOpen.add(d);
  } catch { /* nothing remembered */ }
}

function saveFilesOpen(p) {
  try { localStorage.setItem(filesOpenKey(p), JSON.stringify([...filesOpen])); }
  catch { /* quota; the tree still works, it just forgets */ }
}

async function listDir(dir) {
  return (await api(`/api/fs/list?path=${encodeURIComponent(dir)}`)).entries;
}

// Builds into a detached <ul>, so a slow folder never blanks the panel.
async function buildTree(dir, token) {
  const ul = document.createElement('ul');
  const entries = await listDir(dir);
  for (const e of entries) {
    const full = joinPath(dir, e.name);
    const li = treeNode(dir, e);
    if (e.dir && filesOpen.has(full)) {
      // A folder that is open stays open, and its children are read too. If it
      // has gone away since, drop it rather than failing the whole rebuild.
      try {
        const sub = await buildTree(full, token);
        if (token !== filesToken) return ul;
        li.classList.add('open');
        $('.fi', li).src = fileIconSrc(e.name, true, true);
        li.appendChild(sub);
      } catch { filesOpen.delete(full); }
    }
    ul.appendChild(li);
  }
  return ul;
}

async function renderFilesPanel() {
  const body = $('#files-body');
  const label = $('#files-project');
  const p = project(state.selectedProject);
  label.textContent = p ? p.name : '';
  label.title = p ? p.path : '';
  const token = ++filesToken;
  if (!p) {
    body.innerHTML = '<p class="panel-hint">Pick a project up top.</p>';
    return;
  }
  if (filesPanelProject !== p.id) {
    filesPanelProject = p.id;
    loadFilesOpen(p);
    body.innerHTML = '';
  }
  const scroll = body.scrollTop;
  try {
    const tree = await buildTree(p.path, token);
    tree.className = 'tree';
    if (token !== filesToken) return;
    body.replaceChildren(tree);
    body.scrollTop = scroll;
  } catch (err) {
    if (token !== filesToken) return;
    body.innerHTML = `<p class="panel-hint">${err.message}</p>`;
  }
}
$('#files-refresh').addEventListener('click', renderFilesPanel);

function treeNode(parentDir, entry) {
  const full = joinPath(parentDir, entry.name);
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = entry.dir
    ? '<span class="twist">▶</span><img class="fi" alt="" /><span class="label"></span>'
    : '<img class="fi" alt="" /><span class="label"></span>';
  $('.fi', row).src = fileIconSrc(entry.name, entry.dir, false);
  $('.label', row).textContent = entry.name;
  row.title = full;
  li.appendChild(row);
  if (entry.dir) {
    row.addEventListener('click', async () => {
      const open = !li.classList.contains('open');
      const p = project(state.selectedProject);
      if (!open) {
        li.classList.remove('open');
        $('.fi', row).src = fileIconSrc(entry.name, true, false);
        li.querySelector('ul')?.remove();
        // Collapsing a folder collapses what was open inside it, but only in
        // the DOM — reopening it should find the same shape.
        filesOpen.delete(full);
        if (p) saveFilesOpen(p);
        return;
      }
      try {
        const sub = await buildTree(full, filesToken);
        li.querySelector('ul')?.remove();
        li.appendChild(sub);
        li.classList.add('open');
        $('.fi', row).src = fileIconSrc(entry.name, true, true);
        filesOpen.add(full);
        if (p) saveFilesOpen(p);
      } catch (err) {
        alert(err.message);
      }
    });
  } else {
    row.addEventListener('click', () => openFileViewer(full, entry.name));
  }
  return li;
}

// ---- prompts
async function loadPrompts() {
  try { state.prompts = (await api('/api/prompts')).prompts; } catch { state.prompts = []; }
  return state.prompts;
}

function renderPromptsDrawer(body) {
  body.innerHTML = `
    <p class="drawer-hint"><span class="mono">{TOKENS}</span> become form fields.</p>
    <form class="drawer-form" id="np-form">
      <input id="np-slug" placeholder="new-prompt-name" pattern="[a-z0-9-]+" spellcheck="false" />
      <button type="submit">create</button>
    </form>
    <ul class="row-list" id="prompt-list"></ul>`;
  $('#np-form', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const slug = $('#np-slug', body).value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!slug) return;
    const scaffold = `---\nname: ${slug.replace(/-/g, ' ')}\ndescription: \n---\nTask here. {TOKENS} for params.\n`;
    await api(`/api/prompts/${slug}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: scaffold }),
    });
    await loadPrompts();
    renderPromptsDrawer(body);
    const created = state.prompts.find((x) => x.slug === slug);
    if (created) editPrompt(created);
  });
  loadPrompts().then(() => {
    const ul = $('#prompt-list', body);
    for (const pr of state.prompts) {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="r-top"><span class="r-name"></span><span class="r-meta"></span></div>
        <div class="r-desc"></div>`;
      $('.r-name', li).textContent = pr.name;
      $('.r-meta', li).textContent = pr.params.length ? `{${pr.params.join('} {')}}` : '';
      $('.r-desc', li).textContent = pr.description;
      li.addEventListener('click', () => editPrompt(pr));
      ul.appendChild(li);
    }
  });
}

function editPrompt(pr) {
  const raw = `---\nname: ${pr.name}\ndescription: ${pr.description}\n---\n${pr.body}\n`;
  showView({
    title: `${pr.slug}.md`, edit: raw,
    actions: [
      { label: 'dispatch with this', fn: () => { closeView(); openDispatch({ preset: pr.slug }); } },
      { label: 'delete', danger: true, fn: async () => {
        if (!confirm(`Delete prompt "${pr.name}"?`)) return;
        await api(`/api/prompts/${pr.slug}`, { method: 'DELETE' });
        closeView();
        if (state.drawer === 'prompts') openDrawer('prompts', true);
      } },
      { label: 'save', primary: true, fn: async () => {
        await api(`/api/prompts/${pr.slug}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: $('#view-edit').value }),
        });
        closeView();
        if (state.drawer === 'prompts') openDrawer('prompts', true);
      } },
    ],
  });
}

// ---- skills
function renderSkillsDrawer(body) {
  body.innerHTML = `
    <p class="drawer-hint">Paste a source, an installer agent takes it from there.</p>
    <form class="drawer-form" id="sk-form">
      <input id="sk-src" placeholder="github.com/user/skill-repo" spellcheck="false" />
      <button type="submit">install</button>
    </form>
    <form class="drawer-form">
      <input id="sk-search" placeholder="search" spellcheck="false" />
    </form>
    <ul class="row-list" id="sk-list"></ul>`;
  let all = [];
  const paint = () => {
    const q = $('#sk-search', body).value.toLowerCase();
    const ul = $('#sk-list', body);
    ul.innerHTML = '';
    for (const s of all.filter((x) => !q || x.name.toLowerCase().includes(q) || x.description.toLowerCase().includes(q))) {
      const li = document.createElement('li');
      li.style.cursor = 'default';
      li.innerHTML = `
        <div class="r-top"><span class="r-name"></span><span class="r-kind"></span></div>
        <div class="r-desc"></div>`;
      $('.r-name', li).textContent = s.name;
      $('.r-kind', li).textContent = s.kind;
      $('.r-desc', li).textContent = s.description || '—';
      ul.appendChild(li);
    }
  };
  api('/api/skills').then((j) => { all = j.skills; paint(); })
    .catch((err) => { $('#sk-list', body).innerHTML = `<p class="drawer-hint">${err.message}</p>`; });
  $('#sk-search', body).addEventListener('input', paint);
  $('#sk-form', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const source = $('#sk-src', body).value.trim();
    if (!source) return;
    try {
      state.expectSpawn = true;
      await api('/api/skills/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      $('#sk-src', body).value = '';
      closeDrawer(); // the installer agent card just landed on the canvas
    } catch (err) { alert(err.message); }
  });
}

// ---- secrets (env profiles)
// The browser only ever sees masked tails; full values live on disk and go
// straight into terminal environments at dispatch.
const SECRET_TYPE_VARS = {
  github: 'GITHUB_TOKEN + GH_TOKEN',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  vercel: 'VERCEL_TOKEN',
  supabase: 'SUPABASE_ACCESS_TOKEN',
  elevenlabs: 'ELEVENLABS_API_KEY',
  npm: 'NPM_TOKEN',
  huggingface: 'HF_TOKEN',
};

function renderSecretsDrawer(body) {
  body.innerHTML = `
    <p class="drawer-hint">One profile per identity. Values never show again, only the tail.</p>
    <div class="drawer-section">
      <h3>add a secret</h3>
      <form id="sec-form">
        <div class="field-grid">
          <label class="field"><span>profile</span><select id="sec-profile"></select></label>
          <label class="field"><span>type</span><select id="sec-type"></select></label>
        </div>
        <label class="field" id="sec-newname-field" hidden>
          <span>name it</span>
          <input id="sec-newname" spellcheck="false" />
        </label>
        <label class="field" id="sec-var-field">
          <span>env var</span>
          <input id="sec-var" placeholder="MY_TOKEN" spellcheck="false" />
        </label>
        <p class="drawer-hint" id="sec-var-hint">Types set the var. Custom: name it per the tool's docs.</p>
        <label class="field">
          <span>secret</span>
          <input id="sec-value" type="password" autocomplete="off" placeholder="paste" />
        </label>
        <button class="primary" type="submit">save</button>
      </form>
    </div>
    <div id="sec-list"></div>`;

  const profSel = $('#sec-profile', body);
  const typeSel = $('#sec-type', body);
  const varField = $('#sec-var-field', body);
  const varInput = $('#sec-var', body);

  const syncType = () => {
    const t = typeSel.value;
    if (SECRET_TYPE_VARS[t]) {
      varField.hidden = false;
      varInput.value = SECRET_TYPE_VARS[t];
      varInput.disabled = true;
    } else {
      varField.hidden = false;
      varInput.disabled = false;
      if (Object.values(SECRET_TYPE_VARS).includes(varInput.value)) varInput.value = '';
    }
  };
  const syncProfile = () => {
    $('#sec-newname-field', body).hidden = profSel.value !== '__new__';
  };

  const paint = async () => {
    let j;
    try { j = await api('/api/profiles'); } catch (err) {
      $('#sec-list', body).innerHTML = `<p class="drawer-hint">${err.message}</p>`;
      return;
    }
    profSel.innerHTML = '';
    for (const p of j.profiles) {
      const o = document.createElement('option');
      o.value = p.name;
      o.textContent = p.name;
      profSel.appendChild(o);
    }
    const nw = document.createElement('option');
    nw.value = '__new__';
    nw.textContent = 'new profile…';
    profSel.appendChild(nw);
    if (!j.profiles.length) profSel.value = '__new__';
    syncProfile();

    typeSel.innerHTML = '';
    for (const t of [...(j.types || Object.keys(SECRET_TYPE_VARS)), 'custom']) {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t;
      typeSel.appendChild(o);
    }
    syncType();

    const list = $('#sec-list', body);
    list.innerHTML = '';
    for (const p of j.profiles) {
      const sec = document.createElement('div');
      sec.className = 'drawer-section';
      sec.innerHTML = `
        <h3 class="sec-head"><span></span>
          <span class="sec-used"></span>
          <button class="icon danger sec-del-profile" title="Delete this profile">×</button>
        </h3>
        <ul class="row-list sec-rows"></ul>`;
      $('.sec-head > span', sec).textContent = p.name;
      const used = state.projects.filter((x) => x.envProfile === p.name).map((x) => x.name);
      $('.sec-used', sec).textContent = used.length ? `used by ${used.join(', ')}` : 'not used yet';
      $('.sec-del-profile', sec).addEventListener('click', async () => {
        if (!confirm(`Delete profile "${p.name}"?`)) return;
        await api(`/api/profiles/${p.name}`, { method: 'DELETE' });
        paint();
      });
      const ul = $('.sec-rows', sec);
      for (const v of p.vars) {
        const li = document.createElement('li');
        li.className = 'sec-row';
        li.innerHTML = `
          <span class="sec-var mono"></span>
          <span class="sec-masked mono"></span>
          <button class="icon danger" title="Remove this secret">×</button>`;
        $('.sec-var', li).textContent = v.var;
        $('.sec-masked', li).textContent = v.masked;
        $('button', li).addEventListener('click', async () => {
          if (!confirm(`Remove ${v.var} from "${p.name}"?`)) return;
          await api(`/api/profiles/${p.name}/secrets/${v.var}`, { method: 'DELETE' });
          paint();
        });
        ul.appendChild(li);
      }
      if (!p.vars.length) ul.innerHTML = '<p class="drawer-hint">empty</p>';
      list.appendChild(sec);
    }
    if (!j.profiles.length) {
      list.innerHTML = '';
    }
  };

  profSel.addEventListener('change', syncProfile);
  typeSel.addEventListener('change', syncType);
  $('#sec-form', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = profSel.value === '__new__'
      ? $('#sec-newname', body).value.trim().replace(/[^a-z0-9-_]/gi, '')
      : profSel.value;
    if (!name) { alert('Name the profile first.'); return; }
    const type = typeSel.value;
    const value = $('#sec-value', body).value;
    try {
      await api(`/api/profiles/${name}/secrets`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, var: varInput.disabled ? null : varInput.value.trim(), value }),
      });
      $('#sec-value', body).value = '';
      $('#sec-newname', body).value = '';
      await paint();
      profSel.value = name;
      syncProfile();
    } catch (err) { alert(err.message); }
  });
  paint();
}

// ---- memory
// The index is read by every agent before it works, so the drawer shows what it
// costs while you edit it. The bar is not decoration: the server refuses a save
// over the cap, and knowing that before you type is the difference between
// tightening a fact and losing an edit.
function renderMemoryDrawer(body) {
  const p = project(state.selectedProject);
  if (!p) {
    body.innerHTML = '<p class="drawer-hint">No project selected.</p>';
    return;
  }
  body.innerHTML = `
    <p class="drawer-hint">Decisions, components, conventions, gotchas. Every agent reads this first.</p>
    <div class="drawer-section">
      <h3>index.md <span class="mem-budget" id="mem-budget"></span></h3>
      <div class="mem-bar"><i id="mem-fill"></i></div>
      <textarea class="mem-edit" id="mem-index" spellcheck="false" placeholder="durable facts…"></textarea>
      <button class="primary mem-save" id="mem-save">save</button>
    </div>
    <div class="drawer-section">
      <h3>run notes</h3>
      <ul class="row-list" id="mem-runs"></ul>
      <p class="drawer-hint" id="mem-none" hidden>none yet</p>
    </div>`;
  let cap = 8000;
  const budget = () => {
    const used = new TextEncoder().encode($('#mem-index', body).value).length;
    const pct = Math.min(100, Math.round((used / cap) * 100));
    $('#mem-budget', body).textContent = `${(used / 1000).toFixed(1)} / ${Math.round(cap / 1000)} KB`;
    $('#mem-budget', body).classList.toggle('over', used > cap);
    const fill = $('#mem-fill', body);
    fill.style.width = `${pct}%`;
    fill.classList.toggle('over', used > cap);
  };
  api(`/api/memory/${p.id}`).then((j) => {
    cap = j.cap || cap;
    $('#mem-index', body).value = j.index;
    budget();
    const ul = $('#mem-runs', body);
    $('#mem-none', body).hidden = j.runs.length > 0;
    for (const r of j.runs) {
      const li = document.createElement('li');
      li.innerHTML = '<div class="r-top"><span class="r-name mono"></span><span class="r-meta"></span></div>';
      $('.r-name', li).textContent = r.name;
      $('.r-meta', li).textContent = fmtAgo(r.mtime);
      li.addEventListener('click', async () => {
        const rr = await api(`/api/memory/${p.id}/run?name=${encodeURIComponent(r.name)}`);
        showView({ title: r.name, content: rr.content });
      });
      ul.appendChild(li);
    }
    // Says what happens to the rest, rather than letting notes vanish quietly.
    if (j.runs.length > (j.runsKeep || 20)) {
      const hint = document.createElement('p');
      hint.className = 'drawer-hint';
      hint.textContent = `newest ${j.runsKeep} kept — older notes are removed at the next dispatch`;
      $('#mem-runs', body).after(hint);
    }
  }).catch((err) => { body.innerHTML = `<p class="drawer-hint">${err.message}</p>`; });
  $('#mem-index', body).addEventListener('input', budget);
  $('#mem-save', body).addEventListener('click', async () => {
    const btn = $('#mem-save', body);
    try {
      await api(`/api/memory/${p.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: $('#mem-index', body).value }),
      });
      btn.textContent = 'saved';
      setTimeout(() => { if (body.isConnected) btn.textContent = 'save'; }, 1200);
    } catch (err) { alert(err.message); }
  });
}

// ---- connections (MCP servers)
// One list, handed to every card at dispatch. Kept in kiln's own file rather
// than written into ~/.claude.json or ~/.codex/config.toml, which are yours.
function renderConnectionsDrawer(body) {
  body.innerHTML = `
    <p class="drawer-hint">MCP servers every dispatched agent gets, on both engines.</p>
    <form class="drawer-form" id="mcp-form">
      <input class="mono-input" id="mcp-name" placeholder="name (e.g. linear)" />
      <input class="mono-input" id="mcp-cmd" placeholder="command and args (e.g. npx -y @acme/mcp)" />
      <input class="mono-input" id="mcp-env" placeholder="env, optional: TOKEN=abc, OTHER=def" />
      <button class="primary" type="submit">add</button>
    </form>
    <div class="drawer-section">
      <h3>connected</h3>
      <ul class="row-list" id="mcp-list"></ul>
      <p class="drawer-hint" id="mcp-none" hidden>nothing connected yet</p>
    </div>`;
  const paint = () => api('/api/connections').then((j) => {
    const ul = $('#mcp-list', body);
    ul.innerHTML = '';
    $('#mcp-none', body).hidden = j.connections.length > 0;
    for (const c of j.connections) {
      const li = document.createElement('li');
      li.innerHTML = `<div class="r-top"><span class="r-name mono"></span>
        <button class="row-x" title="remove">×</button></div>
        <div class="r-meta mono"></div>`;
      $('.r-name', li).textContent = c.name;
      $('.r-meta', li).textContent = [c.command, ...c.args].join(' ') +
        (c.env.length ? ` · ${c.env.map((e) => `${e.var}=${e.masked}`).join(' ')}` : '');
      $('.row-x', li).addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove the ${c.name} connection?`)) return;
        await api(`/api/connections/${encodeURIComponent(c.name)}`, { method: 'DELETE' });
        paint();
      });
      ul.appendChild(li);
    }
  }).catch((err) => { $('#mcp-list', body).innerHTML = `<p class="drawer-hint">${err.message}</p>`; });
  $('#mcp-form', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#mcp-name', body).value.trim();
    const parts = $('#mcp-cmd', body).value.trim().split(/\s+/).filter(Boolean);
    const env = {};
    for (const pair of $('#mcp-env', body).value.split(',')) {
      const [k, ...rest] = pair.split('=');
      if (k && k.trim() && rest.length) env[k.trim()] = rest.join('=').trim();
    }
    if (!name || !parts.length) return;
    try {
      await api(`/api/connections/${encodeURIComponent(name)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: parts[0], args: parts.slice(1), env }),
      });
      $('#mcp-form', body).reset();
      paint();
    } catch (err) { alert(err.message); }
  });
  paint();
}
// ---- usage
const PROVIDERS = [
  { key: 'claude', label: 'claude', color: '#e8845a' },
  { key: 'codex', label: 'codex', color: '#c3cdd9' },
];

function usageChart(u) {
  // one point per calendar day (UTC, matching the server's aggregation)
  const map = {};
  for (const d of u.byDay) map[d.date] = d;
  const dates = [];
  for (let i = u.days - 1; i >= 0; i--) {
    dates.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  }
  const W = 396, H = 140, PL = 10, PR = 10, PT = 14, PB = 22;
  const max = Math.max(1, ...dates.map((d) => Math.max(map[d]?.claude || 0, map[d]?.codex || 0)));
  const x = (i) => PL + (dates.length > 1 ? i * (W - PL - PR) / (dates.length - 1) : (W - PL - PR) / 2);
  const y = (v) => PT + (1 - v / max) * (H - PT - PB);
  const showDots = dates.length <= 16;
  const parts = [];
  for (const g of [0.5, 1]) {
    parts.push(`<line x1="${PL}" y1="${y(max * g).toFixed(1)}" x2="${W - PR}" y2="${y(max * g).toFixed(1)}"
      stroke="#1e1e22" stroke-width="1"${g === 1 ? '' : ' stroke-dasharray="3 4"'}/>`);
  }
  parts.push(`<line x1="${PL}" y1="${y(0)}" x2="${W - PR}" y2="${y(0)}" stroke="#26262c" stroke-width="1"/>`);
  for (const p of PROVIDERS) {
    const pts = dates.map((d, i) => `${x(i).toFixed(1)},${y(map[d]?.[p.key] || 0).toFixed(1)}`);
    parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${p.color}"
      stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`);
    if (showDots) {
      for (let i = 0; i < dates.length; i++) {
        const v = map[dates[i]]?.[p.key] || 0;
        if (v) parts.push(`<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.6" fill="${p.color}"/>`);
      }
    }
  }
  const dateLabel = (d) => d.slice(5).replace('-', '/');
  parts.push(`<text x="${PL}" y="${H - 6}" fill="#55555e" font-size="9.5" font-family="inherit">${dateLabel(dates[0])}</text>`);
  parts.push(`<text x="${W - PR}" y="${H - 6}" fill="#55555e" font-size="9.5" text-anchor="end" font-family="inherit">${dateLabel(dates[dates.length - 1])}</text>`);
  parts.push(`<text x="${W - PR}" y="${(y(max) - 4).toFixed(1)}" fill="#55555e" font-size="9.5" text-anchor="end" font-family="inherit">${fmtTokens(max)}</text>`);
  const legend = PROVIDERS.map((p) =>
    `<span><span class="sw" style="background:${p.color}"></span>${p.label} · ${fmtTokens(u.byProvider?.[p.key] || 0)}</span>`).join('');
  return `
    <div class="chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tokens per day by engine">${parts.join('')}</svg>
      <div class="chart-legend">${legend}</div>
    </div>`;
}

function renderUsageDrawer(body, days = 7) {
  body.innerHTML = `
    <div class="range-row">
      ${[7, 30, 90].map((d) => `<button data-d="${d}" class="${d === days ? 'selected' : ''}">${d}d</button>`).join('')}
    </div>
    <div id="usage-content"><p class="drawer-hint">reading transcripts…</p></div>`;
  $$('.range-row button', body).forEach((b) =>
    b.addEventListener('click', () => renderUsageDrawer(body, Number(b.dataset.d))));
  api(`/api/usage?days=${days}`).then((u) => {
    const c = $('#usage-content', body);
    const bars = (rows) => {
      const max = Math.max(1, ...rows.map((r) => r.io));
      return rows.map((r) => `
        <div class="bar-row">
          <span class="b-name" title="${r.name}">${r.name}</span>
          <span class="b-track"><span class="b-fill" style="width:${(r.io / max * 100).toFixed(1)}%"></span></span>
          <span class="b-val">${fmtTokens(r.io)}</span>
        </div>`).join('');
    };
    c.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="v">${fmtTokens(u.today.io)}</div><div class="k">I/O today</div></div>
        <div class="stat"><div class="v">$${u.today.cost.toFixed(2)}</div><div class="k">est. today</div></div>
        <div class="stat"><div class="v">${fmtTokens(u.io)}</div><div class="k">I/O · ${u.days}d</div></div>
        <div class="stat"><div class="v">$${u.cost.toFixed(2)}</div><div class="k">est. · ${u.days}d</div></div>
        <div class="stat"><div class="v">${fmtTokens(u.cacheRead)}</div><div class="k">cache reads</div></div>
        <div class="stat"><div class="v">${u.turns}</div><div class="k">turns</div></div>
      </div>
      <div class="drawer-section"><h3>tokens per day</h3>${usageChart(u)}</div>
      <div class="drawer-section"><h3>top projects</h3>${bars(u.topProjects) || '<p class="drawer-hint">no data</p>'}</div>
      <div class="drawer-section"><h3>models</h3>${bars(u.topModels) || ''}</div>
      <p class="drawer-hint">List-price estimates, not what your plan charges.</p>`;
  }).catch((err) => { $('#usage-content', body).innerHTML = `<p class="drawer-hint">${err.message}</p>`; });
}

// ---- history
function renderHistoryDrawer(body) {
  api('/api/history').then((j) => {
    if (!j.history.length) {
      body.innerHTML = '<p class="drawer-hint">Nothing finished yet.</p>';
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'row-list';
    for (const h of j.history) {
      const li = document.createElement('li');
      li.style.cursor = 'default';
      const dur = h.endedAt && h.startedAt ? fmtDur(h.endedAt - h.startedAt) : '—';
      const outcome = h.exitCode ? `exit ${h.exitCode}` : h.outcome;
      li.innerHTML = `
        <div class="r-top">
          <span class="r-name"></span>
          <span class="r-kind"></span>
          <span class="r-meta"></span>
        </div>
        <div class="r-desc"></div>`;
      $('.r-name', li).textContent = h.title === h.codename ? h.codename : `${h.title} · ${h.codename}`;
      $('.r-kind', li).textContent = h.engine;
      $('.r-meta', li).textContent = `${dur} · ${fmtAgo(h.endedAt)}`;
      $('.r-desc', li).textContent = [h.project, outcome, h.task].filter(Boolean).join(' — ');
      ul.appendChild(li);
    }
    body.appendChild(ul);
  });
}

// ---------------------------------------------------------------- project settings
const sModal = $('#settings-modal');

// Models and reasoning levels hang off the engine *and*, for the harnesses,
// the subscription it is logged in to — a jcode on ChatGPT has no opus.
function catalogView(engine, auth) {
  const cat = state.catalog?.[engine];
  if (!cat) return null;
  return cat.byAuth[auth || '*'] || cat.byAuth[cat.defaultAuth] || cat.byAuth['*'] || null;
}
function engineAuths(engine) { return state.catalog?.[engine]?.auths || []; }
function defaultAuthFor(engine, wanted) {
  const auths = engineAuths(engine);
  if (!auths.length) return null;
  return auths.some((a) => a.id === wanted) ? wanted : state.catalog[engine].defaultAuth;
}

function fillEngineDependent(engine, auth, modelSel, effortSel, wanted = {}) {
  const cat = catalogView(engine, auth);
  modelSel.innerHTML = '';
  effortSel.innerHTML = '';
  if (!cat) return;
  for (const m of cat.models) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label + (m.id === cat.defaultModel ? ' · default' : '');
    modelSel.appendChild(o);
  }
  modelSel.value = cat.models.some((m) => m.id === wanted.model) ? wanted.model : cat.defaultModel;
  for (const lvl of cat.efforts) {
    const o = document.createElement('option');
    o.value = lvl;
    o.textContent = lvl + (lvl === cat.defaultEffort ? ' · default' : '');
    effortSel.appendChild(o);
  }
  effortSel.value = cat.efforts.includes(wanted.effort) ? wanted.effort : cat.defaultEffort;
}

async function loadProfileList() {
  try { return (await api('/api/profiles')).profiles; } catch { return []; }
}

async function openSettings() {
  const p = project(state.selectedProject);
  if (!p) return;
  $('#s-project-name').textContent = p.path;
  const profiles = await loadProfileList();
  const ps = $('#s-profile');
  ps.innerHTML = '<option value="">none</option>';
  for (const pr of profiles) {
    const o = document.createElement('option');
    o.value = pr.name;
    o.textContent = `${pr.name} (${pr.count} var${pr.count === 1 ? '' : 's'})`;
    ps.appendChild(o);
  }
  ps.value = p.envProfile || '';
  if (ps.selectedIndex === -1) ps.value = '';

  const es = $('#s-engine');
  es.innerHTML = '';
  for (const e of engineOptions()) {
    const o = document.createElement('option');
    o.value = e;
    o.textContent = `${ENGINE_LABEL[e]} · ${ENGINE_SUB[e]}`;
    es.appendChild(o);
  }
  const d = p.defaults || {};
  es.value = engineOptions().includes(d.engine) ? d.engine : engineOptions()[0] || 'claude';
  fillSettingsAuth(d);
  sModal.hidden = false;
}

// The settings modal's auth select disappears for engines with one identity.
function fillSettingsAuth(wanted = {}) {
  const engine = $('#s-engine').value;
  const auths = engineAuths(engine);
  const sel = $('#s-auth');
  const field = $('#s-auth-field');
  field.hidden = !auths.length;
  sel.innerHTML = '';
  for (const a of auths) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.sub;
    sel.appendChild(o);
  }
  const auth = defaultAuthFor(engine, wanted.auth);
  if (auth) sel.value = auth;
  fillEngineDependent(engine, auth, $('#s-model'), $('#s-effort'), wanted);
}

$('#s-engine').addEventListener('change', () => fillSettingsAuth());
$('#s-auth').addEventListener('change', () =>
  fillEngineDependent($('#s-engine').value, $('#s-auth').value, $('#s-model'), $('#s-effort')));

$('#s-save').addEventListener('click', () => {
  const p = project(state.selectedProject);
  if (!p) return;
  send({
    type: 'updateProject', projectId: p.id,
    envProfile: $('#s-profile').value || null,
    defaults: {
      engine: $('#s-engine').value,
      auth: engineAuths($('#s-engine').value).length ? $('#s-auth').value : null,
      model: $('#s-model').value,
      effort: $('#s-effort').value,
    },
  });
  sModal.hidden = true;
});
$('#settings-modal [data-action="cancel"]').addEventListener('click', () => { sModal.hidden = true; });
$('#btn-settings').addEventListener('click', openSettings);

$('#s-manage-secrets').addEventListener('click', () => {
  sModal.hidden = true;
  openDrawer('secrets', true);
});

// ---------------------------------------------------------------- view modal
const viewModal = $('#view-modal');
function showView({ title, content, edit, actions = [] }) {
  $('#view-title').textContent = title;
  const pre = $('#view-pre'), ta = $('#view-edit');
  pre.hidden = edit != null;
  ta.hidden = edit == null;
  if (edit != null) ta.value = edit; else pre.textContent = content;
  const act = $('#view-actions');
  act.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = a.primary ? 'primary' : 'ghost';
    if (a.danger) b.style.color = 'var(--c-failed)';
    b.textContent = a.label;
    b.addEventListener('click', a.fn);
    act.appendChild(b);
  }
  const close = document.createElement('button');
  close.className = actions.length ? 'ghost' : 'primary';
  close.textContent = 'close';
  close.addEventListener('click', closeView);
  act.prepend(close);
  viewModal.hidden = false;
}
function closeView() { viewModal.hidden = true; }

// ---------------------------------------------------------------- dispatch modal
const dModal = $('#dispatch-modal');
let dEngine = 'claude';
let dAuth = null;
let dPresetBody = '';
let dTaskDirty = false;

// Claude Code first because it is the only client that still draws on the
// Claude plan itself; pi second because it is the only one that costs nothing
// at all — a local Qwen3.6-35B-A3B on llama-server, which is what you reach for
// when the plan runs out. The metered harnesses are a click away rather than gone.
const PRIMARY_ENGINES = ['claude', 'codex'];
const MORE_ENGINES = [];
function engineOptions() {
  return [...PRIMARY_ENGINES, ...MORE_ENGINES].filter((e) => state.engines[e]);
}

// Claude Code and Codex each authenticate as themselves — there is no identity
// to choose between, so the row that used to offer one stays hidden. The
// catalog still carries an `auths` array per engine, so an engine that grows
// one later needs no change here.
function renderAuthRow() {
  const field = $('#auth-field');
  if (field) field.hidden = true;
}
async function refreshEngineAuth() { renderAuthRow(); }
function engineSeg(e) {
  const b = document.createElement('button');
  b.className = 'seg';
  b.dataset.engine = e;
  b.style.setProperty('--seg-color', ENGINE_COLOR[e]);
  b.innerHTML = `${engineIcon(e, 20)}<span class="seg-text"><strong>${ENGINE_LABEL[e]}</strong></span>`;
  b.addEventListener('click', () => setEngine(e));
  return b;
}

function openDispatch(prefill = {}) {
  const row = $('#engine-row');
  const moreRow = $('#engine-row-more');
  row.innerHTML = '';
  moreRow.innerHTML = '';
  const opts = engineOptions();
  for (const e of opts.filter((x) => PRIMARY_ENGINES.includes(x))) row.appendChild(engineSeg(e));
  const more = opts.filter((x) => MORE_ENGINES.includes(x));
  for (const e of more) moreRow.appendChild(engineSeg(e));
  $('#engine-more').hidden = !more.length;
  showMoreEngines(false);

  const sel = $('#d-project');
  sel.innerHTML = '<option value="">no project</option>';
  for (const p of state.projects) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  sel.value = prefill.projectId || state.selectedProject || '';
  if (sel.selectedIndex === -1) sel.value = '';

  // the chosen project's saved defaults seed engine/model/reasoning
  const dd = project(sel.value)?.defaults || null;
  const eng = opts.includes(prefill.engine) ? prefill.engine
    : dd && opts.includes(dd.engine) ? dd.engine
    : opts[0] || 'claude';
  setEngine(eng, dd || {});

  refreshEngineAuth();

  $('#d-name').value = '';
  $('#d-task').value = '';
  $('#d-skip').checked = true;
  $('#d-env').checked = true;
  dTaskDirty = false;

  loadPrompts().then(() => {
    const ps = $('#d-preset');
    ps.innerHTML = '<option value="">none</option>';
    for (const pr of state.prompts) {
      const o = document.createElement('option');
      o.value = pr.slug;
      o.textContent = pr.name;
      o.title = pr.description;
      ps.appendChild(o);
    }
    ps.value = prefill.preset || '';
    applyPreset();
  });

  dModal.hidden = false;
}

function showMoreEngines(open) {
  $('#engine-row-more').hidden = !open;
  $('#engine-more').setAttribute('aria-expanded', String(open));
  $('#engine-more').textContent = open ? 'fewer engines' : 'more engines';
}
$('#engine-more').addEventListener('click', () =>
  showMoreEngines($('#engine-row-more').hidden));

function setEngine(e, wanted = {}) {
  dEngine = e;
  dAuth = defaultAuthFor(e, wanted.auth);
  // a project defaulting to claude/codex opens with that row already showing
  $$('#engine-row .seg, #engine-row-more .seg')
    .forEach((b) => b.classList.toggle('selected', b.dataset.engine === e));
  renderAuthRow();
  fillEngineDependent(dEngine, dAuth, $('#d-model'), $('#d-effort'), wanted);
}

$('#d-project').addEventListener('change', () => {
  const dd = project($('#d-project').value)?.defaults;
  if (dd && engineOptions().includes(dd.engine)) setEngine(dd.engine, dd);
});

function applyPreset() {
  const slug = $('#d-preset').value;
  const pr = state.prompts.find((x) => x.slug === slug);
  const wrap = $('#d-params');
  wrap.innerHTML = '';
  dPresetBody = pr ? pr.body : '';
  dTaskDirty = false;
  if (pr) {
    for (const param of pr.params) {
      const label = document.createElement('label');
      label.className = 'field';
      label.innerHTML = `<span>{${param}}</span><input type="text" data-param="${param}" spellcheck="false" />`;
      $('input', label).addEventListener('input', substitutePreset);
      wrap.appendChild(label);
    }
  }
  substitutePreset();
}

function substitutePreset() {
  if (dTaskDirty) return;
  let text = dPresetBody;
  for (const input of $$('#d-params input')) {
    if (input.value.trim()) text = text.split(`{${input.dataset.param}}`).join(input.value.trim());
  }
  $('#d-task').value = text;
}

$('#d-preset').addEventListener('change', applyPreset);
$('#d-task').addEventListener('input', () => { dTaskDirty = true; });

$('#d-go').addEventListener('click', () => {
  const w = 860, h = 540;
  const c = viewportCenter();
  const pt = screenToCanvas(c.sx, c.sy);
  const n = state.sessions.size;
  state.expectSpawn = true;
  send({
    type: 'spawn',
    engine: dEngine,
    auth: dAuth,
    projectId: $('#d-project').value || null,
    model: $('#d-model').value || null,
    effort: $('#d-effort').value || null,
    task: $('#d-task').value.trim() || null,
    title: $('#d-name').value.trim() || null,
    skipPermissions: $('#d-skip').checked,
    loadEnv: $('#d-env').checked,
    x: pt.x - w / 2 + (n % 5) * 40,
    y: pt.y - h / 2 + (n % 5) * 40,
    w, h,
  });
  dModal.hidden = true;
});

$('#dispatch-modal [data-action="cancel"]').addEventListener('click', () => { dModal.hidden = true; });
$('#btn-dispatch').addEventListener('click', () => openDispatch());

// ---------------------------------------------------------------- global keys / misc
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (addMenu) closeAddMenu();
    else if (!viewModal.hidden) closeView();
    else if (!dModal.hidden) dModal.hidden = true;
    else if (!sModal.hidden) sModal.hidden = true;
    else if (state.drawer) closeDrawer();
  }
});
[dModal, viewModal, sModal].forEach((m) =>
  m.addEventListener('pointerdown', (e) => { if (e.target === m) m.hidden = true; }));

window.addEventListener('resize', () => {
  for (const e of state.sessions.values()) fitSoon(e);
});

// Coming back to a backgrounded window is exactly when the GPU has thrown our
// contexts away, so redraw everything on the way in. Ctrl+Alt+R is the manual
// version for anything that still slips through.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) requestAnimationFrame(repaintAll);
});
window.addEventListener('focus', () => requestAnimationFrame(repaintAll));
document.addEventListener('keydown', (e) => {
  if (isRepaintKey(e)) { e.preventDefault(); repaintAll(); }
});

// A door into the terminal plumbing for the console and for the UI tests, which
// otherwise have no way to reach anything inside this closure.
window.kiln = {
  entry: (id) => state.sessions.get(String(id)),
  remeasure, repaint, repaintAll, syncScrollArea, settleBottom,
};

applyCamera();
// The home tab is hidden for now, so never open the app into it — anyone whose
// last session ended there would otherwise land on a view with no way out.
showHome(false);
connect();
})();
