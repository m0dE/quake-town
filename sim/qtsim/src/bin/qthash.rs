// qthash: the scripted match's per-tick world hash, for tools/sim/test-wasm.mjs.
//   qthash MAP TICKS SEED INFO   (prints one hex hash per line, tick 0 = after world_new)
// Copyright (C) 2026 Quake Town authors. GPL-2.0-or-later.
use std::sync::Arc;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let map = a.get(1).cloned().unwrap_or("lqdm1".into());
    let ticks: u32 = a.get(2).and_then(|x| x.parse().ok()).unwrap_or(5000);
    let seed: u32 = a.get(3).and_then(|x| x.parse().ok()).unwrap_or(1);
    let info = a.get(4).cloned().unwrap_or("\\deathmatch\\3\\maxclients\\8\\bots\\1".into());
    let progs = qtsim::qcvm::Progs::load(&std::fs::read(qtsim::scenario::QW_PROGS).unwrap()).unwrap();
    let path = format!("{}/{map}.bsp", qtsim::scenario::LQ_MAPS);
    let m = qtsim::bsp::Map::load(&map, &std::fs::read(path).unwrap()).unwrap();
    let mut w = qtsim::World::new(progs, vec![Arc::new(m)], 0, seed, info.as_bytes()).unwrap();
    let mut out = String::with_capacity(ticks as usize * 9);
    out.push_str(&format!("{:08x}\n", w.hash()));
    for t in 1..=ticks {
        qtsim::scenario::script_tick(&mut w, t);
        out.push_str(&format!("{:08x}\n", w.hash()));
    }
    print!("{out}");
}
