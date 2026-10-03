// WAD2 reader (miptex lumps). Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
export function wadTextures(b) {
  if (b.toString('latin1', 0, 4) !== 'WAD2') throw new Error('not WAD2');
  const n = b.readInt32LE(4), o = b.readInt32LE(8);
  const out = new Map();
  for (let i = 0; i < n; i++) {
    const e = o + i * 32;
    const type = b[e + 12];
    let nm = b.toString('latin1', e + 16, e + 32);
    nm = nm.slice(0, nm.indexOf('\0') >= 0 ? nm.indexOf('\0') : 16).toLowerCase();
    const fo = b.readInt32LE(e), size = b.readInt32LE(e + 4);
    if (type !== 0x44) continue;
    const w = b.readUInt32LE(fo + 16), h = b.readUInt32LE(fo + 20), off0 = b.readUInt32LE(fo + 24);
    out.set(nm, { name: nm, w, h, pixels: b.subarray(fo + off0, fo + off0 + w * h), lump: b.subarray(fo, fo + size) });
  }
  return out;
}
