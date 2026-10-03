// bench: µs per tick with 8 and 16 bots on lqdm maps (native), plus the cost of
// world_hash, clone and serialize.  cargo run --release --bin bench [-- TICKS]
// Copyright (C) 2026 Quake Town authors. GPL-2.0-or-later.
use std::sync::Arc;
use std::time::Instant;

/// this thread's CPU time in seconds (utime+stime from /proc, 100 Hz): the box is shared,
/// wall-clock time would measure the other processes
fn cpu() -> f64 {
    let s = std::fs::read_to_string("/proc/thread-self/stat").unwrap_or_default();
    let rest = s.rsplit(')').next().unwrap_or("");
    let f: Vec<&str> = rest.split_whitespace().collect();
    let ut: f64 = f.get(11).and_then(|x| x.parse().ok()).unwrap_or(0.0);
    let st: f64 = f.get(12).and_then(|x| x.parse().ok()).unwrap_or(0.0);
    (ut + st) / 100.0
}

fn main() {
    let ticks: u32 = std::env::args().nth(1).and_then(|x| x.parse().ok()).unwrap_or(5000);
    let progs = qtsim::qcvm::Progs::load(&std::fs::read(qtsim::scenario::QW_PROGS).unwrap()).unwrap();
    println!("{:<8} {:>5} {:>10} {:>10} {:>9} {:>9} {:>10} {:>9}", "map", "bots", "µs/tick", "max wall", "QC ins/t", "hash µs", "clone µs", "ser KB");
    for name in ["lqdm1", "lqdm3", "lqdm4", "lqdm6", "lqdm9"] {
        let m = qtsim::bsp::Map::load(name, &std::fs::read(format!("{}/{name}.bsp", qtsim::scenario::LQ_MAPS)).unwrap()).unwrap();
        let maps = vec![Arc::new(m)];
        for n in [8, 16] {
            let info = format!("\\deathmatch\\3\\maxclients\\{n}\\bots\\1");
            let mut w = qtsim::World::new(progs.clone(), maps.clone(), 0, 5, info.as_bytes()).unwrap();
            for _ in 0..300 {
                w.tick();
            }
            let i0 = w.vm.instructions();
            let mut max = 0f64;
            let t0 = Instant::now();
            let c0 = cpu();
            for _ in 0..ticks {
                let s = Instant::now();
                w.tick();
                max = max.max(s.elapsed().as_secs_f64());
            }
            let _wall = t0.elapsed().as_secs_f64() * 1e6 / ticks as f64;
            let us = (cpu() - c0) * 1e6 / ticks as f64;
            let ins = (w.vm.instructions() - i0) / ticks as u64;
            let c1 = cpu();
            let mut x = 0u32;
            for _ in 0..2000 {
                x ^= w.hash();
            }
            let hash_us = (cpu() - c1) * 1e6 / 2000.0;
            let c2 = cpu();
            for _ in 0..2000 {
                let c = w.clone();
                std::hint::black_box(&c);
            }
            let clone_us = (cpu() - c2) * 1e6 / 2000.0;
            let mut buf = Vec::new();
            w.serialize_into(&mut buf);
            std::hint::black_box(x);
            println!("{:<8} {:>5} {:>10.1} {:>10.1} {:>9} {:>9.1} {:>10.1} {:>9.1}", name, n, us, max * 1e6, ins, hash_us, clone_us, buf.len() as f64 / 1024.0);
            if let Some(e) = &w.sv.error {
                println!("  stopped: {e}");
            }
        }
    }
}
