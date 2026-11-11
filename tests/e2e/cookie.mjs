// Runs inside the browserless container (TOKEN comes from its environment).
// MODE=set|get PROFILE=<user data dir> COOKIE=<value> [HOLD_MS=<ms>]: launches real
// Chromium with the profile directory, optionally sets a persistent cookie, reads
// it back, and keeps the session open for HOLD_MS before closing it.
// Chromium commits cookie changes to the profile about every 30 s, and ending the
// session does not flush them (v2.61.0 and v2.62.0 lost a cookie closed after
// 10 s and kept one held for 30 s), so a writer must hold past that interval.
const launch = encodeURIComponent(JSON.stringify({ args: [`--user-data-dir=${process.env.PROFILE}`] }));
const hold = Number(process.env.HOLD_MS ?? 0);
const ws = new WebSocket(`ws://127.0.0.1:3000/chromium?token=${process.env.TOKEN}&launch=${launch}&timeout=${hold + 30000}`);
let id = 0; const pending = new Map();
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params }));
});
ws.onmessage = (m) => {
  const d = JSON.parse(m.data); const p = pending.get(d.id);
  if (p) { pending.delete(d.id); d.error ? p.reject(new Error(JSON.stringify(d.error))) : p.resolve(d.result); }
};
const out = { mode: process.env.MODE };
const fail = (e) => { out.error = String(e.message ?? e); console.log(JSON.stringify(out)); process.exit(1); };
ws.onerror = () => out.done || fail(new Error('websocket error'));
ws.onclose = (e) => { if (!out.done) fail(new Error(`closed ${e.code} ${e.reason}`)); };
ws.onopen = async () => {
  try {
    out.product = (await call('Browser.getVersion')).product;
    if (process.env.MODE === 'set') {
      await call('Storage.setCookies', { cookies: [{ name: 'persist', value: process.env.COOKIE, domain: 'persist.test', path: '/', expires: Math.floor(Date.now() / 1000) + 86400 }] });
    }
    const { cookies } = await call('Storage.getCookies');
    out.cookie = cookies.find((c) => c.name === 'persist' && c.domain === 'persist.test')?.value ?? null;
    await new Promise((r) => setTimeout(r, hold));
    out.done = true;
    await call('Browser.close').catch(() => {});
    console.log(JSON.stringify(out));
    setTimeout(() => process.exit(0), 1500);
  } catch (e) { fail(e); }
};
