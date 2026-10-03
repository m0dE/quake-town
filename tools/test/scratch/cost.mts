// @ts-nocheck
import { readFileSync } from 'node:fs';
import { createQtApp, QtSim } from '/app/data/home/quake-town/src/sim/qtsim.ts';
import { loadTestContent } from '/app/data/home/quake-town/tools/test/content.ts';
import { encodeCmd } from '/app/data/home/quake-town/src/sim/wire.ts';
for (const [max, bots] of [[4, false], [8, true]]) {
  const sim = await QtSim.create(readFileSync('/app/data/home/quake-town/public/qtsim.wasm'));
  const c = await loadTestContent(false, { maxclients: max, bots });
  const pid = sim.loadProgs(c.progs); let mid=-1; for (const [n,b] of c.maps) { const id=sim.loadMap(n,b); if(mid<0) mid=id; }
  const app = createQtApp(sim, { progsId: pid, mapId: mid, serverinfo: c.serverinfo });
  const s = app.init({ frame: 0, roster: [], seed: 1 });
  const ctx = { frame: 0 };
  for (const id of ['a','b']) { app.applyInput(s, { u: `\\name\\${id}` }, ctx, id); app.applyInput(s, { j: 1 }, ctx, id); }
  const N = 1500; let tStep = 0, tHash = 0;
  for (let i = 0; i < N; i++) {
    for (const id of ['a','b']) app.applyInput(s, encodeCmd({pitch:0,yaw:(i*50)%65536-32768,forward:400,side:i%30<15?400:-400,up:0,buttons:(i%10==0?1:0)|(i%37==0?2:0),impulse:i%300==0?7:0}), ctx, id);
    let t = performance.now(); app.step(s, ctx); tStep += performance.now() - t;
    t = performance.now(); app.hash(s); tHash += performance.now() - t;
  }
  console.log(`maxclients ${max} bots ${bots}: step ${(tStep/N*1000).toFixed(0)} µs, hash ${(tHash/N*1000).toFixed(0)} µs`);
}
