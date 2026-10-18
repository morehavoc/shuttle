// Phone end-to-end (WebKit, iPhone 15 emulation), on two phones and a laptop:
//   - iOS 27: Safari records the screen (the system picker shares the whole screen), so setup
//     offers Screen + cam / Screen / Camera, and every mode records with the phone recording bar
//     (full width, labelled buttons, Delete apart from Stop). Screen + cam is recorded again
//     without a refresh: after deleting one mid-recording, via Library, and after the
//     back/forward-cache restore that left the library stuck under "Finishing upload". The same
//     restore event mid-recording (a phone coming back from another app) must not reload.
//   - iOS 26 and older: no screen capture, so setup is camera only and says why.
//   - a laptop (no touch): the compact bar and no "Tap to cancel", as before.
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

const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);
const check = (cond, good, bad) => (cond ? ok(good) : fail(bad || good));

const browser = await pw.webkit.launch();

async function open(name, { phone, screen }) {
  const out = path.join(root, 'test', 'out', `webkit-${name}`);
  mkdirSync(out, { recursive: true });
  const ctx = await browser.newContext({
    ...(phone ? pw.devices['iPhone 15'] : { viewport: { width: 1280, height: 860 } }),
    ignoreHTTPSErrors: true,
  });
  await ctx.addInitScript((screen) => {
    const md = MediaDevices.prototype;
    function fakeVideo(w, h) {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); let f = 0;
      setInterval(() => { f++; g.fillStyle = `hsl(${(f * 3) % 360},60%,40%)`; g.fillRect(0, 0, c.width, c.height); }, 33);
      return c.captureStream(30);
    }
    if (screen) {
      // iOS 27: getDisplayMedia opens the system screen-sharing picker and shares the whole screen.
      Object.defineProperty(md, 'getDisplayMedia', { configurable: true, value: async () => {
        if (window.__holdPicker) await new Promise((r) => { window.__pickerUp = r; }); // the picker waits for a tap
        const s = fakeVideo(720, 1560);
        const t = s.getVideoTracks()[0];
        const orig = t.getSettings.bind(t);
        t.getSettings = () => ({ ...orig(), displaySurface: 'monitor' });
        return s;
      } });
    } else Object.defineProperty(md, 'getDisplayMedia', { value: undefined, configurable: true }); // iOS 26 and older
    Object.defineProperty(md, 'getUserMedia', { configurable: true, value: async (c) => {
      const t = [];
      if (c.video) t.push(fakeVideo(720, 1280).getVideoTracks()[0]);
      if (c.audio) {
        const a = new AudioContext(); const d = a.createMediaStreamDestination(); const o = a.createOscillator();
        o.connect(d); o.start(); t.push(d.stream.getAudioTracks()[0]);
      }
      return new MediaStream(t);
    } });
    const start = MediaRecorder.prototype.start; // kept, so a test can make one fail
    MediaRecorder.prototype.start = function (...a) { (window.__recorders = window.__recorders || []).push(this); return start.apply(this, a); };
    Object.defineProperty(md, 'enumerateDevices', { configurable: true, value: async () => [
      { kind: 'videoinput', deviceId: 'front', label: 'Front Camera' }, { kind: 'audioinput', deviceId: 'mic', label: 'iPhone Microphone' },
    ] });
  }, screen);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  const shot = (file) => page.screenshot({ path: path.join(out, file) });

  async function signIn() {
    await page.goto(BASE + '/');
    await page.waitForSelector('#signin:not([hidden]), #library:not([hidden])');
    if (await page.isVisible('#signin')) { await page.fill('#password', PASSWORD); await page.click('#signin-form button'); }
    await page.waitForSelector('#library:not([hidden])');
  }
  async function openSetup(mode) {
    await page.click('#new-recording');
    await page.waitForSelector('.sheet');
    if (mode) await page.click(`.seg button[data-mode="${mode}"]`);
    if (mode !== 'screen') {
      await page.waitForFunction(() => { const v = document.querySelector('#setup-cam'); return v && v.videoWidth > 0; }, null, { timeout: 15000 });
    }
  }
  async function startRecording() {
    await page.click('#start');
    await page.waitForSelector('.countdown small', { state: 'attached' });
    const hint = await page.evaluate(() => { const s = document.querySelector('.countdown small'); return s && getComputedStyle(s).display !== 'none' ? s.textContent : null; });
    await page.waitForSelector('.recbar:not([hidden])', { timeout: 20000 });
    return hint;
  }
  // The recording bar as laid out: sizes, labels, order, one row, and every control on screen,
  // also with an hour-long timer and an upload status (a pill above the bar on a phone) showing.
  function readBar() {
    return page.evaluate(async () => {
      const bar = document.querySelector('.recbar');
      await Promise.all(bar.getAnimations().map((a) => a.finished)); // the bar slides in
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const label = (s) => { const el = document.querySelector(s + ' b'); return el && getComputedStyle(el).display !== 'none' ? el.textContent : null; };
      const layout = () => {
        const b = bar.getBoundingClientRect();
        const btns = [...bar.querySelectorAll('button:not([hidden])')].map((el) => el.getBoundingClientRect());
        const mids = btns.map((x) => x.top + x.height / 2);
        return {
          oneRow: Math.max(...mids) - Math.min(...mids) <= 4 && b.height <= 80,
          onScreen: btns.every((x) => x.left >= 0 && x.right <= innerWidth && x.bottom <= innerHeight && x.width > 0),
        };
      };
      const plain = layout();
      const time = bar.querySelector('.time'), up = bar.querySelector('.up');
      const saved = [time.textContent, up.textContent];
      time.textContent = '1:00:00';
      up.textContent = 'Reconnecting…';
      const busy = layout();
      const u = up.getBoundingClientRect(), b = bar.getBoundingClientRect();
      const pill = u.width > 0 && u.left >= 0 && u.right <= innerWidth && u.top >= 0 && u.bottom <= b.top;
      [time.textContent, up.textContent] = saved;
      return {
        width: Math.round(b.width), vw: innerWidth, bottom: Math.round(innerHeight - b.bottom),
        pause: label('.recbar [title="Pause"]'), del: label('.recbar .rec-delete'),
        pauseH: r('.recbar [title="Pause"]').height, stopH: r('.recbar .stop').height,
        deleteLeftOfTime: r('.recbar .rec-delete').right <= r('.recbar .time').left,
        oneRow: plain.oneRow && busy.oneRow, onScreen: plain.onScreen && busy.onScreen, pill,
      };
    });
  }
  function checkPhoneBar(bar, what) {
    const got = `${what}: ${JSON.stringify(bar)}`;
    check(bar.width >= bar.vw - 24 && bar.bottom === 10, `${what}: recording bar spans the phone width, 10 px off the bottom`, got);
    check(bar.pause === 'Pause' && bar.del === 'Delete', `${what}: Pause and Delete are labelled`, got);
    check(bar.pauseH >= 44 && bar.stopH >= 44, `${what}: buttons are at least 44 px tall`, got);
    check(bar.deleteLeftOfTime, `${what}: Delete sits at the far end from Stop`, got);
    check(bar.oneRow && bar.onScreen && bar.pill, `${what}: one row, every control on screen, also at 1:00:00 with "Reconnecting…" above`, got);
  }
  // Record one in `mode` (null: no picker to use), check the bar, stop, and read the stored video.
  async function record(mode, what) {
    await openSetup(mode);
    const hint = await startRecording();
    if (phone) {
      check(hint === 'Tap to cancel', `${what}: the countdown says "Tap to cancel"`, `${what}: countdown hint ${hint}`);
      checkPhoneBar(await readBar(), what);
    }
    await page.waitForTimeout(2500);
    await page.click('.recbar .stop');
    await page.waitForURL(/\/v\//, { timeout: 30000 });
    await page.waitForSelector('video, .sp', { timeout: 15000 });
    const id = new URL(page.url()).pathname.split('/')[2];
    const v = await page.evaluate(async (id) => (await fetch(`/api/videos/${id}`, { credentials: 'same-origin' })).json(), id);
    ok(`${what}: reached its share page (${v.mode}${v.hasCam ? ', with camera' : ''}${v.surface ? `, ${v.surface}` : ''})`);
    return v;
  }
  return { page, errors, shot, signIn, openSetup, startRecording, readBar, checkPhoneBar, record, close: () => ctx.close() };
}

async function run(name, opts, body) {
  console.log(`--- ${name}`);
  const t = await open(name, opts);
  try { await body(t); }
  catch (e) { fail(`${name}: ${e.message.split('\n')[0]}`); await t.shot('fail.png').catch(() => {}); }
  check(!t.errors.length, `${name}: no page errors`, `${name}: ${t.errors.join(' | ')}`);
  await t.close();
}

await run('iphone-ios27', { phone: true, screen: true }, async (t) => {
  const { page } = t;
  await t.signIn();

  // ---------- setup: all three modes ----------
  await t.openSetup(null);
  await page.waitForTimeout(400);
  await t.shot('1-setup.png');
  const setup = await page.evaluate(() => ({
    modes: [...document.querySelectorAll('.sheet .seg button')].map((b) => `${b.dataset.mode}${b.disabled ? ':disabled' : ''}${b.getAttribute('aria-pressed') === 'true' ? ':on' : ''}`),
    note: document.querySelector('#setup-note').textContent,
  }));
  check(setup.modes.join() === 'screen-camera:on,screen,camera' && !setup.note, 'setup offers Screen + cam (picked), Screen and Camera, no note', JSON.stringify(setup));

  // ---------- Screen + cam: the bar, pause, delete mid-recording ----------
  await t.startRecording();
  await page.waitForTimeout(800);
  await t.shot('2-recording-screen-cam.png');
  const note = await page.evaluate(() => { const n = document.querySelector('.stage-note'); return n && !n.hidden ? n.textContent : null; });
  check(!!note && /Whole screen/.test(note), 'whole-screen share: the camera preview is put away (no double face)', `stage note: ${note}`);
  t.checkPhoneBar(await t.readBar(), 'Screen + cam');
  // Narrow and wide phones (320 is a 375 phone with Display Zoom).
  const size = page.viewportSize();
  for (const width of [320, 360, 375, 430]) {
    await page.setViewportSize({ width, height: 700 });
    t.checkPhoneBar(await t.readBar(), `${width} px wide`);
  }
  await page.setViewportSize(size);
  // Back in Safari from the app being shown: a mobile browser may fire pageshow on a page it
  // thaws. That must not reload the page under a live recording.
  await page.evaluate(() => { window.__live = true; window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await page.waitForTimeout(1500);
  const still = await page.evaluate(() => ({ live: window.__live === true, bar: !!document.querySelector('.recbar:not([hidden])') }));
  check(still.live && still.bar, 'a pageshow mid-recording (back from another app) leaves the recording alone', JSON.stringify(still));
  await page.click('.recbar [title="Pause"]');
  await page.waitForSelector('.recbar.paused');
  check((await page.textContent('.recbar [title="Resume"] b')) === 'Resume', 'paused: the button says Resume');
  await page.click('.recbar [title="Resume"]');
  await page.click('.recbar .rec-delete');
  await page.waitForSelector('.recbar', { state: 'detached' });
  ok('deleted mid-recording');

  // ---------- record again without a refresh ----------
  let v = await t.record(null, 'Screen + cam 1');
  check(v.mode === 'screen-camera' && v.hasCam && v.surface === 'monitor', 'stored as screen + camera, two files', JSON.stringify({ mode: v.mode, hasCam: v.hasCam, surface: v.surface }));
  await page.click('a:has-text("Library")');
  await page.waitForSelector('#library:not([hidden])');
  v = await t.record(null, 'Screen + cam 2, via Library');
  check(v.mode === 'screen-camera' && v.hasCam, 'second Screen + cam stored with its camera', JSON.stringify({ mode: v.mode, hasCam: v.hasCam }));

  // ---------- back/forward cache restore ----------
  // The stuck page: Stop finished the upload and sent the page to the share link; Back brings
  // this page back as it was, under "Finishing upload". Holding the share page's request keeps
  // it here, in that state.
  await page.click('a:has-text("Library")');
  await page.waitForSelector('#library:not([hidden])');
  await t.openSetup(null);
  await t.startRecording();
  await page.waitForTimeout(1500);
  let leftFor;
  const left = new Promise((r) => { leftFor = r; });
  await page.route('**/v/**', (route) => leftFor(route.request().url())); // never answered
  await page.click('.recbar .stop');
  await left;
  const stuck = await page.evaluate(() => !!document.querySelector('.finishing'));
  await page.evaluate(() => { window.__stale = true; window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await page.waitForFunction(() => !window.__stale, null, { timeout: 10000 });
  await page.waitForSelector('#library:not([hidden])');
  await page.unroute('**/v/**');
  check(stuck, 'the page left under "Finishing upload" reloads when Safari brings it back');

  // While the screen picker is up (a system sheet over Safari), a restore must not reload either.
  await t.openSetup('screen');
  await page.evaluate(() => { window.__holdPicker = true; window.__starting = true; });
  await page.click('#start');
  await page.waitForFunction(() => typeof window.__pickerUp === 'function');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForTimeout(1500);
  const starting = await page.evaluate(() => window.__starting === true && !!document.querySelector('.sheet'));
  check(starting, 'a pageshow while the screen picker is up leaves the start alone');
  await page.evaluate(() => { window.__holdPicker = false; window.__pickerUp(); });
  await page.waitForSelector('.recbar:not([hidden])', { timeout: 20000 });
  await page.click('.recbar .rec-delete');
  await page.waitForSelector('.recbar', { state: 'detached' });
  v = await t.record('screen-camera', 'Screen + cam 3, after the restore');
  check(v.mode === 'screen-camera' && v.hasCam, 'third Screen + cam stored with its camera', JSON.stringify({ mode: v.mode, hasCam: v.hasCam }));

  // ---------- the other two modes ----------
  await page.click('a:has-text("Library")');
  await page.waitForSelector('#library:not([hidden])');
  v = await t.record('screen', 'Screen');
  check(v.mode === 'screen' && !v.hasCam, 'Screen stored without a camera file', JSON.stringify({ mode: v.mode, hasCam: v.hasCam }));
  await page.click('a:has-text("Library")');
  await page.waitForSelector('#library:not([hidden])');
  v = await t.record('camera', 'Camera');
  check(v.mode === 'camera', 'Camera stored as camera', JSON.stringify({ mode: v.mode }));

  // ---------- the recorder dies while paused (pause, switch apps, come back) ----------
  await page.click('a:has-text("Library")');
  await page.waitForSelector('#library:not([hidden])');
  await t.openSetup('screen-camera');
  await t.startRecording();
  await page.waitForTimeout(1500);
  await page.click('.recbar [title="Pause"]');
  await page.waitForSelector('.recbar.paused');
  await page.evaluate(() => window.__recorders[window.__recorders.length - 1].dispatchEvent(new Event('error')));
  await page.waitForURL(/\/v\//, { timeout: 30000 });
  const id = new URL(page.url()).pathname.split('/')[2];
  v = await page.evaluate(async (id) => (await fetch(`/api/videos/${id}`, { credentials: 'same-origin' })).json(), id);
  check(v.mode === 'screen-camera' && v.durationMs > 1000, 'a recording whose recorder fails while paused is saved, not stuck', JSON.stringify({ mode: v.mode, durationMs: v.durationMs }));
});

await run('iphone-ios26', { phone: true, screen: false }, async (t) => {
  const { page } = t;
  await t.signIn();
  await t.openSetup(null);
  await page.waitForTimeout(400);
  await t.shot('1-setup.png');
  const setup = await page.evaluate(() => ({ seg: !!document.querySelector('.sheet .seg'), note: document.querySelector('#setup-note').textContent }));
  check(!setup.seg && setup.note === 'This browser can’t record the screen.', 'no screen capture: camera only, and the setup says so', JSON.stringify(setup));
  await page.click('.sheet [aria-label="Close"]');
  const v = await t.record(null, 'Camera only');
  check(v.mode === 'camera', 'stored as camera', JSON.stringify({ mode: v.mode }));
});

await run('laptop', { phone: false, screen: true }, async (t) => {
  const { page } = t;
  await t.signIn();
  await t.openSetup('camera');
  const hint = await t.startRecording();
  check(hint === null, 'laptop: no "Tap to cancel" on the countdown', `countdown hint ${hint}`);
  await page.waitForTimeout(500);
  await t.shot('1-recording.png');
  const bar = await t.readBar();
  check(bar.width < 600 && bar.pause === null && bar.del === null && !bar.deleteLeftOfTime, 'laptop: the compact bar, icons only, Delete next to Stop', JSON.stringify(bar));
  await page.click('.recbar .rec-delete');
  await page.waitForSelector('.recbar', { state: 'detached' });
  ok('laptop: deleted');
});

await browser.close();
