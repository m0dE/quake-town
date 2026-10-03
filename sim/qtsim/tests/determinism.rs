//! Determinism (DESIGN.md "Determinism rules"): twins, clones, serialize roundtrips.

use std::sync::Arc;

use qtsim::bsp::Map;
use qtsim::scenario::*;
use qtsim::World;

fn load(map: &str, info: &str, seed: u32) -> World {
    let progs = qtsim::qcvm::Progs::load(&std::fs::read(QW_PROGS).unwrap()).unwrap();
    let m = Map::load(map, &std::fs::read(format!("{LQ_MAPS}/{map}.bsp")).unwrap()).unwrap();
    World::new(progs, vec![Arc::new(m)], 0, seed, info.as_bytes()).unwrap()
}

const INFO: &str = "\\deathmatch\\3\\maxclients\\8\\bots\\1\\timelimit\\3";

#[test]
fn twins_agree_for_20000_ticks() {
    let mut a = load("lqdm6", INFO, 7);
    let mut b = load("lqdm6", INFO, 7);
    assert_eq!(a.hash(), b.hash());
    let mut changes = 0;
    let mut last = 0;
    for t in 1..=20_000 {
        script_tick(&mut a, t);
        script_tick(&mut b, t);
        let (ha, hb) = (a.hash(), b.hash());
        assert_eq!(ha, hb, "twins diverged at tick {t}");
        assert_eq!(a.sv.sink.events, b.sv.sink.events, "events diverged at tick {t}");
        if ha != last {
            changes += 1;
        }
        last = ha;
    }
    assert!(a.sv.error.is_none(), "{:?}", a.sv.error);
    assert_eq!(changes, 20_000, "the hash must change every tick");
    // a different seed is a different game
    let mut c = load("lqdm6", INFO, 8);
    for t in 1..=200 {
        script_tick(&mut c, t);
    }
    let mut d = load("lqdm6", INFO, 7);
    for t in 1..=200 {
        script_tick(&mut d, t);
    }
    assert_ne!(c.hash(), d.hash());
}

#[test]
fn clone_at_5000_agrees_for_5000() {
    let mut a = load("lqdm3", INFO, 3);
    for t in 1..=5000 {
        script_tick(&mut a, t);
    }
    let mut b = a.clone();
    assert_eq!(a.hash(), b.hash());
    for t in 5001..=10_000 {
        script_tick(&mut a, t);
        script_tick(&mut b, t);
        assert_eq!(a.hash(), b.hash(), "clone diverged at tick {t}");
    }
}

#[test]
fn serialize_roundtrip_at_random_ticks() {
    let progs = qtsim::qcvm::Progs::load(&std::fs::read(QW_PROGS).unwrap()).unwrap();
    let m = Arc::new(Map::load("lqdm2", &std::fs::read(format!("{LQ_MAPS}/lqdm2.bsp")).unwrap()).unwrap());
    let mut a = World::new(progs.clone(), vec![m.clone()], 0, 11, INFO.as_bytes()).unwrap();
    let mut buf = Vec::new();
    let mut rng = 0x1234_5678u32;
    let mut next_check = 1;
    let mut sizes = Vec::new();
    for t in 1..=8000 {
        script_tick(&mut a, t);
        if t == next_check {
            a.serialize_into(&mut buf);
            sizes.push(buf.len());
            let mut b = World::deserialize(progs.clone(), vec![m.clone()], &buf).expect("deserialize");
            assert_eq!(a.hash(), b.hash(), "hash after roundtrip at {t}");
            let mut buf2 = Vec::new();
            b.serialize_into(&mut buf2);
            assert_eq!(buf, buf2, "re-serialize differs at {t}");
            let mut c = a.clone();
            for k in 1..=300 {
                script_tick(&mut b, t + k);
                script_tick(&mut c, t + k);
                assert_eq!(c.hash(), b.hash(), "deserialized world diverged at {} (snapshot {t})", t + k);
            }
            rng ^= rng << 13;
            rng ^= rng >> 17;
            rng ^= rng << 5;
            next_check = t + 1 + rng % 1500;
        }
    }
    println!("snapshot sizes: {sizes:?}");
    // bad data is refused, never a panic
    a.serialize_into(&mut buf);
    for cut in [0, 3, 8, 100, buf.len() / 2, buf.len() - 1] {
        assert!(World::deserialize(progs.clone(), vec![m.clone()], &buf[..cut]).is_err());
    }
    let mut x = 1u32;
    for _ in 0..200 {
        let mut bad = buf.clone();
        for _ in 0..4 {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            let i = x as usize % bad.len();
            bad[i] ^= (x >> 8) as u8 | 1;
        }
        if let Ok(mut w) = World::deserialize(progs.clone(), vec![m.clone()], &bad) {
            for t in 0..50 {
                script_tick(&mut w, 9000 + t);
            }
        }
    }
}
