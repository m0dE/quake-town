// Quake Town — a scratch public/ for tests while packs are being rebuilt by other parts:
// symlinks every file of public/ into .cache/test-public and rewrites packs/index.json so
// each pack entry names the .pk3 actually present (sha256 recomputed). Never touches public/.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve('public'), OUT = resolve('.cache/test-public');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/packs`, { recursive: true });
for (const f of readdirSync(SRC)) if (f !== 'packs') symlinkSync(`${SRC}/${f}`, `${OUT}/${f}`);
const index = JSON.parse(readFileSync(`${SRC}/packs/index.json`, 'utf8'));
const files = readdirSync(`${SRC}/packs`).filter((f) => f.endsWith('.pk3'));
for (const e of index) {
  const want = e.file && existsSync(`${SRC}/packs/${e.file}`) ? e.file : files.filter((f) => f.startsWith(`${e.name}-`)).sort().pop();
  if (!want) continue;
  const bytes = readFileSync(`${SRC}/packs/${want}`);
  e.id = createHash('sha256').update(bytes).digest('hex');
  e.bytes = bytes.length;
  e.file = want;
}
for (const f of files) symlinkSync(`${SRC}/packs/${f}`, `${OUT}/packs/${f}`);
writeFileSync(`${OUT}/packs/index.json`, JSON.stringify(index, null, 1));
console.log(index.map((e) => `${e.name} ${e.id.slice(0, 12)} ${e.file}`).join('\n'));
