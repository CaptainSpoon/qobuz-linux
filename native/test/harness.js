// Exercise qobuz_audio.node the way Qobuz's TrackController does.
// Run: ELECTRON_RUN_AS_NODE=1 electron harness.js <addon.node> <a.flac> <b.flac>
const fs = require('fs');
const [addonPath, fileA, fileB] = process.argv.slice(2);
const m = { exports: {} };
process.dlopen(m, addonPath);
const player = m.exports();          // juce.node export is a factory
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

// Find FLAC frame offsets (fixed-blocksize sync 0xFFF8 with sequential frame numbers).
function frameOffsets(buf) {
  const out = []; let want = 0;
  for (let i = 42; i < buf.length - 6; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xf8) {
      const fn = buf[i + 4]; // frame number (UTF-8 coded; < 128 single byte)
      if (fn === (want & 0x7f) || (want >= 128 && (buf[i + 4] & 0xc0) === 0xc0)) { out.push(i); want++; }
    }
  }
  return out;
}

async function main() {
  player.setDeviceChangedListener((d) => console.log('device list:', d.deviceList.map((x) => `${x.name} [${x.type}]`).join(' | ')));
  const devs = player.getAvailableDeviceList();
  check(Array.isArray(devs) && devs.length > 0 && devs[0].name && devs[0].type, `getAvailableDeviceList -> ${devs.length} device(s)`);
  check(!player.useDevice(devs[0].name, devs[0].type), `useDevice("${devs[0].name}") succeeds`);
  player.volume(4);

  // ---- 1. progressive stream (CLEAR_STREAM style: linear chunks from 0)
  const a = fs.readFileSync(fileA);
  const time = player.newCacheRanges(), data = player.newCacheRanges();
  const buf = Buffer.alloc(a.length, 0);
  data.setCacheSize(a.length);
  player.initCacheRange(false, time, data);
  let off = 0; const chunk = 64 * 1024;
  const feed = (n) => { const e = Math.min(a.length, off + n); a.copy(buf, off, off, e); data.addRange(off, e); off = e; };
  feed(8 * 1024);
  check(player.openStream(false, buf, 'flac', 0) === true, 'openStream(current) returns true');
  const ti = player.trackInformation(false);
  check(Math.abs(ti.duration - 20000) < 300 && ti.sampleRate === 44100, `trackInformation: ${ti.duration.toFixed(0)} ms, ${ti.sampleRate} Hz, ${ti.bitsPerSample} bit`);
  check(!player.play(), 'play() returns no error');
  await sleep(1500);
  check(player.status() === 'Blocked', `status while starved = ${player.status()}`);
  const feeder = setInterval(() => off < a.length && feed(chunk), 40);
  await sleep(1500);
  check(player.status() === 'Playing', `status after buffering = ${player.status()}`);
  const p1 = player.offset(); await sleep(1000); const p2 = player.offset();
  check(p2 - p1 > 0.8 && p2 - p1 < 1.2, `position advances ~1s/s (${p1.toFixed(2)} -> ${p2.toFixed(2)})`);
  player.pause(); const pp = player.offset(); await sleep(500);
  check(player.status() === 'Stopped' && Math.abs(player.offset() - pp) < 0.05, 'pause holds position');
  check(!player.play(), 'resume');
  await sleep(800); clearInterval(feeder); while (off < a.length) feed(chunk);
  check(data.isComplete(), 'data ranges complete');
  player.offset(17.0); await sleep(200);
  check(Math.abs(player.offset() - 17.2) < 0.4, `seek within buffered data -> ${player.offset().toFixed(2)}s`);

  // ---- 2. prepare next (HLS style: init block + segments, paired time ranges)
  const b = fs.readFileSync(fileB);
  const frames = frameOffsets(b);
  const headerLen = frames[0];
  const segFrames = 20; // ~1 s per segment at 96k/4608
  const segs = [];
  for (let i = 0; i < frames.length; i += segFrames) {
    const s = frames[i], e = i + segFrames < frames.length ? frames[i + segFrames] : b.length;
    segs.push({ s, e, t0: (i * 4608) / 96000, dur: (Math.min(segFrames, frames.length - i) * 4608) / 96000 });
  }
  const tN = player.newCacheRanges(), dN = player.newCacheRanges();
  const bufN = Buffer.alloc(b.length, 0);
  dN.setCacheSize(b.length); player.initCacheRange(true, tN, dN);
  const addSeg = (k) => { const g = segs[k]; b.copy(bufN, g.s, g.s, g.e); dN.addRange(g.s, g.e); tN.addRange(g.t0, g.t0 + g.dur); };
  b.copy(bufN, 0, 0, headerLen); dN.addRange(0, headerLen);   // init block (no time range)
  addSeg(0); addSeg(1); addSeg(2);
  check(player.openStream(true, bufN, 'flac', 0) === true, `openStream(next) HLS-style, ${segs.length} segments`);
  check(player.trackInformation(true).sampleRate === 96000, 'next track info 96 kHz/24 bit');

  // ---- 3. reach end of current: hasStreamFinished + switch
  let finished = false;
  for (let i = 0; i < 60 && !finished; i++) { await sleep(100); finished = player.hasStreamFinished(); }
  check(finished, 'hasStreamFinished() at end of track');
  player.switchToNext();
  check(!player.play(), 'play() after switchToNext (device re-opened at 96 kHz)');
  await sleep(1200);
  check(player.status() === 'Playing' && player.offset() > 0.5, `next track playing, pos ${player.offset().toFixed(2)}s, device ${JSON.stringify(player.deviceInformation())}`);

  // ---- 4. seek into a segment that is not downloaded yet
  const k = Math.floor(segs.length * 0.7);
  const target = segs[k].t0 + 0.4;
  player.offset(target); await sleep(150);
  check(player.status() === 'Blocked', `seek to undownloaded ${target.toFixed(2)}s -> ${player.status()}`);
  for (let j = k; j < segs.length; j++) addSeg(j);              // downloader fetches from segment k
  await sleep(700);
  const pos = player.offset();
  check(player.status() === 'Playing' && pos > target && pos < target + 1.0, `segment seek resumed at ${pos.toFixed(2)}s`);

  // ---- 5. local file open
  player.close(false);
  check(player.open(false, fileA, 'flac') === true, 'open(file)');
  check(!player.play(), 'play local file'); await sleep(600);
  check(player.status() === 'Playing' && player.offset() > 0.3, `local file playing at ${player.offset().toFixed(2)}s`);
  check(player.open(false, '/nonexistent.flac', 'flac') === false, 'open(missing file) returns false');
  player.close(true);
  check(player.status() === 'Stopped', 'close(true) -> Stopped');
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
