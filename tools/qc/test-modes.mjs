#!/usr/bin/env node
// Quake Town — runs every qtdm mode in the engine's native runner (qtrun) with bots and
// checks the match flow: start / countdown / end, scores, CTF captures (scripted with
// serverinfo qt_selftest), CA rounds, overtime and the changelevel rotation.
//
//   node tools/qc/test-modes.mjs [--verbose]
//
// QTRUN=path/to/qtrun (default sim/target/release/qtrun; build it with
//   cd sim && CARGO_BUILD_JOBS=1 cargo build --release --bin qtrun)
// MAPS=dir with lqdm*.bsp (default /app/data/home/quake-ref/full/id1/maps)
// PROGS=qwprogs.dat (default mod/qtdm/build/qwprogs.dat; run build-mod.mjs first)
//
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const QTRUN = process.env.QTRUN || path.join(ROOT, 'sim/target/release/qtrun');
const MAPS = process.env.MAPS || '/app/data/home/quake-ref/full/id1/maps';
const PROGS = process.env.PROGS || path.join(ROOT, 'mod/qtdm/build/qwprogs.dat');
const VERBOSE = process.argv.includes('--verbose');
const TICKS_PER_SEC = 77;
const TICK = 0.013; // seconds per tick (msec 13)

for (const [what, p] of [['qtrun', QTRUN], ['maps', MAPS], ['progs', PROGS]]) {
  if (!fs.existsSync(p)) {
    console.error(`test-modes: ${what} not found at ${p}`);
    process.exit(2);
  }
}

// Runs qtrun; returns { lines (prints joined per tick+target), states, changelevels, raw }.
function run({ info, maps, ticks, extra = [] }) {
  const args = ['--progs', PROGS, '--ticks', String(ticks), '--info', info];
  for (const m of maps) args.push('--map', path.join(MAPS, `${m}.bsp`));
  args.push(...extra);
  const r = spawnSync(QTRUN, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  const raw = `${r.stdout}${r.stderr}`;
  const prints = new Map();
  const states = [];
  const changelevels = [];
  let errors = [];
  for (const l of raw.split('\n')) {
    let m = l.match(/^\[(\d+)\] (print|centerprint)\(([^)]*)\) ?(.*)$/);
    if (m) {
      const k = `${m[1]} ${m[2]}(${m[3]})`;
      prints.set(k, (prints.get(k) || '') + m[4] + ' ');
      continue;
    }
    m = l.match(/^\[(\d+)\] matchstate phase (\d+) score (-?\d+):(-?\d+) round (\d+)/);
    if (m) states.push({ tick: +m[1], phase: +m[2], s1: +m[3], s2: +m[4], round: +m[5] });
    m = l.match(/^\[(\d+)\] changelevel -> map \d+ \((\w+)\)/);
    if (m) changelevels.push({ tick: +m[1], map: m[2] });
    if (/error|stopped|panic/i.test(l) && !/^\[\d+\] (print|centerprint)/.test(l)) errors.push(l);
  }
  const lines = [...prints].map(([k, v]) => `${k} ${v.replace(/\s+/g, ' ').trim()}`);
  return { lines, states, changelevels, errors, raw };
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const phases = (st) => [...new Set(st.map((s) => s.phase))];
const has = (lines, re) => lines.some((l) => re.test(l));

function test(name, cfg, fn) {
  const t0 = Date.now();
  const r = run(cfg);
  console.log(`-- ${name}: ${cfg.ticks} ticks (${(cfg.ticks / TICKS_PER_SEC / 60).toFixed(1)} min) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (VERBOSE) for (const l of r.lines) console.log(`   ${l}`);
  check(`${name}: world never stopped`, r.errors.length === 0, r.errors.slice(0, 2).join(' | '));
  fn(r);
}

const min = (m) => Math.round((m * 60) / TICK);

test('ffa', { info: '\\mode\\ffa\\maxclients\\6\\bots\\1\\timelimit\\2\\fraglimit\\30\\rotation\\lqdm1 lqdm2', maps: ['lqdm1', 'lqdm2'], ticks: min(5) }, (r) => {
  check('ffa: starts playing at once (no ready-up)', r.states[0]?.phase === 2);
  check('ffa: frags are scored', has(r.lines, /chewed on|pineapple|rides|nailed|punctured|buckshot|gibbed/));
  check('ffa: match ends with an intermission', phases(r.states).includes(4));
  check('ffa: rotation lqdm1 -> lqdm2 -> lqdm1', r.changelevels.map((c) => c.map).join(' ').startsWith('lqdm2 lqdm1'), r.changelevels.map((c) => c.map).join(' '));
  const first = r.changelevels[0];
  check('ffa: timelimit 2 min + 8 s intermission', first && Math.abs(first.tick - (min(2) + Math.round(8 / TICK))) < 3, first && `changelevel at ${first.tick}`);
});

test('duel', { info: '\\mode\\duel\\maxclients\\2\\bots\\1\\timelimit\\1\\rotation\\lqdm4 lqdm1', maps: ['lqdm4', 'lqdm1'], ticks: min(3) }, (r) => {
  check('duel: countdown then playing', r.states[0]?.phase === 1 && r.states.some((s) => s.phase === 2));
  check('duel: countdown is 10 s', (r.states.find((s) => s.phase === 2)?.tick ?? 0) - r.states[0].tick === 770);
  check('duel: centerprinted countdown', has(r.lines, /match starts in 10/));
  check('duel: scores follow frags', r.states.some((s) => s.phase >= 2 && (s.s1 !== 0 || s.s2 !== 0)));
  check('duel: intermission and next map', phases(r.states).includes(4) && r.changelevels[0]?.map === 'lqdm1');
});

test('duel ready-up', {
  info: '\\mode\\duel\\maxclients\\2\\bots\\1\\timelimit\\1',
  maps: ['lqdm1'],
  ticks: 3000,
  extra: ['--human', '1', '--cmd', '500:0:ready', '--cmd', '700:0:break', '--cmd', '900:0:ready', '--cmd', '2000:0:break'],
}, (r) => {
  const p = r.states.map((s) => `${s.tick}:${s.phase}`).join(' ');
  check('ready-up: warmup until the human is ready', r.states[0].phase === 0 && !r.states.some((s) => s.phase === 1 && s.tick < 500), p);
  check('ready-up: break aborts the countdown', r.states.some((s) => s.tick === 700 && s.phase === 0), p);
  check('ready-up: ready again -> match', r.states.some((s) => s.tick === 900 + 770 && s.phase === 2), p);
  check('ready-up: break in the match (1/1 humans) -> warmup', r.states.some((s) => s.tick === 2000 && s.phase === 0), p);
});

test('duel overtime', { info: '\\mode\\duel\\maxclients\\2\\bots\\1\\timelimit\\0.05\\overtime\\sd', maps: ['lqdm1'], ticks: min(2) }, (r) => {
  check('overtime: a tie goes to sudden death', r.states.some((s) => s.phase === 3) && has(r.lines, /sudden death/));
});

test('2on2', { info: '\\mode\\2on2\\maxclients\\4\\bots\\1\\timelimit\\1\\overtime\\0', maps: ['lqdm7'], ticks: min(2) }, (r) => {
  const res = r.lines.find((l) => /Match over/.test(l)) || '';
  check('2on2: auto-team 2 red / 2 blue', res.split('(red)').length - 1 === 2 && res.split('(blue)').length - 1 === 2, res.slice(0, 200));
  check('2on2: team scores move', r.states.some((s) => s.s1 !== 0 || s.s2 !== 0));
  check('2on2: match ends (no overtime with overtime 0)', r.states.some((s) => s.phase === 4));
});

test('4on4', { info: '\\mode\\4on4\\maxclients\\8\\bots\\1\\timelimit\\1\\overtime\\0', maps: ['lqdm3'], ticks: min(2) }, (r) => {
  const res = r.lines.find((l) => /Match over/.test(l)) || '';
  check('4on4: four per team', res.split('(red)').length - 1 === 4 && res.split('(blue)').length - 1 === 4);
  check('4on4: match ends', r.states.some((s) => s.phase === 4));
});

for (const map of ['lqdm3', 'lqdm6']) {
  test(`ctf ${map}`, { info: '\\mode\\ctf\\maxclients\\4\\bots\\1\\timelimit\\5\\qt_selftest\\ctf', maps: [map], ticks: 4800 }, (r) => {
    const st = r.lines.join(' ').match(/selftest: [a-z0-9 ]+ (ok|FAILED)/g) || [];
    check(`ctf ${map}: 6 scripted checks pass`, st.length === 6 && st.every((s) => s.endsWith('ok')), st.join('; '));
    check(`ctf ${map}: capture scored 1:0`, r.states.some((s) => s.s1 === 1 && s.s2 === 0));
    check(`ctf ${map}: no telefrags at the first spawn`, !/^\[1\] obituary/m.test(r.raw));
  });
}

test('ca', { info: '\\mode\\ca\\maxclients\\4\\bots\\1\\rounds\\3\\rotation\\lqdm1 lqdm2', maps: ['lqdm1', 'lqdm2'], ticks: min(8) }, (r) => {
  check('ca: rounds are counted', r.states.some((s) => s.round >= 2));
  check('ca: round break phase', r.states.some((s) => s.phase === 5));
  check('ca: a team reaches 3 rounds -> intermission', r.states.some((s) => s.phase === 4 && (s.s1 === 3 || s.s2 === 3)));
  check('ca: next map', r.changelevels[0]?.map === 'lqdm2');
  check('ca: no item pickups', !/pickup slot/.test(r.raw));
});

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
