// Quake Town - qtbots: A* with an expansion budget
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later

use crate::nav::NavGraph;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// Reusable search buffers (not part of the world state: a clone starts empty).
#[derive(Default)]
pub(crate) struct Scratch {
    g: Vec<f32>,
    h: Vec<f32>,
    stamp_h: Vec<u32>,
    came: Vec<u32>,
    stamp: Vec<u32>,
    gen: u32,
    heap: BinaryHeap<Reverse<(u32, u32)>>,
}

impl Clone for Scratch {
    fn clone(&self) -> Self {
        Scratch::default()
    }
}

pub(crate) const NONE: u32 = u32::MAX;

/// Search from `start` to `goal`, expanding at most `budget` nodes. Returns
/// (path without the start node, expansions used). When the budget runs out, the path
/// leads to the expanded node closest to the goal (partial path); deterministic.
pub(crate) fn astar(nav: &NavGraph, s: &mut Scratch, start: u32, goal: u32, budget: u32) -> (Vec<u32>, u32) {
    let n = nav.nodes.len();
    if start as usize >= n || goal as usize >= n {
        return (Vec::new(), 0);
    }
    if s.g.len() != n {
        s.g = vec![0.0; n];
        s.h = vec![0.0; n];
        s.stamp_h = vec![0; n];
        s.came = vec![NONE; n];
        s.stamp = vec![0; n];
        s.gen = 0;
    }
    s.gen = s.gen.wrapping_add(1);
    if s.gen == 0 {
        s.stamp.iter_mut().for_each(|x| *x = 0);
        s.stamp_h.iter_mut().for_each(|x| *x = 0);
        s.gen = 1;
    }
    let gen = s.gen;
    s.heap.clear();
    s.g[start as usize] = 0.0;
    s.came[start as usize] = NONE;
    s.stamp[start as usize] = gen;
    s.h[start as usize] = nav.heuristic(start, goal);
    s.stamp_h[start as usize] = gen;
    let h0 = s.h[start as usize];
    s.heap.push(Reverse((h0.to_bits(), start)));
    let mut best = (h0, start);
    let mut used = 0;
    let mut found = false;
    while let Some(Reverse((key, u))) = s.heap.pop() {
        if (s.g[u as usize] + s.h[u as usize]).to_bits() != key {
            continue; // stale entry
        }
        if u == goal {
            found = true;
            break;
        }
        if used >= budget {
            break;
        }
        used += 1;
        let gu = s.g[u as usize];
        for l in nav.links_of(u) {
            let v = l.to as usize;
            let ng = gu + l.cost;
            if s.stamp[v] != gen || ng < s.g[v] {
                s.stamp[v] = gen;
                s.g[v] = ng;
                s.came[v] = u;
                let h = if s.stamp_h[v] == gen { s.h[v] } else { nav.heuristic(v as u32, goal) };
                s.h[v] = h;
                s.stamp_h[v] = gen;
                if h < best.0 {
                    best = (h, v as u32);
                }
                s.heap.push(Reverse(((ng + h).to_bits(), v as u32)));
            }
        }
    }
    let end = if found { goal } else { best.1 };
    let mut path = Vec::new();
    let mut x = end;
    while x != start && x != NONE && path.len() < 4096 {
        path.push(x);
        x = s.came[x as usize];
    }
    path.reverse();
    (path, used)
}
