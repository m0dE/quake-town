#!/usr/bin/env node
/**
 * The web build, packaged for arrr.fun (after doom-arrr's and vibe-strike's tools/export.mjs).
 *
 *   npm run export                    # typecheck, vite build, licences, zip
 *   npm run export -- --no-build      # re-package what is already in export/quake-town
 *   npm run export -- --no-typecheck  # skip tsc (vite still builds)
 *
 * Writes:
 *   export/quake-town/        the site (index.html at its root, relative URLs only)
 *     LICENSE.txt             GPL-2.0 (the repository's LICENSE)
 *     ASSET-LICENSES.txt      LibreQuake BSD-3 COPYING + CREDITS, per-map credits from
 *                             public/packs/index.json, the menu fonts' SIL OFL 1.1 texts
 *     README.txt              what this is, and its sizes in KB
 *   export/quake-town.zip     the upload: deterministic (fixed timestamps, sorted entries)
 *   export/BUILD.txt          commit, app id, sizes, sha256
 *
 * arrr.fun's rules are checked before an upload rather than after: index.html at the zip
 * root, ≤ 5000 files, ≤ 100 MiB inflated, no absolute asset paths, no zip64.
 *
 * The source is not bundled: the menu footer, ASSET-LICENSES.txt and README.txt point at SOURCE_URL.
 *
 * Licence: GPL-2.0-or-later.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const flag = (name) => process.argv.includes(`--${name}`);

const SLUG = arg('slug', 'quake-town');
const OUT = path.resolve(ROOT, arg('out', 'export'));
const SITE = path.join(OUT, SLUG);
const ZIP = path.join(OUT, `${SLUG}.zip`);
const MAX_FILES = 5000;
const MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_APP_ID = 'quake-town';
let CRC = null; // crc32()'s table, built on first use
const REPO_URL = 'https://github.com/m0dE/quake-town';

const kb = (n) => `${Math.round(n / 1024).toLocaleString('en-US')} KB`;
const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
const fail = (why) => { console.error(`export refused: ${why}`); process.exit(1); };
const read = (f) => readFileSync(path.join(ROOT, f));

// ---------------------------------------------------------------------------- build

if (!flag('no-build')) {
  if (!existsSync(path.join(ROOT, 'index.html'))) fail('no index.html at the repository root (the game page)');
  if (!flag('no-typecheck')) {
    console.log('typecheck');
    execFileSync('npx', ['tsc', '--noEmit'], { cwd: ROOT, stdio: 'inherit' });
  }
  console.log(`building into ${path.relative(ROOT, SITE)}/`);
  execFileSync('npx', ['vite', 'build', '--outDir', path.relative(ROOT, SITE), '--emptyOutDir'], { cwd: ROOT, stdio: 'inherit' });
}
if (!existsSync(path.join(SITE, 'index.html'))) fail(`no index.html in ${SITE} — run without --no-build`);

// ---------------------------------------------------------------------------- git facts

let head = 'dev';
try { head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
let dirty = false;
try { dirty = execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: ROOT, encoding: 'utf8' }).trim() !== ''; } catch { /* not a checkout */ }
/** The source this build was made from: the repo at its commit, as the menu footer links it. */
const SOURCE_URL = head === 'dev' ? REPO_URL : `${REPO_URL}/tree/${head}`;

// ---------------------------------------------------------------------------- licences

copyFileSync(path.join(ROOT, 'LICENSE'), path.join(SITE, 'LICENSE.txt'));

let index = [];
try { index = JSON.parse(read('public/packs/index.json').toString('utf8')); } catch { /* no packs built */ }

function walk(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else if (st.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

const rule = '='.repeat(78);
const section = (title, body) => `${rule}\n${title}\n${rule}\n\n${body.trim()}\n\n`;
let assets = [
  'Quake Town — licences of the game data and fonts in this bundle',
  '',
  'The program (everything compiled from source: the JavaScript, the simulation',
  'qtsim.wasm and the QuakeC progs in the qtdm pack) is GPL-2.0-or-later: LICENSE.txt,',
  `source at ${SOURCE_URL}. The data below is under its own licences.`,
  '"QUAKE" is a trademark of id Software / ZeniMax. Quake Town is not affiliated with them;',
  'no id Software data is distributed here.',
  '',
  '',
].join('\n');

const lq = walk(path.join(ROOT, 'assets-licenses'));
const lqOrder = (f) => (/COPYING/i.test(f) ? 0 : /CREDITS/i.test(f) ? 1 : 2);
for (const f of lq.sort((a, b) => lqOrder(a) - lqOrder(b) || a.localeCompare(b))) {
  assets += section(`assets-licenses/${f}`, read(`assets-licenses/${f}`).toString('utf8'));
}

const mapLines = [];
for (const pack of index) {
  for (const m of pack.maps ?? []) {
    mapLines.push(`${m.name.padEnd(10)} ${String(m.title ?? '').padEnd(28)} by ${m.author ?? 'unknown'}   (pack ${pack.name}, ${String(pack.id).slice(0, 12)})`);
  }
}
if (mapLines.length) {
  assets += section('Maps in the built-in packs',
    `${mapLines.join('\n')}\n\nThe lqdm maps are LibreQuake's (BSD-3-Clause, above). Maps by "Quake Town" are\noriginal to this project and are GPL-2.0-or-later with their sources at\n${SOURCE_URL} (content/maps/).`);
}

const fontDir = 'src/menu/fonts';
for (const f of walk(path.join(ROOT, fontDir)).filter((x) => /\.txt$/i.test(x))) {
  assets += section(`Menu font licence: ${f}`, read(`${fontDir}/${f}`).toString('utf8'));
}
writeFileSync(path.join(SITE, 'ASSET-LICENSES.txt'), assets);

// ---------------------------------------------------------------------------- sizes + README

const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const siteFile = (f) => readFileSync(path.join(SITE, f));
let files = walk(SITE);
const js = files.filter((f) => /\.js$/.test(f));
const css = files.filter((f) => /\.css$/.test(f));
const fonts = files.filter((f) => /\.woff2?$/.test(f));
const sum = (list, fn) => list.reduce((n, f) => n + fn(f), 0);
const wasmFile = files.find((f) => /qtsim\.wasm$/.test(f));
const packFiles = files.filter((f) => /^packs\/.*\.(pk3|pak)$/.test(f));
const basePack = packFiles.find((f) => /\/base-[0-9a-f]+\.pk3$/.test(f));

const sizeRows = [
  ['JavaScript', sum(js, (f) => siteFile(f).length), sum(js, (f) => gz(siteFile(f))), `${js.length} file(s)`],
  ['CSS', sum(css, (f) => siteFile(f).length), sum(css, (f) => gz(siteFile(f))), `${css.length} file(s)`],
  ['Fonts (woff2)', sum(fonts, (f) => siteFile(f).length), null, `${fonts.length} file(s)`],
  ['qtsim.wasm', wasmFile ? siteFile(wasmFile).length : 0, wasmFile ? gz(siteFile(wasmFile)) : 0, wasmFile ? '' : 'MISSING'],
  ['base pack', basePack ? siteFile(basePack).length : 0, null, basePack ?? 'MISSING'],
  ['all packs', sum(packFiles, (f) => siteFile(f).length), null, `${packFiles.length} pack(s)`],
  ['index.html', siteFile('index.html').length, gz(siteFile('index.html')), ''],
];
const firstLoad = sizeRows[0][2] + sizeRows[1][2] + (sizeRows[3][2] ?? 0) + (basePack ? siteFile(basePack).length : 0);
const table = sizeRows.map(([what, raw, gzipped, extra]) =>
  `  ${what.padEnd(14)} ${kb(raw).padStart(10)}${gzipped === null ? ''.padStart(16) : `  ${kb(gzipped).padStart(9)} gz`}   ${extra}`).join('\n');

const readme = [
  'Quake Town — web build',
  '',
  'QuakeWorld in the browser, in lockstep on arrr-network. Open index.html from a web',
  'server (it fetches qtsim.wasm and packs/*.pk3 relative to itself).',
  '',
  `Built from commit ${head}${dirty ? ' (with uncommitted changes)' : ''}.`,
  '',
  'Sizes (KB = 1024 bytes; gz = gzip -9, what a server sending Content-Encoding: gzip moves):',
  table,
  '',
  `  first load ≈ ${kb(firstLoad)} over the wire (JS gz + CSS gz + wasm gz + base pack);`,
  '  map packs are fetched when a room needs them.',
  '',
  'Licences: LICENSE.txt (GPL-2.0-or-later, the program), ASSET-LICENSES.txt (LibreQuake',
  'BSD-3-Clause art and maps, map credits, menu fonts SIL OFL 1.1).',
  `Source: ${SOURCE_URL}`,
  '',
].join('\n');
writeFileSync(path.join(SITE, 'README.txt'), readme);

// ---------------------------------------------------------------------------- checks

files = walk(SITE);
const bytes = files.reduce((n, f) => n + statSync(path.join(SITE, f)).size, 0);
if (files.length > MAX_FILES) fail(`${files.length} files; arrr.fun takes at most ${MAX_FILES}`);
if (bytes > MAX_BYTES) fail(`${mib(bytes)}; arrr.fun takes at most ${mib(MAX_BYTES)}`);
const html = siteFile('index.html').toString('utf8');
const absolute = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
if (absolute.length) fail(`index.html asks for ${absolute.length} file(s) by absolute path (${absolute[0]})`);
for (const need of ['LICENSE.txt', 'ASSET-LICENSES.txt', 'README.txt']) {
  if (!files.includes(need)) fail(`the site has no ${need}`);
}
if (!wasmFile) console.warn('warning: no qtsim.wasm in the site (npm run build:sim)');
if (!basePack) console.warn('warning: no base pack in the site (npm run build:content)');

// ---------------------------------------------------------------------------- zip

function crcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
}
function crc32(buf) { CRC ??= crcTable(); let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** A deterministic zip: entries in the order given, 1980-01-01 timestamps, no unix modes, no zip64. */
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    // Already-compressed formats are stored: deflating them again costs time and gains nothing.
    const precompressed = /\.(pk3|zip|woff2|png|jpg|ogg)$/i.test(name);
    const deflated = precompressed ? null : deflateRawSync(data, { level: 9 });
    const useDeflate = deflated !== null && deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x0021, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12); dir.writeUInt16LE(0x0021, 14); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28); dir.writeUInt32LE(0, 38); dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  if (offset > 0xfffffff0 || entries.length > 0xffff) throw new Error('zip too large for a non-zip64 archive');
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

mkdirSync(OUT, { recursive: true });
if (existsSync(ZIP)) rmSync(ZIP);
writeFileSync(ZIP, zip(files.map((f) => ({ name: f, data: siteFile(f) }))));
const zipped = statSync(ZIP).size;
const sha256 = createHash('sha256').update(readFileSync(ZIP)).digest('hex');
const appId = (process.env.VITE_ARRR_APP_ID || '').trim() || DEFAULT_APP_ID;

writeFileSync(path.join(OUT, 'BUILD.txt'), [
  'Quake Town — web build, generated by `npm run export` (tools/export.mjs). Do not edit.',
  '',
  `built from commit : ${head}${dirty ? ' (with uncommitted changes)' : ''}`,
  `app               : ${appId}${appId === DEFAULT_APP_ID ? '   (placeholder: set VITE_ARRR_APP_ID to the registered app)' : ''}`,
  `site              : ${SLUG}/  ${files.length} files, ${bytes} bytes`,
  `zip               : ${SLUG}.zip  ${zipped} bytes`,
  `zip sha256        : ${sha256}`,
  '',
  readme,
].join('\n'));

console.log(`\n${table}\n  first load ≈ ${kb(firstLoad)}`);
console.log(`\n${path.relative(ROOT, SITE)}/  ${files.length} files, ${mib(bytes)}`);
console.log(`${path.relative(ROOT, ZIP)}  ${mib(zipped)}  sha256 ${sha256}`);
