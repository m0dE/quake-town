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
