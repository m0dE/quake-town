/*
Copyright (C) 1996-1997 Id Software, Inc.
Copyright (C) 2026 Quake Town authors.

This program is free software; you can redistribute it and/or
modify it under the terms of the GNU General Public License
as published by the Free Software Foundation; either version 2
of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

See the GNU General Public License for more details.
*/
//! Engine builtins: port of QW/server/pr_cmds.c (the ones that need the world; the VM
//! implements the pure ones), the message builtins turned into events, the
//! Quake Town extensions #9000-#9005 and cvar_string #448. Plus the print / sound
//! helpers of sv_send.c.

use qcvm::defs::{fld, glob};
use qcvm::{Ent, Host, Print, Vm, VmError};

use crate::events::*;
use crate::mathlib::*;
use crate::world::*;

const MSG_BROADCAST: i32 = 0;
const MSG_ONE: i32 = 1;
const MSG_ALL: i32 = 2;
const MSG_INIT: i32 = 3;
const MSG_MULTICAST: i32 = 4;

const DAMAGE_AIM: f32 = 2.0;

impl Server {
    // ------------------------------------------------------------------ sv_send.c

    /// SV_BroadcastPrintf
    pub fn broadcast_print(&mut self, level: i32, s: &[u8]) {
        let si = self.sink.string(s);
        self.sink.push(Event::new(EV_PRINT).a(-1).b(level).c(si));
    }

    /// SV_ClientPrintf
    pub fn client_print(&mut self, slot: usize, level: i32, s: &[u8]) {
        let si = self.sink.string(s);
        self.sink.push(Event::new(EV_PRINT).a(slot as i32).b(level).c(si));
    }

    /// SV_StartSound: every client hears every sound (no PHS), the client culls.
    pub fn start_sound(&mut self, vm: &Vm, e: Ent, channel: i32, sample: &[u8], volume: i32, attenuation: f32) {
        let volume = volume.clamp(0, 255);
        let attenuation = if attenuation.is_nan() { 0.0 } else { attenuation.clamp(0.0, 4.0) };
        let channel = channel.clamp(0, 15) & 7;
        let sound_num = match self.sound_index(sample) {
            Some(n) => n,
            None => {
                let msg = format!("SV_StartSound: {} not precacheed\n", String::from_utf8_lossy(sample));
                self.log(&msg);
                return;
            }
        };
        // use the entity origin unless it is a bmodel
        let o = vm.e_v(e, fld::ORIGIN);
        let origin = if Self::solid(vm, e) == SOLID_BSP {
            let (mn, mx) = (vm.e_v(e, fld::MINS), vm.e_v(e, fld::MAXS));
            let mut r = [0.0f32; 3];
            for i in 0..3 {
                r[i] = (o[i] as f64 + 0.5 * (mn[i] + mx[i]) as f64) as f32;
            }
            r
        } else {
            o
        };
        self.sink.push(
            Event::new(EV_SOUND)
                .a(e as i32)
                .b(channel)
                .c(sound_num as i32)
                .d(volume)
                .xyz(origin)
                .e((attenuation as f64 * 64.0) as i32 as u32),
        );
    }

    // ------------------------------------------------------------------ helpers

    fn not_client_slot(&self, e: Ent) -> Option<usize> {
        if self.is_client(e) {
            Some(e as usize - 1)
        } else {
            None
        }
    }

    /// PF_setmodel
    fn pf_setmodel(&mut self, vm: &mut Vm) -> Result<(), VmError> {
        let e = vm.parm_ent(0)?;
        let mh = vm.parm_s(1);
        let m = vm.string(mh).to_vec();
        let i = match self.model_index(&m) {
            Some(i) => i,
            None => return Err(VmError::host(format!("no precache: {}", String::from_utf8_lossy(&m)))),
        };
        vm.set_e_s(e, fld::MODEL, mh);
        vm.set_e_f(e, fld::MODELINDEX, i as f32);

        // if it is an inline model, get the size information for it
        if m.first() == Some(&b'*') {
            let sm = self.model_sub.get(i).copied().unwrap_or(-1);
            if sm >= 0 {
                let sub_m = self.map.models[sm as usize];
                vm.set_e_v(e, fld::MINS, sub_m.mins);
                vm.set_e_v(e, fld::MAXS, sub_m.maxs);
                vm.set_e_v(e, fld::SIZE, sub(&sub_m.maxs, &sub_m.mins));
                self.link_edict(vm, e, false)?;
            }
        }
        Ok(())
    }

    fn precache(&mut self, vm: &mut Vm, sound: bool) -> Result<(), VmError> {
        let h = vm.parm_s(0);
        vm.ret_s(h);
        let s = vm.string(h).to_vec();
        if s.first().map_or(true, |&c| c <= b' ') {
            return Err(VmError::host("Bad string"));
        }
        let list = if sound { &mut self.sound_precache } else { &mut self.model_precache };
        if list.iter().any(|x| *x == s) {
            return Ok(());
        }
        // QW allows precaching only while loading; Quake Town accepts late precaches
        // (the name lists are read per world) so a mod mistake does not stop a room.
        let max = if sound { MAX_SOUNDS } else { MAX_MODELS };
        if list.len() >= max {
            return Err(VmError::host(if sound { "PF_precache_sound: overflow" } else { "PF_precache_model: overflow" }));
        }
        list.push(s);
        if !sound {
            self.update_model_sub();
        }
        Ok(())
    }

    /// PF_traceline
    fn pf_traceline(&mut self, vm: &mut Vm) -> Result<(), VmError> {
        let v1 = vm.parm_v(0);
        let v2 = vm.parm_v(1);
        let nomonsters = vm.parm_f(2) as i32;
        let ent = vm.parm_ent(3)?;
        let trace = self.sv_move(vm, &v1, &VEC3_ORIGIN, &VEC3_ORIGIN, &v2, nomonsters, Some(ent));
        self.set_trace_globals(vm, &trace);
        Ok(())
    }

    pub fn set_trace_globals(&self, vm: &mut Vm, trace: &crate::trace::Trace) {
        vm.set_g_f(glob::TRACE_ALLSOLID, trace.allsolid as i32 as f32);
        vm.set_g_f(glob::TRACE_STARTSOLID, trace.startsolid as i32 as f32);
        vm.set_g_f(glob::TRACE_FRACTION, trace.fraction);
        vm.set_g_f(glob::TRACE_INWATER, trace.inwater as i32 as f32);
        vm.set_g_f(glob::TRACE_INOPEN, trace.inopen as i32 as f32);
        vm.set_g_v(glob::TRACE_ENDPOS, trace.endpos);
        vm.set_g_v(glob::TRACE_PLANE_NORMAL, trace.normal);
        vm.set_g_f(glob::TRACE_PLANE_DIST, trace.dist);
        vm.set_g_e(glob::TRACE_ENT, if trace.ent >= 0 { trace.ent as Ent } else { 0 });
    }

    /// PF_newcheckclient
    fn new_check_client(&mut self, vm: &Vm, check: i32) -> i32 {
        let maxc = self.maxclients as i32;
        let mut check = check.clamp(1, maxc);
        if check < 1 {
            check = 1;
        }
        let mut i = if check == maxc { 1 } else { check + 1 };
        loop {
            if i == maxc + 1 {
                i = 1;
            }
            let ent = i as Ent;
            if i == check {
                break; // didn't find anything else
            }
            if vm.is_free(ent) || !self.clients[i as usize - 1].spawned {
                i += 1;
                continue;
            }
            if vm.e_f(ent, fld::HEALTH) <= 0.0 {
                i += 1;
                continue;
            }
            if Self::flags(vm, ent) & FL_NOTARGET != 0 {
                i += 1;
                continue;
            }
            // anything that is a client, or has a client as an enemy
            break;
        }
        // get the PVS for the entity
        let ent = i as Ent;
        let org = add(&vm.e_v(ent, fld::ORIGIN), &vm.e_v(ent, fld::VIEW_OFS));
        let leaf = self.map.point_in_leaf(&org);
        let mut pvs = std::mem::take(&mut self.checkpvs);
        self.map.leaf_pvs(leaf, &mut pvs);
        self.checkpvs = pvs;
        i
    }

    /// PF_checkclient
    fn pf_checkclient(&mut self, vm: &mut Vm) -> Result<(), VmError> {
        // find a new check if on a new frame
        if self.time - self.lastchecktime >= 0.1 {
            self.lastcheck = self.new_check_client(vm, self.lastcheck);
            self.lastchecktime = self.time;
        }
        // return check if it might be visible
        let ent = self.lastcheck.max(0) as Ent;
        if ent == 0 || vm.is_free(ent) || vm.e_f(ent, fld::HEALTH) <= 0.0 || !self.clients.get(ent as usize - 1).map_or(false, |c| c.spawned)
        {
            vm.ret_e(0);
            return Ok(());
        }
        // if current entity can't possibly see the check entity, return 0
        let selfe = vm.g_e(glob::SELF);
        let view = add(&vm.e_v(selfe, fld::ORIGIN), &vm.e_v(selfe, fld::VIEW_OFS));
        let leaf = self.map.point_in_leaf(&view) as i32;
        let l = leaf - 1;
        if l < 0 || (l as usize >> 3) >= self.checkpvs.len() || self.checkpvs[l as usize >> 3] & (1 << (l & 7)) == 0 {
            vm.ret_e(0);
            return Ok(());
        }
        // might be able to see it
        vm.ret_e(ent);
        Ok(())
    }

    /// PF_aim (QW: sv_aim 2 means autoaim never kicks in; ported in full anyway)
    fn pf_aim(&mut self, vm: &mut Vm) -> Result<(), VmError> {
        let ent = vm.parm_ent(0)?;
        let _speed = vm.parm_f(1);
        let mut start = vm.e_v(ent, fld::ORIGIN);
        start[2] += 20.0;
        let fwd = vm.g_v(glob::V_FORWARD);

        // noaim option
        if let Some(slot) = self.not_client_slot(ent) {
            if qcvm::atoi(self.clients[slot].userinfo.get(b"noaim")) > 0 {
                vm.ret_v(fwd);
                return Ok(());
            }
        }

        let teamplay = self.cvar(b"teamplay");
        // try sending a trace straight
        let dir = fwd;
        let end = ma(&start, 2048.0, &dir);
        let tr = self.sv_move(vm, &start, &VEC3_ORIGIN, &VEC3_ORIGIN, &end, MOVE_NORMAL, Some(ent));
        if tr.ent >= 0 {
            let te = tr.ent as Ent;
            let eteam = vm.e_f(ent, fld::TEAM);
            if vm.e_f(te, fld::TAKEDAMAGE) == DAMAGE_AIM && (teamplay == 0.0 || eteam <= 0.0 || eteam != vm.e_f(te, fld::TEAM)) {
                vm.ret_v(fwd);
                return Ok(());
            }
        }

        // try all possible entities
        let bestdir = dir;
        let mut bestdist = self.cvar(b"sv_aim");
        let mut bestent: Option<Ent> = None;
        for check in 1..vm.num_edicts() {
            if vm.e_f(check, fld::TAKEDAMAGE) != DAMAGE_AIM || check == ent {
                continue;
            }
            let eteam = vm.e_f(ent, fld::TEAM);
            if teamplay != 0.0 && eteam > 0.0 && eteam == vm.e_f(check, fld::TEAM) {
                continue; // don't aim at teammate
            }
            let (co, cmn, cmx) = (vm.e_v(check, fld::ORIGIN), vm.e_v(check, fld::MINS), vm.e_v(check, fld::MAXS));
            let mut end = [0.0f32; 3];
            for j in 0..3 {
                end[j] = (co[j] as f64 + 0.5 * (cmn[j] + cmx[j]) as f64) as f32;
            }
            let mut d = sub(&end, &start);
            normalize(&mut d);
            let dist = dot(&d, &fwd);
            if dist < bestdist {
                continue; // to far to turn
            }
            let tr = self.sv_move(vm, &start, &VEC3_ORIGIN, &VEC3_ORIGIN, &end, MOVE_NORMAL, Some(ent));
            if tr.ent == check as i32 {
                // can shoot at this one
                bestdist = dist;
                bestent = Some(check);
            }
        }
        if let Some(b) = bestent {
            let d = sub(&vm.e_v(b, fld::ORIGIN), &vm.e_v(ent, fld::ORIGIN));
            let dist = dot(&d, &fwd);
            let mut end = scale(&fwd, dist);
            end[2] = d[2];
            normalize(&mut end);
            vm.ret_v(end);
        } else {
            vm.ret_v(bestdir);
        }
        Ok(())
    }

    /// PF_changeyaw
    pub fn change_yaw(vm: &mut Vm, ent: Ent) {
        let mut angles = vm.e_v(ent, fld::ANGLES);
        let current = anglemod(angles[1]);
        let ideal = vm.e_f(ent, fld::IDEAL_YAW);
        let speed = vm.e_f(ent, fld::YAW_SPEED);
        if current == ideal {
            return;
        }
        let mut mv = ideal - current;
        if ideal > current {
            if mv >= 180.0 {
                mv -= 360.0;
            }
        } else if mv <= -180.0 {
            mv += 360.0;
        }
        if mv > 0.0 {
            if mv > speed {
                mv = speed;
            }
        } else if mv < -speed {
            mv = -speed;
        }
        angles[1] = anglemod(current + mv);
        vm.set_e_v(ent, fld::ANGLES, angles);
    }

    fn write(&mut self, vm: &mut Vm, tok: Tok) -> Result<(), VmError> {
        let dest = vm.parm_f(0) as i32;
        match dest {
            MSG_ONE => {
                let me = vm.g_e(glob::MSG_ENTITY);
                if let Some(slot) = self.not_client_slot(me) {
                    self.buf_one[slot].write(tok);
                    let mut b = std::mem::take(&mut self.buf_one[slot]);
                    b.drain(slot as i32, &mut self.sink, false);
                    self.buf_one[slot] = b;
                } else {
                    return Err(VmError::host("WriteDest: not a client"));
                }
            }
            MSG_BROADCAST | MSG_ALL => {
                self.buf_all.write(tok);
                let mut b = std::mem::take(&mut self.buf_all);
                b.drain(-1, &mut self.sink, false);
                self.buf_all = b;
            }
            MSG_INIT => {
                // the signon (static entities written by hand): not used by the sim
            }
            MSG_MULTICAST => self.buf_multicast.write(tok),
            _ => return Err(VmError::host("WriteDest: bad destination")),
        }
        Ok(())
    }

    /// PF_makestatic
    fn pf_makestatic(&mut self, vm: &mut Vm) -> Result<(), VmError> {
        let e = vm.parm_ent(0)?;
        let m = vm.e_str(e, fld::MODEL).to_vec();
        let mi = self.model_index(&m).unwrap_or(0);
        self.statics.push(StaticEnt {
            modelindex: mi as i32,
            frame: vm.e_f(e, fld::FRAME) as i32,
            colormap: vm.e_f(e, fld::COLORMAP) as i32,
            skin: vm.e_f(e, fld::SKIN) as i32,
            origin: vm.e_v(e, fld::ORIGIN),
            angles: vm.e_v(e, fld::ANGLES),
        });
        // throw the entity away now
        self.free_edict(vm, e);
        Ok(())
    }

    /// ED_Free with the unlink
    pub fn free_edict(&mut self, vm: &mut Vm, e: Ent) {
        self.unlink_edict(e);
        vm.free_edict(e, self.time);
    }

    /// localcmd: the few server console commands a mod may issue
    fn localcmd(&mut self, text: &[u8]) {
        for line in text.split(|&c| c == b'\n' || c == b';') {
            let mut args: Vec<Vec<u8>> = Vec::new();
            let mut rest: &[u8] = line;
            while let Some((tok, r)) = qcvm::com_parse(rest) {
                args.push(tok);
                rest = r;
                if args.len() > 8 {
                    break;
                }
            }
            if args.is_empty() {
                continue;
            }
            match args[0].as_slice() {
                b"serverinfo" if args.len() >= 3 => {
                    let (k, v) = (args[1].clone(), args[2].clone());
                    self.serverinfo.set(&k, &v);
                    self.cvars.insert(k, v);
                }
                b"map" | b"changelevel" if args.len() >= 2 => {
                    if self.changelevel.is_none() {
                        self.changelevel = Some(args[1].clone());
                    }
                }
                b"set" if args.len() >= 3 => {
                    let (k, v) = (args[1].clone(), args[2].clone());
                    self.cvar_set(&k, &v);
                }
                _ => {
                    if args.len() >= 2 && self.cvars.contains_key(&args[0]) {
                        let (k, v) = (args[0].clone(), args[1].clone());
                        self.cvar_set(&k, &v);
                    }
                }
            }
        }
    }

    fn client_slot_of(&self, e: Ent) -> i32 {
        if self.is_client(e) {
            e as i32 - 1
        } else {
            -1
        }
    }
}

impl Host for Server {
    fn builtin(&mut self, vm: &mut Vm, num: u32) -> Result<(), VmError> {
        match num {
            // setorigin
            2 => {
                let e = vm.parm_ent(0)?;
                let org = vm.parm_v(1);
                vm.set_e_v(e, fld::ORIGIN, org);
                self.link_edict(vm, e, false)?;
            }
            3 => self.pf_setmodel(vm)?,
            // setsize
            4 => {
                let e = vm.parm_ent(0)?;
                let (mn, mx) = (vm.parm_v(1), vm.parm_v(2));
                vm.set_e_v(e, fld::MINS, mn);
                vm.set_e_v(e, fld::MAXS, mx);
                vm.set_e_v(e, fld::SIZE, sub(&mx, &mn));
                self.link_edict(vm, e, false)?;
            }
            // sound
            8 => {
                let e = vm.parm_ent(0)?;
                let channel = vm.parm_f(1) as i32;
                let sample = vm.parm_str(2).to_vec();
                let volume = (vm.parm_f(3) as f64 * 255.0) as i32;
                let atten = vm.parm_f(4);
                self.start_sound(vm, e, channel, &sample, volume, atten);
            }
            // spawn
            14 => {
                let a = vm.alloc_edict(self.time);
                if a.stepped_on {
                    self.unlink_edict(a.ent);
                }
                vm.ret_e(a.ent);
            }
            // remove
            15 => {
                let e = vm.parm_ent(0)?;
                if e == 0 {
                    self.log("remove: tried to remove world\n");
                } else if self.is_client(e) {
                    self.log("remove: tried to remove a client\n");
                } else {
                    self.free_edict(vm, e);
                }
            }
            16 => self.pf_traceline(vm)?,
            17 => self.pf_checkclient(vm)?,
            19 | 76 => self.precache(vm, true)?,
            20 | 75 => self.precache(vm, false)?,
            // stuffcmd
            21 => {
                let e = vm.parm_ent(0)?;
                let s = vm.parm_str(1).to_vec();
                match self.not_client_slot(e) {
                    Some(slot) => {
                        let si = self.sink.string(&s);
                        self.sink.push(Event::new(EV_STUFFTEXT).a(slot as i32).b(si));
                    }
                    None => return Err(VmError::host("Parm 0 not a client")),
                }
            }
            // bprint
            23 => {
                let level = vm.parm_f(0) as i32;
                let s = vm.var_string(1);
                self.broadcast_print(level, &s);
            }
            // sprint
            24 => {
                let e = vm.parm_ent(0)?;
                let level = vm.parm_f(1) as i32;
                let s = vm.var_string(2);
                match self.not_client_slot(e) {
                    Some(slot) => self.client_print(slot, level, &s),
                    None => self.log("tried to sprint to a non-client\n"),
                }
            }
            // walkmove
            32 => {
                let ent = vm.g_e(glob::SELF);
                let yaw = vm.parm_f(0);
                let dist = vm.parm_f(1);
                if Self::flags(vm, ent) & (FL_ONGROUND | FL_FLY | FL_SWIM) == 0 {
                    vm.ret_f(0.0);
                    return Ok(());
                }
                let yaw = (yaw as f64 * core::f64::consts::PI * 2.0 / 360.0) as f32;
                let mv = [(libm::cos(yaw as f64) * dist as f64) as f32, (libm::sin(yaw as f64) * dist as f64) as f32, 0.0];
                let oldself = vm.g_e(glob::SELF);
                let r = self.movestep(vm, ent, &mv, true)?;
                vm.set_g_e(glob::SELF, oldself);
                vm.ret_f(r as i32 as f32);
            }
            // droptofloor
            34 => {
                let ent = vm.g_e(glob::SELF);
                let o = vm.e_v(ent, fld::ORIGIN);
                let mut end = o;
                end[2] -= 256.0;
                let (mn, mx) = (vm.e_v(ent, fld::MINS), vm.e_v(ent, fld::MAXS));
                let trace = self.sv_move(vm, &o, &mn, &mx, &end, MOVE_NORMAL, Some(ent));
                if trace.fraction == 1.0 || trace.allsolid {
                    vm.ret_f(0.0);
                } else {
                    vm.set_e_v(ent, fld::ORIGIN, trace.endpos);
                    self.link_edict(vm, ent, false)?;
                    Self::set_flags(vm, ent, Self::flags(vm, ent) | FL_ONGROUND);
                    vm.set_e_e(ent, fld::GROUNDENTITY, trace.ent.max(0) as Ent);
                    vm.ret_f(1.0);
                }
            }
            // lightstyle
            35 => {
                let style = vm.parm_f(0) as i32;
                let val = vm.parm_str(1).to_vec();
                if (0..MAX_LIGHTSTYLES as i32).contains(&style) {
                    self.lightstyles[style as usize] = val.clone();
                    if !self.loading {
                        let si = self.sink.string(&val);
                        self.sink.push(Event::new(EV_LIGHTSTYLE).a(style).b(si));
                    }
                }
            }
            // checkbottom
            40 => {
                let e = vm.parm_ent(0)?;
                let r = self.check_bottom(vm, e);
                vm.ret_f(r as i32 as f32);
            }
            // pointcontents
            41 => {
                let v = vm.parm_v(0);
                let c = self.point_contents(&v);
                vm.ret_f(c as f32);
            }
            44 => self.pf_aim(vm)?,
            // cvar
            45 => {
                let name = vm.parm_str(0).to_vec();
                let v = self.cvar(&name);
                vm.ret_f(v);
            }
            // localcmd
            46 => {
                let s = vm.parm_str(0).to_vec();
                self.localcmd(&s);
            }
            // ChangeYaw
            49 => {
                let e = vm.g_e(glob::SELF);
                Self::change_yaw(vm, e);
            }
            // WriteByte, WriteChar, WriteShort, WriteLong, WriteCoord, WriteAngle
            52..=57 => {
                let v = vm.parm_f(1);
                self.write(vm, Tok::Num(v))?;
            }
            // WriteString
            58 => {
                let s = vm.parm_str(1).to_vec();
                self.write(vm, Tok::Str(s))?;
            }
            // WriteEntity
            59 => {
                let e = vm.parm_ent(1)?;
                self.write(vm, Tok::Num(e as f32))?;
            }
            67 => self.move_to_goal(vm)?,
            // precache_file, precache_file2
            68 | 77 => {
                let h = vm.parm_s(0);
                vm.ret_s(h);
            }
            69 => self.pf_makestatic(vm)?,
            // changelevel
            70 => {
                if self.changelevel.is_none() {
                    let s = vm.parm_str(0).to_vec();
                    self.changelevel = Some(s);
                }
            }
            // cvar_set
            72 => {
                let var = vm.parm_str(0).to_vec();
                let val = vm.parm_str(1).to_vec();
                self.cvar_set(&var, &val);
            }
            // centerprint
            73 => {
                let e = vm.parm_ent(0)?;
                let s = vm.var_string(1);
                match self.not_client_slot(e) {
                    Some(slot) => {
                        let si = self.sink.string(&s);
                        self.sink.push(Event::new(EV_CENTERPRINT).a(slot as i32).b(si));
                    }
                    None => self.log("tried to centerprint to a non-client\n"),
                }
            }
            // ambientsound
            74 => {
                let pos = vm.parm_v(0);
                let samp = vm.parm_str(1).to_vec();
                let vol = vm.parm_f(2);
                let atten = vm.parm_f(3);
                match self.sound_index(&samp) {
                    Some(n) => self.ambients.push(Ambient {
                        sound: n as i32,
                        volume: (vol as f64 * 255.0) as i32,
                        atten: (atten as f64 * 64.0) as i32,
                        origin: pos,
                    }),
                    None => self.log(&format!("no precache: {}\n", String::from_utf8_lossy(&samp))),
                }
            }
            // setspawnparms
            78 => {
                let e = vm.parm_ent(0)?;
                match self.not_client_slot(e) {
                    Some(slot) => {
                        for i in 0..NUM_SPAWN_PARMS {
                            vm.set_g_f(glob::PARM1 + i as u32, self.clients[slot].spawn_parms[i]);
                        }
                    }
                    None => return Err(VmError::host("Entity is not a client")),
                }
            }
            // logfrag
            79 => {}
            // infokey
            80 => {
                let e = vm.parm_ent(0)?;
                let key = vm.parm_str(1).to_vec();
                let value: Vec<u8> = if e == 0 {
                    // serverinfo, then QW's localinfo (empty here)
                    self.serverinfo.get(&key).to_vec()
                } else if let Some(slot) = self.not_client_slot(e) {
                    match key.as_slice() {
                        b"ip" => b"".to_vec(),
                        b"ping" => b"0".to_vec(),
                        _ => self.clients[slot].userinfo.get(&key).to_vec(),
                    }
                } else {
                    Vec::new()
                };
                vm.ret_temp(&value)?;
            }
            // multicast
            82 => {
                let _o = vm.parm_v(0);
                let mut b = std::mem::take(&mut self.buf_multicast);
                b.drain(-1, &mut self.sink, true);
                self.buf_multicast = b;
            }
            // cvar_string
            448 => {
                let name = vm.parm_str(0).to_vec();
                let v = self.cvar_str(&name).to_vec();
                vm.ret_temp(&v)?;
            }
            // qt_obituary(victim, killer, deathtype, flags)
            9000 => {
                let victim = vm.parm_ent(0)?;
                let killer = vm.parm_ent(1)?;
                let deathtype = vm.parm_f(2) as i32;
                let flags = vm.parm_f(3) as i32;
                let vo = vm.e_v(victim, fld::ORIGIN);
                let vs = self.client_slot_of(victim);
                let ks = self.client_slot_of(killer);
                self.sink.push(Event::new(EV_OBITUARY).a(vs).b(ks).c(deathtype).d(flags).xyz(vo));
            }
            // qt_setstat(player, stat, value)
            9001 => {
                let e = vm.parm_ent(0)?;
                let stat = vm.parm_f(1) as i32;
                let value = vm.parm_f(2);
                if let Some(slot) = self.not_client_slot(e) {
                    if (0..NUM_QT_STATS as i32).contains(&stat) {
                        self.clients[slot].stats[stat as usize] = value as i32;
                    }
                }
            }
            // qt_matchstate(phase, endtime, countdownend, score1, score2, round)
            9002 => {
                let ms = MatchState {
                    phase: vm.parm_f(0),
                    endtime: vm.parm_f(1),
                    countdown: vm.parm_f(2),
                    score1: vm.parm_f(3),
                    score2: vm.parm_f(4),
                    round: vm.parm_f(5),
                };
                self.matchstate = ms;
                self.sink.push(
                    Event::new(EV_MATCHSTATE)
                        .a(ms.phase as i32)
                        .b(ms.score1 as i32)
                        .c(ms.score2 as i32)
                        .d(ms.round as i32)
                        .e(canon(ms.endtime))
                        .f(canon(ms.countdown)),
                );
            }
            // qt_setinfo(player, key, value)
            9003 => {
                let e = vm.parm_ent(0)?;
                let key = vm.parm_str(1).to_vec();
                let value = vm.parm_str(2).to_vec();
                if let Some(slot) = self.not_client_slot(e) {
                    self.set_userinfo_key(vm, slot, &key, &value)?;
                }
            }
            // qt_isbot(player)
            9004 => {
                let e = vm.parm_ent(0)?;
                let r = self.not_client_slot(e).map_or(false, |s| self.clients[s].state == CS_BOT);
                vm.ret_f(r as i32 as f32);
            }
            // qt_pickup(player, item)
            9005 => {
                let e = vm.parm_ent(0)?;
                let item = vm.parm_f(1) as i32;
                if let Some(slot) = self.not_client_slot(e) {
                    let o = vm.e_v(e, fld::ORIGIN);
                    self.sink.push(Event::new(EV_PICKUP).a(slot as i32).b(item).xyz(o));
                }
            }
            _ => return Err(VmError::unknown_builtin(num)),
        }
        Ok(())
    }

    fn print(&mut self, _vm: &Vm, kind: Print, text: &[u8]) {
        if self.log_enabled {
            match kind {
                Print::Dprint => {}
                Print::Eprint => self.log.extend_from_slice(b"[eprint] "),
                Print::Error => self.log.extend_from_slice(b"[error] "),
            }
            self.log.extend_from_slice(text);
        }
    }

    fn unlink(&mut self, _vm: &mut Vm, e: Ent) {
        self.unlink_edict(e);
    }
}
