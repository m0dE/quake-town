//! pmove regression tests (DESIGN.md "pmove"), against flat test BSPs built in code.
//! Numbers measured from the port are pinned; public QW numbers are asserted.

use qtsim::bsp::Map;
use qtsim::mathlib::*;
use qtsim::pmove::*;
use qtsim::testmap::*;

const MSEC: u8 = 13;

/// The player state that persists between ticks (what SV_RunCmd copies in/out).
#[derive(Clone, Copy, Debug)]
struct Player {
    origin: Vec3,
    velocity: Vec3,
    oldbuttons: i32,
    waterjumptime: f32,
    onground: bool,
    ticks: u32,
}

fn ang16(deg: f64) -> f32 {
    // QW usercmd angles travel as ANGLE2SHORT shorts
    let s = ((deg * 65536.0 / 360.0).round() as i64 & 0xffff) as u16 as i16;
    (s as f64 * (360.0 / 65536.0)) as f32
}

fn step(map: &Map, p: &mut Player, yaw: f64, fwd: i16, side: i16, jump: bool) {
    let physents = [PhysEnt { origin: [0.0; 3], model: 0, mins: [0.0; 3], maxs: [0.0; 3], info: 0 }];
    let mut pm = PlayerMove::new(map, &physents);
    pm.origin = p.origin;
    pm.velocity = p.velocity;
    pm.oldbuttons = p.oldbuttons;
    pm.waterjumptime = p.waterjumptime;
    let a = [0.0, ang16(yaw), 0.0];
    pm.angles = a;
    pm.cmd = UserCmd { msec: MSEC, angles: a, forwardmove: fwd, sidemove: side, upmove: 0, buttons: if jump { 2 } else { 0 }, impulse: 0 };
    pm.player_move();
    p.origin = pm.origin;
    p.velocity = pm.velocity;
    p.oldbuttons = pm.oldbuttons;
    p.waterjumptime = pm.waterjumptime;
    p.onground = pm.onground != -1;
    p.ticks += 1;
}

fn hspeed(v: &Vec3) -> f64 {
    ((v[0] as f64).powi(2) + (v[1] as f64).powi(2)).sqrt()
}

fn vel_yaw(v: &Vec3) -> f64 {
    libm::atan2(v[1] as f64, v[0] as f64).to_degrees()
}

fn flat_map() -> Map {
    let bsp = build_bsp(
        &[bx([-8192.0, -8192.0, -64.0], [8192.0, 8192.0, 0.0])],
        [-8192.0, -8192.0, -64.0],
        [8192.0, 8192.0, 1024.0],
        "{\n\"classname\" \"worldspawn\"\n}\n",
    );
    Map::load("flat", &bsp).unwrap()
}

/// floor for x < 0, a pit, and floor again from x = gap
fn gap_map(gap: f32) -> Map {
    let bsp = build_bsp(
        &[
            bx([-8192.0, -4096.0, -64.0], [0.0, 4096.0, 0.0]),
            bx([gap, -4096.0, -64.0], [8192.0, 4096.0, 0.0]),
            bx([-8192.0, -4096.0, -1100.0], [8192.0, 4096.0, -1024.0]),
        ],
        [-8192.0, -4096.0, -1100.0],
        [8192.0, 4096.0, 1024.0],
        "{\n\"classname\" \"worldspawn\"\n}\n",
    );
    Map::load("gap", &bsp).unwrap()
}

fn spawn() -> Player {
    Player { origin: [0.0, 0.0, 24.0], velocity: [0.0; 3], oldbuttons: 0, waterjumptime: 0.0, onground: false, ticks: 0 }
}

/// let the player settle onto the floor
fn settle(map: &Map, p: &mut Player) {
    for _ in 0..10 {
        step(map, p, 0.0, 0, 0, false);
    }
    assert!(p.onground);
}

#[test]
fn ground_max_speed_320() {
    let map = flat_map();
    let mut p = spawn();
    settle(&map, &mut p);
    let mut max = 0.0f64;
    for _ in 0..300 {
        step(&map, &mut p, 0.0, 400, 0, false);
        max = max.max(hspeed(&p.velocity));
    }
    let s = hspeed(&p.velocity);
    println!("ground speed after 300 ticks: {s:.4} (max {max:.4})");
    assert!((s - 320.0).abs() < 0.01, "ground speed {s}");
    assert!(max < 320.01);
    // +speed (800) is capped by maxspeed too
    for _ in 0..100 {
        step(&map, &mut p, 0.0, 800, 0, false);
    }
    assert!((hspeed(&p.velocity) - 320.0).abs() < 0.01);
    // stops: friction brings a running player to rest
    let mut t = 0;
    while hspeed(&p.velocity) > 0.0 {
        step(&map, &mut p, 0.0, 0, 0, false);
        t += 1;
        assert!(t < 200);
    }
    println!("stopped from 320 in {t} ticks");
}

#[test]
fn jump_apex() {
    let map = flat_map();
    let mut p = spawn();
    settle(&map, &mut p);
    let z0 = p.origin[2];
    let mut apex = z0;
    let mut air = 0;
    step(&map, &mut p, 0.0, 0, 0, true);
    assert!(!p.onground);
    while !p.onground {
        apex = apex.max(p.origin[2]);
        step(&map, &mut p, 0.0, 0, 0, true);
        air += 1;
        assert!(air < 200);
    }
    let h = apex - z0;
    println!("jump apex {h:.4} units, {air} ticks in the air (z0 {z0})");
    // continuous limit 270^2/1600 = 45.5625; QW's integration at msec 13 gives
    // sum_{k=1..25} (270 - 10.4k) * 0.013 = 43.81
    assert!((h - 43.81).abs() < 0.02, "apex {h}");
    // holding jump does not re-jump
    for _ in 0..30 {
        step(&map, &mut p, 0.0, 0, 0, true);
        assert!(p.onground);
    }
}

/// optimal air strafe: wishdir perpendicular to the velocity (QW air accel caps the
/// wish speed at 30 while accelspeed is accelerate*320*0.013 = 41.6, so d = v.w = 0 is
/// optimal). forward+right strafe puts wishdir at yaw-45, so yaw = velyaw + 90 - 45 when
/// turning left with forward+left, yaw = velyaw - 90 + 45 with forward+right.
fn air_strafe_cmd(v: &Vec3, right: bool) -> (f64, i16, i16) {
    let vy = vel_yaw(v);
    if right {
        (vy - 45.0, 400, 400)
    } else {
        (vy + 45.0, 400, -400)
    }
}

#[test]
fn bunny_hop_gains_speed() {
    let map = flat_map();
    let mut p = spawn();
    settle(&map, &mut p);
    // run up to 320
    for _ in 0..100 {
        step(&map, &mut p, 0.0, 400, 0, false);
    }
    let mut hop_speeds = Vec::new();
    let mut hops = 0;
    let mut jump = true;
    let mut right = true;
    let mut ground_ticks = 0;
    while hops < 10 {
        let (yaw, f, s) = if p.onground { (vel_yaw(&p.velocity), 400, 0) } else { air_strafe_cmd(&p.velocity, right) };
        let (prev_vz, prev_ground) = (p.velocity[2], p.onground);
        step(&map, &mut p, yaw, f, s, jump);
        if p.onground {
            ground_ticks += 1;
        }
        let jumped = !p.onground && p.velocity[2] > 200.0 && (prev_ground || prev_vz <= 0.0);
        if jumped {
            hops += 1;
            hop_speeds.push(hspeed(&p.velocity));
            right = !right;
            jump = false; // release for one tick, then hold it for the landing
        } else {
            jump = true;
        }
        assert!(p.ticks < 5000);
    }
    println!("bunny hop speeds at takeoff: {:?}", hop_speeds.iter().map(|s| (s * 10.0).round() / 10.0).collect::<Vec<_>>());
    println!("ground ticks during hops: {ground_ticks}");
    for w in hop_speeds.windows(2) {
        assert!(w[1] > w[0], "every hop gains speed: {hop_speeds:?}");
    }
    let s10 = *hop_speeds.last().unwrap();
    println!("speed after 10 hops: {s10:.3}");
    assert!((s10 - PINNED_BHOP_10).abs() < 0.05, "pinned bunny hop speed changed: {s10}");
}

const PINNED_BHOP_10: f64 = 712.3204;

/// Runs along +x at 320 and jumps when the box is at the edge (x = 15). In the air:
/// straight (no strafe) or bang-bang optimal strafe keeping the heading near +x.
/// Returns the x position where the player comes back down to the takeoff height.
fn jump_distance(map: &Map, strafe: bool) -> (f64, f64) {
    let mut p = spawn();
    p.origin = [-1500.0, 0.0, 24.0];
    settle(map, &mut p);
    while p.origin[0] < 15.0 - 320.0 * 0.013 {
        step(map, &mut p, 0.0, 400, 0, false);
    }
    let x0 = p.origin[0] as f64;
    let z0 = p.origin[2];
    step(map, &mut p, 0.0, 400, 0, true);
    assert!(!p.onground);
    let mut t = 0;
    loop {
        let (yaw, f, s) = if strafe {
            let right = p.velocity[1] > 0.0; // turned left: strafe right
            air_strafe_cmd(&p.velocity, right)
        } else {
            (0.0, 400, 0)
        };
        let prev = p;
        step(map, &mut p, yaw, f, s, false);
        t += 1;
        if p.origin[2] <= z0 + 0.1 && p.velocity[2] <= 0.0 || p.onground {
            let _ = prev;
            return (p.origin[0] as f64 - x0, hspeed(&p.velocity));
        }
        assert!(t < 400);
    }
}

#[test]
fn strafe_jump_crosses_gap_straight_jump_cannot() {
    let flat = flat_map();
    let (d_straight, v_straight) = jump_distance(&flat, false);
    let (d_strafe, v_strafe) = jump_distance(&flat, true);
    println!("jump distance: straight {d_straight:.2} (land speed {v_straight:.1}), strafe {d_strafe:.2} (land speed {v_strafe:.1})");
    assert!(d_strafe > d_straight + 10.0);
    // the gap the box must clear: jump at x0 (box edge at x0+16), land with box edge at
    // the far side (centre at gap-16): the reachable gap is distance + 32 minus a bit
    let gap = ((d_straight + d_strafe) * 0.5 + 32.0 - 0.0) as f32;
    let map = gap_map(gap);
    let land = |strafe: bool| -> bool {
        let mut p = spawn();
        p.origin = [-1500.0, 0.0, 24.0];
        settle(&map, &mut p);
        while p.origin[0] < 15.0 - 320.0 * 0.013 {
            step(&map, &mut p, 0.0, 400, 0, false);
        }
        step(&map, &mut p, 0.0, 400, 0, true);
        for _ in 0..200 {
            let (yaw, f, s) = if strafe && !p.onground {
                air_strafe_cmd(&p.velocity, p.velocity[1] > 0.0)
            } else {
                (0.0, 400, 0)
            };
            step(&map, &mut p, yaw, f, s, false);
        }
        p.origin[2] > 0.0
    };
    let straight_ok = land(false);
    let strafe_ok = land(true);
    println!("gap {gap:.1}: straight lands {straight_ok}, strafe lands {strafe_ok}");
    assert!(!straight_ok && strafe_ok);
}

#[test]
fn circle_jump_start_speed() {
    let map = flat_map();
    // plain: run straight to 320 and jump
    let mut p = spawn();
    settle(&map, &mut p);
    for _ in 0..100 {
        step(&map, &mut p, 0.0, 400, 0, false);
    }
    step(&map, &mut p, 0.0, 400, 0, true);
    let plain = hspeed(&p.velocity);
    // circle jump: from rest, forward+right with the view turning so that the wish
    // direction leads the velocity by the optimal ground angle, then jump
    let mut p = spawn();
    settle(&map, &mut p);
    let mut ticks = 0;
    let mut speeds = Vec::new();
    for _ in 0..25 {
        let v = hspeed(&p.velocity);
        let lead = if v > 278.4 { (278.4 / v).acos().to_degrees() } else { 0.0 };
        // wishdir (fwd+right) is yaw-45; we want wishdir = velyaw - lead (turning right)
        let vy = if v > 0.0 { vel_yaw(&p.velocity) } else { 0.0 };
        step(&map, &mut p, vy - lead + 45.0, 400, 400, false);
        ticks += 1;
        speeds.push(hspeed(&p.velocity));
    }
    let v = hspeed(&p.velocity);
    let lead = if v > 278.4 { (278.4 / v).acos().to_degrees() } else { 0.0 };
    let vy = vel_yaw(&p.velocity);
    step(&map, &mut p, vy - lead + 45.0, 400, 400, true);
    let circle = hspeed(&p.velocity);
    println!("takeoff speed: straight {plain:.3}, circle jump {circle:.3} after {ticks} ground ticks");
    assert!((plain - 320.0).abs() < 0.01);
    assert!(circle > plain + 5.0);
    assert!((circle - PINNED_CIRCLE).abs() < 0.05, "pinned circle jump speed changed: {circle}");
}

const PINNED_CIRCLE: f64 = 456.1422;

#[test]
fn bsp2_loads_the_same_hulls() {
    let bsp = build_bsp(
        &[bx([-512.0, -512.0, -64.0], [512.0, 512.0, 0.0]), bx([100.0, -50.0, 0.0], [150.0, 50.0, 40.0])],
        [-512.0, -512.0, -64.0],
        [512.0, 512.0, 512.0],
        "{\n\"classname\" \"worldspawn\"\n}\n",
    );
    let a = Map::load("a", &bsp).unwrap();
    let b = Map::load("b", &bsp29_to_bsp2(&bsp)).unwrap();
    assert!(b.bsp2);
    let mut pa = spawn();
    let mut pb = spawn();
    for t in 0..400 {
        let yaw = (t as f64) * 0.9;
        step(&a, &mut pa, yaw, 400, 0, t % 50 == 0);
        step(&b, &mut pb, yaw, 400, 0, t % 50 == 0);
        assert_eq!(pa.origin, pb.origin);
    }
}
