// Minimal VFS for the renderer test page: .pak files + loose files, later mounts override.
// (The real VFS is src/content; this only exists so render.html works on its own.)
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import type { Vfs } from '../../content/types';

export class PakVfs implements Vfs {
  private files = new Map<string, Uint8Array>();

  mountPak(data: Uint8Array): number {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (String.fromCharCode(data[0], data[1], data[2], data[3]) !== 'PACK') throw new Error('not a pak');
    const ofs = dv.getInt32(4, true), len = dv.getInt32(8, true);
    let n = 0;
    for (let i = 0; i < len / 64; i++) {
      const o = ofs + i * 64;
      let name = '';
      for (let k = 0; k < 56 && data[o + k]; k++) name += String.fromCharCode(data[o + k]);
      const pos = dv.getInt32(o + 56, true), size = dv.getInt32(o + 60, true);
      this.files.set(name.toLowerCase(), data.subarray(pos, pos + size));
      n++;
    }
    return n;
  }

  add(path: string, data: Uint8Array): void { this.files.set(path.toLowerCase(), data); }
  get(path: string): Uint8Array | null { return this.files.get(path.toLowerCase()) ?? null; }
  has(path: string): boolean { return this.files.has(path.toLowerCase()); }
  list(prefix: string): string[] { return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort(); }
}

export async function fetchBytes(url: string): Promise<Uint8Array | null> {
  const r = await fetch(url);
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}
