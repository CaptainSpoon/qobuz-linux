// Audio engine tests: deterministic, sample-exact, no sound device needed.
//   QOBUZ_AUDIO_TEST=1 node --test native/test/
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureFixtures } from './lib/fixtures.mjs';
import { hlsSegments } from './lib/flac.mjs';
import {
  loadPlayer, reset, streamTrack, pump, stripSilence, countSilentFrames, assertSamples, rng,
} from './lib/player.mjs';

let p, fx;
before(() => { fx = ensureFixtures(); p = loadPlayer(); });
beforeEach(() => reset(p));

const frameOf = (sec, rate) => Math.round(sec * rate);
const slice = (f, startFrame, frames) => f.ref.subarray(startFrame * f.ch, (startFrame + frames) * f.ch);

// ------------------------------------------------------------ decoding accuracy
for (const name of ['cd', 'hires', 'r192', 'mono', 'surround']) {
  test(`decodes ${name} FLAC bit-exactly (complete buffer)`, () => {
    const f = fx[name];
    const t = streamTrack(p, false, f);
    assert.equal(t.open(), true);
    const ti = p.trackInformation(false);
    assert.equal(ti.sampleRate, f.rate);
    assert.equal(ti.numChannels, f.ch);
    assert.equal(ti.bitsPerSample, f.bits);
    assert.equal(ti.lengthInSamples, f.frames);
    assert.equal(p.play(), undefined);
    const st = p.__state();
    assert.equal(st.devRate, f.rate, 'device opened at track rate');
    assert.equal(st.devChannels, f.ch, 'device opened with track channels');
    const out = pump(p, f.frames + 4096);
    assertSamples(out.subarray(0, f.frames * f.ch), f.ref, name, { ch: f.ch });
    assert.equal(countSilentFrames(out.subarray(f.frames * f.ch), f.ch), 4096, 'silence after end');
    assert.equal(p.hasStreamFinished(), true);
    assert.equal(p.status(), 'Stopped');
    assert.equal(p.offset(), f.frames / f.rate);
  });
}

test('decodes a local FLAC file bit-exactly', () => {
  const f = fx.hires;
  assert.equal(p.open(false, f.file, 'flac'), true);
  assert.equal(p.play(), undefined);
  assertSamples(pump(p, f.frames), f.ref, 'file', { ch: 2 });
});

test('open() of a missing file returns false', () => {
  assert.equal(p.open(false, '/nonexistent/x.flac', 'flac'), false);
  assert.equal(p.status(), 'Stopped');
  assert.equal(typeof p.play(), 'string', 'play() reports an error with no track');
});

// MP3 is lossy: align (encoder delay) and require high SNR.
function mp3Snr(out, ref) {
  let best = { snr: -Infinity, lag: 0 };
  for (let lag = 0; lag < 4000; lag++) {
    let sig = 0, err = 0;
    const n = Math.min(ref.length / 2 - 2000, out.length / 2 - lag) ;
    for (let i = 1000; i < n; i += 7) {
      const a = ref[i * 2], b = out[(i + lag) * 2];
      sig += a * a; err += (a - b) * (a - b);
    }
    const snr = 10 * Math.log10(sig / Math.max(err, 1e-20));
    if (snr > best.snr) best = { snr, lag };
  }
  return best;
}
test('decodes MP3 (file) with correct rate, length and >40 dB SNR', () => {
  const f = fx.mp3;
  assert.equal(p.open(false, f.file, 'mp3'), true);
  const ti = p.trackInformation(false);
  assert.equal(ti.sampleRate, 44100);
  assert.ok(Math.abs(ti.duration / 1000 - 6) < 0.1, `duration ${ti.duration}`);
  p.play();
  const out = pump(p, f.frames + 4000);
  const { snr, lag } = mp3Snr(out, f.ref);
  assert.ok(snr > 40, `SNR ${snr.toFixed(1)} dB (lag ${lag})`);
});
test('decodes MP3 (stream) with >40 dB SNR', () => {
  const f = fx.mp3;
  const t = streamTrack(p, false, f);
  assert.equal(t.open(), true);
  const ti = p.trackInformation(false);
  assert.ok(Math.abs(ti.duration / 1000 - 6) < 0.3, `estimated duration ${ti.duration}`);
  p.play();
  const { snr } = mp3Snr(pump(p, f.frames + 4000), f.ref);
  assert.ok(snr > 40, `SNR ${snr.toFixed(1)} dB`);
});

// ------------------------------------------------------------ volume
test('volume scales output exactly (gain = (v/100)^2) and 0 mutes', () => {
  const f = fx.cd;
  streamTrack(p, false, f).open();
  p.play();
  p.volume(50);
  assertSamples(pump(p, 10000), slice(f, 0, 10000), 'vol 50', { scale: 0.25 });
  p.volume(0);
  assert.equal(countSilentFrames(pump(p, 5000), 2), 5000, 'muted');
  p.volume(100);
  assertSamples(pump(p, 5000), slice(f, 15000, 5000), 'vol 100');
});

// ------------------------------------------------------------ streaming / buffering
test('progressive download: blocks when starved, resumes with no skipped or repeated samples', () => {
  const f = fx.cd;
  const t = streamTrack(p, false, f, { fill: false });
  const N = f.bytes.length;
  let fed = 0;
  const feed = (n) => { const e = Math.min(N, fed + n); t.add(fed, e); fed = e; };
  feed(16 * 1024);
  assert.equal(t.open(), true);
  p.play();
  let blockedSeen = 0;
  const out = pump(p, f.frames + 20000, {
    between: (i) => {
      if (p.status() === 'Blocked') blockedSeen++;
      if (i % 3 === 0) feed(4096 + ((i * 7919) % 9000)); // irregular, slower than playback at first
    },
  });
  assert.ok(blockedSeen > 0, 'player reported Blocked at least once');
  assert.ok(countSilentFrames(out, 2) > 1000, 'silence was inserted while starved');
  assertSamples(stripSilence(out, 2), f.ref, 'stream integrity');
});

test('decoder running into a gap re-syncs without losing samples (tiny read margin)', () => {
  const f = fx.hires;
  p.__setReadMargin(1); // let the decoder read up to the very edge of the data
  const t = streamTrack(p, false, f, { fill: false });
  const N = f.bytes.length;
  let fed = 0;
  const feed = (n) => { const e = Math.min(N, fed + n); t.add(fed, e); fed = e; };
  feed(8000);
  t.open();
  p.play();
  const r0 = p.__state().resyncs;
  // Feed 20-80% (avg ~50%) of what one chunk consumes, so the decoder keeps
  // running into the edge of the data regardless of how well the fixture
  // compresses. (A fixed byte count was faster than playback for some encoders.)
  const chunk = 777, perChunk = (N / f.frames) * chunk;
  const out = pump(p, 3 * f.frames, {
    chunk,
    between: (i) => feed(Math.max(1, Math.round(perChunk * (0.2 + 0.6 * (((i * 104729) % 1000) / 1000))))),
  });
  const resyncs = p.__state().resyncs - r0;
  assert.ok(resyncs > 0, `re-sync path exercised (${resyncs} times)`);
  assertSamples(stripSilence(out, 2), f.ref, 'resync integrity');
});

test('stream whose header arrives after play(): device opens late, output exact from frame 0', () => {
  const f = fx.hires;
  const t = streamTrack(p, false, f, { fill: false });
  assert.equal(t.open(), true, 'openStream accepts a buffer with no data yet');
  assert.equal(p.play(), undefined);
  assert.equal(p.__state().devStarted, false);
  assert.equal(p.status(), 'Blocked');
  p.__maintain();
  assert.equal(p.__state().devStarted, false, 'still waiting for header');
  t.add(0, f.bytes.length);
  p.__maintain();
  const st = p.__state();
  assert.equal(st.devStarted, true);
  assert.equal(st.devRate, 96000);
  assertSamples(pump(p, 50000), slice(f, 0, 50000), 'late header');
});

// ------------------------------------------------------------ seeking
test('seek within a complete buffer lands on the exact frame', () => {
  const f = fx.cd;
  streamTrack(p, false, f).open();
  p.play();
  pump(p, 5000);
  for (const sec of [3.25, 0.5, 11.9, 0]) {
    p.offset(sec);
    const start = frameOf(sec, f.rate);
    assert.equal(p.offset(), start / f.rate);
    assertSamples(pump(p, 3000), slice(f, start, 3000), `seek ${sec}`);
  }
});

test('seek past the downloaded end (linear stream) waits, then resumes at the exact frame', () => {
  const f = fx.cd;
  const t = streamTrack(p, false, f, { fill: false });
  const N = f.bytes.length;
  t.add(0, Math.floor(N * 0.2));
  t.open();
  p.play();
  pump(p, 2000);
  const sec = 8.4;
  p.offset(sec);
  assert.equal(p.__state().slots[0].pendingSeek, true);
  assert.equal(p.status(), 'Blocked');
  assert.equal(countSilentFrames(pump(p, 3000), 2), 3000, 'silent while pending');
  t.add(Math.floor(N * 0.2), N);
  const out = pump(p, 5000);
  assert.equal(p.__state().slots[0].pendingSeek, false);
  assertSamples(stripSilence(out, 2), slice(f, frameOf(sec, f.rate), 5000 - countSilentFrames(out, 2)), 'pending linear seek');
});

test('HLS: seek into a not-yet-downloaded segment resumes at the exact frame', () => {
  const f = fx.hires;
  const { headerLen, segs } = hlsSegments(f.bytes, f.rate, 1);
  assert.ok(segs.length >= 6);
  const t = streamTrack(p, false, f, { fill: false });
  t.add(0, headerLen); // init block: bytes only
  for (const k of [0, 1]) t.add(segs[k].start, segs[k].end, segs[k].t0, segs[k].dur);
  t.open();
  p.play();
  assertSamples(pump(p, 20000), slice(f, 0, 20000), 'start');
  const k = segs.length - 3;
  const sec = segs[k].t0 + 0.37; // mid-segment: exercises decode-and-discard
  p.offset(sec);
  assert.equal(p.status(), 'Blocked');
  pump(p, 2000);
  for (let j = k; j < segs.length; j++) t.add(segs[j].start, segs[j].end, segs[j].t0, segs[j].dur);
  const out = pump(p, 30000);
  const st = p.__state().slots[0];
  assert.equal(st.pendingSeek, false);
  assert.equal(st.pieces, 2, 'decoder restarted at the segment (header + segment)');
  const got = stripSilence(out, 2);
  assertSamples(got, slice(f, frameOf(sec, f.rate), got.length / 2), 'segment seek');
});

test('seek beyond the end finishes the track', () => {
  const f = fx.cd;
  streamTrack(p, false, f).open();
  p.play();
  p.offset(1e6);
  pump(p, 4096);
  assert.equal(p.hasStreamFinished(), true);
  assert.equal(p.status(), 'Stopped');
});

// ------------------------------------------------------------ track transitions
test('gapless: same-format next track continues with no gap or click', () => {
  const a = fx.partA, b = fx.partB;
  streamTrack(p, false, a).open();
  p.play();
  p.offset((a.frames - 30000) / a.rate);
  streamTrack(p, true, b).open();
  const out = pump(p, 60000);
  // continuous signal split across two files: output must be seamless
  const want = new Float32Array(60000 * 2);
  want.set(a.ref.subarray((a.frames - 30000) * 2));
  want.set(b.ref.subarray(0, 30000 * 2), 30000 * 2);
  assertSamples(out, want, 'gapless join');
  assert.equal(p.hasStreamFinished(), true);
  assert.equal(p.status(), 'Playing');
  assert.equal(p.offset(), a.frames / a.rate, 'position pinned to end until switch');
  assert.equal(p.__state().autoAdvanced, true);
  p.switchToNext();
  assert.equal(p.offset(), 30000 / b.rate, 'position carries over');
  assert.equal(p.hasStreamFinished(), false);
  assert.equal(p.play(), undefined);
  assertSamples(pump(p, 5000), slice(b, 30000, 5000), 'after switch');
});

test('different-format next track: no auto-advance; switchToNext re-opens device at new rate', () => {
  const a = fx.cd, b = fx.other;
  streamTrack(p, false, a).open();
  p.play();
  p.offset((a.frames - 2000) / a.rate);
  streamTrack(p, true, b).open();
  const out = pump(p, 6000);
  assertSamples(out.subarray(0, 4000), slice(a, a.frames - 2000, 2000), 'tail');
  assert.equal(countSilentFrames(out.subarray(4000), 2), 4000);
  assert.equal(p.__state().autoAdvanced, false);
  assert.equal(p.hasStreamFinished(), true);
  p.switchToNext();
  assert.equal(p.play(), undefined);
  assert.equal(p.__state().devRate, 48000);
  assertSamples(pump(p, 8000), slice(b, 0, 8000), 'next from start');
});

test('clearNextTrack() prevents the gapless advance', () => {
  const a = fx.partA, b = fx.partB;
  streamTrack(p, false, a).open();
  p.play();
  p.offset((a.frames - 1000) / a.rate);
  streamTrack(p, true, b).open();
  p.clearNextTrack();
  assert.equal(p.__state().slots[1].opened, false);
  const out = pump(p, 3000);
  assert.equal(countSilentFrames(out, 2), 2000);
  assert.equal(p.__state().autoAdvanced, false);
});

// ------------------------------------------------------------ lifecycle
test('pause holds position and outputs silence; play resumes exactly', () => {
  const f = fx.cd;
  streamTrack(p, false, f).open();
  p.play();
  pump(p, 10000);
  p.pause();
  assert.equal(p.status(), 'Stopped');
  assert.equal(p.offset(), 10000 / f.rate);
  assert.equal(p.__state().devStarted, false, 'device stopped while paused');
  p.play();
  assertSamples(pump(p, 4000), slice(f, 10000, 4000), 'resume');
});

test('close() variants and releaseResources()', () => {
  streamTrack(p, false, fx.cd).open();
  streamTrack(p, true, fx.partB).open();
  p.play();
  p.close(); // current only
  let st = p.__state();
  assert.equal(st.slots[0].opened, false);
  assert.equal(st.slots[1].opened, true, 'close() keeps the prepared next track');
  streamTrack(p, false, fx.cd).open();
  p.play();
  p.close(false); // both, keep device
  st = p.__state();
  assert.equal(st.slots[1].opened, false);
  assert.equal(st.devRate, 44100, 'device kept');
  streamTrack(p, false, fx.cd).open();
  p.play();
  p.close(true); // both + release device
  assert.equal(p.__state().devRate, 0);
  streamTrack(p, false, fx.cd).open();
  p.play();
  p.releaseResources();
  st = p.__state();
  assert.equal(st.devStarted, false);
  assert.equal(st.playing, false);
});

test('lookAheadInSeconds is accepted', () => {
  p.lookAheadInSeconds(12);
  assert.equal(p.__state().lookAhead, 12);
});

// ------------------------------------------------------------ devices
test('device list, selection while playing, unknown device, hotplug notification', async () => {
  p.__setFakeDevices(['DAC One', 'Headphones']);
  const list = p.getAvailableDeviceList();
  assert.deepEqual(list.map((d) => d.name), ['System default', 'DAC One', 'Headphones']);
  assert.ok(list.every((d) => typeof d.type === 'string' && d.type.length));
  const f = fx.cd;
  streamTrack(p, false, f).open();
  p.play();
  const before = pump(p, 3000);
  assert.equal(p.useDevice('DAC One', list[1].type), undefined);
  assert.equal(p.deviceInformation().name, 'DAC One');
  assert.equal(p.__state().devStarted, true, 'playback resumed on new device');
  const after = pump(p, 3000);
  const joined = new Float32Array(12000); joined.set(before); joined.set(after, 6000);
  assertSamples(joined, slice(f, 0, 6000), 'no samples lost across device switch');
  assert.equal(typeof p.useDevice('Nope', 'x'), 'string', 'unknown device -> error string');
  assert.equal(p.deviceInformation().name, 'DAC One', 'selection unchanged after failure');

  const calls = [];
  p.setDeviceChangedListener((e) => calls.push(e));
  // Notifications go through a ThreadSafeFunction, i.e. libuv's async queue;
  // a single setImmediate tick does not guarantee delivery, so wait for it.
  const settle = async (n, ms = 1000) => {
    const end = Date.now() + ms;
    while (calls.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20)); // let any extra (wrong) call land too
  };
  p.__maintain(true);
  await settle(1);
  assert.equal(calls.length, 1, 'initial notification');
  p.__maintain(true);
  await settle(2, 100);
  assert.equal(calls.length, 1, 'no notification without change');
  p.__setFakeDevices(['DAC One', 'Headphones', 'USB Speaker']);
  p.__maintain(true);
  await settle(2);
  assert.equal(calls.length, 2, 'hotplug notification');
  assert.deepEqual(calls[1].deviceList.map((d) => d.name).slice(-1), ['USB Speaker']);
  assert.equal(calls[1].currentDevice.name, 'DAC One');
});

// ------------------------------------------------------------ cache ranges
test('CacheRanges: merging, contains, isComplete, getRangeCopy', () => {
  const r = p.newCacheRanges();
  r.setCacheSize(100);
  r.addRange(10, 20); r.addRange(30, 40); r.addRange(20, 30);
  assert.deepEqual(r.getRangeCopy(1), [{ start: 10, end: 40 }]);
  assert.equal(r.contains(25), true);
  assert.equal(r.contains(45), false);
  assert.equal(r.isComplete(), false);
  r.addRange(0, 10); r.addRange(40, 100);
  assert.equal(r.isComplete(), true);
  const t = p.newCacheRanges();
  t.addRange(1.5, 2.5);
  assert.deepEqual(t.getRangeCopy(1000), [{ start: 1500, end: 2500 }]);
});

// ------------------------------------------------------------ randomized
test('randomized HLS session: out-of-order segments, random seeks, exact output after every seek', () => {
  const f = fx.hires;
  const { headerLen, segs } = hlsSegments(f.bytes, f.rate, 0.5);
  for (const seed of [1, 2, 3, 4, 5]) {
    reset(p);
    const R = rng(seed);
    const t = streamTrack(p, false, f, { fill: false });
    t.add(0, headerLen);
    const have = new Set();
    const addSeg = (k) => { if (k < segs.length && !have.has(k)) { have.add(k); t.add(segs[k].start, segs[k].end, segs[k].t0, segs[k].dur); } };
    addSeg(0); addSeg(1);
    t.open();
    p.play();
    for (let step = 0; step < 12; step++) {
      const sec = R() * (f.frames / f.rate) * 0.95;
      p.offset(sec);
      const k = segs.findIndex((s) => sec >= s.t0 && sec < s.t0 + s.dur);
      // downloader fetches from k onward, sometimes with random extra segments first
      if (R() < 0.5) addSeg(Math.floor(R() * segs.length));
      for (let j = k; j < Math.min(segs.length, k + 3); j++) addSeg(j);
      const out = pump(p, 6000, { chunk: 512 + Math.floor(R() * 1500) });
      const got = stripSilence(out, 2);
      const start = frameOf(sec, f.rate);
      const n = Math.min(got.length / 2, f.frames - start);
      assert.ok(n > 1000, `seed ${seed} step ${step}: produced audio after seek`);
      assertSamples(got.subarray(0, n * 2), slice(f, start, n), `seed ${seed} step ${step} seek ${sec.toFixed(3)}`);
    }
  }
});
