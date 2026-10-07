// Browser end-to-end: sign in, record (fake camera/mic/screen), stop, land on the share page,
// play + seek the uploaded file. Runs against BASE (a running `wrangler dev`).
//   BASE=https://host:port PASSWORD=… ENGINE=chromium|webkit MODE=screen-camera|screen|camera node test/e2e.mjs
// Playwright is resolved from PLAYWRIGHT_DIR (default: ../node_modules/playwright).

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_DIR || path.join(root, '..', 'node_modules', 'playwright'));

const BASE = process.env.BASE || 'http://localhost:8799';
const PASSWORD = process.env.PASSWORD || 'test-password-123';
const ENGINE = process.env.ENGINE || 'chromium';
const MODE = process.env.MODE || 'screen-camera';
const SECONDS = Number(process.env.SECONDS || 7);
const out = path.join(root, 'test', 'out', `${ENGINE}-${MODE}`);
mkdirSync(out, { recursive: true });

const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);

const launchOpts = ENGINE === 'chromium'
  ? { args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--auto-accept-this-tab-capture',
      '--enable-usermedia-screen-capturing',
      '--allow-http-screen-capture',
    ] }
  : {};
const browser = await pw[ENGINE].launch(launchOpts);
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 860 },
  ignoreHTTPSErrors: true,
  permissions: ENGINE === 'chromium' ? ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] : [],
});
// WebKit under Playwright can't grant camera permission on macOS (the prompt never resolves),
// so it gets synthetic canvas/oscillator streams. That still exercises WebKit's MediaRecorder,
// the upload path and the player.
if (ENGINE === 'webkit' || process.env.FAKE) {
  await ctx.addInitScript((noise) => {
    function fakeVideo(w, h, label) {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); let f = 0;
      const draw = () => {
        f++; g.fillStyle = `hsl(${(f * 2) % 360},60%,35%)`; g.fillRect(0, 0, w, h);
        if (noise) for (let i = 0; i < 400; i++) { g.fillStyle = `hsl(${Math.random() * 360},80%,50%)`; g.fillRect(Math.random() * w, Math.random() * h, 40, 40); }
        g.fillStyle = '#fff'; g.font = `${Math.round(h / 8)}px sans-serif`; g.fillText(`${label} ${f}`, w / 10, h / 2);
      };
      draw(); setInterval(draw, 33);
      const s = c.captureStream(30);
      return s;
    }
    function fakeAudio() {
      const ctx = new AudioContext(); const o = ctx.createOscillator(); const d = ctx.createMediaStreamDestination();
      o.connect(d); o.start(); return d.stream;
    }
    const md = MediaDevices.prototype;
    const def = (k, fn) => Object.defineProperty(md, k, { value: fn, configurable: true, writable: true });
    def('getUserMedia', async (c) => {
      const tracks = [];
      if (c.video) tracks.push(...fakeVideo(1280, 720, 'CAM').getVideoTracks());
      if (c.audio) tracks.push(...fakeAudio().getAudioTracks());
      return new MediaStream(tracks);
    });
    def('getDisplayMedia', async () => fakeVideo(1920, 1080, 'SCREEN'));
    def('enumerateDevices', async () => [
      { kind: 'videoinput', deviceId: 'cam1', label: 'FaceTime HD Camera', groupId: 'g' },
      { kind: 'audioinput', deviceId: 'mic1', label: 'MacBook Pro Microphone', groupId: 'g' },
    ]);
  }, !!process.env.NOISE);
}
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  await page.goto(BASE + '/');
  await page.waitForSelector('#signin:not([hidden]), #library:not([hidden])');
  if (await page.isVisible('#signin')) {
    await page.fill('#password', 'wrong');
    await page.click('#signin-form button');
    await page.waitForFunction(() => document.querySelector('#signin-error').textContent.length > 0);
    ok('wrong password shows an error');
    await page.fill('#password', PASSWORD);
    await page.click('#signin-form button');
  }
  await page.waitForSelector('#library:not([hidden])');
  await page.screenshot({ path: path.join(out, '1-library.png') });
  ok('signed in, library visible');

  await page.click('#new-recording');
  await page.waitForSelector('.sheet');
  await page.click(`.seg button[data-mode="${MODE}"]`);
  if (MODE !== 'screen') {
    await page.waitForFunction(() => { const v = document.querySelector('#setup-cam'); return v && v.videoWidth > 0; }, null, { timeout: 15000 });
    ok('camera preview live');
  }
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, '2-setup.png') });
  const opts = await page.$$eval('#mic-select option', (o) => o.length);
  if (opts < 1) fail('no microphone options listed'); else ok(`devices listed (${opts} mic)`);

  const FAULT = process.env.FAULT;
  if (FAULT === 'flaky') {
    let until = 0;
    await page.route('**/parts/**', (route) => (Date.now() < until ? route.abort('internetdisconnected') : route.continue()));
    page.once('framenavigated', () => {});
    setTimeout(() => { until = Date.now() + 8000; }, 6000);
  }
  if (FAULT === 'fatal') {
    await page.route('**/parts/**', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"Bad part"}' }));
  }
  await page.click('#start');
  // Safari/headless may need the extra "Start recording" click to float the camera.
  const extra = page.locator('.countdown .btn-rec');
  try { await extra.waitFor({ timeout: 2500 }); await page.screenshot({ path: path.join(out, '3-ask-bubble.png') }); await extra.click(); ok('bubble prompt shown and accepted'); } catch {}
  await page.waitForSelector('.recbar:not([hidden])', { timeout: 20000 });
  ok('recording started');
  await page.screenshot({ path: path.join(out, '4-recording.png') });
  await page.waitForTimeout(SECONDS * 500);
  await page.click('.recbar .icon-btn[title="Pause"]');
  await page.waitForSelector('.recbar.paused');
  await page.waitForTimeout(1500);
  await page.click('.recbar .icon-btn[title="Resume"]');
  ok('pause / resume');
  await page.waitForTimeout(SECONDS * 500);
  const shownTime = await page.textContent('.recbar .time');
  if (FAULT === 'fatal') {
    const up = await page.textContent('.recbar .up');
    if (up !== 'Upload failed') fail('recbar did not show the upload failure: ' + up); else ok('recbar shows "Upload failed" while recording');
    await page.click('.recbar .stop');
    await page.waitForSelector('.finishing >> text=/Upload failed/', { timeout: 20000 });
    const hasRetry = await page.isVisible('.finishing >> text=Retry');
    const hasDl = await page.isVisible('.finishing >> text=Download copy');
    await page.screenshot({ path: path.join(out, 'fatal.png') });
    if (hasRetry) fail('Retry offered although parts were lost'); else ok('no false Retry');
    if (!hasDl) fail('no Download copy'); else ok('Download copy offered');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.finishing >> text=Download copy')]);
    const f = path.join(out, 'local-copy.mp4'); await dl.saveAs(f);
    const { statSync } = await import('node:fs');
    if (statSync(f).size < 10000) fail('local copy too small'); else ok(`local copy downloaded (${statSync(f).size} bytes)`);
    throw Object.assign(new Error('done'), { expected: true });
  }
  await page.click('.recbar .stop');
  await page.waitForURL(/\/v\/[A-Za-z0-9]+/, { timeout: 60000 });
  ok(`stopped at ${shownTime}, landed on ${page.url()}`);
  await page.waitForSelector('#player', { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, '5-share.png') });

  const info = await page.evaluate(async () => {
    const v = document.querySelector('#player');
    if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
    // allow the Infinity-duration fix to run
    for (let i = 0; i < 40 && !(Number.isFinite(v.duration)); i++) await new Promise((r) => setTimeout(r, 100));
    v.muted = true;
    await v.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
    const playedTo = v.currentTime;
    const target = Number.isFinite(v.duration) ? v.duration / 2 : 2;
    v.currentTime = target;
    await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); setTimeout(r, 4000); });
    return { duration: v.duration, w: v.videoWidth, h: v.videoHeight, playedTo, seekedTo: v.currentTime, target, err: v.error && v.error.code, src: v.currentSrc, sub: document.querySelector('#sub').textContent };
  });
  console.log('       player:', JSON.stringify(info));
  if (info.err) fail('player error ' + info.err);
  else if (!(info.duration > SECONDS - 2) || !Number.isFinite(info.duration)) fail('bad duration ' + info.duration);
  else if (!(info.playedTo > 0.3)) fail('did not play');
  else if (Math.abs(info.seekedTo - info.target) > 1.5) fail('seek missed');
  else ok(`plays and seeks (${info.duration.toFixed(1)}s, ${info.w}×${info.h})`);
  await page.screenshot({ path: path.join(out, '6-playing.png') });

  // rename
  await page.click('#title');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type('E2E test video');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const t = await page.evaluate(() => fetch(location.pathname.replace('/v/', '/api/videos/')).then((r) => r.json()));
  if (t.title !== 'E2E test video') fail('rename did not save: ' + t.title); else ok('rename saved');
  if (!t.hasThumb) fail('no thumbnail'); else ok('thumbnail uploaded');

  // library shows it
  await page.goto(BASE + '/');
  await page.waitForSelector('.card');
  await page.screenshot({ path: path.join(out, '7-library-after.png') });
  ok('library shows the video');
  console.log(`VIDEO_ID=${t.id}`);
} catch (e) {
  if (e.expected) { console.log('  ok   fault scenario complete'); } else {
  fail(e.stack || e.message);
  await page.screenshot({ path: path.join(out, 'error.png') }).catch(() => {}); }
} finally {
  if (consoleErrors.length) console.log('       console errors:', consoleErrors.slice(0, 8));
  await browser.close();
}
