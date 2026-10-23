// Picking a camera or microphone on the setup sheet (Chromium, three fake cameras and mics).
// Chrome and Brave open the device chosen in the browser's own settings unless the page asks for
// an exact id, so a picker that asked with `ideal` changed nothing. Checks each pick opens that
// device and nothing else stays live, back-to-back picks, closing and reopening the sheet, and a
// saved camera that's gone. Same BASE/server as test/e2e.mjs (sh test/serve.sh).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_DIR || path.join(root, '..', 'node_modules', 'playwright'));
const BASE = process.env.BASE || 'http://localhost:8799';
const PASSWORD = process.env.PASSWORD || 'test-password-123';
let fails = 0; const check = (c, m) => { console.log(c ? '  ok  ' : 'FAIL  ', m); if (!c) fails++; };
const browser = await pw.chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream=device-count=3'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
await ctx.addInitScript(() => {
  window.__streams = [];
  const orig = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = async function (c) { const s = await orig.call(this, c); window.__streams.push(s); return s; };
});
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.log('pageerror', e.message); fails++; });
await page.goto(BASE + '/');
await page.waitForSelector('#signin:not([hidden]), #library:not([hidden])');
if (await page.isVisible('#signin')) { await page.fill('#password', PASSWORD); await page.click('#signin-form button'); }
await page.waitForSelector('#library:not([hidden])');
const open = async () => {
  await page.click('#new-recording');
  await page.click('.seg button[data-mode="camera"]');
  await page.waitForFunction(() => { const v = document.querySelector('#setup-cam'); return v && v.srcObject && !document.querySelector('#start').disabled; }, null, { timeout: 15000 });
  await page.waitForTimeout(500);
};
const st = () => page.evaluate(() => {
  const t = document.querySelector('#setup-cam').srcObject.getVideoTracks()[0];
  const cs = document.querySelector('#cam-select'), ms = document.querySelector('#mic-select');
  const live = window.__streams.flatMap((s) => s.getTracks()).filter((x) => x.readyState === 'live');
  return { camSel: cs.selectedOptions[0].textContent, cam: t.label, micSel: ms.selectedOptions[0].textContent,
    mics: live.filter((x) => x.kind === 'audio').map((x) => x.label), cams: live.filter((x) => x.kind === 'video').map((x) => x.label),
    camOpts: [...cs.options].map((o) => o.textContent), micOpts: [...ms.options].map((o) => o.textContent) };
});
const pick = async (sel, i) => { const v = await page.evaluate(([s, i]) => document.querySelector(s).options[i].value, [sel, i]); await page.selectOption(sel, v); };
await open();
let s = await st(); console.log('initial', JSON.stringify(s));
for (const i of [1, 2, 0, 2]) {
  await pick('#cam-select', i); await page.waitForTimeout(1200); s = await st();
  check(s.cam === s.camOpts[i] && s.camSel === s.camOpts[i] && s.cams.length === 1 && s.cams[0] === s.camOpts[i], `camera pick ${s.camOpts[i]} → preview ${s.cam}, live cams ${s.cams}`);
}
for (const i of [1, 2]) {
  await pick('#mic-select', i); await page.waitForTimeout(1200); s = await st();
  check(s.mics.length === 1 && s.mics[0] === s.micOpts[i] && s.micSel === s.micOpts[i], `mic pick ${s.micOpts[i]} → live mics ${s.mics}`);
}
// Rapid: two picks back to back, before the first opens.
await pick('#cam-select', 1); await pick('#cam-select', 0); await page.waitForTimeout(1500); s = await st();
check(s.cams.length === 1 && s.cams[0] === s.camOpts[0] && s.cam === s.camOpts[0], `rapid picks: one live camera (${s.cams}), the last one picked`);
// Survives closing and reopening the sheet.
await page.click('.sheet .icon-btn[aria-label="Close"]'); await page.waitForTimeout(500);
s = await page.evaluate(() => window.__streams.flatMap((x) => x.getTracks()).filter((x) => x.readyState === 'live').length);
check(s === 0, `closing the sheet leaves no live tracks (${s})`);
await page.evaluate(() => { window.__streams = []; });
await open(); s = await st();
check(s.cam === s.camOpts[0] && s.mics[0] === s.micOpts[2], `reopened: camera ${s.cam}, mic ${s.mics}`);
// Stale saved camera (e.g. unplugged): falls back to default, picker shows what opened.
await page.click('.sheet .icon-btn[aria-label="Close"]');
await page.evaluate(() => { localStorage.setItem('shuttle.cameraId', JSON.stringify('nonexistent-id')); window.__streams = []; });
await open(); s = await st();
check(s.cam === s.camSel && s.cams.length === 1, `stale saved camera: falls back to ${s.cam}, picker shows ${s.camSel}`);
// Record with a non-default camera and confirm the recorder got that camera.
await pick('#cam-select', 2); await page.waitForTimeout(1200);
const startCam = await page.evaluate(() => document.querySelector('#setup-cam').srcObject.getVideoTracks()[0].label);
check(startCam === 'fake_device_2', `before Start: ${startCam}`);
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
