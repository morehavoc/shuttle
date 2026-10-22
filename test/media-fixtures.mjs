// Recordings that say what's in them, for checking edited copies (test/redact.test.mjs,
// test/api.test.mjs). Every video frame carries its frame number as 16 black/white blocks; the
// sound is a tone whose pitch steps every 100 ms through six pitches, except inside `secret`
// ranges, where it is a 3 kHz tone. Needs ffmpeg.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-media-'));
export const FPS = 30, W = 640, H = 360, BITS = 16, SECRET = 3000;
export const PITCHES = [600, 800, 1000, 1200, 1400, 1600];
export const ff = (...args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 30 });

// A recording like a browser's: fragmented, moof-relative, no B-frames, a key frame every `gop`
// frames and a fragment every `frag` seconds. `secret`: the ranges that sound secret.
export function fixture(name, { secs = 11, gop = 30, frag = 1, secret = [], audio = true, bframes = false, rate = FPS } = {}) {
  const file = path.join(dir, name);
  const inSecret = secret.map(([s, e]) => `between(t,${s},${e})`).join('+') || '0';
  const pitch = PITCHES.map((p, i) => `eq(mod(floor(t*10),${PITCHES.length}),${i})*${p}`).join('+');
  const args = [
    '-f', 'lavfi', '-i', `nullsrc=s=${W}x${H}:r=${rate},geq=lum='255*mod(floor(N/pow(2,floor(X/${W / BITS}))),2)':cb=128:cr=128`,
  ];
  if (audio) args.push('-f', 'lavfi', '-i', `aevalsrc='0.5*sin(2*PI*t*(if(gt(${inSecret},0),${SECRET},${pitch})))':s=48000`);
  args.push('-t', String(secs), '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '1500k', '-pix_fmt', 'yuv420p',
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', ...(bframes ? [] : ['-bf', '0']));
  if (audio) args.push('-c:a', 'aac', '-b:a', '128k');
  // A fragment every `frag` seconds, whether or not a key frame starts it.
  args.push('-use_editlist', '0', '-frag_duration', String(frag * 1e6), '-movflags', 'empty_moov+default_base_moof', file);
  ff(...args);
  return file;
}

// Every decoded frame: { t (seconds, as presented), n (the frame number it shows) }.
export function frames(file) {
  const meta = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file]).toString().trim().split('\n').map((x) => parseFloat(x));
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-fps_mode', 'passthrough', '-'], { maxBuffer: 1 << 30 });
  const out = [];
  for (let i = 0; i * W * H < raw.length; i++) {
    let num = 0;
    for (let b = 0; b < BITS; b++) {
      const x = Math.floor((b + 0.5) * W / BITS), y = H >> 1;
      if (raw[i * W * H + y * W + x] > 128) num |= 1 << b;
    }
    out.push({ t: meta[i], n: num });
  }
  return out;
}

// The sound in 10 ms windows: which of the known pitches is loudest, from t = 0 of the file.
export function tones(file) {
  const pcm = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '48000', '-'], { maxBuffer: 1 << 30 });
  const first = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', file]).toString().trim()) || 0;
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
  const win = 480, cands = [...PITCHES, SECRET];
  const out = [];
  for (let i = 0; i + win <= s.length; i += win) {
    let best = null, bestP = 0, total = 0;
    for (let k = i; k < i + win; k++) total += s[k] * s[k];
    for (const f of cands) { // Goertzel
      const w = 2 * Math.PI * f / 48000, c = 2 * Math.cos(w);
      let a = 0, b = 0;
      for (let k = i; k < i + win; k++) { const x = s[k] + c * a - b; b = a; a = x; }
      const p = a * a + b * b - c * a * b;
      if (p > bestP) { bestP = p; best = f; }
    }
    out.push({ t: first + i / 48000, f: total > win * 1e5 ? best : null });
  }
  return out;
}


// Where each frame number sits in a file (the encoder doesn't space them exactly 1/30 s).
// (+1 µs: ffprobe prints times rounded to the microsecond, which can put a cut's end frame inside it.)
export const srcOf = (file) => { const m = new Map(); for (const f of frames(file)) m.set(f.n, f.t + 1e-6); return m; };

// A track's packets: [{ pts, dur }] in the stream's own time units.
export function packets(file, stream = 'v') {
  return execFileSync('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts,duration', '-of', 'csv=p=0', file])
    .toString().trim().split('\n').map((l) => { const [pts, dur] = l.split(',').map((x) => parseInt(x, 10)); return { pts, dur }; });
}

// Where one packet's time runs past or short of the next one's start (more than a tick).
export function seams(file, stream = 'v') {
  const p = packets(file, stream);
  const out = [];
  for (let i = 1; i < p.length; i++) if (Math.abs(p[i - 1].pts + p[i - 1].dur - p[i].pts) > 1) out.push(i);
  return out;
}
