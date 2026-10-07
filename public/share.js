import { $, h, icon, toast, api, fmtDuration, copyText } from './ui.js';

const { video: v, owner } = window.__SHUTTLE__;
const shareUrl = `${location.origin}/v/${v.id}`;
const params = new URLSearchParams(location.search);
if (params.has('new')) history.replaceState(null, '', `/v/${v.id}`);

const player = $('#player');

// ---------- meta line ----------
function renderSub(durationMs) {
  const parts = [new Date(v.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })];
  if (durationMs) parts.push(fmtDuration(durationMs));
  if (owner) parts.push(`${v.views} view${v.views === 1 ? '' : 's'}`);
  $('#sub').textContent = parts.join(' · ');
}
renderSub(v.durationMs);

// ---------- actions ----------
const actions = $('#actions');
const copyBtn = h('button', { class: 'btn btn-primary', type: 'button', html: `${icon.link}Copy link`, onclick: async () => {
  toast((await copyText(shareUrl)) ? 'Link copied' : 'Couldn’t copy', {});
} });
actions.append(copyBtn);

if (navigator.share && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
  actions.append(h('button', { class: 'btn', type: 'button', html: `${icon.share}Share`, onclick: () => navigator.share({ title: v.title, url: shareUrl }).catch(() => {}) }));
}

if (player) {
  const speeds = [1, 1.25, 1.5, 2];
  const saved = Number(localStorage.getItem('shuttle.speed')) || 1;
  const seg = h('div', { class: 'speed', role: 'group', 'aria-label': 'Playback speed' },
    ...speeds.map((s) => h('button', { type: 'button', 'aria-pressed': String(s === saved), onclick: (e) => setSpeed(s, e.currentTarget) }, `${s}×`)));
  function setSpeed(s, btn) {
    player.playbackRate = s;
    player.defaultPlaybackRate = s;
    localStorage.setItem('shuttle.speed', String(s));
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  }
  player.playbackRate = saved;
  player.defaultPlaybackRate = saved;
  actions.append(seg);
  actions.append(h('a', { class: 'btn', href: `/raw/${v.id}?download=1`, html: `${icon.download}Download` }));
}

if (owner) {
  actions.append(h('span', { class: 'spacer' }));
  actions.append(h('button', { class: 'btn btn-ghost btn-danger', type: 'button', html: `${icon.trash}Delete`, onclick: async () => {
    if (!confirm('Delete this video? The link will stop working.')) return;
    try { await api(`/api/videos/${v.id}`, { method: 'DELETE' }); location.href = '/'; }
    catch (e) { toast(e.message, { bad: true }); }
  } }));
  $('#top-actions').append(h('a', { class: 'btn', href: '/' }, 'Library'));

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
      document.title = `${out.title} · Shuttle`;
      toast('Renamed');
    } catch (e) { title.textContent = before; toast(e.message, { bad: true }); }
  });
}

if (params.has('new')) {
  if (params.has('copied')) toast('Link copied');
  else copyBtn.focus();
}

// ---------- player ----------
if (player) {
  // MediaRecorder files often carry no duration; force the browser to find it so the scrubber works.
  const fixDuration = () => {
    if (player.duration === Infinity || Number.isNaN(player.duration)) {
      const restore = () => {
        if (player.duration === Infinity) return;
        player.removeEventListener('durationchange', restore);
        player.currentTime = 0;
      };
      player.addEventListener('durationchange', restore);
      try { player.currentTime = 1e101; } catch {}
    } else if (!v.durationMs && player.duration) {
      renderSub(player.duration * 1000);
    }
  };
  player.addEventListener('loadedmetadata', fixDuration);

  let counted = false;
  player.addEventListener('play', () => {
    if (counted) return;
    counted = true;
    fetch(`/api/videos/${v.id}/view`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.isContentEditable || /INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName)) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); player.paused ? player.play() : player.pause(); }
    else if (e.key === 'ArrowRight' || e.key === 'l') player.currentTime = Math.min(player.duration || 1e9, player.currentTime + 5);
    else if (e.key === 'ArrowLeft' || e.key === 'j') player.currentTime = Math.max(0, player.currentTime - 5);
    else if (e.key === 'f') { (player.requestFullscreen || player.webkitEnterFullscreen || (() => {})).call(player); }
  });
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
