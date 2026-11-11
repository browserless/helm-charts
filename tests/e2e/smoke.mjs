// Runs inside the browserless container (TOKEN comes from its environment); real Chromium via the local HTTP API.
const base = 'http://127.0.0.1:3000';
const token = process.env.TOKEN;
const auth = { Authorization: `Bearer ${token}` };
const out = {};
out.unauthorized = (await fetch(`${base}/pressure`, { headers: { Accept: 'text/plain' } })).status;
out.pressure = (await fetch(`${base}/pressure`, { headers: { ...auth, Accept: 'text/plain' } })).status;
const html = '<html><body><h1 id="h">chart smoke</h1><script>document.getElementById("h").dataset.answer = String(6*7)</script></body></html>';
const content = await fetch(`${base}/chromium/content`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ html }) });
const text = await content.text();
out.content = { status: content.status, jsExecuted: text.includes('data-answer="42"') };
const shot = await fetch(`${base}/chromium/screenshot`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ html }) });
const png = Buffer.from(await shot.arrayBuffer());
out.screenshot = { status: shot.status, bytes: png.length, png: png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) };
console.log(JSON.stringify(out));
if (out.unauthorized !== 401 || out.pressure !== 200 || !out.content.jsExecuted || !out.screenshot.png) process.exit(1);
