// kiln service worker — a pass-through with one job.
//
// The app window is opened by things that do not wait for the server: a login
// item or a pinned app window races the server's own start, and a restart
// leaves any open window pointing at a closed port. Without this, each of those
// shows the browser's "can't connect to 127.0.0.1" page and the only way
// forward is to notice and hit reload.
//
// So: every navigation goes to the network exactly as before, and only when
// the network itself fails (connection refused — the server is not up yet)
// does this answer with a small "starting…" page that polls the server and
// reloads into the app the moment it responds. Nothing else is intercepted
// and nothing is cached, so app.js / style.css / the API / websockets all
// behave exactly as they did without a worker.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(WAITING_PAGE, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })));
});

// Inline on purpose: when this page is shown, no asset on the server is
// reachable, so everything it needs has to travel inside the worker.
const WAITING_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>kiln</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#070708">
<style>
  html,body{height:100%;margin:0;background:#070708;color:#d7d7db;
    font:14px/1.5 ui-monospace,Cascadia Code,Consolas,monospace}
  body{display:flex;align-items:center;justify-content:center}
  main{max-width:34em;padding:2em;text-align:center}
  h1{font-size:16px;font-weight:600;letter-spacing:.02em;margin:0 0 .6em}
  .dot{display:inline-block;width:.55em;height:.55em;border-radius:50%;
    background:#6ee7b7;margin-right:.6em;vertical-align:middle;
    animation:pulse 1.2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}
  p{margin:.4em 0;color:#9a9aa2}
  .late{display:none;margin-top:1.4em;padding-top:1.2em;border-top:1px solid #1d1d22;
    text-align:left}
  .late.show{display:block}
  code{color:#d7d7db}
</style></head><body><main>
  <h1><span class="dot"></span>starting kiln…</h1>
  <p>the server is not answering on this port yet. this page reloads by itself
     as soon as it does.</p>
  <div class="late" id="late">
    <p>still nothing after <span id="secs">0</span>s, so the server probably is
       not running:</p>
    <p>· run <code>kiln</code> in a terminal — that starts it and opens this
       window.</p>
    <p>· if it will not come up, the reason is at the end of
       <code>~/.kiln/server.log</code>.</p>
  </div>
</main>
<script>
  const t0 = Date.now();
  async function probe() {
    try {
      const r = await fetch(location.origin + '/', { cache: 'no-store' });
      if (r.ok) { location.reload(); return; }
    } catch {}
    const secs = Math.round((Date.now() - t0) / 1000);
    document.getElementById('secs').textContent = secs;
    if (secs >= 20) document.getElementById('late').classList.add('show');
    setTimeout(probe, secs < 30 ? 700 : 2000);
  }
  probe();
</script></body></html>`;
