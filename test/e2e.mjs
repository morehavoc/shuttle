// Browser end-to-end: sign in, record (fake camera/mic/screen), stop, land on the share page,
// play the composited video, switch layouts, edit from the transcript, then check what a
// viewer sees. Runs against BASE (a running `wrangler dev --env local`, TRANSCRIBE_FAKE=1).
//   BASE=https://host:port PASSWORD=… ENGINE=chromium|webkit MODE=screen-camera|screen|camera node test/e2e.mjs
//   SURFACE=window  → the fake screen reports a window share (keeps the floating bubble)
//   FAULT=flaky|fatal → a dropped network / a refused upload
//   FAKE=1          → synthetic streams in Chromium too (WebKit always uses them). They carry a
//                     time code, so camera/screen sync is checked frame by frame.
//   OFFSET_MS=700   → start the camera recorder late; the player must still line it up
//   CAM_END=1       → the camera stops mid-recording; the player must hold its last frame
//   SPEECH=1        → the fake mic speaks a sentence every 4 s; with a server using a real
//                     transcriber (TRANSCRIBE=real sh test/serve.sh) checks the words' timing
// Playwright is resolved from PLAYWRIGHT_DIR (default: ../node_modules/playwright).

import { createRequire } from 'node:module';
import { mkdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_DIR || path.join(root, '..', 'node_modules', 'playwright'));

const BASE = process.env.BASE || 'http://localhost:8799';
const PASSWORD = process.env.PASSWORD || 'test-password-123';
const ENGINE = process.env.ENGINE || 'chromium';
const MODE = process.env.MODE || 'screen-camera';
const SECONDS = Number(process.env.SECONDS || 8);
const FAULT = process.env.FAULT;
const OFFSET_MS = Number(process.env.OFFSET_MS || 0);
const CAM_END = !!process.env.CAM_END;
const SPEECH = !!process.env.SPEECH;
const FAKE_MEDIA = ENGINE === 'webkit' || !!process.env.FAKE || SPEECH || OFFSET_MS > 0 || CAM_END;
const out = path.join(root, 'test', 'out', `${ENGINE}-${MODE}${process.env.SURFACE ? '-' + process.env.SURFACE : ''}${SPEECH ? '-speech' : ''}${OFFSET_MS ? '-offset' : ''}${CAM_END ? '-camend' : ''}`);
mkdirSync(out, { recursive: true });

// Different sentences (Whisper collapses a phrase repeated over and over), each with a distinct
// first word whose onset is the start of the clip (leading silence trimmed).
const SENTENCES = [
  'Silver apples sat on the kitchen table.', 'Yesterday the river was quiet and cold.', 'Purple lanterns lit the harbor at night.',
  'Copper wires hummed in the evening wind.', 'Morning fog covered the whole valley.', 'Gentle rain tapped on the metal roof.',
];
const speech = [];
if (SPEECH) {
  SENTENCES.forEach((text, i) => {
    const wav = path.join(root, 'test', 'out', `speech-${i}.wav`);
    if (!existsSync(wav)) {
      execFileSync('say', ['-v', 'Samantha', text, '-o', '/tmp/shuttle-speech.aiff']);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', '/tmp/shuttle-speech.aiff', '-af', 'silenceremove=start_periods=1:start_threshold=-45dB', '-ar', '16000', '-ac', '1', wav]);
    }
    speech.push({ word: text.split(' ')[0].toLowerCase(), b64: readFileSync(wav).toString('base64') });
  });
}

const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };
const ok = (m) => console.log('  ok  ', m);
const check = (cond, good, bad) => (cond ? ok(good) : fail(bad || good));

const launchOpts = ENGINE === 'chromium'
  ? { args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--auto-accept-this-tab-capture',
      '--autoplay-policy=no-user-gesture-required',
    ] }
  : {};
const browser = await pw[ENGINE].launch(launchOpts);

async function newContext() {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    ignoreHTTPSErrors: true,
    permissions: ENGINE === 'chromium' ? ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] : [],
  });
  // WebKit under Playwright can't grant camera permission on macOS (the prompt never resolves),
  // so it gets synthetic canvas/oscillator streams. That still exercises WebKit's MediaRecorder,
  // the upload path and the player.
  if (FAKE_MEDIA) {
    await ctx.addInitScript(({ noise, surface, speech, offsetMs }) => {
      const camIds = new Set();
      window.__rec = [];    // MediaRecorder start/pause/resume/stop, by wall clock
      if (speech.length) window.__shuttleTapLog = [];
      window.__speech = []; // when each "Alpha. Bravo. Charlie." began
      // A 16-bit time code (20 ms units) as big black/white blocks across the top. It survives
      // compression, so the test can read which moment any frame was captured at.
      function stamp(g, w, h) {
        const code = Math.floor(performance.now() / 20) & 0xffff;
        const b = Math.round(h / 18);
        for (let i = 0; i < 16; i++) { g.fillStyle = (code >> (15 - i)) & 1 ? '#fff' : '#000'; g.fillRect(b * i, 0, b, b); }
      }
      function fakeVideo(w, h, label) {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d'); let f = 0;
        const draw = () => {
          f++; g.fillStyle = `hsl(${(f * 2) % 360},60%,35%)`; g.fillRect(0, 0, w, h);
          if (noise) for (let i = 0; i < 400; i++) { g.fillStyle = `hsl(${Math.random() * 360},80%,50%)`; g.fillRect(Math.random() * w, Math.random() * h, 40, 40); }
          g.fillStyle = '#fff'; g.font = `${Math.round(h / 8)}px sans-serif`; g.fillText(`${label} ${f}`, w / 10, h / 2);
          stamp(g, w, h);
        };
        draw(); setInterval(draw, 33);
        return c.captureStream(30);
      }
      let dest = null;
      function fakeAudio() {
        if (!dest) {
          const ctx = new AudioContext();
          dest = ctx.createMediaStreamDestination();
          if (speech.length) {
            // A real mic never stops sending audio, even in silence; keep frames flowing.
            const hum = ctx.createOscillator(); const zero = ctx.createGain(); zero.gain.value = 0;
            hum.connect(zero); zero.connect(dest); hum.start();
            Promise.all(speech.map((c) => ctx.decodeAudioData(Uint8Array.from(atob(c.b64), (ch) => ch.charCodeAt(0)).buffer))).then((bufs) => {
              let k = 0;
              const say = () => {
                if (window.__speechOff) return;
                const i = k++ % bufs.length;
                const src = ctx.createBufferSource(); src.buffer = bufs[i]; src.connect(dest); src.start();
                window.__speech.push({ t: performance.now(), word: speech[i].word, len: bufs[i].duration });
              };
              setTimeout(say, 500);
              setInterval(say, 4000);
            });
          } else {
            // A steady tone, so the transcript tap hears "speech".
            const o = ctx.createOscillator(); const gain = ctx.createGain();
            gain.gain.value = 0.5; o.connect(gain); gain.connect(dest); o.start();
          }
          ctx.resume().catch(() => {});
        }
        return new MediaStream(dest.stream.getAudioTracks().map((t) => t.clone()));
      }
      const md = MediaDevices.prototype;
      const def = (k, fn) => Object.defineProperty(md, k, { value: fn, configurable: true, writable: true });
      def('getUserMedia', async (c) => {
        const tracks = [];
        if (c.video) { const t = fakeVideo(1280, 720, 'CAM').getVideoTracks()[0]; camIds.add(t.id); window.__camTrack = t; tracks.push(t); }
        if (c.audio) tracks.push(...fakeAudio().getAudioTracks());
        return new MediaStream(tracks);
      });
      def('getDisplayMedia', async () => {
        const s = fakeVideo(1920, 1080, 'SCREEN');
        const t = s.getVideoTracks()[0];
        if (surface) { const orig = t.getSettings.bind(t); t.getSettings = () => ({ ...orig(), displaySurface: surface }); }
        return s;
      });
      def('enumerateDevices', async () => [
        { kind: 'videoinput', deviceId: 'cam1', label: 'FaceTime HD Camera', groupId: 'g' },
        { kind: 'audioinput', deviceId: 'mic1', label: 'MacBook Pro Microphone', groupId: 'g' },
      ]);
      // Log recorder events; optionally start the camera-only recorder late.
      const R = MediaRecorder.prototype;
      const isCam = (r) => !r.stream.getAudioTracks().length && r.stream.getVideoTracks().some((t) => camIds.has(t.id));
      const start = R.start;
      R.start = function (...a) {
        const cam = isCam(this);
        const go = () => { window.__rec.push({ ev: 'start', cam, t: performance.now() }); return start.apply(this, a); };
        if (cam && offsetMs) { setTimeout(go, offsetMs); return undefined; }
        return go();
      };
      for (const ev of ['pause', 'resume', 'stop']) {
        const orig = R[ev];
        R[ev] = function (...a) { window.__rec.push({ ev, cam: isCam(this), t: performance.now() }); return orig.apply(this, a); };
      }
    }, { noise: !!process.env.NOISE, surface: process.env.SURFACE || '', speech, offsetMs: OFFSET_MS });
  }
  return ctx;
}

const ctx = await newContext();
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));
const shot = (name) => page.screenshot({ path: path.join(out, name) });

try {
  // ---------- sign in ----------
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
  await shot('1-library.png');
  ok('signed in, library visible');

  // ---------- record ----------
  await page.click('#new-recording');
  await page.waitForSelector('.sheet');
  await page.click(`.seg button[data-mode="${MODE}"]`);
  if (MODE !== 'screen') {
    await page.waitForFunction(() => { const v = document.querySelector('#setup-cam'); return v && v.videoWidth > 0 && !v.paused; }, null, { timeout: 15000 });
    ok('camera preview live');
  }
  await page.waitForTimeout(500);
  await shot('2-setup.png');

  if (FAULT === 'flaky') {
    let until = 0;
    await page.route('**/parts/**', (route) => (Date.now() < until ? route.abort('internetdisconnected') : route.continue()));
    setTimeout(() => { until = Date.now() + 8000; }, 6000);
  }
  if (FAULT === 'fatal') {
    await page.route('**/parts/**', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"Bad part"}' }));
  }

  // Keep a copy of each transcript chunk as it uploads (the server deletes them once transcribed).
  const tapped = [];
  if (SPEECH) {
    await page.route('**/api/videos/*/audio/*', (route) => {
      const r = route.request();
      tapped.push({ start: Number(r.headers()['x-start-ms']) / 1000, dur: Number(r.headers()['x-duration-ms']) / 1000, silent: !!r.headers()['x-silent'], body: r.postDataBuffer() });
      route.continue();
    });
  }

  await page.click('#start');
  const extra = page.locator('.countdown .btn-rec');
  try { await extra.waitFor({ timeout: 2500 }); await shot('3-ask-bubble.png'); await extra.click(); ok('bubble prompt shown and accepted'); } catch {}
  await page.waitForSelector('.recbar:not([hidden])', { timeout: 20000 });
  ok('recording started');
  await page.waitForTimeout(600);
  await shot('4-recording.png');
  if (MODE === 'screen-camera') {
    const stage = await page.evaluate(() => ({
      self: !!document.querySelector('.stage-self video') && document.querySelector('.stage-self video').videoWidth > 0,
      selfShown: !!document.querySelector('.stage-self') && !document.querySelector('.stage-self').classList.contains('stage-hidden'),
      floatBtn: !document.querySelector('.recbar [title="Float camera"]').hidden,
      note: !document.querySelector('.stage-note')?.hidden,
      setupCamInViewport: (() => { const v = document.querySelector('#setup-cam'); if (!v) return null; const r = v.getBoundingClientRect(); return r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight && !v.paused; })(),
    }));
    check(stage.self, 'self-view video stays live (Safari thumbnail source)', 'self-view video not live');
    if (process.env.SURFACE === 'window') check(stage.selfShown, 'window share shows the self-view', 'self-view hidden on a window share');
    else check(!stage.selfShown && !stage.floatBtn, 'whole-screen share hides the on-page self-view and Float camera (no double face)', `self-view ${stage.selfShown}, float button ${stage.floatBtn}`);
    check(stage.setupCamInViewport === true, 'bubble source stays on screen and playing (Safari freeze fix)', `bubble source moved or paused: ${stage.setupCamInViewport}`);
    const bubble = await page.evaluate(() => document.documentElement.dataset.bubble);
    if (process.env.SURFACE === 'window') {
      if (bubble === 'none') ok('no floating bubble in this browser (headless) — skipping bubble check');
      else check(bubble === 'open' && !stage.note, 'window share keeps the bubble', `bubble ${bubble}`);
    } else check(bubble === 'off-whole-screen' && stage.note, 'whole-screen share turns the floating bubble off', `bubble ${bubble}`);
  }
  await page.waitForTimeout(SECONDS * 500);
  if (!process.env.NOPAUSE) {
    await page.click('.recbar .icon-btn[title="Pause"]');
    await page.waitForSelector('.recbar.paused');
    await page.waitForTimeout(1500);
    await page.click('.recbar .icon-btn[title="Resume"]');
    ok('pause / resume');
  }
  if (CAM_END) {
    await page.waitForTimeout(1000);
    // stop() alone fires no 'ended'; a camera that is unplugged or taken by another app does.
    await page.evaluate(() => { window.__camTrack.stop(); window.__camTrack.dispatchEvent(new Event('ended')); });
    ok('camera stopped mid-recording');
    await page.waitForTimeout(Math.max(3500, SECONDS * 500 - 1000));
  } else await page.waitForTimeout(SECONDS * 500);
  const shownTime = await page.textContent('.recbar .time');
  const log = await page.evaluate(() => { window.__speechOff = true; return { rec: window.__rec || [], speech: window.__speech || [], now: performance.now(), tap: window.__shuttleTapLog || [] }; });
  if (log.tap.length) (await import('node:fs')).writeFileSync(path.join(out, 'tap-log.json'), JSON.stringify(log.tap));

  if (FAULT === 'fatal') {
    const up = await page.textContent('.recbar .up');
    check(up === 'Upload failed', 'recbar shows "Upload failed" while recording', `recbar did not show the upload failure: ${up}`);
    await page.click('.recbar .stop');
    await page.waitForSelector('.finishing >> text=/Upload failed/', { timeout: 20000 });
    await shot('fatal.png');
    check(!(await page.isVisible('.finishing >> text=Retry')), 'no false Retry', 'Retry offered although parts were lost');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.finishing >> text=Download copy')]);
    const f = path.join(out, 'local-copy.mp4'); await dl.saveAs(f);
    check(statSync(f).size > 10000, `local copy downloaded (${statSync(f).size} bytes)`, 'local copy too small');
    throw Object.assign(new Error('done'), { expected: true });
  }

  await page.click('.recbar .stop');
  await page.waitForURL(/\/v\/[A-Za-z0-9]+/, { timeout: 60000 });
  const shareUrl = page.url().split('?')[0];
  ok(`stopped at ${shownTime}, landed on ${shareUrl}`);
  await page.waitForSelector('.sp', { timeout: 30000 });
  await page.waitForTimeout(800);
  await shot('5-share.png');

  // ---------- play the composite ----------
  const meta = await page.evaluate(() => window.__SHUTTLE__.video);
  // Reads the time codes burnt into the fake streams: which capture moment each video shows.
  const codes = () => page.evaluate(() => {
    const read = (v) => {
      if (!v || v.readyState < 2 || !v.videoWidth) return null;
      const b = Math.round(v.videoHeight / 18);
      const c = document.createElement('canvas'); c.width = b * 16; c.height = b;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(v, 0, 0, b * 16, b, 0, 0, b * 16, b);
      let code = 0;
      for (let i = 0; i < 16; i++) { const d = g.getImageData(b * i + (b >> 1), b >> 1, 1, 1).data; code = (code << 1) | (d[0] + d[1] + d[2] > 384 ? 1 : 0); }
      return code;
    };
    const m = document.querySelector('.sp-main'), c = document.querySelector('.sp-cam');
    return { main: read(m), cam: read(c), t: m.currentTime, ct: c ? c.currentTime : null, camPaused: c ? c.paused : null, camDur: c ? c.duration : null, playing: !m.paused };
  });
  const gap = (a, b) => { let d = (a - b) & 0xffff; if (d > 0x8000) d -= 0x10000; return d * 0.02; };
  const syncCheck = async (label) => {
    if (!(FAKE_MEDIA && MODE === 'screen-camera')) return;
    const c = await codes();
    if (c.main == null || c.cam == null) return fail(`${label}: couldn't read the frames (${JSON.stringify(c)})`);
    if (CAM_END && c.t - meta.camOffsetMs / 1000 >= c.camDur - 0.1) return ok(`${label}: past the camera's end (checked below)`);
    const d = gap(c.main, c.cam);
    check(Math.abs(d) <= (c.playing ? 0.15 : 0.1), `${label}: camera frame matches the screen frame (${(d * 1000).toFixed(0)} ms apart)`,
      `${label}: camera ${(d * 1000).toFixed(0)} ms off the screen (${JSON.stringify(c)})`);
  };
  if (MODE === 'screen-camera') check(meta.hasCam, 'camera stored as its own track', `no camera track: ${JSON.stringify(meta)}`);
  await page.click('.sp-big');
  await page.waitForTimeout(2600);
  const play = await page.evaluate(() => {
    const m = document.querySelector('.sp-main'), c = document.querySelector('.sp-cam');
    const off = (window.__SHUTTLE__.video.camOffsetMs || 0) / 1000;
    return { t: m.currentTime, paused: m.paused, dur: m.duration, err: m.error && m.error.code, cam: c ? c.currentTime : null, camPaused: c ? c.paused : null, off,
      camBox: c ? (() => { const r = c.parentElement.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })() : null };
  });
  console.log('       playback:', JSON.stringify(play));
  check(!play.err && play.t > 1 && !play.paused, 'main video plays', 'main video did not play');
  check(Number.isFinite(play.dur) && play.dur > SECONDS - 2, `duration ${play.dur && play.dur.toFixed(1)} s`, `bad duration ${play.dur}`);
  if (MODE === 'screen-camera') {
    check(!play.camPaused && Math.abs(play.cam - (play.t - play.off)) < 0.4, `camera plays in sync (drift ${(play.cam - play.t + play.off).toFixed(2)} s)`, `camera out of sync: ${play.cam} vs ${play.t}`);
    check(play.camBox && play.camBox[0] > 80, 'camera overlay visible', 'camera overlay missing');
    if (OFFSET_MS) check(Math.abs(play.off * 1000 - OFFSET_MS) < 250, `late camera start measured (${Math.round(play.off * 1000)} ms)`, `camera offset ${Math.round(play.off * 1000)} ms, expected ~${OFFSET_MS}`);
  }
  await syncCheck('playing, before the pause');
  await shot('6-playing.png');
  await page.evaluate(() => { const s = document.querySelector('.sp-scrub'); s.value = String(Number(s.max) / 2); s.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(800);
  const seek = await page.evaluate(() => ({ t: document.querySelector('.sp-main').currentTime, max: Number(document.querySelector('.sp-scrub').max) }));
  check(Math.abs(seek.t - seek.max / 2) < 1.2, `seeks (${seek.t.toFixed(1)} of ${seek.max.toFixed(1)})`, `seek missed: ${JSON.stringify(seek)}`);
  await syncCheck('playing, after a seek');
  await page.evaluate(() => document.querySelector('.sp-main').pause());
  if (FAKE_MEDIA && MODE === 'screen-camera') {
    // Paused, after the recording's pause: frames must match exactly.
    await page.evaluate(() => { const s = document.querySelector('.sp-scrub'); s.value = String(Number(s.max) * (0.62)); s.dispatchEvent(new Event('input')); });
    await page.waitForTimeout(900);
    await syncCheck('paused, after the recording paused');
  }
  if (CAM_END) {
    // Past the end of the (shorter) camera file: the camera holds its last frame.
    await page.evaluate(() => { const s = document.querySelector('.sp-scrub'); s.value = String(Number(s.max) * 0.9); s.dispatchEvent(new Event('input')); document.querySelector('.sp-main').play(); });
    await page.waitForTimeout(500);
    const a = await codes();
    await page.waitForTimeout(400);
    const b = await codes();
    console.log('       camera end:', JSON.stringify({ a, b }));
    check(b.playing && b.camPaused && Math.abs(b.ct - b.camDur) < 0.3 && b.cam === a.cam,
      'camera holds its last frame after its file ends', `camera after its end: ${JSON.stringify(b)}`);
    await page.evaluate(() => document.querySelector('.sp-main').pause());
    const notice = await page.evaluate(() => document.querySelector('#owner-panel').textContent);
    check(/camera stopped/i.test(notice), 'owner told the camera stopped', `no camera notice: ${notice}`);
  }

  // ---------- layouts ----------
  if (MODE === 'screen-camera') {
    await page.click('.owner-panel button[data-kind="side"]');
    await page.waitForTimeout(600);
    check(await page.evaluate(() => document.querySelector('.sp').classList.contains('sp-framed')), 'Side layout');
    await shot('7-layout-side.png');
    await page.click('.owner-panel button[data-kind="card"]');
    await page.click('.owner-panel button[data-corner="br"]');
    await page.click('.owner-panel button[data-size="l"]');
    await page.waitForTimeout(700);
    const card = await page.evaluate(() => { const r = document.querySelector('.sp-cam-wrap').getBoundingClientRect(); const s = document.querySelector('.sp').getBoundingClientRect(); return { right: s.right - r.right, ratio: r.height / r.width }; });
    check(card.right < 80 && Math.abs(card.ratio - 1.25) < 0.05, 'Card layout, bottom-right, large', `card misplaced: ${JSON.stringify(card)}`);
    await shot('8-layout-card.png');
  }

  // ---------- transcript timing (real transcriber) ----------
  if (SPEECH) {
    let t = null;
    for (let i = 0; i < 90; i++) {
      t = await page.evaluate((id) => fetch(`/api/videos/${id}/transcript`).then((r) => r.json()), meta.id);
      if (t.status !== 'pending') break;
      await page.waitForTimeout(2000);
    }
    check(t.status === 'ready', `transcript ready (${t.words.length} words)`, `transcript ${t.status}: ${JSON.stringify(t).slice(0, 300)}`);
    const main = log.rec.filter((e) => !e.cam);
    const start = main.find((e) => e.ev === 'start');
    // Where a wall-clock moment landed in the video (null while paused / outside it).
    const recAt = (wall) => {
      if (!start || wall < start.t) return null;
      let t = wall - start.t, pausedAt = null;
      for (const e of main) {
        if (e.t > wall) break;
        if (e.ev === 'pause') pausedAt = e.t;
        if (e.ev === 'resume' && pausedAt != null) { t -= e.t - pausedAt; pausedAt = null; }
      }
      return pausedAt != null ? null : t / 1000;
    };
    // Where the transcript's audio sits vs. the video's own audio: speech onsets found in each
    // uploaded chunk (at its claimed start) against onsets in the recorded file. Whisper-free.
    const res = await page.request.get(`${BASE}/raw/${meta.id}`);
    const fileWav = path.join(out, 'main-audio.raw');
    const tmpVid = path.join(out, 'main-video');
    (await import('node:fs')).writeFileSync(tmpVid, await res.body());
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmpVid, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', fileWav]);
    const toPcm = (buf) => new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 2)));
    const onsets = (pcm) => {
      const W = 160, env = [];
      for (let i = 0; i + W <= pcm.length; i += W) { let q = 0; for (let j = i; j < i + W; j++) q += pcm[j] * pcm[j]; env.push(Math.sqrt(q / W) / 32768); }
      const thr = 0.02; const out = []; let quiet = 0;
      env.forEach((r, i) => { if (r < thr) quiet++; else { if (quiet >= 50) out.push(i * 0.01); quiet = 0; } });
      return out;
    };
    const fileOn = onsets(toPcm(readFileSync(fileWav)));
    const placement = [];
    for (const c of tapped) {
      if (c.silent || !c.body || c.body.length <= 44) continue;
      for (const o of onsets(toPcm(c.body.subarray(44)))) {
        const claimed = c.start + o;
        const near = fileOn.map((f) => f - claimed).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
        if (near != null && Math.abs(near) < 2) placement.push({ claimed: +claimed.toFixed(2), err: +near.toFixed(3) });
      }
    }
    tapped.forEach((c, i) => { if (c.body && c.body.length > 44) (require('node:fs')).writeFileSync(path.join(out, `chunk-${i}.wav`), c.body); });
    console.log(`       chunks: ${tapped.map((c) => `${c.start.toFixed(2)}+${c.dur.toFixed(2)}${c.silent ? ' (silent)' : ''}`).join(', ')}`);
    console.log(`       file onsets: ${fileOn.map((x) => x.toFixed(2)).join(' ')}`);
    console.log(`       chunk onsets vs file (s): ${placement.map((p) => `${p.claimed}:${p.err >= 0 ? '+' : ''}${p.err}`).join(' ')}`);
    const worstPlace = Math.max(...placement.map((p) => Math.abs(p.err)));
    if (!tapped.some((c) => c.body)) ok('upload bodies not visible in this engine — chunk placement check skipped (first-word check below still runs)');
    else check(placement.length >= Math.min(8, Math.floor(SECONDS / 5)) && worstPlace <= 0.1, `transcript audio sits where it is in the video (${placement.length} onsets, worst ${(worstPlace * 1000).toFixed(0)} ms)`,
      `transcript audio misplaced by up to ${(worstPlace * 1000).toFixed(0)} ms (${placement.length} onsets)`);

    // Each sentence wholly inside the video (not across the pause or the end).
    const said = log.speech.map((x) => ({ ...x, at: recAt(x.t), end: recAt(x.t + x.len * 1000 + 100) }))
      .filter((x) => x.at != null && x.end != null && Math.abs(x.end - x.at - x.len - 0.1) < 0.05);
    const norm = (w) => w.toLowerCase().replace(/[^a-z]/g, '');
    const diffs = [];
    for (const x of said) {
      // The sentence's onset as found in the video file (the model above only locates it).
      const onset = fileOn.map((f) => f - x.at).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
      const at = onset != null && Math.abs(onset) < 0.5 ? x.at + onset : x.at;
      const near = t.words.filter((w) => norm(w.w) === x.word).map((w) => w.s - at).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
      if (near != null && Math.abs(near) < 1.5) diffs.push(near);
    }
    console.log(`       ${said.length} sentences in the video; first-word offsets (s): ${diffs.map((d) => d.toFixed(2)).join(' ')}`);
    console.log(`       transcript: ${t.words.map((w) => `${w.w}@${w.s.toFixed(2)}`).join(' ').slice(0, 900)}`);
    // Recognition itself is Whisper's business; enough sentences must be found to judge timing.
    check(diffs.length >= Math.ceil(said.length * 0.6), `found ${diffs.length} of ${said.length} sentences`, `found only ${diffs.length} of ${said.length}`);
    // Whisper now and then hangs a sentence's first word on the end of the previous sentence;
    // that is reported, but the typical word must be right.
    const worst = Math.max(...diffs.map(Math.abs));
    const good = diffs.filter((d) => Math.abs(d) <= 0.15).length;
    check(good >= Math.ceil(diffs.length * 0.85), `${good} of ${diffs.length} first words within 150 ms of when they were said (worst ${worst.toFixed(2)} s)`, `only ${good} of ${diffs.length} first words within 150 ms (worst ${worst.toFixed(2)} s)`);
  }

  // ---------- transcript + editing ----------
  let nWords = 0;
  if (!SPEECH) {
  await page.waitForSelector('.tc-body .w', { timeout: 30000 });
  nWords = await page.locator('.tc-body .w').count();
  ok(`transcript shows ${nWords} words`);
  const durBefore = await page.evaluate(() => document.querySelector('#when').textContent);
  await page.click('.tc-tools >> text=Edit');
  await page.evaluate(() => {
    const ws = document.querySelectorAll('.tc-body .w');
    const r = document.createRange(); r.setStartBefore(ws[2]); r.setEndAfter(ws[4]);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  });
  await page.waitForSelector('.sel-tools >> text=Cut', { timeout: 5000 });
  await shot('9-edit-select.png');
  await page.click('.sel-tools >> text=Cut');
  await page.waitForTimeout(300);
  check((await page.locator('.tc-body .w.cut').count()) === 3, 'cut three selected words', `cut count ${await page.locator('.tc-body .w.cut').count()}`);
  await page.click('.tc-edit-tools >> text=Remove ums');
  await page.waitForTimeout(300);
  const cutAfterUms = await page.locator('.tc-body .w.cut').count();
  check(cutAfterUms > 3, `filler words removed (${cutAfterUms} cut)`, 'Remove ums cut nothing');
  await page.click('.tc-edit-tools >> text=Undo');
  await page.waitForTimeout(200);
  check((await page.locator('.tc-body .w.cut').count()) === 3, 'undo');
  await page.click('.tc-edit-tools >> text=Shorten pauses');
  await page.waitForTimeout(900); // debounce save
  const durAfter = await page.evaluate(() => document.querySelector('#when').textContent);
  check(durAfter !== durBefore, `edited length shown (${durBefore} → ${durAfter})`, 'length did not change after edits');
  await shot('10-edited.png');
  await page.reload();
  await page.waitForSelector('.tc-body .w');
  check((await page.locator('.tc-body .w.cut').count()) >= 3, 'edits saved');

  // captions
  await page.click('.sp-big');
  await page.waitForTimeout(400);
  if (await page.isVisible('.sp-btn[aria-label="Captions"]')) {
    await page.mouse.move(640, 300);
    await page.click('.sp-btn[aria-label="Captions"]');
    await page.waitForFunction(() => !document.querySelector('.sp-caption').hidden && document.querySelector('.sp-caption').textContent.length > 0, null, { timeout: 8000 });
    ok('captions show');
    await shot('11-captions.png');
  } else fail('no captions button');
  await page.evaluate(() => document.querySelector('.sp-main').pause());
  } // !SPEECH

  // ---------- what a viewer sees ----------
  const vctx = await newContext();
  const vpage = await vctx.newPage();
  await vpage.goto(shareUrl);
  await vpage.waitForSelector('.sp');
  await vpage.waitForSelector('.tc-body .w', { timeout: 15000 }).catch(() => {});
  const viewer = await vpage.evaluate(() => ({
    download: !!Array.from(document.querySelectorAll('button, a')).find((b) => /Download/.test(b.textContent)),
    panel: !document.querySelector('#owner-panel').hidden,
    editable: document.querySelector('#title').isContentEditable,
    cut: document.querySelectorAll('.tc-body .w.cut').length,
    words: document.querySelectorAll('.tc-body .w').length,
  }));
  check(!viewer.download && !viewer.panel && !viewer.editable, 'viewer gets no download, layout or rename controls', `viewer controls: ${JSON.stringify(viewer)}`);
  if (!SPEECH) check(viewer.cut === 0 && viewer.words < nWords, `viewer transcript hides cut words (${viewer.words} of ${nWords})`, `viewer sees cut words: ${JSON.stringify(viewer)}`);
  const dl = await vpage.evaluate(({ id, cam }) => Promise.all([`/raw/${id}?download=1`, `/raw/${id}?DOWNLOAD`, cam ? `/raw/${id}/cam?Download=1` : null].filter(Boolean).map((u) => fetch(u).then((r) => r.status))), { id: meta.id, cam: meta.hasCam });
  check(dl.every((s) => s === 403), 'viewer download URLs refused (any spelling)', `viewer download statuses ${dl}`);
  if (meta.hasCam) {
    // The Screen layout: viewers get no camera at all.
    await page.click('.owner-panel button[data-kind="screen"]');
    await page.waitForTimeout(700);
    await vpage.reload();
    await vpage.waitForSelector('.sp');
    const hidden = await vpage.evaluate((id) => Promise.all([fetch(`/raw/${id}/cam`, { headers: { Range: 'bytes=0-1' } }).then((r) => r.status), fetch(`/thumb/${id}/cam.jpg`).then((r) => r.status)])
      .then(([raw, thumb]) => ({ raw, thumb, el: !!document.querySelector('.sp-cam'), avatar: !!document.querySelector('img.avatar'), hasCam: window.__SHUTTLE__.video.hasCam, og: document.querySelector('meta[property="og:image"]')?.content })), meta.id);
    check(hidden.raw === 404 && hidden.thumb === 404 && !hidden.el && !hidden.avatar && !hidden.hasCam && /\?l=s$/.test(hidden.og || ''),
      'Screen layout: viewers get no camera file, camera thumbnail, avatar or face in the preview', `Screen layout leaks the camera: ${JSON.stringify(hidden)}`);
    await vpage.screenshot({ path: path.join(out, '12b-viewer-screen-layout.png') });
    const ownerCam = await page.evaluate(() => ({ el: !!document.querySelector('.sp-cam'), hidden: document.querySelector('.sp-cam-wrap')?.hidden }));
    check(ownerCam.el && ownerCam.hidden, 'owner keeps the camera (hidden) to switch back', `owner camera: ${JSON.stringify(ownerCam)}`);
    await page.click('.owner-panel button[data-kind="bubble"]');
    await page.waitForTimeout(500);
  }
  await vpage.screenshot({ path: path.join(out, '12-viewer.png') });
  await vctx.close();

  // library
  await page.goto(BASE + '/');
  await page.waitForSelector('.card');
  await shot('13-library-after.png');
  ok('library shows the video');
  console.log(`VIDEO_ID=${meta.id}`);
} catch (e) {
  if (e.expected) ok('fault scenario complete');
  else { fail(e.stack || e.message); await page.screenshot({ path: path.join(out, 'error.png') }).catch(() => {}); }
} finally {
  if (consoleErrors.length) console.log('       console errors:', consoleErrors.slice(0, 8));
  await browser.close();
}
