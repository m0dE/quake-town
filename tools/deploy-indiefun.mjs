#!/usr/bin/env node
/**
 * Publish the web build to indie.fun (https://indie.fun/play/quake-town).
 *
 *   npm run deploy:indiefun                  # npm run export, then upload export/quake-town.zip
 *   npm run deploy:indiefun -- --no-build    # upload the zip already in export/
 *
 * The deploy key (idk_…, from the game's page on indie.fun → Deploy keys) is read from
 * INDIEFUN_DEPLOY_KEY, in the environment or in .env.local (gitignored):
 *
 *   INDIEFUN_DEPLOY_KEY=idk_…
 *
 * It can replace this game's files and nothing else; it never goes in git. Revoke it on the
 * same page if it leaks.
 *
 * Licence: GPL-2.0-or-later.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ZIP = path.join(ROOT, 'export', 'quake-town.zip');
const ENDPOINT = process.env.INDIEFUN_DEPLOY_URL || 'https://indie.fun/api/deploy/build';
const fail = (why) => { console.error(`deploy refused: ${why}`); process.exit(1); };

const key = (process.env.INDIEFUN_DEPLOY_KEY || '').trim();
if (!key) fail('INDIEFUN_DEPLOY_KEY is not set (in the environment or .env.local): the idk_… key from indie.fun → your game → Deploy keys');
if (!key.startsWith('idk_')) fail('INDIEFUN_DEPLOY_KEY does not look like an indie.fun deploy key (idk_…)');

if (!process.argv.includes('--no-build')) execFileSync('node', [path.join(ROOT, 'tools', 'export.mjs')], { cwd: ROOT, stdio: 'inherit' });
if (!existsSync(ZIP)) fail(`no ${path.relative(ROOT, ZIP)}: run without --no-build`);

const data = readFileSync(ZIP);
console.log(`\nuploading ${path.relative(ROOT, ZIP)} (${(data.length / 1024 / 1024).toFixed(1)} MiB) to ${ENDPOINT}`);
const form = new FormData();
form.append('zip', new Blob([data], { type: 'application/zip' }), 'quake-town.zip');
const res = await fetch(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
const text = await res.text();
let body = text;
try { body = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ }
if (!res.ok) fail(`indie.fun answered ${res.status} ${res.statusText}\n${body}`);
console.log(body);
console.log('\ndeployed: https://indie.fun/play/quake-town');
