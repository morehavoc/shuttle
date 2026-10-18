// The first view right after a recording (WebKit and Chromium). The server adds a fast-start
// index to the file in the background after "complete"; on Cloudflare a long recording's lands
// seconds later, while the share page is already playing. The player must keep playing and
// seeking across that moment. Uses a 3-minute recorder-style MP4 (one fragment a second).
//   INDEX_DELAY_MS=6000 INDEX_WAIT_MS=1000 sh test/serve.sh → EXPECT=late node test/e2e-first-view.mjs
//     the index lands after the page opened: the page keeps the file as stored (?ix=0)
//   sh test/serve.sh → EXPECT=early node test/e2e-first-view.mjs
//     "complete" waited for the index: the page opens with it (?ix=1)
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_DIR || path.join(root, '..', 'node_modules', 'playwright'));
const BASE = process.env.BASE || 'http://localhost:8799';
const PASSWORD = process.env.PASSWORD || 'test-password-123';
const EXPECT = process.env.EXPECT || '';
const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);
const check = (cond, good, bad) => (cond ? ok(good) : fail(bad || good));

const file = path.join(root, 'test/out/long-moof.mp4');
if (!existsSync(file)) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '180', '-c:v', 'libx264', '-bf', '0', '-g', '30', '-preset', 'ultrafast', '-b:v', '3M', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', file]);
}
const bytes = readFileSync(file);

let cookie = '';
const call = (p, o = {}) => fetch(BASE + p, { ...o, headers: { Origin: BASE, Cookie: cookie, ...(o.headers || {}) } });
const login = await call('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

// One finished recording, as Stop leaves it: uploaded, completed, index not there yet.
async function recording() {
  const v = await (await call('/api/videos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mime: 'video/mp4', mode: 'screen' }) })).json();
  let n = 0;
  for (let off = 0; off < bytes.length; off += v.partSize) {
    const r = await call(`/api/videos/${v.id}/parts/${++n}`, { method: 'PUT', body: bytes.subarray(off, off + v.partSize) });
    if (!r.ok) throw new Error(`part ${n}: ${r.status}`);
  }
  const done = await call(`/api/videos/${v.id}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ durationMs: 180000, width: 1920, height: 1080, mime: 'video/mp4' }) });
  if (!done.ok) throw new Error(`complete: ${done.status}`);
  return v.id;
}
const indexed = async (id) => Number((await call(`/raw/${id}`, { method: 'HEAD' })).headers.get('content-length')) > bytes.length;

for (const engine of ['webkit', 'chromium']) {
  const browser = await pw[engine].launch(engine === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {});
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 860 } });
  await ctx.addCookies(cookie.split('; ').map((c) => { const [name, ...rest] = c.split('='); return { name, value: rest.join('='), url: BASE }; }));
  const page = await ctx.newPage();
  const errors = [], raw = new Set();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/raw/')) raw.add(u.search || '(none)'); });
  try {
    const id = await recording();
    const early = !(await indexed(id));
    await page.goto(`${BASE}/v/${id}?new=1`);
    await page.waitForSelector('.sp video');
    await page.click('.sp');
    const main = '.sp video';
    await page.waitForFunction((s) => document.querySelector(s).currentTime > 1, main, { timeout: 20000 });
    ok(`${engine}: plays from the start (index ${early ? 'not there yet' : 'already there'} when the page opened)`);
    if (EXPECT) check(early === (EXPECT === 'late'), `${engine}: the index was ${EXPECT === 'late' ? 'not there yet' : 'there'}, as this run expects`);
    const asked = [...raw].join(' ');
    check(asked === (early ? '?ix=0' : '?ix=1'), `${engine}: the page asks for the file as it was when it opened (${asked})`, `${engine}: requested ${asked}`);
    for (let i = 0; i < 80 && !(await indexed(id)); i++) await page.waitForTimeout(250);
    check(await indexed(id), `${engine}: the index ${early ? 'landed while the page was playing' : 'is there'}`);
    // Seeks after it landed: each is a new range request deep into the file.
    for (const t of [150, 60, 175]) {
      const res = await page.evaluate(async ([s, t]) => {
        const v = document.querySelector(s);
        v.currentTime = t;
        if (v.paused) v.play().catch(() => {});
        const t0 = performance.now();
        while (performance.now() - t0 < 12000) {
          await new Promise((r) => setTimeout(r, 200));
          if (v.error) return { error: v.error.code, at: v.currentTime };
          if (v.currentTime > t + 1 && v.currentTime < t + 6) return { ok: true, at: v.currentTime };
        }
        return { stuck: true, at: v.currentTime, ready: v.readyState };
      }, [main, t]);
      check(res.ok, `${engine}: seeking to ${t}s after the index landed plays on`, `${engine}: seek to ${t}s: ${JSON.stringify(res)}`);
    }
  } catch (e) { fail(`${engine}: ${e.message.split('\n')[0]}`); }
  check(!errors.length, `${engine}: no page errors`, `${engine}: ${errors.join(' | ')}`);
  await browser.close();
}
