// Minimal FLAC frame locator: finds frame headers (sync + CRC-8 verified) so
// tests can split a file into HLS-like segments at real frame boundaries.
function crc8(buf, start, end) {
  let c = 0;
  for (let i = start; i < end; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

export function flacFrames(buf) {
  // skip metadata blocks
  let p = 4;
  for (;;) {
    const last = buf[p] & 0x80;
    const len = buf.readUIntBE(p + 1, 3);
    p += 4 + len;
    if (last) break;
  }
  const frames = [];
  let sample = 0;
  for (let i = p; i < buf.length - 16; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xfe) !== 0xf8) continue;
    const bsCode = buf[i + 2] >> 4, srCode = buf[i + 2] & 0x0f;
    if (bsCode === 0 || srCode === 15 || (buf[i + 3] & 1)) continue;
    let q = i + 4;
    const lead = buf[q];
    let n = 0;
    if (lead < 0x80) n = 0; else if ((lead & 0xe0) === 0xc0) n = 1; else if ((lead & 0xf0) === 0xe0) n = 2;
    else if ((lead & 0xf8) === 0xf0) n = 3; else if ((lead & 0xfc) === 0xf8) n = 4; else if ((lead & 0xfe) === 0xfc) n = 5; else continue;
    q += 1 + n;
    let block;
    if (bsCode === 1) block = 192;
    else if (bsCode <= 5) block = 576 << (bsCode - 2);
    else if (bsCode === 6) { block = buf[q] + 1; q += 1; }
    else if (bsCode === 7) { block = buf.readUInt16BE(q) + 1; q += 2; }
    else block = 256 << (bsCode - 8);
    if (srCode === 12) q += 1; else if (srCode === 13 || srCode === 14) q += 2;
    if (crc8(buf, i, q) !== buf[q]) continue;
    frames.push({ offset: i, startSample: sample, samples: block });
    sample += block;
    i = q; // frames can't overlap their own header
  }
  return { headerLen: p, frames };
}

// Group frames into segments of ~`seconds` each: [{start,end,t0,dur}] in bytes/seconds.
export function hlsSegments(buf, rate, seconds = 1) {
  const { headerLen, frames } = flacFrames(buf);
  const segs = [];
  let cur = null;
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k];
    if (!cur || (f.startSample - cur.startSample) / rate >= seconds) {
      if (cur) segs.push(cur);
      cur = { start: f.offset, startSample: f.startSample, samples: 0 };
    }
    cur.samples += f.samples;
    cur.end = k + 1 < frames.length ? frames[k + 1].offset : buf.length;
  }
  segs.push(cur);
  return { headerLen, segs: segs.map((s) => ({ ...s, t0: s.startSample / rate, dur: s.samples / rate })) };
}
