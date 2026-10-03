// Quake Town content tools: zip / pak readers and a deterministic zip writer.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { zipSync } from 'fflate';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Read a zip's central directory. Returns Map(name -> { method, csize, size, offset }). */
export function zipEntries(zip) {
  const b = Buffer.isBuffer(zip) ? zip : Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: no end of central directory');
  let count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  let zip64 = false;
  if (count === 0xffff || p === 0xffffffff) zip64 = true;
  if (zip64) {
    // ZIP64 end of central directory locator sits right before EOCD.
    const loc = eocd - 20;
    if (b.readUInt32LE(loc) !== 0x07064b50) throw new Error('zip: zip64 locator missing');
    const e64 = Number(b.readBigUInt64LE(loc + 8));
    count = Number(b.readBigUInt64LE(e64 + 32));
    p = Number(b.readBigUInt64LE(e64 + 48));
  }
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory');
    const method = b.readUInt16LE(p + 10);
    let csize = b.readUInt32LE(p + 20);
    let size = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    let local = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nameLen);
    // zip64 extra field
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = b.readUInt16LE(e), len = b.readUInt16LE(e + 2);
      if (id === 1) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(b.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(b.readBigUInt64LE(q)); q += 8; }
        if (local === 0xffffffff) { local = Number(b.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    out.set(name, { method, csize, size, offset: local });
  }
  return out;
}

export function zipRead(zip, entry) {
  const b = Buffer.isBuffer(zip) ? zip : Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const l = entry.offset;
  if (b.readUInt32LE(l) !== 0x04034b50) throw new Error('zip: bad local header');
  const start = l + 30 + b.readUInt16LE(l + 26) + b.readUInt16LE(l + 28);
  const data = b.subarray(start, start + entry.csize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`zip: unsupported method ${entry.method}`);
}

/** Quake .pak: Map(name -> Buffer view) */
export function pakEntries(pak) {
  const b = Buffer.isBuffer(pak) ? pak : Buffer.from(pak);
  if (b.toString('latin1', 0, 4) !== 'PACK') throw new Error('pak: bad magic');
  const dirofs = b.readInt32LE(4), dirlen = b.readInt32LE(8);
  const out = new Map();
  for (let i = 0; i < dirlen / 64; i++) {
    const o = dirofs + i * 64;
    let n = b.toString('latin1', o, o + 56);
    n = n.slice(0, n.indexOf('\0') < 0 ? 56 : n.indexOf('\0'));
    const fo = b.readInt32LE(o + 56), fl = b.readInt32LE(o + 60);
    out.set(n.toLowerCase(), b.subarray(fo, fo + fl));
  }
  return out;
}

// 1980-01-01 00:00 is the zip epoch; any fixed date works. fflate takes a Date or ms.
const FIXED_MTIME = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

/**
 * Deterministic pk3: entries sorted by path, fixed mtime, no extra fields, deflate level 9
 * except for already-compressed or tiny files. files: Map|object path -> Uint8Array.
 */
export function writePk3(files) {
  const names = [...(files instanceof Map ? files.keys() : Object.keys(files))].sort();
  const get = (n) => (files instanceof Map ? files.get(n) : files[n]);
  const tree = {};
  for (const n of names) {
    if (n.includes('..') || n.startsWith('/') || n.includes('\\') || n !== n.toLowerCase()) throw new Error(`bad pack path ${n} (Quake paths are lower-case)`);
    const data = new Uint8Array(get(n));
    const store = /\.(ogg|png|jpg|zip|pk3)$/i.test(n) || data.length < 64;
    tree[n] = [data, { level: store ? 0 : 9, mtime: FIXED_MTIME, os: 0 }];
  }
  // fflate's zipSync preserves insertion order of the object (string keys, non-integer).
  return Buffer.from(zipSync(tree, { mtime: FIXED_MTIME }));
}
