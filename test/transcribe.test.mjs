// Unit tests for turning Whisper responses into words. node test/transcribe.test.mjs
// Fixtures follow the response shapes documented for OpenAI whisper-1 (verbose_json with word
// timestamps) and Workers AI (@cf/openai/whisper, whisper-large-v3-turbo).
import assert from 'node:assert/strict';
import { wordsFromWhisper, punctuate, provider, snapToAudio as snapWith, pcmOfWav, pickTranscript, analyse, transcribeWav } from '../src/transcribe.js';
const snapToAudio = (words, pcm) => snapWith(words, analyse(pcm));

let n = 0, failed = 0;
const t = (name, fn) => { n++; try { fn(); console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };

t('OpenAI verbose_json: bare words get punctuation and case from segments', () => {
  const out = {
    text: 'Hello, um, this is Shuttle.',
    words: [
      { word: 'Hello', start: 0.1, end: 0.4 }, { word: 'um', start: 0.5, end: 0.6 },
      { word: 'this', start: 0.7, end: 0.8 }, { word: 'is', start: 0.85, end: 0.9 }, { word: 'Shuttle', start: 1.0, end: 1.4 },
    ],
    segments: [{ start: 0, end: 1.5, text: ' Hello, um, this is Shuttle.' }],
  };
  assert.deepEqual(wordsFromWhisper(out).map((w) => w.w), ['Hello,', 'um,', 'this', 'is', 'Shuttle.']);
});

t('times never step back: spoken order is kept', () => {
  const out = { words: [{ word: 'the', start: 1.0, end: 1.1 }, { word: 'metal', start: 1.25, end: 1.4 }, { word: 'roof.', start: 1.2, end: 1.5 }] };
  const ws = wordsFromWhisper(out);
  assert.deepEqual(ws.map((w) => w.w), ['the', 'metal', 'roof.']);
  for (let k = 1; k < ws.length; k++) assert.ok(ws[k].s >= ws[k - 1].s);
});

t('Workers AI @cf/openai/whisper: top-level words', () => {
  const out = { text: 'Hi there', word_count: 2, words: [{ word: 'Hi', start: 0, end: 0.3 }, { word: 'there', start: 0.35, end: 0.7 }] };
  assert.deepEqual(wordsFromWhisper(out), [{ w: 'Hi', s: 0, e: 0.3 }, { w: 'there', s: 0.35, e: 0.7 }]);
});

t('Workers AI turbo: words nested in segments', () => {
  const out = { segments: [
    { start: 0, end: 1, text: 'One, two.', words: [{ word: 'One,', start: 0, end: 0.4 }, { word: 'two.', start: 0.5, end: 0.9 }] },
    { start: 1, end: 2, text: 'Three.', words: [{ word: 'Three.', start: 1.1, end: 1.5 }] },
  ] };
  assert.deepEqual(wordsFromWhisper(out).map((w) => w.w), ['One,', 'two.', 'Three.']);
});

t('segments without word timing: words spread across the segment', () => {
  const out = { segments: [{ start: 2, end: 4, text: 'a b c d' }] };
  const w = wordsFromWhisper(out);
  assert.equal(w.length, 4);
  assert.equal(w[0].s, 2);
  assert.equal(w[3].e, 4);
});

t('garbage in, nothing out', () => {
  assert.deepEqual(wordsFromWhisper(null), []);
  assert.deepEqual(wordsFromWhisper({}), []);
  assert.deepEqual(wordsFromWhisper({ words: [{ word: '', start: 0, end: 1 }, { word: 'x', start: 'a', end: 1 }] }), []);
});

t('punctuate skips words it cannot match', () => {
  const words = [{ w: 'gonna' }, { w: 'go' }];
  punctuate(words, [{ text: 'Going to go.' }]);
  assert.deepEqual(words.map((w) => w.w), ['gonna', 'go.']);
});

t('provider order: fake, Workers AI, OpenAI, none', () => {
  assert.equal(provider({ TRANSCRIBE_FAKE: '1', AI: {}, OPENAI_API_KEY: 'k' }), 'fake');
  assert.equal(provider({ AI: {}, OPENAI_API_KEY: 'k' }), 'workers-ai');
  assert.equal(provider({ OPENAI_API_KEY: 'k' }), 'openai');
  assert.equal(provider({}), null);
});


// 16 kHz PCM with "speech" (noise) at the given [start, end] seconds.
function speechPcm(dur, spans) {
  const pcm = new Int16Array(Math.round(dur * 16000));
  for (const [a, b] of spans) for (let i = Math.round(a * 16000); i < Math.round(b * 16000); i++) pcm[i] = Math.round((Math.random() * 2 - 1) * 8000);
  for (let i = 0; i < pcm.length; i++) pcm[i] += Math.round((Math.random() * 2 - 1) * 30); // room noise
  return pcm;
}
const near = (a, b, tol = 0.035) => Math.abs(a - b) <= tol;

t('snap: words next to pauses move to where the sound starts and stops', () => {
  // Said: 0.50–1.00 and 1.06–1.40 (one phrase; the 60 ms dip is inside it), pause, 2.00–2.60.
  const pcm = speechPcm(3.2, [[0.5, 1.0], [1.06, 1.4], [2.0, 2.6]]);
  // Whisper, 0.3 s late throughout.
  const words = [{ w: 'Purple', s: 0.8, e: 1.1 }, { w: 'lanterns', s: 1.36, e: 1.7 }, { w: 'glow.', s: 2.3, e: 2.9 }];
  const out = snapToAudio(words, pcm);
  assert.ok(near(out[0].s, 0.48), `first start ${out[0].s}`);
  assert.equal(out[0].e, 1.1, 'no pause after the first word: kept');
  assert.equal(out[1].s, 1.36, 'no pause before the second: kept');
  assert.ok(near(out[1].e, 1.43), `end before the pause ${out[1].e}`);
  assert.ok(near(out[2].s, 1.98), `start after the pause ${out[2].s}`);
  assert.ok(near(out[2].e, 2.63), `last end ${out[2].e}`);
});

t('snap: a word Whisper starts early, inside the silence, moves to the sound', () => {
  const pcm = speechPcm(3.2, [[0.5, 1.4], [2.0, 2.6]]);
  const out = snapToAudio([{ w: 'one', s: 0.5, e: 1.3 }, { w: 'two', s: 1.55, e: 2.5 }], pcm);
  assert.ok(near(out[1].s, 1.98), `start ${out[1].s}`);
  assert.ok(near(out[0].e, 1.43), `end ${out[0].e}`);
});

t('snap: a word stretched across a whole pause isn\u2019t pinned to either side of it', () => {
  const pcm = speechPcm(3.2, [[0.5, 1.4], [2.0, 2.6]]);
  const [w] = snapToAudio([{ w: 'long', s: 1.2, e: 2.3 }], pcm);
  assert.equal(w.s, 1.2);
  assert.ok(near(w.e, 2.63), `only the end of the recording's sound applies: ${w.e}`);
});

t('pickTranscript: the prompted words (with ums) when they agree, else the plain ones', () => {
  const W = (text) => text.split(' ').map((w, i) => ({ w, s: i, e: i + 0.5 }));
  const plain = W('Copper wires hummed in the evening wind.');
  const withUms = W('Copper, um, wires hummed in the uh evening wind.');
  assert.equal(pickTranscript(withUms, plain), withUms);
  const invented = W("I'm not done. Yes, tiktok. I'm a blooper.");
  assert.equal(pickTranscript(invented, plain), plain);
  assert.equal(pickTranscript(W('Hmm, okay.'), plain), plain, 'a thin answer');
  assert.equal(pickTranscript(W('Copper wires hummed in the evening wind and then a lot more words appeared here.'), plain), plain, 'padded');
  assert.equal(pickTranscript(null, plain), plain);
  assert.deepEqual(pickTranscript(withUms, null), [], 'no reference, no words');
  assert.deepEqual(pickTranscript([], []), []);
  const echo = W('Copper wires hummed in the evening wind. Let me show you this.');
  assert.equal(pickTranscript(echo, plain), plain, 'the prompt echoed on the end');
  const none = [];
  assert.equal(pickTranscript(W('Yes tiktok.'), none), none, 'words invented over a wordless chunk');
  const ums = W('Um.');
  assert.equal(pickTranscript(ums, none), ums, 'only fillers over a wordless chunk are fine');
});

t('pickTranscript drops "um"s that sit on silence', () => {
  const pcm = speechPcm(3, [[0.2, 1.0], [1.8, 2.6]]);
  const plain = [{ w: 'Copper', s: 0.2, e: 0.6 }, { w: 'wires', s: 1.8, e: 2.5 }];
  const prompted = [{ w: 'Copper,', s: 0.2, e: 0.6 }, { w: 'um,', s: 1.2, e: 1.5 }, { w: 'uh,', s: 0.65, e: 0.95 }, { w: 'wires.', s: 1.8, e: 2.5 }];
  assert.deepEqual(pickTranscript(prompted, plain, analyse(pcm)).map((w) => w.w), ['Copper,', 'uh,', 'wires.']);
});

t('snap never reorders words (a click before the first word, a word Whisper put early)', () => {
  // A click at 0.05–0.1, a pause, then "I think so." from 0.6.
  const pcm = speechPcm(3, [[0.05, 0.1], [0.6, 0.75], [0.8, 1.3], [1.35, 1.8]]);
  const ws = [{ w: 'I', s: 0.6, e: 0.75 }, { w: 'think', s: 0.9, e: 1.3 }, { w: 'so.', s: 1.35, e: 1.8 }];
  const out = snapToAudio(ws, pcm);
  for (let k = 1; k < out.length; k++) assert.ok(out[k].s >= out[k - 1].s, JSON.stringify(out));
  // Fuzz: random late/early Whisper times over random sound never come back out of order.
  for (let r = 0; r < 300; r++) {
    const spans = [], words = [];
    let t = Math.random() * 0.5;
    while (t < 5) {
      const len = 0.15 + Math.random() * 0.5;
      spans.push([t, t + len]);
      const off = (Math.random() - 0.3) * 0.7;
      words.push({ w: 'w' + words.length, s: Math.max(0, t + off), e: Math.max(0, t + off) + len });
      t += len + (Math.random() < 0.4 ? 0.2 + Math.random() * 0.8 : 0.02);
    }
    if (Math.random() < 0.5) spans.unshift([0.02, 0.06]);
    words.sort((x, y) => x.s - y.s);
    const o = snapToAudio(words, speechPcm(5.5, spans));
    for (let k = 1; k < o.length; k++) assert.ok(o[k].s >= o[k - 1].s && o[k].e > o[k].s, `run ${r}: ${JSON.stringify(o)}`);
  }
});

await (async () => {
  // transcribeWav makes exactly two provider calls per chunk, and only plain falls back.
  let calls = 0;
  const env = { AI: { run: async (model, input) => { calls++; return { text: 'hi there', words: [{ word: 'hi', start: 0.1, end: 0.3 }, { word: 'there', start: 0.4, end: 0.8 }] }; } } };
  const pcm = speechPcm(2, [[0.1, 0.8]]);
  const buf = new ArrayBuffer(44 + pcm.length * 2); const dv = new DataView(buf); const u8 = new Uint8Array(buf);
  const str = (o, x) => { for (let i = 0; i < x.length; i++) u8[o + i] = x.charCodeAt(i); };
  str(0, 'RIFF'); str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true); str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  pcm.forEach((x, i) => dv.setInt16(44 + i * 2, x, true));
  await transcribeWav(env, buf, 2000);
  n++;
  if (calls === 2) console.log('  ok   two Whisper calls per chunk (prompted + plain)');
  else { failed++; console.log('  FAIL two Whisper calls per chunk — made', calls); }
})();

t('snap: running speech, silence-only audio and far-off words are left alone', () => {
  const words = [{ w: 'a', s: 0.2, e: 0.5 }, { w: 'b', s: 0.55, e: 0.9 }];
  assert.deepEqual(snapToAudio(words, speechPcm(1.2, [[0, 1.2]])), words);
  assert.deepEqual(snapToAudio(words, speechPcm(1.2, [])), words);
  // A word starting 1.2 s after the sound does isn't that sound's start (its end still snaps).
  const far = snapToAudio([{ w: 'x', s: 1.7, e: 2.0 }], speechPcm(2.4, [[0.5, 2.1]]));
  assert.equal(far[0].s, 1.7);
  assert.ok(near(far[0].e, 2.13), `end ${far[0].e}`);
});

t('pcmOfWav reads the data chunk', () => {
  const pcm = new Int16Array([1, -2, 3, 32767]);
  const buf = new ArrayBuffer(44 + 8); const dv = new DataView(buf); const u8 = new Uint8Array(buf);
  const str = (o, x) => { for (let i = 0; i < x.length; i++) u8[o + i] = x.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 44, true); str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true);
  str(36, 'data'); dv.setUint32(40, 8, true); pcm.forEach((x, i) => dv.setInt16(44 + i * 2, x, true));
  assert.deepEqual([...pcmOfWav(buf)], [1, -2, 3, 32767]);
});

console.log(`\n${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
