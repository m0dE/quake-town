// Quake Town content tools: WAV normaliser for the base pack.
// Keeps what a Quake engine reads (fmt, data, the "cue " loop start and the adtl/ltxt loop
// length), drops metadata (ID3, JUNK, LIST INFO, SAUR), and resamples anything above
// 22050 Hz down to 22050 Hz (windowed sinc, deterministic). Mono/16-bit or 8-bit is kept.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.

const TARGET = 22050;

function chunks(b) {
  const out = [];
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return null;
  let o = 12;
  while (o + 8 <= b.length) {
    const id = b.toString('latin1', o, o + 4);
    const len = b.readUInt32LE(o + 4);
    out.push({ id, data: b.subarray(o + 8, Math.min(b.length, o + 8 + len)) });
    o += 8 + len + (len & 1);
  }
  return out;
}

function resample(samples, inRate, outRate) {
  const ratio = inRate / outRate;
  const n = Math.floor(samples.length / ratio);
  const out = new Float64Array(n);
  const fc = (outRate / inRate) * 0.92; // cutoff relative to the input Nyquist
  const W = Math.ceil(12 / fc); // half-width in input samples
  for (let i = 0; i < n; i++) {
    const t = i * ratio;
    const c = Math.floor(t);
    let acc = 0, wsum = 0;
    for (let k = c - W + 1; k <= c + W; k++) {
      if (k < 0 || k >= samples.length) continue;
      const x = t - k;
      const s = x === 0 ? 1 : Math.sin(Math.PI * fc * x) / (Math.PI * fc * x);
      const w = 0.42 + 0.5 * Math.cos(Math.PI * x / W) + 0.08 * Math.cos(2 * Math.PI * x / W); // Blackman
      const h = s * w;
      acc += samples[k] * h; wsum += h;
    }
    out[i] = wsum ? acc / wsum : 0;
  }
  return out;
}

function riff(parts) {
  const body = [];
  for (const [id, data] of parts) {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'latin1'); h.writeUInt32LE(data.length, 4);
    body.push(h, data);
    if (data.length & 1) body.push(Buffer.alloc(1));
  }
  const b = Buffer.concat(body);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(b.length + 4, 4); head.write('WAVE', 8, 'latin1');
  return Buffer.concat([head, b]);
}

/** Returns normalised WAV bytes (or the input unchanged if it is not a plain PCM WAV). */
export function normalizeWav(input) {
  const b = Buffer.from(input);
  const cs = chunks(b);
  if (!cs) return b;
  const fmt = cs.find((c) => c.id === 'fmt ');
  const data = cs.find((c) => c.id === 'data');
  if (!fmt || !data) return b;
  const format = fmt.data.readUInt16LE(0), ch = fmt.data.readUInt16LE(2);
  const rate = fmt.data.readUInt32LE(4), bits = fmt.data.readUInt16LE(14);
  if (format !== 1 || ch !== 1 || (bits !== 8 && bits !== 16)) return b;
  let cue = cs.find((c) => c.id === 'cue ');
  let list = cs.find((c) => c.id === 'LIST' && c.data.toString('latin1', 0, 4) === 'adtl');
  let pcm = data.data, outRate = rate;
  if (rate > TARGET) {
    const n = bits === 16 ? pcm.length >> 1 : pcm.length;
    const s = new Float64Array(n);
    for (let i = 0; i < n; i++) s[i] = bits === 16 ? pcm.readInt16LE(i * 2) : pcm[i] - 128;
    const r = resample(s, rate, TARGET);
    const out = Buffer.alloc(r.length * (bits >> 3));
    for (let i = 0; i < r.length; i++) {
      if (bits === 16) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r[i]))), i * 2);
      else out[i] = Math.max(0, Math.min(255, Math.round(r[i]) + 128));
    }
    pcm = out; outRate = TARGET;
    const scale = (v) => Math.round(v * TARGET / rate);
    if (cue && cue.data.length >= 28) {
      const c = Buffer.from(cue.data);
      c.writeUInt32LE(scale(c.readUInt32LE(4 + 20)), 4 + 20); // first cue point dwSampleOffset
      c.writeUInt32LE(scale(c.readUInt32LE(4 + 4)), 4 + 4);   // dwPosition
      cue = { id: 'cue ', data: c };
    }
    if (list) {
      const l = Buffer.from(list.data);
      // adtl sub-chunks: 'ltxt' carries the sample length at +4 (after the cue id)
      let o = 4;
      while (o + 8 <= l.length) {
        const id = l.toString('latin1', o, o + 4), len = l.readUInt32LE(o + 4);
        if (id === 'ltxt' && len >= 8) l.writeUInt32LE(scale(l.readUInt32LE(o + 12)), o + 12);
        o += 8 + len + (len & 1);
      }
      list = { id: 'LIST', data: l };
    }
  }
  const f = Buffer.from(fmt.data.subarray(0, 16));
  f.writeUInt32LE(outRate, 4);
  f.writeUInt32LE(outRate * (bits >> 3), 8);
  f.writeUInt16LE(bits >> 3, 12);
  const parts = [['fmt ', f], ['data', pcm]];
  if (cue) parts.push(['cue ', cue.data]);
  if (list) parts.push(['LIST', list.data]);
  return riff(parts);
}
