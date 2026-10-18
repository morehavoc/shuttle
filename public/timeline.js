// Non-destructive editing: a video's edits are a list of cut ranges [start, end] in
// seconds of the original recording. Playback skips them; the file is never rewritten.
// Pure functions, shared by the player, the editor and the tests (node imports this file).

const MIN_CUT = 0.04; // ignore slivers shorter than this
const MERGE_GAP = 0.06; // cuts closer than this merge into one

// Sort, clamp to [0, duration], drop slivers, merge overlaps.
export function normalizeCuts(cuts, duration = Infinity) {
  const out = [];
  const list = (Array.isArray(cuts) ? cuts : [])
    .map((c) => [Number(c[0]), Number(c[1])])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e))
    .map(([s, e]) => [Math.max(0, Math.min(s, e)), Math.min(duration, Math.max(s, e))])
    .filter(([s, e]) => e - s >= MIN_CUT)
    .sort((a, b) => a[0] - b[0]);
  for (const [s, e] of list) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + MERGE_GAP) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out.map(([s, e]) => [round(s), round(e)]);
}

export function addCut(cuts, range, duration) {
  return normalizeCuts([...cuts, range], duration);
}

// cuts minus [s, e]
export function removeCut(cuts, [s, e], duration) {
  const out = [];
  for (const [a, b] of cuts) {
    if (b <= s || a >= e) { out.push([a, b]); continue; }
    if (a < s) out.push([a, s]);
    if (b > e) out.push([e, b]);
  }
  return normalizeCuts(out, duration);
}

// The parts that play: complement of the cuts inside [0, duration]. Slivers left between a cut
// and the start or end are dropped: cuts are stored to the millisecond, so a trim to the end
// of a 9.31533 s file stops at 9.315 and would otherwise leave a third of a millisecond
// "playing" after it (and Play, finding it, would not start over from the beginning).
export function keepSegments(cuts, duration) {
  const segs = [];
  let t = 0;
  for (const [s, e] of normalizeCuts(cuts, duration)) {
    if (s > t) segs.push([t, s]);
    t = Math.max(t, e);
  }
  if (duration > t) segs.push([t, duration]);
  const real = segs.filter(([s, e]) => e - s >= MIN_CUT);
  return real.length ? real : segs;
}

// The trim, { start, end } in seconds of the recording (end null: to the end), as cuts. The end
// cut runs past any length, and normalizeCuts clamps it to the length at hand: browsers read
// the same file's length differently (by up to half a second), so a stored end of the file
// would leave a Safari viewer a piece of what was trimmed.
export const TRIM_END = 1e7;
export function trimCuts(trim) {
  const out = [];
  if (!trim) return out;
  if (trim.start > 0) out.push([0, trim.start]);
  if (typeof trim.end === 'number' && Number.isFinite(trim.end)) out.push([trim.end, TRIM_END]);
  return out;
}

// What playback skips: the cuts and the trim together.
export function withTrim(cuts, trim, duration = Infinity) {
  return normalizeCuts([...(cuts || []), ...trimCuts(trim)], duration);
}

export function editedDuration(cuts, duration) {
  return keepSegments(cuts, duration).reduce((sum, [s, e]) => sum + (e - s), 0);
}

// Original time → edited time (a time inside a cut maps to where the cut starts).
export function toEdited(t, cuts) {
  let removed = 0;
  for (const [s, e] of cuts) {
    if (t <= s) break;
    removed += Math.min(t, e) - s;
  }
  return Math.max(0, t - removed);
}

// Edited time → original time.
// A time on a boundary maps to the start of the next kept part, so seeking there skips the cut.
export function toSource(te, cuts, duration) {
  const segs = keepSegments(cuts, duration);
  let acc = 0;
  for (const [s, e] of segs) {
    const len = e - s;
    if (te < acc + len) return s + Math.max(0, te - acc);
    acc += len;
  }
  return segs.length ? segs[segs.length - 1][1] : duration;
}

// The cut containing t, or null.
export function cutAt(t, cuts) {
  for (const c of cuts) {
    if (t >= c[0] && t < c[1]) return c;
    if (c[0] > t) break;
  }
  return null;
}

export function isWordCut(word, cuts) {
  const mid = (word.s + word.e) / 2;
  return !!cutAt(mid, cuts);
}

// The time range that removing words i..j should cut. Takes up to 0.25 s of the silence
// on each side (never more than half a gap) so neighbouring words aren't clipped. The first
// and last words get the same margin: the silence before or after them may be him showing
// something, and Shorten pauses deals with plain silence.
export function wordRange(words, i, j, duration) {
  const first = words[i], last = words[j];
  const before = words[i - 1] ? words[i - 1].e : 0;
  const after = words[j + 1] ? words[j + 1].s : duration;
  const start = Math.max(before, first.s - Math.min(0.25, Math.max(0, first.s - before) / 2));
  const end = Math.min(after, last.e + Math.min(0.25, Math.max(0, after - last.e) / 2));
  return [round(start), round(end)];
}

const FILLER = /^(u+m+|u+h+m*|e+r+m*|a+h+|h+m+|m+h*m+|mhm)$/i;
export const bare = (w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');

export function isFiller(word) {
  return FILLER.test(bare(word.w));
}

export function fillerCuts(words, duration) {
  const out = [];
  words.forEach((w, i) => { if (isFiller(w)) out.push(wordRange(words, i, i, duration)); });
  return out;
}

// Silences between the words that still play → cut down to `keep` seconds a side. Only pauses
// up to `longest` seconds (as they play now): a longer silence in a screen recording is
// usually him showing something.
export function pauseCuts(words, cuts, duration, { maxGap = 1.0, keep = 0.35, tail = 0.6, longest = 8 } = {}) {
  const kept = words.filter((w) => !isWordCut(w, cuts));
  const out = [];
  if (!kept.length) return out;
  const plays = (a, b) => (b - a) - overlap(cuts, a, b);
  const fits = (a, b) => plays(a, b) > maxGap && plays(a, b) <= longest;
  if (fits(0, kept[0].s)) out.push([0, kept[0].s - keep]);
  for (let i = 1; i < kept.length; i++) {
    const a = kept[i - 1].e, b = kept[i].s;
    if (fits(a, b)) out.push([a + keep, b - keep]);
  }
  const lastEnd = kept[kept.length - 1].e;
  if (fits(lastEnd, duration)) out.push([lastEnd + tail, duration]);
  return out.map(([s, e]) => [round(s), round(e)]);
}

// Seconds of [a, b] already cut.
function overlap(cuts, a, b) {
  let t = 0;
  for (const [s, e] of cuts) t += Math.max(0, Math.min(b, e) - Math.max(a, s));
  return t;
}

// Caption lines from the words that play: break on pauses, sentence ends and length.
export function captionLines(words, cuts, { maxChars = 42, gap = 0.7 } = {}) {
  const lines = [];
  let cur = null;
  for (const w of words) {
    if (isWordCut(w, cuts)) continue;
    const text = String(w.w).trim();
    if (!text) continue;
    const brk = !cur || w.s - cur.e > gap || (cur.text + ' ' + text).length > maxChars || /[.!?]$/.test(cur.text);
    if (brk) { cur = { s: w.s, e: w.e, text }; lines.push(cur); }
    else { cur.text += ' ' + text; cur.e = w.e; }
  }
  return lines;
}

// Paragraphs for the transcript panel: break on long pauses.
export function paragraphs(words, { gap = 1.6, maxWords = 90 } = {}) {
  const out = [];
  let cur = [];
  words.forEach((w, i) => {
    if (cur.length && (w.s - words[i - 1].e > gap || cur.length >= maxWords && /[.!?]$/.test(words[i - 1].w))) {
      out.push(cur);
      cur = [];
    }
    cur.push(i);
  });
  if (cur.length) out.push(cur);
  return out;
}

function round(x) { return Math.round(x * 1000) / 1000; }
