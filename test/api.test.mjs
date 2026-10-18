// API contract test. Starts `wrangler dev --env local` (local R2 + D1, fake transcription),
// drives the whole lifecycle, stops it. Usage: npm test
// (or BASE=http://127.0.0.1:8799 node test/api.test.mjs against one already running with
//  OWNER_PASSWORD=test-password-123 and TRANSCRIBE_FAKE=1).

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8799;
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const PASSWORD = 'test-password-123';
let server;

// Never let a local run pick up Cloudflare credentials from the environment.
export function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CF_KV_NAMESPACE_ID']) delete env[k];
  return env;
}

async function startServer() {
  if (process.env.BASE) return;
  // Fresh state every run (the login-throttle test leaves failures behind for 15 minutes).
  rmSync(path.join(root, '.wrangler/test-state'), { recursive: true, force: true });
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'shuttle', '--local', '--env', 'local', '--persist-to', '.wrangler/test-state'], { cwd: root, stdio: 'ignore', env: cleanEnv() });
  server = spawn('npx', ['wrangler', 'dev', '--env', 'local', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', '.wrangler/test-state',
    '--var', `OWNER_PASSWORD:${PASSWORD}`, '--var', 'TRANSCRIBE_FAKE:1', '--show-interactive-dev-session=false'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: cleanEnv() });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${BASE}/api/me`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start:\n' + log);
}
function stopServer() { if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch {} } }

let cookie = '';
async function call(p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookie && !opts.anon) headers.Cookie = cookie;
  let body = opts.body;
  if (body && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer) && typeof body !== 'string') { body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  return fetch(BASE + p, { method: opts.method || 'GET', headers, body, redirect: 'manual' });
}
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`not JSON (${r.status}): ${t.slice(0, 200)}`); } };

// 16 kHz mono 16-bit WAV of `seconds`, a tone so it isn't silent.
function wav(seconds) {
  const n = Math.round(16000 * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), 44 + i * 2);
  return new Uint8Array(buf);
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['ok', name]); console.log('  ok  ', name); }
  catch (e) { results.push(['FAIL', name]); console.log('  FAIL', name, '\n       ', e.message); }
}

try {
  await startServer();
  const sample = readFileSync(path.join(root, 'test/out/sample.mp4'));
  const me0 = await j(await call('/api/me'));
  const PART = me0.partSize;
  let id;

  await test('anonymous is not owner, owner APIs refuse', async () => {
    assert.equal(me0.owner, false);
    assert.equal(me0.transcripts, true);
    assert.equal((await call('/api/videos')).status, 401);
    assert.equal((await call('/api/videos', { method: 'POST', body: { mime: 'video/mp4' } })).status, 401);
  });

  await test('wrong password refused', async () => {
    const r = await call('/api/login', { method: 'POST', body: { password: 'nope' } });
    assert.equal(r.status, 401);
  });

  await test('login sets a session cookie', async () => {
    const r = await call('/api/login', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(r.status, 200);
    const sc = r.headers.get('set-cookie');
    assert.match(sc, /^__Host-shuttle_session=\d+\.[\w-]+;/);
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /; Secure/);
    assert.match(sc, /; Path=\/;/);
    assert.doesNotMatch(sc, /Domain=/i);
    cookie = sc.split(';')[0];
    assert.equal((await j(await call('/api/me'))).owner, true);
  });

  await test('forged cookie is refused', async () => {
    const r = await call('/api/videos', { anon: true, headers: { Cookie: `__Host-shuttle_session=${Date.now() + 1e9}.AAAA` } });
    assert.equal(r.status, 401);
  });

  await test('cross-origin write refused', async () => {
    const r = await call('/api/videos', { method: 'POST', body: { mime: 'video/mp4' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
  });

  await test('bad mime refused', async () => {
    assert.equal((await call('/api/videos', { method: 'POST', body: { mime: 'text/html' } })).status, 400);
    assert.equal((await call('/api/videos', { method: 'POST', body: { mime: 'video/mp4', camMime: 'text/html' } })).status, 400);
  });

  await test('create a screen + camera video (two tracks)', async () => {
    const r = await call('/api/videos', { method: 'POST', body: {
      mime: 'video/mp4;codecs=avc1,mp4a.40.2', camMime: 'video/mp4', mode: 'screen-camera', tz: 'America/New_York',
      surface: 'window', layout: { kind: 'card', corner: 'br', size: 'l' },
    } });
    assert.equal(r.status, 201);
    const v = await j(r);
    id = v.id;
    assert.match(id, /^[A-Za-z0-9]{12}$/);
    assert.equal(v.partSize, PART);
    assert.equal(v.hasCam, true);
    assert.match(v.title, /^Recording · /);
  });

  await test('share page while recording shows pending', async () => {
    const html = await (await call(`/v/${id}`, { anon: true })).text();
    assert.match(html, /Finishing upload/);
    assert.equal((await j(await call(`/api/videos/${id}/status`, { anon: true }))).status, 'recording');
    assert.equal((await call(`/raw/${id}`, { anon: true })).status, 404);
  });

  await test('oversize part and bad track refused', async () => {
    assert.equal((await call(`/api/videos/${id}/parts/1`, { method: 'PUT', body: new Uint8Array(PART + 1) })).status, 400);
    assert.equal((await call(`/api/videos/${id}/parts/1?track=evil`, { method: 'PUT', body: new Uint8Array(10) })).status, 400);
  });

  await test('upload main parts (fixed size + remainder) and a camera part', async () => {
    let n = 0;
    for (let off = 0; off < sample.length; off += PART) {
      n++;
      const r = await call(`/api/videos/${id}/parts/${n}`, { method: 'PUT', body: new Uint8Array(sample.subarray(off, off + PART)) });
      const body = await j(r);
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.equal(body.partNumber, n);
      assert.equal(body.track, 'main');
    }
    assert.equal(n, 2);
    const r = await call(`/api/videos/${id}/parts/1?track=cam`, { method: 'PUT', body: new Uint8Array(sample.subarray(0, 300000)) });
    assert.equal(r.status, 200);
    assert.equal((await j(r)).track, 'cam');
  });

  await test('audio chunks: transcribed in the background; silence skipped', async () => {
    let r = await call(`/api/videos/${id}/audio/0`, { method: 'PUT', body: wav(6), headers: { 'X-Start-Ms': '0', 'X-Duration-Ms': '6000' } });
    assert.equal(r.status, 200);
    assert.equal((await j(r)).status, 'pending');
    r = await call(`/api/videos/${id}/audio/1`, { method: 'PUT', body: new Uint8Array(0), headers: { 'X-Start-Ms': '6000', 'X-Duration-Ms': '4000', 'X-Silent': '1' } });
    assert.equal((await j(r)).status, 'ready');
    r = await call(`/api/videos/${id}/audio/2`, { method: 'PUT', body: wav(4), headers: { 'X-Start-Ms': '10000', 'X-Duration-Ms': '4000' } });
    assert.equal(r.status, 200);
    let t;
    for (let i = 0; i < 40; i++) {
      t = await j(await call(`/api/videos/${id}/transcript`));
      if (t.status !== 'pending') break;
      await new Promise((res) => setTimeout(res, 250));
    }
    assert.equal(t.status, 'ready');
    assert.ok(t.words.length > 5, `words: ${t.words.length}`);
    assert.ok(t.words.some((w) => w.s >= 10), 'second chunk offset by its start');
    assert.ok(t.words.every((w, i) => i === 0 || w.s >= t.words[i - 1].s), 'sorted');
    assert.ok(t.words.every((w) => !(w.s >= 6 && w.s < 10)), 'nothing in the silent chunk');
  });

  await test('audio chunk validation', async () => {
    assert.equal((await call(`/api/videos/${id}/audio/9`, { method: 'PUT', body: new Uint8Array(10), headers: { 'X-Start-Ms': '0' } })).status, 400);
    assert.equal((await call(`/api/videos/${id}/audio/9`, { method: 'PUT', anon: true, body: wav(1) })).status, 401);
  });

  await test('thumbnails: poster, camera and link-preview variants', async () => {
    const jpg = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', path.join(root, 'test/out/sample.mp4'), '-frames:v', '1', '-f', 'mjpeg', '-'], { maxBuffer: 1e7 });
    for (const variant of ['poster', 'cam']) {
      const r = await call(`/api/videos/${id}/thumb?variant=${variant}`, { method: 'PUT', body: new Uint8Array(jpg) });
      assert.equal(r.status, 200);
    }
    assert.equal((await call(`/api/videos/${id}/thumb?variant=evil`, { method: 'PUT', body: new Uint8Array(jpg) })).status, 400);
    assert.equal((await call(`/thumb/${id}.jpg`, { anon: true })).headers.get('content-type'), 'image/jpeg');
    assert.equal((await call(`/thumb/${id}/cam.jpg`, { anon: true })).headers.get('content-type'), 'image/jpeg');
    // og falls back to the poster until it exists
    assert.equal((await call(`/thumb/${id}/og.jpg`, { anon: true })).headers.get('content-type'), 'image/jpeg');
  });

  await test('complete closes both tracks', async () => {
    const r = await call(`/api/videos/${id}/complete`, { method: 'POST', body: {
      durationMs: 20000, width: 1280, height: 720, mime: 'video/mp4', camMime: 'video/mp4', camOffsetMs: 42, camMutedMs: 0, surface: 'window',
      audioChunks: 3, tapGapMs: 0,
    } });
    const v = await j(r);
    assert.equal(r.status, 200, JSON.stringify(v));
    assert.equal(v.status, 'ready');
    assert.equal(v.size, sample.length);
    assert.equal(v.camSize, 300000);
    assert.equal(v.hasCam, true);
    assert.equal(v.camOffsetMs, 42);
    assert.equal(v.durationMs, 20000);
    assert.deepEqual(v.layout, { kind: 'card', corner: 'br', size: 'l' });
    assert.equal(v.surface, 'window');
  });

  await test('transcript stays complete when every chunk the recorder made arrived', async () => {
    assert.equal((await j(await call(`/api/videos/${id}/transcript`))).status, 'ready');
  });

  await test('complete is idempotent; parts after complete refused', async () => {
    assert.equal((await call(`/api/videos/${id}/complete`, { method: 'POST', body: {} })).status, 200);
    assert.equal((await call(`/api/videos/${id}/parts/3`, { method: 'PUT', body: new Uint8Array(10) })).status, 409);
  });

  await test('raw: main is byte-identical, camera served separately', async () => {
    let r = await call(`/raw/${id}`, { anon: true });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(sample));
    r = await call(`/raw/${id}/cam`, { anon: true });
    assert.equal(r.status, 200);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(sample.subarray(0, 300000)));
  });

  await test('raw: range requests', async () => {
    let r = await call(`/raw/${id}`, { anon: true, headers: { Range: 'bytes=0-99' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes 0-99/${sample.length}`);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(sample.subarray(0, 100)));
    r = await call(`/raw/${id}`, { anon: true, headers: { Range: `bytes=${PART - 10}-` } });
    assert.equal(r.status, 206);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(sample.subarray(PART - 10)));
    r = await call(`/raw/${id}`, { anon: true, headers: { Range: 'bytes=-500' } });
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(sample.subarray(sample.length - 500)));
    r = await call(`/raw/${id}/cam`, { anon: true, headers: { Range: 'bytes=10-19' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 10-19/300000');
    assert.equal((await call(`/raw/${id}`, { anon: true, headers: { Range: `bytes=${sample.length}-` } })).status, 416);
  });

  await test('downloads are the owner’s only', async () => {
    assert.equal((await call(`/raw/${id}?download=1`, { anon: true })).status, 403);
    assert.equal((await call(`/raw/${id}/cam?download=1`, { anon: true })).status, 403);
    assert.equal((await call(`/raw/${id}?DOWNLOAD`, { anon: true })).status, 403);
    assert.equal((await call(`/raw/${id}/cam?Download=1`, { anon: true })).status, 403);
    let r = await call(`/raw/${id}?download=1`, { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition') || '', /attachment; filename=".+\.mp4"/);
    r = await call(`/raw/${id}/cam?download=1`, { method: 'HEAD' });
    assert.match(r.headers.get('content-disposition') || '', /\(camera\)\.mp4"/);
  });

  await test('layout: valid saved, invalid refused', async () => {
    let r = await call(`/api/videos/${id}`, { method: 'PATCH', body: { layout: { kind: 'side', corner: 'tr', size: 's' } } });
    assert.deepEqual((await j(r)).layout, { kind: 'side', corner: 'tr', size: 's' });
    r = await call(`/api/videos/${id}`, { method: 'PATCH', body: { layout: { kind: 'evil' } } });
    assert.equal(r.status, 400);
    r = await call(`/api/videos/${id}`, { method: 'PATCH', body: { layout: { kind: 'bubble', corner: 'nowhere' } } });
    assert.deepEqual((await j(r)).layout, { kind: 'bubble', corner: 'bl', size: 'm' });
  });

  await test('Screen layout: viewers get no camera file, camera thumbnail or face in the preview', async () => {
    await call(`/api/videos/${id}`, { method: 'PATCH', body: { layout: { kind: 'screen', corner: 'bl', size: 'm' } } });
    assert.equal((await call(`/raw/${id}/cam`, { anon: true })).status, 404);
    assert.equal((await call(`/raw/${id}/cam`, { anon: true, headers: { Range: 'bytes=0-9' } })).status, 404);
    assert.equal((await call(`/thumb/${id}/cam.jpg`, { anon: true })).status, 404);
    const ownerCam = await call(`/raw/${id}/cam`);
    assert.equal(ownerCam.status, 200, 'owner still can');
    assert.equal(ownerCam.headers.get('cache-control'), 'private, no-cache', 'a hidden camera is never cached');
    const ownerCamThumb = await call(`/thumb/${id}/cam.jpg`);
    assert.equal(ownerCamThumb.headers.get('content-type'), 'image/jpeg');
    assert.equal(ownerCamThumb.headers.get('cache-control'), 'private, no-cache');
    assert.match((await call(`/thumb/${id}.jpg`, { anon: true })).headers.get('cache-control'), /^public/, 'the poster stays public');
    const og = Buffer.from(await (await call(`/thumb/${id}/og.jpg`, { anon: true })).arrayBuffer());
    const poster = Buffer.from(await (await call(`/thumb/${id}.jpg`, { anon: true })).arrayBuffer());
    assert.ok(og.equals(poster), 'link preview is the plain poster');
    const html = await (await call(`/v/${id}`, { anon: true })).text();
    assert.match(html, /"hasCam":false/);
    assert.match(html, /og\.jpg\?l=s"/);
    assert.doesNotMatch(html, /class="avatar" src=/);
    const page = await (await call(`/v/${id}`)).text();
    assert.match(page, /"hasCam":true/, 'owner page keeps the camera to switch back');
    await call(`/api/videos/${id}`, { method: 'PATCH', body: { layout: { kind: 'bubble', corner: 'bl', size: 'm' } } });
    const shown = await call(`/raw/${id}/cam`, { anon: true, headers: { Range: 'bytes=0-9' } });
    assert.equal(shown.status, 206);
    assert.equal(shown.headers.get('cache-control'), 'private, no-cache', 'a visible camera is revalidated, so hiding it takes effect at once');
    assert.match((await call(`/raw/${id}`, { anon: true, headers: { Range: 'bytes=0-9' } })).headers.get('cache-control'), /^public/, 'the main track stays cacheable');
  });

  await test('cuts: normalised on save; viewers never get cut words', async () => {
    const all = await j(await call(`/api/videos/${id}/transcript`));
    const w = all.words[1];
    let r = await call(`/api/videos/${id}`, { method: 'PATCH', body: { cuts: [[w.s - 0.05, w.e + 0.05], [1e6, 2e6], [3, 2.99]] } });
    const v = await j(r);
    assert.equal(r.status, 200);
    assert.equal(v.cuts.length, 1);
    const viewer = await j(await call(`/api/videos/${id}/transcript`, { anon: true }));
    assert.equal(viewer.words.length, all.words.length - 1);
    assert.ok(!viewer.words.some((x) => x.s === w.s));
    const owner = await j(await call(`/api/videos/${id}/transcript`));
    assert.equal(owner.words.length, all.words.length);
    assert.equal((await call(`/api/videos/${id}`, { method: 'PATCH', body: { cuts: 'nope' } })).status, 400);
  });

  await test('share page: link-preview tags, escaped title, owner flag, no owner-only fields for viewers', async () => {
    await call(`/api/videos/${id}`, { method: 'PATCH', body: { title: 'Hello <script>alert(1)</script> & "q"' } });
    const html = await (await call(`/v/${id}`, { anon: true })).text();
    assert.match(html, /<meta property="og:image" content="http:\/\/127\.0\.0\.1:\d+\/thumb\/[A-Za-z0-9]+\/og\.jpg\?l=c"/);
    assert.doesNotMatch(html, /og:video/);
    assert.match(html, /Hello &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;q&quot;/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /"owner":false/);
    assert.match(html, /Christopher Moravec/);
    assert.doesNotMatch(html, /"views"|"camMutedMs"|"surface"/);
    assert.match(await (await call(`/v/${id}`)).text(), /"owner":true/);
    // Nothing inline to execute, so script-src 'self' holds: the data rides in a JSON block.
    assert.match(html, /<script type="application\/json" id="shuttle-data">\{/);
    for (const tag of html.match(/<script\b[^>]*>/g)) assert.match(tag, /\bsrc=|type="application\/json"/, tag);
    assert.doesNotMatch(html, /\son[a-z]+=|\sstyle=/i, 'no inline handlers or style attributes');
  });

  await test('security headers on the app, the share page and the API', async () => {
    for (const p of ['/', '/index.html', '/app.js', `/v/${id}`, '/v/nosuchvideo1', '/api/me']) {
      const r = await call(p, { anon: true });
      const csp = r.headers.get('content-security-policy') || '';
      assert.match(csp, /frame-ancestors 'none'/, `${p} CSP: ${csp}`);
      assert.match(csp, /default-src 'self'/, p);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, p);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
      assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', p);
    }
    assert.equal((await call('/_headers', { anon: true })).status, 404, 'the _headers file itself is not served');
  });

  await test('empty title refused', async () => {
    assert.equal((await call(`/api/videos/${id}`, { method: 'PATCH', body: { title: '   ' } })).status, 400);
  });

  await test('views count viewers, not the owner', async () => {
    await call(`/api/videos/${id}/view`, { method: 'POST', anon: true });
    await call(`/api/videos/${id}/view`, { method: 'POST', anon: true });
    await call(`/api/videos/${id}/view`, { method: 'POST' });
    assert.equal((await j(await call(`/api/videos/${id}`))).views, 2);
  });

  await test('list', async () => {
    const v = await j(await call('/api/videos'));
    assert.ok(v.videos.some((x) => x.id === id && x.status === 'ready' && x.hasCam));
  });

  await test('a transcript chunk that never arrived reads as a gap, not a finished transcript', async () => {
    const c = await j(await call('/api/videos', { method: 'POST', body: { mime: 'video/mp4' } }));
    await call(`/api/videos/${c.id}/parts/1`, { method: 'PUT', body: new Uint8Array(sample.subarray(0, 1000)) });
    await call(`/api/videos/${c.id}/audio/0`, { method: 'PUT', body: wav(3), headers: { 'X-Start-Ms': '0', 'X-Duration-Ms': '3000' } });
    await j(await call(`/api/videos/${c.id}/complete`, { method: 'POST', body: { audioChunks: 2, tapGapMs: 4000 } }));
    let t;
    for (let i = 0; i < 40; i++) {
      t = await j(await call(`/api/videos/${c.id}/transcript`));
      if (t.status !== 'pending') break;
      await new Promise((res) => setTimeout(res, 250));
    }
    assert.equal(t.status, 'partial');
    assert.equal(t.missing, 1);
    assert.equal(t.failed, 0);
    assert.ok(t.words.length > 0);
    const viewer = await j(await call(`/api/videos/${c.id}/transcript`, { anon: true }));
    assert.equal(viewer.missing, undefined);
    assert.equal((await j(await call(`/api/videos/${c.id}`))).tapGapMs, 4000);
    await call(`/api/videos/${c.id}`, { method: 'DELETE' });
  });

  await test('description: drafted from the transcript (default title replaced), owner edits win', async () => {
    const c = await j(await call('/api/videos', { method: 'POST', body: { mime: 'video/mp4', keepDays: 30 } }));
    assert.ok(c.title.startsWith('Recording · '));
    await call(`/api/videos/${c.id}/parts/1`, { method: 'PUT', body: new Uint8Array(sample.subarray(0, 1000)) });
    await call(`/api/videos/${c.id}/audio/0`, { method: 'PUT', body: wav(6), headers: { 'X-Start-Ms': '0', 'X-Duration-Ms': '6000' } });
    await j(await call(`/api/videos/${c.id}/complete`, { method: 'POST', body: { audioChunks: 1 } }));
    let v;
    for (let i = 0; i < 40; i++) {
      v = await j(await call(`/api/videos/${c.id}`));
      if (v.description) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(v.description.length > 10, `description: ${v.description}`);
    assert.equal(v.title, 'Quick Shuttle test');
    assert.equal(v.descriptionSource, 'auto');
    const exp = v.expiresAt - Date.now();
    assert.ok(exp > 29.9 * 864e5 && exp <= 30 * 864e5, `expires in ${exp}`);
    let r = await j(await call(`/api/videos/${c.id}`, { method: 'PATCH', body: { description: '  Mine,\n\n\n  please. ' } }));
    assert.equal(r.description, 'Mine,\n\n please.');
    assert.equal(r.descriptionSource, 'owner');
    const html = await (await call(`/v/${c.id}`, { anon: true })).text();
    assert.match(html, /<meta property="og:description" content="Mine,/);
    assert.match(html, /id="description"[^>]*>Mine,/);
    assert.doesNotMatch(html, /"descriptionSource"|"expiresAt"/);
    r = await j(await call(`/api/videos/${c.id}/describe`, { method: 'POST' }));
    assert.equal(r.descriptionSource, 'auto', 'Write one for me redraws on request');
    await call(`/api/videos/${c.id}`, { method: 'DELETE' });
  });

  await test('fragment index: built after complete, spliced into the served file, byte-exact', async () => {
    // A Chrome-style recording: fragments that locate their data relative to themselves.
    const frag = path.join(root, 'test/out/sample-moof.mp4');
    // No B-frames, like MediaRecorder's output.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(root, 'test/out/sample.mp4'), '-c:v', 'libx264', '-bf', '0', '-g', '60', '-preset', 'ultrafast', '-c:a', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', frag]);
    const file = readFileSync(frag);
    const { buildSidx } = await import('../src/mp4index.js');
    const idx = await buildSidx(async (o, l) => new Uint8Array(file.buffer, file.byteOffset + o, Math.min(l, file.length - o)), file.length);
    assert.ok(idx, 'the fixture is indexable');
    const expected = Buffer.concat([file.subarray(0, idx.at), Buffer.from(idx.sidx), file.subarray(idx.at)]);
    const c = await j(await call('/api/videos', { method: 'POST', body: { mime: 'video/mp4' } }));
    let n = 0;
    for (let off = 0; off < file.length; off += PART) await call(`/api/videos/${c.id}/parts/${++n}`, { method: 'PUT', body: new Uint8Array(file.subarray(off, off + PART)) });
    assert.equal((await call(`/api/videos/${c.id}/complete`, { method: 'POST', body: { durationMs: 20000, width: 1280, height: 720, mime: 'video/mp4' } })).status, 200);
    let len = 0;
    for (let i = 0; i < 60 && len !== expected.length; i++) {
      len = Number((await call(`/raw/${c.id}`, { method: 'HEAD', anon: true })).headers.get('content-length'));
      if (len !== expected.length) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(len, expected.length, `served size includes the ${idx.sidx.length}-byte index`);
    let r = await call(`/raw/${c.id}`, { anon: true });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('etag'), /-x"$/, 'a different ETag than the stored file');
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(expected), 'whole file');
    const L = expected.length, at = idx.at, end = idx.at + idx.sidx.length;
    for (const [lo, hi] of [[0, 99], [at - 10, at + 10], [at + 5, end + 5], [end - 3, end + 3], [at, L - 1], [L - 200, L - 1], [0, L - 1]]) {
      r = await call(`/raw/${c.id}`, { anon: true, headers: { Range: `bytes=${lo}-${hi}` } });
      assert.equal(r.status, 206);
      assert.equal(r.headers.get('content-range'), `bytes ${lo}-${hi}/${L}`);
      assert.ok(Buffer.from(await r.arrayBuffer()).equals(expected.subarray(lo, hi + 1)), `range ${lo}-${hi}`);
    }
    r = await call(`/raw/${c.id}`, { anon: true, headers: { Range: 'bytes=-700' } });
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(expected.subarray(L - 700)), 'suffix range');
    // The served file decodes cleanly and reports the same length.
    const out = path.join(root, 'test/out/served-indexed.mp4');
    (await import('node:fs')).writeFileSync(out, expected);
    let errs = '';
    try { execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { errs = String(e.stderr || e.message); }
    assert.equal(errs, '', 'decodes with no errors');
    const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
    assert.ok(Math.abs(dur(out) - dur(frag)) < 0.05, `duration ${dur(out)} vs ${dur(frag)}`);
    // A stored file that can't be indexed (absolute offsets) is served exactly as stored.
    assert.equal(Number((await call(`/raw/${id}`, { method: 'HEAD', anon: true })).headers.get('content-length')), sample.length);
    await call(`/api/videos/${c.id}`, { method: 'DELETE' });
  });

  await test('starting speed: owner picks it, viewers see it, bad values refused', async () => {
    let c = await j(await call('/api/videos', { method: 'POST', body: { mime: 'video/mp4', speed: 1.2 } }));
    assert.equal((await j(await call(`/api/videos/${c.id}`))).speed, 1.2, 'set at creation');
    await call(`/api/videos/${c.id}`, { method: 'DELETE' });
    c = await j(await call('/api/videos', { method: 'POST', body: { mime: 'video/mp4', speed: 9 } }));
    assert.equal(c.id.length > 0, true, 'a stale default never blocks a recording');
    assert.equal((await j(await call(`/api/videos/${c.id}`))).speed, null);
    let r = await j(await call(`/api/videos/${c.id}`, { method: 'PATCH', body: { speed: 1.5 } }));
    assert.equal(r.speed, 1.5);
    assert.equal((await call(`/api/videos/${c.id}`, { method: 'PATCH', body: { speed: 1.3 } })).status, 400);
    assert.equal((await call(`/api/videos/${c.id}`, { method: 'PATCH', body: { speed: 'fast' } })).status, 400);
    const html = await (await call(`/v/${c.id}`, { anon: true })).text();
    assert.match(html, /"speed":1\.5/, 'the share page carries it for viewers');
    r = await j(await call(`/api/videos/${c.id}`, { method: 'PATCH', body: { speed: null } }));
    assert.equal(r.speed, null, 'cleared back to the viewer\'s own choice');
    await call(`/api/videos/${c.id}`, { method: 'DELETE' });
  });

  await test('expiry: keep forever, or expire — expired videos vanish and get swept', async () => {
    const c = await j(await call('/api/videos', { method: 'POST', body: { mime: 'video/mp4' } }));
    await call(`/api/videos/${c.id}/parts/1`, { method: 'PUT', body: new Uint8Array(sample.subarray(0, 1000)) });
    await call(`/api/videos/${c.id}/complete`, { method: 'POST', body: {} });
    assert.equal((await j(await call(`/api/videos/${c.id}`))).expiresAt, null, 'no keepDays = forever');
    let r = await j(await call(`/api/videos/${c.id}`, { method: 'PATCH', body: { keepDays: 7 } }));
    assert.ok(r.expiresAt > Date.now() + 6.9 * 864e5);
    r = await j(await call(`/api/videos/${c.id}`, { method: 'PATCH', body: { keepDays: 'forever' } }));
    assert.equal(r.expiresAt, null);
    assert.equal((await call(`/api/videos/${c.id}`, { method: 'PATCH', body: { keepDays: 'soon' } })).status, 400);
    await call(`/api/videos/${c.id}`, { method: 'PATCH', body: { keepDays: 0 } }); // expires now
    assert.equal((await call(`/v/${c.id}`, { anon: true })).status, 404);
    assert.equal((await call(`/raw/${c.id}`, { anon: true })).status, 404);
    assert.equal((await call(`/thumb/${c.id}/og.jpg`, { anon: true })).status, 404);
    assert.equal((await call(`/api/videos/${c.id}`)).status, 404);
    await call('/api/videos'); // listing sweeps
    await new Promise((res) => setTimeout(res, 500));
    const list = await j(await call('/api/videos'));
    assert.ok(!list.videos.some((x) => x.id === c.id));
  });

  await test('camera track with no data is dropped at complete', async () => {
    const c = await j(await call('/api/videos', { method: 'POST', body: { mime: 'video/mp4', camMime: 'video/mp4', mode: 'screen-camera' } }));
    assert.equal(c.hasCam, true);
    await call(`/api/videos/${c.id}/parts/1`, { method: 'PUT', body: new Uint8Array(sample.subarray(0, 1000)) });
    const v = await j(await call(`/api/videos/${c.id}/complete`, { method: 'POST', body: { camMime: 'video/mp4' } }));
    assert.equal(v.hasCam, false);
    assert.equal(v.layout.kind, 'bubble'); // stored default, but the player ignores it without a camera
    await call(`/api/videos/${c.id}`, { method: 'DELETE' });
  });

  await test('interrupted recording can be recovered from server-side parts', async () => {
    const c = await j(await call('/api/videos', { method: 'POST', body: { mime: 'video/mp4' } }));
    await call(`/api/videos/${c.id}/parts/1`, { method: 'PUT', body: new Uint8Array(sample.subarray(0, PART)) });
    await call(`/api/videos/${c.id}/parts/2`, { method: 'PUT', body: new Uint8Array(sample.subarray(PART, PART + 1000)) });
    const r = await call(`/api/videos/${c.id}/complete`, { method: 'POST', body: {} });
    assert.equal(r.status, 200);
    assert.equal((await j(r)).size, PART + 1000);
    await call(`/api/videos/${c.id}`, { method: 'DELETE' });
  });

  await test('complete with no data is refused and keeps the (possibly live) video', async () => {
    const c = await j(await call('/api/videos', { method: 'POST', body: { mime: 'video/webm' } }));
    assert.equal((await call(`/api/videos/${c.id}/complete`, { method: 'POST', body: {} })).status, 409);
    assert.equal((await call(`/api/videos/${c.id}`)).status, 200);
    assert.equal((await call(`/api/videos/${c.id}/heartbeat`, { method: 'POST' })).status, 200);
    await call(`/api/videos/${c.id}`, { method: 'DELETE' });
  });

  await test('recover reports a truncated video (gap in parts)', async () => {
    const c = await j(await call('/api/videos', { method: 'POST', body: { mime: 'video/mp4' } }));
    await call(`/api/videos/${c.id}/parts/1`, { method: 'PUT', body: new Uint8Array(sample.subarray(0, PART)) });
    await call(`/api/videos/${c.id}/parts/3`, { method: 'PUT', body: new Uint8Array(sample.subarray(PART, PART + 10)) });
    const v = await j(await call(`/api/videos/${c.id}/complete`, { method: 'POST', body: {} }));
    assert.equal(v.truncated, true);
    assert.equal(v.size, PART);
    await call(`/api/videos/${c.id}`, { method: 'DELETE' });
  });

  await test('owner-only routes need the owner', async () => {
    assert.equal((await call('/api/videos/abcdefabcdef/heartbeat', { method: 'POST', anon: true })).status, 401);
    assert.equal((await call(`/api/videos/${id}/transcript/retry`, { method: 'POST', anon: true })).status, 401);
  });

  await test('logout refuses cross-origin', async () => {
    assert.equal((await call('/api/logout', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  });

  await test('delete removes the video, camera, thumbnails and transcript', async () => {
    assert.equal((await call(`/api/videos/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await call(`/raw/${id}`, { anon: true })).status, 404);
    assert.equal((await call(`/raw/${id}/cam`, { anon: true })).status, 404);
    assert.equal((await call(`/v/${id}`, { anon: true })).status, 404);
    assert.equal((await call(`/api/videos/${id}/transcript`, { anon: true })).status, 404);
    assert.equal((await call(`/thumb/${id}/cam.jpg`, { anon: true })).headers.get('content-type'), 'image/svg+xml');
  });

  await test('login is throttled after repeated failures', async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await call('/api/login', { method: 'POST', anon: true, body: { password: 'bad' + i } });
    assert.equal(last.status, 429);
    const good = await call('/api/login', { method: 'POST', anon: true, body: { password: PASSWORD } });
    assert.equal(good.status, 429, 'even the right password waits out the lockout');
  });

  // CF-Connecting-IP is honoured by wrangler dev, so each test below gets its own addresses.
  const login = (password, ip) => call('/api/login', { method: 'POST', anon: true, body: { password }, headers: { 'CF-Connecting-IP': ip } });

  await test('concurrent wrong passwords from one address get at most 10 checks', async () => {
    const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => login('bad' + i, '198.51.100.7')));
    const st = rs.map((r) => r.status);
    const checked = st.filter((x) => x === 401).length;
    assert.ok(checked <= 10, `${checked} password checks went through (cap 10)`);
    assert.ok(checked >= 1, 'some were checked');
    assert.equal(st.filter((x) => x === 429).length, 60 - checked, `statuses: ${st}`);
    assert.equal((await login(PASSWORD, '198.51.100.7')).status, 429, 'that address is locked out, right password or not');
    assert.equal((await login('nope', '198.51.100.8')).status, 401, 'another address is not');
  });

  await test('a flood from many addresses never locks out the right password', async () => {
    // 11 + 1 failures so far from this run's other tests; push the last hour past 100.
    for (let a = 1; a <= 10; a++) await Promise.all(Array.from({ length: 10 }, (_, i) => login('flood' + i, `203.0.113.${a}`)));
    const owner = await login(PASSWORD, '192.0.2.50');
    assert.equal(owner.status, 200, 'the right password from a quiet address still signs in');
    assert.match(owner.headers.get('set-cookie') || '', /^__Host-shuttle_session=/);
    // While flooded, a fresh address gets 3 checks, not 10.
    const st = [];
    for (let i = 0; i < 5; i++) st.push((await login('guess' + i, '192.0.2.60')).status);
    assert.deepEqual(st, [401, 401, 401, 429, 429]);
    assert.equal((await login(PASSWORD, '192.0.2.60')).status, 429, 'the per-address cap is still the hard stop');
  });

  await test('static app is served', async () => {
    const r = await call('/', { anon: true });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<title>Shuttle<\/title>/);
    for (const f of ['/app.js', '/player.js', '/timeline.js', '/pcm-tap.js']) assert.equal((await call(f, { anon: true })).status, 200, f);
  });
} finally {
  stopServer();
}
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
