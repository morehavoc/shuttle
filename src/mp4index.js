// A fragment index for recorded MP4 files.
//
// MediaRecorder writes fragmented MP4: a header (moov) with no sample tables, then a run of
// moof+mdat fragments, and nothing that says where the fragments are. Before Chrome will play
// such a file it reads every fragment's header, one HTTP request each: a 20 MB camera file
// took 34 requests and 7.7 s to start (measured 2026-10-17). A 'sidx' box listing the
// fragments, placed in front of the first one, lets it start after two requests (0.3 s).
// Safari starts either way.
//
// The recorded file is never rewritten. The box is built once, stored with the video, and
// spliced in when the file is served (spliceRanges). That is safe only when fragments locate
// their data relative to themselves, so files whose fragments carry absolute file offsets
// (tfhd base-data-offset) are left alone.
//
// The parser takes hostile input calmly (security review, 2026-10-17): work is bounded by the
// bytes actually present (a sample count must fit its box; a long run of samples with no
// per-sample durations is multiplied, not looped), boxes must fit inside their parent, a moof
// over MAX_MOOF or a 64-bit size past 2^53 means "not a file to index", and the number of
// fragments is capped. Anything odd returns null: the file is then served as stored.

const MAX_MOOF = 1 << 20; // a recorder's moof is a few KB
const MAX_FRAGMENTS = 50000; // ~1 s fragments for 14 hours

const enc = (s) => [...s].map((c) => c.charCodeAt(0));
const typeOf = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

// The box header at o: { type, start, size, hdr }, or null if there isn't a sane one before `to`.
// size 0 ("to the end of the file") comes back as 0: only the caller knows where the file ends.
function boxAt(b, o, to) {
  if (o + 8 > to) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let size = dv.getUint32(o);
  let hdr = 8;
  if (size === 1) {
    if (o + 16 > to) return null;
    const big = dv.getBigUint64(o + 8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(big);
    hdr = 16;
  }
  if (size !== 0 && size < hdr) return null;
  return { type: typeOf(b, o + 4), start: o, size, hdr };
}

// The boxes inside a parent, each wholly inside it (a child running past its parent ends the list).
function boxesIn(b, from, to) {
  to = Math.min(to, b.length);
  const out = [];
  for (let o = from; ;) {
    const box = boxAt(b, o, to);
    if (!box) break;
    if (box.size === 0) box.size = to - o;
    if (o + box.size > to) break;
    out.push(box);
    o += box.size;
  }
  return out;
}

// Top-level box headers from the start of a buffer; the last may run past its end.
function topBoxes(b, to) {
  const out = [];
  for (let o = 0; ;) {
    const box = boxAt(b, o, to);
    if (!box || box.size === 0) break;
    out.push(box);
    o += box.size;
  }
  return out;
}

const child = (b, box, type) => boxesIn(b, box.start + box.hdr, box.start + box.size).find((x) => x.type === type);
const children = (b, box, type) => boxesIn(b, box.start + box.hdr, box.start + box.size).filter((x) => x.type === type);

// Per-track defaults from moov/mvex/trex, and the video track (id + timescale).
function readMoov(b, moov) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const trex = {};
  const mvex = child(b, moov, 'mvex');
  if (mvex) for (const t of children(b, mvex, 'trex')) {
    if (t.size < t.hdr + 24) continue;
    const o = t.start + t.hdr + 4;
    trex[dv.getUint32(o)] = { duration: dv.getUint32(o + 8), flags: dv.getUint32(o + 16) };
  }
  let video = null;
  const scales = {};
  for (const trak of children(b, moov, 'trak')) {
    const tk = child(b, trak, 'tkhd'), md = child(b, trak, 'mdia'), mh = md && child(b, md, 'mdhd');
    if (tk && mh) {
      const tid = dv.getUint32(tk.start + tk.hdr + (b[tk.start + tk.hdr] === 1 ? 20 : 12));
      scales[tid] = dv.getUint32(mh.start + mh.hdr + (b[mh.start + mh.hdr] === 1 ? 20 : 12));
    }
  }
  for (const trak of children(b, moov, 'trak')) {
    const tkhd = child(b, trak, 'tkhd');
    const mdia = child(b, trak, 'mdia');
    if (!tkhd || !mdia) continue;
    const hdlr = child(b, mdia, 'hdlr');
    const mdhd = child(b, mdia, 'mdhd');
    if (!hdlr || !mdhd || typeOf(b, hdlr.start + hdlr.hdr + 8) !== 'vide') continue;
    const tv = b[tkhd.start + tkhd.hdr];
    const id = dv.getUint32(tkhd.start + tkhd.hdr + (tv === 1 ? 20 : 12));
    const mv = b[mdhd.start + mdhd.hdr];
    const timescale = dv.getUint32(mdhd.start + mdhd.hdr + (mv === 1 ? 20 : 12));
    video = { id, timescale };
    break;
  }
  return { trex, video, scales };
}

// The video track's fragment in a moof: decode time, total duration, first-sample-is-sync.
// Returns null if this moof has no video fragment, 'absolute' if offsets are absolute, or 'bad'
// if a sample table doesn't fit its box.
function readMoof(b, moof, video, trex, scales) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let found = null, endSec = 0;
  for (const traf of children(b, moof, 'traf')) {
    const tfhd = child(b, traf, 'tfhd');
    if (!tfhd) continue;
    let o = tfhd.start + tfhd.hdr;
    const tf = dv.getUint32(o) & 0xffffff;
    const id = dv.getUint32(o + 4);
    if (tf & 0x1) return 'absolute';
    o += 8;
    if (tf & 0x2) o += 4; // sample description index
    const defDur = tf & 0x8 ? dv.getUint32(o) : (trex[id] ? trex[id].duration : 0);
    if (tf & 0x8) o += 4;
    if (tf & 0x10) o += 4; // default sample size
    const defFlags = tf & 0x20 ? dv.getUint32(o) : (trex[id] ? trex[id].flags : 0);
    const tfdt = child(b, traf, 'tfdt');
    if (!tfdt) continue;
    const vv = b[tfdt.start + tfdt.hdr];
    const time = vv === 1 ? Number(dv.getBigUint64(tfdt.start + tfdt.hdr + 4)) : dv.getUint32(tfdt.start + tfdt.hdr + 4);
    let duration = 0;
    let firstFlags = null;
    for (const trun of children(b, traf, 'trun')) {
      const boxEnd = trun.start + trun.size;
      let p = trun.start + trun.hdr;
      if (p + 8 > boxEnd) return 'bad';
      const rf = dv.getUint32(p) & 0xffffff;
      const n = dv.getUint32(p + 4);
      p += 8;
      if (rf & 0x1) p += 4; // data offset
      let first = null;
      if (rf & 0x4) { if (p + 4 > boxEnd) return 'bad'; first = dv.getUint32(p); p += 4; }
      // Per sample: duration (0x100), size (0x200), flags (0x400), composition offset (0x800).
      const per = (rf & 0x100 ? 4 : 0) + (rf & 0x200 ? 4 : 0) + (rf & 0x400 ? 4 : 0) + (rf & 0x800 ? 4 : 0);
      if (p + n * per > boxEnd) return 'bad';
      if (n === 0) continue;
      if (firstFlags === null) {
        if (first !== null) firstFlags = first; // first_sample_flags beats the sample's own
        else if (rf & 0x400) firstFlags = dv.getUint32(p + (rf & 0x100 ? 4 : 0) + (rf & 0x200 ? 4 : 0));
        else firstFlags = defFlags;
      }
      if (rf & 0x100) for (let i = 0; i < n; i++) duration += dv.getUint32(p + i * per);
      else duration += n * defDur; // no per-sample durations: no loop (n can be 2^32 in a bad file)
    }
    if (scales[id]) endSec = Math.max(endSec, (time + duration) / scales[id]);
    // sample_is_non_sync_sample is bit 16 of the sample flags.
    if (id === video.id) found = { time, duration, sync: firstFlags !== null && !((firstFlags >> 16) & 1) };
  }
  return found && { ...found, endSec };
}

// Builds the sidx for an MP4 of `size` bytes. `read(offset, length)` returns a Uint8Array.
// Returns { at, sidx } (insert sidx at byte `at`), or null if the file isn't one this can
// index: not MP4, not fragmented, already indexed, or fragments with absolute offsets.
export async function buildSidx(read, size) {
  const headLen = Math.min(size, 256 * 1024);
  let head = await read(0, headLen);
  let top = topBoxes(head, headLen);
  if (!top.length || top[0].type !== 'ftyp') return null;
  const moovBox = top.find((x) => x.type === 'moov');
  if (!moovBox) return null;
  if (moovBox.start + moovBox.size > headLen) {
    if (moovBox.start + moovBox.size > size || moovBox.size > 8 * 1024 * 1024) return null;
    head = await read(0, moovBox.start + moovBox.size);
    top = topBoxes(head, moovBox.start + moovBox.size);
  }
  const moov = top.find((x) => x.type === 'moov');
  let trex, video, scales;
  try { ({ trex, video, scales } = readMoov(head, moov)); } catch { return null; } // a field past its box
  if (!video || !video.timescale) return null;

  const frags = []; // { start, time, duration, sync }
  let pos = moov.start + moov.size;
  let firstMoofAt = -1;
  let guard = 0;
  let done = false;
  while (!done && pos + 8 <= size) {
    if (++guard > MAX_FRAGMENTS * 2) return null;
    // One read per fragment: the moof is a few KB, so 64 KB covers it and the next box's header.
    let base = pos;
    let buf = await read(pos, Math.min(64 * 1024, size - pos));
    for (;;) {
      const rel = pos - base;
      if (rel + 16 > buf.length && pos + 16 <= size) break; // header not in this buffer: read again
      const box = boxAt(buf, rel, buf.length);
      if (!box) return null; // not a box: not a file to index
      if (box.size === 0) box.size = size - pos; // runs to the end of the file
      if (box.type === 'sidx') return null; // already indexed
      if (box.type === 'mfra' || pos + box.size > size) { done = true; break; } // end, or a truncated tail
      if (box.type === 'moof') {
        if (box.size > MAX_MOOF || frags.length >= MAX_FRAGMENTS) return null;
        let mb = buf, mstart = rel;
        if (rel + box.size > buf.length) { mb = await read(pos, box.size); mstart = 0; }
        let f;
        try { f = readMoof(mb, { ...box, start: mstart }, video, trex, scales); } catch { return null; }
        if (f === 'absolute' || f === 'bad') return null;
        if (f) {
          if (firstMoofAt < 0) firstMoofAt = pos;
          frags.push({ start: pos, ...f });
        }
      }
      pos += box.size;
      if (pos + 8 > size) { done = true; break; }
      if (pos - base + 8 > buf.length) break;
    }
  }
  if (frags.length < 2) return null;
  const end = pos; // end of the last complete box

  const refs = frags.map((f, i) => {
    const next = i + 1 < frags.length ? frags[i + 1] : null;
    const bytes = (next ? next.start : end) - f.start;
    // The last one runs to the end of whichever track ends last (audio can outlast the video).
    const duration = next ? next.time - f.time : Math.max(f.duration, Math.round(f.endSec * video.timescale) - f.time);
    return { bytes, duration: Math.max(0, duration), sync: f.sync };
  });
  if (refs.some((r) => r.bytes <= 0 || r.bytes > 0x7fffffff || r.duration > 0xffffffff)) return null;

  const len = 8 + 4 + 4 + 4 + 8 + 8 + 2 + 2 + refs.length * 12;
  if (refs.length > 0xffff) return null;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  out.set(enc('sidx'), 4);
  dv.setUint32(8, 0x01000000); // version 1, flags 0
  dv.setUint32(12, video.id); // reference_ID
  dv.setUint32(16, video.timescale);
  // earliest_presentation_time. Decode times stand in for presentation times: MediaRecorder
  // writes no B-frames, so they are the same.
  dv.setBigUint64(20, BigInt(frags[0].time));
  dv.setBigUint64(28, 0n); // first_offset: the first fragment follows this box
  dv.setUint16(36, 0);
  dv.setUint16(38, refs.length);
  refs.forEach((r, i) => {
    const o = 40 + i * 12;
    dv.setUint32(o, r.bytes & 0x7fffffff); // reference_type 0 (media)
    dv.setUint32(o + 4, r.duration);
    dv.setUint32(o + 8, r.sync ? 0x90000000 : 0); // starts_with_SAP, SAP_type 1
  });
  return { at: firstMoofAt, sidx: out };
}

// The pieces of the served file (original with `insertLen` bytes inserted at `at`) that cover
// bytes start..end inclusive: [{ from: 'file', offset, length } | { from: 'sidx', offset, length }].
export function spliceRanges(start, end, at, insertLen) {
  const out = [];
  if (start < at) out.push({ from: 'file', offset: start, length: Math.min(end, at - 1) - start + 1 });
  const s2 = Math.max(start, at), e2 = Math.min(end, at + insertLen - 1);
  if (s2 <= e2) out.push({ from: 'sidx', offset: s2 - at, length: e2 - s2 + 1 });
  const s3 = Math.max(start, at + insertLen);
  if (s3 <= end) out.push({ from: 'file', offset: s3 - insertLen, length: end - s3 + 1 });
  return out;
}
