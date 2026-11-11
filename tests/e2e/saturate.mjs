// Runs inside the browserless container (TOKEN comes from its environment).
// Opens N real Chromium CDP sessions, then probes an extra request and /pressure
// while they are held. Prints one JSON line when saturated and one when released.
const N = Number(process.env.N ?? 2), HOLD = Number(process.env.HOLD_MS ?? 30000);
const base = 'ws://127.0.0.1:3000', http = 'http://127.0.0.1:3000';
const token = process.env.TOKEN;
const out = { opened: 0, closed: [], extra: null, pressure: null };
const sockets = [];
for (let i = 0; i < N; i++) {
  const ws = new WebSocket(`${base}/chromium?token=${token}&timeout=${HOLD + 30000}`);
  ws.onopen = () => { out.opened++; ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' })); };
  ws.onclose = (e) => out.closed.push(e.code);
  ws.onerror = () => {};
  sockets.push(ws);
}
await new Promise((r) => setTimeout(r, Number(process.env.SETTLE_MS ?? 8000)));
out.extra = await fetch(`${http}/chromium/content`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ html: '<p>extra</p>' }), signal: AbortSignal.timeout(4000),
}).then((r) => r.status, (e) => `error:${e.name}`);
out.pressure = await fetch(`${http}/pressure`, { headers: { Accept: 'text/plain', Authorization: `Bearer ${token}` } })
  .then((r) => r.status, (e) => `error:${e.name}`);
console.log(JSON.stringify({ phase: 'saturated', ...out }));
await new Promise((r) => setTimeout(r, HOLD));
for (const ws of sockets) ws.close();
await new Promise((r) => setTimeout(r, 3000));
out.pressure = await fetch(`${http}/pressure`, { headers: { Accept: 'text/plain', Authorization: `Bearer ${token}` } })
  .then((r) => r.status, (e) => `error:${e.name}`);
console.log(JSON.stringify({ phase: 'released', ...out }));
process.exit(0);
