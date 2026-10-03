/**
 * Pack readers: .pk3 (zip, stored or deflate, zip64 tolerated) and Quake .pak. Directory
 * parsing is eager, file data lazy; stored zip entries and pak files are zero-copy views
 * into the pack bytes, deflated entries are inflated once (fflate) and cached.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */
import { inflateSync } from 'fflate';
import type { PackArchive } from './types';
import { LIMITS, PackError, checkFileSize, sanitizePath } from './sanitize';

interface ZipEntry { method: number; csize: number; size: number; local: number }

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 0x100000000;
const latin1 = (b: Uint8Array, o: number, n: number) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]); return s; };
const utf8 = new TextDecoder('utf-8');

export interface OpenOptions {
  /** enforce the community sandbox limits (entries, per-file sizes). Built-ins pass true too. */
  limits?: boolean;
  /** maximum entries (default LIMITS.zipEntries); id paks use a larger value */
  maxEntries?: number;
}

/** Detect the format and parse. Throws PackError on malformed or unsafe packs. */
export function openPack(bytes: Uint8Array, opts: OpenOptions = {}): PackArchive {
  if (bytes.length >= 4 && latin1(bytes, 0, 4) === 'PACK') return new PakArchive(bytes, opts);
  if (bytes.length >= 4 && u32(bytes, 0) === 0x04034b50) return new Pk3Archive(bytes, opts);
  if (bytes.length >= 22 && u32(bytes, 0) === 0x06054b50) return new Pk3Archive(bytes, opts); // empty zip
  throw new PackError('not a .pk3 or .pak file');
}

export class Pk3Archive implements PackArchive {
  readonly format = 'pk3' as const;
  private entries = new Map<string, ZipEntry>();
  private cache = new Map<string, Uint8Array>();

  constructor(private readonly b: Uint8Array, opts: OpenOptions = {}) {
    const limits = opts.limits ?? true;
    const max = opts.maxEntries ?? LIMITS.zipEntries;
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new PackError('zip: no end of central directory');
    let count = u16(b, eocd + 10);
    let p = u32(b, eocd + 16);
    if (count === 0xffff || p === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || u32(b, loc) !== 0x07064b50) throw new PackError('zip: zip64 locator missing');
      const e64 = u64(b, loc + 8);
      count = u64(b, e64 + 32);
      p = u64(b, e64 + 48);
    }
    if (count > max) throw new PackError(`zip: ${count} entries (at most ${max})`);
    for (let i = 0; i < count; i++) {
      if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new PackError('zip: bad central directory');
      const flags = u16(b, p + 8);
      const method = u16(b, p + 10);
      let csize = u32(b, p + 20), size = u32(b, p + 24);
      const nameLen = u16(b, p + 28), extraLen = u16(b, p + 30), commentLen = u16(b, p + 32);
      let local = u32(b, p + 42);
      const nameBytes = b.subarray(p + 46, p + 46 + nameLen);
      const rawName = (flags & 0x800) ? utf8.decode(nameBytes) : latin1(b, p + 46, nameLen);
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = u16(b, e), len = u16(b, e + 2);
        if (id === 1) {
          let q = e + 4;
          if (size === 0xffffffff) { size = u64(b, q); q += 8; }
          if (csize === 0xffffffff) { csize = u64(b, q); q += 8; }
          if (local === 0xffffffff) { local = u64(b, q); q += 8; }
        }
        e += 4 + len;
      }
      p += 46 + nameLen + extraLen + commentLen;
      if (rawName.endsWith('/')) continue; // directory
      const name = sanitizePath(rawName);
      if (!name) throw new PackError(`zip: unsafe path "${rawName}"`);
      if (flags & 1) throw new PackError(`zip: ${name} is encrypted`);
      if (method !== 0 && method !== 8) throw new PackError(`zip: ${name} uses compression method ${method}`);
      if (method === 0 && csize !== size) throw new PackError(`zip: ${name} stored size mismatch`);
      if (local + 30 > b.length || local + csize > b.length) throw new PackError(`zip: ${name} points outside the file`);
      if (limits) checkFileSize(name, size);
      if (!this.entries.has(name)) this.entries.set(name, { method, csize, size, local });
    }
  }

  paths(): string[] { return [...this.entries.keys()]; }
  has(path: string): boolean { return this.entries.has(path); }
  size(path: string): number { return this.entries.get(path)?.size ?? -1; }

  read(path: string): Uint8Array | null {
    const c = this.cache.get(path);
    if (c) return c;
    const e = this.entries.get(path);
    if (!e) return null;
    const b = this.b;
    if (u32(b, e.local) !== 0x04034b50) throw new PackError(`zip: bad local header for ${path}`);
    const start = e.local + 30 + u16(b, e.local + 26) + u16(b, e.local + 28);
    const data = b.subarray(start, start + e.csize);
    if (e.method === 0) return data; // zero-copy
    const out = inflateSync(data, { out: new Uint8Array(e.size) });
    if (out.length !== e.size) throw new PackError(`zip: ${path} inflated to ${out.length}, expected ${e.size}`);
    this.cache.set(path, out);
    return out;
  }
}

export class PakArchive implements PackArchive {
  readonly format = 'pak' as const;
  private files = new Map<string, Uint8Array>();

  constructor(b: Uint8Array, opts: OpenOptions = {}) {
    const limits = opts.limits ?? true;
    const max = opts.maxEntries ?? LIMITS.zipEntries;
    if (b.length < 12) throw new PackError('pak: truncated');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const dirofs = dv.getInt32(4, true), dirlen = dv.getInt32(8, true);
    if (dirofs < 12 || dirlen < 0 || dirlen % 64 || dirofs + dirlen > b.length) throw new PackError('pak: bad directory');
    const n = dirlen / 64;
    if (n > max) throw new PackError(`pak: ${n} entries (at most ${max})`);
    for (let i = 0; i < n; i++) {
      const o = dirofs + i * 64;
      let end = 0;
      while (end < 56 && b[o + end]) end++;
      const raw = latin1(b, o, end);
      const pos = dv.getInt32(o + 56, true), size = dv.getInt32(o + 60, true);
      const name = sanitizePath(raw);
      if (!name) throw new PackError(`pak: unsafe path "${raw}"`);
      if (pos < 0 || size < 0 || pos + size > b.length) throw new PackError(`pak: ${name} points outside the file`);
      if (limits) checkFileSize(name, size);
      if (!this.files.has(name)) this.files.set(name, b.subarray(pos, pos + size));
    }
  }

  paths(): string[] { return [...this.files.keys()]; }
  has(path: string): boolean { return this.files.has(path); }
  size(path: string): number { return this.files.get(path)?.length ?? -1; }
  read(path: string): Uint8Array | null { return this.files.get(path) ?? null; }
}
