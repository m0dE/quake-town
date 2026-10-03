// Quake Town - qcvm: garbage progs / garbage states never panic.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later

mod common;
use common::*;
use qcvm::defs::glob;
use qcvm::{Pcg32, Progs, Vm, VmConfig};

/// Run every function of `p` a little under a small budget; must not panic.
fn exercise(p: std::sync::Arc<Progs>, seed: u64) {
    let cfg = VmConfig { runaway: 20_000, max_edicts: 64, ..Default::default() };
    let mut vm = Vm::new(p.clone(), cfg, seed);
    let mut host = MockHost { time: 1.0, ..Default::default() };
    let n = p.functions().len() as u32;
    let mut rng = Pcg32::new(seed);
    for k in 0..n.min(400) {
        let f = if k % 2 == 0 { k } else { rng.below(n + 3) };
        vm.set_budget(50_000);
        vm.set_g_e(glob::SELF, rng.below(40));
        for i in 0..24 {
            vm.set_g_i(4 + i, rng.next_u32() as i32 >> (rng.below(32)));
        }
        let _ = vm.call(&mut host, f);
        vm.clear_error();
    }
    let mut buf = Vec::new();
    vm.serialize(&mut buf);
    let (vm2, _) = Vm::deserialize(p, &buf).expect("roundtrip");
    assert_eq!(vm2.hash(), vm.hash());
}

#[test]
fn random_bytes_never_panic() {
    let mut rng = Pcg32::new(99);
    for len in [0usize, 1, 59, 60, 61, 100, 1000, 5000] {
        for _ in 0..50 {
            let mut b: Vec<u8> = (0..len).map(|_| rng.next_u32() as u8).collect();
            if b.len() >= 8 {
                b[0..4].copy_from_slice(&6i32.to_le_bytes());
                b[4..8].copy_from_slice(&54730i32.to_le_bytes());
            }
            if let Ok(p) = Progs::load(&b) {
                exercise(p, 1);
            }
        }
    }
}

#[test]
fn mutated_qwprogs_never_panic() {
    let Some(orig) = qwprogs() else { return };
    let mut rng = Pcg32::new(1234);
    let ents = bsp_entities(&format!("{}/lqdm1.bsp", MAPS)).unwrap();
    let mut loaded = 0;
    let hdr = |i: usize| i32::from_le_bytes(orig[i * 4..i * 4 + 4].try_into().unwrap()) as usize;
    let (st_ofs, st_n, gl_ofs, gl_n) = (hdr(2), hdr(3), hdr(12), hdr(13));
    let rounds = 300;
    for round in 0..rounds {
        let mut b = orig.clone();
        // mutate: header fields, then random words in statements / functions / globals
        let nmut = 1 + rng.below(40);
        for _ in 0..nmut {
            let region = rng.below(10);
            let pos = match region {
                0 => 8 + rng.below(52) as usize,
                1 => 60 + rng.below((b.len() - 64) as u32) as usize,
                2 | 3 => gl_ofs + 4 * rng.below(gl_n as u32) as usize,
                _ => st_ofs + 2 * rng.below(4 * st_n as u32) as usize,
            };
            let v = match rng.below(4) {
                0 => 0u32,
                1 => 0xFFFF_FFFF,
                2 => rng.below(70),
                _ => rng.next_u32(),
            };
            let w = if rng.below(2) == 0 { 2 } else { 4 };
            for k in 0..w {
                if pos + k < b.len() {
                    b[pos + k] = (v >> (8 * k)) as u8;
                }
            }
        }
        if let Ok(p) = Progs::load(&b) {
            loaded += 1;
            let mut vm = Vm::new(p.clone(), VmConfig { runaway: 50_000, ..Default::default() }, round);
            let mut host = MockHost { time: 1.0, ..Default::default() };
            let _ = vm.load_entities(&mut host, &ents, 1.0);
            exercise(p, round);
        }
    }
    eprintln!("mutated progs that still loaded: {}/{}", loaded, rounds);
}

#[test]
fn garbage_states_never_panic() {
    let Some(orig) = qwprogs() else { return };
    let p = Progs::load(&orig).unwrap();
    let mut w = MiniWorld::new(Vm::new(p.clone(), VmConfig::default(), 5));
    let ents = bsp_entities(&format!("{}/lqdm1.bsp", MAPS)).unwrap();
    w.spawn_map(&ents).unwrap();
    w.connect(1).unwrap();
    for _ in 0..50 {
        w.step(true, true, 0.0).unwrap();
    }
    let mut good = Vec::new();
    w.vm.serialize(&mut good);
    let mut rng = Pcg32::new(7);
    for _ in 0..300 {
        let mut b = good.clone();
        for _ in 0..1 + rng.below(8) {
            let i = rng.below(b.len() as u32) as usize;
            b[i] = rng.next_u32() as u8;
        }
        if rng.below(4) == 0 {
            b.truncate(rng.below(b.len() as u32) as usize);
        }
        if let Ok((mut vm, _)) = Vm::deserialize(p.clone(), &b) {
            let mut host = MockHost { time: 2.0, ..Default::default() };
            vm.set_g_e(glob::SELF, 1);
            let f = vm.g_fn(glob::PLAYERPRETHINK);
            let _ = vm.call(&mut host, f);
            let _ = vm.hash();
        }
    }
    // states of another progs are refused
    let mut other = orig.clone();
    let last = other.len() - 1;
    other[last] ^= 1;
    let p2 = Progs::load(&other).unwrap();
    assert!(Vm::deserialize(p2, &good).is_err());
}
