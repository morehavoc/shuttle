import { $, h, icon, toast, api, fmtDuration, copyText } from './ui.js';
import { Player } from './player.js';
import {
  normalizeCuts, addCut, removeCut, wordRange, isWordCut, fillerCuts, pauseCuts, paragraphs, editedDuration, toEdited,
} from './timeline.js';

const { video: v, owner, ownerName } = JSON.parse(document.getElementById('shuttle-data').textContent);
const shareUrl = `${location.origin}/v/${v.id}`;
const params = new URLSearchParams(location.search);
if (params.has('new')) history.replaceState(null, '', `/v/${v.id}`);

let player = null;
let words = [];
let cuts = normalizeCuts(v.cuts || []);
const duration = () => (player && player.duration) || (v.durationMs || 0) / 1000;

// ---------- byline ----------
function renderWhen() {
  const date = new Date(v.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const d = duration();
  const len = d ? fmtDuration(editedDuration(cuts, d) * 1000) : '';
  $('#when').textContent = [date, len].filter(Boolean).join(' · ');
}
renderWhen();

// ---------- actions ----------
const actions = $('#actions');
const copyBtn = h('button', { class: 'btn btn-primary', type: 'button', html: `${icon.link}Copy link`, onclick: async () => {
  toast((await copyText(shareUrl)) ? 'Link copied' : 'Couldn’t copy', {});
} });
actions.append(copyBtn);
if (navigator.share && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
  actions.append(h('button', { class: 'btn', type: 'button', html: `${icon.share}Share`, onclick: () => navigator.share({ title: v.title, url: shareUrl }).catch(() => {}) }));
}

if (owner) {
  $('#top-actions').append(h('a', { class: 'btn', href: '/' }, 'Library'));
  if (v.status === 'ready') {
    const dl = h('div', { class: 'menu-wrap' });
    const menu = h('div', { class: 'menu', hidden: true },
      v.hasCam ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); menu.hidden = true; exportTogether(); } }, 'Screen and camera together') : null,
      h('a', { href: `/raw/${v.id}?download=1` }, v.hasCam ? 'Screen and audio' : 'Video'),
      v.hasCam ? h('a', { href: `/raw/${v.id}/cam?download=1` }, 'Camera only (no sound)') : null,
      !v.hasCam ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); menu.hidden = true; exportTogether(); } }, 'With your edits') : null);
    const btn = h('button', { class: 'btn', type: 'button', html: `${icon.download}Download`, onclick: (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; } });
    document.addEventListener('click', () => { menu.hidden = true; });
    dl.append(btn, menu);
    actions.append(dl);
  }
  actions.append(h('span', { class: 'spacer' }));
  actions.append(h('button', { class: 'btn btn-ghost btn-danger', type: 'button', html: `${icon.trash}Delete`, onclick: async () => {
    if (!confirm('Delete this video? The link will stop working.')) return;
    try { await api(`/api/videos/${v.id}`, { method: 'DELETE' }); location.href = '/'; }
    catch (e) { toast(e.message, { bad: true }); }
  } }));

  // Rename in place.
  const title = $('#title');
  title.contentEditable = 'true';
  title.spellcheck = false;
  title.title = 'Rename';
  let before = title.textContent;
  title.addEventListener('focus', () => { before = title.textContent; });
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
    if (e.key === 'Escape') { title.textContent = before; title.blur(); }
  });
  title.addEventListener('blur', async () => {
    const next = title.textContent.replace(/\s+/g, ' ').trim();
    if (!next) { title.textContent = before; return; }
    if (next === before) return;
    try {
      const out = await api(`/api/videos/${v.id}`, { method: 'PATCH', body: { title: next } });
      title.textContent = out.title;
      document.title = `${out.title}${ownerName ? ` · ${ownerName}` : ''}`;
      toast('Renamed');
    } catch (e) { title.textContent = before; toast(e.message, { bad: true }); }
  });
}

// ---------- description ----------
const descEl = $('#description');
function showDescription(text) {
  if (document.activeElement === descEl) return;
  descEl.textContent = text || '';
  descEl.hidden = !owner && !text;
}
if (owner) {
  descEl.hidden = false;
  descEl.contentEditable = 'plaintext-only';
  if (descEl.contentEditable !== 'plaintext-only') descEl.contentEditable = 'true';
  descEl.dataset.placeholder = 'Add a description';
  descEl.spellcheck = true;
  let before = descEl.textContent;
  descEl.addEventListener('focus', () => { before = descEl.textContent; });
  descEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); descEl.blur(); }
    if (e.key === 'Escape') { descEl.textContent = before; descEl.blur(); }
  });
  descEl.addEventListener('blur', async () => {
    const next = descEl.innerText.replace(/[ \t]+/g, ' ').trim();
    if (next === before.trim()) return;
    try {
      const out = await api(`/api/videos/${v.id}`, { method: 'PATCH', body: { description: next } });
      v.description = out.description;
      descEl.textContent = out.description;
      toast('Saved');
    } catch (e) { descEl.textContent = before; toast(e.message, { bad: true }); }
  });
  const write = h('button', { class: 'linkish desc-write', type: 'button', onclick: async () => {
    write.disabled = true; write.textContent = 'Writing…';
    try {
      const out = await api(`/api/videos/${v.id}/describe`, { method: 'POST' });
      applyVideo(out);
    } catch (e) { toast(e.message, { bad: true }); }
    write.disabled = false; write.textContent = 'Write one for me';
  } }, 'Write one for me');
  write.hidden = v.status !== 'ready';
  descEl.after(write);
}

// New title / description from the server (the auto draft lands after the transcript).
function applyVideo(out) {
  if (out.title && document.activeElement !== $('#title')) {
    $('#title').textContent = out.title;
    document.title = `${out.title}${ownerName ? ` · ${ownerName}` : ''}`;
  }
  v.description = out.description || '';
  showDescription(v.description);
}

// One file with the camera over the screen, as the page shows it (layout, edits), made by
// playing the video through once here.
async function exportTogether() {
  const { exportComposite } = await import('./export.js');
  const ctrl = new AbortController();
  const bar = h('div', { class: 'progress' }, h('i'));
  const label = h('div', { style: 'font-weight:600' }, 'Making your video… 0%');
  const box = h('div', { class: 'finishing', role: 'alertdialog', 'aria-label': 'Making your video' },
    h('div', { class: 'box' }, label, bar,
      h('div', { class: 'muted', style: 'font-size:13px;max-width:320px' }, 'It plays through once, so this takes as long as the video. Keep this tab in front.'),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => ctrl.abort() }, 'Cancel')));
  document.body.append(box);
  player.pause();
  try {
    const blob = await exportComposite({ ...v, cuts }, {
      layout: player.layout, ownerName, signal: ctrl.signal,
      onProgress: (p) => { const pc = Math.round(p * 100); label.textContent = `Making your video… ${pc}%`; bar.firstChild.style.width = `${pc}%`; },
    });
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    const name = ($('#title').textContent || 'video').replace(/[^\w\- .]+/g, '').trim().slice(0, 80) || 'video';
    const a = h('a', { href: URL.createObjectURL(blob), download: `${name}.${ext}` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 120000);
    toast('Downloaded');
  } catch (e) {
    if (e.name !== 'AbortError') toast(`Couldn’t make the video: ${e.message}`, { bad: true });
  } finally { box.remove(); }
}

if (params.has('new')) {
  if (params.has('copied')) toast('Link copied');
  else copyBtn.focus();
}

// ---------- owner: layout ----------
const LAYOUTS = [
  { kind: 'bubble', label: 'Bubble' },
  { kind: 'card', label: 'Card' },
  { kind: 'side', label: 'Side' },
  { kind: 'screen', label: 'Screen' },
];

function ownerPanel() {
  const panel = $('#owner-panel');
  const parts = [];
  if (v.camMutedMs > 2000) {
    parts.push(h('div', { class: 'notice' },
      `The camera stopped for ${fmtDuration(v.camMutedMs)} of this recording.`));
  }
  if (v.hasCam && v.mode === 'screen-camera') {
    let layout = { kind: 'bubble', corner: 'bl', size: 'm', ...(v.layout || {}) };
    const save = async () => {
      player.setLayout(layout);
      sync();
      try {
        await api(`/api/videos/${v.id}`, { method: 'PATCH', body: { layout } });
        localStorage.setItem('shuttle.layout', JSON.stringify(layout)); // the next recording starts here
      } catch (e) { toast(e.message, { bad: true }); }
    };
    const kinds = h('div', { class: 'seg seg-inline', role: 'group', 'aria-label': 'Layout' },
      ...LAYOUTS.map((l) => h('button', { type: 'button', 'data-kind': l.kind, onclick: () => { layout = { ...layout, kind: l.kind }; save(); } }, l.label)));
    const corners = h('div', { class: 'corners', role: 'group', 'aria-label': 'Corner' },
      ...['tl', 'tr', 'bl', 'br'].map((c) => h('button', { type: 'button', 'data-corner': c, 'aria-label': { tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right' }[c], onclick: () => { layout = { ...layout, corner: c }; save(); } }, h('i'))));
    const sizes = h('div', { class: 'seg seg-inline seg-small', role: 'group', 'aria-label': 'Size' },
      ...['s', 'm', 'l'].map((s) => h('button', { type: 'button', 'data-size': s, onclick: () => { layout = { ...layout, size: s }; save(); } }, s.toUpperCase())));
    const sync = () => {
      kinds.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === layout.kind)));
      corners.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.corner === layout.corner)));
      sizes.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.size === layout.size)));
      const placed = layout.kind === 'bubble' || layout.kind === 'card';
      corners.hidden = !placed;
      sizes.hidden = !placed;
    };
    sync();
    parts.push(h('div', { class: 'layout-row' }, h('span', { class: 'row-label' }, 'Layout'), kinds, corners, sizes));
  }
  parts.push(keepRow());
  if (parts.length) { panel.replaceChildren(...parts); panel.hidden = false; }
}

const KEEP = [{ d: 7, label: '7 days' }, { d: 30, label: '30 days' }, { d: 90, label: '90 days' }, { d: 'forever', label: 'Forever' }];
function keepRow() {
  const note = h('span', { class: 'row-note' });
  const seg = h('div', { class: 'seg seg-inline', role: 'group', 'aria-label': 'Keep for' },
    ...KEEP.map((k) => h('button', { type: 'button', 'data-keep': String(k.d), onclick: () => save(k.d) }, k.label)));
  const sync = () => {
    note.textContent = v.expiresAt ? `Deletes ${new Date(v.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : 'Kept until you delete it';
    const days = v.expiresAt ? Math.round((v.expiresAt - Date.now()) / 864e5) : 'forever';
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.keep === String(days))));
  };
  async function save(d) {
    try {
      const out = await api(`/api/videos/${v.id}`, { method: 'PATCH', body: { keepDays: d } });
      v.expiresAt = out.expiresAt;
      localStorage.setItem('shuttle.keepDays', JSON.stringify(d)); // the next recording starts here
      sync();
    } catch (e) { toast(e.message, { bad: true }); }
  }
  sync();
  return h('div', { class: 'layout-row' }, h('span', { class: 'row-label' }, 'Keep'), seg, note);
}

// ---------- transcript ----------
const card = $('#transcript');
let editing = false;
let undoStack = [];
let saveTimer = 0;
let wordEls = [];
let activeIdx = -1;
let toRetry = 0; // chunks the last transcript load said could be tried again

async function loadTranscript() {
  let t;
  for (let i = 0; i < 90; i++) {
    try { t = await api(`/api/videos/${v.id}/transcript`); } catch { return; }
    if (t.status !== 'pending') break;
    renderTranscriptShell('pending');
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!t || t.status === 'none') {
    if (owner && v.tapGapMs > 3000) renderTranscriptShell('missed');
    return;
  }
  if (t.status === 'off') { if (owner) renderTranscriptShell('off'); return; }
  words = t.words || [];
  player.setWords(words);
  renderTranscript(t);
  if (owner && !v.description && (v.descriptionSource === '' || v.descriptionSource === 'working')) watchForDraft();
}

function renderTranscriptShell(state) {
  card.hidden = false;
  const msg = state === 'pending' ? 'Transcribing…'
    : state === 'missed' ? 'No transcript: the browser didn’t pass the audio to Shuttle while recording.'
    : 'Transcripts aren’t set up on this server. The audio is kept, so this one can be transcribed later.';
  card.replaceChildren(h('div', { class: 'tc-head' }, h('h2', {}, 'Transcript')), h('p', { class: 'muted tc-msg' }, msg));
}

function renderTranscript(t) {
  card.hidden = false;
  toRetry = t.failed || 0;
  const head = h('div', { class: 'tc-head' }, h('h2', {}, 'Transcript'));
  const tools = h('div', { class: 'tc-tools' });
  head.append(tools);
  const body = h('div', { class: 'tc-body', id: 'tc-body' });
  const children = [head];
  if (owner) {
    const retry = (label) => h('button', { class: 'linkish', type: 'button', onclick: retryTranscript }, label);
    if (t.status === 'partial' && t.failed && !words.length) children.push(h('div', { class: 'notice' }, 'Not transcribed yet. ', retry('Transcribe')));
    else if (t.status === 'partial' && t.failed) children.push(h('div', { class: 'notice' }, 'Part of the transcript didn’t come through. ', retry('Retry')));
    else if (t.missing || v.tapGapMs > 3000) children.push(h('div', { class: 'notice' }, 'Some audio didn’t reach the transcript, so it has gaps.'));
  }
  if (!words.length) children.push(h('p', { class: 'muted tc-msg' }, 'No speech.'));
  children.push(body);
  card.replaceChildren(...children);
  if (owner && words.length) renderEditTools(tools);
  renderWords();
}

function renderWords() {
  const body = $('#tc-body');
  if (!body) return;
  wordEls = [];
  const visible = owner ? words.map((w, i) => i) : words.map((w, i) => i).filter((i) => !isWordCut(words[i], cuts));
  const paras = paragraphs(visible.map((i) => words[i]));
  body.replaceChildren(...paras.map((idxs) => {
    const first = words[visible[idxs[0]]];
    const p = h('p', { class: 'tc-p' }, h('button', { class: 'tc-ts', type: 'button', onclick: () => player.seekSource(first.s) }, fmtDuration(Math.max(0, toEdited(first.s, cuts)) * 1000)));
    for (const k of idxs) {
      const i = visible[k];
      const w = words[i];
      const span = h('span', { class: 'w', 'data-i': String(i) }, w.w);
      if (isWordCut(w, cuts)) span.classList.add('cut');
      wordEls[i] = span;
      p.append(span, ' ');
    }
    return p;
  }));
  body.classList.toggle('editing', editing);
}

// The description is drafted a few seconds after the last transcript chunk; pick it up.
async function watchForDraft() {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    let out;
    try { out = await api(`/api/videos/${v.id}`); } catch { return; }
    if (out.description || out.descriptionSource === 'owner') { applyVideo(out); return; }
  }
}

// Click a word to jump there (outside edit selections).
card.addEventListener('click', (e) => {
  const span = e.target.closest('.w');
  if (!span || !player) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  const w = words[Number(span.dataset.i)];
  if (w) player.seekSource(w.s);
});

// Highlight the word being spoken.
function followPlayback() {
  if (!player) return;
  player.addEventListener('time', (e) => {
    const t = e.detail.source;
    let idx = -1;
    for (let i = 0; i < words.length; i++) { if (words[i].s <= t + 0.05) idx = i; else break; }
    if (idx === activeIdx) return;
    if (wordEls[activeIdx]) wordEls[activeIdx].classList.remove('now');
    activeIdx = idx;
    if (wordEls[idx]) wordEls[idx].classList.add('now');
  });
}
// ---------- owner: transcript editing ----------
function renderEditTools(tools) {
  const editBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => setEditing(!editing) }, 'Edit');
  const extra = h('div', { class: 'tc-edit-tools', hidden: true },
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => apply(addAll(fillerCuts(words, duration())), 'Filler words removed') }, 'Remove ums'),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => apply(addAll(pauseCuts(words, cuts, duration())), 'Pauses shortened') }, 'Shorten pauses'),
    h('button', { class: 'btn btn-sm', type: 'button', id: 'undo', onclick: undo, disabled: true }, 'Undo'),
    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => apply([], 'All edits removed') }, 'Restore all'),
  );
  tools.append(extra, editBtn);
  function setEditing(on) {
    editing = on;
    editBtn.textContent = on ? 'Done' : 'Edit';
    editBtn.classList.toggle('btn-primary', on);
    extra.hidden = !on;
    $('#tc-body').classList.toggle('editing', on);
    if (!on) hideSelTools();
  }
}

function addAll(ranges) {
  let c = cuts;
  for (const r of ranges) c = addCut(c, r, duration());
  return c;
}

function apply(next, message, { record = true } = {}) {
  if (record) {
    undoStack.push(cuts);
    if (undoStack.length > 100) undoStack.shift();
  }
  cuts = normalizeCuts(next, duration());
  player.setCuts(cuts);
  for (let i = 0; i < words.length; i++) if (wordEls[i]) wordEls[i].classList.toggle('cut', isWordCut(words[i], cuts));
  const undoBtn = $('#undo');
  if (undoBtn) undoBtn.disabled = !undoStack.length;
  renderWhen();
  if (message) toast(message);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

function undo() {
  if (!undoStack.length) return;
  apply(undoStack.pop(), 'Undone', { record: false });
}

async function save() {
  try { await api(`/api/videos/${v.id}`, { method: 'PATCH', body: { cuts } }); }
  catch (e) { toast(`Not saved: ${e.message}`, { bad: true }); }
}

// One pass over the chunks that need it (the server hands out four at a time, least recently
// tried first), then show what came of it.
async function retryTranscript(e) {
  if (e && e.target) { e.target.disabled = true; e.target.textContent = 'Working…'; }
  const rounds = Math.min(30, Math.max(1, Math.ceil(toRetry / 4)));
  for (let i = 0; i < rounds; i++) {
    let r;
    try { r = await api(`/api/videos/${v.id}/transcript/retry`, { method: 'POST' }); } catch (err) { toast(err.message, { bad: true }); break; }
    if (!r.retried || r.status === 'ready') break;
  }
  loadTranscript();
}

// Selected words → [i, j] indices, or null.
function selectedRange() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const body = $('#tc-body');
  if (!body) return null;
  const range = sel.getRangeAt(0);
  if (!body.contains(range.commonAncestorContainer)) return null;
  const idx = [];
  body.querySelectorAll('.w').forEach((el) => { if (range.intersectsNode(el)) idx.push(Number(el.dataset.i)); });
  if (!idx.length) return null;
  return [Math.min(...idx), Math.max(...idx)];
}

let selTools = null;
let selectionTimer = 0;
function hideSelTools() { if (selTools) { selTools.remove(); selTools = null; } }

document.addEventListener('selectionchange', () => {
  if (!editing) return;
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(showSelTools, 120);
});

function showSelTools() {
  hideSelTools();
  const r = selectedRange();
  if (!r) return;
  const [i, j] = r;
  const anyKept = words.slice(i, j + 1).some((w) => !isWordCut(w, cuts));
  const anyCut = words.slice(i, j + 1).some((w) => isWordCut(w, cuts));
  const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
  selTools = h('div', { class: 'sel-tools' },
    anyKept ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', onmousedown: (e) => e.preventDefault(), onclick: () => cutSel(i, j) }, 'Cut') : null,
    anyCut ? h('button', { class: 'btn btn-sm', type: 'button', onmousedown: (e) => e.preventDefault(), onclick: () => restoreSel(i, j) }, 'Restore') : null,
  );
  document.body.append(selTools);
  const tw = selTools.offsetWidth;
  selTools.style.left = `${Math.max(8, Math.min(window.innerWidth - tw - 8, rect.left + rect.width / 2 - tw / 2 + window.scrollX))}px`;
  selTools.style.top = `${rect.top + window.scrollY - selTools.offsetHeight - 8}px`;
}

function cutSel(i, j) {
  apply(addCut(cuts, wordRange(words, i, j, duration()), duration()));
  window.getSelection().removeAllRanges();
  hideSelTools();
}

function restoreSel(i, j) {
  apply(removeCut(cuts, wordRange(words, i, j, duration()), duration()));
  window.getSelection().removeAllRanges();
  hideSelTools();
}

document.addEventListener('keydown', (e) => {
  if (!editing) return;
  if ((e.key === 'Backspace' || e.key === 'Delete') && selectedRange()) {
    e.preventDefault();
    const [i, j] = selectedRange();
    cutSel(i, j);
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    undo();
  }
});

// Player shortcuts work anywhere on the page that isn't a text field.
document.addEventListener('keydown', (e) => {
  if (!player || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t !== document.body && !(t.closest && t.closest('.sp, .tc-body'))) return;
  if (t.closest && t.closest('.sp')) return; // the player handles its own keys
  if (editing && (e.key === 'Backspace' || e.key === 'Delete')) return;
  player.onKey(e);
});

// ---------- player (started last, once everything above is defined) ----------
function init() {
if (v.status === 'ready') {
  player = new Player($('#player-host'), { video: v, ownerName, owner });
  let counted = owner;
  player.addEventListener('play', () => {
    if (counted) return;
    counted = true;
    fetch(`/api/videos/${v.id}/view`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  });
  player.main.addEventListener('loadedmetadata', renderWhen);
  if (owner) ownerPanel();
  loadTranscript();
} else {
  // Still uploading: wait, then reload into the player.
  const started = Date.now();
  const poll = async () => {
    if (Date.now() - started > 15 * 60e3) { $('#pending').innerHTML = '<p>This recording didn’t finish.</p>'; return; }
    try {
      const s = await api(`/api/videos/${v.id}/status`);
      if (s.status === 'ready') return location.reload();
    } catch (e) {
      if (e.status === 404) { $('#pending').innerHTML = '<p>This video was deleted.</p>'; return; }
    }
    setTimeout(poll, 2000);
  };
  setTimeout(poll, 1500);
}
}

init();
followPlayback();
