/**
 * Content: the VFS the game reads every file through, and how packs get into it.
 *
 *   const content = createContent();                 // packs from ./packs/
 *   await content.loadBase(progress);                 // base pack (+ the player's id paks, art only)
 *   await content.loadRoom([{ id: 'maps-qt' }, { id: qtdmId }, { id: sha, url }], progress);
 *   renderer = new Renderer(canvas, content.vfs, …);  // full view (art)
 *   sim.loadMap(content.vfs.sim.get('maps/qt_aero.bsp'))  // sim view: never id paks
 *
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */
import { IdPaks } from './idpaks';
import { PackLoader, type PackLoaderOptions } from './packs';
import type { PackIndexEntry, PackMapInfo, PackRef, Progress } from './types';
import { PackVfs } from './vfs';

export type { Vfs, PackRef, PackIndexEntry, PackMapInfo, PackArchive, PackRole, Progress } from './types';
export { PackVfs, type Mount } from './vfs';
export { PackLoader, sha256Hex, fetchBytes } from './packs';
export { IdPaks } from './idpaks';
export { openPack } from './archive';
export { LIMITS, PackError, sanitizePath } from './sanitize';
export { MemoryStore, IdbStore, defaultStore } from './store';

export interface Content {
  vfs: PackVfs;
  loader: PackLoader;
  idPaks: IdPaks;
  /** mount the base pack (by name from the index) and the stored id paks */
  loadBase(onProgress?: Progress): Promise<void>;
  /** replace the room packs: refs by name ("maps-qt"), short id, or full sha256 (+ url) */
  loadRoom(refs: PackRef[], onProgress?: Progress): Promise<void>;
  /** every map the mounted packs describe (maps.json), later packs first */
  maps(): PackMapInfo[];
  index(): Promise<PackIndexEntry[]>;
  cacheLocalPack(file: File): Promise<{ id: string; name: string; bytes: number }>;
}

export function createContent(opts: PackLoaderOptions = {}): Content {
  const vfs = new PackVfs();
  const loader = new PackLoader(opts);
  const idPaks = new IdPaks(undefined, vfs);
  return {
    vfs, loader, idPaks,
    async loadBase(onProgress) {
      await loader.mountAll(vfs, [{ ref: { id: 'base' }, role: 'base' }], onProgress);
      try { await idPaks.mount(vfs); } catch (e) { console.warn('id paks not mounted:', e); }
    },
    async loadRoom(refs, onProgress) {
      vfs.unmountRole('room');
      await loader.mountAll(vfs, refs.map((ref) => ({ ref, role: 'room' as const })), onProgress);
    },
    maps() {
      const out: PackMapInfo[] = [];
      const seen = new Set<string>();
      for (const m of [...vfs.mounts()].reverse()) {
        if (m.role === 'idpak') continue;
        const j = m.archive.read('maps.json');
        if (!j) continue;
        try {
          for (const x of JSON.parse(new TextDecoder().decode(j)) as PackMapInfo[]) {
            if (!seen.has(x.name)) { seen.add(x.name); out.push(x); }
          }
        } catch { /* malformed maps.json: ignore */ }
      }
      return out;
    },
    index: () => loader.index(),
    cacheLocalPack: (file) => loader.cacheLocalPack(file),
  };
}
