// Embedding (WebKit and Chromium): a video uploaded through the API plays inside another site's
// <iframe> of /e/:id, counts a view, and the share page itself refuses to be framed. The owner's
// "Copy embed code" copies the oEmbed iframe (Chromium, which lets the test read the clipboard).
//   BASE=https://host:port PASSWORD=… node test/e2e-embed.mjs   (server: sh test/serve.sh)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_DIR || path.join(root, '..', 'node_modules', 'playwright'));
const BASE = process.env.BASE || 'http://localhost:8799';
const PASSWORD = process.env.PASSWORD || 'test-password-123';
const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);
const check = (cond, good, bad) => (cond ? ok(good) : fail(bad || good));

// A finished video from test/out/sample.mp4 (see the workflow for the ffmpeg line).
let cookie = '';
const call = (p, o = {}) => fetch(BASE + p, { ...o, headers: { Origin: BASE, Cookie: cookie, ...(o.headers || {}) } });
const login = await call('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const v = await (await call('/api/videos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mime: 'video/mp4', mode: 'screen', title: 'Embed test' }) })).json();
const sample = readFileSync(path.join(root, 'test/out/sample.mp4'));
let n = 0;
for (let off = 0; off < sample.length; off += v.partSize) {
  const r = await call(`/api/videos/${v.id}/parts/${++n}`, { method: 'PUT', body: sample.subarray(off, off + v.partSize) });
  if (!r.ok) throw new Error(`part ${n}: ${r.status}`);
}
const done = await call(`/api/videos/${v.id}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ durationMs: 20000, width: 1280, height: 720, mime: 'video/mp4' }) });
if (!done.ok) throw new Error(`complete: ${done.status}`);
const views = async () => (await (await call(`/api/videos/${v.id}`)).json()).views;

for (const engine of ['webkit', 'chromium']) {
  const browser = await pw[engine].launch(engine === 'chromium' ? { args: [
    '--autoplay-policy=no-user-gesture-required',
    // The test server is on a tailnet address and the fake blog counts as public, so Chrome's
    // private-network checks would block the frame. The real site is public; turn them off.
    '--disable-features=PrivateNetworkAccessForNavigations,PrivateNetworkAccessForWorkers,BlockInsecurePrivateNetworkRequests,LocalNetworkAccessChecks',
  ] } : {});
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 900, height: 700 } });
  const page = await ctx.newPage();
  try {
    const before = await views();
    // "Another site": a page of its own with the embed in it, and the share page tried in a second frame.
    // Served as https://blog.example (a real site's origin: frame-ancestors * doesn't cover about:blank).
    await page.route('https://blog.example/**', (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><h1>A blog post</h1><iframe id="e" src="${BASE}/e/${v.id}" width="640" height="360" allow="fullscreen" allowfullscreen></iframe>
      <iframe id="v" src="${BASE}/v/${v.id}" width="640" height="360"></iframe>` }));
    await page.goto('https://blog.example/post');
    const frame = await (await page.waitForSelector('#e')).contentFrame();
    await frame.waitForSelector('.sp', { timeout: 15000 });
    await frame.click('.sp');
    await frame.waitForFunction(() => { const m = document.querySelector('.sp video'); return m && m.currentTime > 1; }, null, { timeout: 15000 });
    ok(`${engine}: the embed plays inside another site's page`);
    const box = await frame.evaluate(() => { const r = document.querySelector('.sp').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    check(box[0] === 640 && box[1] === 360, `${engine}: the player fills the 640×360 frame`, `${engine}: player ${box}`);
    let after = before;
    for (let i = 0; i < 20 && after === before; i++) { await page.waitForTimeout(250); after = await views(); }
    check(after === before + 1, `${engine}: playing the embed counts one view`, `${engine}: views ${before} → ${after}`);
    const shareFramed = await (await (await page.$('#v')).contentFrame()).evaluate(() => !!document.querySelector('.share-main')).catch(() => false);
    check(!shareFramed, `${engine}: the share page itself won't load in another site's frame`);
    if (engine === 'chromium') {
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
      await ctx.addCookies(cookie.split('; ').map((c) => { const [name, ...rest] = c.split('='); return { name, value: rest.join('='), url: BASE }; }));
      await page.goto(`${BASE}/v/${v.id}`);
      await page.waitForSelector('#copy-embed');
      await page.waitForTimeout(500);
      await page.click('#copy-embed');
      await page.waitForTimeout(300);
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      check(copied.startsWith(`<iframe src="${BASE}/e/${v.id}"`), 'owner: Copy embed code copies the iframe', copied.slice(0, 120));
    }
  } catch (e) { fail(`${engine}: ${e.message.split('\n')[0]}`); }
  await browser.close();
}
await call(`/api/videos/${v.id}`, { method: 'DELETE' });
