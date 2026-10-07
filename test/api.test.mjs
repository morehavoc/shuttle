// API contract test. Starts `wrangler dev` (local R2 + D1), drives the whole lifecycle,
// stops it. Usage: npm test   (or BASE=http://127.0.0.1:8799 node test/api.test.mjs against a running one)

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8799;
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const PASSWORD = 'test-password-123';
let server;

async function startServer() {
  if (process.env.BASE) return;
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'shuttle', '--local', '--persist-to', '.wrangler/test-state'], { cwd: root, stdio: 'ignore' });
  server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', '.wrangler/test-state', '--var', `OWNER_PASSWORD:${PASSWORD}`, '--show-interactive-dev-session=false'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
  const r = await fetch(BASE + p, { method: opts.method || 'GET', headers, body, redirect: 'manual' });
  return r;
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['ok', name]); console.log('  ok  ', name); }
  catch (e) { results.push(['FAIL', name]); console.log('  FAIL', name, '\n       ', e.message); }
}

try {
  await startServer();
  const sample = readFileSync(path.join(root, 'test/out/sample.mp4'));
  const me0 = await (await call('/api/me')).json();
  const PART = me0.partSize;
  let id, share;

  await test('anonymous is not owner, owner APIs refuse', async () => {
    assert.equal(me0.owner, false);
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
    assert.match(sc, /shuttle_session=\d+\.[\w-]+/);
    assert.match(sc, /HttpOnly/);
    cookie = sc.split(';')[0];
    assert.equal((await (await call('/api/me')).json()).owner, true);
  });

  await test('forged cookie is refused', async () => {
    const r = await call('/api/videos', { anon: true, headers: { Cookie: `shuttle_session=${Date.now() + 1e9}.AAAA` } });
    assert.equal(r.status, 401);
  });

  await test('cross-origin write refused', async () => {
    const r = await call('/api/videos', { method: 'POST', body: { mime: 'video/mp4' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
  });

  await test('bad mime refused', async () => {
    const r = await call('/api/videos', { method: 'POST', body: { mime: 'text/html' } });
    assert.equal(r.status, 400);
  });

  await test('create video', async () => {
    const r = await call('/api/videos', { method: 'POST', body: { mime: 'video/mp4;codecs=avc1,mp4a.40.2', mode: 'screen-camera', tz: 'America/New_York' } });
    assert.equal(r.status, 201);
    const j = await r.json();
    id = j.id; share = j.shareUrl;
    assert.match(id, /^[A-Za-z0-9]{12}$/);
    assert.equal(j.partSize, PART);
    assert.match(j.title, /^Recording · /);
  });

  await test('share page while recording shows pending, no og:video', async () => {
    const html = await (await call(`/v/${id}`, { anon: true })).text();
    assert.match(html, /Finishing upload/);
    assert.doesNotMatch(html, /og:video/);
    const s = await (await call(`/api/videos/${id}/status`, { anon: true })).json();
    assert.equal(s.status, 'recording');
  });

  await test('raw is 404 until ready', async () => {
    assert.equal((await call(`/raw/${id}`, { anon: true })).status, 404);
  });

  await test('oversize part refused', async () => {
    const r = await call(`/api/videos/${id}/parts/1`, { method: 'PUT', body: new Uint8Array(PART + 1) });
    assert.equal(r.status, 400);
  });

  await test('upload parts (fixed size + remainder)', async () => {
    let n = 0;
    for (let off = 0; off < sample.length; off += PART) {
      n++;
      const r = await call(`/api/videos/${id}/parts/${n}`, { method: 'PUT', body: new Uint8Array(sample.subarray(off, off + PART)) });
      const txt = await r.text();
      assert.equal(r.status, 200, txt);
      const j = JSON.parse(txt);
      assert.equal(j.partNumber, n);
      assert.ok(j.etag);
    }
    assert.equal(n, 2);
  });

  await test('thumbnail upload', async () => {
    const jpg = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', path.join(root, 'test/out/sample.mp4'), '-frames:v', '1', '-f', 'mjpeg', '-'], { maxBuffer: 1e7 });
    const r = await call(`/api/videos/${id}/thumb`, { method: 'PUT', body: new Uint8Array(jpg) });
    assert.equal(r.status, 200);
    const t = await call(`/thumb/${id}.jpg`, { anon: true });
    assert.equal(t.headers.get('content-type'), 'image/jpeg');
  });

  await test('complete', async () => {
    const r = await call(`/api/videos/${id}/complete`, { method: 'POST', body: { durationMs: 20000, width: 1280, height: 720, mime: 'video/mp4' } });
    assert.equal(r.status, 200, await r.clone().text());
    const j = await r.json();
    assert.equal(j.status, 'ready');
    assert.equal(j.size, sample.length);
    assert.equal(j.durationMs, 20000);
  });

  await test('complete is idempotent', async () => {
    const r = await call(`/api/videos/${id}/complete`, { method: 'POST', body: {} });
    assert.equal(r.status, 200);
  });

  await test('part upload after complete refused', async () => {
    const r = await call(`/api/videos/${id}/parts/3`, { method: 'PUT', body: new Uint8Array(10) });
    assert.equal(r.status, 409);
  });

  await test('raw: full body is byte-identical', async () => {
    const r = await call(`/raw/${id}`, { anon: true });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    const b = Buffer.from(await r.arrayBuffer());
    assert.ok(b.equals(sample));
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
    r = await call(`/raw/${id}`, { anon: true, headers: { Range: `bytes=${sample.length}-` } });
    assert.equal(r.status, 416);
  });

  await test('raw: download sets a filename', async () => {
    const r = await call(`/raw/${id}?download=1`, { anon: true, method: 'HEAD' });
    assert.match(r.headers.get('content-disposition') || '', /attachment; filename=".+\.mp4"/);
  });

  await test('share page: OG tags, escaped title', async () => {
    await call(`/api/videos/${id}`, { method: 'PATCH', body: { title: 'Hello <script>alert(1)</script> & "q"' } });
    const html = await (await call(`/v/${id}`, { anon: true })).text();
    assert.match(html, /<meta property="og:image" content="http:\/\/127\.0\.0\.1:\d+\/thumb\//);
    assert.match(html, /<meta property="og:video" content=/);
    assert.match(html, /Hello &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;q&quot;/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /"owner":false/);
  });

  await test('owner sees owner flag on share page', async () => {
    const html = await (await call(`/v/${id}`)).text();
    assert.match(html, /"owner":true/);
  });

  await test('empty title refused', async () => {
    const r = await call(`/api/videos/${id}`, { method: 'PATCH', body: { title: '   ' } });
    assert.equal(r.status, 400);
  });

  await test('views count viewers, not the owner', async () => {
    await call(`/api/videos/${id}/view`, { method: 'POST', anon: true });
    await call(`/api/videos/${id}/view`, { method: 'POST', anon: true });
    await call(`/api/videos/${id}/view`, { method: 'POST' });
    const j = await (await call(`/api/videos/${id}`)).json();
    assert.equal(j.views, 2);
  });

  await test('list', async () => {
    const j = await (await call('/api/videos')).json();
    assert.ok(j.videos.some((x) => x.id === id && x.status === 'ready'));
  });

  await test('interrupted recording can be recovered from server-side parts', async () => {
    const c = await (await call('/api/videos', { method: 'POST', body: { mime: 'video/mp4' } })).json();
    await call(`/api/videos/${c.id}/parts/1`, { method: 'PUT', body: new Uint8Array(sample.subarray(0, PART)) });
    await call(`/api/videos/${c.id}/parts/2`, { method: 'PUT', body: new Uint8Array(sample.subarray(PART, PART + 1000)) });
    const r = await call(`/api/videos/${c.id}/complete`, { method: 'POST', body: {} });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.size, PART + 1000);
    await call(`/api/videos/${c.id}`, { method: 'DELETE' });
  });

  await test('complete with no data is refused and keeps the (possibly live) video', async () => {
    const c = await (await call('/api/videos', { method: 'POST', body: { mime: 'video/webm' } })).json();
    const r = await call(`/api/videos/${c.id}/complete`, { method: 'POST', body: {} });
    assert.equal(r.status, 409);
    assert.equal((await call(`/api/videos/${c.id}`)).status, 200);
    const hb = await call(`/api/videos/${c.id}/heartbeat`, { method: 'POST' });
    assert.equal(hb.status, 200);
    await call(`/api/videos/${c.id}`, { method: 'DELETE' });
  });

  await test('recover reports a truncated video (gap in parts)', async () => {
    const c = await (await call('/api/videos', { method: 'POST', body: { mime: 'video/mp4' } })).json();
    await call(`/api/videos/${c.id}/parts/1`, { method: 'PUT', body: new Uint8Array(sample.subarray(0, PART)) });
    await call(`/api/videos/${c.id}/parts/3`, { method: 'PUT', body: new Uint8Array(sample.subarray(PART, PART + 10)) });
    const j = await (await call(`/api/videos/${c.id}/complete`, { method: 'POST', body: {} })).json();
    assert.equal(j.truncated, true);
    assert.equal(j.size, PART);
    await call(`/api/videos/${c.id}`, { method: 'DELETE' });
  });

  await test('heartbeat and owner routes need the owner', async () => {
    const r = await call('/api/videos/abcdefabcdef/heartbeat', { method: 'POST', anon: true });
    assert.equal(r.status, 401);
  });

  await test('logout refuses cross-origin', async () => {
    const r = await call('/api/logout', { method: 'POST', headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
  });

  await test('delete removes the video and its bytes', async () => {
    assert.equal((await call(`/api/videos/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await call(`/raw/${id}`, { anon: true })).status, 404);
    assert.equal((await call(`/v/${id}`, { anon: true })).status, 404);
  });

  await test('login is throttled after repeated failures', async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await call('/api/login', { method: 'POST', anon: true, body: { password: 'bad' + i } });
    assert.equal(last.status, 429);
    const good = await call('/api/login', { method: 'POST', anon: true, body: { password: PASSWORD } });
    assert.equal(good.status, 429, 'even the right password waits out the lockout');
  });

  await test('static app is served', async () => {
    const r = await call('/', { anon: true });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<title>Shuttle<\/title>/);
    assert.equal((await call('/app.js', { anon: true })).status, 200);
  });
} finally {
  stopServer();
}
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
