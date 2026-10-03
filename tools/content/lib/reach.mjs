// Walk-reachability on a compiled BSP with the player hull (hull 1).
// Builds a navigation graph of standing spots on a 32-unit grid (exact floor heights found in
// the clip hull), connects them with hull-1 traces for walking (step ≤ 18), dropping, jumping
// (≤ 40 up, gaps up to 160 at running/strafe-jump speed), swimming and climbing out of water,
// plus map mechanics: teleporters, trigger_push jump pads (flight simulated with gravity 800 and
// hull-1 traces), func_plat lifts. trigger_hurt volumes are excluded. Then BFS from the spawns.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { pointContents, CONTENTS } from './bsp.mjs';

const GRID = 32, STEP = 18, JUMP_UP = 40, JUMP_GAP = 160;

/** true if hull h has no solid along p1→p2 (SV_RecursiveHullCheck reduced to a yes/no) */
export function clearPath(bsp, h, p1, p2) {
  const clip = bsp.clip, planes = bsp.planes;
  const rec = (num, a, b) => {
    if (num < 0) return num !== CONTENTS.SOLID;
    const c = clip[num], pl = planes[c[0]];
    const t1 = pl.n[0] * a[0] + pl.n[1] * a[1] + pl.n[2] * a[2] - pl.d;
    const t2 = pl.n[0] * b[0] + pl.n[1] * b[1] + pl.n[2] * b[2] - pl.d;
    if (t1 >= 0 && t2 >= 0) return rec(c[1], a, b);
    if (t1 < 0 && t2 < 0) return rec(c[2], a, b);
    const f = t1 / (t1 - t2);
    const mid = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    const side = t1 < 0 ? 2 : 1;
    return rec(c[side], a, mid) && rec(c[side === 1 ? 2 : 1], mid, b);
  };
  return rec(bsp.models[0].head[h], p1, p2);
}

const solid1 = (bsp, p) => pointContents(bsp, 1, p) === CONTENTS.SOLID;

function entBox(bsp, e) {
  if (!e.model || !e.model.startsWith('*')) return null;
  const m = bsp.models[+e.model.slice(1)];
  return m ? { mins: m.mins, maxs: m.maxs } : null;
}
const inBox = (p, b, pad = 0) => p[0] >= b.mins[0] - pad && p[0] <= b.maxs[0] + pad && p[1] >= b.mins[1] - pad && p[1] <= b.maxs[1] + pad && p[2] >= b.mins[2] - pad && p[2] <= b.maxs[2] + pad;

export function reachability(bsp) {
  const t0 = Date.now();
  const w = bsp.models[0];
  const hurts = bsp.ents.filter((e) => e.classname === 'trigger_hurt').map((e) => entBox(bsp, e)).filter(Boolean);
  // ---- nodes -----------------------------------------------------------------------------
  const nodes = [];           // { p:[x,y,z], col }
  const cols = new Map();     // "i,j" -> [node index]
  const i0 = Math.floor(w.mins[0] / GRID), i1 = Math.ceil(w.maxs[0] / GRID);
  const j0 = Math.floor(w.mins[1] / GRID), j1 = Math.ceil(w.maxs[1] / GRID);
  const zTop = w.maxs[2] + 32, zBot = w.mins[2] - 32;
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const x = i * GRID + GRID / 2, y = j * GRID + GRID / 2;
    const list = [];
    let prevSolid = solid1(bsp, [x, y, zTop]);
    for (let z = zTop - 8; z >= zBot; z -= 8) {
      const s = solid1(bsp, [x, y, z]);
      if (s && !prevSolid) {
        // empty at z+8, solid at z: find the lowest empty height
        let lo = z, hi = z + 8;
        while (hi - lo > 0.25) { const m = (lo + hi) / 2; if (solid1(bsp, [x, y, m])) lo = m; else hi = m; }
        const p = [x, y, hi + 0.03125];
        if (!hurts.some((b) => inBox(p, b, 16))) {
          const c0 = pointContents(bsp, 0, p);
          if (c0 !== CONTENTS.LAVA && c0 !== CONTENTS.SLIME && c0 !== CONTENTS.SKY) { list.push(nodes.length); nodes.push({ p, i, j }); }
        }
      }
      prevSolid = s;
    }
    if (list.length) cols.set(`${i},${j}`, list);
  }
  const adj = nodes.map(() => []);
  const link = (a, b) => adj[a].push(b);
  const near = (i, j, r) => {
    const out = [];
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      if (!di && !dj) continue;
      const l = cols.get(`${i + di},${j + dj}`);
      if (l) out.push(...l);
    }
    return out;
  };
  const inWater = (p) => { const c = pointContents(bsp, 0, p); return c === CONTENTS.WATER || c === CONTENTS.SLIME; };
  // ---- walk / drop / jump / swim edges ------------------------------------------------------
  const jr = Math.ceil(JUMP_GAP / GRID);
  for (let a = 0; a < nodes.length; a++) {
    const A = nodes[a].p;
    for (const b of near(nodes[a].i, nodes[a].j, jr)) {
      const B = nodes[b].p;
      const dh = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const dz = B[2] - A[2];
      const adjacent = dh <= GRID * 1.5;
      if (adjacent && dz <= STEP) {
        // walk / step up / drop: rise to the higher level, move across, settle
        const top = Math.max(A[2], B[2]) + 1;
        if (clearPath(bsp, 1, A, [A[0], A[1], top]) && clearPath(bsp, 1, [A[0], A[1], top], [B[0], B[1], top]) && clearPath(bsp, 1, [B[0], B[1], top], B)) { link(a, b); continue; }
      }
      if (dz > JUMP_UP) {
        // only water lets you climb higher than a jump: swim up and climb out
        if (adjacent || dh <= 64) {
          const wa = inWater([A[0], A[1], A[2] + 8]);
          if (wa) {
            let surf = A[2];
            while (inWater([A[0], A[1], surf + 4]) && surf < B[2] + 64) surf += 4;
            if (B[2] <= surf + 30 && clearPath(bsp, 1, A, [A[0], A[1], B[2] + 2]) && clearPath(bsp, 1, [A[0], A[1], B[2] + 2], [B[0], B[1], B[2] + 2])) link(a, b);
          }
        }
        continue;
      }
      // jump: up to 40 higher, or across a gap (at most JUMP_GAP horizontally, more if dropping)
      if (dh > JUMP_GAP + Math.max(0, -dz) * 0.5) continue;
      const apex = Math.max(A[2], B[2]) + 44;
      if (clearPath(bsp, 1, A, [A[0], A[1], apex]) && clearPath(bsp, 1, [A[0], A[1], apex], [B[0], B[1], apex]) && clearPath(bsp, 1, [B[0], B[1], apex], B)) link(a, b);
    }
  }
  // ---- mechanics ---------------------------------------------------------------------------
  const nearestNode = (p, maxH = 48, maxDz = 40) => {
    let best = -1, bd = Infinity;
    const i = Math.floor(p[0] / GRID), j = Math.floor(p[1] / GRID);
    for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) {
      for (const n of cols.get(`${i + di},${j + dj}`) ?? []) {
        const q = nodes[n].p;
        const h = Math.hypot(q[0] - p[0], q[1] - p[1]), dz = Math.abs(q[2] - p[2]);
        if (h > maxH || dz > maxDz) continue;
        const d = h + dz * 2;
        if (d < bd && clearPath(bsp, 1, [p[0], p[1], Math.max(p[2], q[2]) + 1], [q[0], q[1], Math.max(p[2], q[2]) + 1])) { bd = d; best = n; }
      }
    }
    return best;
  };
  const nodesIn = (box, pad) => nodes.map((n, k) => (inBox(n.p, box, pad) ? k : -1)).filter((k) => k >= 0);
  const mech = [];
  for (const e of bsp.ents) {
    if (e.classname === 'trigger_teleport') {
      const box = entBox(bsp, e);
      const d = bsp.ents.find((x) => x.classname === 'info_teleport_destination' && x.targetname === e.target);
      if (!box || !d) continue;
      const o = d.origin.split(' ').map(Number); o[2] += 27;
      const to = nearestNode([o[0], o[1], o[2] - 24 + 24], 48, 40);
      const from = nodesIn(box, 32);
      if (to >= 0) for (const f of from) link(f, to);
      mech.push(`teleport ${e.target}: ${from.length} entry spots -> ${to >= 0 ? 'ok' : 'NO landing spot'}`);
    } else if (e.classname === 'trigger_push') {
      const box = entBox(bsp, e);
      if (!box) continue;
      let dirv;
      if (e.angle === '-1' || e.angles === '0 -1 0') dirv = [0, 0, 1];
      else {
        const [pitch, yaw] = (e.angles ?? `0 ${e.angle ?? 0} 0`).split(' ').map((v) => (+v * Math.PI) / 180);
        dirv = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch)];
      }
      const sp = (+(e.speed ?? 1000)) * 10;
      const c = [(box.mins[0] + box.maxs[0]) / 2, (box.mins[1] + box.maxs[1]) / 2, box.mins[2]];
      while (solid1(bsp, c) && c[2] < box.maxs[2] + 64) c[2] += 1; // standing height on the pad
      // flight with gravity 800, hull-1 collision; stop on landing (velocity down and floor below)
      let p = c.slice(), v = dirv.map((x) => x * sp), land = -1;
      for (let k = 0; k < 400; k++) {
        const dt = 0.013;
        const np = [p[0] + v[0] * dt, p[1] + v[1] * dt, p[2] + v[2] * dt];
        v[2] -= 800 * dt;
        const rising = k < 4 || v[2] > 0;
        if (!clearPath(bsp, 1, p, np)) {
          // blocked: slide vertically only (hit a wall: keep falling), or landed
          if (!rising && solid1(bsp, [p[0], p[1], p[2] - 2])) { land = nearestNode(p, 48, 48); break; }
          if (clearPath(bsp, 1, p, [p[0], p[1], np[2]])) { p = [p[0], p[1], np[2]]; v[0] = v[1] = 0; continue; }
          v = [0, 0, Math.min(0, v[2])];
          continue;
        }
        p = np;
        if (!rising && solid1(bsp, [p[0], p[1], p[2] - 2])) { land = nearestNode(p, 48, 48); break; }
      }
      const from = nodesIn({ mins: [box.mins[0], box.mins[1], box.mins[2] - 24], maxs: box.maxs }, 16);
      if (land >= 0) for (const f of from) link(f, land);
      mech.push(`jump pad at ${c.map(Math.round).join(' ')}: lands ${land >= 0 ? `at ${nodes[land].p.map(Math.round).join(' ')}` : 'NOWHERE'}`);
    } else if (e.classname === 'func_plat') {
      const box = entBox(bsp, e);
      if (!box) continue;
      const height = e.height ? +e.height : box.maxs[2] - box.mins[2] - 8;
      const topZ = box.maxs[2] + 24, botZ = box.maxs[2] - height + 24;
      const bottom = nodes.map((n, k) => (n.p[0] > box.mins[0] - 48 && n.p[0] < box.maxs[0] + 48 && n.p[1] > box.mins[1] - 48 && n.p[1] < box.maxs[1] + 48 && Math.abs(n.p[2] - botZ) < 20 ? k : -1)).filter((k) => k >= 0);
      const top = nodes.map((n, k) => (n.p[0] > box.mins[0] - 64 && n.p[0] < box.maxs[0] + 64 && n.p[1] > box.mins[1] - 64 && n.p[1] < box.maxs[1] + 64 && Math.abs(n.p[2] - topZ) < 20 ? k : -1)).filter((k) => k >= 0);
      for (const b of bottom) for (const t of top) { link(b, t); link(t, b); }
      mech.push(`lift ${e.model}: ${bottom.length} bottom spots <-> ${top.length} top spots`);
    }
  }
  // ---- search from the spawns --------------------------------------------------------------
  const spawnEnts = bsp.ents.filter((e) => /^info_player_(deathmatch|start|team1|team2)$/.test(e.classname));
  const spawnNodes = spawnEnts.map((e) => { const o = e.origin.split(' ').map(Number); return nearestNode(o, 40, 8); });
  const seen = new Uint8Array(nodes.length);
  const q = [];
  const start = spawnNodes.find((n) => n >= 0);
  if (start !== undefined) { seen[start] = 1; q.push(start); }
  while (q.length) { const a = q.pop(); for (const b of adj[a]) if (!seen[b]) { seen[b] = 1; q.push(b); } }
  const errs = [];
  spawnEnts.forEach((e, k) => {
    if (spawnNodes[k] < 0) errs.push(`${e.classname} at ${e.origin}: no standing spot found`);
    else if (!seen[spawnNodes[k]]) errs.push(`${e.classname} at ${e.origin} is not reachable from the first spawn`);
  });
  // can every spawn get back to the first one? (no one-way traps) — reverse search
  const radj = nodes.map(() => []);
  adj.forEach((l, a) => { for (const b of l) radj[b].push(a); });
  const back = new Uint8Array(nodes.length);
  if (start !== undefined) { back[start] = 1; q.push(start); }
  while (q.length) { const a = q.pop(); for (const b of radj[a]) if (!back[b]) { back[b] = 1; q.push(b); } }
  spawnEnts.forEach((e, k) => { if (spawnNodes[k] >= 0 && seen[spawnNodes[k]] && !back[spawnNodes[k]]) errs.push(`${e.classname} at ${e.origin}: cannot walk back to the rest of the map (one-way)`); });
  let items = 0;
  for (const e of bsp.ents.filter((x) => /^(item_|weapon_)/.test(x.classname))) {
    items++;
    const o = e.origin.split(' ').map(Number);
    const corner = /^(weapon_|item_armor|item_artifact|item_flag)/.test(e.classname);
    const c = corner ? [o[0], o[1], o[2] - 8 + 24] : [o[0] + 16, o[1] + 16, o[2] - 8 + 24];
    const n = nearestNode(c, 40, 30);
    if (n < 0 || !seen[n]) errs.push(`${e.classname} at ${e.origin} is not reachable on foot from the spawns`);
  }
  const reached = seen.reduce((a, b) => a + b, 0);
  return { errs, mech, stats: `reach: ${nodes.length} standing spots, ${adj.reduce((a, l) => a + l.length, 0)} moves, ${reached} reachable from spawns; ${spawnEnts.length} spawns + ${items} items checked in ${Date.now() - t0} ms` };
}
