// Quake Town - qtbots: bots driving QW pmove on the LibreQuake DM maps.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later

mod kit;
use kit::*;
use qtbots::{BotWorld, Bots, NavGraph};

fn have_maps() -> bool {
    std::path::Path::new(&map_path(1)).exists()
}

/// One bot, forced to walk from spawn A to spawn B. Returns seconds taken or None.
fn walk(w: &mut TestWorld, nav: &NavGraph, from: usize, to: usize, max_s: f32) -> Option<f32> {
    let mut bots = Bots::new(w.maxclients);
    bots.add(0, 3);
    w.players[0] = Default::default();
    w.spawn_player(0);
    let a = w.ents[w.spawns[from]].origin;
    w.set_spawn_point(0, [a[0], a[1], a[2] + 1.0]);
    let b = w.ents[w.spawns[to]].origin;
    bots.force_goal(0, Some(b));
    let t0 = w.time;
    let ticks = (max_s / 0.013) as u32;
    for _ in 0..ticks {
        bots.begin_tick();
        let cmd = bots.think(w, nav, 0);
        w.players[0].cmd = cmd;
        w.tick();
        let o = w.players[0].pm.origin;
        if qtbots::math::dist(o, b) < 48.0 {
            return Some((w.time - t0) as f32);
        }
    }
    None
}

#[test]
fn bots_walk_between_spawn_points() {
    if !have_maps() {
        return;
    }
    let mut total = 0;
    let mut ok = 0;
    for m in 1..=13 {
        let mut w = TestWorld::load(&map_path(m), 2, 7);
        w.combat = false;
        let nav = NavGraph::build(&mut w);
        let n = w.spawns.len();
        let mut times = Vec::new();
        let mut fails = Vec::new();
        for k in 0..4 {
            let (a, b) = (k % n, (k * 3 + 2) % n);
            if a == b {
                continue;
            }
            total += 1;
            match walk(&mut w, &nav, a, b, 40.0) {
                Some(t) => {
                    ok += 1;
                    times.push(t);
                }
                None => fails.push((a, b, w.players[0].pm.origin)),
            }
        }
        eprintln!("lqdm{:<2} reached {}/{} times {:?} fails {:?} max speed {:.0}", m, times.len(), times.len() + fails.len(), times, fails, w.players[0].max_speed);
    }
    eprintln!("spawn-to-spawn walks: {}/{}", ok, total);
    assert!(ok * 10 >= total * 8, "only {}/{} walks arrived", ok, total);
}

/// 8 bots fighting on a map: twin worlds agree tick by tick, a serialize/deserialize
/// mid-match continues identically, and the think cost is measured.
fn match_run(m: u32, ticks: u32, seed: u64, restore_at: Option<u32>) -> (Vec<u64>, f64, TestWorld) {
    let mut w = TestWorld::load(&map_path(m), 8, seed);
    let nav = NavGraph::build(&mut w);
    let mut bots = Bots::new(8);
    for s in 0..8 {
        bots.add(s, 1 + (s % 5) as u8);
        w.spawn_player(s as usize);
    }
    let mut hashes = Vec::new();
    let mut cpu = 0.0;
    for t in 0..ticks {
        if restore_at == Some(t) {
            let mut buf = Vec::new();
            bots.serialize(&mut buf);
            let (b2, used) = Bots::deserialize(&buf).unwrap();
            assert_eq!(used, buf.len());
            assert_eq!(b2.hash(), bots.hash());
            bots = b2;
        }
        bots.begin_tick();
        let t0 = cpu_time();
        for s in 0..8 {
            let cmd = bots.think(&mut w, &nav, s);
            w.players[s as usize].cmd = cmd;
        }
        cpu += cpu_time() - t0;
        w.tick();
        let mut h = bots.hash();
        for p in &w.players {
            h = h.rotate_left(7) ^ p.pm.origin[0].to_bits() as u64 ^ (p.pm.origin[1].to_bits() as u64) << 32;
        }
        hashes.push(h);
    }
    (hashes, cpu, w)
}

#[test]
fn bots_fight_deterministically_and_cheaply() {
    if !have_maps() {
        return;
    }
    let ticks = 6000;
    for m in [1u32, 3, 6] {
        let (a, cpu, w) = match_run(m, ticks, 11, None);
        let (b, _, _) = match_run(m, ticks, 11, Some(3000));
        for t in 0..ticks as usize {
            assert_eq!(a[t], b[t], "lqdm{} diverged at tick {}", m, t);
        }
        let frags: i32 = w.players.iter().map(|p| p.frags).sum();
        let pickups: u32 = w.players.iter().map(|p| p.pickups).sum();
        let shots: u32 = w.players.iter().map(|p| p.shots).sum();
        let hits: u32 = w.players.iter().map(|p| p.hits).sum();
        let maxs = w.players.iter().map(|p| p.max_speed).fold(0.0, f32::max);
        let us = cpu * 1e6 / (ticks as f64 * 8.0);
        eprintln!(
            "lqdm{}: 8 bots x {} ticks: {:.1} us/bot/tick, frags {} pickups {} shots {} hits {} ({:.0}%), max speed {:.0}",
            m, ticks, us, frags, pickups, shots, hits, 100.0 * hits as f64 / shots.max(1) as f64, maxs
        );
        assert!(frags > 5, "bots should kill each other");
        assert!(pickups > 20, "bots should pick up items");
        assert!(us < 30.0, "bot think too slow: {:.1} us", us);
    }
}
