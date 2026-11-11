// Runs inside a browserless container (TOKEN comes from its environment) as a
// client of the Service SERVICE (http://<name>:<port>) of a release whose pod
// IPs are PODS (comma-separated). It asks each pod's /pressure directly how many
// sessions it holds, to see which pod a connection through the Service reached.
// 1. Stateless requests, each on a new TCP connection, one at a time, until every
//    pod has served one (at most MAX): waitForTimeout keeps each running for 3 s.
// 2. WebSocket CDP sessions, each on its own connection, until every pod holds
//    one (at most MAX). Then every session answers, the first session is closed,
//    and every other session still answers.
// Prints one JSON line: the pod index that served each request and each session.
import http from 'node:http';

const { SERVICE, PODS, TOKEN } = process.env;
const MAX = Number(process.env.MAX ?? 16);
const pods = PODS.split(',');
const auth = { Authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { pods: pods.length, requests: [], sessions: [] };
const fail = (e) => { out.error = String(e.message ?? e); console.log(JSON.stringify(out)); process.exit(1); };

const held = () => Promise.all(pods.map(async (ip) => {
  const { pressure } = await (await fetch(`http://${ip}:3000/pressure`, { headers: auth })).json();
  return pressure.running + pressure.queued;
}));
// Waits until the pods hold `total` sessions in all; returns the count per pod.
async function settle(total) {
  let counts = [];
  for (let i = 0; i < 100; i++) {
    counts = await held();
    if (counts.reduce((a, b) => a + b, 0) === total) return counts;
    await sleep(100);
  }
  throw new Error(`pods hold ${counts.join('+')} sessions, expected ${total}`);
}

// agent: false opens a new connection for the request and closes it afterwards.
const content = (marker) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ html: `<p id=m>${marker}</p>`, waitForTimeout: 3000 });
  const req = http.request(`${SERVICE}/chromium/content`, {
    method: 'POST', agent: false,
    headers: { ...auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { text += d; });
    res.on('end', () => (res.statusCode === 200 && text.includes(marker) ? resolve() : reject(new Error(`request ${marker}: ${res.statusCode}`))));
  });
  req.on('error', reject);
  req.end(body);
});

function session(n) {
  const ws = new WebSocket(`${SERVICE.replace(/^http/, 'ws')}/chromium?token=${TOKEN}&timeout=180000`);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    pending.get(d.id)?.(d);
    pending.delete(d.id);
  };
  ws.call = (method) => new Promise((resolve, reject) => {
    const i = ++id;
    const timer = setTimeout(() => reject(new Error(`session ${n}: ${method} timed out`)), 15000);
    pending.set(i, (d) => { clearTimeout(timer); d.error ? reject(new Error(JSON.stringify(d.error))) : resolve(d.result); });
    ws.send(JSON.stringify({ id: i, method }));
  });
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`session ${n}: websocket error`));
  });
}

try {
  if ((await settle(0)).length !== pods.length) throw new Error('pod count');
  for (let i = 1; i <= MAX && pods.some((_, p) => !out.requests.includes(p)); i++) {
    const reply = content(`request-${i}`);
    out.requests.push((await settle(1)).indexOf(1));
    await reply;
    await settle(0);
  }
  if (pods.some((_, p) => !out.requests.includes(p))) throw new Error('some pod served no request');

  const sockets = [];
  for (let i = 1; i <= MAX && pods.some((_, p) => !out.sessions.includes(p)); i++) {
    const before = await settle(sockets.length);
    const ws = await session(i);
    await ws.call('Browser.getVersion');
    const after = await settle(sockets.length + 1);
    out.sessions.push(after.findIndex((c, p) => c > before[p]));
    sockets.push(ws);
  }
  if (pods.some((_, p) => !out.sessions.includes(p))) throw new Error('some pod held no session');
  out.answered = (await Promise.all(sockets.map((ws) => ws.call('Browser.getVersion')))).length;
  sockets[0].close();
  await settle(sockets.length - 1);
  out.answeredAfterClose = (await Promise.all(sockets.slice(1).map((ws) => ws.call('Browser.getVersion')))).length;
  for (const ws of sockets.slice(1)) ws.close();
  await settle(0);
  console.log(JSON.stringify(out));
  process.exit(0);
} catch (e) {
  fail(e);
}
