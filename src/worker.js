// Shuttle — record a screen/camera video, get a link.
// One Worker: JSON API (/api/*), the share page (/v/:id), the video bytes (/raw/:id),
// thumbnails (/thumb/:id). Static app in public/. Videos in R2, metadata in D1.

import { renderSharePage, renderNotFound } from './share-page.js';

const PART_SIZE = 5 * 1024 * 1024; // R2 multipart: every part but the last must be this size
const SESSION_DAYS = 90;
const COOKIE = 'shuttle_session';
const ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ALLOWED_MIME = /^video\/(webm|mp4|x-matroska|quicktime)(;.*)?$/i;

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err && err.stack || err);
      return json({ error: 'Something went wrong' }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  let m;

  if (path === '/api/me' && method === 'GET') {
    return json({ owner: await isOwner(request, env), passwordSet: !!env.OWNER_PASSWORD, partSize: PART_SIZE });
  }
  if (path === '/api/login' && method === 'POST') return login(request, env);
  if (path === '/api/logout' && method === 'POST') {
    checkSameOrigin(request, url);
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
  }

  // Public reads (the id is the capability).
  if ((m = path.match(/^\/v\/([A-Za-z0-9]{6,32})\/?$/)) && method === 'GET') return sharePage(request, env, m[1]);
  if ((m = path.match(/^\/raw\/([A-Za-z0-9]{6,32})(?:\.\w+)?$/)) && (method === 'GET' || method === 'HEAD')) return rawVideo(request, env, m[1], url);
  if ((m = path.match(/^\/thumb\/([A-Za-z0-9]{6,32})(?:\.jpg)?$/)) && method === 'GET') return thumb(env, m[1]);
  if ((m = path.match(/^\/api\/videos\/([A-Za-z0-9]{6,32})\/status$/)) && method === 'GET') return status(env, m[1]);
  if ((m = path.match(/^\/api\/videos\/([A-Za-z0-9]{6,32})\/view$/)) && method === 'POST') return countView(request, env, m[1]);

  if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });

  // Everything else is the owner's.
  if (!(await isOwner(request, env))) throw new HttpError(401, 'Sign in');
  if (method !== 'GET' && method !== 'HEAD') checkSameOrigin(request, url);

  if (path === '/api/videos' && method === 'GET') return listVideos(env);
  if (path === '/api/videos' && method === 'POST') return createVideo(request, env, url);
  if ((m = path.match(/^\/api\/videos\/([A-Za-z0-9]{6,32})$/))) {
    if (method === 'GET') return json(publicVideo(await getVideo(env, m[1]), url));
    if (method === 'PATCH') return patchVideo(request, env, m[1], url);
    if (method === 'DELETE') return deleteVideo(env, m[1]);
  }
  if ((m = path.match(/^\/api\/videos\/([A-Za-z0-9]{6,32})\/parts\/(\d{1,5})$/)) && method === 'PUT') return uploadPart(request, env, m[1], Number(m[2]));
  if ((m = path.match(/^\/api\/videos\/([A-Za-z0-9]{6,32})\/complete$/)) && method === 'POST') return completeVideo(request, env, m[1], url);
  if ((m = path.match(/^\/api\/videos\/([A-Za-z0-9]{6,32})\/thumb$/)) && method === 'PUT') return putThumb(request, env, m[1]);
  if ((m = path.match(/^\/api\/videos\/([A-Za-z0-9]{6,32})\/heartbeat$/)) && method === 'POST') {
    await env.DB.prepare("UPDATE videos SET updated_at = ? WHERE id = ? AND status = 'recording'").bind(Date.now(), m[1]).run();
    return json({ ok: true });
  }

  throw new HttpError(404, 'Not found');
}

// ---------- auth ----------

async function login(request, env) {
  if (!env.OWNER_PASSWORD) throw new HttpError(503, 'OWNER_PASSWORD is not set on the server');
  const body = await readJson(request);
  const given = String(body.password || '');
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const now = Date.now();
  const recent = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM login_failures WHERE ip = ? AND at > ?) AS mine, (SELECT COUNT(*) FROM login_failures WHERE at > ?) AS everyone'
  ).bind(ip, now - 15 * 60e3, now - 60 * 60e3).first();
  if (recent.mine >= 10 || recent.everyone >= 100) throw new HttpError(429, 'Too many tries. Wait 15 minutes.');
  const ok = await safeEqual(given, env.OWNER_PASSWORD);
  if (!ok) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO login_failures (ip, at) VALUES (?, ?)').bind(ip, now),
      env.DB.prepare('DELETE FROM login_failures WHERE at < ?').bind(now - 864e5),
    ]);
    await new Promise((r) => setTimeout(r, 600));
    throw new HttpError(401, 'Wrong password');
  }
  await env.DB.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip).run();
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const sig = await hmac(env, `owner.${exp}`);
  const cookie = `${COOKIE}=${exp}.${sig}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
  return json({ ok: true }, 200, { 'Set-Cookie': cookie });
}

async function isOwner(request, env) {
  if (!env.OWNER_PASSWORD) return false;
  const raw = (request.headers.get('Cookie') || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return false;
  const [exp, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(env, `owner.${exp}`));
}

async function hmac(env, msg) {
  // Keyed by the password, so changing the password signs everyone out.
  const secret = (env.SESSION_SECRET || '') + '|' + env.OWNER_PASSWORD;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return b64url(new Uint8Array(mac));
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

function checkSameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-origin request refused');
}

// ---------- videos ----------

async function createVideo(request, env, url) {
  const body = await readJson(request);
  const mime = String(body.mime || '');
  if (!ALLOWED_MIME.test(mime)) throw new HttpError(400, 'Unsupported video type');
  const mode = ['screen-camera', 'screen', 'camera'].includes(body.mode) ? body.mode : 'screen-camera';
  const id = newId(12);
  const title = cleanTitle(body.title) || defaultTitle(body.tz);
  const upload = await env.VIDEOS.createMultipartUpload(videoKey(id), {
    httpMetadata: { contentType: mime.split(';')[0] },
  });
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO videos (id, title, mode, mime, status, upload_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, title, mode, mime.split(';')[0], 'recording', upload.uploadId, now, now).run();
  return json({ id, title, partSize: PART_SIZE, shareUrl: `${url.origin}/v/${id}` }, 201);
}

async function uploadPart(request, env, id, n) {
  if (n < 1 || n > 10000) throw new HttpError(400, 'Bad part number');
  const v = await getVideo(env, id);
  if (v.status !== 'recording' || !v.upload_id) throw new HttpError(409, 'This recording is already finished');
  const len = Number(request.headers.get('Content-Length') || 0);
  if (!request.body) throw new HttpError(400, 'Empty part');
  if (len && len > PART_SIZE) throw new HttpError(400, 'Part too large');
  const upload = env.VIDEOS.resumeMultipartUpload(videoKey(id), v.upload_id);
  // R2 needs a known length; buffer the (≤5 MiB) part.
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) throw new HttpError(400, 'Empty part');
  if (bytes.byteLength > PART_SIZE) throw new HttpError(400, 'Part too large');
  const part = await upload.uploadPart(n, bytes);
  await env.DB.prepare('INSERT OR REPLACE INTO parts (video_id, n, etag, size) VALUES (?, ?, ?, ?)')
    .bind(id, n, part.etag, bytes.byteLength).run();
  await env.DB.prepare('UPDATE videos SET updated_at = ? WHERE id = ?').bind(Date.now(), id).run();
  return json({ partNumber: n, etag: part.etag });
}

async function completeVideo(request, env, id, url) {
  const body = await readJson(request);
  const v = await getVideo(env, id);
  if (v.status === 'ready') return json(publicVideo(v, url));
  const { results } = await env.DB.prepare('SELECT n, etag, size FROM parts WHERE video_id = ? ORDER BY n').bind(id).all();
  if (!results.length) {
    // A previous complete may have finished in R2 but not here.
    const existing = await env.VIDEOS.head(videoKey(id));
    if (existing) return markReady(env, id, v, existing.size, body, url, false);
    throw new HttpError(409, 'Nothing has been uploaded for this video yet');
  }
  // Parts must be contiguous from 1, and all but the last exactly PART_SIZE.
  const usable = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].n !== i + 1) break;
    usable.push(results[i]);
    if (results[i].size !== PART_SIZE) break;
  }
  let size;
  try {
    const upload = env.VIDEOS.resumeMultipartUpload(videoKey(id), v.upload_id);
    const obj = await upload.complete(usable.map((p) => ({ partNumber: p.n, etag: p.etag })));
    size = obj.size;
  } catch (err) {
    // Already completed by an earlier attempt that died before updating D1?
    const existing = await env.VIDEOS.head(videoKey(id));
    if (!existing) throw err;
    size = existing.size;
  }
  return markReady(env, id, v, size, body, url, usable.length < results.length);
}

async function markReady(env, id, v, size, body, url, truncated) {
  const durationMs = clampInt(body.durationMs, 0, 1e9);
  const mime = typeof body.mime === 'string' && ALLOWED_MIME.test(body.mime) ? body.mime.split(';')[0] : v.mime;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE videos SET status = 'ready', upload_id = NULL, mime = ?, size = ?, duration_ms = ?, width = ?, height = ?, updated_at = ? WHERE id = ?"
    ).bind(mime, size, durationMs, clampInt(body.width, 0, 20000), clampInt(body.height, 0, 20000), Date.now(), id),
    env.DB.prepare('DELETE FROM parts WHERE video_id = ?').bind(id),
  ]);
  return json({ ...publicVideo(await getVideo(env, id), url), truncated });
}

async function putThumb(request, env, id) {
  await getVideo(env, id);
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024) throw new HttpError(400, 'Bad thumbnail');
  await env.VIDEOS.put(thumbKey(id), bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.DB.prepare('UPDATE videos SET has_thumb = 1, updated_at = ? WHERE id = ?').bind(Date.now(), id).run();
  return json({ ok: true });
}

async function patchVideo(request, env, id, url) {
  const body = await readJson(request);
  await getVideo(env, id);
  if (body.title !== undefined) {
    const t = cleanTitle(body.title);
    if (!t) throw new HttpError(400, 'Title can’t be empty');
    await env.DB.prepare('UPDATE videos SET title = ?, updated_at = ? WHERE id = ?').bind(t, Date.now(), id).run();
  }
  return json(publicVideo(await getVideo(env, id), url));
}

async function deleteVideo(env, id) {
  const v = await getVideo(env, id);
  if (v.status === 'recording' && v.upload_id) {
    try { await env.VIDEOS.resumeMultipartUpload(videoKey(id), v.upload_id).abort(); } catch {}
  }
  await env.VIDEOS.delete([videoKey(id), thumbKey(id)]);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM parts WHERE video_id = ?').bind(id),
    env.DB.prepare('DELETE FROM videos WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

async function listVideos(env) {
  const { results } = await env.DB.prepare('SELECT * FROM videos ORDER BY created_at DESC LIMIT 500').all();
  return json({ videos: results.map((v) => publicVideo(v)) });
}

async function status(env, id) {
  const v = await env.DB.prepare('SELECT status, updated_at FROM videos WHERE id = ?').bind(id).first();
  if (!v) throw new HttpError(404, 'Not found');
  return json({ status: v.status });
}

async function countView(request, env, id) {
  if (await isOwner(request, env)) return json({ ok: true, counted: false });
  await env.DB.prepare("UPDATE videos SET views = views + 1 WHERE id = ? AND status = 'ready'").bind(id).run();
  return json({ ok: true, counted: true });
}

// ---------- public reads ----------

async function sharePage(request, env, id) {
  const v = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(id).first();
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders() };
  if (!v) return new Response(renderNotFound(), { status: 404, headers });
  const url = new URL(request.url);
  const owner = await isOwner(request, env);
  return new Response(renderSharePage(publicVideo(v, url), { owner, origin: url.origin }), { headers });
}

async function rawVideo(request, env, id, url) {
  const v = await env.DB.prepare('SELECT status, mime, title FROM videos WHERE id = ?').bind(id).first();
  if (!v || v.status !== 'ready') return new Response('Not found', { status: 404 });
  const head = await env.VIDEOS.head(videoKey(id));
  if (!head) return new Response('Not found', { status: 404 });
  const size = head.size;
  const headers = new Headers({
    'Content-Type': v.mime,
    'Accept-Ranges': 'bytes',
    'ETag': head.httpEtag,
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  if (url.searchParams.has('download')) {
    const ext = v.mime.includes('mp4') ? 'mp4' : v.mime.includes('quicktime') ? 'mov' : 'webm';
    const name = (v.title || 'video').replace(/[^\w\- .]+/g, '').trim().slice(0, 80) || 'video';
    headers.set('Content-Disposition', `attachment; filename="${name}.${ext}"`);
  }
  const range = parseRange(request.headers.get('Range'), size);
  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(size));
    return new Response(null, { status: 200, headers });
  }
  if (range) {
    const obj = await env.VIDEOS.get(videoKey(id), { range: { offset: range.start, length: range.end - range.start + 1 } });
    if (!obj) return new Response('Not found', { status: 404 });
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    headers.set('Content-Length', String(range.end - range.start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  const obj = await env.VIDEOS.get(videoKey(id));
  if (!obj) return new Response('Not found', { status: 404 });
  headers.set('Content-Length', String(size));
  return new Response(obj.body, { status: 200, headers });
}

async function thumb(env, id) {
  const obj = await env.VIDEOS.get(thumbKey(id));
  if (!obj) {
    return new Response(PLACEHOLDER_SVG, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' } });
  }
  return new Response(obj.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' } });
}

// ---------- helpers ----------

export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start, end;
  if (m[1] === '') { // suffix: last N bytes
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

async function getVideo(env, id) {
  const v = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(id).first();
  if (!v) throw new HttpError(404, 'Not found');
  return v;
}

function publicVideo(v, url) {
  const out = {
    id: v.id, title: v.title, mode: v.mode, mime: v.mime, status: v.status,
    size: v.size, durationMs: v.duration_ms, width: v.width, height: v.height,
    hasThumb: !!v.has_thumb, views: v.views, createdAt: v.created_at, updatedAt: v.updated_at,
  };
  if (url) out.shareUrl = `${url.origin}/v/${v.id}`;
  return out;
}

function videoKey(id) { return `videos/${id}`; }
function thumbKey(id) { return `thumbs/${id}.jpg`; }

function newId(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return s;
}

function cleanTitle(t) {
  return typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().slice(0, 140) : '';
}

function defaultTitle(tz) {
  let zone = 'America/Los_Angeles';
  try { if (tz) { new Intl.DateTimeFormat('en-US', { timeZone: tz }); zone = tz; } } catch {}
  const d = new Date();
  const s = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
  return `Recording · ${s}`;
}

function clampInt(x, lo, hi) {
  const n = Math.round(Number(x));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
}

async function readJson(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'Bad JSON'); }
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#1b1a22"/><circle cx="320" cy="180" r="34" fill="#2c2a37"/><path d="M310 162v36l30-18z" fill="#8b86a3"/></svg>`;
