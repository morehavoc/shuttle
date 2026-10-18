// Shuttle — record a screen/camera video, get a link.
// One Worker: JSON API (/api/*), the share page (/v/:id), the video bytes (/raw/:id[/cam]),
// thumbnails (/thumb/:id[/variant].jpg). Static app in public/. Videos in R2, metadata in D1.
//
// A recording has up to two tracks: `main` (screen + all audio, or the camera in camera-only
// mode) and `cam` (the camera, video only), composited by the player. Edits are cut ranges
// applied at playback; the files are never rewritten.

import { renderSharePage, renderEmbedPage, renderNotFound } from './share-page.js';
import { transcribeWav, provider } from './transcribe.js';
import { draftDescription, describeProvider } from './describe.js';
import { normalizeCuts, isWordCut, withTrim } from '../public/timeline.js';
import { buildSidx, spliceRanges } from './mp4index.js';

const PART_SIZE = 5 * 1024 * 1024; // R2 multipart: every part but the last must be this size
const SESSION_DAYS = 90;
// __Host-: only ever set by this origin over HTTPS, Path=/, no Domain.
const COOKIE = '__Host-shuttle_session';
const LOGIN_PER_IP = 10; // password checks per address per 15 minutes
const LOGIN_PER_IP_FLOOD = 3; // ... while more than LOGIN_GLOBAL failures came in the last hour
const LOGIN_GLOBAL = 100;
const LOGIN_GLOBAL_HARD = 300; // ... and past this many, only a browser that has signed in before is checked
const DEVICE_COOKIE = '__Host-shuttle_device'; // marks a browser that has signed in; never a session
const DEVICE_DAYS = 365;
const MAX_JSON = 1024 * 1024; // the largest edit (5,000 cuts) is ~100 KB
const MAX_LOGIN_JSON = 4096;
const MAX_THUMB = 2 * 1024 * 1024;
const INDEX_TRIES = 3; // fragment-index builds per file before giving up (a build can be killed)
const ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ALLOWED_MIME = /^video\/(webm|mp4|x-matroska|quicktime)(;.*)?$/i;
const ID = '([A-Za-z0-9]{6,32})';
const TRACKS = ['main', 'cam'];
const THUMBS = ['poster', 'cam', 'og'];
const LAYOUT_KINDS = ['bubble', 'card', 'side', 'screen'];
const CORNERS = ['bl', 'br', 'tl', 'tr'];
const SIZES = ['s', 'm', 'l'];
const PLAY_SPEEDS = [1, 1.2, 1.25, 1.5, 1.75, 2];
const DEFAULT_LAYOUT = { kind: 'bubble', corner: 'bl', size: 'm' };
const MAX_AUDIO_CHUNK = 8 * 1024 * 1024;
const STALE_CHUNK_MS = 2 * 60e3;

export default {
  async fetch(request, env, ctx) {
    hsts = env.HSTS !== '0';
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err && err.stack || err);
      return json({ error: 'Something went wrong' }, 500);
    }
  },
  // Hourly (wrangler.toml [triggers]): delete videos past their expiry, then index a few files
  // that have no fragment index yet (older recordings; builds cut short).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweepExpired(env).then(() => indexBacklog(env)));
  },
};

const DAY = 86400000;
const expired = (v) => !!(v && v.expires_at && v.expires_at <= Date.now());

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  let m;
  const match = (re) => (m = path.match(re));

  if (path === '/api/me' && method === 'GET') {
    return json({ owner: await isOwner(request, env), passwordSet: !!env.OWNER_PASSWORD, partSize: PART_SIZE, transcripts: !!provider(env) });
  }
  if (path === '/api/login' && method === 'POST') return login(request, env, url);
  if (path === '/api/logout' && method === 'POST') {
    checkSameOrigin(request, url);
    const res = json({ ok: true });
    // Signing out forgets this browser too (it no longer counts as one he signs in from).
    for (const name of [COOKIE, DEVICE_COOKIE]) res.headers.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    return res;
  }

  // Public reads (the id is the capability).
  if (match(new RegExp(`^/v/${ID}/?$`)) && method === 'GET') return sharePage(request, env, m[1]);
  if (match(new RegExp(`^/e/${ID}/?$`)) && method === 'GET') return embedPage(request, env, m[1]);
  if (path === '/oembed' && method === 'GET') return oembed(env, url);
  if (match(new RegExp(`^/raw/${ID}(?:/(cam))?(?:\\.\\w+)?$`)) && (method === 'GET' || method === 'HEAD')) return rawVideo(request, env, ctx, m[1], m[2] || 'main', url);
  if (match(new RegExp(`^/thumb/${ID}(?:/(cam|og))?(?:\\.jpg)?$`)) && method === 'GET') return thumb(request, env, m[1], m[2] || 'poster');
  if (match(new RegExp(`^/api/videos/${ID}/status$`)) && method === 'GET') return status(env, m[1]);
  if (match(new RegExp(`^/api/videos/${ID}/view$`)) && method === 'POST') return countView(request, env, m[1], url);
  if (match(new RegExp(`^/api/videos/${ID}/transcript$`)) && method === 'GET') return getTranscript(request, env, m[1]);

  if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });

  // Everything else is the owner's.
  if (!(await isOwner(request, env))) throw new HttpError(401, 'Sign in');
  if (method !== 'GET' && method !== 'HEAD') checkSameOrigin(request, url);

  if (path === '/api/videos' && method === 'GET') { ctx.waitUntil(sweepExpired(env)); return listVideos(env); }
  if (path === '/api/videos' && method === 'POST') return createVideo(request, env, url);
  if (match(new RegExp(`^/api/videos/${ID}$`))) {
    if (method === 'GET') return json(publicVideo(await getVideo(env, m[1]), url, true));
    if (method === 'PATCH') return patchVideo(request, env, m[1], url);
    if (method === 'DELETE') return deleteVideo(env, m[1]);
  }
  if (match(new RegExp(`^/api/videos/${ID}/parts/(\\d{1,5})$`)) && method === 'PUT') return uploadPart(request, env, m[1], Number(m[2]), url.searchParams.get('track') || 'main');
  if (match(new RegExp(`^/api/videos/${ID}/complete$`)) && method === 'POST') return completeVideo(request, env, ctx, m[1], url);
  if (match(new RegExp(`^/api/videos/${ID}/describe$`)) && method === 'POST') return describeNow(env, m[1], url);
  if (match(new RegExp(`^/api/videos/${ID}/thumb$`)) && method === 'PUT') return putThumb(request, env, m[1], url.searchParams.get('variant') || 'poster');
  if (match(new RegExp(`^/api/videos/${ID}/audio/(\\d{1,5})$`)) && method === 'PUT') return putAudio(request, env, ctx, m[1], Number(m[2]));
  if (match(new RegExp(`^/api/videos/${ID}/transcript/retry$`)) && method === 'POST') return retryTranscript(env, m[1]);
  if (match(new RegExp(`^/api/videos/${ID}/heartbeat$`)) && method === 'POST') {
    await env.DB.prepare("UPDATE videos SET updated_at = ? WHERE id = ? AND status = 'recording'").bind(Date.now(), m[1]).run();
    return json({ ok: true });
  }

  throw new HttpError(404, 'Not found');
}

// ---------- auth ----------

async function login(request, env, url) {
  if (!env.OWNER_PASSWORD) throw new HttpError(503, 'OWNER_PASSWORD is not set on the server');
  // Only this site's own page may try a password: another site posting wrong ones from his
  // browser would otherwise lock him out (a cross-site form can't send application/json).
  checkSameOrigin(request, url);
  if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) throw new HttpError(415, 'Send JSON');
  const body = await readJson(request, MAX_LOGIN_JSON);
  const given = String(body.password || '');
  const ip = loginNet(request.headers.get('CF-Connecting-IP'));
  const now = Date.now();
  // The attempt is recorded before it is counted, in one transaction, so concurrent requests
  // each see the others and at most LOGIN_PER_IP of them get to check the password.
  const [ins, counts] = await env.DB.batch([
    env.DB.prepare('INSERT INTO login_failures (ip, at) VALUES (?, ?) RETURNING rowid AS rid').bind(ip, now),
    env.DB.prepare(
      'SELECT (SELECT COUNT(*) FROM login_failures WHERE ip = ? AND at > ?) AS mine, (SELECT COUNT(*) FROM login_failures WHERE at > ?) AS everyone'
    ).bind(ip, now - 15 * 60e3, now - 60 * 60e3),
  ]);
  const rid = ins.results[0].rid;
  const recent = counts.results[0];
  // A flood from many addresses shrinks every address's allowance, but never blocks one that
  // hasn't been guessing: the owner's right password still gets in.
  const allowed = recent.everyone > LOGIN_GLOBAL ? LOGIN_PER_IP_FLOOD : LOGIN_PER_IP;
  // A flood big enough to be guessing from many addresses at once: only a browser that has
  // signed in before gets its password checked (so the owner still gets in from his own).
  const shut = recent.everyone > LOGIN_GLOBAL_HARD && !(await signedCookie(request, env, DEVICE_COOKIE, 'device', deviceMac));
  if (recent.mine > allowed || shut) {
    // Refused attempts don't count (only checked ones do), so hammering doesn't extend the wait.
    await env.DB.prepare('DELETE FROM login_failures WHERE rowid = ?').bind(rid).run();
    throw new HttpError(429, 'Too many tries. Wait 15 minutes.');
  }
  const ok = await safeEqual(given, env.OWNER_PASSWORD);
  if (!ok) {
    // The row inserted above is the failure record.
    await env.DB.prepare('DELETE FROM login_failures WHERE at < ?').bind(now - 864e5).run();
    await new Promise((r) => setTimeout(r, 600));
    throw new HttpError(401, 'Wrong password');
  }
  await env.DB.prepare('DELETE FROM login_failures WHERE ip = ? OR rowid = ?').bind(ip, rid).run();
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const dexp = Date.now() + DEVICE_DAYS * 864e5;
  const res = json({ ok: true });
  res.headers.append('Set-Cookie', `${COOKIE}=${exp}.${await hmac(env, `owner.${exp}`)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`);
  res.headers.append('Set-Cookie', `${DEVICE_COOKIE}=${dexp}.${await deviceMac(env, `device.${dexp}`)}; Path=/; Max-Age=${DEVICE_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`);
  return res;
}

// What a login attempt is counted against: an IPv4 address, or an IPv6 /64 (one machine can
// hold a whole /64, so counting single IPv6 addresses would allow unlimited tries). An
// IPv4-mapped IPv6 address counts as its IPv4 address.
export function loginNet(ip) {
  if (!ip) return 'local';
  let a = String(ip).trim().toLowerCase().replace(/%.*$/, ''); // no zone id
  if (!a.includes(':')) return a;
  a = a.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, p, q, r, t) => `${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`);
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const g = (tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]).map((x) => parseInt(x, 16) || 0);
  if (g.length === 8 && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

async function isOwner(request, env) {
  return signedCookie(request, env, COOKIE, 'owner', hmac);
}

// A cookie of ours holding `${exp}.${mac(kind + '.' + exp)}`, still in date.
async function signedCookie(request, env, name, kind, mac) {
  if (!env.OWNER_PASSWORD) return false;
  const raw = (request.headers.get('Cookie') || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  if (!raw) return false;
  const [exp, sig] = raw.slice(name.length + 1).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await mac(env, `${kind}.${exp}`));
}

// The device mark is signed without the password: changing it (during an attack, say) mustn't
// shut his own browsers out with everyone else. Without a SESSION_SECRET (local runs) it uses
// the session key.
async function deviceMac(env, msg) {
  return env.SESSION_SECRET ? macWith(`${env.SESSION_SECRET}|device`, msg) : hmac(env, msg);
}

async function hmac(env, msg) {
  // Keyed by the password, so changing the password signs everyone out.
  return macWith((env.SESSION_SECRET || '') + '|' + env.OWNER_PASSWORD, msg);
}

async function macWith(secret, msg) {
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
  const camMime = body.camMime ? String(body.camMime) : null;
  if (camMime && !ALLOWED_MIME.test(camMime)) throw new HttpError(400, 'Unsupported camera video type');
  const mode = ['screen-camera', 'screen', 'camera'].includes(body.mode) ? body.mode : 'screen-camera';
  const id = newId(12);
  const title = cleanTitle(body.title) || defaultTitle(body.tz);
  const main = await env.VIDEOS.createMultipartUpload(videoKey(id, 'main'), { httpMetadata: { contentType: mime.split(';')[0] } });
  let camUploadId = null;
  if (camMime && mode === 'screen-camera') {
    const cam = await env.VIDEOS.createMultipartUpload(videoKey(id, 'cam'), { httpMetadata: { contentType: camMime.split(';')[0] } });
    camUploadId = cam.uploadId;
  }
  const layout = JSON.stringify(cleanLayout(body.layout) || DEFAULT_LAYOUT);
  const now = Date.now();
  const keep = keepDays(body.keepDays, 1);
  // A stale default in the recorder's storage must never stop a recording: ignore it.
  const speed = PLAY_SPEEDS.includes(Number(body.speed)) ? Number(body.speed) : null;
  await env.DB.prepare(
    `INSERT INTO videos (id, title, mode, mime, status, upload_id, cam_mime, cam_upload_id, surface, layout, expires_at, speed, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'recording', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, title, mode, mime.split(';')[0], main.uploadId, camUploadId ? camMime.split(';')[0] : null, camUploadId,
    cleanSurface(body.surface), layout, keep === null ? null : now + keep * DAY, speed, now, now).run();
  return json({ id, title, partSize: PART_SIZE, shareUrl: `${url.origin}/v/${id}`, hasCam: !!camUploadId }, 201);
}

async function uploadPart(request, env, id, n, track) {
  if (!TRACKS.includes(track)) throw new HttpError(400, 'Bad track');
  if (n < 1 || n > 10000) throw new HttpError(400, 'Bad part number');
  const v = await getVideo(env, id);
  const uploadId = track === 'cam' ? v.cam_upload_id : v.upload_id;
  if (v.status !== 'recording' || !uploadId) throw new HttpError(409, 'This recording is already finished');
  if (!request.body) throw new HttpError(400, 'Empty part');
  // R2 needs a known length; buffer the (≤5 MiB) part, and not a byte more.
  const bytes = await readBody(request, PART_SIZE, 'Part too large');
  if (bytes.byteLength === 0) throw new HttpError(400, 'Empty part');
  const part = await env.VIDEOS.resumeMultipartUpload(videoKey(id, track), uploadId).uploadPart(n, bytes);
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO parts (video_id, track, n, etag, size) VALUES (?, ?, ?, ?, ?)').bind(id, track, n, part.etag, bytes.byteLength),
    env.DB.prepare('UPDATE videos SET updated_at = ? WHERE id = ?').bind(Date.now(), id),
  ]);
  return json({ partNumber: n, etag: part.etag, track });
}

// Closes one track's multipart upload from the parts recorded in D1.
// Returns { size, truncated } or null when the track has no data.
async function completeTrack(env, id, track, uploadId) {
  const { results } = await env.DB.prepare('SELECT n, etag, size FROM parts WHERE video_id = ? AND track = ? ORDER BY n').bind(id, track).all();
  if (!results.length) {
    // A previous complete may have finished in R2 but not here.
    const existing = await env.VIDEOS.head(videoKey(id, track));
    return existing ? { size: existing.size, truncated: false } : null;
  }
  // Parts must be contiguous from 1, and all but the last exactly PART_SIZE.
  const usable = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].n !== i + 1) break;
    usable.push(results[i]);
    if (results[i].size !== PART_SIZE) break;
  }
  try {
    const obj = await env.VIDEOS.resumeMultipartUpload(videoKey(id, track), uploadId)
      .complete(usable.map((p) => ({ partNumber: p.n, etag: p.etag })));
    return { size: obj.size, truncated: usable.length < results.length };
  } catch (err) {
    // Already completed by an earlier attempt that died before updating D1?
    const existing = await env.VIDEOS.head(videoKey(id, track));
    if (!existing) throw err;
    return { size: existing.size, truncated: usable.length < results.length };
  }
}

async function completeVideo(request, env, ctx, id, url) {
  const body = await readJson(request);
  const v = await getVideo(env, id);
  if (v.status === 'ready') return json(publicVideo(v, url, true));
  const main = await completeTrack(env, id, 'main', v.upload_id);
  if (!main) throw new HttpError(409, 'Nothing has been uploaded for this video yet');
  let cam = null;
  if (v.cam_upload_id) {
    try { cam = await completeTrack(env, id, 'cam', v.cam_upload_id); } catch (e) { console.error('camera track:', e && e.message); }
    if (!cam) { try { await env.VIDEOS.resumeMultipartUpload(videoKey(id, 'cam'), v.cam_upload_id).abort(); } catch {} }
  }
  const mime = typeof body.mime === 'string' && ALLOWED_MIME.test(body.mime) ? body.mime.split(';')[0] : v.mime;
  const camMime = cam ? (typeof body.camMime === 'string' && ALLOWED_MIME.test(body.camMime) ? body.camMime.split(';')[0] : v.cam_mime) : null;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE videos SET status = 'ready', upload_id = NULL, cam_upload_id = NULL, mime = ?, size = ?, duration_ms = ?, width = ?, height = ?,
         cam_mime = ?, cam_size = ?, cam_offset_ms = ?, cam_muted_ms = ?, surface = COALESCE(NULLIF(?, ''), surface),
         audio_chunks = ?, tap_gap_ms = ?, updated_at = ? WHERE id = ?`
    ).bind(mime, main.size, clampInt(body.durationMs, 0, 1e9), clampInt(body.width, 0, 20000), clampInt(body.height, 0, 20000),
      camMime, cam ? cam.size : 0, clampInt(body.camOffsetMs, -10000, 10000), clampInt(body.camMutedMs, 0, 1e9),
      cleanSurface(body.surface), body.audioChunks === undefined ? -1 : clampInt(body.audioChunks, 0, 100000),
      clampInt(body.tapGapMs, 0, 1e9), Date.now(), id),
    env.DB.prepare('DELETE FROM parts WHERE video_id = ?').bind(id),
  ]);
  ctx.waitUntil(maybeDescribe(env, id)); // in case the transcript finished first
  ctx.waitUntil(indexTrack(env, id, 'main').then(() => cam && indexTrack(env, id, 'cam')));
  return json({ ...publicVideo(await getVideo(env, id), url, true), truncated: main.truncated || !!(cam && cam.truncated) });
}

async function putThumb(request, env, id, variant) {
  if (!THUMBS.includes(variant)) throw new HttpError(400, 'Bad thumbnail variant');
  await getVideo(env, id);
  const bytes = await readBody(request, MAX_THUMB, 'Bad thumbnail');
  if (!bytes.byteLength) throw new HttpError(400, 'Bad thumbnail');
  await env.VIDEOS.put(thumbKey(id, variant), bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  const col = { poster: 'has_thumb', cam: 'has_cam_thumb', og: 'has_og' }[variant];
  await env.DB.prepare(`UPDATE videos SET ${col} = 1, updated_at = ? WHERE id = ?`).bind(Date.now(), id).run();
  return json({ ok: true });
}

async function patchVideo(request, env, id, url) {
  const body = await readJson(request);
  const v = await getVideo(env, id);
  const sets = [], args = [];
  if (body.title !== undefined) {
    const t = cleanTitle(body.title);
    if (!t) throw new HttpError(400, 'Title can’t be empty');
    sets.push('title = ?'); args.push(t);
  }
  if (body.layout !== undefined) {
    const l = cleanLayout(body.layout);
    if (!l) throw new HttpError(400, 'Bad layout');
    sets.push('layout = ?'); args.push(JSON.stringify(l));
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') throw new HttpError(400, 'Bad description');
    sets.push('description = ?', "description_source = 'owner'"); args.push(cleanDescription(body.description));
  }
  if (body.speed !== undefined) {
    sets.push('speed = ?'); args.push(body.speed === null ? null : cleanSpeed(body.speed));
  }
  if (body.keepDays !== undefined) {
    const k = keepDays(body.keepDays, 0);
    sets.push('expires_at = ?'); args.push(k === null ? null : Date.now() + k * DAY);
  }
  if (body.cuts !== undefined) {
    if (!Array.isArray(body.cuts) || body.cuts.length > 5000) throw new HttpError(400, 'Bad cuts');
    const dur = v.duration_ms ? v.duration_ms / 1000 + 5 : 1e7;
    sets.push('cuts = ?'); args.push(JSON.stringify(normalizeCuts(body.cuts, dur)));
  }
  if (body.trim !== undefined) {
    const t = cleanTrim(body.trim, v.duration_ms ? v.duration_ms / 1000 + 5 : 1e7);
    sets.push('trim_start = ?', 'trim_end = ?'); args.push(t.start, t.end);
  }
  if (sets.length) {
    sets.push('updated_at = ?'); args.push(Date.now());
    await env.DB.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id).run();
  }
  return json(publicVideo(await getVideo(env, id), url, true));
}

async function deleteVideo(env, id) {
  await removeVideo(env, await getVideo(env, id));
  return json({ ok: true });
}

async function sweepExpired(env) {
  try {
    const { results } = await env.DB.prepare('SELECT * FROM videos WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT 50').bind(Date.now()).all();
    for (const v of results) await removeVideo(env, v);
    if (results.length) console.log(`expired: deleted ${results.length}`);
  } catch (e) { console.error('sweep', e && e.message); }
}

async function removeVideo(env, v) {
  const id = v.id;
  for (const [track, uploadId] of [['main', v.upload_id], ['cam', v.cam_upload_id]]) {
    if (v.status === 'recording' && uploadId) {
      try { await env.VIDEOS.resumeMultipartUpload(videoKey(id, track), uploadId).abort(); } catch {}
    }
  }
  // Every audio chunk (a long recording can have more than one listing page), deleted in
  // batches of at most 1,000 keys, which is what R2 takes.
  const keys = [videoKey(id, 'main'), videoKey(id, 'cam'), ...THUMBS.map((t) => thumbKey(id, t))];
  let cursor;
  do {
    const page = await env.VIDEOS.list({ prefix: `audio/${id}/`, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < keys.length; i += 1000) await env.VIDEOS.delete(keys.slice(i, i + 1000));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM parts WHERE video_id = ?').bind(id),
    env.DB.prepare('DELETE FROM transcript_chunks WHERE video_id = ?').bind(id),
    env.DB.prepare('DELETE FROM videos WHERE id = ?').bind(id),
  ]);
}

async function listVideos(env) {
  const { results } = await env.DB.prepare('SELECT * FROM videos ORDER BY created_at DESC LIMIT 500').all();
  return json({ videos: results.map((v) => publicVideo(v, null, true)) });
}

async function status(env, id) {
  const v = await env.DB.prepare('SELECT status, expires_at FROM videos WHERE id = ?').bind(id).first();
  if (!v || expired(v)) throw new HttpError(404, 'Not found');
  return json({ status: v.status });
}

async function countView(request, env, id, url) {
  checkSameOrigin(request, url); // the share page counts a view; another site can't
  if (await isOwner(request, env)) return json({ ok: true, counted: false });
  await env.DB.prepare("UPDATE videos SET views = views + 1 WHERE id = ? AND status = 'ready' AND (expires_at IS NULL OR expires_at > ?)")
    .bind(id, Date.now()).run();
  return json({ ok: true, counted: true });
}

// ---------- transcripts ----------

// One ~minute of 16 kHz mono WAV, sent while recording. Transcribed in the background.
async function putAudio(request, env, ctx, id, seq) {
  const v = await getVideo(env, id);
  if (v.status !== 'recording' && v.status !== 'ready') throw new HttpError(409, 'Not recording');
  const startMs = clampInt(request.headers.get('X-Start-Ms'), 0, 1e9);
  const durationMs = clampInt(request.headers.get('X-Duration-Ms'), 0, 1e7);
  const silent = request.headers.get('X-Silent') === '1';
  const bytes = await readBody(request, MAX_AUDIO_CHUNK, 'Bad audio chunk');
  if (!silent && bytes.byteLength < 44) throw new HttpError(400, 'Bad audio chunk');
  const now = Date.now();
  const p = provider(env);
  // Silence skips the model (Whisper invents words on silence), and so does having no provider.
  const state = silent ? 'ready' : p ? 'pending' : 'off';
  // Kept even with no provider ('off'), so turning transcription on later can still use it.
  if (!silent) await env.VIDEOS.put(audioKey(id, seq), bytes, { httpMetadata: { contentType: 'audio/wav' } });
  await env.DB.prepare(
    'INSERT OR REPLACE INTO transcript_chunks (video_id, seq, start_ms, duration_ms, status, words, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)'
  ).bind(id, seq, startMs, durationMs, state, state === 'ready' ? '[]' : null, now).run();
  if (state === 'pending') ctx.waitUntil(runChunk(env, id, seq));
  return json({ ok: true, status: state });
}

async function runChunk(env, id, seq) {
  const row = await env.DB.prepare('SELECT * FROM transcript_chunks WHERE video_id = ? AND seq = ?').bind(id, seq).first();
  if (!row) return;
  await env.DB.prepare("UPDATE transcript_chunks SET status = 'pending', updated_at = ? WHERE video_id = ? AND seq = ?").bind(Date.now(), id, seq).run();
  try {
    const obj = await env.VIDEOS.get(audioKey(id, seq));
    if (!obj) throw new Error('audio chunk missing');
    const words = await transcribeWav(env, await obj.arrayBuffer(), row.duration_ms);
    const offset = row.start_ms / 1000;
    const abs = words.map((w) => ({ w: w.w, s: round3(w.s + offset), e: round3(w.e + offset) }));
    await env.DB.prepare("UPDATE transcript_chunks SET status = 'ready', words = ?, error = NULL, updated_at = ? WHERE video_id = ? AND seq = ?")
      .bind(JSON.stringify(abs), Date.now(), id, seq).run();
    await env.VIDEOS.delete(audioKey(id, seq));
    await maybeDescribe(env, id);
  } catch (e) {
    console.error('transcribe', id, seq, e && e.message);
    await env.DB.prepare("UPDATE transcript_chunks SET status = 'failed', error = ?, updated_at = ? WHERE video_id = ? AND seq = ?")
      .bind(String(e && e.message || e).slice(0, 300), Date.now(), id, seq).run();
  }
}

async function transcriptOf(env, id, expected = -1) {
  const { results } = await env.DB.prepare('SELECT * FROM transcript_chunks WHERE video_id = ? ORDER BY seq').bind(id).all();
  const now = Date.now();
  const p = provider(env);
  // Chunks the recorder made that never arrived (navigated away mid-upload, refused upload).
  const missing = expected >= 0 ? Math.max(0, expected - results.length) : 0;
  let st;
  if (!results.length && !missing) st = 'none';
  else if (!p && results.some((r) => r.status === 'off')) st = 'off';
  else if (results.some((r) => r.status === 'pending' && now - r.updated_at < STALE_CHUNK_MS)) st = 'pending';
  else if (missing || results.some((r) => r.status !== 'ready')) st = 'partial';
  else st = 'ready';
  const words = results.flatMap((r) => (r.status === 'ready' && r.words ? JSON.parse(r.words) : [])).sort((a, b) => a.s - b.s);
  const retryable = results.filter((r) => r.status === 'failed' || r.status === 'off' || (r.status === 'pending' && now - r.updated_at >= STALE_CHUNK_MS)).length;
  return { status: st, words, failed: retryable, missing };
}

async function getTranscript(request, env, id) {
  const v = await env.DB.prepare('SELECT status, cuts, trim_start, trim_end, audio_chunks, expires_at FROM videos WHERE id = ?').bind(id).first();
  if (!v || expired(v)) throw new HttpError(404, 'Not found');
  const t = await transcriptOf(env, id, v.status === 'ready' ? v.audio_chunks : -1);
  if (!(await isOwner(request, env))) {
    // Viewers never get the words that were cut or trimmed.
    const cuts = playCuts(v);
    t.words = t.words.filter((w) => !isWordCut(w, cuts));
    delete t.failed;
    delete t.missing;
  }
  return json(t);
}

// Re-runs failed or stuck chunks, a few per request; the page calls again until done.
async function retryTranscript(env, id) {
  const now = Date.now();
  if (!provider(env)) throw new HttpError(409, 'Transcription isn’t set up on this server');
  const v = await getVideo(env, id);
  const { results } = await env.DB.prepare(
    // Least recently tried first, so a chunk that keeps failing doesn't starve the others.
    "SELECT seq FROM transcript_chunks WHERE video_id = ? AND (status IN ('failed', 'off') OR (status = 'pending' AND updated_at < ?)) ORDER BY updated_at, seq LIMIT 4"
  ).bind(id, now - STALE_CHUNK_MS).all();
  for (const r of results) await runChunk(env, id, r.seq);
  const t = await transcriptOf(env, id, v.status === 'ready' ? v.audio_chunks : -1);
  return json({ status: t.status, failed: t.failed, missing: t.missing, retried: results.length });
}

// ---------- public reads ----------

// ---------- description ----------

// Drafts a description (and replaces the default title) once the transcript is done — only if
// the owner hasn't written one. Claims the row first so two chunks finishing together draft once.
async function maybeDescribe(env, id) {
  try {
    if (!describeProvider(env)) return;
    const v = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(id).first();
    if (!v || v.status !== 'ready' || v.description_source !== '') return;
    const t = await transcriptOf(env, id, v.audio_chunks);
    if (t.status === 'pending' || t.status === 'none' || t.status === 'off') return;
    const cuts = playCuts(v);
    const words = t.words.filter((w) => !isWordCut(w, cuts));
    if (words.length < 8) return;
    const claimed = await env.DB.prepare("UPDATE videos SET description_source = 'working' WHERE id = ? AND description_source = ''").bind(id).run();
    if (!claimed.meta || !claimed.meta.changes) return;
    try {
      await applyDraft(env, v, await draftDescription(env, words));
    } catch (e) {
      console.error('describe', id, e && e.message);
      await env.DB.prepare("UPDATE videos SET description_source = '' WHERE id = ? AND description_source = 'working'").bind(id).run();
    }
  } catch (e) { console.error('maybeDescribe', e && e.message); }
}

async function applyDraft(env, v, d) {
  const title = d.title && isDefaultTitle(v.title) ? cleanTitle(d.title) : null;
  await env.DB.prepare(
    "UPDATE videos SET description = ?, description_source = 'auto', title = COALESCE(?, title), updated_at = ? WHERE id = ? AND description_source != 'owner'"
  ).bind(cleanDescription(d.description), title, Date.now(), v.id).run();
}

// Owner's "Write one for me": always redraws the description (the title only if still default).
async function describeNow(env, id, url) {
  const v = await getVideo(env, id);
  if (!describeProvider(env)) throw new HttpError(409, 'Descriptions aren’t set up on this server');
  const t = await transcriptOf(env, id, v.audio_chunks);
  const cuts = playCuts(v);
  const words = t.words.filter((w) => !isWordCut(w, cuts));
  if (words.length < 3) throw new HttpError(409, 'Not enough transcript to go on yet');
  const d = await draftDescription(env, words);
  await env.DB.prepare("UPDATE videos SET description_source = 'auto' WHERE id = ?").bind(id).run();
  await applyDraft(env, { ...v, description_source: 'auto' }, d);
  return json(publicVideo(await getVideo(env, id), url, true));
}

async function sharePage(request, env, id) {
  const v = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(id).first();
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders() };
  if (!v || expired(v)) return new Response(renderNotFound(), { status: 404, headers });
  const url = new URL(request.url);
  const owner = await isOwner(request, env);
  return new Response(renderSharePage(publicVideo(v, url, owner), { owner, origin: url.origin, ownerName: env.OWNER_NAME || '' }), { headers });
}

// The player alone, for an <iframe> on any site: the only page another site may frame.
async function embedPage(request, env, id) {
  const v = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(id).first();
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders({ framable: true }) };
  if (!v || expired(v)) return new Response(renderNotFound(), { status: 404, headers });
  const url = new URL(request.url);
  return new Response(renderEmbedPage(publicVideo(v, url, false), { origin: url.origin, ownerName: env.OWNER_NAME || '' }), { headers });
}

// oEmbed (https://oembed.com): what Ghost, WordPress, Notion and others ask when a link is
// pasted. The share page names this endpoint in a <link>, and the answer is an <iframe> of /e/.
const EMBED_W = 640, EMBED_H = 360;
async function oembed(env, url) {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  const format = url.searchParams.get('format') || 'json';
  if (format !== 'json') return json({ error: 'Only json' }, 501, cors);
  let target;
  try { target = new URL(url.searchParams.get('url') || ''); } catch { return json({ error: 'Bad url' }, 404, cors); }
  const m = target.origin === url.origin && target.pathname.match(new RegExp(`^/[ve]/${ID}/?$`));
  if (!m) return json({ error: 'Not a video here' }, 404, cors);
  const v = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(m[1]).first();
  if (!v || expired(v) || v.status !== 'ready') return json({ error: 'Not found' }, 404, cors);
  const pv = publicVideo(v, url, false);
  // The player is always 16:9. Fit maxwidth/maxheight when the consumer gives them.
  const maxW = clampInt(url.searchParams.get('maxwidth'), 0, 4000), maxH = clampInt(url.searchParams.get('maxheight'), 0, 4000);
  let w = EMBED_W;
  if (maxW) w = Math.min(w, maxW);
  if (maxH) w = Math.min(w, Math.floor(maxH * 16 / 9));
  w = Math.max(w, 160);
  const h = Math.round(w * 9 / 16);
  const src = `${url.origin}/e/${pv.id}`;
  const title = String(pv.title || 'Video').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const out = {
    version: '1.0', type: 'video', provider_name: 'Shuttle', provider_url: url.origin,
    title: pv.title || 'Video', width: w, height: h,
    html: `<iframe src="${src}" width="${w}" height="${h}" style="border:0;width:100%;height:auto;aspect-ratio:16/9" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy" title="${title}"></iframe>`,
  };
  if (env.OWNER_NAME) out.author_name = env.OWNER_NAME;
  if (pv.hasThumb || pv.hasOg) Object.assign(out, { thumbnail_url: `${url.origin}/thumb/${pv.id}/og.jpg${pv.rev ? `?v=${pv.rev}` : ''}`, thumbnail_width: 1280, thumbnail_height: 720 });
  return json(out, 200, { ...cors, 'Cache-Control': 'public, max-age=300' });
}

async function rawVideo(request, env, ctx, id, track, url) {
  const v = await env.DB.prepare('SELECT status, mime, cam_mime, title, layout, expires_at, mp4_index FROM videos WHERE id = ?').bind(id).first();
  if (!v || v.status !== 'ready' || expired(v)) return new Response('Not found', { status: 404 });
  const download = [...url.searchParams.keys()].some((k) => k.toLowerCase() === 'download');
  if (download && !(await isOwner(request, env))) return new Response('Downloads are for the owner', { status: 403 });
  // With the Screen layout the camera isn't part of the video, so viewers can't fetch it.
  if (track === 'cam' && camHidden(v) && !(await isOwner(request, env))) return new Response('Not found', { status: 404 });
  const key = videoKey(id, track);
  const head = await env.VIDEOS.head(key);
  if (!head) return new Response('Not found', { status: 404 });
  const mime = (track === 'cam' ? v.cam_mime : v.mime) || head.httpMetadata?.contentType || 'video/mp4';
  // The fragment index (see mp4index.js), spliced in at `at`. Built when the recording completes;
  // a file without one (an older recording) is served as stored until the hourly job indexes it.
  // Never built here: a viewer's request must not set off work.
  const idx = (parseJson(v.mp4_index, {}) || {})[track];
  const fresh = idx && idx.etag === head.etag;
  const sidx = fresh && idx.sidx ? b64decode(idx.sidx) : null;
  const at = sidx ? idx.at : 0;
  const insert = sidx ? sidx.length : 0;
  const size = head.size + insert;
  const etag = sidx ? `"${head.etag}-x"` : head.httpEtag;
  const headers = new Headers({
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'ETag': etag,
    // The camera can be hidden from viewers at any time (and the owner still gets it then), so
    // no cache may keep it or serve it without asking again.
    'Cache-Control': download ? 'private, no-store' : track === 'cam' ? 'private, no-cache' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  if (download) {
    const ext = mime.includes('mp4') ? 'mp4' : mime.includes('quicktime') ? 'mov' : 'webm';
    const name = (v.title || 'video').replace(/[^\w\- .]+/g, '').trim().slice(0, 80) || 'video';
    headers.set('Content-Disposition', `attachment; filename="${name}${track === 'cam' ? ' (camera)' : ''}.${ext}"`);
  }
  // A resumed download names the file it started (If-Range). If that isn't this one (the index
  // arrived in between and shifted every offset), it gets the whole file, not a mismatched piece.
  const ifRange = request.headers.get('If-Range');
  const range = ifRange && ifRange !== etag ? null : parseRange(request.headers.get('Range'), size);
  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(size));
    return new Response(null, { status: 200, headers });
  }
  const start = range ? range.start : 0, end = range ? range.end : size - 1;
  const len = end - start + 1;
  let body;
  if (!sidx) {
    const obj = await env.VIDEOS.get(key, range ? { range: { offset: start, length: len } } : undefined);
    if (!obj) return new Response('Not found', { status: 404 });
    body = obj.body;
  } else {
    body = splicedBody(env, ctx, key, spliceRanges(start, end, at, insert), sidx, len);
  }
  headers.set('Content-Length', String(len));
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  return new Response(body, { status: range ? 206 : 200, headers });
}

// Streams the stored file's byte ranges with the index bytes between them, at a fixed length.
function splicedBody(env, ctx, key, pieces, sidx, len) {
  let i = 0, reader = null;
  const source = new ReadableStream({
    async pull(ctrl) {
      for (;;) {
        if (reader) {
          const { done, value } = await reader.read();
          if (!done) { ctrl.enqueue(value); return; }
          reader = null;
        }
        if (i >= pieces.length) { ctrl.close(); return; }
        const p = pieces[i++];
        if (p.from === 'sidx') { ctrl.enqueue(sidx.slice(p.offset, p.offset + p.length)); return; }
        const obj = await env.VIDEOS.get(key, { range: { offset: p.offset, length: p.length } });
        if (!obj) { ctrl.error(new Error('Video data is missing')); return; }
        reader = obj.body.getReader();
      }
    },
    cancel(reason) { if (reader) reader.cancel(reason).catch(() => {}); },
  });
  const fixed = new FixedLengthStream(len);
  ctx.waitUntil(source.pipeTo(fixed.writable).catch(() => {})); // a viewer seeking cancels mid-way
  return fixed.readable;
}

const indexing = new Set();
// Builds one track's index; true if it started a build. The attempt is claimed in D1 first,
// atomically (compare-and-set on a claim token), so two isolates can't build the same file at
// once, and a build the runtime kills (CPU, memory) leaves its claim behind: after INDEX_TRIES
// of those the file is left as it is. A read that fails is retried later, within those tries.
async function indexTrack(env, id, track) {
  const k = `${id}:${track}`;
  if (indexing.has(k)) return false;
  indexing.add(k);
  try {
    const key = videoKey(id, track);
    const row = await env.DB.prepare(`SELECT json_extract(mp4_index, '$.' || ?) AS e FROM videos WHERE id = ?`).bind(track, id).first();
    if (!row) return false;
    const prev = parseJson(row.e, null);
    const head = await env.VIDEOS.head(key);
    if (!head) { // no file (a camera that recorded nothing, a half-finished delete): not again
      if (!(prev && prev.missing)) await storeIndex(env, id, track, { none: true, missing: true });
      return false;
    }
    const same = prev && prev.etag === head.etag;
    if (same && (prev.sidx || prev.none)) return false;
    if (same && prev.pending && (prev.tries >= INDEX_TRIES || Date.now() - prev.since < 10 * 60e3)) return false;
    const tries = same && prev.pending ? prev.tries + 1 : 1;
    const claim = crypto.randomUUID();
    if (!(await storeIndex(env, id, track, { pending: true, etag: head.etag, tries, since: Date.now(), claim }, (prev && prev.claim) || ''))) return false;
    const read = async (offset, length) => {
      const obj = await env.VIDEOS.get(key, { range: { offset, length } });
      if (!obj) throw new Error('range read failed');
      return new Uint8Array(await obj.arrayBuffer());
    };
    let entry;
    try {
      const r = await buildSidx(read, head.size);
      entry = r ? { at: r.at, etag: head.etag, sidx: b64encode(r.sidx) } : { none: true, etag: head.etag };
    } catch (e) { // the parser doesn't throw; this is a failed read, worth another try later
      console.error(`index ${k}:`, e && e.message);
      entry = { pending: true, etag: head.etag, tries, since: Date.now(), error: String(e && e.message || e).slice(0, 200) };
    }
    await storeIndex(env, id, track, entry, claim);
    return true;
  } catch (e) {
    console.error(`index ${k}:`, e && e.message);
    return false;
  } finally {
    indexing.delete(k);
  }
}

// Writes one track's index entry. With `expect`, only if the stored entry's claim is still that
// ('' for none); returns whether it wrote.
async function storeIndex(env, id, track, entry, expect = null) {
  const set = `UPDATE videos SET mp4_index = json_set(COALESCE(mp4_index, '{}'), '$.' || ?, json(?)) WHERE id = ?`;
  const r = expect === null
    ? await env.DB.prepare(set).bind(track, JSON.stringify(entry), id).run()
    : await env.DB.prepare(`${set} AND COALESCE(json_extract(mp4_index, '$.' || ? || '.claim'), '') = ?`).bind(track, JSON.stringify(entry), id, track, expect).run();
  return !!(r.meta && r.meta.changes);
}

// Up to `max` index builds a run for MP4 tracks that have none yet (recorded before indexing
// existed, or a build that didn't finish), newest first. Only builds that start count, so files
// that can't be indexed never use up the run.
async function indexBacklog(env, max = 3) {
  try {
    // Without the sidx bytes (kilobytes of base64 each): only what's needed to choose.
    const { results } = await env.DB.prepare(
      `SELECT id, mime, cam_mime, json_remove(COALESCE(mp4_index, '{}'), '$.main.sidx', '$.cam.sidx') AS idx,
         json_extract(mp4_index, '$.main.sidx') IS NOT NULL AS main_done, json_extract(mp4_index, '$.cam.sidx') IS NOT NULL AS cam_done
       FROM videos WHERE status = 'ready' AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC`
    ).bind(Date.now()).all();
    let started = 0;
    for (const v of results) {
      const idx = parseJson(v.idx, {}) || {};
      for (const [track, mime, done] of [['main', v.mime, v.main_done], ['cam', v.cam_mime, v.cam_done]]) {
        const e = idx[track];
        if (done || !mime || !/mp4/i.test(mime)) continue;
        if (e && (e.none || (e.pending && (e.tries >= INDEX_TRIES || Date.now() - e.since < 10 * 60e3)))) continue;
        if ((await indexTrack(env, v.id, track)) && ++started >= max) return;
      }
    }
  } catch (e) { console.error('index backlog', e && e.message); }
}

function b64encode(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
function b64decode(str) { const s = atob(str); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }

async function thumb(request, env, id, variant) {
  const v = await env.DB.prepare('SELECT layout, expires_at FROM videos WHERE id = ?').bind(id).first();
  if (!v || expired(v)) return new Response('Not found', { status: 404 });
  if (variant !== 'poster') {
    if (v && camHidden(v)) {
      if (variant === 'cam' && !(await isOwner(request, env))) return new Response('Not found', { status: 404 });
      if (variant === 'og') variant = 'poster'; // the preview without his face
    }
  }
  let obj = await env.VIDEOS.get(thumbKey(id, variant));
  if (!obj && variant === 'og') obj = await env.VIDEOS.get(thumbKey(id, 'poster'));
  if (!obj) {
    return new Response(PLACEHOLDER_SVG, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' } });
  }
  // The camera thumbnail is his face and can be hidden later: same rule as the camera track.
  // Five minutes, like the video: a deleted video, or a camera he hides, stops showing soon.
  return new Response(obj.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': variant === 'cam' ? 'private, no-cache' : 'public, max-age=300' } });
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
  if (!v || expired(v)) throw new HttpError(404, 'Not found');
  return v;
}

// The owner picked the Screen layout: the camera recording is not shown to viewers.
function camHidden(v) {
  const l = parseJson(v.layout, null);
  return !!(l && l.kind === 'screen');
}

function publicVideo(v, url, owner = false) {
  const out = {
    id: v.id, title: v.title, mode: v.mode, mime: v.mime, status: v.status,
    durationMs: v.duration_ms, width: v.width, height: v.height,
    hasThumb: !!v.has_thumb, hasCamThumb: !!v.has_cam_thumb, hasOg: !!v.has_og,
    hasCam: !!(v.cam_mime && (v.cam_size || v.cam_upload_id)), camMime: v.cam_mime || null, camOffsetMs: v.cam_offset_ms || 0,
    layout: parseJson(v.layout, null) || (v.cam_mime ? DEFAULT_LAYOUT : { kind: 'screen', corner: 'bl', size: 'm' }),
    cuts: parseJson(v.cuts, []),
    trim: trimOf(v),
    rev: rev(v.updated_at),
    description: v.description || '',
    speed: typeof v.speed === 'number' ? v.speed : null,
    createdAt: v.created_at,
  };
  if (!owner && v.cam_mime && camHidden(v)) Object.assign(out, { hasCam: false, hasCamThumb: false, camMime: null });
  if (owner) {
    Object.assign(out, {
      size: v.size, camSize: v.cam_size || 0, views: v.views, updatedAt: v.updated_at,
      surface: v.surface || '', camMutedMs: v.cam_muted_ms || 0, tapGapMs: v.tap_gap_ms || 0,
      expiresAt: v.expires_at || null, descriptionSource: v.description_source || '',
    });
  }
  if (url) out.shareUrl = `${url.origin}/v/${v.id}`;
  return out;
}

// A short tag that changes whenever the video does (from its last-change time, without showing
// it): versions the poster and link-preview URLs, so caches fetch a retaken picture.
function rev(x) {
  let h = 0x811c9dc5;
  for (const c of String(x || 0)) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

// The trim as stored: { start, end } in seconds (end null: to the end), or null for none.
function trimOf(v) {
  const start = typeof v.trim_start === 'number' ? v.trim_start : 0;
  const end = typeof v.trim_end === 'number' ? v.trim_end : null;
  return start > 0 || end !== null ? { start, end } : null;
}

// What playback skips (cuts and trim); viewers' transcripts and the description leave it out.
function playCuts(v) {
  return withTrim(parseJson(v.cuts, []), trimOf(v));
}

// A trim from the owner: null, or { start, end } with end null for "to the end". At least half
// a second stays. Returns the two column values.
function cleanTrim(t, max) {
  if (t === null) return { start: null, end: null };
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new HttpError(400, 'Bad trim');
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : NaN);
  const start = t.start == null ? 0 : num(t.start);
  const end = t.end == null ? null : num(t.end);
  if (Number.isNaN(start) || start < 0 || start > max) throw new HttpError(400, 'Bad trim');
  if (end !== null && (Number.isNaN(end) || end > max || end < start + 0.5)) throw new HttpError(400, 'Bad trim');
  return { start: start > 0 ? start : null, end };
}

function cleanLayout(l) {
  if (!l || typeof l !== 'object') return null;
  if (!LAYOUT_KINDS.includes(l.kind)) return null;
  return { kind: l.kind, corner: CORNERS.includes(l.corner) ? l.corner : 'bl', size: SIZES.includes(l.size) ? l.size : 'm' };
}

function cleanSurface(s) {
  return ['monitor', 'window', 'browser', 'camera'].includes(s) ? s : '';
}

function videoKey(id, track = 'main') { return track === 'cam' ? `videos/${id}.cam` : `videos/${id}`; }
function thumbKey(id, variant = 'poster') { return variant === 'poster' ? `thumbs/${id}.jpg` : `thumbs/${id}.${variant}.jpg`; }
function audioKey(id, seq) { return `audio/${id}/${String(seq).padStart(5, '0')}.wav`; }

function newId(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return s;
}

function cleanTitle(t) {
  return typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().slice(0, 140) : '';
}

function isDefaultTitle(t) { return /^Recording · /.test(String(t || '')); }

function cleanDescription(d) { return String(d || '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1000); }

// null = keep forever; else whole days within [min, 3650].
function cleanSpeed(x) {
  const n = Number(x);
  if (!PLAY_SPEEDS.includes(n)) throw new HttpError(400, `Speed must be one of ${PLAY_SPEEDS.join(', ')}`);
  return n;
}

function keepDays(x, min) {
  if (x === null || x === undefined || x === 'forever') return null;
  const n = Number(x);
  if (!Number.isFinite(n)) throw new HttpError(400, 'Bad keepDays');
  return Math.max(min, Math.min(3650, Math.round(n)));
}

function defaultTitle(tz) {
  let zone = 'America/Los_Angeles';
  try { if (tz) { new Intl.DateTimeFormat('en-US', { timeZone: tz }); zone = tz; } } catch {}
  const s = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date());
  return `Recording · ${s}`;
}

function clampInt(x, lo, hi) {
  const n = Math.round(Number(x));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
}

function round3(x) { return Math.round(x * 1000) / 1000; }

function parseJson(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}

async function readJson(request, max = MAX_JSON) {
  const text = new TextDecoder().decode(await readBody(request, max, 'Request too large'));
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Bad JSON'); }
}

// A request body, refused (413) as soon as it passes `max` bytes: never buffers more than that.
async function readBody(request, max, message = 'Too large') {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > max) throw new HttpError(413, message);
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { reader.cancel().catch(() => {}); throw new HttpError(413, message); }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Same policy as public/_headers (static files); keep the two in step.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.bunny.net; font-src https://fonts.bunny.net; "
  + "media-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

// HTTPS only, remembered for a year. Not from local runs (HSTS = "0"): the preview shares a host
// name with other services there. Sent by the Worker's own responses (every page load calls
// /api/me); public/_headers can't be switched per environment, so it doesn't send it. Set per
// request from env, which is the same for every request an isolate serves.
let hsts = false;

// `framable`: only the embed page (/e/) may be shown inside another site's <iframe>.
function securityHeaders({ framable = false } = {}) {
  return {
    ...(hsts ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': framable ? CSP.replace("frame-ancestors 'none'", 'frame-ancestors *') : CSP,
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders(), ...extra },
  });
}

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#1b1a22"/><circle cx="320" cy="180" r="34" fill="#2c2a37"/><path d="M310 162v36l30-18z" fill="#8b86a3"/></svg>`;
