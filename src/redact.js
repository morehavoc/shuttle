// The copy of a recording that viewers get once it has been trimmed or cut: the stored file with
// the removed time taken out of it, not just skipped at playback (security review, 2026-10-21:
// /raw served the whole recording, trimmed and cut parts included, to anyone with the link).
//
// No re-encoding. Recorders write fragmented MP4 with a key frame about every second, so this
// copies samples, not pixels:
//   - audio is cut to the sample (~21 ms): a sample stays when its middle is outside every cut;
//   - video drops every frame inside a cut, and after a cut it can only start again on a key
//     frame. The frame it starts on is shown from the moment the cut closes, so the picture holds
//     still for up to the key-frame spacing (~1 s) while the sound plays. Nothing cut is kept.
//   - the very start can't hold a frame it doesn't have yet, so a trim that ends between key
//     frames is pushed on to the next one (sound too): up to ~1 s more is trimmed.
//     (With no trim, the first frame is a key frame and nothing moves.)
// Every kept sample is retimed onto the edited timeline (toEdited), so the copy plays straight
// through with no skips and the transcript's times map onto it the same way.
//
// The work is resumable: a step reads fragments in order and writes the output as a run of
// segments (whole fragments each), and its state is plain JSON, so a step the runtime cuts short
// is picked up from the last saved state. A kind of file this can't redact (not fragmented MP4,
// B-frames, absolute offsets) throws Unsupported; one that is damaged throws Malformed.

import { boxAt, boxesIn, sidxBox } from './mp4index.js';

export const SEG_BYTES = 8 * 1024 * 1024; // output segment size to aim for
const READ_WINDOW = 4 * 1024 * 1024;
const MAX_FRAGMENT = 24 * 1024 * 1024; // one moof + mdat; a recorder's are a few MB at most (a Worker has 128 MB)
const MAX_MOOV = 8 * 1024 * 1024;

// A kind of file this can't redact (WebM, plain MP4, B-frames…): the owner is told, and viewers
// get the file as stored, edits skipped at playback, as before there were copies.
export class Unsupported extends Error {}
// A file of the kind this handles that doesn't hold together. Never a reason to hand out the
// stored file: the copy fails, and viewers wait.
export class Malformed extends Error {}

const typeOf = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const child = (b, box, type) => boxesIn(b, box.start + box.hdr, box.start + box.size).find((x) => x.type === type);
const children = (b, box, type) => boxesIn(b, box.start + box.hdr, box.start + box.size).filter((x) => x.type === type);
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

// ---------- the edited timeline ----------

// Cuts ([start, end] seconds, sorted, not overlapping) → lookups in O(log n).
export class Timeline {
  constructor(cuts) {
    this.cuts = cuts;
    this.before = []; // seconds removed before cut i
    let sum = 0;
    for (const [s, e] of cuts) { this.before.push(sum); sum += e - s; }
  }
  // Index of the last cut starting at or before t, or -1.
  find(t) {
    let lo = 0, hi = this.cuts.length - 1, at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.cuts[mid][0] <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return at;
  }
  inCut(t) {
    const i = this.find(t);
    return i >= 0 && t < this.cuts[i][1];
  }
  // Original time → edited time (inside a cut: where the cut starts). Same as timeline.js toEdited.
  edited(t) {
    const i = this.find(t);
    if (i < 0) return t;
    const [s, e] = this.cuts[i];
    return t < e ? s - this.before[i] : t - this.before[i] - (e - s);
  }
  // Start of the kept stretch that t is in (the end of the cut before it, or 0).
  keptFrom(t) {
    const i = this.find(t);
    return i < 0 ? 0 : this.cuts[i][1];
  }
}

// The cuts with the extra start trim (see the header) folded in.
export function effectiveCuts(cuts, extra) {
  const list = extra ? [...cuts, extra] : [...cuts];
  list.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of list) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// ---------- reading ----------

function readMoov(b, moov) {
  const dv = view(b);
  const trex = {};
  const mvex = child(b, moov, 'mvex');
  if (!mvex) throw new Unsupported('not a fragmented MP4');
  for (const t of children(b, mvex, 'trex')) {
    if (t.size < t.hdr + 24) continue;
    const o = t.start + t.hdr + 4;
    trex[dv.getUint32(o)] = { sdi: dv.getUint32(o + 4), dur: dv.getUint32(o + 8), size: dv.getUint32(o + 12), flags: dv.getUint32(o + 16) };
  }
  const tracks = {};
  for (const trak of children(b, moov, 'trak')) {
    const tkhd = child(b, trak, 'tkhd'), mdia = child(b, trak, 'mdia');
    const mdhd = mdia && child(b, mdia, 'mdhd'), hdlr = mdia && child(b, mdia, 'hdlr');
    if (!tkhd || !mdhd || !hdlr || hdlr.size < hdlr.hdr + 12) throw new Malformed('track header');
    const tv = b[tkhd.start + tkhd.hdr], mv = b[mdhd.start + mdhd.hdr];
    if (tkhd.size < tkhd.hdr + (tv === 1 ? 24 : 16) || mdhd.size < mdhd.hdr + (mv === 1 ? 24 : 16)) throw new Malformed('track header');
    const id = dv.getUint32(tkhd.start + tkhd.hdr + (tv === 1 ? 20 : 12));
    const ts = dv.getUint32(mdhd.start + mdhd.hdr + (mv === 1 ? 20 : 12));
    const handler = typeOf(b, hdlr.start + hdlr.hdr + 8);
    if (!ts) throw new Malformed('track timescale');
    if (handler !== 'vide' && handler !== 'soun') throw new Unsupported(`a ${handler} track`);
    tracks[id] = { ts, kind: handler === 'vide' ? 'video' : 'audio', trex: trex[id] || { sdi: 1, dur: 0, size: 0, flags: 0 } };
  }
  const ids = Object.keys(tracks);
  if (!ids.length) throw new Malformed('no tracks');
  if (ids.filter((id) => tracks[id].kind === 'video').length > 1) throw new Unsupported('more than one video track');
  return tracks;
}

// A moof's samples: [{ tid, sdi, samples: [{ dts, dur, size, flags, cto, at }] }], `at` being
// the sample's offset from the moof's first byte. Only moof-relative data is accepted.
function readMoof(b, moof, tracks, limit) {
  const dv = view(b);
  const out = [];
  for (const traf of children(b, moof, 'traf')) {
    const tfhd = child(b, traf, 'tfhd'), tfdt = child(b, traf, 'tfdt');
    if (!tfhd || tfhd.size < tfhd.hdr + 8) throw new Malformed('tfhd');
    let o = tfhd.start + tfhd.hdr;
    const tf = dv.getUint32(o) & 0xffffff;
    const tid = dv.getUint32(o + 4);
    const track = tracks[tid];
    if (!track) throw new Malformed('a fragment for an unknown track');
    if (tf & 0x1) throw new Unsupported('absolute data offsets');
    if (!(tf & 0x20000)) throw new Unsupported('data offsets not relative to the fragment');
    if (tfhd.size < tfhd.hdr + 8 + 4 * ((tf & 0x2 ? 1 : 0) + (tf & 0x8 ? 1 : 0) + (tf & 0x10 ? 1 : 0) + (tf & 0x20 ? 1 : 0))) throw new Malformed('tfhd');
    o += 8;
    const sdi = tf & 0x2 ? dv.getUint32(o) : track.trex.sdi; if (tf & 0x2) o += 4;
    const defDur = tf & 0x8 ? dv.getUint32(o) : track.trex.dur; if (tf & 0x8) o += 4;
    const defSize = tf & 0x10 ? dv.getUint32(o) : track.trex.size; if (tf & 0x10) o += 4;
    const defFlags = tf & 0x20 ? dv.getUint32(o) : track.trex.flags;
    if (!tfdt) throw new Malformed('no tfdt');
    const vv = b[tfdt.start + tfdt.hdr];
    if (tfdt.size < tfdt.hdr + (vv === 1 ? 12 : 8)) throw new Malformed('tfdt');
    let dts = vv === 1 ? Number(dv.getBigUint64(tfdt.start + tfdt.hdr + 4)) : dv.getUint32(tfdt.start + tfdt.hdr + 4);
    const samples = [];
    let dataAt = 0; // moof-relative; the first trun without an offset starts at the moof
    for (const trun of children(b, traf, 'trun')) {
      const end = trun.start + trun.size;
      let p = trun.start + trun.hdr;
      if (p + 8 > end) throw new Malformed('trun');
      const rf = dv.getUint32(p) & 0xffffff;
      const v1 = b[p] === 1;
      const n = dv.getUint32(p + 4);
      p += 8;
      if (rf & 0x1) { dataAt = dv.getInt32(p); p += 4; }
      let first = null;
      if (rf & 0x4) { first = dv.getUint32(p); p += 4; }
      const per = (rf & 0x100 ? 4 : 0) + (rf & 0x200 ? 4 : 0) + (rf & 0x400 ? 4 : 0) + (rf & 0x800 ? 4 : 0);
      if (p + n * per > end) throw new Malformed('trun');
      for (let i = 0; i < n; i++) {
        const dur = rf & 0x100 ? dv.getUint32(p) : defDur; if (rf & 0x100) p += 4;
        const size = rf & 0x200 ? dv.getUint32(p) : defSize; if (rf & 0x200) p += 4;
        let flags = rf & 0x400 ? dv.getUint32(p) : defFlags; if (rf & 0x400) p += 4;
        if (i === 0 && first !== null) flags = first;
        const cto = rf & 0x800 ? (v1 ? dv.getInt32(p) : dv.getUint32(p)) : 0; if (rf & 0x800) p += 4;
        if (cto !== 0) throw new Unsupported('reordered frames (composition offsets)');
        if (dataAt < 0 || dataAt + size > limit) throw new Malformed('sample data outside its fragment');
        samples.push({ dts, dur, size, flags, at: dataAt });
        dts += dur;
        dataAt += size;
      }
    }
    if (samples.length) out.push({ tid, sdi, explicitSdi: !!(tf & 0x2), samples });
  }
  return out;
}

// Sequential reads through a window, so a run of small fragments costs one storage read.
function windowed(read, size) {
  let base = 0, buf = new Uint8Array(0);
  return async (pos, len) => {
    if (pos + len > size) throw new Malformed('read past the end');
    if (pos < base || pos + len > base + buf.length) {
      base = pos;
      buf = await read(pos, Math.min(size - pos, Math.max(len, READ_WINDOW)));
      if (buf.length < len) throw new Error('short read');
    }
    return buf.subarray(pos - base, pos - base + len);
  };
}

// ---------- writing ----------

const u32 = (dv, o, x) => dv.setUint32(o, x >>> 0);
function boxHead(dv, o, size, type) { u32(dv, o, size); for (let i = 0; i < 4; i++) dv.setUint8(o + 4 + i, type.charCodeAt(i)); }

// One output fragment: moof (mfhd + a traf per track) + mdat with the kept samples' bytes.
// trafs: [{ tid, sdi, explicitSdi, out: [{ t, dur, flags, size, at }] }]; `src` holds the data.
function writeFragment(seq, trafs, src) {
  const trafSize = (tr) => 8 + (12 + 4 + (tr.explicitSdi ? 4 : 0)) + 20 + (20 + tr.out.length * 12);
  const moofSize = 8 + 16 + trafs.reduce((a, tr) => a + trafSize(tr), 0);
  const dataSize = trafs.reduce((a, tr) => a + tr.out.reduce((x, s) => x + s.size, 0), 0);
  const total = moofSize + 8 + dataSize;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  boxHead(dv, 0, moofSize, 'moof');
  boxHead(dv, 8, 16, 'mfhd'); u32(dv, 16, 0); u32(dv, 20, seq);
  let o = 24, data = moofSize + 8;
  for (const tr of trafs) {
    boxHead(dv, o, trafSize(tr), 'traf'); o += 8;
    const tfhdSize = 12 + 4 + (tr.explicitSdi ? 4 : 0);
    boxHead(dv, o, tfhdSize, 'tfhd'); u32(dv, o + 8, 0x020000 | (tr.explicitSdi ? 0x2 : 0)); u32(dv, o + 12, tr.tid);
    if (tr.explicitSdi) u32(dv, o + 16, tr.sdi);
    o += tfhdSize;
    boxHead(dv, o, 20, 'tfdt'); u32(dv, o + 8, 0x01000000); dv.setBigUint64(o + 12, BigInt(tr.out[0].t)); o += 20;
    const trunSize = 20 + tr.out.length * 12; // header, flags, count, data offset, then per sample
    boxHead(dv, o, trunSize, 'trun');
    u32(dv, o + 8, 0x000701); u32(dv, o + 12, tr.out.length); u32(dv, o + 16, data);
    let p = o + 20;
    for (const s of tr.out) {
      u32(dv, p, s.dur); u32(dv, p + 4, s.size); u32(dv, p + 8, s.flags); p += 12;
      out.set(src.subarray(s.at, s.at + s.size), data);
      data += s.size;
    }
    o += trunSize;
  }
  boxHead(dv, moofSize, 8 + dataSize, 'mdat');
  return out;
}

// ---------- the step ----------

const isSync = (flags) => !((flags >> 16) & 1);

// Opens a job: reads the header. `cuts` are in seconds of the primary (main) recording;
// `offset` puts this file on that clock (main time = this file's time + offset).
export async function startRedact(read, size) {
  const head = await read(0, Math.min(size, 256 * 1024));
  const first = boxAt(head, 0, head.length);
  if (!first || first.type !== 'ftyp') throw new Unsupported('not an MP4');
  let pos = 0, moov = null;
  while (pos + 8 <= head.length) {
    const box = boxAt(head, pos, head.length);
    if (!box || box.size === 0) break;
    if (box.type === 'moov') { moov = box; break; }
    if (box.type === 'moof' || box.type === 'mdat') break;
    pos += box.size;
  }
  if (!moov) throw new Unsupported('no moov at the start');
  if (moov.size > MAX_MOOV || moov.start + moov.size > size) throw new Malformed('moov');
  const mb = moov.start + moov.size > head.length ? await read(0, moov.start + moov.size) : head;
  const tracks = readMoov(mb, { ...moov, start: moov.start });
  const t = {};
  for (const [id, tr] of Object.entries(tracks)) t[id] = { ...tr, lastOut: -1, lastEnd: 0, chain: false, brk: false };
  return { v: 1, pos: moov.start + moov.size, headEnd: moov.start + moov.size, tracks: t, seen: false, started: false, extra: null, seq: 0, outPos: 0, segments: [], refs: [], maxEnd: 0, done: false };
}

// Works through fragments until the file ends or `budgetMs` passes, writing output segments with
// `writeSegment(chunks, size) → { key, size }` (chunks: Uint8Arrays, in order). Mutates and
// returns `state`; state.done when finished. A step that throws leaves `state` half-advanced:
// pass in a copy, and keep the one from before the step if it throws.
// `primary`: this is the main file (the one that sets the start trim, see the header).
export async function redactStep(read, size, state, { cuts, offset = 0, primary = true, budgetMs = 20000, writeSegment }) {
  const t0 = Date.now();
  const at = windowed(read, size);
  const tracks = state.tracks;
  const videoId = Object.keys(tracks).find((id) => tracks[id].kind === 'video');
  const hasAudio = Object.values(tracks).some((tr) => tr.kind === 'audio');
  // The start trim waits for the first key frame only where there is sound to hold back too.
  const holdStart = primary && videoId && hasAudio;
  let tl = new Timeline(effectiveCuts(cuts, state.extra));
  let pending = [], pendingBytes = 0;
  const flush = async () => {
    if (!pendingBytes) return;
    state.segments.push(await writeSegment(pending, pendingBytes));
    pending = []; pendingBytes = 0;
  };

  while (!state.done) {
    if (state.pos + 8 > size) { state.done = true; break; }
    const hb = await at(state.pos, Math.min(16, size - state.pos));
    const box = boxAt(hb, 0, hb.length);
    if (!box) throw new Malformed('not a box');
    if (box.size === 0) box.size = size - state.pos;
    if (state.pos + box.size > size || box.type === 'mfra') { state.done = true; break; } // a truncated tail, or the end
    if (box.type !== 'moof') { state.pos += box.size; continue; }
    // The moof and the mdat after it, read together. A recording cut off after its last moof
    // (the upload ended there) just ends.
    const after = state.pos + box.size;
    if (after + 8 > size) { state.done = true; break; }
    const mh = await at(after, Math.min(16, size - after));
    const mdat = boxAt(mh, 0, mh.length);
    if (!mdat || mdat.type !== 'mdat') throw new Malformed('a moof without its mdat');
    if (mdat.size === 0) mdat.size = size - state.pos - box.size;
    const fragLen = box.size + mdat.size;
    if (fragLen > MAX_FRAGMENT) throw new Malformed('a fragment too large');
    if (state.pos + fragLen > size) { state.done = true; break; }
    const frag = await at(state.pos, fragLen);
    let trafs;
    try { trafs = readMoof(frag, { type: 'moof', start: 0, size: box.size, hdr: box.hdr }, tracks, fragLen); }
    catch (e) {
      // What kind of file this is shows in its first fragment. A later one that looks like
      // another kind is damage, not a reason to hand out the stored file.
      if (e instanceof Unsupported && state.seen) throw new Malformed(`${e.message}, after the first fragment`);
      throw e;
    }

    // Video first: whether it may start yet decides the sound at the start.
    trafs.sort((a, b) => (tracks[a.tid].kind === 'video' ? 0 : 1) - (tracks[b.tid].kind === 'video' ? 0 : 1));
    const outTrafs = [];
    let refTime = null, refSync = false;
    for (const tr of trafs) {
      const st = tracks[tr.tid];
      const video = st.kind === 'video';
      const keep = [];
      for (const s of tr.samples) {
        const sec = s.dts / st.ts + offset; // on the main recording's clock
        let kept;
        if (video) {
          kept = !tl.inCut(sec) && (isSync(s.flags) || st.chain);
          if (kept && holdStart && !state.started) {
            // The first frame that can play: the trim stretches to it, sound and all. Everything
            // before it goes, kept parts too: with no key frame there, their picture can't be shown.
            if (sec > 0) { state.extra = [0, sec]; tl = new Timeline(effectiveCuts(cuts, state.extra)); }
          }
          if (kept) state.started = true;
          st.chain = kept;
          if (!kept) { if (st.lastOut >= 0) st.brk = true; continue; }
        } else {
          kept = (!holdStart || state.started) && !tl.inCut(sec + s.dur / st.ts / 2);
          if (!kept) continue;
        }
        // A camera frame from before the main recording's (edited) start has no time of its own:
        // it goes at 0, where the player holds the camera's first frame anyway, so that the frames
        // after it can still be decoded.
        let c = Math.round((tl.edited(sec) - offset) * st.ts);
        if (c < 0) { if (!video) continue; c = 0; }
        keep.push({ s, c, brk: video && st.brk });
        if (video) st.brk = false;
      }
      if (!keep.length) continue;
      // Times: each sample on the edited clock, except that video carries on from the frame
      // before it after a cut (that frame is held until its own time is over), and nothing goes
      // backwards. Durations are the gaps between them.
      const out = [];
      for (let i = 0; i < keep.length; i++) {
        const { s, c, brk } = keep[i];
        let t;
        if (st.lastOut < 0) t = video ? 0 : c; // the picture starts at 0 (Chrome times a file from its first frame)
        else if (video && brk) t = Math.max(st.lastEnd, st.lastOut + 1);
        else if (i === 0) t = Math.max(c, st.lastEnd);
        else t = Math.max(c, st.lastOut + 1);
        if (out.length) out[out.length - 1].dur = t - out[out.length - 1].t;
        // The last one runs to where it ends on the edited clock: a held frame to the end of its
        // own time, so the next fragment carries on with no gap.
        const dur = video ? Math.max(1, c + s.dur - t) : s.dur;
        out.push({ t, dur, flags: s.flags, size: s.size, at: s.at });
        st.lastOut = t;
        st.lastEnd = t + dur;
      }
      if (video) { refTime = out[0].t; refSync = isSync(out[0].flags); }
      const endTs = st.lastEnd / st.ts;
      if (endTs > state.maxEnd) state.maxEnd = endTs;
      outTrafs.push({ tid: tr.tid, sdi: tr.sdi, explicitSdi: tr.explicitSdi, out });
    }
    state.pos += fragLen;
    state.seen = true;
    if (outTrafs.length) {
      outTrafs.sort((a, b) => a.tid - b.tid);
      const bytes = writeFragment(++state.seq, outTrafs, frag);
      if (refTime !== null) state.refs.push({ off: state.outPos, time: refTime, sync: refSync });
      state.outPos += bytes.length;
      pending.push(bytes); pendingBytes += bytes.length;
      if (pendingBytes >= SEG_BYTES) await flush();
    }
    if (Date.now() - t0 > budgetMs) break;
  }
  await flush();
  return state;
}

// The header for a finished job: the original ftyp + moov and an index of the new fragments.
export async function finishRedact(read, state) {
  const head = await read(0, state.headEnd);
  const videoId = Object.keys(state.tracks).find((id) => state.tracks[id].kind === 'video');
  let sidx = null;
  const refs = state.refs;
  if (videoId && refs.length >= 2 && refs[0].off === 0) {
    const ts = state.tracks[videoId].ts;
    const list = refs.map((r, i) => {
      const next = refs[i + 1];
      return {
        bytes: (next ? next.off : state.outPos) - r.off,
        duration: Math.max(0, next ? next.time - r.time : Math.round(state.maxEnd * ts) - r.time),
        sync: r.sync,
      };
    });
    if (list.every((r) => r.bytes > 0 && r.bytes <= 0x7fffffff && r.duration <= 0xffffffff)) sidx = sidxBox(Number(videoId), ts, refs[0].time, list);
  }
  const out = new Uint8Array(head.length + (sidx ? sidx.length : 0));
  out.set(head, 0);
  if (sidx) out.set(sidx, head.length);
  return out;
}
