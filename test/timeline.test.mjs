// Unit tests for the edit timeline (pure functions). node test/timeline.test.mjs
import assert from 'node:assert/strict';
import {
  normalizeCuts, addCut, removeCut, keepSegments, editedDuration, toEdited, toSource, cutAt,
  wordRange, isWordCut, fillerCuts, pauseCuts, captionLines, isFiller, paragraphs,
} from '../public/timeline.js';

let n = 0, failed = 0;
const t = (name, fn) => { n++; try { fn(); console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

t('normalize sorts, clamps, merges, drops slivers', () => {
  assert.deepEqual(normalizeCuts([[5, 6], [1, 2], [1.5, 3], [-1, 0.01], [9, 12], [7, 7.01]], 10), [[1, 3], [5, 6], [9, 10]]);
});
t('normalize merges cuts closer than the merge gap', () => {
  assert.deepEqual(normalizeCuts([[1, 2], [2.05, 3]], 10), [[1, 3]]);
});
t('normalize ignores garbage', () => {
  assert.deepEqual(normalizeCuts([['a', 2], [null, null], [3, 4]], 10), [[3, 4]]);
  assert.deepEqual(normalizeCuts(null, 10), []);
});
t('keep segments are the complement', () => {
  assert.deepEqual(keepSegments([[1, 2], [5, 6]], 10), [[0, 1], [2, 5], [6, 10]]);
  assert.deepEqual(keepSegments([[0, 2], [8, 10]], 10), [[2, 8]]);
  assert.deepEqual(keepSegments([], 10), [[0, 10]]);
});
t('edited duration', () => {
  near(editedDuration([[1, 2], [5, 6]], 10), 8);
  near(editedDuration([[0, 10]], 10), 0);
});
t('toEdited / toSource round-trip on kept times', () => {
  const cuts = [[1, 2], [5, 6]];
  for (const src of [0, 0.5, 2, 3.3, 4.99, 6, 9.5]) near(toSource(toEdited(src, cuts), cuts, 10), src);
  near(toEdited(1.5, cuts), 1); // inside a cut → where it starts
  near(toSource(8, cuts, 10), 10);
});
t('cutAt finds the containing cut', () => {
  const cuts = [[1, 2], [5, 6]];
  assert.deepEqual(cutAt(1.2, cuts), [1, 2]);
  assert.equal(cutAt(2, cuts), null);
  assert.equal(cutAt(0.5, cuts), null);
});
t('add / remove cuts', () => {
  let c = addCut([], [1, 3], 10);
  c = addCut(c, [2, 4], 10);
  assert.deepEqual(c, [[1, 4]]);
  c = removeCut(c, [2, 3], 10);
  assert.deepEqual(c, [[1, 2], [3, 4]]);
  c = removeCut(c, [0, 10], 10);
  assert.deepEqual(c, []);
});

const words = [
  { w: 'Hello,', s: 0.5, e: 0.9 },
  { w: 'um', s: 1.0, e: 1.2 },
  { w: 'this', s: 1.3, e: 1.5 },
  { w: 'is', s: 1.55, e: 1.7 },
  { w: 'Shuttle.', s: 4.0, e: 4.6 },
];

t('word range takes part of the gap, never past neighbours', () => {
  const [s, e] = wordRange(words, 1, 1, 6);
  assert.ok(s >= 0.9 && s < 1.0, `start ${s}`);
  assert.ok(e > 1.2 && e <= 1.3, `end ${e}`);
  assert.ok(!isWordCut(words[0], [[s, e]]));
  assert.ok(isWordCut(words[1], [[s, e]]));
  assert.ok(!isWordCut(words[2], [[s, e]]));
});
t('cutting the first / last word stays near it (a silent intro or demo is kept)', () => {
  const [s0] = wordRange(words, 0, 0, 6);
  assert.ok(s0 > 0 && s0 >= words[0].s - 0.25, `start ${s0}`);
  const [, e4] = wordRange(words, 4, 4, 120);
  assert.ok(e4 <= words[4].e + 0.25, `end ${e4}`);
  // "Remove ums" on a recording that ends "…uh." then shows something for a minute.
  const tailUm = [{ w: 'done', s: 48, e: 49.5 }, { w: 'uh.', s: 49.7, e: 49.9 }];
  const c = fillerCuts(tailUm, 120);
  assert.ok(c[0][1] <= 50.2, `filler cut ${c}`);
  assert.deepEqual(fillerCuts([{ w: 'Um.', s: 10, e: 10.3 }], 60).map(([a, b]) => b - a <= 0.81), [true]);
});
t('restoring words removes exactly their cut', () => {
  const r = wordRange(words, 1, 3, 6);
  let c = addCut([], r, 6);
  c = removeCut(c, wordRange(words, 2, 2, 6), 6);
  assert.ok(isWordCut(words[1], c));
  assert.ok(!isWordCut(words[2], c));
  assert.ok(isWordCut(words[3], c));
});
t('filler words', () => {
  assert.ok(isFiller({ w: 'Um,' }));
  assert.ok(isFiller({ w: 'uhh' }));
  assert.ok(isFiller({ w: 'Hmm.' }));
  assert.ok(!isFiller({ w: 'umbrella' }));
  assert.ok(!isFiller({ w: 'are' }));
  const c = normalizeCuts(fillerCuts(words, 6), 6);
  assert.equal(c.length, 1);
  assert.ok(isWordCut(words[1], c));
});
t('pause cuts shorten long gaps and the tail', () => {
  const c = pauseCuts(words, [], 9);
  // gap 1.7 → 4.0 shortened, tail 4.6 → 9 trimmed; the 0.5 s lead-in kept
  assert.equal(c.length, 2);
  near(c[0][0], 1.7 + 0.35); near(c[0][1], 4.0 - 0.35);
  near(c[1][0], 4.6 + 0.6); near(c[1][1], 9);
});
t('pause cuts ignore words already cut', () => {
  const cuts = [wordRange(words, 4, 4, 9)]; // last word cut → tail starts after "is"
  const c = pauseCuts(words, cuts, 9);
  near(c[c.length - 1][0], 1.7 + 0.6);
});
t('pause cuts leave long silences alone (he is probably showing something)', () => {
  const ws = [{ w: 'Look', s: 0.5, e: 0.9 }, { w: 'here.', s: 1.0, e: 1.4 }, { w: 'Done.', s: 31.4, e: 31.8 }];
  assert.deepEqual(pauseCuts(ws, [], 100), []);
});
t('caption lines skip cut words and break on gaps', () => {
  const lines = captionLines(words, [wordRange(words, 1, 1, 6)]);
  assert.deepEqual(lines.map((l) => l.text), ['Hello, this is', 'Shuttle.']);
});
t('paragraphs break on long pauses', () => {
  assert.deepEqual(paragraphs(words), [[0, 1, 2, 3], [4]]);
});

console.log(`\n${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
