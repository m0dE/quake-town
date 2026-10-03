// @ts-nocheck  Node test: needs @types/node, which this repo does not install (docs/proposals/game.md)
/*
 * Quake Town — test content for Node tests: a progs and a map or two.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 *
 * Prefers our own built packs (public/packs: qwprogs.dat from qtdm, maps from
 * maps-qt / maps-lq); falls back to the reference data on this box (id's GPL
 * qwprogs.dat and LibreQuake's BSD-3 lqdm maps), which never enter the repo.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { unzipSync } from 'fflate';

export interface TestContent { progs: Uint8Array; maps: [string, Uint8Array][]; serverinfo: string }

const REF = '/app/data/home/quake-ref';

function fromPacks(): { progs?: Uint8Array; maps: [string, Uint8Array][] } {
  const out: { progs?: Uint8Array; maps: [string, Uint8Array][] } = { maps: [] };
  if (!existsSync('public/packs')) return out;
  for (const f of readdirSync('public/packs').sort()) {
    if (!f.endsWith('.pk3')) continue;
    try {
      const files = unzipSync(new Uint8Array(readFileSync(`public/packs/${f}`)));
      for (const [path, bytes] of Object.entries(files)) {
        const p = path.toLowerCase();
        if (p === 'qwprogs.dat') out.progs = bytes;
        const m = /^maps\/([a-z0-9_]+)\.bsp$/.exec(p);
        // b_*.bsp are QW's item boxes (health, ammo), not levels
        if (m && !m[1].startsWith('b_')) out.maps.push([m[1], bytes]);
      }
    } catch { /* not a zip we can read */ }
  }
  return out;
}

export async function loadTestContent(fake: boolean, opts: { maxclients?: number; bots?: boolean; mode?: string } = {}): Promise<TestContent> {
  const maxclients = opts.maxclients ?? 8;
  const mode = opts.mode ?? 'ffa';
  if (fake) {
    return { progs: new Uint8Array(4), maps: [['fake', new Uint8Array(4)]], serverinfo: `\\mode\\${mode}\\deathmatch\\3\\teamplay\\0\\maxclients\\${maxclients}\\bots\\${opts.bots === false ? 0 : 1}\\rotation\\fake\\hostname\\test` };
  }
  const packs = fromPacks();
  let progs = packs.progs;
  if (!progs && existsSync(`${REF}/Quake/QW/progs/qwprogs.dat`)) progs = new Uint8Array(readFileSync(`${REF}/Quake/QW/progs/qwprogs.dat`));
  if (!progs) throw new Error('no qwprogs.dat: build the mod (npm run build:mod) or provide the reference data');
  let maps = packs.maps;
  if (!maps.length) {
    for (const n of ['lqdm1', 'lqdm2']) {
      const p = `${REF}/full/id1/maps/${n}.bsp`;
      if (existsSync(p)) maps.push([n, new Uint8Array(readFileSync(p))]);
    }
  }
  const order = (n: string): number => (n === 'qt_aero' ? 0 : n === 'lqdm1' ? 1 : n.startsWith('lqdm') ? 2 : 3);
  maps.sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0], 'en', { numeric: true }));
  maps = maps.slice(0, 4);
  if (process.env.MAP) maps = maps.filter(([n]) => n === process.env.MAP).concat(maps.filter(([n]) => n !== process.env.MAP));
  if (!maps.length) throw new Error('no maps');
  return {
    progs, maps,
    serverinfo: `\\mode\\${mode}\\deathmatch\\3\\teamplay\\0\\timelimit\\15\\fraglimit\\30\\maxclients\\${maxclients}\\bots\\${opts.bots === false ? 0 : 1}\\rotation\\${maps.map(([n]) => n).join(' ')}\\hostname\\test`,
  };
}
