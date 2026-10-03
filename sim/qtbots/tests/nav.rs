// Quake Town - qtbots: navigation graph tests on the LibreQuake DM maps.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later

mod kit;
use kit::*;
use qtbots::{BotWorld, NavGraph};

#[test]
fn graph_builds_for_all_lqdm_maps() {
    if !std::path::Path::new(&map_path(1)).exists() {
        return;
    }
    let mut total_nodes = 0;
    for i in 1..=13 {
        let mut w = TestWorld::load(&map_path(i), 4, 1);
        let t0 = cpu_time();
        let g = NavGraph::build(&mut w);
        let dt = cpu_time() - t0;
        let st = g.stats();
        total_nodes += st.nodes;
        // spawn connectivity: every spawn reaches most other spawns
        let spawns: Vec<u32> = g.goals.iter().filter(|g| g.kind == qtbots::GoalKind::Spawn).map(|g| g.node).collect();
        let mut ok = 0;
        let mut pairs = 0;
        for (a, &sa) in spawns.iter().enumerate() {
            for (b, &sb) in spawns.iter().enumerate() {
                if a == b {
                    continue;
                }
                pairs += 1;
                let gi = g.goals.iter().position(|x| x.node == sb && x.kind == qtbots::GoalKind::Spawn).unwrap();
                if g.goal_dist(gi, sa).is_some() {
                    ok += 1;
                }
            }
        }
        let reach = if spawns.is_empty() { 0 } else { g.reachable_count(spawns[0]) };
        eprintln!(
            "lqdm{:<2} nodes {:5} links {:6} (walk {} jump {} drop {} tele {} plat {} push {}) goals {:3} traces {:7} build {:6.1} ms | spawns {} pairs connected {}/{} | reach from spawn0 {}",
            i, st.nodes, st.links, st.walk, st.jump, st.drop, st.teleport, st.plat, st.push, st.goals, st.build_traces, dt * 1e3,
            spawns.len(), ok, pairs, reach
        );
        assert!(st.nodes > 200, "lqdm{} has too few nodes", i);
        assert!(spawns.len() >= 2, "lqdm{} spawns", i);
        assert!(ok * 10 >= pairs * 8, "lqdm{}: only {}/{} spawn pairs connected", i, ok, pairs);
        let _ = w.time();
    }
    eprintln!("total nodes {}", total_nodes);
}
