#!/usr/bin/env node
// Runs public/qtsim.wasm from Node: the scripted 5,000-tick match with bots
// (sim/qtsim/src/scenario.rs, mirrored here), and compares every tick's world_hash with
// the native build (sim/qtsim `qthash`). Also: clone / serialize roundtrip through the
// ABI, view buffers, and µs/tick with 8 and 16 bots.
//   node tools/sim/test-wasm.mjs [MAP] [TICKS]
// Copyright (C) 2026 Quake Town authors. GPL-2.0-or-later.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAP = process.argv[2] ?? 'lqdm1'
const TICKS = Number(process.argv[3] ?? 5000)
const SEED = 1
const INFO = '\\deathmatch\\3\\maxclients\\8\\bots\\1'
const PROGS = '/app/data/home/quake-ref/Quake/QW/progs/qwprogs.dat'
const MAPS = '/app/data/home/quake-ref/full/id1/maps'

const { instance } = await WebAssembly.instantiate(readFileSync(join(root, 'public', 'qtsim.wasm')), {})
const ex = instance.exports
const u8 = () => new Uint8Array(ex.memory.buffer)
const u32 = (p, n) => new Uint32Array(ex.memory.buffer, p, n).slice()
const enc = new TextEncoder()
const pass = (bytes) => { const p = ex.alloc(bytes.length); u8().set(bytes, p); return [p, bytes.length] }
const cstr = (p) => { const m = u8(); let e = p; while (m[e]) e++; return new TextDecoder().decode(m.subarray(p, e)) }
const names = (p) => { const m = u8(); const out = []; let at = p; for (;;) { let e = at; while (m[e]) e++; const s = new TextDecoder().decode(m.subarray(at, e)); at = e + 1; if (s === '' && out.length > 0) break; out.push(s) } return out }
let failures = 0
const check = (ok, msg) => { if (!ok) { failures++; console.error('FAIL:', msg) } }

const progsId = (() => { const [p, n] = pass(readFileSync(PROGS)); const r = ex.progs_load(p, n); ex.dealloc(p, n); return r })()
check(progsId >= 0, `progs_load ${progsId}: ${cstr(ex.last_error_ptr())}`)
const loadMap = (name) => {
  const b = readFileSync(`${MAPS}/${name}.bsp`); const nm = enc.encode(name)
  const [np, nn] = pass(nm); const [p, n] = pass(b)
  const id = ex.map_load(np, nn, p, n); ex.dealloc(p, n); ex.dealloc(np, nn)
  check(id >= 0, `map_load ${name}: ${cstr(ex.last_error_ptr())}`)
  return id
}
const mapId = loadMap(MAP)
check(cstr(ex.map_name(mapId)) === MAP, 'map_name')
const newWorld = (info, seed = SEED, map = mapId) => { const [p, n] = pass(enc.encode(info)); const h = ex.world_new(progsId, map, seed, p, n); ex.dealloc(p, n); check(h > 0, `world_new: ${cstr(ex.last_error_ptr())}`); return h }
const call = (fn, h, slot, text) => { const [p, n] = pass(enc.encode(text)); fn(h, slot, p, n); ex.dealloc(p, n) }

// ---- scenario.rs mirror
function scriptCmd(t, slot) {
  t = (t + Math.imul(slot, 977)) >>> 0
  const pitch16 = (Math.imul(t, 37) >>> 0) % 2000 - 1000
  const yaw16 = (Math.imul(t, 331) & 0xffff) - 32768
  const forward = t % 300 < 200 ? 400 : -200
  const side = ((Math.floor(t / 50) % 3) - 1) * 350
  const buttons = (t % 17 < 3 ? 1 : 0) | (t % 61 < 2 ? 2 : 0)
  const impulse = t % 500 === 0 ? (Math.floor(t / 500) % 8) + 1 : 0
  return [pitch16, yaw16, forward, side, 0, buttons, impulse]
}
function scriptEvents(h, t) {
  switch (t) {
    case 1: call(ex.world_client_join, h, ex.world_free_slot(h), '\\name\\alice\\topcolor\\4\\bottomcolor\\12\\team\\red'); break
    case 1000: call(ex.world_set_userinfo, h, 0, '\\name\\alice2\\topcolor\\3\\bottomcolor\\3\\team\\blue'); break
    case 2000: call(ex.world_client_join, h, ex.world_free_slot(h), '\\name\\bob\\team\\red'); break
    case 2500: call(ex.world_client_command, h, 0, 'kill'); break
    case 3000: ex.world_client_leave(h, 1); break
    case 4000: ex.world_client_idle(h, 0); break
    case 4500: call(ex.world_client_join, h, 0, '\\name\\alice2'); break
  }
}
function scriptTick(h, t) {
  scriptEvents(h, t)
  const rows = ex.world_view_clients(h)
  const n = u32(rows, 1)[0]
  const r = u32(rows + 4, n * 32)
  for (let s = 0; s < n; s++) {
    if (r[s * 32 + 1] === 1) { const c = scriptCmd(t, s); ex.world_set_cmd(h, s, ...c) }
  }
  ex.world_tick(h)
}

// ---- native vs wasm hash sequence
const h = newWorld(INFO)
const wasmHashes = [(ex.world_hash(h) >>> 0).toString(16).padStart(8, '0')]
let events = 0, prints = 0, obits = 0
const t0 = performance.now()
for (let t = 1; t <= TICKS; t++) {
  scriptTick(h, t)
  wasmHashes.push((ex.world_hash(h) >>> 0).toString(16).padStart(8, '0'))
  const ep = ex.world_events(h); const n = u32(ep, 1)[0]; events += n
  const ev = u32(ep + 4, n * 10)
  for (let k = 0; k < n; k++) { if (ev[k * 10] === 3) prints++ }
}
const ms = performance.now() - t0
console.log(`wasm: ${TICKS} ticks on ${MAP} in ${ms.toFixed(0)} ms (${(ms * 1000 / TICKS).toFixed(1)} µs/tick incl. hash+views), ${events} events, ${prints} prints`)
const env = { ...process.env, PATH: `${join(homedir(), '.cargo', 'bin')}:${process.env.PATH}`, CARGO_BUILD_JOBS: '1' }
const native = execFileSync('cargo', ['run', '-q', '--release', '-p', 'qtsim', '--bin', 'qthash', '--', MAP, String(TICKS), String(SEED), INFO], { cwd: join(root, 'sim'), env, maxBuffer: 1 << 26 }).toString().trim().split('\n')
check(native.length === wasmHashes.length, `native ${native.length} hashes, wasm ${wasmHashes.length}`)
let firstDiff = -1
for (let i = 0; i < wasmHashes.length; i++) if (native[i] !== wasmHashes[i]) { firstDiff = i; break }
check(firstDiff < 0, `native and wasm diverge at tick ${firstDiff}: ${native[firstDiff]} vs ${wasmHashes[firstDiff]}`)
if (firstDiff < 0) console.log(`native == wasm for all ${wasmHashes.length} hashes (last ${wasmHashes.at(-1)})`)

// ---- views
const ep = ex.world_view_ents(h); const ne = u32(ep, 1)[0]
const ents = u32(ep + 4, ne * 20)
const models = names(ex.world_model_names(h)), sounds = names(ex.world_sound_names(h))
const lights = (() => { const m = u8(); const out = []; let at = ex.world_lightstyles(h); for (let i = 0; i < 64; i++) { let e = at; while (m[e]) e++; out.push(new TextDecoder().decode(m.subarray(at, e))); at = e + 1 } return out })()
const cv = u32(ex.world_view_client(h, 0), 64)
console.log(`views: ${ne} ents, ${models.length} models (${models[1]}), ${sounds.length} sounds, lightstyle0 "${lights[0]}", slot0 state ${cv[2]} health ${cv[19] | 0} frags ${cv[31] | 0}`)
check(ne > 20 && models[1] === `maps/${MAP}.bsp` && sounds.length > 20 && cv[1] === 1, 'views')
check(ents.every((w, i) => i % 20 !== 0 || w > 0), 'ent nums')
check(cstr(ex.world_client_info(h, 0)).includes('alice2'), 'client info')
check(cstr(ex.world_serverinfo(h)).includes(`\\map\\${MAP}`), 'serverinfo map')

// ---- clone + serialize roundtrip through the ABI
const len = ex.world_serialize(h)
const bytes = u8().slice(ex.world_buf_ptr(), ex.world_buf_ptr() + len)
const [bp, bn] = pass(bytes); const h2 = ex.world_deserialize(bp, bn); ex.dealloc(bp, bn)
check(h2 > 0, `world_deserialize: ${cstr(ex.last_error_ptr())}`)
const h3 = ex.world_clone(h)
check(ex.world_hash(h) === ex.world_hash(h2) && ex.world_hash(h) === ex.world_hash(h3), 'hash after copy')
for (let t = TICKS + 1; t <= TICKS + 500; t++) {
  for (const w of [h, h2, h3]) scriptTick(w, t)
  if (ex.world_hash(h) !== ex.world_hash(h2) || ex.world_hash(h) !== ex.world_hash(h3)) { check(false, `copies diverged at ${t}`); break }
}
const [jp, jn] = pass(bytes.slice(0, 100)); check(ex.world_deserialize(jp, jn) === 0, 'truncated data refused'); ex.dealloc(jp, jn)
console.log(`serialized ${len} bytes; clone + deserialize stay in sync`)
for (const w of [h, h2, h3]) ex.world_free(w)

// ---- bench: µs/tick with 8 and 16 bots on a few maps (world_tick only)
for (const name of ['lqdm1', 'lqdm4', 'lqdm6']) {
  const id = name === MAP ? mapId : loadMap(name)
  for (const n of [8, 16]) {
    const w = newWorld(`\\deathmatch\\3\\maxclients\\${n}\\bots\\1`, 5, id)
    for (let t = 0; t < 200; t++) ex.world_tick(w)
    const N = 3000
    // CPU time, not wall time: the box is shared
    const c0 = process.cpuUsage()
    for (let t = 0; t < N; t++) ex.world_tick(w)
    const c = process.cpuUsage(c0)
    const us = (c.user + c.system) / N
    const h0 = process.cpuUsage()
    for (let t = 0; t < 500; t++) ex.world_hash(w)
    const hc = process.cpuUsage(h0)
    console.log(`bench wasm ${name} ${n} bots: ${us.toFixed(1)} µs/tick (cpu), world_hash ${((hc.user + hc.system) / 500).toFixed(1)} µs`)
    ex.world_free(w)
  }
}
console.log(`sim_version ${ex.sim_version()}, memory ${(ex.memory.buffer.byteLength / 1048576).toFixed(1)} MB`)
if (failures) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('OK')
