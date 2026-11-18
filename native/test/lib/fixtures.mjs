// Deterministic test audio. Each fixture has an exact integer reference signal;
// FLAC is lossless, so the engine's decoded float output must match
// int / 2^(bits-1) exactly. Signals carry a DC offset so no sample is ever
// exactly 0: rendered frames that are all-zero are therefore inserted silence
// (buffering), which lets tests check that no audio was skipped or repeated.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures');
const VERSION = 2; // bump to regenerate

// name: rate, channels, bits, seconds (or frames), signal kind
const SPECS = {
  cd:       { rate: 44100,  ch: 2, bits: 16, frames: 44100 * 12 + 1234 },
  hires:    { rate: 96000,  ch: 2, bits: 24, frames: 96000 * 8 + 77 },
  r192:     { rate: 192000, ch: 2, bits: 24, frames: 192000 * 3 },
  mono:     { rate: 48000,  ch: 1, bits: 16, frames: 48000 * 3 },
  surround: { rate: 48000,  ch: 6, bits: 16, frames: 48000 * 2 },
  // gapless pair: one continuous signal split at a non-block boundary
  partA:    { rate: 44100,  ch: 2, bits: 16, frames: 321987, split: 'A' },
  partB:    { rate: 44100,  ch: 2, bits: 16, frames: 250011, split: 'B' },
  // a different-format next track
  other:    { rate: 48000,  ch: 2, bits: 16, frames: 48000 * 2 },
};

function sample(spec, frame, c) {
  // channel-distinct tones + offset, |x| in [0.05, 0.75]
  const t = frame / spec.rate;
  const f = 220 * (c + 1) + 37;
  const sign = c % 2 ? -1 : 1;
  return sign * (0.4 + 0.3 * Math.sin(2 * Math.PI * f * t + c));
}

function intSignal(spec, startFrame = 0) {
  const full = 2 ** (spec.bits - 1) - 1;
  const out = new Int32Array(spec.frames * spec.ch);
  for (let i = 0; i < spec.frames; i++)
    for (let c = 0; c < spec.ch; c++) out[i * spec.ch + c] = Math.round(sample(spec, startFrame + i, c) * full);
  return out;
}

function writeWav(file, spec, ints) {
  const bps = spec.bits / 8;
  const dataLen = ints.length * bps;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(spec.ch, 22);
  b.writeUInt32LE(spec.rate, 24); b.writeUInt32LE(spec.rate * spec.ch * bps, 28);
  b.writeUInt16LE(spec.ch * bps, 32); b.writeUInt16LE(spec.bits, 34);
  b.write('data', 36); b.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < ints.length; i++) b.writeIntLE(ints[i], 44 + i * bps, bps);
  fs.writeFileSync(file, b);
}

function gst(args) {
  execFileSync('gst-launch-1.0', ['-q', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
}

export function ensureFixtures() {
  const stamp = path.join(DIR, `.v${VERSION}`);
  const out = {};
  const fresh = !fs.existsSync(stamp);
  if (fresh) { fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true }); }
  for (const [name, spec] of Object.entries(SPECS)) {
    const start = spec.split === 'B' ? SPECS.partA.frames : 0;
    const ints = intSignal(spec, start);
    const flac = path.join(DIR, `${name}.flac`);
    if (fresh) {
      const wav = path.join(DIR, `${name}.wav`);
      writeWav(wav, spec, ints);
      gst(['filesrc', `location=${wav}`, '!', 'wavparse', '!', 'audioconvert', '!', 'flacenc', '!', 'filesink', `location=${flac}`]);
      fs.rmSync(wav);
    }
    const ref = new Float32Array(ints.length);
    const scale = 2 ** (spec.bits - 1);
    for (let i = 0; i < ints.length; i++) ref[i] = ints[i] / scale;
    out[name] = { ...spec, file: flac, bytes: fs.readFileSync(flac), ref };
  }
  // MP3 (lossy): plain tones without offset, compared by SNR after alignment
  const mp3Spec = { rate: 44100, ch: 2, bits: 16, frames: 44100 * 6 };
  const mp3 = path.join(DIR, 'tone.mp3');
  const toneInts = new Int32Array(mp3Spec.frames * 2);
  for (let i = 0; i < mp3Spec.frames; i++) for (let c = 0; c < 2; c++)
    toneInts[i * 2 + c] = Math.round(0.5 * Math.sin(2 * Math.PI * (440 + 220 * c) * i / 44100) * 32767);
  if (fresh) {
    const wav = path.join(DIR, 'tone.wav');
    writeWav(wav, mp3Spec, toneInts);
    gst(['filesrc', `location=${wav}`, '!', 'wavparse', '!', 'audioconvert', '!',
      'lamemp3enc', 'target=bitrate', 'bitrate=320', 'cbr=true', '!', 'filesink', `location=${mp3}`]);
    fs.rmSync(wav);
    fs.writeFileSync(stamp, '');
  }
  out.mp3 = { ...mp3Spec, file: mp3, bytes: fs.readFileSync(mp3), ref: Float32Array.from(toneInts, (v) => v / 32768) };
  return out;
}
