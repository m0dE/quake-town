// Read-only views of a world for the client: EntView, ClientView, ClientRow and the
// name lists (DESIGN.md "The wasm ABI").
// Copyright (C) 2026 Quake Town authors. GPL-2.0-or-later.

use qcvm::defs::fld;

use crate::mathlib::canon;
use crate::world::*;

pub const ENTVIEW_WORDS: usize = 20;
pub const CLIENTVIEW_WORDS: usize = 64;
pub const CLIENTROW_WORDS: usize = 32;
/// static entities (makestatic) are appended to the EntView list with num = this + i
pub const STATIC_NUM_BASE: u32 = 0x10000;

/// QW CRC_Block (crc.c, CCITT, init 0xffff)
pub fn crc_block(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xffff;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

fn names_blob(names: &[Vec<u8>], out: &mut Vec<u8>) {
    out.clear();
    for n in names {
        out.extend(n.iter().copied().filter(|&c| c != 0));
        out.push(0);
    }
    out.push(0);
}

impl World {
    /// u32 count, then count × EntView
    pub fn view_ents(&self, out: &mut Vec<u32>) {
        let (vm, sv) = (&self.vm, &self.sv);
        out.clear();
        out.push(0);
        let mut count = 0u32;
        for e in 1..vm.num_edicts() {
            if vm.is_free(e) {
                continue;
            }
            let modelindex = vm.e_f(e, fld::MODELINDEX) as i32;
            if sv.is_client(e) {
                if !sv.clients[e as usize - 1].spawned {
                    continue;
                }
            } else if modelindex == 0 || vm.e_str(e, fld::MODEL).is_empty() {
                // sv_ents.c: SV_WritePacketEntities skips !modelindex || !*model
                continue;
            }
            let flags = vm.e_f(e, fld::FLAGS) as i32;
            let mt = vm.e_f(e, fld::MOVETYPE) as i32;
            let solid = vm.e_f(e, fld::SOLID) as i32;
            let o = vm.e_v(e, fld::ORIGIN);
            let a = vm.e_v(e, fld::ANGLES);
            let v = vm.e_v(e, fld::VELOCITY);
            let alpha = sv.ext.alpha.map(|ofs| vm.e_f(e, ofs)).filter(|&x| x != 0.0).unwrap_or(1.0);
            let colormap = if sv.is_client(e) { e as i32 } else { vm.e_f(e, fld::COLORMAP) as i32 };
            out.extend_from_slice(&[
                e,
                vm.serial(e),
                modelindex as u32,
                vm.e_f(e, fld::FRAME) as i32 as u32,
                vm.e_f(e, fld::SKIN) as i32 as u32,
                colormap as u32,
                vm.e_f(e, fld::EFFECTS) as i32 as u32,
                ((mt & 0xff) | ((solid & 0xff) << 8) | ((flags & 0xffff) << 16)) as u32,
                canon(o[0]),
                canon(o[1]),
                canon(o[2]),
                canon(a[0]),
                canon(a[1]),
                canon(a[2]),
                canon(v[0]),
                canon(v[1]),
                canon(v[2]),
                vm.e_e(e, fld::OWNER),
                canon(alpha),
                0,
            ]);
            count += 1;
        }
        for (i, s) in sv.statics.iter().enumerate() {
            out.extend_from_slice(&[
                STATIC_NUM_BASE + i as u32,
                0,
                s.modelindex as u32,
                s.frame as u32,
                s.skin as u32,
                s.colormap as u32,
                0,
                0,
                canon(s.origin[0]),
                canon(s.origin[1]),
                canon(s.origin[2]),
                canon(s.angles[0]),
                canon(s.angles[1]),
                canon(s.angles[2]),
                0,
                0,
                0,
                0,
                canon(1.0),
                0,
            ]);
            count += 1;
        }
        out[0] = count;
    }

    /// ClientView (64 words)
    pub fn view_client(&self, slot: usize, out: &mut Vec<u32>) {
        out.clear();
        out.resize(CLIENTVIEW_WORDS, 0);
        let (vm, sv) = (&self.vm, &self.sv);
        if slot >= sv.maxclients {
            return;
        }
        let c = &sv.clients[slot];
        let e = Server::slot_edict(slot);
        let f = |o: u32| vm.e_f(e, o);
        let fi = |o: u32| vm.e_f(e, o) as i32 as u32;
        out[0] = slot as u32;
        out[1] = e;
        out[2] = c.state as u32;
        if !c.spawned {
            return;
        }
        let v3 = |out: &mut Vec<u32>, at: usize, v: [f32; 3]| {
            out[at] = canon(v[0]);
            out[at + 1] = canon(v[1]);
            out[at + 2] = canon(v[2]);
        };
        v3(out, 3, vm.e_v(e, fld::ORIGIN));
        v3(out, 6, vm.e_v(e, fld::VELOCITY));
        v3(out, 9, vm.e_v(e, fld::V_ANGLE));
        out[12] = canon(vm.e_v(e, fld::VIEW_OFS)[2]);
        // 13-15 punchangle: QW keeps it client-side (kick events)
        out[16] = ((f(fld::FLAGS) as i32 & FL_ONGROUND) != 0) as u32;
        out[17] = fi(fld::WATERLEVEL);
        out[18] = fi(fld::WATERTYPE);
        out[19] = fi(fld::HEALTH);
        out[20] = fi(fld::ARMORVALUE);
        out[21] = (f(fld::ARMORTYPE) as f64 * 100.0).round() as i32 as u32;
        out[22] = fi(fld::CURRENTAMMO);
        out[23] = fi(fld::AMMO_SHELLS);
        out[24] = fi(fld::AMMO_NAILS);
        out[25] = fi(fld::AMMO_ROCKETS);
        out[26] = fi(fld::AMMO_CELLS);
        out[27] = (f(fld::ITEMS) as i32 | ((sv.serverflags as i32) << 28)) as u32;
        out[28] = fi(fld::WEAPON);
        out[29] = sv.model_index(vm.e_str(e, fld::WEAPONMODEL)).unwrap_or(0) as u32;
        out[30] = fi(fld::WEAPONFRAME);
        out[31] = fi(fld::FRAGS);
        out[32] = fi(fld::DEADFLAG);
        out[33] = fi(fld::EFFECTS);
        if let Some(a) = c.out_fixangle {
            out[34] = 1;
            v3(out, 35, a);
        }
        if let Some((take, save, from)) = c.out_dmg {
            out[38] = take as i32 as u32;
            out[39] = save as i32 as u32;
            v3(out, 40, from);
        }
        out[43] = sv.intermission.is_some() as u32;
        out[44] = 0;
        out[45] = ((c.oldbuttons & 2) != 0) as u32;
        out[46] = canon(f(fld::TELEPORT_TIME));
        out[47] = sv.matchstate.phase as i32 as u32;
        out[48] = canon(sv.matchstate.endtime);
    }

    /// u32 count (= maxclients), then count × ClientRow
    pub fn view_clients(&self, out: &mut Vec<u32>) {
        out.clear();
        let (vm, sv) = (&self.vm, &self.sv);
        out.push(sv.maxclients as u32);
        for (slot, c) in sv.clients.iter().enumerate() {
            let e = Server::slot_edict(slot);
            let mut row = [0u32; CLIENTROW_WORDS];
            row[0] = slot as u32;
            row[1] = c.state as u32;
            row[2] = e;
            if c.state != CS_EMPTY {
                row[3] = vm.e_f(e, fld::FRAGS) as i32 as u32;
                let team = c.userinfo.get(b"team");
                row[4] = if team.is_empty() { 0 } else { crc_block(team) as u32 };
                row[5] = qcvm::atoi(c.userinfo.get(b"topcolor")) as u32;
                row[6] = qcvm::atoi(c.userinfo.get(b"bottomcolor")) as u32;
                for (i, s) in c.stats.iter().enumerate() {
                    row[8 + i] = *s as u32;
                }
            }
            out.extend_from_slice(&row);
        }
    }

    pub fn client_info(&self, slot: usize, out: &mut Vec<u8>) {
        out.clear();
        if let Some(c) = self.sv.clients.get(slot) {
            out.extend_from_slice(&c.userinfo.encode());
        }
        out.push(0);
    }

    pub fn model_names(&self, out: &mut Vec<u8>) {
        names_blob(&self.sv.model_precache, out);
    }

    pub fn sound_names(&self, out: &mut Vec<u8>) {
        names_blob(&self.sv.sound_precache, out);
    }

    pub fn lightstyle_names(&self, out: &mut Vec<u8>) {
        names_blob(&self.sv.lightstyles, out);
    }

    pub fn serverinfo(&self, out: &mut Vec<u8>) {
        out.clear();
        out.extend_from_slice(&self.sv.serverinfo.encode());
        out.push(0);
    }

    /// u32 count, then count × (sound index, volume 0..255, attenuation×64, x, y, z f32)
    pub fn view_ambients(&self, out: &mut Vec<u32>) {
        out.clear();
        out.push(self.sv.ambients.len() as u32);
        for a in &self.sv.ambients {
            out.extend_from_slice(&[a.sound as u32, a.volume as u32, a.atten as u32, canon(a.origin[0]), canon(a.origin[1]), canon(a.origin[2])]);
        }
    }

    /// u32 count, then count × Event (10 words)
    pub fn view_events(&self, out: &mut Vec<u32>) {
        out.clear();
        out.push(self.sv.sink.events.len() as u32);
        for e in &self.sv.sink.events {
            out.extend_from_slice(&e.w);
        }
    }

    pub fn event_strings(&self, out: &mut Vec<u8>) {
        out.clear();
        for s in &self.sv.sink.strings {
            out.extend(s.iter().copied().filter(|&c| c != 0));
            out.push(0);
        }
        out.push(0);
    }
}
