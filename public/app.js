import { $, h, icon, toast, api, fmtDuration, fmtAgo, fmtSize, copyText } from './ui.js';
import { Session, canRecordScreen, makeThumbnail, pickMime } from './recorder.js';
import { Bubble } from './bubble.js';

const store = {
  get(k, d) { try { const v = localStorage.getItem('shuttle.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('shuttle.' + k, JSON.stringify(v)); } catch {} },
};

// ---------------- boot ----------------

boot();

async function boot() {
  let me;
  try { me = await api('/api/me'); } catch { me = { owner: false }; }
  if (!me.owner) return showSignin(me);
  showLibrary();
}

function showSignin(me) {
  $('#library').hidden = true;
  $('#top-actions').hidden = true;
  $('#signin').hidden = false;
  if (me && me.passwordSet === false) $('#signin-error').textContent = 'Set OWNER_PASSWORD on the server first.';
  $('#signin-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter || $('#signin-form button');
    btn.disabled = true;
    $('#signin-error').textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: { password: $('#password').value } });
      $('#signin').hidden = true;
      showLibrary();
    } catch (err) {
      $('#signin-error').textContent = err.message;
      $('#password').select();
    } finally { btn.disabled = false; }
  };
}

$('#signout').onclick = async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.reload();
};

// ---------------- library ----------------

async function showLibrary() {
  $('#signin').hidden = true;
  $('#library').hidden = false;
  $('#top-actions').hidden = false;
  $('#new-recording').onclick = openSetup;
  $('#empty-record').onclick = openSetup;
  await renderLibrary();
}

async function renderLibrary() {
  let videos = [];
  try { ({ videos } = await api('/api/videos')); }
  catch (e) { if (e.status === 401) return showSignin(); toast(e.message, { bad: true }); }
  const grid = $('#grid');
  grid.replaceChildren(...videos.map(card));
  $('#empty').hidden = videos.length > 0;
}

function card(v) {
  const interrupted = v.status === 'recording' && Date.now() - (v.updatedAt || v.createdAt) > 3 * 60000;
  const live = v.status === 'recording' && !interrupted;
  const link = `/v/${v.id}`;
  const shareUrl = location.origin + link;
  const meta = [fmtAgo(v.createdAt), v.views ? `${v.views} view${v.views === 1 ? '' : 's'}` : null, fmtSize(v.size)].filter(Boolean).join(' · ');
  const el = h('article', { class: 'card' },
    h('a', { class: 'thumb', href: link },
      h('img', { src: `/thumb/${v.id}.jpg?v=${v.updatedAt || ''}`, alt: '', loading: 'lazy' }),
      v.status === 'ready' && v.durationMs ? h('span', { class: 'dur' }, fmtDuration(v.durationMs)) : null,
      interrupted ? h('span', { class: 'badge' }, 'Interrupted') : null,
      live ? h('span', { class: 'badge' }, 'Recording') : null,
    ),
    h('div', { class: 'body' },
      h('div', { class: 'text' },
        h('div', { class: 'name', title: v.title }, v.title),
        h('div', { class: 'meta' }, meta),
      ),
      h('div', { class: 'tools' },
        interrupted ? h('button', { class: 'btn btn-ghost', type: 'button', style: 'height:34px;padding:0 10px', onclick: () => recover(v) }, 'Recover') : null,
        v.status === 'ready' ? h('button', { class: 'icon-btn', type: 'button', title: 'Copy link', 'aria-label': 'Copy link', html: icon.link, onclick: async () => {
          toast((await copyText(shareUrl)) ? 'Link copied' : 'Couldn’t copy', {});
        } }) : null,
        h('button', { class: 'icon-btn', type: 'button', title: 'Delete', 'aria-label': 'Delete', html: icon.trash, onclick: () => remove(v, el) }),
      ),
    ),
  );
  return el;
}

async function recover(v) {
  try {
    const out = await api(`/api/videos/${v.id}/complete`, { method: 'POST', body: { recover: true } });
    toast(out.truncated ? 'Recovered (the end was lost)' : 'Recovered');
  } catch (e) { toast(e.message, { bad: true }); }
  renderLibrary();
}

async function remove(v, el) {
  if (!confirm(`Delete “${v.title}”?`)) return;
  try {
    await api(`/api/videos/${v.id}`, { method: 'DELETE' });
    el.remove();
    if (!$('#grid').children.length) $('#empty').hidden = false;
    toast('Deleted');
  } catch (e) { toast(e.message, { bad: true }); }
}

// ---------------- setup sheet ----------------

const MODES = [
  { id: 'screen-camera', label: 'Screen + cam', icon: icon.screenCam },
  { id: 'screen', label: 'Screen', icon: icon.screen },
  { id: 'camera', label: 'Camera', icon: icon.camera },
];

const setup = {
  el: null, mode: 'screen-camera', cameraStream: null, micStream: null,
  micOn: true, audioCtx: null, meterRaf: 0, busy: false,
};

function openSetup() {
  if (setup.el) return;
  if (pickMime() === null) return toast('This browser can’t record video', { bad: true });
  const screenOk = canRecordScreen();
  setup.mode = screenOk ? store.get('mode', 'screen-camera') : 'camera';
  setup.micOn = store.get('micOn', true);
  // Created inside the click, so Safari lets it run.
  try { setup.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}

  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'What to record' },
    ...MODES.map((m) => h('button', {
      type: 'button', 'data-mode': m.id, 'aria-pressed': String(m.id === setup.mode),
      disabled: !screenOk && m.id !== 'camera', html: `${m.icon}<span>${m.label}</span>`,
      onclick: () => setMode(m.id),
    })),
  );
  const camSel = h('select', { id: 'cam-select', 'aria-label': 'Camera', onchange: () => { store.set('cameraId', camSel.value); acquireCamera(); } });
  const micSel = h('select', { id: 'mic-select', 'aria-label': 'Microphone', onchange: () => { store.set('micId', micSel.value); acquireMic(); } });
  const micToggle = h('button', { class: 'toggle', type: 'button', role: 'switch', 'aria-checked': String(setup.micOn), 'aria-label': 'Microphone on', onclick: () => {
    setup.micOn = !setup.micOn; store.set('micOn', setup.micOn);
    micToggle.setAttribute('aria-checked', String(setup.micOn));
    micSel.disabled = !setup.micOn;
    if (setup.micOn) acquireMic(); else stopStream('micStream');
  } });
  micSel.disabled = !setup.micOn;
  const startBtn = h('button', { class: 'btn btn-rec btn-lg', id: 'start', type: 'button', onclick: onStart, html: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>Start recording` });

  const el = h('div', { class: 'sheet-backdrop', onclick: (e) => { if (e.target === el) closeSetup(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'New recording' },
      h('div', { class: 'sheet-head' },
        h('h2', {}, 'New recording'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', html: icon.close, onclick: closeSetup }),
      ),
      seg,
      h('div', { class: 'preview', id: 'preview' }),
      h('div', { class: 'devices' },
        h('div', { class: 'device', id: 'cam-row' }, h('span', { html: icon.camera }), camSel, h('span')),
        h('div', { class: 'device' }, h('span', { html: icon.mic }), micSel, micToggle),
        h('div', { class: 'meter', 'aria-hidden': 'true', style: 'grid-column:auto' }, h('i', { id: 'meter' })),
      ),
      h('div', { class: 'sheet-foot' },
        h('span', { class: 'note', id: 'setup-note' }, screenOk ? '' : 'Screen recording needs a computer.'),
        startBtn,
      ),
    ),
  );
  setup.el = el;
  document.body.append(el);
  document.addEventListener('keydown', escClose);
  renderPreview();
  fillDevices();
  acquireCamera().then(() => acquireMic()).then(fillDevices);
}

function escClose(e) { if (e.key === 'Escape' && setup.el && !setup.busy) closeSetup(); }

function setMode(id) {
  setup.mode = id;
  store.set('mode', id);
  setup.el.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === id)));
  renderPreview();
  if (id !== 'screen' && !setup.cameraStream) acquireCamera();
}

function needsCamera() { return setup.mode !== 'screen'; }

function renderPreview() {
  const p = $('#preview', setup.el);
  const camRow = $('#cam-row', setup.el);
  camRow.style.display = needsCamera() ? '' : 'none';
  const v = h('video', { autoplay: true, muted: true, playsinline: true, id: 'setup-cam' });
  v.muted = true;
  if (setup.cameraStream) { v.srcObject = setup.cameraStream; v.play().catch(() => {}); }
  if (setup.mode === 'camera') {
    v.className = 'cam-full';
    p.replaceChildren(setup.cameraStream ? v : h('div', { class: 'cam-off' }, setup.camMsg || 'Waiting for camera access…'));
  } else {
    const hint = h('div', { class: 'screen-hint', html: `${icon.screen}<span>You’ll pick a screen next</span>` });
    p.replaceChildren(hint);
    if (setup.mode === 'screen-camera') p.append(h('div', { class: 'bubble' }, setup.cameraStream ? v : null));
  }
}

async function acquireCamera() {
  if (!needsCamera()) return;
  stopStream('cameraStream');
  setup.camMsg = '';
  if (setup.el) renderPreview();
  const id = store.get('cameraId', '');
  try {
    setup.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: id ? { ideal: id } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (e) {
    setup.cameraStream = null;
    setup.camMsg = cameraError(e);
  }
  if (setup.el) renderPreview();
  else stopStream('cameraStream');
}

async function acquireMic() {
  if (!setup.micOn) return;
  stopStream('micStream');
  const id = store.get('micId', '');
  try {
    setup.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: id ? { ideal: id } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (e) {
    setup.micStream = null;
    if (setup.el) $('#setup-note', setup.el).textContent = 'No microphone access.';
  }
  if (!setup.el) return stopStream('micStream');
  startMeter();
}

function startMeter() {
  cancelAnimationFrame(setup.meterRaf);
  const bar = setup.el && $('#meter', setup.el);
  if (!bar || !setup.micStream || !setup.audioCtx) return;
  const ctx = setup.audioCtx;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const src = ctx.createMediaStreamSource(setup.micStream);
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Uint8Array(an.fftSize);
  const tick = () => {
    an.getByteTimeDomainData(buf);
    let peak = 0;
    for (const x of buf) peak = Math.max(peak, Math.abs(x - 128));
    bar.style.width = `${Math.min(100, (peak / 128) * 160)}%`;
    setup.meterRaf = requestAnimationFrame(tick);
  };
  tick();
}

async function fillDevices() {
  if (!setup.el) return;
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const fill = (sel, kind, stream, key) => {
    const list = devices.filter((d) => d.kind === kind);
    const current = stream && stream.getTracks()[0] && stream.getTracks()[0].getSettings().deviceId;
    sel.replaceChildren(...list.map((d, i) => h('option', { value: d.deviceId }, d.label || `${kind === 'videoinput' ? 'Camera' : 'Microphone'} ${i + 1}`)));
    if (!list.length) sel.append(h('option', { value: '' }, kind === 'videoinput' ? 'No camera' : 'No microphone'));
    sel.value = current || store.get(key, '') || (list[0] && list[0].deviceId) || '';
  };
  fill($('#cam-select', setup.el), 'videoinput', setup.cameraStream, 'cameraId');
  fill($('#mic-select', setup.el), 'audioinput', setup.micStream, 'micId');
}

function cameraError(e) {
  if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) return 'Camera blocked — allow it in the browser.';
  if (e && e.name === 'NotFoundError') return 'No camera found.';
  return 'Camera unavailable.';
}

function stopStream(key) {
  if (setup[key]) setup[key].getTracks().forEach((t) => t.stop());
  setup[key] = null;
}

function closeSetup({ keepStreams = false } = {}) {
  if (!setup.el) return;
  cancelAnimationFrame(setup.meterRaf);
  document.removeEventListener('keydown', escClose);
  setup.el.remove();
  setup.el = null;
  if (!keepStreams) { stopStream('cameraStream'); stopStream('micStream'); }
  if (setup.audioCtx) { setup.audioCtx.close().catch(() => {}); setup.audioCtx = null; }
}

// ---------------- recording ----------------

let current = null; // { session, bubble, ui }

function onStart() {
  if (setup.busy) return;
  const mode = setup.mode;
  if (mode !== 'screen' && !setup.cameraStream) return toast('Camera unavailable', { bad: true });
  setup.busy = true;
  // Screen-only: let the camera go (and its light off).
  if (mode === 'screen') { stopStream('cameraStream'); renderPreview(); }
  const session = new Session({
    mode,
    cameraStream: mode === 'screen' ? null : setup.cameraStream,
    micStream: setup.micOn ? setup.micStream : null,
  });
  // Both of these must start synchronously inside the click.
  const displayP = session.requestDisplay();
  let bubble = null, bubbleP = Promise.resolve(false);
  if (mode === 'screen-camera') {
    bubble = new Bubble(setup.cameraStream);
    bubbleP = bubble.open($('#setup-cam', setup.el));
  }
  run(session, bubble, displayP, bubbleP);
}

function setupCam() { return setup.el ? $('#setup-cam', setup.el) : null; }

async function run(session, bubble, displayP, bubbleP) {
  try {
    await displayP;
  } catch (e) {
    setup.busy = false;
    if (bubble) bubble.close();
    if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast('Couldn’t capture the screen', { bad: true });
    return;
  }
  let bubbleOpen = await bubbleP;
  try {
    await session.prepare();
  } catch (e) {
    setup.busy = false;
    session.releaseCapture();
    if (bubble) bubble.close();
    if (e.status === 401) { closeSetup(); return showSignin(); }
    return toast(e.message, { bad: true });
  }

  // Park the setup sheet off-screen rather than removing it: Safari's video PiP
  // closes if its <video> leaves the document.
  setup.el.style.cssText = 'position:fixed;left:-10000px;top:0;width:520px;opacity:0;pointer-events:none';
  setup.busy = false;
  document.removeEventListener('keydown', escClose);
  cancelAnimationFrame(setup.meterRaf);

  const ui = buildStage(session);
  current = { session, bubble, ui };
  window.addEventListener('beforeunload', guardUnload);

  // Safari can refuse the PiP request made alongside the screen picker; one more click opens it.
  if (bubble && !bubbleOpen) {
    bubbleOpen = await ui.askForBubble(() => bubble.open(setupCam()));
  }
  if (bubble) wireBubble(bubble, session);

  const go = await ui.countdown(3, bubble);
  if (!go || session.state !== 'ready') { if (current && current.session === session) await abandon(); return; }

  try { session.start(); }
  catch (e) { toast(e.message, { bad: true }); await abandon(); return; }
  ui.onStarted();
  // A few seconds in, he has usually switched to what he's showing — a better thumbnail
  // (and link preview) than Shuttle's own page.
  ui.thumbTimer = setTimeout(() => uploadThumb(session, ui), 3000);
}

function guardUnload(e) {
  if (current && ['ready', 'recording', 'paused', 'stopping', 'failed'].includes(current.session.state)) {
    e.preventDefault();
    e.returnValue = '';
  }
}

function wireBubble(bubble, session) {
  bubble.addEventListener('action', (e) => {
    const { action, doc } = e.detail;
    if (action === 'pause') session.pause();
    if (action === 'resume') session.resume();
    if (action === 'stop') finish(doc);
    if (action === 'cancel') discard(doc, { confirmed: true }); // the bubble asks twice itself
  });
  bubble.addEventListener('closed', () => current && current.ui.syncBubbleButton());
}

function buildStage(session) {
  const isCam = session.mode === 'camera';
  const stage = h('div', { class: 'stage' });
  const screenVideo = h('video', { autoplay: true, muted: true, playsinline: true });
  screenVideo.muted = true;
  const camVideo = h('video', { autoplay: true, muted: true, playsinline: true, class: 'mirror' });
  camVideo.muted = true;
  if (session.displayStream) { screenVideo.srcObject = session.displayStream; screenVideo.play().catch(() => {}); }
  if (session.cameraStream) { camVideo.srcObject = session.cameraStream; camVideo.play().catch(() => {}); }
  if (isCam) stage.append(camVideo);
  else {
    // The screen itself isn't shown (it would mirror into the recording); kept for the thumbnail.
    screenVideo.style.cssText = 'position:absolute;width:2px;height:2px;opacity:0;pointer-events:none';
    camVideo.style.cssText = 'position:absolute;width:2px;height:2px;opacity:0;pointer-events:none';
    stage.append(screenVideo, camVideo,
      h('div', { style: 'text-align:center;color:#c9c4dd;display:grid;gap:8px;justify-items:center' },
        h('div', { style: 'font-size:15px;font-weight:600;color:#fff' }, 'Recording your screen'),
        h('div', { style: 'font-size:13px' }, 'Switch to what you want to show.'),
      ));
  }
  const time = h('span', { class: 'time' }, '0:00');
  const up = h('span', { class: 'up' });
  const pauseBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Pause', 'aria-label': 'Pause', html: icon.pause, onclick: () => {
    if (session.state === 'recording') session.pause(); else if (session.state === 'paused') session.resume();
  } });
  const bubbleBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Float camera', 'aria-label': 'Float camera', html: icon.bubble, hidden: true, onclick: async () => {
    if (current && current.bubble && (await current.bubble.open(setupCam()))) syncBubbleButton();
  } });
  const bar = h('div', { class: 'recbar', role: 'toolbar', 'aria-label': 'Recording' },
    h('span', { class: 'dot' }), time, up, pauseBtn, bubbleBtn,
    h('button', { class: 'icon-btn', type: 'button', title: 'Delete', 'aria-label': 'Delete', html: icon.trash, onclick: () => discard(document) }),
    h('button', { class: 'stop', type: 'button', onclick: () => finish(document), html: `${icon.stop}Stop` }),
  );
  bar.hidden = true;
  document.body.append(stage, bar);

  function syncBubbleButton() {
    bubbleBtn.hidden = !(current && current.bubble && !current.bubble.isOpen && session.mode === 'screen-camera');
  }

  let interval = 0, heartbeat = 0;
  const cancelers = new Set(); // overlays that must go if the session ends under them

  session.addEventListener('state', () => {
    const paused = session.state === 'paused';
    bar.classList.toggle('paused', paused);
    pauseBtn.innerHTML = paused ? icon.play : icon.pause;
    pauseBtn.title = paused ? 'Resume' : 'Pause';
    if (current && current.bubble) current.bubble.setPaused(paused);
    if (!['recording', 'paused'].includes(session.state)) { clearInterval(interval); clearInterval(heartbeat); }
    // MediaRecorder died mid-recording: save what we have.
    if (session.state === 'failed' && session.failedWhile === 'recording' && !ui.finishing) salvage();
  });
  session.addEventListener('display-ended', () => {
    if (session.state === 'recording' || session.state === 'paused') finish(document);
    else if (session.state === 'ready') abandon();
  });
  session.addEventListener('progress', (e) => {
    const p = e.detail;
    const msg = p.failed ? 'Upload failed' : p.stalled ? 'Reconnecting…' : '';
    up.textContent = msg;
    if (current && current.bubble) current.bubble.setStatus(msg);
    if (ui.onProgress) ui.onProgress(p);
  });

  const ui = {
    stage, bar, screenVideo, camVideo, syncBubbleButton, finishing: null, thumbDone: false, thumbTimer: 0,
    onStarted() {
      bar.hidden = false;
      syncBubbleButton();
      interval = setInterval(() => {
        const t = fmtDuration(session.elapsed);
        if (time.textContent !== t) time.textContent = t;
        if (current && current.bubble) current.bubble.setTime(session.elapsed);
      }, 250);
      // Keeps the library from calling a long pause "Interrupted".
      heartbeat = setInterval(() => {
        fetch(`/api/videos/${session.video.id}/heartbeat`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      }, 30000);
    },
    countdown(n, bubble) {
      return new Promise((resolve) => {
        const span = h('span');
        const el = h('div', { class: 'countdown', title: 'Click to cancel', onclick: () => done(false) }, span);
        document.body.append(el);
        let i = n, timer;
        const done = (ok) => {
          clearTimeout(timer);
          el.remove();
          document.removeEventListener('keydown', onKey);
          cancelers.delete(done);
          if (bubble) bubble.countdown(0);
          resolve(ok);
        };
        cancelers.add(done);
        const onKey = (e) => { if (e.key === 'Escape') done(false); };
        document.addEventListener('keydown', onKey);
        const step = () => {
          if (i === 0) return done(true);
          span.textContent = String(i);
          span.style.animation = 'none'; void span.offsetWidth; span.style.animation = '';
          if (bubble) bubble.countdown(i);
          i -= 1;
          timer = setTimeout(step, 1000);
        };
        step();
      });
    },
    askForBubble(open) {
      return new Promise((resolve) => {
        const done = (ok) => { box.remove(); cancelers.delete(cancel); resolve(ok); };
        const cancel = () => done(false);
        const box = h('div', { class: 'countdown' },
          h('div', { style: 'display:grid;gap:14px;justify-items:center' },
            h('button', { class: 'btn btn-rec btn-lg', type: 'button', onclick: async () => {
              let ok = false;
              try { ok = await open(); } catch {}
              done(ok);
            }, html: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>Start recording` }),
            h('button', { class: 'btn btn-ghost', type: 'button', style: 'color:#fff', onclick: () => done(false) }, 'Without camera bubble'),
          ));
        cancelers.add(cancel);
        document.body.append(box);
      });
    },
    teardown() {
      clearInterval(interval);
      clearInterval(heartbeat);
      clearTimeout(ui.thumbTimer);
      for (const c of [...cancelers]) c(false);
      stage.remove();
      bar.remove();
      if (ui.finishing) ui.finishing.el.remove();
    },
  };
  return ui;
}

async function uploadThumb(session, ui) {
  if (ui.thumbDone) return;
  ui.thumbDone = true;
  try {
    const blob = await makeThumbnail({
      screenTrack: session.displayStream && session.displayStream.getVideoTracks()[0],
      cameraTrack: session.cameraStream && session.cameraStream.getVideoTracks()[0],
      screenVideo: ui.screenVideo, cameraVideo: ui.camVideo, mode: session.mode,
    });
    if (!blob || session.state === 'cancelled') return;
    await fetch(`/api/videos/${session.video.id}/thumb`, { method: 'PUT', body: blob, credentials: 'same-origin' });
  } catch {}
}

function finishingOverlay(session, ui, bubble) {
  ui.bar.hidden = true; // nothing behind the overlay stays reachable
  const label = h('div', { style: 'font-weight:600;max-width:340px' }, 'Finishing upload…');
  const spinner = h('div', { class: 'spinner' });
  const bar = h('div', { class: 'progress' }, h('i'));
  const extra = h('div', { style: 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap' },
    h('button', { class: 'btn', type: 'button', html: `${icon.download}Download copy`, onclick: () => downloadLocal(session) }));
  const el = h('div', { class: 'finishing', role: 'alertdialog', 'aria-label': 'Finishing upload' },
    h('div', { class: 'box' }, spinner, label, bar, extra));
  document.body.append(el);
  const f = {
    el,
    progress(p) {
      bar.firstChild.style.width = `${p.total ? Math.round((p.sent / p.total) * 100) : 0}%`;
      if (!f.done) label.textContent = p.stalled ? 'Waiting for connection…' : 'Finishing upload…';
      if (bubble) bubble.setDoneStatus(p.stalled ? 'Waiting for connection…' : `Uploading ${p.total ? Math.round((p.sent / p.total) * 100) : 0}%`);
    },
    failed() {
      f.done = true;
      spinner.remove();
      bar.remove();
      const err = session.error;
      label.textContent = `Upload failed${err ? `: ${err.message}` : ''}. Download a copy so it isn’t lost.`;
      if (bubble) bubble.setDoneStatus('Upload failed');
      // Retry only makes sense when every part made it and just the final step failed.
      if (session.allPartsUploaded) {
        const retry = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
          retry.disabled = true;
          label.textContent = 'Retrying…';
          try { await session.finalize(); leave(session, false); }
          catch (e) { retry.disabled = false; label.textContent = `Upload failed: ${e.message}. Download a copy so it isn’t lost.`; }
        } }, 'Retry');
        extra.append(retry);
      }
      extra.append(h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => {
        if (confirm('Leave without the recording?')) { window.removeEventListener('beforeunload', guardUnload); location.href = '/'; }
      } }, 'Close'));
    },
  };
  ui.onProgress = (p) => f.progress(p);
  ui.finishing = f;
  return f;
}

async function finish(doc) {
  if (!current) return;
  const { session, bubble, ui } = current;
  if (session.state !== 'recording' && session.state !== 'paused') return;
  const url = session.video.shareUrl;
  // Copy while we still hold the click.
  const copiedP = copyText(url, doc || document);
  // Short recording: grab the thumbnail before the screen track is released.
  if (!ui.thumbDone) { clearTimeout(ui.thumbTimer); uploadThumb(session, ui); await new Promise((r) => setTimeout(r, 120)); }
  const stopP = session.stop().catch(() => null);
  const f = finishingOverlay(session, ui, bubble);
  const copied = await copiedP;
  if (bubble) bubble.showDone(url, { copied, onCopy: (d) => copyText(url, d) });
  const done = await stopP;
  if (!done) return f.failed();
  if (bubble) bubble.setDoneStatus('Ready');
  leave(session, copied);
}

async function salvage() {
  if (!current) return;
  const { session, bubble, ui } = current;
  const f = finishingOverlay(session, ui, bubble);
  toast('Recording stopped unexpectedly — saving it', { bad: true, ms: 4000 });
  try { await session.finalize(); leave(session, false); }
  catch { f.failed(); }
}

function leave(session, copied) {
  window.removeEventListener('beforeunload', guardUnload);
  if (current && current.bubble) setTimeout(() => current && current.bubble && current.bubble.close(), 4000);
  closeSetup();
  location.href = `/v/${session.video.id}?new=1${copied ? '&copied=1' : ''}`;
}

function downloadLocal(session) {
  const blob = session.localBlob();
  if (!blob.size) return toast('Nothing was recorded', { bad: true });
  const a = h('a', { href: URL.createObjectURL(blob), download: `shuttle-${session.video.id}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function discard(doc, { confirmed = false } = {}) {
  if (!current) return;
  const { session } = current;
  if (!['ready', 'recording', 'paused'].includes(session.state)) return;
  if (!confirmed) {
    const wasRecording = session.state === 'recording';
    if (wasRecording) session.pause();
    const ok = confirm('Delete this recording?');
    if (!ok) { if (wasRecording) session.resume(); return; }
  }
  await abandon();
  toast('Deleted');
}

async function abandon() {
  if (!current) { closeSetup(); return; }
  const { session, bubble, ui } = current;
  current = null;
  window.removeEventListener('beforeunload', guardUnload);
  if (bubble) bubble.close();
  ui.teardown();
  closeSetup();
  await session.cancel();
  renderLibrary();
}
