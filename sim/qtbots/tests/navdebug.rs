mod kit;
use kit::*;
use qtbots::NavGraph;

#[test]
#[ignore]
fn debug_components() {
    let m: u32 = std::env::var("MAP").ok().and_then(|x| x.parse().ok()).unwrap_or(4);
    let mut w = TestWorld::load(&map_path(m), 4, 1);
    let g = NavGraph::build(&mut w);
    let spawns: Vec<u32> = g.goals.iter().filter(|g| g.kind == qtbots::GoalKind::Spawn).map(|g| g.node).collect();
    // reachability sets
    let reach = |s: u32| {
        let mut seen = vec![false; g.nodes.len()];
        let mut st = vec![s];
        while let Some(x) = st.pop() {
            if seen[x as usize] { continue; }
            seen[x as usize] = true;
            for l in g.links_of(x) { st.push(l.to); }
        }
        seen
    };
    let r0 = reach(spawns[0]);
    for &s in &spawns {
        let rs = reach(s);
        let n = rs.iter().filter(|&&x| x).count();
        let back = r0[s as usize];
        eprintln!("spawn node {} at {:?}: reaches {} nodes; reachable from spawn0: {}", s, g.nodes[s as usize].pos, n, back);
    }
    // nodes not reachable from spawn0 but reaching it: print the boundary
    let mut shown = 0;
    for (i, n) in g.nodes.iter().enumerate() {
        if r0[i] { continue; }
        // a node of the unreachable set adjacent (any link) into reachable set
        for l in g.links_of(i as u32) {
            if r0[l.to as usize] && shown < 30 {
                eprintln!("  unreachable {} {:?} -> reachable {} {:?} kind {:?}", i, n.pos, l.to, g.nodes[l.to as usize].pos, l.kind);
                shown += 1;
            }
        }
    }
    // candidate climbs: reachable node below an unreachable node within 2 cells, dz 18..80
    let mut cands: Vec<(i32, u32, u32)> = Vec::new();
    for (i, n) in g.nodes.iter().enumerate() {
        if r0[i] { continue; }
        for (j, m) in g.nodes.iter().enumerate() {
            if !r0[j] { continue; }
            let d2 = ((n.pos[0]-m.pos[0]).powi(2) + (n.pos[1]-m.pos[1]).powi(2)).sqrt();
            let dz = n.pos[2] - m.pos[2];
            if d2 <= 46.0 && dz > 0.0 && dz < 100.0 { cands.push((dz as i32, i as u32, j as u32)); }
        }
    }
    cands.sort();
    for c in cands.iter().take(25) { eprintln!("  climb dz {} : {:?} above {:?}", c.0, g.nodes[c.1 as usize].pos, g.nodes[c.2 as usize].pos); }
    for e in &w.ents { if e.classname == b"trigger_teleport" || e.classname == b"info_teleport_destination" || e.classname == b"func_wall" || e.classname == b"trigger_push" {
        eprintln!("{} origin {:?} mins {:?} maxs {:?} movedir {:?} speed {} target {} targetname {}", String::from_utf8_lossy(&e.classname), e.origin, e.mins, e.maxs, e.movedir, e.speed, String::from_utf8_lossy(&e.target), String::from_utf8_lossy(&e.targetname));
    }}
}

#[test]
#[ignore]
fn debug_jump() {
    use qtbots::BotWorld;
    let mut w = TestWorld::load(&map_path(4), 4, 1);
    let p = [-224.0f32, -32.0, -159.96875];
    let mn = [-16.0, -16.0, -24.0];
    let mx = [16.0, 16.0, 32.0];
    let up = w.trace_world(p, mn, mx, [p[0], p[1], p[2] + 46.0]);
    eprintln!("up: frac {} end {:?} ss {}", up.fraction, up.endpos, up.startsolid);
    let lz = up.endpos[2];
    let over = w.trace_world([p[0], p[1], lz], mn, mx, [p[0] + 32.0, p[1], lz]);
    eprintln!("over: frac {} end {:?} n {:?}", over.fraction, over.endpos, over.normal);
    let fw = w.trace_world([p[0], p[1], p[2] + 18.0], mn, mx, [p[0] + 32.0, p[1], p[2] + 18.0]);
    eprintln!("fw18: frac {} end {:?} n {:?}", fw.fraction, fw.endpos, fw.normal);
    for dz in [20.0f32, 30.0, 36.0, 40.0, 44.0] {
        let t = w.trace_world([p[0] + 32.0, p[1], p[2] + 60.0], mn, mx, [p[0] + 32.0, p[1], p[2] - 10.0]);
        eprintln!("floor at +32: {:?} n {:?} (dz {})", t.endpos, t.normal, dz);
        break;
    }
}

#[test]
#[ignore]
fn debug_jump_sim() {
    use qtbots::BotWorld;
    use qtbots::math::*;
    let mut w = TestWorld::load(&map_path(4), 4, 1);
    let p = [-224.0f32, -32.0, -159.96875];
    let d = [1.0f32, 0.0, 0.0];
    let mn = [-16.0, -16.0, -24.0];
    let mx = [16.0, 16.0, 32.0];
    let mut pos = p;
    let mut vel = [d[0] * 300.0, d[1] * 300.0, 270.0];
    let dt = 1.0 / 30.0;
    for i in 0..40 {
        let end = ma(pos, dt, vel);
        let t = w.trace_world(pos, mn, mx, end);
        eprintln!("{} pos {:?} vel {:?} -> frac {} end {:?} n {:?} ss {}", i, pos, vel, t.fraction, t.endpos, t.normal, t.startsolid);
        if t.startsolid { break; }
        pos = t.endpos;
        if t.fraction < 1.0 {
            if t.normal[2] >= 0.7 && vel[2] <= 0.0 { eprintln!("landed"); break; }
            let back = dot(vel, t.normal);
            vel = sub(vel, scale(t.normal, back));
            if len2d(vel) < 50.0 && vel[2] <= 0.0 { eprintln!("stall"); }
        }
        let along = dot(vel, d);
        if along < 30.0 { vel = ma(vel, 30.0 - along, d); }
        vel[2] -= 800.0 * dt;
    }
}

#[test]
#[ignore]
fn debug_profile() {
    use qtbots::BotWorld;
    let mut w = TestWorld::load(&map_path(4), 4, 1);
    let y: f32 = std::env::var("Y").ok().and_then(|x| x.parse().ok()).unwrap_or(-32.0);
    let mut x = -240.0f32;
    while x < -120.0 {
        let t = w.trace_world([x, y, 100.0], [0.0; 3], [0.0; 3], [x, y, -300.0]);
        let tb = w.trace_world([x, y, 100.0], [-16.0, -16.0, -24.0], [16.0, 16.0, 32.0], [x, y, -300.0]);
        eprintln!("x {:6.1} point floor {:8.2} n {:?} | hull1 origin z {:8.2}", x, t.endpos[2], t.normal, tb.endpos[2]);
        x += 4.0;
    }
}

#[test]
#[ignore]
fn debug_walk() {
    use qtbots::Bots;
    let m: u32 = std::env::var("MAP").ok().and_then(|x| x.parse().ok()).unwrap_or(13);
    let bsp = std::env::var("BSP").unwrap_or_else(|_| map_path(m));
    let from: usize = std::env::var("FROM").ok().and_then(|x| x.parse().ok()).unwrap_or(0);
    let to: usize = std::env::var("TO").ok().and_then(|x| x.parse().ok()).unwrap_or(2);
    let mut w = TestWorld::load(&bsp, 2, 7);
    w.combat = false;
    let nav = NavGraph::build(&mut w);
    let mut bots = Bots::new(2);
    bots.add(0, 3);
    w.spawn_player(0);
    let mut a = w.ents[w.spawns[from % w.spawns.len()]].origin;
    let mut b = w.ents[w.spawns[to % w.spawns.len()]].origin;
    if let Ok(v) = std::env::var("A") { let p: Vec<f32> = v.split(',').map(|x| x.parse().unwrap()).collect(); a = [p[0], p[1], p[2]]; }
    if let Ok(v) = std::env::var("B") { let p: Vec<f32> = v.split(',').map(|x| x.parse().unwrap()).collect(); b = [p[0], p[1], p[2]]; }
    w.set_spawn_point(0, [a[0], a[1], a[2] + 1.0]);
    eprintln!("from {:?} to {:?}", a, b);
    bots.force_goal(0, Some(b));
    for t in 0..3000 {
        bots.begin_tick();
        let cmd = bots.think(&mut w, &nav, 0);
        w.players[0].cmd = cmd;
        w.tick();
        let p = &w.players[0];
        if t % 10 == 0 {
            let d = bots.debug(0).unwrap();
            let cur = nav.node(d.node).map(|n| n.pos);
            let links: Vec<_> = nav.links_of(d.node).iter().map(|l| (l.to, l.kind)).collect();
            eprintln!("t {:4} pos {:?} vel {:?} og {} cur {} {:?} cmd f{} s{} b{} yaw {:.0} lk {:?} | links {:?}", t, p.pm.origin.map(|x| x as i32), p.pm.velocity.map(|x| x as i32), p.pm.onground, d.node, cur.map(|c| c.map(|x| x as i32)), cmd.forward, cmd.side, cmd.buttons, d.yaw, (d.link_kind, d.chase, d.goal), &links[..links.len().min(6)]);
        }
        if qtbots::math::dist(p.pm.origin, b) < 48.0 { eprintln!("arrived at t {}", t); break; }
        if p.pm.origin[2] < -1000.0 { eprintln!("fell"); break; }
    }
}

#[test]
#[ignore]
fn debug_route() {
    let m: u32 = std::env::var("MAP").ok().and_then(|x| x.parse().ok()).unwrap_or(2);
    let from: usize = std::env::var("FROM").ok().and_then(|x| x.parse().ok()).unwrap_or(0);
    let to: usize = std::env::var("TO").ok().and_then(|x| x.parse().ok()).unwrap_or(2);
    let mut w = TestWorld::load(&map_path(m), 2, 7);
    let nav = NavGraph::build(&mut w);
    let a = w.ents[w.spawns[from]].origin;
    let b = w.ents[w.spawns[to]].origin;
    let gi = nav.goals.iter().position(|g| g.kind == qtbots::GoalKind::Spawn && qtbots::math::dist(g.pos, b) < 1.0).unwrap();
    let mut n = nav.nearest(a, 160.0).unwrap();
    eprintln!("goal node {} {:?} dist {:?}", nav.goals[gi].node, nav.goals[gi].pos, nav.goal_dist(gi, n));
    for _ in 0..200 {
        let Some(l) = nav.goal_next(gi, n) else { break };
        eprintln!("  {} {:?} --{:?} c{:.0}--> {} {:?}", n, nav.nodes[n as usize].pos.map(|x| x as i32), l.kind, l.cost, l.to, nav.nodes[l.to as usize].pos.map(|x| x as i32));
        n = l.to;
        if n == nav.goals[gi].node { break; }
    }
}

#[test]
#[ignore]
fn debug_falls() {
    use qtbots::Bots;
    let path = std::env::var("BSP").unwrap();
    let mut w = TestWorld::load(&path, 6, 3);
    let nav = NavGraph::build(&mut w);
    let st = nav.stats();
    eprintln!("graph {:?}", st);
    let minz = nav.nodes.iter().map(|n| n.pos[2]).fold(f32::MAX, f32::min);
    let mut bots = Bots::new(6);
    for s in 0..6 { bots.add(s, 1 + (s % 5) as u8); w.spawn_player(s as usize); }
    let mut falls = 0;
    for _t in 0..23100 {
        bots.begin_tick();
        for s in 0..6 { let c = bots.think(&mut w, &nav, s); w.players[s as usize].cmd = c; }
        w.tick();
        for s in 0..6usize {
            let o = w.players[s].pm.origin;
            let hurt = w.ents.iter().any(|e| e.classname == b"trigger_hurt" && (0..3).all(|k| o[k] + [16.0,16.0,32.0][k] > e.origin[k] + e.mins[k] && o[k] - [16.0,16.0,24.0][k] < e.origin[k] + e.maxs[k]));
            let _ = minz;
            if w.players[s].alive && hurt {
                let d = bots.debug(s as u32).unwrap();
                eprintln!("fall slot {} at t {:.1} pos {:?} node {} {:?} hop {} enemy {}", s, w.time, w.players[s].pm.origin, d.node, nav.node(d.node).map(|n| (n.pos, n.flags)), d.hopping, d.enemy);
                falls += 1;
                w.players[s].alive = false; w.players[s].dead_time = w.time; w.players[s].deaths += 1;
            }
        }
    }
    let frags: i32 = w.players.iter().map(|p| p.frags).sum();
    eprintln!("falls {} frags {}", falls, frags);
}
