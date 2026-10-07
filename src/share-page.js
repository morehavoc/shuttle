// Server-rendered share page: real <title> and Open Graph tags so a pasted link unfurls
// (iMessage, Slack, LinkedIn) with the thumbnail and title.

export function renderSharePage(v, { owner, origin }) {
  const page = `${origin}/v/${v.id}`;
  const thumb = `${origin}/thumb/${v.id}.jpg`;
  const raw = `${origin}/raw/${v.id}`;
  const ready = v.status === 'ready';
  const data = JSON.stringify({ video: v, owner }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(v.title)} · Shuttle</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="#121117">
<meta property="og:type" content="video.other">
<meta property="og:title" content="${esc(v.title)}">
<meta property="og:url" content="${esc(page)}">
<meta property="og:site_name" content="Shuttle">
${v.hasThumb ? `<meta property="og:image" content="${esc(thumb)}">
<meta property="og:image:width" content="1280">
<meta property="og:image:height" content="720">` : ''}
${ready ? `<meta property="og:video" content="${esc(raw)}">
<meta property="og:video:secure_url" content="${esc(raw)}">
<meta property="og:video:type" content="${esc(v.mime)}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(v.title)}">
${v.hasThumb ? `<meta name="twitter:image" content="${esc(thumb)}">` : ''}
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
</head>
<body class="share">
<header class="topbar">
  <a class="brand" href="/" aria-label="Shuttle"><span class="brand-mark"></span>Shuttle</a>
  <div class="topbar-actions" id="top-actions"></div>
</header>
<main class="share-main">
  <div class="player-wrap" id="player-wrap">
    ${ready
      ? `<video id="player" class="player" controls playsinline preload="metadata" ${v.hasThumb ? `poster="/thumb/${v.id}.jpg"` : ''}><source src="/raw/${v.id}" type="${esc(v.mime)}"></video>`
      : `<div class="player player-pending" id="pending"><div class="spinner"></div><p>Finishing upload…</p></div>`}
  </div>
  <section class="share-meta">
    <div class="title-row">
      <h1 id="title" class="title">${esc(v.title)}</h1>
    </div>
    <p class="sub" id="sub"></p>
    <div class="actions" id="actions"></div>
  </section>
</main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>window.__SHUTTLE__ = ${data};</script>
<script src="/share.js" type="module"></script>
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

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
