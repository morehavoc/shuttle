// The fragment index builder on hostile input: every call returns quickly, never throws, and
// never asks for more than it needs. node test/mp4index.test.mjs
import assert from 'node:assert/strict';
import { buildSidx, READ_WINDOW } from '../src/mp4index.js';

let n = 0, failed = 0;
const t = async (name, fn) => { n++; try { await fn(); console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };

const u32 = (x) => { const b = Buffer.alloc(4); b.writeUInt32BE(x >>> 0); return b; };
const u64 = (x) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(x)); return b; };
const bytes = (p) => (Buffer.isBuffer(p) ? p : Buffer.from(p));
const box = (type, ...parts) => { const body = Buffer.concat(parts.map(bytes)); return Buffer.concat([u32(8 + body.length), Buffer.from(type), body]); };
const full = (type, version, flags, ...parts) => box(type, Buffer.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);

const TS = 90000, DUR = 3000; // 30 fps
const ftyp = box('ftyp', 'isom', u32(0), 'isom');
const moov = box('moov',
  box('trak', full('tkhd', 0, 3, u32(0), u32(0), u32(1), Buffer.alloc(72)),
    box('mdia', full('mdhd', 0, 0, u32(0), u32(0), u32(TS), u32(0), Buffer.alloc(4)), full('hdlr', 0, 0, u32(0), 'vide', Buffer.alloc(12)))),
  box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(DUR), u32(0), u32(0x00010000))));
// A fragment: `count` samples of the default duration, the first a sync sample.
const frag = (time, count, { trunFlags = 0x000005, extra = Buffer.alloc(0), mdat = 100 } = {}) => Buffer.concat([
  box('moof', full('mfhd', 0, 0, u32(1)),
    box('traf', full('tfhd', 0, 0x020000, u32(1)), full('tfdt', 1, 0, u64(time)), full('trun', 0, trunFlags, u32(count), u32(0), u32(0x02000000), extra))),
  box('mdat', Buffer.alloc(mdat)),
]);
const file = (...parts) => new Uint8Array(Buffer.concat(parts));
// A reader over a buffer that records what it was asked for.
const reader = (buf) => {
  const log = { reads: 0, biggest: 0 };
  const read = async (o, len) => { log.reads++; log.biggest = Math.max(log.biggest, len); return buf.subarray(o, o + len); };
  return { read, log };
};
const timed = async (buf) => {
  const { read, log } = reader(buf);
  const t0 = performance.now();
  const r = await buildSidx(read, buf.length);
  return { r, ms: performance.now() - t0, ...log };
};

const good = file(ftyp, moov, frag(0, 30), frag(30 * DUR, 30), frag(60 * DUR, 30));

await t('a normal file is indexed (3 fragments, 1 s each)', async () => {
  const { r } = await timed(good);
  assert.ok(r, 'indexed');
  const dv = new DataView(r.sidx.buffer, r.sidx.byteOffset, r.sidx.byteLength);
  assert.equal(dv.getUint16(38), 3);
  for (let i = 0; i < 3; i++) assert.equal(dv.getUint32(40 + i * 12 + 4), 30 * DUR);
  assert.equal(r.at, ftyp.length + moov.length);
});

await t('a sample count of 2^32 with no per-sample fields is multiplied, not looped', async () => {
  const { ms } = await timed(file(ftyp, moov, frag(0, 0xffffffff), frag(0, 0xffffffff)));
  assert.ok(ms < 200, `${ms.toFixed(0)} ms`);
});

await t('a sample table bigger than its box is refused at once', async () => {
  const { r, ms } = await timed(file(ftyp, moov, frag(0, 1e9, { trunFlags: 0x000105 }), frag(1, 1e9, { trunFlags: 0x000105 })));
  assert.equal(r, null);
  assert.ok(ms < 50, `${ms.toFixed(0)} ms`);
});

await t('per-sample durations are summed (bounded by the bytes present)', async () => {
  const durs = Buffer.concat(Array.from({ length: 30 }, () => u32(DUR)));
  const { r } = await timed(file(ftyp, moov, frag(0, 30, { trunFlags: 0x000105, extra: durs }), frag(30 * DUR, 30, { trunFlags: 0x000105, extra: durs })));
  assert.ok(r, 'indexed');
  assert.equal(new DataView(r.sidx.buffer, r.sidx.byteOffset).getUint32(44), 30 * DUR);
});

await t('100,000 tiny boxes take linear time', async () => {
  const { r, ms } = await timed(file(ftyp, moov, Buffer.concat(Array.from({ length: 100000 }, () => box('free')))));
  assert.equal(r, null);
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
});

await t('a moof claiming 2 MB is refused without reading it on its own', async () => {
  const big = Buffer.concat([u32(2 * 1024 * 1024), Buffer.from('moof'), Buffer.alloc(2 * 1024 * 1024 - 8)]);
  const buf = file(ftyp, moov, frag(0, 30), big, frag(30 * DUR, 30));
  const { read, log } = reader(buf);
  assert.equal(await buildSidx(read, buf.length), null);
  // Reads are the head, then windows of the file: never one sized by what a box claims.
  assert.ok(log.biggest <= READ_WINDOW, `largest read ${log.biggest} bytes`);
  assert.ok(log.reads <= 2, `${log.reads} reads`);
});

await t('a long recording takes a few reads, not one per fragment', async () => {
  const mdat = Buffer.concat([u32(8 + 400000), Buffer.from('mdat'), Buffer.alloc(400000)]); // ~3 Mbps, 1 s
  const frags = Array.from({ length: 180 }, (_, i) => Buffer.concat([frag(i * 30 * DUR, 30), mdat]));
  const buf = file(ftyp, moov, ...frags);
  const { read, log } = reader(buf);
  assert.ok(await buildSidx(read, buf.length), 'indexed');
  assert.ok(log.reads <= Math.ceil(buf.length / READ_WINDOW) + 2, `${log.reads} reads for ${(buf.length / 1e6).toFixed(0)} MB`);
});

await t('a 64-bit size past 2^53 is not a box', async () => {
  const huge = Buffer.concat([u32(1), Buffer.from('mdat'), u64(2n ** 60n)]);
  const { r } = await timed(file(ftyp, moov, frag(0, 30), huge, frag(30 * DUR, 30)));
  assert.equal(r, null);
});

await t('a child running past its parent is ignored, not read', async () => {
  const badTrex = Buffer.from(moov); // stretch the trex box past the end of mvex and moov
  const at = badTrex.indexOf('trex') - 4;
  badTrex.writeUInt32BE(500, at);
  const { r } = await timed(file(ftyp, badTrex, frag(0, 30), frag(30 * DUR, 30)));
  assert.ok(r === null || r.sidx, 'returned');
});

await t('fields read past a short box are refused, not taken from the next box', async () => {
  // A tfhd that says it carries a default duration, with no room for it.
  const shortTfhd = (time) => Buffer.concat([
    box('moof', full('mfhd', 0, 0, u32(1)),
      box('traf', full('tfhd', 0, 0x020008, u32(1)), full('tfdt', 1, 0, u64(time)), full('trun', 0, 5, u32(30), u32(0), u32(0x02000000)))),
    box('mdat', Buffer.alloc(100)),
  ]);
  assert.equal((await timed(file(ftyp, moov, shortTfhd(0), shortTfhd(1)))).r, null);
  // A version-1 tfdt with only four bytes of time.
  const shortTfdt = (time) => Buffer.concat([
    box('moof', full('mfhd', 0, 0, u32(1)),
      box('traf', full('tfhd', 0, 0x020000, u32(1)), full('tfdt', 1, 0, u32(time)), full('trun', 0, 5, u32(30), u32(0), u32(0x02000000)))),
    box('mdat', Buffer.alloc(100)),
  ]);
  assert.equal((await timed(file(ftyp, moov, shortTfdt(0), shortTfdt(1)))).r, null);
});

await t('a file cut off mid-fragment indexes what is complete, or nothing', async () => {
  for (let cut = good.length - 1; cut > good.length - 400; cut -= 7) {
    const { r } = await timed(good.subarray(0, cut));
    assert.ok(r === null || r.sidx, `cut at ${cut}`);
  }
});

await t('3,000 random mutations: no throw, none slow', async () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  let slowest = 0, indexed = 0;
  for (let i = 0; i < 3000; i++) {
    const m = Buffer.from(good);
    for (let k = 0, flips = 1 + Math.floor(rnd() * 4); k < flips; k++) m[Math.floor(rnd() * m.length)] = Math.floor(rnd() * 256);
    const { r, ms } = await timed(new Uint8Array(m));
    slowest = Math.max(slowest, ms);
    if (r) indexed++;
  }
  assert.ok(slowest < 250, `slowest ${slowest.toFixed(0)} ms`);
  console.log(`        (${indexed} of 3000 still indexable, slowest ${slowest.toFixed(1)} ms)`);
});

console.log(`\n${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
