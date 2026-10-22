// Server-rendered share page: real <title> and Open Graph tags so a pasted link unfurls
// (iMessage, Slack, LinkedIn) with the preview image and title. The player itself is
// built client-side (public/share.js + public/player.js).

import { editedDuration, withTrim } from '../public/timeline.js';

export function renderSharePage(v, { owner, origin, ownerName }) {
  const page = `${origin}/v/${v.id}`;
  // Versioned by layout and by the last change: unfurlers cache images by URL, the Screen
  // layout's preview has no face, and a start trim takes the picture again.
  const ogImage = `${origin}/thumb/${v.id}/og.jpg?l=${v.layout && v.layout.kind === 'screen' ? 's' : 'c'}${v.rev ? `&v=${v.rev}` : ''}`;
  const ready = v.status === 'ready';
  const d = (v.durationMs || 0) / 1000;
  const dur = d ? fmtDuration(editedDuration(withTrim(v.cuts, v.trim, d), d) * 1000) : '';
  const desc = v.description ? v.description.slice(0, 200) : [ownerName, dur].filter(Boolean).join(' · ');
  const data = JSON.stringify({ video: v, owner, ownerName }).replace(/</g, '\\u003c');
  const avatar = v.hasCamThumb && v.hasCam ? `/thumb/${v.id}/cam.jpg` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(v.title)}${ownerName ? ` · ${esc(ownerName)}` : ''}</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="#fcfaf6">
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="video.other">
<meta property="og:title" content="${esc(v.title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(page)}">
<meta property="og:site_name" content="${esc(ownerName || 'Shuttle')}">
${v.hasThumb || v.hasOg ? `<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:image:width" content="1280">
<meta property="og:image:height" content="720">
<meta name="twitter:image" content="${esc(ogImage)}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(v.title)}">
<link rel="alternate" type="application/json+oembed" href="${esc(`${origin}/oembed?format=json&url=${encodeURIComponent(page)}`)}" title="${esc(v.title)}">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.bunny.net"><link rel="stylesheet" href="https://fonts.bunny.net/css?family=fira-sans:500,600,700|noto-sans:400,700|jetbrains-mono:400,500&display=swap">
<link rel="stylesheet" href="/styles.css">
</head>
<body class="share">
<header class="topbar">
  <a class="brand" href="/" aria-label="Shuttle"><span class="brand-mark"></span>Shuttle</a>
  <div class="topbar-actions" id="top-actions"></div>
</header>
<main class="share-main">
  <section class="share-head">
    <div class="byline">
      ${avatar ? `<img class="avatar" src="${avatar}" alt="">` : `<span class="avatar avatar-blank"></span>`}
      <div class="byline-text">
        <span class="who">${esc(ownerName || 'Shuttle')}</span>
        <span class="when" id="when">${dur ? esc(dur) : ''}</span>
      </div>
    </div>
    <h1 id="title" class="title">${esc(v.title)}</h1>
    <p id="description" class="description"${v.description ? '' : ' hidden'}>${esc(v.description)}</p>
  </section>
  <div class="player-host" id="player-host">
    ${ready ? '' : `<div class="player-pending" id="pending">${v.status === 'unavailable' ? '' : '<div class="spinner"></div>'}<p>${v.status === 'updating' ? 'Updating this video…' : v.status === 'unavailable' ? 'This video isn’t available right now.' : 'Finishing upload…'}</p></div>`}
  </div>
  <section class="share-actions" id="actions"></section>
  <section class="owner-panel" id="owner-panel" hidden></section>
  <section class="transcript-card" id="transcript" hidden></section>
</main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script type="application/json" id="shuttle-data">${data}</script>
<script src="/share.js" type="module"></script>
</body>
</html>`;
}

// The player alone, for an <iframe> on another site (a Ghost post, say). Always rendered for a
// viewer: an embed is the share link in another frame, and nothing on it edits the video.
export function renderEmbedPage(v, { origin, ownerName }) {
  const data = JSON.stringify({ video: v, ownerName }).replace(/</g, '\\u003c');
  const ready = v.status === 'ready';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(v.title)}${ownerName ? ` · ${esc(ownerName)}` : ''}</title>
<meta name="robots" content="noindex">
${v.status === 'updating' ? '<meta http-equiv="refresh" content="15">' : ''}
<link rel="canonical" href="${esc(`${origin}/v/${v.id}`)}">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.bunny.net"><link rel="stylesheet" href="https://fonts.bunny.net/css?family=fira-sans:500,600,700|noto-sans:400,700|jetbrains-mono:400,500&display=swap">
<link rel="stylesheet" href="/styles.css">
</head>
<body class="embed">
<div class="player-host" id="player-host">
  ${ready ? '' : `<div class="player-pending"><p>${v.status === 'updating' ? 'This video is being updated. It will be back in a moment.' : v.status === 'unavailable' ? 'This video isn’t available right now.' : 'This video is still uploading.'}</p></div>`}
</div>
<script type="application/json" id="shuttle-data">${data}</script>
${ready ? '<script src="/embed.js" type="module"></script>' : ''}
</body>
</html>`;
}

export function renderNotFound() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found · Shuttle</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/styles.css"></head>
<body class="share"><header class="topbar"><a class="brand" href="/"><span class="brand-mark"></span>Shuttle</a></header>
<main class="empty-state"><h1>This video isn’t here</h1><p>It may have been deleted.</p></main></body></html>`;
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
