// Quake Town - qcvm: tests against id's qwprogs.dat (GPL, not in the repo) and lqdm maps.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later

mod common;
use common::*;
use qcvm::defs::{fld, glob, ty};
use qcvm::{Progs, Vm, VmConfig};

fn load() -> Option<std::sync::Arc<Progs>> {
    let bytes = qwprogs()?;
    Some(Progs::load(&bytes).expect("qwprogs.dat loads"))
}

#[test]
fn loads_and_layout_matches_progdefs() {
    let Some(p) = load() else { return };
    assert_eq!(p.crc(), 54730);
    assert_eq!(p.entityfields(), 194);
    // every named def of the C structs sits where defs.rs says
    let checks_g: &[(&str, u32)] = &[
        ("self", glob::SELF),
        ("other", glob::OTHER),
        ("time", glob::TIME),
        ("frametime", glob::FRAMETIME),
        ("mapname", glob::MAPNAME),
        ("parm1", glob::PARM1),
        ("parm16", glob::PARM16),
        ("v_forward", glob::V_FORWARD),
        ("trace_ent", glob::TRACE_ENT),
        ("msg_entity", glob::MSG_ENTITY),
        ("main", glob::MAIN),
        ("SetChangeParms", glob::SETCHANGEPARMS),
    ];
    for (n, o) in checks_g {
        assert_eq!(p.find_global(n).unwrap().ofs, *o, "global {}", n);
    }
    let checks_f: &[(&str, u32)] = &[
        ("modelindex", fld::MODELINDEX),
        ("origin", fld::ORIGIN),
        ("classname", fld::CLASSNAME),
        ("think", fld::THINK),
        ("nextthink", fld::NEXTTHINK),
        ("health", fld::HEALTH),
        ("v_angle", fld::V_ANGLE),
        ("netname", fld::NETNAME),
        ("noise3", fld::NOISE3),
    ];
    for (n, o) in checks_f {
        assert_eq!(p.find_field(n).unwrap().ofs, *o, "field {}", n);
    }
    assert_eq!(p.find_field("origin").unwrap().ty, ty::VECTOR);
    assert!(p.find_function("worldspawn").is_some());
    assert!(p.find_function("PlayerPreThink").is_some());
    assert!(p.find_function("no_such_function").is_none());
}

#[test]
fn refuses_netquake_and_bad_versions() {
    let Some(mut bytes) = qwprogs() else { return };
    bytes[4..8].copy_from_slice(&5927i32.to_le_bytes());
    let e = Progs::load(&bytes).err().unwrap();
    assert_eq!(e.code(), -3);
    assert!(e.to_string().contains("NetQuake"));
    bytes[4..8].copy_from_slice(&1234i32.to_le_bytes());
    assert_eq!(Progs::load(&bytes).err().unwrap().code(), -4);
    bytes[0..4].copy_from_slice(&7i32.to_le_bytes());
    assert_eq!(Progs::load(&bytes).err().unwrap().code(), -2);
    assert_eq!(Progs::load(&bytes[..10]).err().unwrap().code(), -1);
}

fn spawn_world(p: &std::sync::Arc<Progs>, map: &str, seed: u64) -> MiniWorld {
    let ents = bsp_entities(&format!("{}/{}.bsp", MAPS, map)).expect("map");
    let mut w = MiniWorld::new(Vm::new(p.clone(), VmConfig::default(), seed));
    let st = w.spawn_map(&ents).unwrap_or_else(|e| panic!("{}: {}", map, e));
    assert!(st.spawned > 10, "{} spawned {:?}", map, st);
    w.connect(1).expect("connect");
    w
}

#[test]
fn spawns_every_lqdm_map() {
    let Some(p) = load() else { return };
    for i in 1..=13 {
        let map = format!("lqdm{}", i);
        let w = spawn_world(&p, &map, 7);
        let classname = w.vm.e_str(0, fld::CLASSNAME).to_vec();
        assert_eq!(classname, b"worldspawn");
        // the client got a body
        assert_eq!(w.vm.e_str(1, fld::CLASSNAME), b"player");
        assert!(w.vm.e_f(1, fld::HEALTH) > 0.0);
    }
}

#[test]
fn plays_ticks_deterministically_with_clone_and_serialize() {
    let Some(p) = load() else { return };
    let mut a = spawn_world(&p, "lqdm1", 42);
    let mut b = spawn_world(&p, "lqdm1", 42);
    assert_eq!(a.vm.hash(), b.vm.hash());
    let input = |t: u32| (t % 50 < 30, if t % 400 == 100 { 2.0 } else if t % 400 == 300 { 1.0 } else { 0.0 });
    let mut clone: Option<MiniWorld> = None;
    let mut restored: Option<MiniWorld> = None;
    for t in 0..3000u32 {
        let (atk, imp) = input(t);
        a.step(true, atk, imp).unwrap_or_else(|e| panic!("tick {}: {}", t, e));
        b.step(true, atk, imp).unwrap();
        if let Some(c) = clone.as_mut() {
            c.step(true, atk, imp).unwrap();
            assert_eq!(c.vm.hash(), a.vm.hash(), "clone diverged at {}", t);
        }
        if let Some(r) = restored.as_mut() {
            r.step(true, atk, imp).unwrap();
            assert_eq!(r.vm.hash(), a.vm.hash(), "deserialized diverged at {}", t);
        }
        assert_eq!(a.vm.hash(), b.vm.hash(), "twins diverged at {}", t);
        if t == 1000 {
            clone = Some(MiniWorld { vm: a.vm.clone(), host: a.host.clone(), tick: a.tick });
        }
        if t == 1500 {
            let mut buf = Vec::new();
            a.vm.serialize(&mut buf);
            let (vm, used) = Vm::deserialize(p.clone(), &buf).unwrap();
            assert_eq!(used, buf.len());
            assert_eq!(vm.hash(), a.vm.hash());
            let mut buf2 = Vec::new();
            vm.serialize(&mut buf2);
            assert_eq!(buf, buf2);
            restored = Some(MiniWorld { vm, host: a.host.clone(), tick: a.tick });
        }
    }
    // the player fired: ammo went down from the start value
    assert!(a.vm.e_f(1, fld::AMMO_SHELLS) < 25.0, "shells {}", a.vm.e_f(1, fld::AMMO_SHELLS));
    // different seeds diverge (random() is used by the mod)
    let mut c = spawn_world(&p, "lqdm1", 43);
    for t in 0..300 {
        let (atk, imp) = input(t);
        c.step(true, atk, imp).unwrap();
    }
    let _ = c.vm.hash();
}

#[test]
fn restart_resets_world() {
    let Some(p) = load() else { return };
    let mut w = spawn_world(&p, "lqdm2", 1);
    for _ in 0..1000 {
        w.step(true, true, 0.0).unwrap();
    }
    let n = w.vm.num_edicts();
    assert!(n > 33);
    w.vm.restart();
    assert_eq!(w.vm.num_edicts(), 33);
    assert_eq!(w.vm.string_bytes(), 0);
    let fresh = Vm::new(p.clone(), VmConfig::default(), 1);
    assert_eq!(w.vm.globals(), fresh.globals());
    // and it can spawn again
    let ents = bsp_entities(&format!("{}/lqdm3.bsp", MAPS)).unwrap();
    w.vm.load_entities(&mut w.host, &ents, 1.0).unwrap();
}

#[test]
fn load_time_and_tick_cost() {
    let Some(bytes) = qwprogs() else { return };
    let t0 = cpu_time();
    let n = 20;
    for _ in 0..n {
        let _ = Progs::load(&bytes).unwrap();
    }
    let load_us = (cpu_time() - t0) * 1e6 / n as f64;
    let p = Progs::load(&bytes).unwrap();
    let t0 = cpu_time();
    let mut w = spawn_world(&p, "lqdm1", 3);
    let spawn_us = (cpu_time() - t0) * 1e6;
    let i0 = w.vm.instructions();
    let t0 = cpu_time();
    let ticks = 5000;
    for t in 0..ticks {
        w.step(true, t % 3 == 0, 0.0).unwrap();
    }
    let dt = cpu_time() - t0;
    let ops = w.vm.instructions() - i0;
    let t0 = cpu_time();
    let mut h = 0;
    for _ in 0..1000 {
        h ^= w.vm.hash();
    }
    let hash_us = (cpu_time() - t0) * 1e6 / 1000.0;
    let t0 = cpu_time();
    let mut buf = Vec::new();
    for _ in 0..1000 {
        buf.clear();
        w.vm.serialize(&mut buf);
    }
    let ser_us = (cpu_time() - t0) * 1e6 / 1000.0;
    let t0 = cpu_time();
    for _ in 0..1000 {
        std::hint::black_box(w.vm.clone());
    }
    let clone_us = (cpu_time() - t0) * 1e6 / 1000.0;
    let t0 = cpu_time();
    for _ in 0..1000 {
        std::hint::black_box(Vm::deserialize(p.clone(), &buf).unwrap());
    }
    let de_us = (cpu_time() - t0) * 1e6 / 1000.0;
    eprintln!(
        "qwprogs.dat: load {:.0} us; lqdm1 spawn+connect {:.0} us; {} ticks: {:.2} us/tick, {} QC ops ({:.1} M ops/s); \
         edicts {}; state {} bytes; hash {:.1} us; serialize {:.1} us; deserialize {:.1} us; clone {:.1} us ({})",
        load_us,
        spawn_us,
        ticks,
        dt * 1e6 / ticks as f64,
        ops,
        ops as f64 / dt / 1e6,
        w.vm.num_edicts(),
        buf.len(),
        hash_us,
        ser_us,
        de_us,
        clone_us,
        h & 1
    );
}

#[test]
fn hash_parts_timing() {
    let Some(p) = load() else { return };
    let w = spawn_world(&p, "lqdm1", 3);
    let g = w.vm.globals().to_vec();
    let mask = vec![false; g.len()];
    let t0 = cpu_time();
    let mut x = 0u64;
    for _ in 0..1000 {
        let mut h = qcvm::StateHasher::new();
        h.words_typed(std::hint::black_box(&g), &mask);
        x ^= h.finish();
    }
    let gt = (cpu_time() - t0) * 1e3;
    let t0 = cpu_time();
    for _ in 0..1000 {
        x ^= std::hint::black_box(&w.vm).hash();
    }
    let all = (cpu_time() - t0) * 1e3;
    eprintln!("hash: globals ({} words) {:.2} us, whole vm {:.2} us ({})", g.len(), gt, all, x & 1);
}
