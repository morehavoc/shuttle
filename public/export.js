// "Screen and camera together": plays the screen and camera files once, in real time, into a
// canvas laid out exactly like the share page (same layout, edits skipped), and records that
// with the screen's audio as one video file. Runs in the owner's browser; Workers can't encode.

import { layoutBoxes, rawUrl } from './player.js';
import { normalizeCuts, keepSegments } from './timeline.js';

const MIMES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];

const once = (el, ev) => new Promise((ok) => el.addEventListener(ev, ok, { once: true }));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function media(src, muted) {
  const el = document.createElement('video');
  el.playsInline = true;
  el.muted = muted;
  el.preload = 'auto';
  el.src = src;
  return el;
}

// MediaRecorder files can say "Infinity" until their end has been read.
async function ready(el) {
  if (el.readyState < 1) await once(el, 'loadedmetadata');
  if (el.duration === Infinity) {
    el.currentTime = 1e101;
    await once(el, 'durationchange');
    el.currentTime = 0;
    await once(el, 'seeked');
  }
  if (el.readyState < 2) await once(el, 'loadeddata');
}

async function seek(el, t) {
  if (Math.abs(el.currentTime - t) < 0.01) return;
  el.currentTime = t;
  await Promise.race([once(el, 'seeked'), sleep(4000)]);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// → Blob. onProgress(0..1). Stops early (rejects with AbortError) when signal aborts.
export async function exportComposite(v, { layout, ownerName = '', onProgress = () => {}, signal } = {}) {
  const main = media(rawUrl(v, 'main'), false);
  const cam = v.hasCam ? media(rawUrl(v, 'cam'), true) : null;
  const abort = () => { if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError'); };
  await Promise.all([ready(main), cam ? ready(cam) : null]);
  abort();

  const duration = Number.isFinite(main.duration) && main.duration > 0 ? main.duration : (v.durationMs || 0) / 1000;
  const segs = keepSegments(normalizeCuts(v.cuts || [], duration), duration);
  const total = segs.reduce((a, [s, e]) => a + (e - s), 0);
  const camOffset = (v.camOffsetMs || 0) / 1000;

  const big = (main.videoHeight || v.height || 1080) >= 900;
  const W = big ? 1920 : 1280, H = big ? 1080 : 720;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  const ar = (main.videoWidth || 16) / (main.videoHeight || 9);
  const kind = cam ? layout.kind : 'screen';
  const { main: mb, cam: cb, unit } = layoutBoxes({ W, H, ar, kind, layout, cameraMode: v.mode === 'camera' });

  const draw = () => {
    if (kind === 'side' && v.mode !== 'camera') {
      const bg = g.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, '#1c1714'); bg.addColorStop(1, '#0f0f12');
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      const glow = g.createRadialGradient(0, 0, 0, 0, 0, W * 0.6);
      glow.addColorStop(0, 'rgba(42,111,140,.30)'); glow.addColorStop(1, 'rgba(42,111,140,0)');
      g.fillStyle = glow; g.fillRect(0, 0, W, H);
    } else { g.fillStyle = '#0b0b0d'; g.fillRect(0, 0, W, H); }
    // Screen (or the camera, for camera-only videos): letterboxed into its box.
    g.save(); roundRect(g, mb.x, mb.y, mb.w, mb.h, mb.r || 0); g.clip();
    g.fillStyle = '#000'; g.fillRect(mb.x, mb.y, mb.w, mb.h);
    const s = Math.min(mb.w / (main.videoWidth || 1), mb.h / (main.videoHeight || 1));
    const dw = (main.videoWidth || 1) * s, dh = (main.videoHeight || 1) * s;
    g.drawImage(main, mb.x + (mb.w - dw) / 2, mb.y + (mb.h - dh) / 2, dw, dh);
    g.restore();
    if (!cam || !cb || !cam.videoWidth) return;
    // Camera: cropped to fill its shape.
    g.save();
    g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 32 * unit; g.shadowOffsetY = 12 * unit;
    roundRect(g, cb.x, cb.y, cb.w, cb.h, cb.r); g.fillStyle = '#000'; g.fill();
    g.restore();
    g.save(); roundRect(g, cb.x, cb.y, cb.w, cb.h, cb.r); g.clip();
    const c = Math.max(cb.w / cam.videoWidth, cb.h / cam.videoHeight);
    const cw = cam.videoWidth * c, ch = cam.videoHeight * c;
    g.drawImage(cam, cb.x + (cb.w - cw) / 2, cb.y + (cb.h - ch) / 2, cw, ch);
    if (cb.shape !== 'bubble' && ownerName) {
      const fs = Math.max(11, 15 * unit);
      g.font = `600 ${fs}px "Noto Sans", system-ui, sans-serif`;
      const pad = 9 * unit, tw = Math.min(g.measureText(ownerName).width, cb.w - 16 * unit - pad * 2);
      const bx = cb.x + 8 * unit, by = cb.y + cb.h - 8 * unit - fs - 8 * unit;
      g.fillStyle = 'rgba(17,18,20,.62)'; roundRect(g, bx, by, tw + pad * 2, fs + 8 * unit, 8 * unit); g.fill();
      g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(ownerName, bx + pad, by + (fs + 8 * unit) / 2, tw);
    }
    g.restore();
    if (cb.shape === 'bubble') {
      const ring = Math.max(2, 4 * unit);
      g.beginPath(); g.arc(cb.x + cb.w / 2, cb.y + cb.h / 2, cb.w / 2 + ring / 2, 0, Math.PI * 2);
      g.lineWidth = ring; g.strokeStyle = 'rgba(255,255,255,.95)'; g.stroke();
    }
  };

  // Keep the camera on the screen's clock (holding its first/last frame outside its file).
  const syncCam = (hard) => {
    if (!cam) return;
    const raw = main.currentTime - camOffset;
    const end = Number.isFinite(cam.duration) ? cam.duration - 0.05 : Infinity;
    if (raw < 0 || raw >= end) { if (!cam.paused) cam.pause(); return; }
    if (hard || Math.abs(cam.currentTime - raw) > 0.2) cam.currentTime = raw;
    if (cam.paused && !main.paused) cam.play().catch(() => {});
  };

  // Audio: the screen file's sound, routed only into the recording (not the speakers).
  const actx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = actx.createMediaStreamDestination();
  actx.createMediaElementSource(main).connect(dest);
  if (actx.state === 'suspended') await actx.resume().catch(() => {});

  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = MIMES.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 160_000 });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  const stopped = once(rec, 'stop');

  let timer = 0, raf = 0;
  const stopLoop = () => { clearInterval(timer); cancelAnimationFrame(raf); };
  const cleanup = () => {
    stopLoop();
    for (const el of [main, cam]) if (el) { el.pause(); el.removeAttribute('src'); el.load(); }
    actx.close().catch(() => {});
  };

  try {
    let done = 0;
    for (const [s, e] of segs) {
      abort();
      await seek(main, s);
      if (cam) { syncCam(true); if (cam.seeking) await Promise.race([once(cam, 'seeked'), sleep(4000)]); }
      draw();
      if (rec.state === 'inactive') rec.start(1000); else rec.resume();
      // A stalled screen video would otherwise be recorded as a frozen picture.
      const onWait = () => { if (rec.state === 'recording') rec.pause(); };
      const onPlay = () => { if (rec.state === 'paused') rec.resume(); };
      main.addEventListener('waiting', onWait);
      main.addEventListener('playing', onPlay);
      await main.play();
      syncCam(true);
      await new Promise((resolve, reject) => {
        const tick = () => {
          if (signal && signal.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
          draw();
          syncCam(false);
          onProgress(Math.min(1, (done + Math.max(0, main.currentTime - s)) / (total || 1)));
          if (main.ended || main.currentTime >= e - 0.02) resolve();
        };
        // Frames when the tab is visible; a timer keeps it going (more slowly) when it isn't.
        const loop = () => { tick(); raf = requestAnimationFrame(loop); };
        raf = requestAnimationFrame(loop);
        timer = setInterval(tick, 40);
      });
      stopLoop();
      main.removeEventListener('waiting', onWait);
      main.removeEventListener('playing', onPlay);
      if (rec.state === 'recording') rec.pause();
      main.pause(); if (cam) cam.pause();
      done += e - s;
    }
    rec.stop();
    await stopped;
    onProgress(1);
    return new Blob(parts, { type: (rec.mimeType || mime || 'video/mp4').split(';')[0] });
  } catch (err) {
    if (rec.state !== 'inactive') rec.stop();
    throw err;
  } finally {
    cleanup();
  }
}
