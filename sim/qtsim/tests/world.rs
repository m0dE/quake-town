//! World tests with id's qwprogs.dat: rocket jump height (combat.qc knockback through
//! the whole engine), smoke runs on every LibreQuake DM map, events and views.

use std::sync::Arc;

use qtsim::bsp::Map;
use qtsim::events::*;
use qtsim::scenario::*;
use qtsim::testmap::*;
use qtsim::World;

fn progs() -> Arc<qtsim::qcvm::Progs> {
    qtsim::qcvm::Progs::load(&std::fs::read(QW_PROGS).unwrap()).unwrap()
}

fn flat_world(info: &str) -> World {
    let ents = "{\n\"classname\" \"worldspawn\"\n}\n{\n\"classname\" \"info_player_start\"\n\"origin\" \"0 0 24\"\n}\n{\n\"classname\" \"info_player_deathmatch\"\n\"origin\" \"0 0 24\"\n}\n";
    let bsp = build_bsp(&[bx([-4096.0, -4096.0, -64.0], [4096.0, 4096.0, 0.0])], [-4096.0, -4096.0, -64.0], [4096.0, 4096.0, 2048.0], ents);
    let m = Map::load("flat", &bsp).unwrap();
    World::new(progs(), vec![Arc::new(m)], 0, 1, info.as_bytes()).unwrap()
}

fn origin(w: &World, slot: usize) -> [f32; 3] {
    let mut v = Vec::new();
    w.view_client(slot, &mut v);
    [f32::from_bits(v[3]), f32::from_bits(v[4]), f32::from_bits(v[5])]
}

/// pitch16 for looking straight down (QW clamps pitch to 80 on the client; 80 here)
const DOWN: i32 = (80.0 * 65536.0 / 360.0) as i32;

#[test]
fn rocket_jump_height() {
    // deathmatch 4: id's progs spawn the player with the rocket launcher (cheats are
    // compiled out of qwprogs)
    let mut w = flat_world("\\deathmatch\\4\\maxclients\\2\\bots\\0");
    w.client_join(0, b"\\name\\rj");
    for _ in 0..30 {
        w.tick();
    }
    w.set_cmd(0, DOWN, 0, 0, 0, 0, 0, 7);
    for _ in 0..80 {
        w.tick();
    }
    let mut v = Vec::new();
    w.view_client(0, &mut v);
    assert_eq!(v[28], 32, "rocket launcher selected (IT_ROCKET_LAUNCHER)");
    let z0 = origin(&w, 0)[2];
    let h0 = v[19] as i32;
    // jump, fire on the next tick (the classic QW rocket jump)
    w.set_cmd(0, DOWN, 0, 0, 0, 0, 2, 0);
    w.tick();
    w.set_cmd(0, DOWN, 0, 0, 0, 0, 3, 0);
    w.tick();
    // the rocket moves 0.05 s at once (SV_RunNewmis) and explodes in the firing tick
    let mut explosion = w.sv.sink.events.iter().any(|e| e.kind() == EV_TEMPENT && e.w[1] as i32 == TE_EXPLOSION);
    w.set_cmd(0, DOWN, 0, 0, 0, 0, 0, 0);
    let mut apex = z0;
    for _ in 0..200 {
        w.tick();
        apex = apex.max(origin(&w, 0)[2]);
        explosion |= w.sv.sink.events.iter().any(|e| e.kind() == EV_TEMPENT && e.w[1] as i32 == TE_EXPLOSION);
    }
    w.view_client(0, &mut v);
    let h = apex - z0;
    println!("rocket jump: apex {h:.3} units above the floor stance, health {h0} -> {}", v[19] as i32);
    assert!(explosion);
    assert!(h > 150.0, "rocket jump too low: {h}");
    assert!((h - PINNED_RJ).abs() < 0.05, "pinned rocket jump height changed: {h}");
}

const PINNED_RJ: f32 = 261.685;

#[test]
fn all_lqdm_maps_run_with_bots() {
    let p = progs();
    for i in 1..=13 {
        let name = format!("lqdm{i}");
        let m = Map::load(&name, &std::fs::read(format!("{LQ_MAPS}/{name}.bsp")).unwrap()).unwrap();
        let mut w = World::new(p.clone(), vec![Arc::new(m)], 0, i, b"\\deathmatch\\3\\maxclients\\8\\bots\\1").unwrap();
        let mut kills = 0;
        let mut sounds = 0;
        let mut ents = Vec::new();
        for t in 1..=3000 {
            script_tick(&mut w, t);
            for e in &w.sv.sink.events {
                match e.kind() {
                    EV_SOUND => sounds += 1,
                    EV_PRINT if e.w[1] as i32 == -1 => kills += 1,
                    _ => {}
                }
            }
            assert!(w.sv.error.is_none(), "{name} stopped at {t}: {:?}", w.sv.error);
        }
        w.view_ents(&mut ents);
        let statics = w.sv.statics.len();
        println!("{name}: edicts {} ents {} statics {} sounds {} bprints {}", w.vm.num_edicts(), ents[0], statics, sounds, kills);
        assert!(sounds > 100 && ents[0] > 10);
    }
}
