// README screenshots: a real recording against a local server (sh test/serve.sh, ideally with
// TRANSCRIBE=real for a real transcript), with a picture as the "screen", a drawn stand-in for
// the camera and a spoken narration as the mic. Writes PNGs to docs/images/.
//   BASE=https://host:port SCREEN=site.png NARRATION=narr.wav node scripts/readme-shots.mjs
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_DIR || path.join(root, '..', 'node_modules', 'playwright'));
const BASE = process.env.BASE;
const PASSWORD = process.env.PASSWORD || 'test-password-123';
const out = path.join(root, 'docs', 'images');
mkdirSync(out, { recursive: true });
const screenB64 = readFileSync(process.env.SCREEN).toString('base64');
const narrB64 = readFileSync(process.env.NARRATION).toString('base64');
const seconds = Number(process.env.SECONDS || 18);

const browser = await pw.chromium.launch({ args: [
  '--autoplay-policy=no-user-gesture-required',
  '--disable-features=PrivateNetworkAccessForNavigations,PrivateNetworkAccessForWorkers,BlockInsecurePrivateNetworkRequests,LocalNetworkAccessChecks',
] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true });
await ctx.addInitScript(({ screenB64, narrB64 }) => {
  const img = new Image();
  img.src = `data:image/png;base64,${screenB64}`;
  function screen() {
    const c = document.createElement('canvas'); c.width = 1600; c.height = 900;
    const g = c.getContext('2d'); const t0 = performance.now();
    setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      g.fillStyle = '#faf9f6'; g.fillRect(0, 0, c.width, c.height);
      if (img.complete) g.drawImage(img, 0, -Math.min(120, Math.max(0, t - 6) * 12));
      // A cursor drifting across the page.
      const x = 520 + Math.sin(t / 2) * 260, y = 420 + Math.cos(t / 3) * 120;
      g.fillStyle = '#111'; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 26); g.lineTo(x + 7, y + 20); g.lineTo(x + 18, y + 20); g.closePath(); g.fill();
    }, 33);
    return c.captureStream(30);
  }
  function camera() {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
    const g = c.getContext('2d'); const t0 = performance.now();
    setInterval(() => {
      const t = (performance.now() - t0) / 1000, bob = Math.sin(t * 1.3) * 6;
      const bg = g.createLinearGradient(0, 0, 0, 720); bg.addColorStop(0, '#d9e7ec'); bg.addColorStop(1, '#a9c6d1');
      g.fillStyle = bg; g.fillRect(0, 0, 1280, 720);
      g.fillStyle = '#2a6f8c';
      g.beginPath(); g.ellipse(640, 760 + bob, 300, 260, 0, Math.PI, 0); g.fill(); // shoulders
      g.beginPath(); g.arc(640, 330 + bob, 125, 0, Math.PI * 2); g.fill();       // head
    }, 33);
    return c.captureStream(30);
  }
  let dest = null, buf = null, started = false;
  const ac = new AudioContext();
  ac.decodeAudioData(Uint8Array.from(atob(narrB64), (ch) => ch.charCodeAt(0)).buffer).then((b) => { buf = b; });
  dest = ac.createMediaStreamDestination();
  const hum = ac.createConstantSource(); hum.offset.value = 1e-4; hum.connect(dest); hum.start();
  const start = MediaRecorder.prototype.start;
  MediaRecorder.prototype.start = function (...a) {
    if (!started && buf && this.stream.getAudioTracks().length) {
      started = true;
      setTimeout(() => { const s = ac.createBufferSource(); s.buffer = buf; s.connect(dest); s.start(); }, 600);
    }
    return start.apply(this, a);
  };
  const md = MediaDevices.prototype;
  const def = (k, fn) => Object.defineProperty(md, k, { value: fn, configurable: true, writable: true });
  def('getDisplayMedia', async () => {
    const s = screen(); const t = s.getVideoTracks()[0]; const o = t.getSettings.bind(t);
    t.getSettings = () => ({ ...o(), displaySurface: 'monitor' });
    return s;
  });
  def('getUserMedia', async (c) => {
    const tracks = [];
    // Named like the devices below, as a real camera and mic are, so the menus show them.
    const named = (t, id) => { const o = t.getSettings.bind(t); t.getSettings = () => ({ ...o(), deviceId: id }); return t; };
    if (c.video) tracks.push(named(camera().getVideoTracks()[0], 'cam'));
    if (c.audio) { ac.resume(); tracks.push(named(dest.stream.getAudioTracks()[0].clone(), 'mic')); }
    return new MediaStream(tracks);
  });
  def('enumerateDevices', async () => [
    { kind: 'videoinput', deviceId: 'cam', label: 'FaceTime HD Camera', groupId: 'g' },
    { kind: 'audioinput', deviceId: 'mic', label: 'MacBook Pro Microphone', groupId: 'g' },
  ]);
}, { screenB64, narrB64 });

const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
const shot = async (name, opts = {}) => { await page.screenshot({ path: path.join(out, name), ...opts }); console.log('  shot', name); };

await page.goto(BASE + '/');
await page.waitForSelector('#signin:not([hidden]), #library:not([hidden])');
if (await page.isVisible('#signin')) { await page.fill('#password', PASSWORD); await page.click('#signin-form button'); }
await page.waitForSelector('#library:not([hidden])');

// Setup sheet.
await page.click('#new-recording');
await page.waitForSelector('.sheet');
await page.click('.seg button[data-mode="screen-camera"]');
await page.waitForFunction(() => { const v = document.querySelector('#setup-cam'); return v && v.videoWidth > 0; });
await page.waitForTimeout(800);
await shot('setup.png');

// Record.
await page.click('#start');
await page.waitForSelector('.recbar:not([hidden])', { timeout: 20000 });
await page.waitForTimeout(seconds * 1000);
await page.click('.recbar .stop');
await page.waitForURL(/\/v\//, { timeout: 60000 });
const id = new URL(page.url()).pathname.split('/')[2];
// Transcript, then the drafted title and description.
await page.waitForSelector('.tc-body .w', { timeout: 90000 });
for (let i = 0; i < 60; i++) {
  const v = await (await page.request.get(`${BASE}/api/videos/${id}`)).json();
  if (v.description && !/^Recording · /.test(v.title)) break;
  await page.waitForTimeout(1000);
}
await page.reload();
await page.waitForSelector('.tc-body .w', { timeout: 30000 });
await page.click('.sp');
await page.waitForTimeout(5200);
await page.click('.sp');
await page.mouse.move(10, 10);
await page.waitForTimeout(1200);
await shot('share.png');
await shot('share-full.png', { fullPage: true });

// The Side layout, the player alone.
await page.click('[data-kind="side"]');
await page.waitForTimeout(1500);
await (await page.$('.sp')).screenshot({ path: path.join(out, 'layout-side.png') });
await page.click('[data-kind="bubble"]');
await page.waitForTimeout(800);

// Library.
await page.goto(BASE + '/');
await page.waitForSelector('#library:not([hidden])');
await page.waitForTimeout(1500);
await shot('library.png');

// Phone: the share page.
const phone = await browser.newContext({ ...pw.devices['iPhone 15'], ignoreHTTPSErrors: true });
const pp = await phone.newPage();
await pp.goto(`${BASE}/v/${id}`);
await pp.waitForSelector('.sp');
await pp.waitForTimeout(2500);
await pp.screenshot({ path: path.join(out, 'phone.png') });
console.log('  shot phone.png');

// An embed in a blog post.
const blog = await ctx.newPage();
await blog.route('https://blog.example/**', (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
<style>body{margin:0;background:#fff;font:19px/1.6 Georgia,serif;color:#15171a}main{max-width:720px;margin:60px auto;padding:0 24px}
h1{font:700 44px/1.15 -apple-system,system-ui,sans-serif;margin:0 0 14px}.meta{font:14px -apple-system,system-ui,sans-serif;color:#738a94;margin-bottom:34px}
iframe{display:block;width:100%;aspect-ratio:16/9;border:0;border-radius:6px;margin:30px 0}</style>
<main><h1>A quick tour of Shuttle</h1><div class="meta">Christopher Moravec · 3 min read</div>
<p>I wanted a screen recorder that was mine: my domain, my storage, no seat licence. So I built one on Cloudflare.</p>
<iframe src="${BASE}/e/${id}" allow="fullscreen" allowfullscreen></iframe>
<p>Paste a Shuttle link into a Ghost post and it turns into the player above.</p></main>` }));
await blog.goto('https://blog.example/post');
await blog.waitForTimeout(3000);
await blog.screenshot({ path: path.join(out, 'embed.png') });
console.log('  shot embed.png');

await browser.close();
// Retina captures are big; keep them sharp but light enough for a README.
for (const f of ['setup.png', 'share.png', 'share-full.png', 'library.png', 'embed.png']) execFileSync('sips', ['-Z', '1800', path.join(out, f)], { stdio: 'ignore' });
execFileSync('sips', ['-Z', '1100', path.join(out, 'phone.png')], { stdio: 'ignore' });
execFileSync('sips', ['-Z', '1400', path.join(out, 'layout-side.png')], { stdio: 'ignore' });
console.log('video', id);
