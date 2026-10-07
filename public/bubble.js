// The floating camera bubble. It sits above every app, so a full-screen recording
// captures it — the same trick as Loom's web recorder.
//  - Chrome/Edge: Document Picture-in-Picture → camera + hover controls (pause/stop/delete).
//  - Safari/others: classic video Picture-in-Picture of the camera.

import { icon, fmtDuration } from './ui.js';

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#0d0c12;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;color:#fff}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}
.bar{position:absolute;left:8px;right:8px;bottom:8px;display:flex;align-items:center;gap:6px;padding:6px 6px 6px 12px;border-radius:12px;background:rgba(18,17,23,.82);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);opacity:0;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease}
body:hover .bar,body.show .bar{opacity:1;transform:none}
.dot{width:9px;height:9px;border-radius:50%;background:#ff3b4e;animation:p 1.2s ease-in-out infinite;flex:none}
.paused .dot{animation:none;background:#f5a524}
.t{font-weight:600;font-variant-numeric:tabular-nums;font-size:13px;flex:1;white-space:nowrap}
.warn{position:absolute;left:8px;right:8px;top:8px;text-align:center;font-size:12px;font-weight:600;background:rgba(229,72,77,.92);border-radius:8px;padding:4px 6px}
button.armed{background:#e5484d;color:#fff;width:auto;padding:0 8px;font-size:12px;font-weight:700}
button{border:0;background:transparent;color:#ddd;width:30px;height:30px;border-radius:8px;display:grid;place-items:center;cursor:pointer;padding:0}
button:hover{background:rgba(255,255,255,.12);color:#fff}
button svg{width:16px;height:16px}
button.stop{background:#ff3b4e;color:#fff;width:auto;padding:0 10px;gap:5px;display:flex;align-items:center;font-weight:700;font-size:12.5px}
button.stop svg{width:11px;height:11px}
.cd{position:absolute;inset:0;display:grid;place-items:center;background:rgba(10,8,20,.5);font-size:72px;font-weight:800;text-shadow:0 6px 30px rgba(0,0,0,.6)}
.done{position:absolute;inset:0;display:grid;place-items:center;align-content:center;gap:10px;background:#121117;text-align:center;padding:12px;font-size:14px}
.done button{width:auto;height:34px;padding:0 14px;background:#7c63ff;color:#fff;font-weight:700;border-radius:10px;font-size:13px}
.done .muted{color:#9a96ad;font-size:12.5px}
@keyframes p{50%{opacity:.35}}
`;

export function documentPipSupported() {
  return 'documentPictureInPicture' in window;
}

export function videoPipSupported() {
  return !!(document.pictureInPictureEnabled || (HTMLVideoElement.prototype.webkitSupportsPresentationMode));
}

export class Bubble extends EventTarget {
  constructor(cameraStream) {
    super();
    this.stream = cameraStream;
    this.win = null;
    this.videoEl = null;
    this.kind = null;
  }

  // Call synchronously inside a click handler. Resolves true if a bubble opened.
  open(fallbackVideo) {
    if (documentPipSupported()) {
      let p;
      try {
        p = window.documentPictureInPicture.requestWindow({ width: 260, height: 260 });
      } catch (e) { return Promise.resolve(false); }
      return p.then((win) => { this.mountDoc(win); return true; }).catch(() => false);
    }
    const v = fallbackVideo;
    if (!v) return Promise.resolve(false);
    try {
      if (v.requestPictureInPicture && document.pictureInPictureEnabled) {
        return v.requestPictureInPicture().then(() => {
          this.kind = 'video'; this.videoEl = v;
          v.addEventListener('leavepictureinpicture', () => this.emit('closed'), { once: true });
          return true;
        }).catch(() => false);
      }
      if (v.webkitSetPresentationMode) {
        v.webkitSetPresentationMode('picture-in-picture');
        this.kind = 'video'; this.videoEl = v;
        return Promise.resolve(true);
      }
    } catch {}
    return Promise.resolve(false);
  }

  mountDoc(win) {
    this.kind = 'doc';
    this.win = win;
    const d = win.document;
    d.title = 'Shuttle';
    const style = d.createElement('style');
    style.textContent = CSS;
    d.head.append(style);
    const video = d.createElement('video');
    video.autoplay = true; video.muted = true; video.playsInline = true;
    video.srcObject = this.stream;
    d.body.append(video);
    video.play().catch(() => {});
    const bar = d.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = `<span class="dot"></span><span class="t">0:00</span>
      <button data-a="pause" title="Pause">${icon.pause}</button>
      <button data-a="cancel" title="Delete">${icon.trash}</button>
      <button data-a="stop" class="stop" title="Stop">${icon.stop}Stop</button>`;
    d.body.append(bar);
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      // Dialogs don't open from a PiP window, so Delete asks with a second tap.
      if (b.dataset.a === 'cancel' && !b.classList.contains('armed')) {
        b.classList.add('armed');
        b.textContent = 'Delete?';
        clearTimeout(this.disarm);
        this.disarm = setTimeout(() => { b.classList.remove('armed'); b.innerHTML = icon.trash; }, 3000);
        return;
      }
      this.emit('action', { action: b.dataset.a, doc: d });
    });
    this.timeEl = bar.querySelector('.t');
    this.pauseBtn = bar.querySelector('[data-a=pause]');
    win.addEventListener('pagehide', () => { this.win = null; this.emit('closed'); });
  }

  get isOpen() { return this.kind === 'doc' ? !!this.win : this.kind === 'video'; }

  setTime(ms) { if (this.timeEl) this.timeEl.textContent = fmtDuration(ms); }

  setStatus(text) {
    if (!this.win) return;
    const d = this.win.document;
    let el = d.querySelector('.warn');
    if (!text) { if (el) el.remove(); return; }
    if (!el) { el = d.createElement('div'); el.className = 'warn'; d.body.append(el); }
    el.textContent = text;
  }

  setPaused(paused) {
    if (!this.win) return;
    this.win.document.body.classList.toggle('paused', paused);
    if (this.pauseBtn) {
      this.pauseBtn.innerHTML = paused ? icon.play : icon.pause;
      this.pauseBtn.dataset.a = paused ? 'resume' : 'pause';
      this.pauseBtn.title = paused ? 'Resume' : 'Pause';
    }
  }

  countdown(n) {
    if (!this.win) return;
    const d = this.win.document;
    let el = d.querySelector('.cd');
    if (n <= 0) { if (el) el.remove(); return; }
    if (!el) { el = d.createElement('div'); el.className = 'cd'; d.body.append(el); }
    el.textContent = String(n);
  }

  // After Stop: the bubble turns into "Link copied / Copy link".
  showDone(shareUrl, { copied, onCopy }) {
    if (!this.win) return;
    const d = this.win.document;
    const box = d.createElement('div');
    box.className = 'done';
    box.innerHTML = `<div>${copied ? 'Link copied' : 'Uploading…'}</div><button type="button">Copy link</button><div class="muted"></div>`;
    d.body.append(box);
    const btn = box.querySelector('button');
    btn.addEventListener('click', async () => {
      const ok = await onCopy(d);
      box.firstElementChild.textContent = ok ? 'Link copied' : 'Couldn’t copy';
    });
    this.doneEl = box;
    setTimeout(() => this.close(), 12000);
  }

  setDoneStatus(text) {
    if (this.doneEl) this.doneEl.querySelector('.muted').textContent = text;
  }

  close() {
    try {
      if (this.kind === 'doc' && this.win) this.win.close();
      if (this.kind === 'video') {
        if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
        else if (this.videoEl && this.videoEl.webkitSetPresentationMode) this.videoEl.webkitSetPresentationMode('inline');
      }
    } catch {}
    this.win = null;
    this.kind = null;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
