// @ts-nocheck  Node test: needs @types/node, which this repo does not install (docs/proposals/game.md)
/*
 * Quake Town — Node tests for the sim wrapper (src/sim/qtsim.ts).
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 *
 *   npx tsx tools/test/sim-wrapper.test.ts            # the real public/qtsim.wasm if present, else the fake
 *   npx tsx tools/test/sim-wrapper.test.ts --fake     # the TS stand-in
 *   TICKS=20000 npx tsx tools/test/sim-wrapper.test.ts
 *
 * What it proves, through the wrapper exactly as the lockstep drives it:
 *   - twin worlds (two apps, two modules) fed the same ordered stream agree on every tick's hash;
 *   - serialize → JSON → deserialize (the wire path) steps identically to the original;
 *   - the clone fast path is taken for the prediction's own payload and agrees too;
 *   - membership (`j`, `u`, `k`, leave, idle, reconnect) is a pure function of the stream;
 *   - no world leaks (dispose frees what deserialize made).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createQtApp, QtSim, type QtApp, type QtState } from '../../src/sim/qtsim.js';
import { createFakeSim } from '../../src/sim/fake.js';
import { loadTestContent } from './content.js';
import { CV, ROW_WORDS, R_FRAGS } from '../../src/sim/abi.js';
import { encodeCmd } from '../../src/sim/wire.js';

const TICKS = Number(process.env.TICKS ?? 3000);
const useFake = process.argv.includes('--fake') || !existsSync('public/qtsim.wasm');

let failures = 0;
function check(ok: boolean, what: string): void {
  if (ok) console.log(`  ok  ${what}`);
  else { failures++; console.log(`  FAIL ${what}`); }
}

async function makeApp(): Promise<QtApp> {
  const sim = await QtSim.create(useFake ? createFakeSim() : readFileSync('public/qtsim.wasm'));
  const content = await loadTestContent(useFake);
  const progsId = sim.loadProgs(content.progs);
  let mapId = -1;
  for (const [name, bytes] of content.maps) { const id = sim.loadMap(name, bytes); if (mapId < 0) mapId = id; }
  return createQtApp(sim, { progsId, mapId, serverinfo: content.serverinfo, packs: ['test'] });
}

const rng = (seed: number) => () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };

/** The scripted ordered stream: tick → [sender, payload][] */
function script(ticks: number): Map<number, [string, unknown][]> {
  const r = rng(7);
  const s = new Map<number, [string, unknown][]>();
  const put = (t: number, who: string, d: unknown): void => { const a = s.get(t) ?? []; a.push([who, d]); s.set(t, a); };
  put(2, 'alice', { u: '\\name\\alice\\team\\red\\topcolor\\4\\bottomcolor\\4' });
  put(2, 'alice', { j: 1 });
  put(5, 'bob', { u: '\\name\\bob\\team\\blue\\topcolor\\13\\bottomcolor\\13' });
  put(6, 'bob', { j: 1 });
  put(40, 'carol', { j: 1 });                    // never sent userinfo: the default
  put(300, 'bob', { k: 'kill' });
  put(400, 'carol', { j: 0 });                   // back to spectating
  put(500, 'bob', { u: '\\name\\bobby\\team\\blue\\topcolor\\13\\bottomcolor\\13' });
  for (let t = 3; t < ticks; t++) {
    for (const who of ['alice', 'bob']) {
      if (r() < 0.9) put(t, who, encodeCmd({
        pitch: Math.round((r() - 0.5) * 8000), yaw: Math.round((r() - 0.5) * 65535), forward: r() < 0.7 ? 400 : -400,
        side: r() < 0.5 ? 400 : r() < 0.5 ? -400 : 0, up: 0, buttons: (r() < 0.3 ? 1 : 0) | (r() < 0.1 ? 2 : 0), impulse: r() < 0.02 ? 7 : 0,
      }));
    }
    if (r() < 0.01) put(t, 'mallory', { c: 'not a cmd' });   // garbage is ignored
    if (r() < 0.01) put(t, 'alice', { say: 'hello' });        // chat never reaches the sim
  }
  return s;
}

interface Run { app: QtApp; s: QtState }

function apply(run: Run, frame: number, inputs: [string, unknown][] | undefined): void {
  const ctx = { frame, player: '', roster: [], rng: () => 0 };
  for (const [who, d] of inputs ?? []) run.app.applyInput(run.s, d, ctx as never, who);
  run.app.step(run.s, ctx as never);
}

async function main(): Promise<void> {
  console.log(`sim wrapper tests against ${useFake ? 'the FAKE sim (src/sim/fake.ts)' : 'public/qtsim.wasm'}, ${TICKS} ticks`);
  const stream = script(TICKS);
  const a: Run = { app: await makeApp(), s: null as unknown as QtState };
  const b: Run = { app: await makeApp(), s: null as unknown as QtState };
  const initCtx = { frame: 0, roster: [], seed: 1234 };
  a.s = a.app.init(initCtx as never);
  b.s = b.app.init(initCtx as never);
  for (const r of [a, b]) r.app.addPlayer!(r.s, 'alice', {} as never);

  let agree = 0, firstBad = -1;
  let rt: Run | null = null;          // a world rebuilt from the wire at a random tick
  let cl: Run | null = null;          // a clone through the fast path
  let rtAgree = 0, clAgree = 0, rtFrom = -1, clFrom = -1;
  const t0 = performance.now();
  let stepMs = 0;
  for (let t = 1; t <= TICKS; t++) {
    const ins = stream.get(t);
    const ts = performance.now();
    apply(a, t, ins);
    stepMs += performance.now() - ts;
    apply(b, t, ins);
    if (t === 700) b.app.disconnectPlayer!(b.s, 'bob'), a.app.disconnectPlayer!(a.s, 'bob');
    if (t === 800) b.app.addPlayer!(b.s, 'bob', {} as never), a.app.addPlayer!(a.s, 'bob', {} as never);
    const ha = a.app.hash(a.s), hb = b.app.hash(b.s);
    if (ha === hb) agree++; else if (firstBad < 0) firstBad = t;
    if (rt) { apply(rt, t, ins); if (rt.app.hash(rt.s) === ha) rtAgree++; }
    if (cl) { apply(cl, t, ins); if (cl.app.hash(cl.s) === ha) clAgree++; }
    if (t === Math.floor(TICKS / 3)) {
      const wire = JSON.parse(JSON.stringify(b.app.serialize!(b.s)));
      rt = { app: b.app, s: b.app.deserialize!(wire) as QtState };
      rtFrom = t;
      check(rt.app.hash(rt.s) === ha, `deserialize(JSON(serialize)) at tick ${t} hashes the same`);
    }
    if (t === Math.floor(TICKS / 2)) {
      const before = a.app.stats.clones;
      cl = { app: a.app, s: a.app.deserialize!(a.app.serialize!(a.s)) as QtState };
      clFrom = t;
      check(a.app.stats.clones === before + 1, 'the prediction path (own payload, untouched world) is a clone');
      check(cl.app.hash(cl.s) === ha, `clone at tick ${t} hashes the same`);
    }
  }
  const total = performance.now() - t0;
  check(agree === TICKS, `twin worlds agree on ${agree}/${TICKS} ticks${firstBad >= 0 ? ` (first disagreement at ${firstBad})` : ''}`);
  check(rtAgree === TICKS - rtFrom, `wire-restored world agrees ${rtAgree}/${TICKS - rtFrom} ticks after tick ${rtFrom}`);
  check(clAgree === TICKS - clFrom, `cloned world agrees ${clAgree}/${TICKS - clFrom} ticks after tick ${clFrom}`);

  // membership
  const s = a.s;
  check(s.slots.includes('alice') && s.slots.includes('bob'), `alice and bob hold slots (${JSON.stringify(s.slots)})`);
  check(!s.slots.includes('carol'), 'carol spectates after { j: 0 }');
  check(!s.slots.includes('mallory'), 'a sender that never joined has no slot');
  const bobSlot = s.slots.indexOf('bob');
  const info = a.app.sim.clientInfo(s.h, bobSlot);
  check(info.includes('bobby'), `userinfo change reached the world (${info})`);
  const rows = a.app.sim.clients(s.h);
  check(rows.length === a.app.maxclients * ROW_WORDS, `ClientRow table is maxclients (${a.app.maxclients}) rows`);
  const cv = a.app.sim.client(s.h, s.slots.indexOf('alice'));
  check(cv[CV.state] === 1, `alice is human in the ClientView (state ${cv[CV.state]})`);
  check(a.app.fingerprint!(s, 'alice') === b.app.fingerprint!(b.s, 'alice'), `fingerprints agree (${a.app.fingerprint!(s, 'alice')})`);
  let frags = 0;
  for (let i = 0; i < a.app.maxclients; i++) frags += Math.abs(rows[i * ROW_WORDS + R_FRAGS]);
  console.log(`  ..  frags in the room after ${TICKS} ticks: ${frags}; ents: ${a.app.sim.ents(s.h).length / 20}`);

  // leave
  a.app.removePlayer!(a.s, 'alice');
  check(!a.s.slots.includes('alice') && !('alice' in a.s.names), 'leave frees the slot and forgets the userinfo');

  // leaks
  const liveBefore = a.app.sim.liveCount;
  for (let i = 0; i < 50; i++) { const x = a.app.deserialize!(a.app.serialize!(a.s)) as QtState; a.app.dispose!(x); }
  check(a.app.sim.liveCount === liveBefore, `50 clone+dispose cycles leak no world (${liveBefore} live)`);

  console.log(`  ..  ${(stepMs / TICKS * 1000).toFixed(1)} µs per tick (one world, wrapper + events), ${total.toFixed(0)} ms for the whole run`);
  if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
  console.log('all passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
