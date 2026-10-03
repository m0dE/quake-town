// @ts-nocheck
import { readFileSync } from 'node:fs';
import { createQtApp, QtSim } from '/app/data/home/quake-town/src/sim/qtsim.ts';
import { loadTestContent } from '/app/data/home/quake-town/tools/test/content.ts';
import { CV, ENT_WORDS } from '/app/data/home/quake-town/src/sim/abi.ts';
import { encodeCmd } from '/app/data/home/quake-town/src/sim/wire.ts';
const sim = await QtSim.create(readFileSync('/app/data/home/quake-town/public/qtsim.wasm'));
const c = await loadTestContent(false);
const pid = sim.loadProgs(c.progs); let mid=-1; for (const [n,b] of c.maps) { const id=sim.loadMap(n,b); if(mid<0) mid=id; }
console.log('maps', c.maps.map(m=>m[0]), 'serverinfo', c.serverinfo);
const app = createQtApp(sim, { progsId: pid, mapId: mid, serverinfo: c.serverinfo });
const s = app.init({ frame: 0, roster: [], seed: 1 });
const ctx = { frame: 0 };
app.applyInput(s, { u: '\\name\\alice' }, ctx, 'alice'); app.applyInput(s, { j: 1 }, ctx, 'alice');
let t0=performance.now();
for (let i = 0; i < 400; i++) { app.applyInput(s, encodeCmd({pitch:0,yaw:0,forward:400,side:0,up:0,buttons:i%50==0?2:0,impulse:0}), ctx, 'alice'); app.step(s, ctx); }
console.log('ms/tick', (performance.now()-t0)/400);
const cv = sim.client(s.h, 0); const f = new Float32Array(cv.buffer);
console.log('state', cv[CV.state], 'ent', cv[CV.entnum], 'origin', f[3], f[4], f[5], 'vel', f[6],f[7],f[8], 'health', cv[CV.health], 'weapon', cv[CV.weapon], 'wm', cv[CV.weaponmodel], 'items', cv[CV.items], 'phase', cv[CV.phase], f[CV.phaseEnd], 'viewofs', f[12]);
console.log('models', sim.modelNames(s.h).slice(0,30));
console.log('sounds', sim.soundNames(s.h).length);
const ents = sim.ents(s.h); console.log('ents', ents.length/ENT_WORDS, Array.from(ents.slice(0,20)));
console.log('stopped', sim.ex.world_stopped(s.h), sim.error());
const ev = sim.events(s.h); console.log('events', ev.ev.length/10, ev.strs);
