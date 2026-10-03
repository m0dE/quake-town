#!/usr/bin/env node
// `npm run build:content`: fetch pinned inputs, build base / maps-lq / maps-qt packs, write
// public/packs/index.json (DESIGN.md "Content packs"). Every step is stamp-cached, so a run
// with nothing changed is a fast no-op.
//   --fast   quick map compiles (vis -fast, light without -extra4/bounce) for iteration
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchAll, ROOT } from './fetch.mjs';
import { buildBase } from './build-base.mjs';
import { buildMapsLq, buildMapsQt } from './build-maps.mjs';
import { PACKS_DIR } from './lib/packs.mjs';
import { sha256, zipEntries } from './lib/archive.mjs';

/** the mod part's pack: mod/qtdm/build/pack.json if present, else scan public/packs/qtdm-*.pk3 */
function modEntry() {
  const pj = join(ROOT, 'mod/qtdm/build/pack.json');
  if (existsSync(pj)) {
    const e = JSON.parse(readFileSync(pj, 'utf8'));
    if (e.file && existsSync(join(PACKS_DIR, e.file))) return { kind: 'mod', ...e };
  }
  const f = existsSync(PACKS_DIR) ? readdirSync(PACKS_DIR).filter((x) => /^qtdm-[0-9a-f]{12}\.pk3$/.test(x)).sort() : [];
  if (!f.length) return null;
  const bytes = readFileSync(join(PACKS_DIR, f[f.length - 1]));
  return { id: sha256(bytes), name: 'qtdm', kind: 'mod', file: f[f.length - 1], bytes: bytes.length, files: [...zipEntries(bytes).keys()].filter((n) => !n.endsWith('/')).sort() };
}

export async function buildContent({ fast = false } = {}) {
  const t0 = Date.now();
  await fetchAll();
  const base = await buildBase();
  const lq = await buildMapsLq();
  const qt = await buildMapsQt({ fast });
  const mod = modEntry();
  const index = [base, qt?.entry, lq, mod].filter(Boolean).map((e) => {
    const o = { id: e.id, name: e.name, kind: e.kind, file: e.file, bytes: e.bytes, files: e.files };
    if (e.title) o.title = e.title;
    if (e.maps) o.maps = e.maps;
    return o;
  });
  const json = JSON.stringify(index, null, 1) + '\n';
  const out = join(PACKS_DIR, 'index.json');
  if (!existsSync(out) || readFileSync(out, 'utf8') !== json) writeFileSync(out, json);
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`build:content ${((Date.now() - t0) / 1000).toFixed(1)} s: ` + index.map((e) => `${e.file} ${kb(e.bytes)}`).join(', '));
  return index;
}

if (import.meta.url === `file://${process.argv[1]}`) await buildContent({ fast: process.argv.includes('--fast') });
