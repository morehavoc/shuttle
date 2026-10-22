// An edited video as a viewer sees it, in WebKit and Chromium: the share page and the embed play
// the server's edited copy (no frame from inside a cut ever reaches the screen, screen or
// camera), it plays through to the end with no error, seeks work, the owner's page says what
// viewers get, and a viewer who opens the page while the copy is being made gets it once it's
// ready. Every frame of the test recordings carries its frame number (media-fixtures.mjs), read
// back here from the frames the browser actually presents.
//   BASE=https://host:port node test/e2e-edited.mjs   (server: sh test/serve.sh)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, srcOf, W, H, BITS } from './media-fixtures.mjs';
import { Timeline } from '../src/redact.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_DIR || path.join(root, '..', 'node_modules', 'playwright'));
const BASE = process.env.BASE || 'http://localhost:8799';
const PASSWORD = process.env.PASSWORD || 'test-password-123';
const STATE = process.env.STATE || '.wrangler/e2e-state';
const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);
const check = (cond, good, bad) => (cond ? ok(good) : fail(bad || good));

const CUTS = [[3.3, 4.6], [6.2, 6.5]], TRIM = { start: 0.7, end: 9.4 }, OFFSET = 0.25;
const mainFile = fixture('e2e-main.mp4', { secret: [[0, 0.7], ...CUTS, [9.4, 99]] });
const camFile = fixture('e2e-cam.mp4', { audio: false });
const SRC = Object.fromEntries(srcOf(mainFile)), CSRC = Object.fromEntries(srcOf(camFile));

let cookie = '';
const call = (p, o = {}) => fetch(BASE + p, { ...o, headers: { Origin: BASE, Cookie: cookie, ...(o.headers || {}) } });
const login = await call('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const d1 = (sql) => execFileSync('npx', ['wrangler', 'd1', 'execute', 'shuttle', '--local', '--env', 'local', '--persist-to', STATE, '--json', '--command', sql],
  { cwd: root, env: { ...process.env, CLOUDFLARE_API_TOKEN: '', CF_API_TOKEN: '' } }).toString();
const redactRow = (id) => JSON.parse(JSON.parse(d1(`SELECT redact FROM videos WHERE id = '${id}'`))[0].results[0].redact);

async function upload() {
  const v = await (await call('/api/videos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mime: 'video/mp4', camMime: 'video/mp4', mode: 'screen-camera', layout: { kind: 'bubble', corner: 'br', size: 'l' } }) })).json();
  for (const [track, f] of [['main', mainFile], ['cam', camFile]]) {
    const b = readFileSync(f);
    let n = 0;
    for (let off = 0; off < b.length; off += v.partSize) {
      const r = await call(`/api/videos/${v.id}/parts/${++n}?track=${track}`, { method: 'PUT', body: b.subarray(off, off + v.partSize) });
      if (!r.ok) throw new Error(`part ${n}: ${r.status}`);
    }
  }
  const done = await call(`/api/videos/${v.id}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ durationMs: 11000, width: W, height: H, mime: 'video/mp4', camMime: 'video/mp4', camOffsetMs: OFFSET * 1000 }) });
  if (!done.ok) throw new Error(`complete: ${done.status}`);
  return v.id;
}
async function edit(id, body) {
  await call(`/api/videos/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (let i = 0; i < 100; i++) {
    const s = (await (await call(`/api/videos/${id}`)).json()).shared;
    if (s === 'ready') return;
    if (s !== 'pending') throw new Error(`shared: ${s}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('copy never ready');
}

// In the page: records the frame number of every frame each video presents (rVFC), with the
// media time it was presented at.
const WATCH = ({ W, H, BITS }) => {
  window.__seen = { main: [], cam: [] };
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  const read = (v) => {
    g.drawImage(v, 0, 0, W, H);
    const row = g.getImageData(0, H >> 1, W, 1).data;
    let n = 0;
    for (let b = 0; b < BITS; b++) if (row[Math.floor((b + 0.5) * W / BITS) * 4] > 128) n |= 1 << b;
    return n;
  };
  for (const [k, sel] of [['main', '.sp-main'], ['cam', '.sp-cam']]) {
    const v = document.querySelector(sel);
    if (!v || !v.requestVideoFrameCallback) continue;
    const cb = (now, meta) => { window.__seen[k].push({ t: meta.mediaTime, n: read(v) }); v.requestVideoFrameCallback(cb); };
    v.requestVideoFrameCallback(cb);
  }
};

const id = await upload();
await edit(id, { cuts: CUTS, trim: TRIM });
const red = redactRow(id);
const tl = new Timeline(red.cuts);
const edited = red.durationMs / 1000;
ok(`the copy is ready: ${edited.toFixed(2)} s (from 11 s)`);

function judge(engine, label, seen, src, offset) {
  const bad = seen.filter((f) => src[f.n] === undefined || tl.inCut(src[f.n] + offset));
  check(seen.length > 20 && !bad.length, `${engine}: ${label}: ${seen.length} frames shown, none from a cut`,
    `${engine}: ${label}: ${seen.length} frames, ${bad.length} from cut time or unreadable (${bad.slice(0, 5).map((f) => `#${f.n}@${f.t.toFixed(2)}`).join(' ')})`);
  // Each frame at its edited time; a frame held after a cut shows up to ~1 s early.
  const off = seen.filter((f) => src[f.n] !== undefined).map((f) => (tl.edited(src[f.n] + offset) - offset) - f.t).filter((d) => d < -0.05 || d > 1.05);
  check(!off.length, `${engine}: ${label}: every frame at its place in the edited video`, `${engine}: ${label}: ${off.length} frames out of place (${off.slice(0, 5).map((d) => d.toFixed(2)).join(' ')})`);
}

for (const engine of ['webkit', 'chromium']) {
  const browser = await pw[engine].launch(engine === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {});
  try {
    // ---- a viewer, start to end ----
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    const errors = [];
    const raw = new Set();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/raw/')) raw.add(u.pathname + u.search); });
    await page.goto(`${BASE}/v/${id}`);
    await page.waitForSelector('.sp-main');
    await page.evaluate(WATCH, { W, H, BITS });
    await page.click('.sp-big');
    const end = await page.waitForFunction(() => {
      const v = document.querySelector('.sp-main');
      return (v.ended || document.querySelector('.sp-end:not([hidden])')) && { t: v.currentTime, d: v.duration, err: v.error && v.error.code };
    }, null, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);
    check(end && !end.err, `${engine}: viewer: plays to the end with no error (${end && end.t.toFixed(2)} s of ${end && end.d.toFixed(2)})`, `${engine}: viewer: didn't reach the end: ${JSON.stringify(end)}`);
    check(end && Math.abs(end.d - edited) < 0.15, `${engine}: viewer: the file is the edited length`);
    const asked = [...raw];
    check(asked.length && asked.every((u) => u.endsWith(`?r=${red.ver}`)), `${engine}: viewer: asks only for the copy (${asked.join(', ')})`);
    const seen = await page.evaluate(() => window.__seen);
    judge(engine, 'screen', seen.main, SRC, 0);
    judge(engine, 'camera', seen.cam, CSRC, OFFSET);
    check(!errors.length, `${engine}: viewer: no page errors`, `${engine}: ${errors.join(' | ')}`);

    // ---- seeks: into the middle, across the first cut point, near the end ----
    for (const to of [2.0, 4.5, edited - 1.2]) {
      await page.evaluate(() => { window.__seen = { main: [], cam: [] }; });
      await page.evaluate(WATCH, { W, H, BITS });
      const res = await page.evaluate(async (to) => {
        const v = document.querySelector('.sp-main');
        v.currentTime = to;
        if (v.paused) v.play().catch(() => {});
        const t0 = performance.now();
        while (performance.now() - t0 < 6000 && !(v.currentTime > to + 0.6 && !v.seeking)) await new Promise((r) => setTimeout(r, 50));
        return { t: v.currentTime, err: v.error && v.error.code };
      }, to);
      const s = await page.evaluate(() => window.__seen.main);
      const bad = s.filter((f) => SRC[f.n] === undefined || tl.inCut(SRC[f.n]));
      check(!res.err && res.t > to + 0.5 && !bad.length, `${engine}: seek to ${to.toFixed(1)} s: plays on (${s.length} frames, none cut)`, `${engine}: seek to ${to}: ${JSON.stringify(res)}, ${bad.length} bad frames`);
    }
    await ctx.close();

    // ---- the embed ----
    const ectx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 800, height: 450 } });
    const ep = await ectx.newPage();
    await ep.goto(`${BASE}/e/${id}`);
    await ep.waitForSelector('.sp-main');
    await ep.evaluate(WATCH, { W, H, BITS });
    await ep.click('.sp-big');
    await ep.waitForFunction(() => document.querySelector('.sp-main').currentTime > 2.5, null, { timeout: 15000 }).catch(() => {});
    const es = await ep.evaluate(() => window.__seen.main);
    check(es.length > 20 && es.every((f) => SRC[f.n] !== undefined && !tl.inCut(SRC[f.n])), `${engine}: embed: plays the copy (${es.length} frames, none cut)`);
    await ectx.close();

    // ---- the owner ----
    const octx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 860 } });
    await octx.addCookies(cookie.split('; ').map((c) => { const [name, ...rest] = c.split('='); return { name, value: rest.join('='), url: BASE }; }));
    const op = await octx.newPage();
    const oraw = new Set();
    op.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/raw/')) oraw.add(u.search); });
    await op.goto(`${BASE}/v/${id}`);
    await op.waitForSelector('.shared-note');
    const note = await op.textContent('.shared-note');
    check(/Viewers get a copy with your trims and cuts removed/.test(note), `${engine}: owner: "${note}"`);
    await op.click('.sp-big');
    await op.waitForFunction(() => document.querySelector('.sp-main').currentTime > 1, null, { timeout: 15000 }).catch(() => {});
    check([...oraw].every((q) => !q.includes('r=')), `${engine}: owner: plays the recording as stored (${[...oraw].join(' ')})`);
    await octx.close();

    // ---- a viewer who arrives while the copy is being made ----
    if (engine === 'chromium') {
      const r = redactRow(id);
      d1(`UPDATE videos SET redact = '${JSON.stringify({ sig: r.sig + 'z', state: 'pending', ver: 'waitver', tries: 0, since: 0, claim: null, job: null })}' WHERE id = '${id}'`);
      const wctx = await browser.newContext({ ignoreHTTPSErrors: true });
      const wp = await wctx.newPage();
      await wp.goto(`${BASE}/v/${id}`);
      check(/Updating this video/.test(await wp.textContent('#pending')), 'chromium: viewer during a build: "Updating this video…"');
      // The owner's page (or the hourly job) carries the build on; the waiting page reloads into it.
      await call(`/api/videos/${id}/redact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const got = await wp.waitForSelector('.sp-main', { timeout: 15000 }).then(() => true).catch(() => false);
      check(got, 'chromium: viewer during a build: the page loads the video when it\'s ready');
      await wctx.close();
    }
  } finally {
    await browser.close();
  }
}
await call(`/api/videos/${id}`, { method: 'DELETE' });

// ---- recordings made by the browsers' own MediaRecorder (what Shuttle really stores) ----
// A canvas that draws a frame counter as the same 16 blocks, plus a tone, recorded the way the
// recorder does (MP4, a chunk a second); then edited, and the copy decoded and played.
const RECORD = async ({ W, H, BITS, secs }) => {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  let n = 0, on = true;
  const draw = () => {
    for (let b = 0; b < BITS; b++) { g.fillStyle = (n >> b) & 1 ? '#fff' : '#000'; g.fillRect(b * W / BITS, 0, W / BITS, H); }
    n++;
    if (on) requestAnimationFrame(draw);
  };
  draw();
  const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start();
  const s = new MediaStream([...c.captureStream(30).getVideoTracks(), ...d.stream.getAudioTracks()]);
  const mime = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
  const r = new MediaRecorder(s, { mimeType: mime, videoBitsPerSecond: 2_500_000, videoKeyFrameIntervalDuration: 1000 }); // as recorder.js
  const parts = [];
  r.ondataavailable = (e) => parts.push(e.data);
  r.start(1000);
  await new Promise((res) => setTimeout(res, secs * 1000));
  r.stop();
  await new Promise((res) => (r.onstop = res));
  on = false;
  const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
  let out = '';
  for (let i = 0; i < buf.length; i += 0x8000) out += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(out);
};
const { writeFileSync } = await import('node:fs');
const { frames: decodeFrames, dir } = await import('./media-fixtures.mjs');
for (const engine of ['webkit', 'chromium']) {
  const browser = await pw[engine].launch(engine === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {});
  try {
    const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
    await page.goto(`${BASE}/`);
    const b64 = await page.evaluate(RECORD, { W, H, BITS, secs: 9 });
    const rec = path.join(dir, `rec-${engine}.mp4`);
    writeFileSync(rec, Buffer.from(b64, 'base64'));
    const src = Object.fromEntries(srcOf(rec));
    const v = await (await call('/api/videos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mime: 'video/mp4', mode: 'screen' }) })).json();
    await call(`/api/videos/${v.id}/parts/1`, { method: 'PUT', body: readFileSync(rec) });
    await call(`/api/videos/${v.id}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ durationMs: 9000, width: W, height: H, mime: 'video/mp4' }) });
    await edit(v.id, { cuts: [[2.4, 3.9], [5.55, 5.8]], trim: { start: 0.5, end: 8.2 } });
    const r = redactRow(v.id);
    const rtl = new Timeline(r.cuts);
    const copy = path.join(dir, `rec-${engine}-copy.mp4`);
    writeFileSync(copy, Buffer.from(await (await fetch(`${BASE}/raw/${v.id}`)).arrayBuffer()));
    const got = decodeFrames(copy);
    const bad = got.filter((f) => src[f.n] === undefined || rtl.inCut(src[f.n]));
    check(got.length > 100 && !bad.length, `${engine} recording: the copy holds ${got.length} frames, none from a cut`, `${engine} recording: ${bad.length} of ${got.length} frames from cut time (${bad.slice(0, 5).map((f) => f.n).join(' ')})`);
    let errs = '';
    try { execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', copy, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { errs = String(e.stderr || e.message); }
    check(!errs, `${engine} recording: the copy decodes cleanly`, errs.slice(0, 200));
    // Played by the same browser as a viewer, to the end.
    const vp = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
    await vp.goto(`${BASE}/v/${v.id}`);
    await vp.waitForSelector('.sp-main');
    await vp.evaluate(WATCH, { W, H, BITS });
    await vp.click('.sp-big');
    const end = await vp.waitForFunction(() => { const m = document.querySelector('.sp-main'); return m.ended && { d: m.duration, err: m.error && m.error.code }; }, null, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);
    const seen = await vp.evaluate(() => window.__seen.main);
    const sbad = seen.filter((f) => src[f.n] === undefined || rtl.inCut(src[f.n]));
    check(end && !end.err && Math.abs(end.d - r.durationMs / 1000) < 0.2 && seen.length > 50 && !sbad.length,
      `${engine} recording: a viewer plays it to the end (${seen.length} frames shown, none cut)`, `${engine} recording: ${JSON.stringify(end)}, ${sbad.length}/${seen.length} cut frames`);
    await call(`/api/videos/${v.id}`, { method: 'DELETE' });
  } finally {
    await browser.close();
  }
}
console.log(process.exitCode ? '\nFAILED' : '\nall passed');
