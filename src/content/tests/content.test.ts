/**
 * Content tests (no browser): npx tsx src/content/tests/content.test.ts
 * Uses the built packs in public/packs (run `npm run build:content` first) and in-memory
 * fakes for fetch and IndexedDB.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */
import { zipSync, strToU8 } from 'fflate';
import { openPack } from '../archive';
import { IdPaks } from '../idpaks';
import { PackLoader, fetchBytes, sha256Hex } from '../packs';
import { LIMITS, sanitizePath } from '../sanitize';
import { MemoryStore } from '../store';
import type { PackIndexEntry } from '../types';
import { PackVfs } from '../vfs';
import { createContent } from '../index';

// node:fs without @types/node (the repo's tsconfig is browser-only)
const fs: { readFileSync(p: string): Uint8Array; readFileSync(p: string, e: string): string; existsSync(p: string): boolean } = await import('node:' + 'fs');
const ROOT = new URL('../../../', import.meta.url).pathname;

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).stack?.split('\n').slice(0, 3).join('\n     ')}`); }
}
function eq<T>(a: T, b: T, msg = '') { if (a !== b) throw new Error(`${msg} expected ${String(b)}, got ${String(a)}`); }
function ok(c: unknown, msg = 'assertion failed') { if (!c) throw new Error(msg); }
async function throws(fn: () => unknown, re: RegExp) {
  try { await fn(); } catch (e) { if (!re.test((e as Error).message)) throw new Error(`wrong error: ${(e as Error).message}`); return; }
  throw new Error(`expected an error matching ${re}`);
}

/** build a .pak in memory */
function makePak(files: Record<string, Uint8Array>): Uint8Array<ArrayBuffer> {
  const names = Object.keys(files);
  let size = 12;
  for (const n of names) size += files[n].length;
  const out = new Uint8Array(size + names.length * 64);
  const dv = new DataView(out.buffer);
  out.set([0x50, 0x41, 0x43, 0x4b]);
  let o = 12;
  const pos: number[] = [];
  for (const n of names) { pos.push(o); out.set(files[n], o); o += files[n].length; }
  dv.setInt32(4, o, true); dv.setInt32(8, names.length * 64, true);
  names.forEach((n, i) => {
    for (let k = 0; k < n.length; k++) out[o + i * 64 + k] = n.charCodeAt(k);
    dv.setInt32(o + i * 64 + 56, pos[i], true); dv.setInt32(o + i * 64 + 60, files[n].length, true);
  });
  return out;
}

/** a fake fetch serving public/packs and a few extra URLs */
function fakeFetch(extra: Record<string, Uint8Array> = {}, counter = { n: 0 }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    counter.n++;
    const url = String(input);
    let body: Uint8Array | null = extra[url] ?? null;
    if (!body && url.startsWith('packs/')) {
      const p = ROOT + 'public/' + url;
      if (fs.existsSync(p)) body = fs.readFileSync(p);
    }
    if (!body) return new Response('not found', { status: 404 });
    // chunked stream to exercise progress
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < body.length; i += 65536) chunks.push(body.subarray(i, i + 65536));
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } });
    return new Response(stream, { status: 200, headers: { 'content-length': String(body.length) } });
  }) as typeof fetch;
}

const index: PackIndexEntry[] = JSON.parse(fs.readFileSync(ROOT + 'public/packs/index.json', 'utf8'));
const baseEntry = index.find((e) => e.kind === 'base')!;
const baseBytes = fs.readFileSync(ROOT + 'public/packs/' + baseEntry.file);

await test('sanitizePath', () => {
  eq(sanitizePath('Progs/Player.MDL'), 'progs/player.mdl');
  eq(sanitizePath('sound\\weapons\\r_exp3.wav'), 'sound/weapons/r_exp3.wav');
  eq(sanitizePath('./maps/x.bsp'), 'maps/x.bsp');
  for (const bad of ['../x', 'maps/../../etc/passwd', '/etc/passwd', 'C:/x', 'a//b', 'a/./b', 'dir/', '', 'a\u0000b']) eq(sanitizePath(bad), null, bad);
});

await test('base pack: index entry matches the file (sha256, size, file list)', async () => {
  eq(await sha256Hex(baseBytes), baseEntry.id);
  eq(baseBytes.length, baseEntry.bytes);
  const ar = openPack(baseBytes);
  eq(ar.format, 'pk3');
  eq(ar.paths().sort().join('\n'), (baseEntry.files ?? []).join('\n'));
  for (const f of ['progs/player.mdl', 'progs/flag.mdl', 'gfx.wad', 'gfx/palette.lmp', 'gfx/colormap.lmp', 'sound/weapons/r_exp3.wav', 'progs/s_explod.spr', 'maps/b_bh100.bsp']) ok(ar.has(f), f);
  eq(ar.read('gfx/palette.lmp')!.length, 768);
  ok(ar.read('gfx/colormap.lmp')!.length >= 16384, 'colormap 64x256 (LibreQuake has no trailing byte)');
  const mdl = ar.read('progs/player.mdl')!;
  eq(String.fromCharCode(...mdl.subarray(0, 4)), 'IDPO');
  const flag = ar.read('progs/flag.mdl')!;
  eq(String.fromCharCode(...flag.subarray(0, 4)), 'IDPO');
  const dv = new DataView(flag.buffer, flag.byteOffset);
  eq(dv.getInt32(4, true), 6, 'flag version');
  eq(dv.getInt32(48, true), 2, 'flag skins');
  eq(dv.getInt32(68, true), 8, 'flag frames');
});

await test('pk3: stored entries are zero-copy views, deflated ones are cached', () => {
  const z = zipSync({ 'a.txt': [strToU8('x'.repeat(10)), { level: 0 }], 'b.txt': [strToU8('y'.repeat(5000)), { level: 9 }] });
  const ar = openPack(z);
  const a = ar.read('a.txt')!;
  eq(a.buffer, z.buffer, 'stored shares the buffer');
  const b1 = ar.read('b.txt')!, b2 = ar.read('b.txt')!;
  eq(b1.length, 5000); eq(b1, b2, 'cached');
});

await test('pk3: unsafe paths, too many entries, oversized maps are refused', async () => {
  await throws(() => openPack(zipSync({ '../evil.cfg': strToU8('x') })), /unsafe path/);
  await throws(() => openPack(zipSync({ '/abs.txt': strToU8('x') })), /unsafe path/);
  const many: Record<string, Uint8Array> = {};
  for (let i = 0; i <= LIMITS.zipEntries; i++) many[`f${i}`] = new Uint8Array(0);
  await throws(() => openPack(zipSync(many, { level: 0 })), /entries/);
  // forge a declared size over the BSP limit in the central directory
  const z = zipSync({ 'maps/big.bsp': [new Uint8Array(16), { level: 0 }] });
  const dv = new DataView(z.buffer);
  for (let i = z.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x02014b50) { dv.setUint32(i + 24, LIMITS.bspBytes + 1, true); dv.setUint32(i + 20, LIMITS.bspBytes + 1, true); break; }
  await throws(() => openPack(z), /32 MB|outside/);
  await throws(() => openPack(strToU8('hello world, not a pack')), /not a \.pk3/);
});

await test('pak reader (+ LibreQuake pak0 if fetched)', () => {
  const p = makePak({ 'progs/x.mdl': strToU8('IDPO....'), 'Maps/Y.bsp': strToU8('29') });
  const ar = openPack(p);
  eq(ar.format, 'pak');
  ok(ar.has('maps/y.bsp'));
  eq(new TextDecoder().decode(ar.read('progs/x.mdl')!), 'IDPO....');
  const lq = ROOT + '.cache/lq/pak0.pak';
  if (fs.existsSync(lq)) {
    const t0 = performance.now();
    const big = openPack(fs.readFileSync(lq), { limits: false });
    console.log(`     LibreQuake pak0: ${big.paths().length} files indexed in ${(performance.now() - t0).toFixed(1)} ms`);
    eq(big.read('gfx/palette.lmp')!.length, 768);
  }
});

await test('vfs: mount order base < idpak < room, sim view excludes id paks', () => {
  const vfs = new PackVfs();
  const mk = (files: Record<string, string>) => openPack(makePak(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
  vfs.mount({ id: 'room1', name: 'room', role: 'room', archive: mk({ 'maps/qt_aero.bsp': 'room-map', 'qwprogs.dat': 'room-progs' }), bytes: 1 });
  vfs.mount({ id: 'base', name: 'base', role: 'base', archive: mk({ 'progs/player.mdl': 'lq-player', 'gfx/palette.lmp': 'lq-pal' }), bytes: 1 });
  vfs.mount({ id: 'idpak:pak0', name: 'pak0', role: 'idpak', archive: mk({ 'progs/player.mdl': 'id-player', 'maps/qt_aero.bsp': 'id-map?', 'progs.dat': 'id-progs', 'maps/dm6.bsp': 'id-dm6' }), bytes: 1 });
  eq(vfs.mounts().map((m) => m.role).join(','), 'base,idpak,room');
  const s = (u: Uint8Array | null) => (u ? new TextDecoder().decode(u) : null);
  eq(s(vfs.get('progs/player.mdl')), 'id-player', 'art from id pak');
  eq(s(vfs.get('maps/qt_aero.bsp')), 'room-map', 'room overrides id pak');
  eq(s(vfs.sim.get('progs/player.mdl')), 'lq-player', 'sim never reads id pak');
  eq(vfs.sim.get('maps/dm6.bsp'), null, 'id maps invisible to sim');
  eq(vfs.sim.get('progs.dat'), null);
  eq(vfs.list('maps/').join(','), 'maps/dm6.bsp,maps/qt_aero.bsp');
  eq(vfs.sim.list('maps/').join(','), 'maps/qt_aero.bsp');
  ok(vfs.has('GFX/Palette.lmp'), 'case-insensitive');
  vfs.unmountRole('idpak');
  eq(s(vfs.get('progs/player.mdl')), 'lq-player');
});

await test('loader: built-ins by name / short id / full id, cache hit, progress', async () => {
  const counter = { n: 0 };
  const store = new MemoryStore();
  const L = new PackLoader({ store, fetchImpl: fakeFetch({}, counter) });
  const prog: number[] = [];
  const a = await L.resolve({ id: 'base' }, (d) => prog.push(d));
  eq(a.id, baseEntry.id); eq(a.source, 'builtin');
  ok(prog.length > 1 && prog.every((v, i) => i === 0 || v >= prog[i - 1]) && prog[prog.length - 1] === baseEntry.bytes, 'monotonic progress to the end');
  const n = counter.n;
  const b = await L.resolve({ id: baseEntry.id.slice(0, 12) });
  eq(b.source, 'cache'); eq(counter.n, n, 'no download on a cache hit');
  const c = await L.resolve({ id: baseEntry.id });
  eq(c.source, 'cache');
});

await test('loader: community pack by URL verified; tampered bytes and bad URLs refused', async () => {
  const pack = zipSync({ 'maps/x.bsp': strToU8('BSP') });
  const id = await sha256Hex(pack);
  const tampered = pack.slice(); tampered[tampered.length - 30] ^= 1;
  const L = new PackLoader({ store: new MemoryStore(), fetchImpl: fakeFetch({ 'https://cdn.example/x.pk3': pack, 'https://cdn.example/bad.pk3': tampered }) });
  const r = await L.resolve({ id, url: 'https://cdn.example/x.pk3' });
  eq(r.source, 'url'); eq(r.name, 'x');
  eq((await L.resolve({ id })).source, 'cache', 'second time from cache, no URL needed');
  const id2 = await sha256Hex(zipSync({ 'other.txt': strToU8('y') }));
  await throws(() => L.resolve({ id: id2, url: 'https://cdn.example/bad.pk3' }), /sha256 mismatch/);
  await throws(() => L.resolve({ id: id2, url: 'http://cdn.example/x.pk3' }), /https/);
  await throws(() => L.resolve({ id: 'abc123abc123' }), /full sha256|unknown/);
  await throws(() => L.resolve({ id: id2 }), /not available/);
});

await test('fetchBytes refuses packs over the limit while streaming', async () => {
  const big = new Uint8Array(300000);
  const f = fakeFetch({ 'https://x/big.pk3': big });
  await throws(() => fetchBytes('https://x/big.pk3', { limit: 100000, fetchImpl: f }), /too large/);
});

await test('createContent: base + room packs, maps.json, local pack', async () => {
  const c = createContent({ store: new MemoryStore(), fetchImpl: fakeFetch() });
  // no IndexedDB in node: idPaks falls back to memory
  await c.loadBase();
  ok(c.vfs.has('progs/player.mdl'));
  const mapsPacks = index.filter((e) => e.kind === 'maps').map((e) => ({ id: e.name }));
  await c.loadRoom(mapsPacks);
  const maps = c.maps().map((m) => m.name);
  for (const e of index.filter((x) => x.kind === 'maps')) for (const m of e.maps ?? []) ok(maps.includes(m.name), m.name);
  for (const m of maps) ok(c.vfs.sim.has(`maps/${m}.bsp`), `maps/${m}.bsp`);
  const f = new File([zipSync({ 'maps/mine.bsp': strToU8('29') })], 'mine.pk3');
  const r = await c.cacheLocalPack(f);
  eq(r.name, 'mine');
  eq((await c.loader.resolve({ id: r.id })).source, 'cache');
});

await test('id paks: validated, stored, mounted art-only, forgettable', async () => {
  const vfs = new PackVfs();
  const ip = new IdPaks(new MemoryStore(), vfs);
  const pak0 = makePak({ 'gfx/palette.lmp': new Uint8Array(768), 'progs/player.mdl': strToU8('IDPO-id'), 'progs.dat': strToU8('id progs'), 'maps/e1m1.bsp': strToU8('id map') });
  const r1 = await ip.load([new File([new Uint8Array(strToU8('nope'))], 'pak0.pak')]);
  eq(r1.ok, false);
  const r2 = await ip.load([new File([pak0], 'PAK0.PAK'), new File([pak0], 'readme.txt')]);
  ok(r2.ok, r2.message);
  const st = await ip.status();
  eq(st.loaded, true); eq(st.files[0].name, 'pak0.pak');
  eq(new TextDecoder().decode(vfs.get('progs/player.mdl')!), 'IDPO-id');
  eq(vfs.sim.get('progs/player.mdl'), null); eq(vfs.sim.get('maps/e1m1.bsp'), null); eq(vfs.sim.get('progs.dat'), null);
  await ip.forget();
  eq((await ip.status()).loaded, false); eq(vfs.get('progs/player.mdl'), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) (globalThis as unknown as { process: { exitCode: number } }).process.exitCode = 1;
