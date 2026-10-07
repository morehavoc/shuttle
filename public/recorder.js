// Capture → MediaRecorder → live multipart upload.
// The video is uploaded in fixed-size parts while it is being recorded, so the link
// works seconds after Stop. A full local copy is kept until the upload completes.

import { api } from './ui.js';

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
  }
  return '';
}

export const canRecordScreen = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

export function displayMediaOptions(withAudio) {
  return {
    video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 }, displaySurface: 'monitor' },
    audio: withAudio,
    // Chrome hints; other browsers ignore unknown keys.
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'include',
    monitorTypeSurfaces: 'include',
  };
}

// Mixes any number of audio tracks into one. Returns { track, close }.
function mixAudio(tracks) {
  const live = tracks.filter(Boolean);
  if (live.length === 0) return { track: null, close() {} };
  if (live.length === 1) return { track: live[0], close() {} };
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const dest = ctx.createMediaStreamDestination();
  for (const t of live) ctx.createMediaStreamSource(new MediaStream([t])).connect(dest);
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return { track: dest.stream.getAudioTracks()[0], close: () => ctx.close().catch(() => {}) };
}

class PartUploader {
  constructor(id, partSize, onProgress) {
    this.id = id;
    this.partSize = partSize;
    this.onProgress = onProgress;
    this.pending = new Blob([]);
    this.n = 0;
    this.sentBytes = 0;
    this.totalBytes = 0;
    this.chain = Promise.resolve();
    this.stalled = false;
    this.aborted = false;
    this.failed = null;
  }
  push(blob) {
    this.totalBytes += blob.size;
    this.pending = new Blob([this.pending, blob]);
    while (this.pending.size >= this.partSize) {
      const part = this.pending.slice(0, this.partSize);
      this.pending = this.pending.slice(this.partSize);
      this.enqueue(part);
    }
    this.report();
  }
  finish() {
    if (this.pending.size > 0) { this.enqueue(this.pending); this.pending = new Blob([]); }
    return this.chain;
  }
  enqueue(blob) {
    const n = ++this.n;
    this.chain = this.chain.then(() => this.send(n, blob));
    // A fatal part failure stops later parts; record it so the UI can say so now, not at Stop.
    this.chain.catch((e) => { if (!this.failed) { this.failed = e; this.report(); } });
  }
  async send(n, blob) {
    let delay = 1000, serverErrors = 0;
    for (;;) {
      if (this.aborted) return;
      let res;
      try {
        res = await fetch(`/api/videos/${this.id}/parts/${n}`, { method: 'PUT', body: blob, credentials: 'same-origin' });
      } catch {
        res = null; // offline / connection dropped: wait it out, however long
      }
      if (res && res.ok) break;
      if (res) {
        const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
        if (!retryable || ++serverErrors > 8) {
          let msg = `server said ${res.status}`;
          try { msg = (await res.json()).error || msg; } catch {}
          if (res.status === 401) msg = 'signed out';
          throw new Error(msg);
        }
      }
      this.stalled = true;
      this.report();
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
    this.stalled = false;
    this.sentBytes += blob.size;
    this.report();
  }
  report() { this.onProgress && this.onProgress({ sent: this.sentBytes, total: this.totalBytes, stalled: this.stalled, failed: !!this.failed }); }
}

// One recording session.
export class Session extends EventTarget {
  constructor({ mode, cameraStream, micStream, title }) {
    super();
    this.mode = mode;
    this.cameraStream = cameraStream || null;
    this.micStream = micStream || null;
    this.title = title;
    this.displayStream = null;
    this.chunks = [];
    this.state = 'idle'; // idle | ready | recording | paused | stopping | done | failed | cancelled
    this.elapsedBefore = 0;
    this.startedAt = 0;
    this.video = null;
    this.mime = pickMime();
  }

  get elapsed() {
    return this.elapsedBefore + (this.state === 'recording' ? performance.now() - this.startedAt : 0);
  }

  // Must be called synchronously from a click (Safari gates getDisplayMedia on the gesture).
  requestDisplay() {
    if (this.mode === 'camera') return Promise.resolve(null);
    const wantAudio = true; // tab / system audio when the browser offers it
    return navigator.mediaDevices.getDisplayMedia(displayMediaOptions(wantAudio)).then((s) => {
      this.displayStream = s;
      const v = s.getVideoTracks()[0];
      if (v) {
        try { v.contentHint = 'detail'; } catch {}
        // The browser's own "Stop sharing" button ends the track.
        v.addEventListener('ended', () => this.emit('display-ended'));
      }
      return s;
    });
  }

  buildStream() {
    const videoTrack = this.mode === 'camera'
      ? this.cameraStream && this.cameraStream.getVideoTracks()[0]
      : this.displayStream && this.displayStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error(this.mode === 'camera' ? 'No camera' : 'No screen selected');
    const micTrack = this.micStream && this.micStream.getAudioTracks()[0];
    const sysTrack = this.displayStream && this.displayStream.getAudioTracks()[0];
    this.mixer = mixAudio([micTrack, sysTrack]);
    const tracks = [videoTrack];
    if (this.mixer.track) tracks.push(this.mixer.track);
    this.hasAudio = !!this.mixer.track;
    const s = videoTrack.getSettings ? videoTrack.getSettings() : {};
    this.width = s.width || 0;
    this.height = s.height || 0;
    return new MediaStream(tracks);
  }

  // Creates the server-side video so the link exists before recording starts.
  async prepare() {
    if (this.mime === null) throw new Error('This browser can’t record video');
    const mime = this.mime || 'video/webm';
    this.video = await api('/api/videos', {
      method: 'POST',
      body: { mime, mode: this.mode, title: this.title, tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
    });
    this.uploader = new PartUploader(this.video.id, this.video.partSize, (p) => this.emit('progress', p));
    this.state = 'ready';
    return this.video;
  }

  start() {
    const stream = this.buildStream();
    const isScreen = this.mode !== 'camera';
    const opts = {
      videoBitsPerSecond: isScreen ? 3_500_000 : 2_500_000,
      audioBitsPerSecond: 128_000,
    };
    if (this.mime) opts.mimeType = this.mime;
    let rec;
    try { rec = new MediaRecorder(stream, opts); }
    catch { rec = new MediaRecorder(stream); }
    this.recorder = rec;
    this.recordMime = (rec.mimeType || this.mime || 'video/webm').split(';')[0];
    rec.addEventListener('dataavailable', (e) => {
      if (!e.data || !e.data.size) return;
      this.chunks.push(e.data);
      if (this.state !== 'cancelled') this.uploader.push(e.data);
    });
    rec.addEventListener('error', (e) => this.fail(e.error || new Error('Recording failed')));
    this.stopped = new Promise((resolve) => rec.addEventListener('stop', resolve, { once: true }));
    rec.start(1000);
    this.startedAt = performance.now();
    this.state = 'recording';
    this.emit('state');
  }

  pause() {
    if (this.state !== 'recording') return;
    this.recorder.pause();
    this.elapsedBefore += performance.now() - this.startedAt;
    this.state = 'paused';
    this.emit('state');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.recorder.resume();
    this.startedAt = performance.now();
    this.state = 'recording';
    this.emit('state');
  }

  async stop() {
    if (this.state !== 'recording' && this.state !== 'paused') return;
    const duration = this.elapsed;
    this.elapsedBefore = duration;
    this.state = 'stopping';
    this.emit('state');
    try { this.recorder.stop(); } catch {}
    await this.stopped;
    this.releaseCapture();
    try {
      return await this.finalize();
    } catch (e) {
      this.fail(e);
      throw e;
    }
  }

  // Upload whatever is left and close the video. Safe to call again after a failure.
  async finalize() {
    await this.uploader.finish();
    this.allPartsUploaded = true;
    const done = await api(`/api/videos/${this.video.id}/complete`, {
      method: 'POST',
      body: { durationMs: Math.round(this.elapsedBefore), width: this.width, height: this.height, mime: this.recordMime },
    });
    this.video = done;
    this.state = 'done';
    this.emit('state');
    return done;
  }

  async cancel() {
    const prev = this.state;
    this.state = 'cancelled';
    if (this.uploader) this.uploader.aborted = true;
    try { if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop(); } catch {}
    this.releaseCapture();
    this.emit('state');
    if (this.video && prev !== 'done') {
      try { await api(`/api/videos/${this.video.id}`, { method: 'DELETE' }); } catch {}
    }
  }

  fail(err) {
    if (this.state === 'failed' || this.state === 'cancelled') return;
    this.error = err;
    this.failedWhile = this.state;
    if (this.state === 'recording' || this.state === 'paused') this.elapsedBefore = this.elapsed;
    this.state = 'failed';
    this.releaseCapture();
    this.emit('state');
  }

  // Everything that was recorded, for "Download a copy".
  localBlob() {
    return new Blob(this.chunks, { type: this.recordMime || this.mime || 'video/webm' });
  }

  releaseCapture() {
    if (this.displayStream) this.displayStream.getTracks().forEach((t) => t.stop());
    if (this.mixer) this.mixer.close();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

// Grab one frame from a live track. ImageCapture reads the track directly, so it works
// even when this tab is in the background; otherwise fall back to the <video> element.
async function grab(track, video) {
  if (track && track.readyState === 'live' && typeof ImageCapture !== 'undefined') {
    try {
      const bmp = await Promise.race([new ImageCapture(track).grabFrame(), new Promise((_, j) => setTimeout(() => j(new Error('slow')), 1500))]);
      return { src: bmp, w: bmp.width, h: bmp.height };
    } catch {}
  }
  if (video && video.videoWidth) return { src: video, w: video.videoWidth, h: video.videoHeight };
  return null;
}

// Thumbnail: the screen frame with the camera bubble drawn in, like the video itself looks.
export async function makeThumbnail({ screenTrack, cameraTrack, screenVideo, cameraVideo, mode }) {
  const W = 1280, H = 720;
  const [main, cam] = await Promise.all([
    mode === 'camera' ? grab(cameraTrack, cameraVideo) : grab(screenTrack, screenVideo),
    mode === 'screen-camera' ? grab(cameraTrack, cameraVideo) : null,
  ]);
  if (!main) return null;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#121117';
  g.fillRect(0, 0, W, H);
  const fit = mode === 'camera' ? Math.max(W / main.w, H / main.h) : Math.min(W / main.w, H / main.h);
  const dw = main.w * fit, dh = main.h * fit;
  g.save();
  if (mode === 'camera') { g.translate(W, 0); g.scale(-1, 1); }
  g.drawImage(main.src, (W - dw) / 2, (H - dh) / 2, dw, dh);
  g.restore();
  if (cam) {
    const d = 200, x = 36, y = H - d - 36;
    g.save();
    g.beginPath(); g.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2); g.closePath();
    g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 24; g.fillStyle = '#000'; g.fill();
    g.clip();
    const s = Math.max(d / cam.w, d / cam.h);
    const cw = cam.w * s, ch = cam.h * s;
    g.translate(x + d, y); g.scale(-1, 1);
    g.drawImage(cam.src, (d - cw) / 2, (d - ch) / 2, cw, ch);
    g.restore();
    g.beginPath(); g.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
    g.lineWidth = 6; g.strokeStyle = 'rgba(255,255,255,.92)'; g.stroke();
  }
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.84));
}
