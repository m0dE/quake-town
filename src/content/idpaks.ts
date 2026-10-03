/**
 * The player's own id paks (pak0.pak / pak1.pak from their Quake install).
 * Stored in this browser only (IndexedDB), never uploaded, never advertised to a room, and
 * mounted for ART ONLY: they sit between `base` and the room packs, and `vfs.sim` (what the
 * sim loader reads maps/progs from) never sees them (DESIGN.md "Licensing", "Content packs").
 * Implements the menu's IdPakLoader (src/menu/types.ts).
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */
import { openPack } from './archive';
import { LIMITS, PackError } from './sanitize';
import { defaultStore, STORE_IDPAKS, type BlobStore } from './store';
import type { PackVfs } from './vfs';

const NAMES = ['pak0', 'pak1'] as const;

export class IdPaks {
  readonly store: BlobStore;
  constructor(store?: BlobStore, private readonly vfs?: PackVfs) {
    this.store = store ?? defaultStore(STORE_IDPAKS);
  }

  async status(): Promise<{ loaded: boolean; files: { name: string; bytes: number }[] }> {
    const l = (await this.store.list()).filter((x) => (NAMES as readonly string[]).includes(x.key)).sort((a, b) => a.key.localeCompare(b.key));
    return { loaded: l.length > 0, files: l.map((x) => ({ name: `${x.key}.pak`, bytes: x.size })) };
  }

  /** Validate and store pak files picked by the player; mounts them if a VFS was given. */
  async load(files: (Blob & { name: string })[]): Promise<{ ok: boolean; message: string }> {
    const accepted: string[] = [];
    const problems: string[] = [];
    for (const f of files) {
      const m = /^(pak[01])\.pak$/i.exec(f.name.split(/[\\/]/).pop() || '');
      if (!m) { problems.push(`${f.name}: only pak0.pak and pak1.pak are used`); continue; }
      const key = m[1].toLowerCase();
      if (f.size > LIMITS.idPakBytes) { problems.push(`${f.name} is too large to be a Quake pak`); continue; }
      const bytes = new Uint8Array(await f.arrayBuffer());
      let ar;
      try { ar = openPack(bytes, { limits: false, maxEntries: 16384 }); } catch (e) { problems.push(`${f.name}: ${(e as Error).message}`); continue; }
      if (ar.format !== 'pak') { problems.push(`${f.name} is not a Quake .pak`); continue; }
      // sanity: pak0 carries the palette and the player model; pak1 carries registered data
      if (key === 'pak0' && !(ar.has('gfx/palette.lmp') && ar.has('progs/player.mdl'))) { problems.push(`${f.name} does not look like Quake's pak0.pak`); continue; }
      await this.store.put({ key, name: `${key}.pak`, bytes, at: Date.now() });
      accepted.push(`${key}.pak (${Math.round(bytes.length / 1048576)} MB)`);
    }
    if (accepted.length && this.vfs) await this.mount(this.vfs);
    if (!accepted.length) return { ok: false, message: problems.join('; ') || 'No pak files.' };
    return { ok: true, message: `Loaded ${accepted.join(' and ')}.${problems.length ? ' Skipped: ' + problems.join('; ') : ''}` };
  }

  async forget(): Promise<void> {
    for (const k of NAMES) await this.store.delete(k);
    this.vfs?.unmountRole('idpak');
  }

  /** Mount the stored paks (pak0 then pak1) as art-only. Returns how many were mounted. */
  async mount(vfs: PackVfs): Promise<number> {
    vfs.unmountRole('idpak');
    let n = 0;
    for (const k of NAMES) {
      let s;
      try { s = await this.store.get(k); } catch { s = null; }
      if (!s) continue;
      try {
        vfs.mount({ id: `idpak:${k}`, name: `${k}.pak`, role: 'idpak', archive: openPack(s.bytes, { limits: false, maxEntries: 16384 }), bytes: s.bytes.length });
        n++;
      } catch (e) {
        throw new PackError(`stored ${k}.pak is unreadable: ${(e as Error).message}`);
      }
    }
    return n;
  }
}
