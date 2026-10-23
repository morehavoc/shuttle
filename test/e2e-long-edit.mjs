// A long edited recording, its copy built in many short steps (the server started with
// REDACT_STEP_MS=1500), driven the way the owner's page drives it. Viewers get "being updated"
// throughout, then a copy that is the edited length, decodes cleanly, and plays and seeks in
// Chromium and WebKit.
//   REDACT_STEP_MS=1500 sh test/serve.sh → BASE=https://host:port node test/e2e-long-edit.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

const MIN = Number(process.env.MINUTES || 10);
const file = path.join(root, `test/out/long-${MIN}m.mp4`);
if (!existsSync(file)) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', String(MIN * 60), '-c:v', 'libx264', '-bf', '0', '-g', '30', '-preset', 'ultrafast', '-b:v', '3M', '-maxrate', '3M', '-bufsize', '3M', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-use_editlist', '0', '-frag_duration', '1000000', '-movflags', 'empty_moov+default_base_moof', file]);
}
const bytes = readFileSync(file);
const L = MIN * 60;
const CUTS = [[100, 160], [300.2, 300.9]], TRIM = { start: 3.4, end: L - 10 };

let cookie = '';
const call = (p, o = {}) => fetch(BASE + p, { ...o, headers: { Origin: BASE, Cookie: cookie, ...(o.headers || {}) } });
const login = await call('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const json = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const v = await (await call('/api/videos', { method: 'POST', ...json({ mime: 'video/mp4', mode: 'screen' }) })).json();
let n = 0;
for (let off = 0; off < bytes.length; off += v.partSize) {
  const r = await call(`/api/videos/${v.id}/parts/${++n}`, { method: 'PUT', body: bytes.subarray(off, off + v.partSize) });
  if (!r.ok) throw new Error(`part ${n}: ${r.status}`);
}
const done = await call(`/api/videos/${v.id}/complete`, { method: 'POST', ...json({ durationMs: L * 1000, width: 1920, height: 1080, mime: 'video/mp4' }) });
check(done.ok, `uploaded ${MIN} min, ${(bytes.length / 1e6).toFixed(0)} MB`);

const t0 = Date.now();
let shared = (await (await call(`/api/videos/${v.id}`, { method: 'PATCH', ...json({ cuts: CUTS, trim: TRIM }) })).json()).shared;
let steps = 0, leaked = 0;
while (shared === 'pending' && steps < 500) {
  // A viewer gets "being updated", or the copy once it's done; never the stored file.
  const raw = await call(`/raw/${v.id}`, { headers: { Cookie: '' }, method: 'HEAD' });
  if (raw.status !== 404 && !/^"c-/.test(raw.headers.get('etag') || '')) leaked++;
  shared = (await (await call(`/api/videos/${v.id}/redact`, { method: 'POST', ...json({}) })).json()).shared;
  steps++;
}
check(shared === 'ready', `copy built in ${steps} owner calls, ${((Date.now() - t0) / 1000).toFixed(1)} s`, `shared: ${shared} after ${steps}`);
check(!leaked, 'viewers got "being updated" all through the build', `${leaked} viewer requests got something else`);

const head = await call(`/raw/${v.id}`, { headers: { Cookie: '' }, method: 'HEAD' });
const etag = head.headers.get('etag');
check(/^"c-/.test(etag), `viewers now get the copy (${(Number(head.headers.get('content-length')) / 1e6).toFixed(0)} MB)`);
const out = path.join(root, 'test/out/long-copy.mp4');
writeFileSync(out, Buffer.from(await (await call(`/raw/${v.id}`, { headers: { Cookie: '' } })).arrayBuffer()));
const want = TRIM.end - TRIM.start - 60 - 0.7;
const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
check(Math.abs(dur - want) < 1.1, `the copy is ${dur.toFixed(1)} s (edited length ${want.toFixed(1)} s, start moved to a key frame)`);
let errs = '';
try { execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', out, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { errs = String(e.stderr || e.message); }
check(!errs, 'the copy decodes with no errors', errs.slice(0, 300));
// Byte for byte what one uninterrupted build makes: however many steps it took, and whatever
// failed on the way (run with REDACT_FAIL_PUT to make a segment write fail mid-build).
{
  const { startRedact, redactStep, finishRedact } = await import('../src/redact.js');
  const { withTrim } = await import('../public/timeline.js');
  const read = async (o, l) => new Uint8Array(bytes.buffer, bytes.byteOffset + o, Math.min(l, bytes.length - o));
  let st = await startRedact(read, bytes.length);
  const segs = [];
  st = await redactStep(read, bytes.length, st, { cuts: withTrim(CUTS, TRIM), budgetMs: 1e9, writeSegment: async (c, size) => { segs.push(Buffer.concat(c)); return { key: '', size }; } });
  const want = Buffer.concat([Buffer.from(await finishRedact(read, st)), ...segs]);
  check(want.equals(readFileSync(out)), `the copy is byte for byte one clean build (${process.env.REDACT_FAIL_PUT ? 'a segment write failed on the way' : 'no failure injected'})`);
}

const pv = await (await call(`/api/videos/${v.id}`)).json();
for (const engine of ['webkit', 'chromium']) {
  const browser = await pw[engine].launch(engine === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {});
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/v/${v.id}`);
    await page.waitForSelector('.sp-main');
    await page.click('.sp-big');
    await page.waitForFunction(() => document.querySelector('.sp-main').currentTime > 1, null, { timeout: 20000 }).catch(() => {});
    for (const to of [200, 30, want - 3]) {
      const r = await page.evaluate(async (to) => {
        const m = document.querySelector('.sp-main');
        m.currentTime = to;
        if (m.paused) m.play().catch(() => {});
        const t = performance.now();
        while (performance.now() - t < 8000 && !(m.currentTime > to + 0.8 && !m.seeking)) await new Promise((r) => setTimeout(r, 50));
        return { t: m.currentTime, d: m.duration, err: m.error && m.error.code, ms: Math.round(performance.now() - t) };
      }, to);
      check(!r.err && r.t > to + 0.7, `${engine}: seek to ${to.toFixed(0)} s plays on in ${r.ms} ms (file ${r.d.toFixed(1)} s)`, `${engine}: seek to ${to}: ${JSON.stringify(r)}`);
    }
  } finally { await browser.close(); }
}
await call(`/api/videos/${v.id}`, { method: 'DELETE' });
void pv;
console.log(process.exitCode ? '\nFAILED' : '\nall passed');
