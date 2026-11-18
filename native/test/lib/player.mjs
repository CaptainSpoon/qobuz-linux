// Helpers for driving the engine in deterministic test mode.
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

export function loadPlayer() {
  process.env.QOBUZ_AUDIO_TEST = '1';
  const addon = process.env.QOBUZ_AUDIO_ADDON || path.join(ROOT, 'build', 'Release', 'qobuz_audio.node');
  const m = { exports: {} };
  process.dlopen(m, addon);
  const p = m.exports();
  assert.equal(typeof p.__render, 'function', 'addon not in test mode');
  return p;
}

export function reset(p) {
  p.close(true);
  p.volume(100);
  p.__setReadMargin(64 * 1024);
  p.__setFakeDevices(null);
}

// A track buffer filled the way Qobuz's TrackController does it.
export function streamTrack(p, isNext, fx, { fill = true } = {}) {
  const time = p.newCacheRanges();
  const data = p.newCacheRanges();
  const buf = Buffer.alloc(fx.bytes.length, 0);
  data.setCacheSize(buf.length);
  p.initCacheRange(isNext, time, data);
  const t = {
    buf, time, data,
    // copy bytes [s,e) in; optional time range [t0, t0+dur)
    add(s, e, t0, dur) {
      fx.bytes.copy(buf, s, s, e);
      data.addRange(s, e);
      if (t0 !== undefined) time.addRange(t0, t0 + dur);
    },
    open() { return p.openStream(isNext, buf, fx.file.endsWith('.mp3') ? 'mp3' : 'flac', 0); },
  };
  if (fill) t.add(0, buf.length);
  return t;
}

// Render `frames` frames in chunks, running maintenance between chunks.
// `between(i)` is called before each chunk (for feeding data etc).
export function pump(p, frames, { chunk = 1024, maintain = true, between } = {}) {
  const ch = p.__state().devChannels;
  const out = new Float32Array(frames * ch);
  let done = 0, i = 0;
  while (done < frames) {
    if (between) between(i++);
    if (maintain) p.__maintain();
    const n = Math.min(chunk, frames - done);
    const chCur = p.__state().devChannels;
    if (chCur !== ch) throw new Error(`device channel count changed mid-pump (${ch} -> ${chCur})`);
    const r = p.__render(n);
    if (r.length) out.set(r, done * ch);
    done += n;
  }
  return out;
}

// Drop frames that are entirely zero (inserted silence while buffering).
export function stripSilence(out, ch) {
  const keep = [];
  for (let f = 0; f < out.length / ch; f++) {
    let any = false;
    for (let c = 0; c < ch; c++) if (out[f * ch + c] !== 0) { any = true; break; }
    if (any) for (let c = 0; c < ch; c++) keep.push(out[f * ch + c]);
  }
  return Float32Array.from(keep);
}

export function countSilentFrames(out, ch) {
  let n = 0;
  for (let f = 0; f < out.length / ch; f++) {
    let any = false;
    for (let c = 0; c < ch; c++) if (out[f * ch + c] !== 0) { any = true; break; }
    if (!any) n++;
  }
  return n;
}

// Assert `got` equals `ref` sample-for-sample (optionally scaled).
export function assertSamples(got, ref, msg, { scale = 1, ch = 2 } = {}) {
  assert.equal(got.length, ref.length, `${msg}: length ${got.length / ch} frames, expected ${ref.length / ch}`);
  for (let i = 0; i < ref.length; i++) {
    const want = Math.fround(ref[i] * scale);
    if (got[i] !== want) {
      assert.fail(`${msg}: first mismatch at frame ${Math.floor(i / ch)} ch ${i % ch}: got ${got[i]}, expected ${want}`);
    }
  }
}

// Deterministic PRNG (mulberry32)
export function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
