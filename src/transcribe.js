// Speech → words with timestamps, one half-minute WAV chunk at a time.

import { isFiller, bare } from '../public/timeline.js';
// Providers, in order: Workers AI (production binding `AI`), OpenAI (OPENAI_API_KEY),
// a fake (TRANSCRIBE_FAKE, tests only). With none, transcripts are off.

// Nudges Whisper to keep "um"/"uh" in the text, so they can be cut.
const PROMPT = 'Um, so, uh, I was like, hmm, okay. Let me show you this.';

export function provider(env) {
  if (env.TRANSCRIBE_FAKE) return 'fake';
  if (env.AI) return 'workers-ai';
  if (env.OPENAI_API_KEY) return 'openai';
  return null;
}

// Returns [{ w, s, e }] with seconds relative to the start of the chunk.
export async function transcribeWav(env, bytes, durationMs) {
  const p = provider(env);
  if (p === 'fake') return fakeWords(durationMs);
  if (!p) throw new Error('No transcription provider');
  const audio = p === 'workers-ai' ? toBase64(bytes) : null; // encoded once, for both calls
  const run = (prompt) => (p === 'workers-ai' ? workersAi(env, bytes, audio, prompt) : openAi(env, bytes, prompt));
  // The prompt keeps "um"s in the text (so they can be cut), but Whisper sometimes answers a
  // prompted chunk with invented sentences. The plain version is the reference and must work;
  // the prompted one is used only where it says the same thing.
  const [prompted, plain] = await Promise.allSettled([run(PROMPT), run(null)]);
  if (plain.status === 'rejected') throw plain.reason;
  const a = prompted.status === 'fulfilled' ? prompted.value : null;
  const sound = analyse(pcmOfWav(bytes));
  const words = pickTranscript(a, plain.value, sound);
  console.log(`transcript chunk: ${words === plain.value ? 'plain' : 'prompted'} (${a ? a.length : 'failed'} vs ${plain.value.length} words)`);
  return snapToAudio(words, sound);
}

// The prompted words if, fillers aside, they match the plain ones both ways; else the plain
// ones. Filler words that sit on silence (invented) are dropped.
export function pickTranscript(prompted, plain, sound = null) {
  if (!prompted) return plain || [];
  if (!plain) return [];
  const said = (ws) => ws.filter((w) => !isFiller(w)).map((w) => bare(w.w)).filter(Boolean);
  const a = said(prompted), b = said(plain);
  let agrees;
  if (!b.length) agrees = !a.length; // the plain one heard no words; only fillers may be added
  else {
    const pool = new Map();
    for (const w of a) pool.set(w, (pool.get(w) || 0) + 1);
    let shared = 0;
    for (const w of b) if (pool.get(w)) { shared++; pool.set(w, pool.get(w) - 1); }
    agrees = shared / b.length >= 0.85 && shared / a.length >= 0.85;
  }
  if (!agrees) return plain;
  if (!sound) return prompted;
  const kept = prompted.filter((w) => !isFiller(w) || loudShare(sound, w.s, w.e) >= 0.3);
  return kept.length === prompted.length ? prompted : kept;
}

// 16-bit mono PCM samples of a WAV (our own chunks: 16 kHz), or null.
export function pcmOfWav(bytes) {
  const u8 = new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let o = 12; o + 8 <= u8.length;) {
    const id = String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    const size = dv.getUint32(o + 4, true);
    if (id === 'data') {
      const start = o + 8, len = Math.min(size, u8.length - start) & ~1;
      const copy = u8.slice(start, start + len);
      return new Int16Array(copy.buffer);
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

const FRAME = 0.01;

// Loudness every 10 ms, a speech/silence threshold and the pauses (quiet for 150 ms or more;
// shorter dips are inside words: "p", "t", "k"). Null when there's nothing to go by.
export function analyse(pcm, rate = 16000) {
  if (!pcm || pcm.length < rate * 0.3) return null;
  const hop = Math.round(rate * FRAME), env = [];
  for (let i = 0; i + hop <= pcm.length; i += hop) {
    let q = 0;
    for (let j = i; j < i + hop; j += 2) q += pcm[j] * pcm[j]; // every other sample is plenty
    env.push(Math.sqrt(q / (hop / 2)) / 32768);
  }
  const sorted = [...env].sort((x, y) => x - y);
  const level = sorted[Math.floor(sorted.length * 0.95)], floor = sorted[Math.floor(sorted.length * 0.1)];
  if (level < 0.003) return null;
  const thr = Math.max(level * 0.06, floor * 2.5, 0.0015);
  const pauses = [];
  for (let i = 0; i < env.length;) {
    if (env[i] >= thr) { i++; continue; }
    let j = i;
    while (j < env.length && env[j] < thr) j++;
    if ((j - i) * FRAME >= 0.15) pauses.push([i * FRAME, j * FRAME]);
    i = j;
  }
  return { env, thr, pauses, end: env.length * FRAME };
}

function loudShare(sound, s, e) {
  const a = Math.max(0, Math.floor(s / FRAME)), b = Math.min(sound.env.length, Math.ceil(e / FRAME));
  if (b <= a) return 0;
  let n = 0;
  for (let i = a; i < b; i++) if (sound.env[i] >= sound.thr) n++;
  return n / (b - a);
}

// Whisper's word times are rough (often a few tenths of a second off, early or late). Where the
// audio has a real pause, the words on either side of it are moved to its edges, so cutting a
// word (or shortening a pause) cuts what was actually said there. Words in running speech are
// kept, and words never change order: if anything would, the words come back untouched.
export function snapToAudio(words, sound) {
  if (!words.length || !sound) return words;
  const out = words.map((w) => ({ ...w }));
  const n = out.length;
  const setStart = (k, t) => {
    const w = out[k];
    if (Math.abs(w.s - t) > 0.6 || w.e <= t + 0.05) return;
    if (k > 0 && t < out[k - 1].s) return;
    if (k + 1 < n && t > out[k + 1].s) return;
    w.s = t;
  };
  const setEnd = (k, t) => { const w = out[k]; if (Math.abs(w.e - t) <= 0.6 && t > w.s + 0.05) w.e = t; };
  const used = new Set();
  for (const [ps, pe] of sound.pauses) {
    if (ps <= 0.02) { if (out[0].e > pe) setStart(0, Math.max(0, pe - 0.02)); continue; } // before the first word
    if (pe >= sound.end - 0.02) { if (out[n - 1].s < ps) setEnd(n - 1, ps + 0.03); continue; } // after the last
    // Inside: of the neighbouring pairs the pause falls between, the one whose gap (by
    // Whisper's times) is closest to it.
    let best = -1, dist = 0.6;
    for (let k = 0; k + 1 < n; k++) {
      if (used.has(k) || !(out[k].s < ps && out[k + 1].e > pe)) continue;
      const d = Math.abs((out[k].e + out[k + 1].s) / 2 - (ps + pe) / 2);
      if (d < dist) { dist = d; best = k; }
    }
    if (best < 0) continue;
    used.add(best);
    setEnd(best, ps + 0.03);
    setStart(best + 1, Math.max(0, pe - 0.02));
  }
  for (let k = 1; k < n; k++) if (out[k].s < out[k - 1].s) return words;
  return out;
}

async function workersAi(env, bytes, audio, prompt) {
  const input = { audio, task: 'transcribe', language: env.TRANSCRIBE_LANGUAGE || 'en' };
  if (prompt) input.initial_prompt = prompt;
  try {
    const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', input);
    const words = wordsFromWhisper(out);
    if (words.length || !String(out && out.text || '').trim()) return words;
    if (prompt) throw new Error('no word timings');
  } catch (e) {
    if (prompt) throw e; // only the plain call falls back
    console.error('whisper-large-v3-turbo failed, trying whisper:', e && e.message);
  }
  const out = await env.AI.run('@cf/openai/whisper', { audio: [...new Uint8Array(bytes)] });
  return wordsFromWhisper(out);
}

async function openAi(env, bytes, prompt) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'audio/wav' }), 'chunk.wav');
  fd.append('model', 'whisper-1');
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'word');
  fd.append('timestamp_granularities[]', 'segment');
  fd.append('language', env.TRANSCRIBE_LANGUAGE || 'en');
  if (prompt) fd.append('prompt', prompt);
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: fd,
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return wordsFromWhisper(await r.json());
}

// Accepts the shapes Whisper endpoints return:
//   { words: [{ word, start, end }], segments?: [{ text }] }            (OpenAI, @cf/openai/whisper)
//   { segments: [{ start, end, text, words?: [{ word, start, end }] }] } (whisper-large-v3-turbo)
export function wordsFromWhisper(out) {
  if (!out || typeof out !== 'object') return [];
  const segs = Array.isArray(out.segments) ? out.segments : [];
  let words = [];
  if (Array.isArray(out.words) && out.words.length) {
    words = out.words.map(toWord);
  } else if (segs.some((s) => Array.isArray(s.words) && s.words.length)) {
    words = segs.flatMap((s) => (s.words || []).map(toWord));
  } else {
    // Segment timing only: spread each segment's words across it.
    for (const s of segs) {
      const toks = String(s.text || '').trim().split(/\s+/).filter(Boolean);
      const span = Math.max(0, Number(s.end) - Number(s.start));
      toks.forEach((t, i) => words.push({ w: t, s: Number(s.start) + (span * i) / toks.length, e: Number(s.start) + (span * (i + 1)) / toks.length }));
    }
  }
  words = words.filter((w) => w.w && Number.isFinite(w.s) && Number.isFinite(w.e)).map((w) => ({ ...w, e: Math.max(w.e, w.s) }));
  if (segs.length && !words.some((w) => /[.,!?;:]$/.test(w.w))) punctuate(words, segs);
  // Spoken order is the order Whisper gives; its times can step back a little ("metal" 20 ms
  // before "roof" ends up after it). Keep the order, make the times follow it.
  let last = 0;
  return words.map((w) => {
    const s = Math.max(w.s, last);
    last = s;
    return { w: w.w, s: round(s), e: round(Math.max(w.e, s)) };
  });
}

function toWord(x) {
  return { w: String(x.word ?? x.text ?? '').trim(), s: Number(x.start), e: Number(x.end) };
}

const norm = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// Word-level output often drops punctuation and case; borrow them from the segment text.
export function punctuate(words, segments) {
  const toks = segments.flatMap((s) => String(s.text || '').trim().split(/\s+/)).filter(Boolean);
  let j = 0;
  for (const w of words) {
    const nw = norm(w.w);
    if (!nw) continue;
    for (let k = j; k < Math.min(toks.length, j + 4); k++) {
      if (norm(toks[k]) === nw) { w.w = toks[k]; j = k + 1; break; }
    }
  }
  return words;
}

const FAKE = ['Hello,', 'um,', 'this', 'is', 'a', 'quick', 'Shuttle', 'test.', 'Here', 'is', 'the', 'second', 'part,', 'uh,', 'and', 'that', 'is', 'it.'];
function fakeWords(durationMs) {
  const out = [];
  const end = durationMs / 1000;
  let t = 0.3, i = 0;
  while (t + 0.3 < end) {
    out.push({ w: FAKE[i % FAKE.length], s: round(t), e: round(t + 0.3) });
    t += i % FAKE.length === 7 ? 2.2 : 0.45; // a long pause after "test."
    i++;
  }
  return out;
}

function toBase64(bytes) {
  const u8 = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function round(x) { return Math.round(x * 1000) / 1000; }
