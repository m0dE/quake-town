#!/usr/bin/env node
// Builds the sim (sim/qtsim, Rust) to wasm32 and writes public/qtsim.wasm.
//   node tools/sim/build-sim.mjs        (npm run build:sim)
// Runs wasm-opt -O3 if it is on PATH (optional). Checks the module imports nothing and
// exports the whole ABI (DESIGN.md "The wasm ABI").
// Copyright (C) 2026 Quake Town authors. GPL-2.0-or-later.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const simDir = join(root, 'sim')
const env = {
  ...process.env,
  PATH: `${join(homedir(), '.cargo', 'bin')}:${process.env.PATH ?? ''}`,
  CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '1',
}

execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'qtsim', '--lib'], { cwd: simDir, env, stdio: 'inherit' })

const targetDir = env.CARGO_TARGET_DIR ?? join(simDir, 'target')
const built = join(targetDir, 'wasm32-unknown-unknown', 'release', 'qtsim.wasm')
let wasm = stripCustomSections(readFileSync(built))

const opt = spawnSync('wasm-opt', ['--version'], { env })
if (opt.status === 0) {
  const tin = join(tmpdir(), `qtsim-in-${process.pid}.wasm`)
  const tout = join(tmpdir(), `qtsim-out-${process.pid}.wasm`)
  writeFileSync(tin, wasm)
  // no float-changing passes: -O3 keeps IEEE semantics
  execFileSync('wasm-opt', ['-O3', '--strip-debug', tin, '-o', tout], { env, stdio: 'inherit' })
  wasm = readFileSync(tout)
  console.log('wasm-opt -O3 applied')
} else {
  console.log('wasm-opt not found: skipped (optional)')
}

const mod = new WebAssembly.Module(wasm)
const imports = WebAssembly.Module.imports(mod)
if (imports.length) throw new Error(`qtsim.wasm must import nothing, imports: ${imports.map((i) => `${i.module}.${i.name}`).join(', ')}`)
const exports = WebAssembly.Module.exports(mod).map((e) => e.name)
const abi = [
  'memory', 'alloc', 'dealloc', 'sim_version', 'last_error_ptr',
  'progs_load', 'map_load', 'map_name', 'map_count',
  'world_new', 'world_free', 'world_clone', 'world_serialize', 'world_buf_ptr', 'world_deserialize',
  'world_hash', 'world_tick_count', 'world_map',
  'world_free_slot', 'world_client_join', 'world_client_leave', 'world_client_idle', 'world_set_userinfo', 'world_client_command',
  'world_set_cmd', 'world_tick', 'world_tick_ms',
  'world_view_ents', 'world_view_client', 'world_view_clients', 'world_client_info', 'world_events', 'world_strings',
  'world_model_names', 'world_sound_names', 'world_lightstyles', 'world_serverinfo', 'world_set_cvar',
]
for (const name of abi) if (!exports.includes(name)) throw new Error(`qtsim.wasm is missing export ${name}`)

const out = join(root, 'public', 'qtsim.wasm')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, wasm)
console.log(`wrote ${out} (${(wasm.length / 1024).toFixed(1)} KB, ${exports.length} exports, no imports)`)

/** drop custom sections (names, producers, target_features): they only add size */
function stripCustomSections(buf) {
  const parts = [buf.subarray(0, 8)]
  let p = 8
  const leb = () => {
    let r = 0, s = 0, b
    do { b = buf[p++]; r |= (b & 0x7f) << s; s += 7 } while (b & 0x80)
    return r >>> 0
  }
  while (p < buf.length) {
    const start = p
    const id = buf[p++]
    const size = leb()
    const end = p + size
    if (id !== 0) parts.push(buf.subarray(start, end))
    p = end
  }
  return Buffer.concat(parts)
}
