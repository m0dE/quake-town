// Quake Town content tools: writing content-addressed packs into public/packs/.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, writePk3 } from './archive.mjs';
import { ROOT, CACHE } from '../fetch.mjs';

export const PACKS_DIR = join(ROOT, 'public', 'packs');
export const BUILD_DIR = join(CACHE, 'build');

/** write a file atomically (temp + rename): readers see the old or the new bytes, never a partial file */
export function writeAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** Delete `<name>-<sha12>.pk3` files that the index no longer references (after the index is written). */
export function pruneStalePacks(keepFiles) {
  const keep = new Set(keepFiles);
  for (const f of readdirSync(PACKS_DIR)) {
    if (!keep.has(f) && /^(base|maps-qt|maps-lq)-[0-9a-f]{12}\.pk3$/.test(f)) rmSync(join(PACKS_DIR, f));
  }
}

/** Writes `<name>-<sha12>.pk3` (atomically) and returns the index entry. Old packs are pruned by
 *  build-content after index.json points at the new ones. */
export function writePack(name, kind, files, extra = {}) {
  mkdirSync(PACKS_DIR, { recursive: true });
  const bytes = writePk3(files);
  const id = sha256(bytes);
  const file = `${name}-${id.slice(0, 12)}.pk3`;
  if (!existsSync(join(PACKS_DIR, file))) writeAtomic(join(PACKS_DIR, file), bytes);
  const entry = { id, name, kind, file, bytes: bytes.length, files: [...(files instanceof Map ? files.keys() : Object.keys(files))].sort(), ...extra };
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(join(BUILD_DIR, `${name}.entry.json`), JSON.stringify(entry, null, 1));
  return entry;
}

/** Stamp-based no-op: returns the previous entry if its key matches and its pk3 still exists. */
export function upToDate(name, key) {
  const st = join(BUILD_DIR, `${name}.stamp`);
  const en = join(BUILD_DIR, `${name}.entry.json`);
  if (!existsSync(st) || !existsSync(en) || readFileSync(st, 'utf8') !== key) return null;
  const entry = JSON.parse(readFileSync(en, 'utf8'));
  return existsSync(join(PACKS_DIR, entry.file)) ? entry : null;
}
export function stamp(name, key) {
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(join(BUILD_DIR, `${name}.stamp`), key);
}

/** Hash of a list of files' bytes + extra strings (for stamps). */
export function inputsKey(paths, extra = '') {
  const h = [];
  for (const p of paths.slice().sort()) h.push(p.replace(ROOT, ''), existsSync(p) ? sha256(readFileSync(p)) : 'missing');
  h.push(extra);
  return sha256(Buffer.from(h.join('\n')));
}
