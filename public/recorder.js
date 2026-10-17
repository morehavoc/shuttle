// Capture → MediaRecorder → live multipart upload.
// A screen + camera recording is two files recorded side by side: `main` (the screen with all
// the audio) and `cam` (the camera, video only). The player composites them, so the camera
// never depends on a floating window being captured. Everything uploads while recording, so
// the link works seconds after Stop, and a local copy is kept until the upload completes.
// A third, side branch taps the audio for the transcript.

import { api } from './ui.js';

const MAIN_MIMES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
const CAM_MIMES = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1.42E01F',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function pick(list) {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of list) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
  }
  return '';
}
export const pickMime = () => pick(MAIN_MIMES);
export const pickCamMime = () => pick(CAM_MIMES);

export const canRecordScreen = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

export function displayMediaOptions() {
  return {
    video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: true, // tab / system audio when the browser offers it
    // Chrome hints; other browsers ignore unknown keys.
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'include',
    monitorTypeSurfaces: 'include',
  };
}

// Chrome's MP4 recorder writes undecodable video for everything after its input changes size
// (a shared window resized, a tab switch): the encoder restarts with new settings the file
// never records, so Chrome stops playing at that point and Safari shows stripes. Here each
// screen frame is drawn into a frame of the starting size (scaled to fit, black bars if the
// shape changes), so the recorder's input never changes size. The pipeline is driven by frames
// arriving, not timers, so it keeps running in a background tab. Safari's recorder handles a
// resize itself and has no MediaStreamTrackProcessor, so it gets the track unchanged.
function fixedSizeTrack(track, width, height) {
  const W = width & ~1, H = height & ~1;
  if (!W || !H || !window.MediaStreamTrackProcessor || !window.MediaStreamTrackGenerator || !window.OffscreenCanvas) {
    return { track, close() {} };
  }
  let gen;
  try {
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const proc = new MediaStreamTrackProcessor({ track });
    gen = new MediaStreamTrackGenerator({ kind: 'video' });
    try { gen.contentHint = track.contentHint; } catch {}
    proc.readable.pipeThrough(new TransformStream({
      transform(frame, out) {
        try {
          const fw = frame.displayWidth, fh = frame.displayHeight;
          if (fw === W && fh === H) { out.enqueue(frame); return; }
          const k = Math.min(W / fw, H / fh);
          const dw = Math.round(fw * k), dh = Math.round(fh * k);
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, W, H);
          ctx.drawImage(frame, (W - dw) >> 1, (H - dh) >> 1, dw, dh);
          out.enqueue(new VideoFrame(canvas, { timestamp: frame.timestamp }));
          frame.close();
        } catch (e) { try { frame.close(); } catch {} }
      },
    })).pipeTo(gen.writable).catch(() => {});
  } catch { return { track, close() {} }; }
  return { track: gen, close() { try { gen.stop(); } catch {} } };
}

// Mixes any number of audio tracks into one. Returns { track, close }. A microphone alone is
// recorded directly. Anything else goes through an audio graph, whose output never stops: in
// Chrome's MP4 recorder, audio that stops arriving after a pause/resume is lost for good.
function mixAudio(tracks, mic) {
  const live = tracks.filter(Boolean);
  if (live.length === 0) return { track: null, close() {} };
  if (live.length === 1 && live[0] === mic) return { track: mic, close() {} };
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const dest = ctx.createMediaStreamDestination();
  for (const t of live) ctx.createMediaStreamSource(new MediaStream([t])).connect(dest);
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return { track: dest.stream.getAudioTracks()[0], close: () => ctx.close().catch(() => {}) };
}

// Uploads one track in exact PART_SIZE parts while it records.
class PartUploader {
  constructor(id, partSize, track, onProgress) {
    Object.assign(this, { id, partSize, track, onProgress });
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
    const ok = await putWithRetry(`/api/videos/${this.id}/parts/${n}?track=${this.track}`, blob, {}, this);
    if (!ok) return;
    this.sentBytes += blob.size;
    this.report();
  }
  report() { this.onProgress && this.onProgress(); }
}

// PUT with backoff. Network errors wait forever (offline is temporary); server errors give up
// after a while; a 4xx is fatal. Returns false only when aborted.
async function putWithRetry(url, body, headers, state) {
  let delay = 1000, serverErrors = 0;
  for (;;) {
    if (state.aborted) return false;
    let res;
    try {
      res = await fetch(url, { method: 'PUT', body, headers, credentials: 'same-origin' });
    } catch {
      res = null;
    }
    if (res && res.ok) { if (state.stalled) { state.stalled = false; state.report && state.report(); } return true; }
    if (res) {
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      if (!retryable || ++serverErrors > 8) {
        let msg = `server said ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch {}
        if (res.status === 401) msg = 'signed out';
        throw new Error(msg);
      }
    }
    state.stalled = true;
    state.report && state.report();
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 15000);
  }
}

// ---------- transcript audio ----------

const RATE = 16000;
const MIN_CHUNK_S = 25, MAX_CHUNK_S = 45;
const GAP_MS = 400;         // audio arriving this much later than its place is a gap, not jitter...
const GAP_CONFIRM = 5;      // ...once this many batches in a row arrive late, at a normal pace
const SPLIT_GAP_MS = 8000;  // a longer gap ends the chunk instead of being filled with silence

function encodeWav(bufs, n) {
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, RATE, true); dv.setUint32(28, RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, n * 2, true);
  let off = 44;
  for (const b of bufs) {
    for (let i = 0; i < b.length; i++) { dv.setInt16(off, b[i], true); off += 2; }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function rmsOf(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / Math.max(1, pcm.length)) / 32768;
}

// Taps the recorded audio (a side branch: if it stalls, the video is unaffected), cuts it into
// half-minute chunks at quiet moments and uploads them to be transcribed while recording.
//
// Each chunk carries where it starts in the recording, so words line up with the video. That
// position comes from when the audio arrives: delivery is never early, so the earliest estimate
// seen in a chunk is the truest one. Audio the tap never got (the browser suspended it) shows
// up as a run of batches all arriving late at a normal pace; that gap is filled with silence,
// or ends the chunk if it is long.
class AudioTap {
  constructor(ctx, track, session) {
    this.ctx = ctx;
    this.track = track;
    this.session = session;
    this.cur = null;
    this.seq = 0;
    this.queue = Promise.resolve();
    this.aborted = false;
    this.stalled = false;
    this.gapMs = 0;      // audio the tap missed
    this.lost = 0;       // chunks that failed to upload
    this.coveredMs = 0;  // where the last closed chunk ended
  }

  async start() {
    await this.ctx.audioWorklet.addModule('/pcm-tap.js');
    this.src = this.ctx.createMediaStreamSource(new MediaStream([this.track]));
    this.node = new AudioWorkletNode(this.ctx, 'pcm-tap');
    this.silence = this.ctx.createGain();
    this.silence.gain.value = 0;
    this.src.connect(this.node);
    this.node.connect(this.silence);
    this.silence.connect(this.ctx.destination); // keeps the graph pulled; inaudible
    // Chrome hands an output that has been exactly silent for ~30 s to a timer-driven stand-in,
    // which can run this context slower than real time and drop audio. A level ~100 dB below
    // hearing keeps the real output.
    if (this.ctx.createConstantSource) {
      this.hum = this.ctx.createConstantSource();
      this.hum.offset.value = 1e-5;
      this.hum.connect(this.ctx.destination);
      this.hum.start();
    }
    this.node.port.onmessage = (e) => this.onPcm(e.data);
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
  }

  onPcm(pcm) {
    const s = this.session;
    const now = performance.now();
    const ms = (pcm.length / RATE) * 1000;
    // Batches from before the recording (re)started would hold audio that isn't in the video.
    if (s.state !== 'recording' || now - s.startedAt < ms + 20) return;
    const at = Math.max(0, s.elapsed - ms); // the latest this audio can have started
    const rms = rmsOf(pcm);
    if (window.__shuttleTapLog) window.__shuttleTapLog.push([Math.round(now), Math.round(this.ctx.currentTime * 1000), Math.round(s.elapsed), this.ctx.state]);
    let c = this.cur;
    if (c) {
      const late = at - (c.startMs + (c.n / RATE) * 1000);
      if (late > GAP_MS) {
        if (!c.late.length) c.lateFrom = c.bufs.length;
        c.late.push({ late, now });
        if (c.late.length > GAP_CONFIRM) c.late.shift();
        const first = c.late[0], last = c.late[c.late.length - 1];
        // A backlog after a busy moment arrives all at once; missing audio arrives at a normal pace.
        if (c.late.length === GAP_CONFIRM && last.now - first.now >= (GAP_CONFIRM - 1) * ms * 0.6) {
          c = this.gap(c, Math.min(...c.late.map((l) => l.late)), c.lateFrom);
        }
      } else {
        c.late = [];
        if (late < 0) c.startMs = Math.max(0, c.startMs + late); // an earlier, truer estimate
      }
    }
    if (!c) c = this.cur = { startMs: at, bufs: [], n: 0, late: [] };
    pcm.rms = rms;
    c.bufs.push(pcm);
    c.n += pcm.length;
    const secs = c.n / RATE;
    if ((secs >= MIN_CHUNK_S && rms < 0.006) || secs >= MAX_CHUNK_S) this.close();
  }

  // `gapMs` of audio is missing before bufs[idx]. Returns the chunk to keep filling.
  gap(c, gapMs, idx) {
    this.gapMs += gapMs;
    c.late = [];
    const tail = c.bufs.splice(idx);
    const tailN = tail.reduce((a, b) => a + b.length, 0);
    c.n -= tailN;
    if (gapMs <= SPLIT_GAP_MS) {
      const pad = new Int16Array(Math.round((gapMs / 1000) * RATE));
      pad.pad = true;
      c.bufs.push(pad, ...tail);
      c.n += pad.length + tailN;
      return c;
    }
    const startMs = c.startMs + (c.n / RATE) * 1000 + gapMs;
    this.close();
    return (this.cur = { startMs, bufs: tail, n: tailN, late: [] });
  }

  // Ends the current chunk and queues its upload.
  close() {
    const c = this.cur;
    this.cur = null;
    if (!c || !c.n) return;
    const real = c.bufs.filter((b) => !b.pad);
    if (!real.length) return;
    this.coveredMs = c.startMs + (c.n / RATE) * 1000;
    const seq = this.seq++;
    const silent = real.filter((b) => b.rms > 0.01).length / real.length < 0.03;
    const headers = {
      'X-Start-Ms': String(Math.round(c.startMs)),
      'X-Duration-Ms': String(Math.round((c.n / RATE) * 1000)),
    };
    if (silent) headers['X-Silent'] = '1';
    const body = silent ? new Blob([]) : encodeWav(c.bufs, c.n);
    this.queue = this.queue
      .then(() => putWithRetry(`/api/videos/${this.session.video.id}/audio/${seq}`, body, headers, this))
      // A lost chunk is a gap in the transcript, never a failed video. The server counts chunks,
      // so it shows as a gap instead of a finished transcript.
      .then((ok) => { if (!ok) this.lost++; }, () => { this.lost++; });
  }

  // Closes the last chunk; resolves when every chunk has uploaded (or failed). Audio that
  // stopped arriving before the end (no batches, so nothing looked late) counts as missed.
  finish() {
    this.close();
    const tail = this.session.elapsed - this.coveredMs;
    if (tail > 1500) this.gapMs += tail;
    return this.queue;
  }

  stop() {
    try { this.src && this.src.disconnect(); this.node && this.node.disconnect(); this.hum && this.hum.stop(); } catch {}
    this.ctx.close().catch(() => {});
  }

  report() {}
}

// ---------- one recording session ----------

export class Session extends EventTarget {
  constructor({ mode, cameraStream, micStream, audioCtx, layout, keepDays }) {
    super();
    this.mode = mode;
    this.cameraStream = cameraStream || null;
    this.micStream = micStream || null;
    this.audioCtx = audioCtx || null; // created inside the click, for the transcript tap
    this.layout = layout || null;
    this.keepDays = keepDays === undefined ? 'forever' : keepDays;
    this.displayStream = null;
    this.surface = mode === 'camera' ? 'camera' : '';
    this.chunks = { main: [], cam: [] };
    this.state = 'idle'; // idle | ready | recording | paused | stopping | done | failed | cancelled
    this.elapsedBefore = 0;
    this.startedAt = 0;
    this.video = null;
    this.mime = pickMime();
    this.camMime = mode === 'screen-camera' ? pickCamMime() : null;
    this.camMutedMs = 0;
    this.camMutedSince = 0;
    this.camBytes = [];
  }

  get elapsed() {
    return this.elapsedBefore + (this.state === 'recording' ? performance.now() - this.startedAt : 0);
  }

  get withCam() { return this.mode === 'screen-camera' && !!this.cameraStream && this.camMime !== null; }

  // Must be called synchronously from a click (Safari gates getDisplayMedia on the gesture).
  requestDisplay() {
    if (this.mode === 'camera') return Promise.resolve(null);
    return navigator.mediaDevices.getDisplayMedia(displayMediaOptions()).then((s) => {
      this.displayStream = s;
      const v = s.getVideoTracks()[0];
      if (v) {
        try { v.contentHint = 'detail'; } catch {}
        const set = v.getSettings ? v.getSettings() : {};
        this.surface = set.displaySurface || '';
        // The browser's own "Stop sharing" control ends the track. Safari doesn't always fire
        // 'ended' for it, so the track's state is also checked every second.
        let told = false;
        const ended = () => { if (told) return; told = true; clearInterval(this.endedPoll); this.emit('display-ended'); };
        v.addEventListener('ended', ended);
        s.addEventListener && s.addEventListener('inactive', ended);
        this.endedPoll = setInterval(() => { if (v.readyState === 'ended') ended(); }, 1000);
      }
      return s;
    });
  }

  // Creates the server-side video so the link exists before recording starts.
  async prepare() {
    if (this.mime === null) throw new Error('This browser can’t record video');
    this.video = await api('/api/videos', {
      method: 'POST',
      body: {
        mime: this.mime || 'video/webm',
        camMime: this.withCam ? (this.camMime || 'video/webm') : null,
        mode: this.mode,
        surface: this.surface,
        layout: this.layout,
        keepDays: this.keepDays,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
    const report = () => this.emit('progress', this.progress());
    this.uploaders = { main: new PartUploader(this.video.id, this.video.partSize, 'main', report) };
    if (this.video.hasCam) this.uploaders.cam = new PartUploader(this.video.id, this.video.partSize, 'cam', report);
    this.state = 'ready';
    return this.video;
  }

  progress() {
    const ups = Object.values(this.uploaders || {});
    return {
      sent: ups.reduce((a, u) => a + u.sentBytes, 0),
      total: ups.reduce((a, u) => a + u.totalBytes, 0),
      stalled: ups.some((u) => u.stalled),
      failed: ups.some((u) => u.failed),
    };
  }

  makeRecorder(stream, mime, bitrate, track) {
    const opts = { videoBitsPerSecond: bitrate };
    if (track === 'main') opts.audioBitsPerSecond = 128_000;
    if (mime) opts.mimeType = mime;
    let rec;
    try { rec = new MediaRecorder(stream, opts); }
    catch { rec = new MediaRecorder(stream); }
    rec.addEventListener('dataavailable', (e) => {
      if (!e.data || !e.data.size) return;
      this.chunks[track].push(e.data);
      if (track === 'cam') this.camBytes.push([performance.now(), e.data.size]);
      if (this.state !== 'cancelled' && this.uploaders[track]) this.uploaders[track].push(e.data);
    });
    rec.addEventListener('error', (e) => this.fail(e.error || new Error('Recording failed')));
    rec.stoppedP = new Promise((resolve) => rec.addEventListener('stop', resolve, { once: true }));
    // The event's own timestamp is when the recorder started, not when this page got round to
    // handling it (which can lag by the rest of a busy task).
    rec.startedP = new Promise((resolve) => rec.addEventListener('start', (e) => {
      const now = performance.now();
      resolve(e.timeStamp > 0 && e.timeStamp <= now + 1 ? e.timeStamp : now);
    }, { once: true }));
    return rec;
  }

  start() {
    const isScreen = this.mode !== 'camera';
    const videoTrack = isScreen
      ? this.displayStream && this.displayStream.getVideoTracks()[0]
      : this.cameraStream && this.cameraStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error(isScreen ? 'No screen selected' : 'No camera');
    const micTrack = this.micStream && this.micStream.getAudioTracks()[0];
    const sysTrack = this.displayStream && this.displayStream.getAudioTracks()[0];
    this.mixer = mixAudio([micTrack, sysTrack], micTrack);
    const set = videoTrack.getSettings ? videoTrack.getSettings() : {};
    this.width = set.width || 0;
    this.height = set.height || 0;

    this.fixed = isScreen ? fixedSizeTrack(videoTrack, this.width, this.height) : null;
    const recTrack = this.fixed ? this.fixed.track : videoTrack;
    const mainStream = new MediaStream(this.mixer.track ? [recTrack, this.mixer.track] : [recTrack]);
    this.recorders = { main: this.makeRecorder(mainStream, this.mime, isScreen ? 3_500_000 : 2_500_000, 'main') };
    if (this.uploaders.cam) {
      const camTrack = this.cameraStream.getVideoTracks()[0];
      this.recorders.cam = this.makeRecorder(new MediaStream([camTrack]), this.camMime, 1_200_000, 'cam');
      this.watchCamera(camTrack);
    }
    // Start both in the same turn so they line up; the start events give the exact offset.
    for (const r of Object.values(this.recorders)) r.start(1000);
    this.startedAt = performance.now();
    this.state = 'recording';
    this.emit('state');
    this.mainMime = (this.recorders.main.mimeType || this.mime || 'video/webm').split(';')[0];
    if (this.recorders.cam) this.recordCamMime = (this.recorders.cam.mimeType || this.camMime || 'video/webm').split(';')[0];
    Promise.all([this.recorders.main.startedP, this.recorders.cam ? this.recorders.cam.startedP : null]).then(([a, b]) => {
      this.camOffsetMs = b ? Math.round(b - a) : 0;
    });

    // Transcript tap (never fatal).
    if (this.mixer.track && this.audioCtx && window.AudioWorkletNode) {
      this.tap = new AudioTap(this.audioCtx, this.mixer.track, this);
      this.tap.start().catch((e) => { console.warn('transcript tap off:', e); this.tap = null; });
    }
  }

  // The browser can pause a camera (Safari can when its window is hidden). Count how long,
  // so the share page can say so instead of leaving a frozen face unexplained.
  watchCamera(track) {
    const onMute = () => { if (!this.camMutedSince) this.camMutedSince = performance.now(); this.emit('camera', { muted: true }); };
    const onUnmute = () => {
      if (this.camMutedSince) { this.camMutedMs += performance.now() - this.camMutedSince; this.camMutedSince = 0; }
      this.emit('camera', { muted: false });
    };
    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);
    track.addEventListener('ended', onMute);
    if (track.muted) onMute();
  }

  // Seconds in which the camera recorder produced almost nothing (frozen camera).
  camStarvedMs() {
    let ms = 0;
    const list = this.camBytes;
    for (let i = 1; i < list.length; i++) {
      const dt = list[i][0] - list[i - 1][0];
      if (list[i][1] < 600 && dt < 5000) ms += dt; // < ~600 B in a 1 s slice: no new frames
    }
    return ms;
  }

  pause() {
    if (this.state !== 'recording') return;
    for (const r of Object.values(this.recorders)) { try { r.pause(); } catch {} }
    if (this.tap) this.tap.close();
    this.elapsedBefore += performance.now() - this.startedAt;
    this.state = 'paused';
    this.emit('state');
  }

  resume() {
    if (this.state !== 'paused') return;
    for (const r of Object.values(this.recorders)) { try { r.resume(); } catch {} }
    this.startedAt = performance.now();
    this.state = 'recording';
    this.emit('state');
  }

  async stop() {
    if (this.state !== 'recording' && this.state !== 'paused') return;
    const duration = this.elapsed;
    this.elapsedBefore = duration;
    if (this.camMutedSince) { this.camMutedMs += performance.now() - this.camMutedSince; this.camMutedSince = 0; }
    this.state = 'stopping';
    this.emit('state');
    for (const r of Object.values(this.recorders)) { try { r.stop(); } catch {} }
    // A recorder that never reports stopping mustn't hold up the rest (its data is in already).
    await Promise.all(Object.values(this.recorders).map((r) => Promise.race([r.stoppedP, new Promise((ok) => setTimeout(ok, 5000))])));
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
    // The transcript's last chunk uploads alongside the video's last parts.
    const tapDone = this.tap ? this.tap.finish() : null;
    await Promise.all(Object.values(this.uploaders).map((u) => u.finish()));
    this.allPartsUploaded = true;
    if (this.tap) {
      const tap = this.tap;
      this.tap = null;
      await Promise.race([tapDone, new Promise((r) => setTimeout(r, 8000))]);
      // How many chunks there should be, so one that never arrives reads as a gap.
      this.audioInfo = { audioChunks: tap.seq, tapGapMs: Math.round(tap.gapMs) };
      tap.stop();
    } else if (!this.audioInfo && this.mixer && this.mixer.track) {
      // There was sound, but the transcript never got it (no AudioWorklet, or it failed).
      this.audioInfo = { audioChunks: 0, tapGapMs: Math.round(this.elapsedBefore) };
    }
    const done = await api(`/api/videos/${this.video.id}/complete`, {
      method: 'POST',
      body: {
        durationMs: Math.round(this.elapsedBefore), width: this.width, height: this.height,
        mime: this.mainMime || this.mime, camMime: this.recordCamMime || this.camMime,
        camOffsetMs: this.camOffsetMs || 0,
        camMutedMs: Math.round(Math.max(this.camMutedMs, this.camStarvedMs())),
        surface: this.surface,
        ...(this.audioInfo || {}),
      },
    });
    this.video = done;
    this.state = 'done';
    this.emit('state');
    return done;
  }

  async cancel() {
    const prev = this.state;
    this.state = 'cancelled';
    for (const u of Object.values(this.uploaders || {})) u.aborted = true;
    if (this.tap) { this.tap.aborted = true; this.tap.stop(); this.tap = null; }
    for (const r of Object.values(this.recorders || {})) { try { if (r.state !== 'inactive') r.stop(); } catch {} }
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
  localBlob(track = 'main') {
    const mime = track === 'cam' ? (this.recordCamMime || this.camMime) : (this.mainMime || this.mime);
    return new Blob(this.chunks[track], { type: mime || 'video/webm' });
  }

  releaseCapture() {
    clearInterval(this.endedPoll);
    if (this.displayStream) this.displayStream.getTracks().forEach((t) => t.stop());
    // The camera too, so its light (and the bubble) show at once that recording stopped.
    if (this.cameraStream) this.cameraStream.getTracks().forEach((t) => t.stop());
    if (this.mixer) this.mixer.close();
    if (this.fixed) this.fixed.close();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

// ---------- thumbnails ----------

// One frame from a live track. ImageCapture reads the track directly, so it works even when
// this tab is in the background; otherwise fall back to a playing <video>.
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

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function drawCover(g, img, x, y, w, h) {
  const s = Math.max(w / img.w, h / img.h);
  const dw = img.w * s, dh = img.h * s;
  g.drawImage(img.src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

const toJpeg = (c, q = 0.84) => new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', q));

// poster: the main video's frame. cam: the camera frame. og: the link preview — the frame with
// the camera overlaid the way the video plays, plus a play button.
export async function makeThumbs({ screenTrack, cameraTrack, screenVideo, cameraVideo, mode, layout }) {
  const W = 1280, H = 720;
  const [main, cam] = await Promise.all([
    mode === 'camera' ? grab(cameraTrack, cameraVideo) : grab(screenTrack, screenVideo),
    mode === 'screen-camera' ? grab(cameraTrack, cameraVideo) : null,
  ]);
  const out = {};
  if (!main) return out;

  const [pc, pg] = canvas(W, H);
  pg.fillStyle = '#111214';
  pg.fillRect(0, 0, W, H);
  if (mode === 'camera') drawCover(pg, main, 0, 0, W, H);
  else {
    const fit = Math.min(W / main.w, H / main.h);
    pg.drawImage(main.src, (W - main.w * fit) / 2, (H - main.h * fit) / 2, main.w * fit, main.h * fit);
  }
  out.poster = await toJpeg(pc);

  if (cam) {
    const [cc, cg] = canvas(640, 360);
    drawCover(cg, cam, 0, 0, 640, 360);
    out.cam = await toJpeg(cc, 0.86);
  }

  // Link preview.
  const [oc, og] = canvas(W, H);
  og.drawImage(pc, 0, 0);
  // Drawn even for the Screen layout (as a bubble): the server serves the plain poster while the
  // layout hides the camera, and this one if he switches the camera back on.
  if (cam && layout) {
    const left = (layout.corner || 'bl').endsWith('l');
    if (layout.kind === 'card') {
      const w = 300, h = 375, x = left ? 40 : W - w - 40, y = H - h - 40;
      og.save(); og.shadowColor = 'rgba(0,0,0,.45)'; og.shadowBlur = 30; roundRect(og, x, y, w, h, 22); og.fillStyle = '#000'; og.fill(); og.restore();
      og.save(); roundRect(og, x, y, w, h, 22); og.clip(); drawCover(og, cam, x, y, w, h); og.restore();
    } else {
      const d = 230, x = left ? 40 : W - d - 40, y = H - d - 40;
      og.save(); og.beginPath(); og.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
      og.shadowColor = 'rgba(0,0,0,.45)'; og.shadowBlur = 30; og.fillStyle = '#000'; og.fill(); og.clip();
      drawCover(og, cam, x, y, d, d); og.restore();
      og.beginPath(); og.arc(x + d / 2, y + d / 2, d / 2 - 3, 0, Math.PI * 2); og.lineWidth = 6; og.strokeStyle = 'rgba(255,255,255,.95)'; og.stroke();
    }
  }
  og.beginPath(); og.arc(W / 2, H / 2, 64, 0, Math.PI * 2); og.fillStyle = 'rgba(17,18,20,.62)'; og.fill();
  og.beginPath(); og.moveTo(W / 2 - 20, H / 2 - 32); og.lineTo(W / 2 + 34, H / 2); og.lineTo(W / 2 - 20, H / 2 + 32); og.closePath();
  og.fillStyle = '#fff'; og.fill();
  out.og = await toJpeg(oc);
  return out;
}
