#!/usr/bin/env node
// Quake Town content: download and sha256-pin every third-party input of `build:content`
// into .cache/ (gitignored). Idempotent; a second run only checks a stamp.
//   - LibreQuake v0.09-beta full.zip  (BSD-3 game data: pak0/pak1, lqdm maps, docs)
//   - LibreQuake v0.09-beta dev.zip   (BSD-3 texture WADs used to compile our maps)
//   - ericw-tools 2.0.0-alpha11 Linux (qbsp/vis/light; build-time tool only, never shipped)
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, chmodSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, zipEntries, zipRead } from './lib/archive.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE = join(ROOT, '.cache');
const DL = join(CACHE, 'dl');

export const PINS = {
  lqFull: {
    url: 'https://github.com/lavenderdotpet/LibreQuake/releases/download/v0.09-beta/full.zip',
    sha256: '623e463b35811216244f9ba15e0c45abc1765288650b5e3d36a899b35e4bcf3d',
    file: 'lq-full.zip',
    local: ['/app/data/home/quake-ref/lq-full.zip'], // reused when the hash matches
  },
  lqDev: {
    url: 'https://github.com/lavenderdotpet/LibreQuake/releases/download/v0.09-beta/dev.zip',
    sha256: '8b6cd467a73976e8ed6ee52eecc0cafc7d3a0c289058b1ccebcf05583a88f288',
    file: 'lq-dev.zip',
    local: [],
  },
  ericw: {
    url: 'https://github.com/ericwa/ericw-tools/releases/download/2.0.0-alpha11/ericw-tools-2.0.0-alpha11-Linux.zip',
    sha256: '166109ab47657d291142992070bcb661e3029708916e152c690473dfb0f74f15',
    file: 'ericw-tools-2.0.0-alpha11-Linux.zip',
    local: [],
  },
};

export const PATHS = {
  lq: join(CACHE, 'lq'),             // pak0.pak pak1.pak docs/ maps/
  wads: join(CACHE, 'lq', 'wads'),   // lq_*.wad
  ericw: join(CACHE, 'ericw'),       // qbsp vis light bspinfo + libs
};

const STAMP = join(CACHE, 'fetch.stamp.json');
const stampWant = JSON.stringify(Object.fromEntries(Object.entries(PINS).map(([k, v]) => [k, v.sha256])));

async function obtain(pin) {
  const dst = join(DL, pin.file);
  if (existsSync(dst) && sha256(readFileSync(dst)) === pin.sha256) return dst;
  for (const l of pin.local) {
    if (existsSync(l) && sha256(readFileSync(l)) === pin.sha256) {
      rmSync(dst, { force: true });
      symlinkSync(l, dst);
      console.log(`reusing ${l}`);
      return dst;
    }
  }
  console.log('downloading', pin.url);
  const res = await fetch(pin.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${pin.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== pin.sha256) throw new Error(`sha256 mismatch for ${pin.file}: got ${got}`);
  writeFileSync(dst, buf);
  return dst;
}

function extract(zipPath, select, outDir) {
  const zip = readFileSync(zipPath);
  const n = { files: 0, bytes: 0 };
  for (const [name, e] of zipEntries(zip)) {
    if (name.endsWith('/')) continue;
    const rel = select(name);
    if (!rel) continue;
    const out = join(outDir, rel);
    mkdirSync(dirname(out), { recursive: true });
    const data = zipRead(zip, e);
    writeFileSync(out, data);
    n.files++; n.bytes += data.length;
  }
  return n;
}

export async function fetchAll({ force = false } = {}) {
  if (!force && existsSync(STAMP) && readFileSync(STAMP, 'utf8') === stampWant
      && existsSync(join(PATHS.lq, 'pak0.pak')) && existsSync(join(PATHS.ericw, 'qbsp'))) {
    return PATHS;
  }
  mkdirSync(DL, { recursive: true });
  const full = await obtain(PINS.lqFull);
  const dev = await obtain(PINS.lqDev);
  const ew = await obtain(PINS.ericw);
  let r = extract(full, (n) => {
    const m = /^full\/id1\/((?:pak[01]\.pak)|(?:docs\/(?:COPYING|CREDITS|README-IMPORTANT-LICENCE-INFO|README\.md|deathmatch-setup-guide\.txt))|(?:maps\/lqdm\d+\.(?:bsp|lit)))$/.exec(n);
    return m ? m[1] : null;
  }, PATHS.lq);
  console.log(`LibreQuake full: ${r.files} files, ${(r.bytes / 1048576).toFixed(1)} MB`);
  r = extract(dev, (n) => {
    const m = /^dev\/texture-wads\/(lq_[a-z_]+\.wad)$/.exec(n);
    if (m) return join('wads', m[1]);
    const s = /^dev\/maps\/src\/dm\/(lqdm\d+\.map)$/.exec(n);
    return s ? join('src', s[1]) : null;
  }, PATHS.lq);
  console.log(`LibreQuake dev: ${r.files} files (texture WADs + lqdm sources)`);
  r = extract(ew, (n) => (/^(qbsp|vis|light|bspinfo|bsputil|lib[a-z0-9]+\.so[.0-9]*|README\.md|gpl_v3\.txt|LICENSE-embree\.txt)$/.test(n) ? n : null), PATHS.ericw);
  for (const t of ['qbsp', 'vis', 'light', 'bspinfo', 'bsputil']) chmodSync(join(PATHS.ericw, t), 0o755);
  console.log(`ericw-tools: ${r.files} files`);
  writeFileSync(STAMP, stampWant);
  return PATHS;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await fetchAll({ force: process.argv.includes('--force') });
  console.log('fetch: inputs present and verified in .cache/');
}
