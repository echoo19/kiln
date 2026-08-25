/*
 * Codex notify relay. Codex runs this program with one JSON argument on
 * events like agent-turn-complete (configured via -c notify=[...] at spawn).
 * Forwards the event type to the kiln server so codex cards get a real
 * READY signal instead of guessing from output. Exits 0 in all cases.
 * No-op outside kiln terminals.
 */
const sid = process.env.KILN_SESSION;
if (!sid) process.exit(0);
setTimeout(() => process.exit(0), 3000).unref();

let type = '';
try { type = JSON.parse(process.argv[2] || '{}').type || ''; } catch { /* forward empty */ }
const body = JSON.stringify({
  sessionId: sid,
  event: { hook_event_name: 'CodexNotify', notification_type: type },
});
const req = require('http').request({
  host: '127.0.0.1',
  port: Number(process.env.KILN_PORT) || 5456,
  path: '/api/hook',
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
}, () => process.exit(0));
req.on('error', () => process.exit(0));
req.end(body);
