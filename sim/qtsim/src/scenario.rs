// The scripted match used by the determinism tests, the bench and tools/sim/test-wasm.mjs
// (which mirrors this file exactly: keep them in sync).
// Copyright (C) 2026 Quake Town authors. GPL-2.0-or-later.

use crate::World;

pub const QW_PROGS: &str = "/app/data/home/quake-ref/Quake/QW/progs/qwprogs.dat";
pub const LQ_MAPS: &str = "/app/data/home/quake-ref/full/id1/maps";

/// The scripted human input for `slot` at tick t (1-based):
/// [pitch16, yaw16, forward, side, up, buttons, impulse]
pub fn script_cmd(t: u32, slot: u32) -> [i32; 7] {
    let t = t.wrapping_add(slot.wrapping_mul(977));
    let pitch16 = ((t.wrapping_mul(37)) % 2000) as i32 - 1000;
    let yaw16 = (t.wrapping_mul(331) & 0xffff) as i32 - 32768;
    let forward = if t % 300 < 200 { 400 } else { -200 };
    let side = (((t / 50) % 3) as i32 - 1) * 350;
    let buttons = (if t % 17 < 3 { 1 } else { 0 }) | (if t % 61 < 2 { 2 } else { 0 });
    let impulse = if t % 500 == 0 { ((t / 500) % 8 + 1) as i32 } else { 0 };
    [pitch16, yaw16, forward, side, 0, buttons, impulse]
}

/// Membership and command events of the scripted match, applied before tick t.
pub fn script_events(w: &mut World, t: u32) {
    match t {
        1 => {
            let s = w.free_slot();
            w.client_join(s as usize, b"\\name\\alice\\topcolor\\4\\bottomcolor\\12\\team\\red");
        }
        1000 => w.set_userinfo(0, b"\\name\\alice2\\topcolor\\3\\bottomcolor\\3\\team\\blue"),
        2000 => {
            let s = w.free_slot();
            w.client_join(s as usize, b"\\name\\bob\\team\\red");
        }
        2500 => w.client_command(0, b"kill"),
        3000 => w.client_leave(1),
        4000 => w.client_idle(0),
        4500 => w.client_join(0, b"\\name\\alice2"),
        _ => {}
    }
}

/// One scripted tick: events, human cmds for occupied human slots, tick.
pub fn script_tick(w: &mut World, t: u32) {
    script_events(w, t);
    for slot in 0..w.sv.maxclients {
        if w.sv.clients[slot].state == crate::world::CS_HUMAN {
            let c = script_cmd(t, slot as u32);
            w.set_cmd(slot, c[0], c[1], c[2], c[3], c[4], c[5], c[6]);
        }
    }
    w.tick();
}
