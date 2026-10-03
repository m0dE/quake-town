/**
 * The virtual file system every part reads game files through (DESIGN.md "Content packs").
 * Owned by the content part; the renderer, audio, HUD and the sim loader only use this
 * interface. Paths are Quake paths, lower-case, forward slashes: "maps/qt_aero.bsp".
 */
export interface Vfs {
  /** The file's bytes from the highest-priority mounted pack that has it, or null. */
  get(path: string): Uint8Array | null;
  has(path: string): boolean;
  /** Every path starting with `prefix` (e.g. "maps/"), sorted, de-duplicated. */
  list(prefix: string): string[];
}

/** One map described by a pack's maps.json / the index. */
export interface PackMapInfo {
  name: string;
  title?: string;
  author?: string;
  modes?: string[];
  /** [min, max] suggested players */
  players?: number[];
}

/** An entry of public/packs/index.json (built by tools/content/build-content.mjs). */
export interface PackIndexEntry {
  /** sha256 of the pack bytes, hex */
  id: string;
  name: string;
  kind: 'base' | 'maps' | 'mod' | string;
  /** file name under packs/ ("base-94152a854657.pk3") */
  file?: string;
  bytes: number;
  files?: string[];
  title?: string;
  maps?: PackMapInfo[];
}

/** A reference to a pack a room needs: sha256 (full hex, or the 12-char short id for built-ins) + optional URL. */
export interface PackRef {
  id: string;
  url?: string;
}

/** Where a mounted pack came from; decides whether the sim may read it. */
export type PackRole = 'base' | 'idpak' | 'room' | 'local';

/** A parsed pack (pk3 or pak): random access by Quake path. */
export interface PackArchive {
  readonly format: 'pk3' | 'pak';
  /** every file path, lower-case */
  paths(): string[];
  has(path: string): boolean;
  /** bytes of one file (stored entries and pak files are zero-copy views), null if absent */
  read(path: string): Uint8Array | null;
  size(path: string): number;
}

/** progress callback for downloads: done / total bytes (total 0 when unknown) */
export type Progress = (done: number, total: number) => void;
