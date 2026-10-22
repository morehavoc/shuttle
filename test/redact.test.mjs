// The redacted copy (src/redact.js), checked by what a decoder gets out of it. Needs ffmpeg.
// node test/redact.test.mjs
//
// The fixtures (media-fixtures.mjs) say when every frame and every bit of sound was recorded, and
// the parts that get cut sound "secret", so decoding the copy shows exactly what is in it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRedact, redactStep, finishRedact, Unsupported, Timeline, effectiveCuts } from '../src/redact.js';
import { dir, FPS, SECRET, PITCHES, ff, fixture, frames, tones, srcOf, seams } from './media-fixtures.mjs';

let n = 0, failed = 0;
const t = async (name, fn) => { n++; try { await fn(); console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.stack.split('\n').slice(0, 3).join('\n        ')); } };

// Runs a whole job, `budgetMs` per step, the state through JSON between steps (as D1 stores it).
async function redact(file, cuts, { offset = 0, primary = true, budgetMs = 20000 } = {}) {
  const buf = new Uint8Array(fs.readFileSync(file));
  const reads = { n: 0, bytes: 0 };
  const read = async (o, l) => { reads.n++; reads.bytes += l; if (o + l > buf.length) throw new Error('read past end'); return buf.slice(o, o + l); };
  const segs = [];
  let st = JSON.parse(JSON.stringify(await startRedact(read, buf.length)));
  let steps = 0;
  while (!st.done) {
    st = await redactStep(read, buf.length, st, { cuts, offset, primary, budgetMs, writeSegment: async (b) => { segs.push(b); return { key: `s${segs.length}`, size: b.length }; } });
    st = JSON.parse(JSON.stringify(st));
    if (++steps > 10000) throw new Error('no progress');
  }
  const head = await finishRedact(read, st);
  const out = Buffer.concat([head, ...segs]);
  const outFile = file.replace(/\.mp4$/, `.out${Math.random().toString(36).slice(2, 7)}.mp4`);
  fs.writeFileSync(outFile, out);
  return { outFile, out, state: st, steps, segs, head, reads };
}

const close = (a, b, eps) => Math.abs(a - b) <= eps;

// ---------- the main case: a recording with a start trim, two cuts and an end trim ----------
const CUTS = [[0, 0.7], [3.3, 4.6], [6.2, 6.5], [9.4, 1e7]];
const main = fixture('main.mp4', { secret: CUTS.map(([s, e]) => [s, Math.min(e, 99)]) });
const r = await redact(main, CUTS);
const eff = new Timeline(effectiveCuts(CUTS, r.state.extra));

await t('the start trim moves on to the next key frame, and only that far', () => {
  const key = frames(main).find((f) => f.n === 30).t; // the second key frame
  assert.equal(r.state.extra[0], 0);
  assert.ok(close(r.state.extra[1], key, 1e-5), `${r.state.extra[1]} vs ${key}`);
});

await t('ffmpeg decodes the copy with no errors', () => {
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', r.outFile, '-f', 'null', '-']);
});

const SRC = srcOf(main);
const fr = frames(r.outFile);
await t('no frame from inside a cut or the trims', () => {
  assert.ok(fr.length > 100, `${fr.length} frames`);
  const bad = fr.filter((f) => eff.inCut(SRC.get(f.n)));
  assert.equal(bad.length, 0, `frames from cut time: ${bad.slice(0, 5).map((f) => f.n).join(', ')}`);
});

await t('every frame plays at its edited time, or early by at most the key-frame gap (the held frame)', () => {
  let held = 0;
  for (const f of fr) {
    const want = eff.edited(SRC.get(f.n));
    const early = want - f.t;
    assert.ok(early > -0.02 && early <= 1.0 + 0.02, `frame ${f.n} at ${f.t}, edited time ${want}`);
    if (early > 0.02) held++;
  }
  // Exactly the frames right after the two cuts that end between key frames (4.6 and 6.5).
  assert.equal(held, 2, `${held} frames shown early`);
});

await t('frames come in order, none repeated, and the picture never has a gap (it holds a frame instead)', () => {
  for (let i = 1; i < fr.length; i++) {
    assert.ok(fr[i].n > fr[i - 1].n && fr[i].t > fr[i - 1].t, `at ${i}`);
    // A long frame is only ever the one held after a cut: shown early, until its successor's time.
    const heldEarly = eff.edited(SRC.get(fr[i - 1].n)) - fr[i - 1].t > 0.02;
    assert.ok(fr[i].t - fr[i - 1].t < 0.1 || heldEarly, `no frame from ${fr[i - 1].t} to ${fr[i].t}`);
  }
  assert.ok(fr[0].t < 0.02, `first frame at ${fr[0].t}`);
  assert.deepEqual(seams(r.outFile), [], 'each frame lasts until the next one starts');
});

await t('every frame outside the cuts that can be decoded is there', () => {
  // Kept: everything outside the cuts, except from a cut's end to the next key frame.
  const have = new Set(fr.map((f) => f.n));
  const missing = [];
  for (const [k, s] of SRC) {
    if (s >= 9.4) continue;
    if (eff.inCut(s)) continue;
    const afterCut = (s >= 4.6 && s < 5.05) || (s >= 6.5 && s < 7.05);
    if (!afterCut && !have.has(k)) missing.push(`${k}@${s.toFixed(3)}`);
  }
  assert.deepEqual(missing, []);
});

const tn = tones(r.outFile);
await t('no secret sound: under 30 ms of it at each cut edge (AAC frames overlap)', () => {
  const secret = tn.filter((w) => w.f === SECRET);
  // Edges: four (two cuts), plus the trims' one each.
  assert.ok(secret.length <= 6 * 3, `${secret.length * 10} ms of secret tone: at ${secret.map((w) => w.t.toFixed(2)).join(' ')}`);
});

await t('the sound plays at its edited time (lip sync within 30 ms)', () => {
  // The pitch says which 100 ms the sound is from (mod 600 ms); compare with where it should be.
  const inv = (te) => { // edited → original
    let acc = 0, prev = 0;
    for (const [s, e] of effectiveCuts(CUTS, r.state.extra)) {
      if (te < acc + (s - prev)) return prev + (te - acc);
      acc += s - prev; prev = e;
    }
    return prev + (te - acc);
  };
  let checked = 0, wrong = 0;
  for (const w of tn) {
    if (w.f === null || w.f === SECRET) continue;
    const mid = w.t + 0.005;
    const src = inv(mid);
    const pos = (src * 10) % 1; // where inside its 100 ms step: skip windows near a step change
    if (pos < 0.35 || pos > 0.65) continue;
    checked++;
    if (PITCHES[Math.floor(src * 10) % PITCHES.length] !== w.f) wrong++;
  }
  assert.ok(checked > 150, `${checked} windows checked`);
  assert.ok(wrong <= checked * 0.02, `${wrong} of ${checked} windows out of step`);
});

await t('the length is the edited length', () => {
  const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', r.outFile]).toString());
  const want = 9.4 - (1 - 0) - (4.6 - 3.3) - (6.5 - 6.2);
  assert.ok(close(d, want, 0.08), `${d} vs ${want}`);
});

await t('the copy carries a fragment index that adds up', () => {
  const b = r.out;
  const i = b.indexOf(Buffer.from('sidx'));
  assert.ok(i > 0 && i < r.head.length, 'sidx in the header');
  const at = i - 4;
  const count = b.readUInt16BE(at + 38);
  let sum = 0;
  for (let k = 0; k < count; k++) sum += b.readUInt32BE(at + 40 + k * 12) & 0x7fffffff;
  assert.equal(at + b.readUInt32BE(at) + sum, b.length);
});

await t('step by step (one fragment a step, state through JSON) gives the same bytes', async () => {
  const slow = await redact(main, CUTS, { budgetMs: -1 });
  assert.ok(slow.steps > 8, `${slow.steps} steps`);
  assert.ok(Buffer.compare(slow.out, r.out) === 0);
});

await t('reads stay bounded: about one pass over the file', () => {
  const size = fs.statSync(main).size;
  assert.ok(r.reads.bytes < size * 2.2 + 1e6, `${r.reads.bytes} bytes read for ${size}`);
});

// ---------- key frames every 2 s, fragments every 1 s (fragments that start without one) ----------
await t('sparse key frames: still nothing cut, frames held at most 2 s', async () => {
  const cuts = [[2.5, 3.2], [5.1, 7.4]];
  const f = fixture('gop2.mp4', { gop: 60, secret: cuts });
  const x = await redact(f, cuts);
  const tl = new Timeline(effectiveCuts(cuts, x.state.extra));
  const got = frames(x.outFile), src = srcOf(f);
  assert.ok(got.length > 100);
  for (const g of got) {
    assert.ok(!tl.inCut(src.get(g.n)), `frame ${g.n}`);
    const early = tl.edited(src.get(g.n)) - g.t;
    assert.ok(early > -0.02 && early <= 2.02, `frame ${g.n}: ${early}`);
  }
  const secret = tones(x.outFile).filter((w) => w.f === SECRET);
  assert.ok(secret.length <= 4 * 3, `${secret.length * 10} ms of secret`);
});

// ---------- one frame per fragment: the held frame ends its fragment ----------
await t('one frame per fragment: the frame after a cut is still held, no gap', async () => {
  const cuts = [[2.3, 3.6]];
  const f = fixture('perframe.mp4', { secs: 6, frag: 0.000001, secret: cuts });
  const x = await redact(f, cuts);
  const tl = new Timeline(effectiveCuts(cuts, x.state.extra)), src = srcOf(f);
  const got = frames(x.outFile);
  let held = 0;
  for (let i = 0; i < got.length; i++) {
    assert.ok(!tl.inCut(src.get(got[i].n)), `frame ${got[i].n}`);
    const early = tl.edited(src.get(got[i].n)) - got[i].t;
    if (early > 0.02) held++;
    if (i) assert.ok(got[i].t - got[i - 1].t < 0.1 || tl.edited(src.get(got[i - 1].n)) - got[i - 1].t > 0.02, `gap before ${got[i].t}`);
  }
  assert.equal(held, 1);
  assert.deepEqual(seams(x.outFile), [], 'each frame lasts until the next one starts');
});

await t('sparse key frames and a cut over the first one after the trim: the start moves past it, no held picture', async () => {
  // Key frames at 0, 2, 4 …; the trim ends at 0.5 and a cut covers 1.9–2.6, so the first frame
  // that can be shown is the key frame at 4. Nothing before it can play (no picture to show).
  const cuts = [[0, 0.5], [1.9, 2.6], [8, 1e7]];
  const f = fixture('gop2-start.mp4', { gop: 60, secs: 9, secret: [[0, 0.5], [1.9, 2.6]] });
  const x = await redact(f, cuts);
  const src = srcOf(f), key = [...src].find(([n]) => n === 120)[1];
  assert.ok(close(x.state.extra[1], key, 1e-4) && x.state.extra[0] === 0, JSON.stringify(x.state.extra));
  const got = frames(x.outFile);
  assert.equal(got[0].n, 120);
  assert.ok(got[0].t < 0.001 && got[1].t < 0.05, 'the picture starts at once, no long first frame');
  const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', x.outFile]).toString());
  assert.ok(close(d, 8 - key, 0.08), `${d} s`);
});

// ---------- the camera file: video only, on the main clock by an offset ----------
await t('camera file: offset onto the main clock, nothing cut, no start hold', async () => {
  const off = 0.25; // main time = camera time + 0.25
  // The screen's copy starts at its first key frame after the trim (1.02 s): pass that on, as the server does.
  const cam = fixture('cam.mp4', { audio: false, secs: 10 });
  const camCuts = effectiveCuts(CUTS, r.state.extra);
  const x = await redact(cam, camCuts, { offset: off, primary: false });
  assert.equal(x.state.extra, null);
  const tl = new Timeline(camCuts), src = srcOf(cam);
  const got = frames(x.outFile);
  // It starts at 0 like the screen's copy: Chrome times a file from its first frame, so a camera
  // copy starting later would play out of step with the screen.
  assert.ok(got[0].t < 0.001, `first camera frame at ${got[0].t}`);
  assert.ok(got.length > 150, `${got.length} frames`);
  assert.deepEqual(seams(x.outFile), []);
  for (const g of got) {
    const mainT = src.get(g.n) + off;
    assert.ok(!tl.inCut(mainT), `frame ${g.n}`);
    const early = Math.max(0, tl.edited(mainT) - off) - g.t;
    assert.ok(early > -0.02 && early <= 1.02, `frame ${g.n}: ${early}`);
  }
});

await t('camera file whose first usable key frame comes late: still starts at 0', async () => {
  const cam = fixture('cam-gop2.mp4', { audio: false, secs: 10, gop: 60 });
  const camCuts = effectiveCuts(CUTS, r.state.extra);
  const x = await redact(cam, camCuts, { offset: 0.25, primary: false });
  const got = frames(x.outFile);
  assert.ok(got[0].t < 0.001, `first camera frame at ${got[0].t}`);
  assert.equal(got[0].n, 60, 'the key frame at 2 s, held from the start');
  assert.deepEqual(seams(x.outFile), []);
});

// ---------- files it must refuse ----------
await t('B-frames: refused (Unsupported), never half-done', async () => {
  const f = fixture('bf.mp4', { bframes: true, secs: 4 });
  await assert.rejects(redact(f, [[1, 2]]), Unsupported);
});

await t('not MP4 (WebM): refused', async () => {
  const f = path.join(dir, 'x.webm');
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-t', '2', '-c:v', 'libvpx', f);
  await assert.rejects(redact(f, [[0.5, 1]]), Unsupported);
});

await t('plain (not fragmented) MP4: refused', async () => {
  const f = path.join(dir, 'flat.mp4');
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-t', '2', '-c:v', 'libx264', '-bf', '0', f);
  await assert.rejects(redact(f, [[0.5, 1]]), Unsupported);
});

await t('garbage after the header: refused or stopped, never a throw of another kind', async () => {
  const buf = fs.readFileSync(main);
  for (let i = 0; i < 40; i++) {
    const b = Buffer.from(buf);
    const at = 2000 + Math.floor(Math.random() * (b.length - 2000));
    for (let k = 0; k < 16; k++) b[at + k] = Math.floor(Math.random() * 256);
    const f = path.join(dir, `bad${i}.mp4`);
    fs.writeFileSync(f, b);
    try { await redact(f, CUTS); } catch (e) { if (!(e instanceof Unsupported)) throw e; }
  }
});

await t('no cuts at all: the copy holds every frame', async () => {
  const x = await redact(main, []);
  const got = frames(x.outFile);
  assert.equal(got.length, 11 * FPS);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
