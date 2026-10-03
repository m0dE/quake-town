/**
 * The mount-ordered VFS (DESIGN.md "Content packs"). Mount order is by role, then by the
 * order packs were mounted: base → the player's own id paks (art only) → room/local packs.
 * Later mounts override earlier ones. `vfs.sim` is the view the sim loader must use: the
 * same mounts minus the id paks, so maps and progs always come from the room's packs and a
 * player with id paks stays in lockstep.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */
import type { PackArchive, PackRole, Vfs } from './types';

export interface Mount {
  /** sha256 hex of the pack (or a stable name for id paks) */
  id: string;
  name: string;
  role: PackRole;
  archive: PackArchive;
  bytes: number;
}

const ROLE_ORDER: Record<PackRole, number> = { base: 0, idpak: 1, room: 2, local: 2 };

class View implements Vfs {
  index = new Map<string, Mount>();
  sorted: string[] | null = null;
  get(path: string): Uint8Array | null {
    const m = this.index.get(normal(path));
    return m ? m.archive.read(normal(path)) : null;
  }
  has(path: string): boolean { return this.index.has(normal(path)); }
  list(prefix: string): string[] {
    if (!this.sorted) this.sorted = [...this.index.keys()].sort();
    const p = normal(prefix);
    // binary search for the first key >= prefix
    const a = this.sorted;
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < p) lo = mid + 1; else hi = mid; }
    const out: string[] = [];
    for (let i = lo; i < a.length && a[i].startsWith(p); i++) out.push(a[i]);
    return out;
  }
  /** which mount serves a path (debug / UI) */
  owner(path: string): Mount | null { return this.index.get(normal(path)) ?? null; }
}

const normal = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

export class PackVfs implements Vfs {
  private list_: Mount[] = [];
  private all = new View();
  /** read-only view for the simulation: excludes art-only mounts (the player's id paks) */
  readonly sim: Vfs & { owner(path: string): Mount | null } = new View();
  private listeners = new Set<() => void>();

  /** Mount a pack. Re-mounting the same id is a no-op. Returns the mount. */
  mount(m: Mount): Mount {
    const prev = this.list_.find((x) => x.id === m.id && x.role === m.role);
    if (prev) return prev;
    // stable insertion: after every mount whose role order is ≤ this one's
    let at = this.list_.length;
    while (at > 0 && ROLE_ORDER[this.list_[at - 1].role] > ROLE_ORDER[m.role]) at--;
    this.list_.splice(at, 0, m);
    this.rebuild();
    return m;
  }
  unmount(id: string): void {
    const n = this.list_.length;
    this.list_ = this.list_.filter((m) => m.id !== id);
    if (this.list_.length !== n) this.rebuild();
  }
  unmountRole(role: PackRole): void {
    const n = this.list_.length;
    this.list_ = this.list_.filter((m) => m.role !== role);
    if (this.list_.length !== n) this.rebuild();
  }
  mounts(): readonly Mount[] { return this.list_; }
  /** called after any mount change (renderer/audio may drop caches) */
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  get(path: string): Uint8Array | null { return this.all.get(path); }
  has(path: string): boolean { return this.all.has(path); }
  list(prefix: string): string[] { return this.all.list(prefix); }
  owner(path: string): Mount | null { return this.all.owner(path); }

  private rebuild(): void {
    const all = this.all, sim = this.sim as View;
    all.index.clear(); sim.index.clear(); all.sorted = null; sim.sorted = null;
    for (const m of this.list_) {
      for (const p of m.archive.paths()) {
        all.index.set(p, m);
        if (m.role !== 'idpak') sim.index.set(p, m);
      }
    }
    for (const fn of this.listeners) fn();
  }
}
