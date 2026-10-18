// iPhone end-to-end (WebKit, iPhone 15 emulation, no screen capture): camera-only setup and
// labelled recording controls, two recordings in a row without a refresh (via Library, and after
// deleting one mid-recording), and the back/forward-cache restore that left the library stuck
// under the old "Finishing upload" screen.
//   BASE=https://host:port PASSWORD=… node test/e2e-mobile.mjs
// Playwright WebKit doesn't keep pages in a back/forward cache, so the restore is simulated with
// the pageshow event Safari fires (persisted: true).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_DIR || path.join(root, '..', 'node_modules', 'playwright'));
const BASE = process.env.BASE || 'http://localhost:8799';
const PASSWORD = process.env.PASSWORD || 'test-password-123';
const out = path.join(root, 'test', 'out', 'webkit-iphone');
mkdirSync(out, { recursive: true });

const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);
const check = (cond, good, bad) => (cond ? ok(good) : fail(bad || good));

const browser = await pw.webkit.launch();
const ctx = await browser.newContext({ ...pw.devices['iPhone 15'], ignoreHTTPSErrors: true });
await ctx.addInitScript(() => {
  const md = MediaDevices.prototype;
  Object.defineProperty(md, 'getDisplayMedia', { value: undefined, configurable: true }); // iPhone Safari has none
  function fakeVideo() {
    const c = document.createElement('canvas'); c.width = 720; c.height = 1280;
    const g = c.getContext('2d'); let f = 0;
    setInterval(() => { f++; g.fillStyle = `hsl(${(f * 3) % 360},60%,40%)`; g.fillRect(0, 0, c.width, c.height); }, 33);
    return c.captureStream(30);
  }
  Object.defineProperty(md, 'getUserMedia', { configurable: true, value: async (c) => {
    const t = [];
    if (c.video) t.push(fakeVideo().getVideoTracks()[0]);
    if (c.audio) {
      const a = new AudioContext(); const d = a.createMediaStreamDestination(); const o = a.createOscillator();
      o.connect(d); o.start(); t.push(d.stream.getAudioTracks()[0]);
    }
    return new MediaStream(t);
  } });
  Object.defineProperty(md, 'enumerateDevices', { configurable: true, value: async () => [
    { kind: 'videoinput', deviceId: 'front', label: 'Front Camera' }, { kind: 'audioinput', deviceId: 'mic', label: 'iPhone Microphone' },
  ] });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => d.accept());
const shot = (name) => page.screenshot({ path: path.join(out, name) });

async function openSetup() {
  await page.click('#new-recording');
  await page.waitForSelector('.sheet');
  await page.waitForFunction(() => { const v = document.querySelector('#setup-cam'); return v && v.videoWidth > 0; }, null, { timeout: 15000 });
}
async function startRecording() {
  await page.click('#start');
  await page.waitForSelector('.countdown small');
  await page.waitForSelector('.recbar:not([hidden])', { timeout: 20000 });
}
async function record(n) {
  await openSetup();
  await startRecording();
  await page.waitForTimeout(2500);
  await page.click('.recbar .stop');
  await page.waitForURL(/\/v\//, { timeout: 30000 });
  await page.waitForSelector('video, .sp', { timeout: 15000 });
  ok(`recording ${n} reached its share page`);
}

try {
  await page.goto(BASE + '/');
  await page.waitForSelector('#signin:not([hidden]), #library:not([hidden])');
  if (await page.isVisible('#signin')) { await page.fill('#password', PASSWORD); await page.click('#signin-form button'); }
  await page.waitForSelector('#library:not([hidden])');

  // ---------- setup: camera only ----------
  await openSetup();
  await page.waitForTimeout(400);
  await shot('1-setup.png');
  const setup = await page.evaluate(() => ({
    cameraOnly: document.documentElement.classList.contains('camera-only'),
    seg: !!document.querySelector('.sheet .seg'),
    note: document.querySelector('#setup-note').textContent,
  }));
  check(setup.cameraOnly && !setup.seg && !setup.note, 'phone setup: no screen/camera picker, no "needs a computer" note', JSON.stringify(setup));

  // ---------- recording controls ----------
  await startRecording();
  await page.waitForTimeout(800);
  await shot('2-recording.png');
  const bar = await page.evaluate(() => {
    const b = document.querySelector('.recbar').getBoundingClientRect();
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const label = (s) => { const el = document.querySelector(s + ' b'); return el && getComputedStyle(el).display !== 'none' ? el.textContent : null; };
    return {
      width: b.width, vw: innerWidth, bottom: innerHeight - b.bottom,
      pause: label('.recbar [title="Pause"]'), del: label('.recbar .rec-delete'),
      pauseH: r('.recbar [title="Pause"]').height, stopH: r('.recbar .stop').height,
      deleteLeftOfTime: r('.recbar .rec-delete').right <= r('.recbar .time').left,
    };
  });
  check(bar.width >= bar.vw - 24, 'recording bar spans the phone width', JSON.stringify(bar));
  check(bar.pause === 'Pause' && bar.del === 'Delete', 'Pause and Delete are labelled', JSON.stringify(bar));
  check(bar.pauseH >= 44 && bar.stopH >= 44, 'buttons are at least 44 px tall', JSON.stringify(bar));
  check(bar.deleteLeftOfTime, 'Delete sits at the far end from Stop', JSON.stringify(bar));
  await page.click('.recbar [title="Pause"]');
  await page.waitForSelector('.recbar.paused');
  check((await page.textContent('.recbar [title="Resume"] b')) === 'Resume', 'paused: the button says Resume');
  await page.click('.recbar [title="Resume"]');
  // ---------- delete mid-recording, then record again ----------
  await page.click('.recbar .rec-delete');
  await page.waitForSelector('.recbar', { state: 'detached' });
  ok('deleted mid-recording');
  await record(1);

  // ---------- Library, record again ----------
  await page.click('a:has-text("Library")');
  await page.waitForSelector('#library:not([hidden])');
  await record(2);

  // ---------- back/forward cache restore ----------
  await page.goto(BASE + '/');
  await page.waitForSelector('#library:not([hidden])');
  await page.evaluate(() => { window.__stale = true; window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await page.waitForFunction(() => !window.__stale, null, { timeout: 10000 });
  await page.waitForSelector('#library:not([hidden])');
  ok('a page restored from the back/forward cache reloads');
  await record(3);
} catch (e) {
  fail(e.message.split('\n')[0]);
  await shot('fail.png').catch(() => {});
}
check(!errors.length, 'no page errors', errors.join(' | '));
await browser.close();
