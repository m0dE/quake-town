// @ts-nocheck  Node test: needs @types/node, which this repo does not install (docs/proposals/game.md)
/*
 * Quake Town — demo record → encode → decode → playback steps the same world, and
 * the console/command system basics.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 *
 *   npx tsx tools/test/demo.test.ts [--fake]
 */
import { existsSync, readFileSync } from 'node:fs';
import { createQtApp, QtSim, type QtState } from '../../src/sim/qtsim.js';
import { createFakeSim } from '../../src/sim/fake.js';
import { loadTestContent } from './content.js';
import { encodeCmd } from '../../src/sim/wire.js';
import { DemoRecorder, DemoPlayer, encodeDemo, decodeDemo } from '../../src/demo/demo.js';
import { CommandSystem, tokenize, splitCommands } from '../../src/console/commands.js';
import { testCvars } from '../../src/console/cvars.js';
import { Binds } from '../../src/settings/binds.js';
import { Configs } from '../../src/settings/configs.js';

const useFake = process.argv.includes('--fake') || !existsSync('public/qtsim.wasm');
let failures = 0;
const check = (ok: boolean, what: string): void => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

async function main(): Promise<void> {
  console.log(`demo tests against ${useFake ? 'the fake sim' : 'public/qtsim.wasm'}`);
  const sim = await QtSim.create(useFake ? createFakeSim() : readFileSync('public/qtsim.wasm'));
  const c = await loadTestContent(useFake, { maxclients: 4 });
  const progsId = sim.loadProgs(c.progs);
  let mapId = -1;
  for (const [n, b] of c.maps) { const id = sim.loadMap(n, b); if (mapId < 0) mapId = id; }
  const app = createQtApp(sim, { progsId, mapId, serverinfo: c.serverinfo, packs: ['t'] });
  const s = app.init({ frame: 0, roster: [], seed: 99 } as never) as QtState;
  const ctx = (frame: number) => ({ frame, player: '', roster: [], rng: () => 0 }) as never;
  // 300 ticks before recording starts: the demo begins mid-match
  const run = (from: number, to: number): void => {
    for (let f = from; f <= to; f++) {
      if (f === 3) { app.addPlayer!(s, 'ann', ctx(f)); app.applyInput(s, { u: '\\name\\ann' }, ctx(f), 'ann'); app.applyInput(s, { j: 1 }, ctx(f), 'ann'); }
      if (f === 500) { app.addPlayer!(s, 'ben', ctx(f)); app.applyInput(s, { j: 1 }, ctx(f), 'ben'); }
      if (f === 900) app.disconnectPlayer!(s, 'ben', ctx(f));
      app.applyInput(s, encodeCmd({ pitch: 0, yaw: (f * 97) % 65536 - 32768, forward: 400, side: f % 40 < 20 ? 400 : -400, up: 0, buttons: (f % 13 === 0 ? 1 : 0) | (f % 29 === 0 ? 2 : 0), impulse: f % 200 === 0 ? 7 : 0 }), ctx(f), 'ann');
      app.step(s, ctx(f));
    }
  };
  run(1, 300);
  const rec = new DemoRecorder(app, s, 300, { serverinfo: c.serverinfo, packs: ['t'], maps: c.maps.map(([n]) => n), player: 'ann', playerName: 'ann' }, () => s);
  const hashes: number[] = [];
  const origStep = app.step;
  for (let f = 301; f <= 1300; f++) { run(f, f); hashes.push(app.hash(s)); }
  const demo = rec.stop();
  void origStep;
  check(demo.ticks.length === 1000, `recorded 1000 ticks (${demo.ticks.length})`);
  const bytes = encodeDemo(demo);
  console.log(`  ..  .qtd: ${(bytes.length / 1024).toFixed(1)} KB for 1000 ticks (${(1000 * 0.013).toFixed(1)} s) incl. the snapshot`);
  const back = decodeDemo(bytes);
  const playHashes: number[] = [];
  const player = new DemoPlayer(app, back, (st) => playHashes.push(app.hash(st)));
  while (player.step()) { /* to the end */ }
  let same = 0;
  for (let i = 0; i < hashes.length; i++) if (hashes[i] === playHashes[i]) same++;
  check(same === hashes.length, `playback matches the recording on ${same}/${hashes.length} ticks`);
  playHashes.length = 0;
  player.seek(400);
  check(player.pos === 400, `seek to tick 400 (${player.pos})`);
  player.step();
  check(app.hash(player.state) === hashes[400], 'after a seek back the next tick matches');
  player.dispose();

  // console
  const cv = testCvars();
  const cmds = new CommandSystem(cv, new Binds(), new Configs(), () => 'seta sensitivity "3"\n', null);
  const out: string[] = [];
  cmds.onPrint((t) => out.push(t));
  check(JSON.stringify(tokenize('bind "space" "+jump; say hi" // x')) === '["bind","space","+jump; say hi"]', 'tokenize: quotes and comments');
  check(JSON.stringify(splitCommands('echo a; echo "b;c"\necho d')) === '["echo a","echo \\"b;c\\"","echo d"]', 'split on ; and newlines, not inside quotes');
  cmds.exec('sensitivity 7.5; m_pitch -0.022');
  check(cv.get('sensitivity') === '7.5' && cv.num('m_pitch') === -0.022, 'cvars set from the console');
  cmds.exec('bind x "+attack"; alias boom "echo kaboom"; boom');
  check(cmds.bindOf('x') === '+attack', 'bind');
  check(out.join('').includes('kaboom'), 'alias runs');
  cmds.exec('writeconfig my; unbindall; exec my');
  check(out.join('').includes('wrote my.cfg'), 'writeconfig stores a cfg');
  let forwarded = '';
  cmds.forward = (line) => { forwarded = line; return true; };
  cmds.exec('vote map lqdm2');
  check(forwarded === 'vote map lqdm2', 'unknown commands go to the mod');
  cmds.restricted = (n) => n === 'echo';
  cmds.exec('bind q kill; echo allowed');
  cmds.restricted = null;
  check(cmds.bindOf('q') !== 'kill' && out.join('').includes('allowed'), 'stufftext whitelist blocks bind, allows echo');

  if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
  console.log('all passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
