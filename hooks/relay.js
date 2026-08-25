/*
 * Claude Code hook relay. Reads the hook event from stdin and forwards it to
 * the kiln server with the session id from the environment. Exits 0 in
 * all cases so hooks never block the agent. No-op outside kiln terminals.
 */
const sid = process.env.KILN_SESSION;
if (!sid) process.exit(0);
setTimeout(() => process.exit(0), 3000).unref();

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(raw); } catch { /* forward empty */ }
  const body = JSON.stringify({ sessionId: sid, event });
  const req = require('http').request({
    host: '127.0.0.1',
    port: Number(process.env.KILN_PORT) || 5456,
    path: '/api/hook',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  }, () => process.exit(0));
  req.on('error', () => process.exit(0));
  req.end(body);
});
