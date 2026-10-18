// The share-page player. Plays the screen recording and composites the separately recorded
// camera on top in the chosen layout, keeps the two in sync, skips edited-out ranges, and
// shows captions from the transcript. Custom controls (no native ones), so the camera never
// sits on a native scrub bar and viewers get no download menu.

import { normalizeCuts, keepSegments, editedDuration, toEdited, toSource, cutAt, captionLines } from './timeline.js';
import { h, icon, fmtDuration } from './ui.js';

const SPEEDS = [1, 1.2, 1.25, 1.5, 1.75, 2]; // same list as the server's PLAY_SPEEDS
const BUBBLE = { s: 0.2, m: 0.27, l: 0.36 };
const CARD = { s: 0.16, m: 0.21, l: 0.27 };

const ico = {
  play: icon.play,
  pause: icon.pause,
  replay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  unfull: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
  vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
  mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>',
  cc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 10.3a2.5 2.5 0 1 0 0 3.4M17.5 10.3a2.5 2.5 0 1 0 0 3.4"/></svg>',
};

const pref = {
  get(k, d) { try { const v = localStorage.getItem('shuttle.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('shuttle.' + k, JSON.stringify(v)); } catch {} },
};

export class Player extends EventTarget {
  constructor(host, { video, ownerName = '', owner = false }) {
    super();
    this.v = video;
    this.owner = owner;
    this.hasCam = !!video.hasCam && video.mode === 'screen-camera';
    this.layout = { kind: 'bubble', corner: 'bl', size: 'm', ...(video.layout || {}) };
    this.camOffset = (video.camOffsetMs || 0) / 1000;
    this.cuts = normalizeCuts(video.cuts || []);
    this.words = [];
    this.lines = [];
    this.started = false;
    this.ended = false;
    this.duration = (video.durationMs || 0) / 1000;
    this.build(host, ownerName);
    this.bind();
    this.applyLayout();
  }

  // ---------- DOM ----------

  build(host, ownerName) {
    const v = this.v;
    this.main = h('video', {
      class: 'sp-main', playsinline: true, preload: 'metadata', controlslist: 'nodownload noplaybackrate', disablepictureinpicture: true,
      poster: v.hasThumb ? `/thumb/${v.id}.jpg` : null,
    });
    this.main.src = `/raw/${v.id}`;
    this.mainWrap = h('div', { class: 'sp-main-wrap' }, this.main);

    if (this.hasCam) {
      this.cam = h('video', { class: 'sp-cam', playsinline: true, muted: true, preload: 'auto', disablepictureinpicture: true,
        poster: v.hasCamThumb ? `/thumb/${v.id}/cam.jpg` : null });
      this.cam.muted = true;
      this.cam.src = `/raw/${v.id}/cam`;
      this.camWrap = h('div', { class: 'sp-cam-wrap' }, this.cam, ownerName ? h('span', { class: 'sp-name' }, ownerName) : null);
    }
    this.caption = h('div', { class: 'sp-caption', hidden: true }, h('span'));
    this.bigPlay = h('button', { class: 'sp-big', type: 'button', 'aria-label': 'Play', html: ico.play });
    this.spinner = h('div', { class: 'sp-spin', hidden: true });
    this.endBox = h('div', { class: 'sp-end', hidden: true },
      h('button', { class: 'sp-big', type: 'button', 'aria-label': 'Replay', html: ico.replay, onclick: () => this.replay() }));

    this.playBtn = h('button', { class: 'sp-btn', type: 'button', 'aria-label': 'Play', html: ico.play });
    this.time = h('span', { class: 'sp-time' }, '0:00');
    this.scrub = h('input', { class: 'sp-scrub', type: 'range', min: '0', max: '1', step: '0.01', value: '0', 'aria-label': 'Seek' });
    this.speedBtn = h('button', { class: 'sp-btn sp-speed', type: 'button', 'aria-label': 'Speed', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, '1×');
    this.speedMenu = h('div', { class: 'sp-speed-menu', role: 'menu', hidden: true },
      ...SPEEDS.map((s) => h('button', { type: 'button', role: 'menuitemradio', 'data-speed': String(s), onclick: (e) => { e.stopPropagation(); this.pickSpeed(s); } }, `${s}×`)));
    this.speedWrap = h('div', { class: 'sp-speed-wrap' }, this.speedBtn, this.speedMenu);
    this.ccBtn = h('button', { class: 'sp-btn', type: 'button', 'aria-label': 'Captions', 'aria-pressed': 'false', html: ico.cc, hidden: true });
    this.muteBtn = h('button', { class: 'sp-btn', type: 'button', 'aria-label': 'Mute', html: ico.vol });
    this.fullBtn = h('button', { class: 'sp-btn', type: 'button', 'aria-label': 'Full screen', html: ico.full });
    this.controls = h('div', { class: 'sp-controls' }, this.playBtn, this.time, this.scrub, this.speedWrap, this.ccBtn, this.muteBtn, this.fullBtn);

    this.el = h('div', { class: 'sp', tabindex: '0', 'data-kind': this.layout.kind },
      h('div', { class: 'sp-bg' }), this.mainWrap, this.camWrap || null, this.caption, this.spinner, this.bigPlay, this.endBox, this.controls);
    host.replaceChildren(this.el);

    // The owner's pick for this video wins; without one, the viewer's own last choice.
    const speed = SPEEDS.includes(this.v.speed) ? this.v.speed : pref.get('speed', 1);
    this.setSpeed(SPEEDS.includes(speed) ? speed : 1);
    this.setCaptions(pref.get('cc', false));
  }

  bind() {
    const m = this.main;
    const onPlayClick = () => (m.paused || this.ended ? this.play() : this.pause());
    this.bigPlay.addEventListener('click', () => this.play());
    this.playBtn.addEventListener('click', onPlayClick);
    this.mainWrap.addEventListener('click', onPlayClick);
    if (this.camWrap) this.camWrap.addEventListener('click', onPlayClick);
    this.speedBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleSpeedMenu(); });
    document.addEventListener('click', (e) => { if (!this.speedWrap.contains(e.target)) this.toggleSpeedMenu(false); });
    this.ccBtn.addEventListener('click', () => { this.setCaptions(!this.cc); pref.set('cc', this.cc); });
    this.muteBtn.addEventListener('click', () => {
      m.muted = !m.muted;
      this.muteBtn.innerHTML = m.muted ? ico.mute : ico.vol;
    });
    this.fullBtn.addEventListener('click', () => this.toggleFullscreen());
    this.scrub.addEventListener('input', () => this.seekEdited(Number(this.scrub.value)));
    this.scrub.addEventListener('pointerdown', () => { this.scrubbing = true; });
    for (const ev of ['pointerup', 'pointercancel', 'change']) this.scrub.addEventListener(ev, () => { this.scrubbing = false; });

    m.addEventListener('loadedmetadata', () => this.onMeta());
    m.addEventListener('durationchange', () => this.onMeta());
    m.addEventListener('play', () => { this.syncCam(true); this.playCam(); this.loop(); this.armCutTimer(); this.ui(); });
    m.addEventListener('pause', () => { this.waiting = false; this.cam && this.cam.pause(); clearTimeout(this.cutTimer); this.ui(); this.showControls(); });
    m.addEventListener('seeking', () => this.syncCam(true));
    m.addEventListener('seeked', () => { this.syncCam(true); this.armCutTimer(); });
    m.addEventListener('ratechange', () => this.armCutTimer());
    m.addEventListener('waiting', () => { this.waiting = true; this.spinner.hidden = false; this.cam && this.cam.pause(); });
    m.addEventListener('playing', () => { this.waiting = false; this.spinner.hidden = true; if (!m.paused) this.playCam(); this.armCutTimer(); });
    m.addEventListener('ended', () => this.end());
    m.addEventListener('timeupdate', () => this.tick());
    if (!this.owner) for (const el of [m, this.cam].filter(Boolean)) el.addEventListener('contextmenu', (e) => e.preventDefault());
    if (this.cam) {
      const c = this.cam;
      c.addEventListener('loadedmetadata', () => {
        this.applyLayout();
        // Like the screen file, a camera file can report no length until its end has been read;
        // without one, the player can't tell when the camera ran out.
        if (c.duration === Infinity && !this.camProbing) {
          this.camProbing = true;
          const back = () => {
            if (c.duration === Infinity) return;
            c.removeEventListener('durationchange', back);
            this.camProbing = false;
            this.syncCam(true);
          };
          c.addEventListener('durationchange', back);
          try { c.currentTime = 1e101; } catch { this.camProbing = false; }
        }
      });
    }

    // Controls hide while playing and the pointer is still.
    let idle;
    const wake = () => { this.showControls(); clearTimeout(idle); idle = setTimeout(() => { if (!m.paused) this.el.classList.remove('controls-on'); }, 2600); };
    this.el.addEventListener('pointermove', wake);
    this.el.addEventListener('pointerdown', wake);
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.showControls();

    new ResizeObserver(() => this.applyLayout()).observe(this.el);
    for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => {
      const fs = this.isFullscreen();
      this.el.classList.toggle('fs', fs);
      this.fullBtn.innerHTML = fs ? ico.unfull : ico.full;
      setTimeout(() => this.applyLayout(), 50);
    });
  }

  // MediaRecorder files can report Infinity until the browser has looked at the end.
  onMeta() {
    const m = this.main;
    if (m.duration === Infinity && !this.fixingDuration) {
      this.fixingDuration = true;
      const back = () => {
        if (m.duration === Infinity) return;
        m.removeEventListener('durationchange', back);
        m.currentTime = 0;
        this.fixingDuration = false;
      };
      m.addEventListener('durationchange', back);
      try { m.currentTime = 1e101; } catch {}
      return;
    }
    if (Number.isFinite(m.duration) && m.duration > 0) this.duration = m.duration;
    this.cuts = normalizeCuts(this.cuts, this.duration);
    this.lines = captionLines(this.words, this.cuts);
    this.applyLayout();
    this.ui();
  }

  // ---------- playback ----------

  get editedDuration() { return editedDuration(this.cuts, this.duration); }
  get currentSource() { return this.main.currentTime; }
  get currentEdited() { return toEdited(this.main.currentTime, this.cuts); }

  play() {
    const segs = keepSegments(this.cuts, this.duration);
    if (!segs.length) return;
    if (this.ended || this.main.currentTime >= segs[segs.length - 1][1] - 0.05) this.main.currentTime = segs[0][0];
    else if (!this.started && this.main.currentTime < segs[0][0]) this.main.currentTime = segs[0][0];
    this.started = true;
    this.ended = false;
    this.endBox.hidden = true;
    this.bigPlay.hidden = true;
    this.el.classList.add('started');
    const p = this.main.play();
    this.playCam(); // same gesture: iOS needs both here
    if (p) p.catch(() => {});
    this.dispatchEvent(new Event('play'));
  }

  pause() { this.main.pause(); }

  replay() { this.ended = true; this.play(); }

  seekEdited(te) { this.seekSource(toSource(Math.max(0, te), this.cuts, this.duration)); }

  seekSource(t) {
    const c = cutAt(t, this.cuts);
    this.main.currentTime = c ? Math.min(c[1], this.duration) : t;
    if (!this.started) { this.started = true; this.bigPlay.hidden = true; this.el.classList.add('started'); }
    if (this.ended) { this.ended = false; this.endBox.hidden = true; }
    this.tick();
  }

  end() {
    this.ended = true;
    clearTimeout(this.cutTimer);
    this.main.pause();
    this.endBox.hidden = false;
    this.ui();
    this.dispatchEvent(new Event('ended'));
  }

  loop() {
    if (this.raf) return;
    const step = () => {
      this.raf = 0;
      if (this.main.paused) return;
      this.tick();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  // Cuts are also skipped by a timer aimed at the next one: animation frames stop in background
  // tabs and in iPhone full screen, and timeupdate comes only every quarter second.
  armCutTimer() {
    clearTimeout(this.cutTimer);
    const m = this.main;
    if (m.paused || this.ended || !this.cuts.length) return;
    const t = m.currentTime;
    const next = this.cuts.find((c) => c[1] > t + 0.03);
    if (!next) return;
    const wait = ((next[0] - t) / (m.playbackRate || 1) - 0.03) * 1000;
    this.cutTimer = setTimeout(() => { this.tick(); this.armCutTimer(); }, Math.min(1000, Math.max(10, wait)));
  }

  tick() {
    const m = this.main;
    const t = m.currentTime;
    if (!m.paused && !m.seeking) {
      const c = cutAt(t + 0.03, this.cuts);
      if (c) {
        if (c[1] >= this.duration - 0.05) return this.end();
        m.currentTime = c[1];
      }
    }
    this.syncCam(false);
    this.ui();
    this.dispatchEvent(new CustomEvent('time', { detail: { source: t, edited: toEdited(t, this.cuts) } }));
  }

  playCam() {
    const c = this.cam;
    // Never restart a finished camera from the top, or play one the layout hides.
    if (!c || this.camHidden || this.camHeld || this.camProbing || this.camStarting || !c.paused || c.ended) return;
    this.camStarting = true;
    c.play().catch(() => {}).finally(() => { this.camStarting = false; });
  }

  // Keep the camera on the screen's clock: nudge its rate for small drift, jump for big.
  syncCam(hard) {
    const c = this.cam;
    if (!c || c.readyState < 1 || this.camHidden || this.camProbing) return;
    const m = this.main;
    const raw = m.currentTime - this.camOffset;
    const target = Math.max(0, raw);
    const camEnd = Number.isFinite(c.duration) ? Math.max(0, c.duration - 0.05) : Infinity;
    if (raw < -0.03 || target >= camEnd) {
      // Before the camera started recording, or after it stopped (its file is shorter than the
      // screen's): hold its first or last frame instead of running ahead or looping.
      const at = raw < 0 ? 0 : camEnd;
      this.camHeld = true;
      if (!c.paused) c.pause();
      if (!c.seeking && Math.abs(c.currentTime - at) > 0.1) c.currentTime = at;
      return;
    }
    this.camHeld = false;
    // While the screen video seeks, buffers or stalls (Safari doesn't always say so), the
    // camera waits for it rather than running ahead.
    const now = performance.now();
    if (m.currentTime !== this.lastMainTime || m.paused) { this.lastMainTime = m.currentTime; this.lastMainMove = now; }
    const stalled = !m.paused && now - (this.lastMainMove || now) > 250;
    if (m.seeking || this.waiting || stalled) {
      if (!c.paused) c.pause();
      if (hard && Math.abs(c.currentTime - target) > 0.02) c.currentTime = target;
      return;
    }
    if (c.seeking && !hard) return;
    const diff = c.currentTime - target;
    const rate = m.playbackRate;
    if (hard || Math.abs(diff) > 0.2 || m.paused) {
      if (Math.abs(diff) > 0.02) c.currentTime = target;
      c.playbackRate = rate;
    } else if (c.paused) {
      // Starting again: only jump if it has drifted.
      if (Math.abs(diff) > 0.08) c.currentTime = target;
      c.playbackRate = rate;
    } else if (Math.abs(diff) > 0.04) {
      c.playbackRate = rate * (diff > 0 ? 0.9 : 1.1);
    } else if (c.playbackRate !== rate) {
      c.playbackRate = rate;
    }
    if (!m.paused && c.paused) this.playCam();
  }

  // ---------- UI ----------

  ui() {
    const m = this.main;
    const playing = !m.paused && !this.ended;
    // Only when it changes: ui() runs every frame while playing, and swapping the icon under
    // the pointer between mouse-down and mouse-up swallowed the click (Pause did nothing).
    if (this.shownPlaying !== playing) {
      this.shownPlaying = playing;
      this.playBtn.innerHTML = playing ? ico.pause : ico.play;
      this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }
    const total = this.editedDuration;
    const cur = Math.min(total, toEdited(m.currentTime, this.cuts));
    const label = `${fmtDuration(cur * 1000)} / ${fmtDuration(total * 1000)}`;
    if (this.time.textContent !== label) this.time.textContent = label;
    this.scrub.max = String(Math.max(0.01, total));
    if (!this.scrubbing) this.scrub.value = String(cur);
    this.scrub.style.setProperty('--p', `${total ? (cur / total) * 100 : 0}%`);
    // Captions
    if (this.cc && this.lines.length) {
      const t = m.currentTime;
      // The latest line that has started (an ended one lingers briefly only until the next).
      let line = null;
      for (const l of this.lines) { if (l.s - 0.15 > t) break; if (t <= l.e + 0.6) line = l; }
      const text = line ? line.text : '';
      this.caption.hidden = !text;
      if (this.caption.firstChild.textContent !== text) this.caption.firstChild.textContent = text;
    } else this.caption.hidden = true;
  }

  showControls() { this.el.classList.add('controls-on'); }

  setSpeed(s) {
    this.speed = s;
    this.main.playbackRate = s;
    this.main.defaultPlaybackRate = s;
    if (this.cam) this.cam.playbackRate = s;
    this.speedBtn.textContent = `${s}×`;
    this.speedMenu.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.speed) === s)));
  }

  toggleSpeedMenu(open = this.speedMenu.hidden) {
    this.speedMenu.hidden = !open;
    this.speedBtn.setAttribute('aria-expanded', String(open));
    if (open) this.showControls();
  }

  // A viewer's choice also becomes their default for videos without an owner's pick.
  pickSpeed(s) {
    this.setSpeed(s);
    pref.set('speed', s);
    this.toggleSpeedMenu(false);
    this.dispatchEvent(new CustomEvent('speed', { detail: s }));
  }

  setCaptions(on) {
    this.cc = !!on;
    this.ccBtn.setAttribute('aria-pressed', String(this.cc));
    this.ui();
  }

  setWords(words) {
    this.words = words || [];
    this.lines = captionLines(this.words, this.cuts);
    this.ccBtn.hidden = !this.lines.length;
    this.ui();
  }

  setCuts(cuts) {
    this.cuts = normalizeCuts(cuts, this.duration);
    this.lines = captionLines(this.words, this.cuts);
    this.armCutTimer();
    this.ui();
  }

  setLayout(layout) {
    this.layout = { ...this.layout, ...layout };
    this.el.dataset.kind = this.layout.kind;
    this.applyLayout();
  }

  // The Screen layout doesn't show the camera, so it isn't played (or downloaded) at all.
  updateCamHidden() {
    const hidden = !!this.cam && this.layout.kind === 'screen';
    if (hidden === !!this.camHidden) return;
    this.camHidden = hidden;
    if (hidden) { this.cam.pause(); return; }
    this.syncCam(true);
    if (!this.main.paused) this.playCam();
  }

  onKey(e) {
    if (e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]') && e.target !== this.scrub) return;
    const k = e.key;
    if (k === ' ' || k === 'k') { e.preventDefault(); this.main.paused || this.ended ? this.play() : this.pause(); }
    else if (k === 'ArrowRight' || k === 'l') { e.preventDefault(); this.seekEdited(this.currentEdited + 5); }
    else if (k === 'ArrowLeft' || k === 'j') { e.preventDefault(); this.seekEdited(this.currentEdited - 5); }
    else if (k === 'f') this.toggleFullscreen();
    else if (k === 'm') this.muteBtn.click();
    else if (k === 'c' && !this.ccBtn.hidden) this.ccBtn.click();
    else if (k === '>' || k === '<') { const i = SPEEDS.indexOf(this.speed) + (k === '>' ? 1 : -1); if (i >= 0 && i < SPEEDS.length) this.pickSpeed(SPEEDS[i]); }
    else if (k === 'Escape') this.toggleSpeedMenu(false);
  }

  isFullscreen() { return (document.fullscreenElement || document.webkitFullscreenElement) === this.el; }

  toggleFullscreen() {
    if (this.isFullscreen()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    if (this.el.requestFullscreen) this.el.requestFullscreen().catch(() => {});
    else if (this.el.webkitRequestFullscreen) this.el.webkitRequestFullscreen();
    else if (this.main.webkitEnterFullscreen) this.main.webkitEnterFullscreen(); // iPhone: the screen only
  }

  // ---------- layout ----------

  applyLayout() {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (!W || !H) return;
    const m = this.main;
    const mw = m.videoWidth || this.v.width || 16, mh = m.videoHeight || this.v.height || 9;
    const ar = mw / mh;
    const kind = this.hasCam ? this.layout.kind : 'screen';
    const { main, cam, unit } = layoutBoxes({ W, H, ar, kind, layout: this.layout, cameraMode: this.v.mode === 'camera' });

    place(this.mainWrap, main);
    this.updateCamHidden();
    this.el.classList.toggle('sp-framed', kind === 'side' && this.v.mode !== 'camera');
    if (this.camWrap) {
      this.camWrap.hidden = !cam;
      if (cam) {
        place(this.camWrap, cam);
        this.camWrap.dataset.shape = cam.shape;
        this.camWrap.classList.toggle('bottom', !!cam.bottom);
        this.camWrap.style.setProperty('--ring', `${Math.max(2, Math.round(4 * unit))}px`);
      }
    }
    this.el.style.setProperty('--unit', String(unit));
  }
}

// Where the screen and the camera go in a W×H frame. Shared by the player and the export, so a
// downloaded video looks like the share page.
export function layoutBoxes({ W, H, ar, kind, layout, cameraMode }) {
  const unit = Math.min(W, H * 16 / 9) / 1000;
  let main, cam = null;
  if (cameraMode) {
    main = { x: 0, y: 0, w: W, h: H, r: 0 };
  } else if (kind === 'side') {
    const pad = W * 0.04;
    const camW = W * 0.25;
    const region = { x: pad, y: pad, w: W - camW - pad * 3, h: H - pad * 2 };
    main = { ...fit(ar, region), r: 12 * unit };
    const camH = Math.min(H - pad * 2, camW * 1.32);
    cam = { x: W - pad - camW, y: (H - camH) / 2, w: camW, h: camH, r: 16 * unit, shape: 'card' };
  } else {
    main = { ...fit(ar, { x: 0, y: 0, w: W, h: H }), r: 0 };
    if (kind === 'bubble' || kind === 'card') {
      const margin = Math.max(10, H * 0.04);
      let w, hh;
      if (kind === 'bubble') { w = hh = Math.min(H * BUBBLE[layout.size] || H * BUBBLE.m, main.w * 0.45); }
      else { w = Math.min(W * (CARD[layout.size] || CARD.m), main.w * 0.4); hh = w * 1.25; }
      const left = layout.corner.endsWith('l');
      const top = layout.corner.startsWith('t');
      cam = {
        x: left ? main.x + margin : main.x + main.w - margin - w,
        y: top ? main.y + margin : main.y + main.h - margin - hh,
        w, h: hh, r: kind === 'bubble' ? w / 2 : 16 * unit, shape: kind, bottom: !top,
      };
    }
  }
  return { main, cam, unit };
}

function fit(ar, box) {
  let w = box.w, h = w / ar;
  if (h > box.h) { h = box.h; w = h * ar; }
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

function place(el, b) {
  el.style.left = `${b.x}px`;
  el.style.top = `${b.y}px`;
  el.style.width = `${b.w}px`;
  el.style.height = `${b.h}px`;
  el.style.borderRadius = `${b.r || 0}px`;
}
