// Gapless: two same-format tracks; the device should roll into the next track
// at EOF before JS calls switchToNext(), and position should carry over.
const fs = require('fs');
const [addonPath, file] = process.argv.slice(2);
const m = { exports: {} };
process.dlopen(m, addonPath);
const p = m.exports();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (c, msg) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${msg}`); if (!c) fails++; };

function load(isNext, bytes) {
  const t = p.newCacheRanges(), d = p.newCacheRanges(), buf = Buffer.from(bytes);
  d.setCacheSize(buf.length); p.initCacheRange(isNext, t, d); d.addRange(0, buf.length);
  return p.openStream(isNext, buf, 'flac', 0);
}
(async () => {
  const a = fs.readFileSync(file);
  p.volume(4);
  check(load(false, a), 'open current');
  check(!p.play(), 'play');
  p.offset(18.5);
  check(load(true, a), 'prepare next (same format)');
  await sleep(2200);                                   // current ends ~1.5 s in
  check(p.hasStreamFinished(), 'current reports finished');
  check(p.status() === 'Playing', `status stays Playing across boundary (${p.status()})`);
  check(Math.abs(p.offset() - p.trackInformation(false).duration / 1000) < 0.05, 'offset pinned to current duration until switch');
  p.switchToNext();
  const pos = p.offset();
  check(pos > 0.4 && pos < 1.2, `after switch, next already advanced to ${pos.toFixed(2)}s (no gap/restart)`);
  check(!p.hasStreamFinished(), 'finished flag cleared after switch');
  p.close(true);
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})();
