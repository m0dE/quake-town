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
//! Clients: QW/server/sv_user.c (SV_RunCmd, SV_PreRunCmd/SV_PostRunCmd, spawn/begin,
//! kill, setinfo) and the connect / drop parts of sv_main.c (SVC_DirectConnect,
//! SV_DropClient, SV_ExtractFromUserinfo).

use qcvm::defs::{fld, glob};
use qcvm::{Ent, Vm, VmError};

use crate::bsp::CONTENTS_EMPTY;
use crate::info::Info;
use crate::mathlib::*;
use crate::pmove::*;
use crate::world::*;

const CL_ROLLSPEED: f32 = 200.0;
const CL_ROLLANGLE: f32 = 2.0;

/// V_CalcRoll
fn calc_roll(angles: &Vec3, velocity: &Vec3) -> f32 {
    let (_f, right, _u) = angle_vectors(angles);
    let mut side = dot(velocity, &right);
    let sign = if side < 0.0 { -1.0 } else { 1.0 };
    side = side.abs();
    let value = CL_ROLLANGLE;
    if side < CL_ROLLSPEED {
        side = side * value / CL_ROLLSPEED;
    } else {
        side = value;
    }
    side * sign
}

impl Server {
    #[inline]
    pub fn slot_edict(slot: usize) -> Ent {
        slot as Ent + 1
    }

    /// SV_ExtractFromUserinfo (name trimming and de-duplication)
    pub fn extract_from_userinfo(&mut self, vm: &mut Vm, slot: usize) -> Result<(), VmError> {
        let raw = self.clients[slot].userinfo.get(b"name").to_vec();
        // trim leading / trailing white space
        let is_ws = |c: &u8| *c == b' ' || *c == b'\r' || *c == b'\n';
        let start = raw.iter().position(|c| !is_ws(c)).unwrap_or(raw.len());
        let end = raw.iter().rposition(|c| !is_ws(c)).map(|i| i + 1).unwrap_or(start);
        let mut val: Vec<u8> = raw[start..end.max(start)].to_vec();
        if val.is_empty() || val.eq_ignore_ascii_case(b"console") {
            val = b"unnamed".to_vec();
        }
        // check to see if another user by the same name exists
        let mut dupc = 1;
        loop {
            let dup = self
                .clients
                .iter()
                .enumerate()
                .any(|(i, c)| i != slot && c.spawned && c.name.eq_ignore_ascii_case(&val));
            if !dup {
                break;
            }
            let mut p: &[u8] = &val;
            if p.first() == Some(&b'(') {
                if p.get(2) == Some(&b')') {
                    p = &p[3..];
                } else if p.get(3) == Some(&b')') {
                    p = &p[4..];
                }
            }
            let mut n = format!("({dupc})").into_bytes();
            dupc += 1;
            n.extend_from_slice(&p[..p.len().min(40)]);
            val = n;
            if dupc > 99 {
                break;
            }
        }
        if val != raw {
            self.clients[slot].userinfo.set(b"name", &val);
            val = self.clients[slot].userinfo.get(b"name").to_vec();
        }
        let old = std::mem::replace(&mut self.clients[slot].name, val.clone());
        if self.clients[slot].spawned && !old.is_empty() && old != val {
            let msg = [old.as_slice(), b" changed name to ", val.as_slice(), b"\n"].concat();
            self.broadcast_print(2, &msg);
        }
        if self.clients[slot].spawned {
            let e = Self::slot_edict(slot);
            let h = vm.new_string(&val)?;
            vm.set_e_s(e, fld::NETNAME, h);
        }
        Ok(())
    }

    /// SVC_DirectConnect (the progs part) + SV_Spawn_f + SV_Begin_f: the slot gets a
    /// body. `parms` = Some(...) to reuse saved spawn parms (changelevel).
    pub fn connect_client(&mut self, vm: &mut Vm, slot: usize, userinfo: Info, state: u8) -> Result<(), VmError> {
        
        {
            let c = &mut self.clients[slot];
            let bot = c.bot.clone();
            *c = Client::new();
            c.bot = bot;
            c.state = state;
            c.userinfo = userinfo;
        }
        self.extract_from_userinfo(vm, slot)?;

        // call the progs to get default spawn parms for the new client
        vm.set_g_f(glob::TIME, self.time as f32);
        let f = vm.g_fn(glob::SETNEWPARMS);
        if f != 0 {
            vm.call(self, f)?;
        }
        for i in 0..NUM_SPAWN_PARMS {
            self.clients[slot].spawn_parms[i] = vm.g_f(glob::PARM1 + i as u32);
        }
        self.spawn_client(vm, slot)
    }

    /// SV_Spawn_f + SV_Begin_f
    pub fn spawn_client(&mut self, vm: &mut Vm, slot: usize) -> Result<(), VmError> {
        let e = Self::slot_edict(slot);
        // set up the edict
        vm.clear_edict(e);
        vm.set_e_f(e, fld::COLORMAP, e as f32);
        vm.set_e_f(e, fld::TEAM, 0.0);
        let name = self.clients[slot].name.clone();
        let h = vm.new_string(&name)?;
        vm.set_e_s(e, fld::NETNAME, h);
        self.clients[slot].entgravity = 1.0;
        if let Some(o) = self.ext.gravity {
            vm.set_e_f(e, o, 1.0);
        }
        let maxspeed = self.cvar(b"sv_maxspeed");
        self.clients[slot].maxspeed = maxspeed;
        if let Some(o) = self.ext.maxspeed {
            vm.set_e_f(e, o, maxspeed);
        }
        self.clients[slot].stats = [0; NUM_QT_STATS];
        self.clients[slot].spawned = true;
        self.clients[slot].oldbuttons = 0;

        // SV_Begin_f: copy spawn parms out of the client_t
        for i in 0..NUM_SPAWN_PARMS {
            vm.set_g_f(glob::PARM1 + i as u32, self.clients[slot].spawn_parms[i]);
        }
        // call the spawn function
        vm.set_g_f(glob::TIME, self.time as f32);
        vm.set_g_e(glob::SELF, e);
        let f = vm.g_fn(glob::CLIENTCONNECT);
        if f != 0 {
            vm.call(self, f)?;
        }
        // actually spawn the player
        vm.set_g_f(glob::TIME, self.time as f32);
        vm.set_g_e(glob::SELF, e);
        let f = vm.g_fn(glob::PUTCLIENTINSERVER);
        if f != 0 {
            vm.call(self, f)?;
        }
        Ok(())
    }

    /// SV_DropClient
    pub fn drop_client(&mut self, vm: &mut Vm, slot: usize) -> Result<(), VmError> {
        let e = Self::slot_edict(slot);
        if self.clients[slot].spawned {
            // call the prog function for removing a client
            // this will set the body to a dead frame, among other things
            vm.set_g_e(glob::SELF, e);
            vm.set_g_f(glob::TIME, self.time as f32);
            let f = vm.g_fn(glob::CLIENTDISCONNECT);
            if f != 0 {
                vm.call(self, f)?;
            }
        }
        vm.set_e_f(e, fld::FRAGS, 0.0);
        let bot = self.clients[slot].bot.clone();
        self.clients[slot] = Client::new();
        self.clients[slot].bot = bot;
        Ok(())
    }

    /// SV_Kill_f
    pub fn kill_command(&mut self, vm: &mut Vm, slot: usize) -> Result<(), VmError> {
        let e = Self::slot_edict(slot);
        if vm.e_f(e, fld::HEALTH) <= 0.0 {
            self.client_print(slot, 2, b"Can't suicide -- allready dead!\n");
            return Ok(());
        }
        vm.set_g_f(glob::TIME, self.time as f32);
        vm.set_g_e(glob::SELF, e);
        let f = vm.g_fn(glob::CLIENTKILL);
        if f != 0 {
            vm.call(self, f)?;
        }
        Ok(())
    }

    /// SV_RunCmd for one client with its held command (msec 13).
    pub fn run_cmd(&mut self, vm: &mut Vm, slot: usize) -> Result<(), VmError> {
        let player = Self::slot_edict(slot);
        let ucmd = self.clients[slot].cmd;

        if vm.e_f(player, fld::FIXANGLE) == 0.0 {
            vm.set_e_v(player, fld::V_ANGLE, ucmd.angles);
        }

        vm.set_e_f(player, fld::BUTTON0, (ucmd.buttons & 1) as f32);
        vm.set_e_f(player, fld::BUTTON2, ((ucmd.buttons & 2) >> 1) as f32);
        if ucmd.impulse != 0 {
            vm.set_e_f(player, fld::IMPULSE, ucmd.impulse as f32);
        }

        // angles: show 1/3 the pitch angle and all the roll angle
        if vm.e_f(player, fld::HEALTH) > 0.0 {
            let mut angles = vm.e_v(player, fld::ANGLES);
            if vm.e_f(player, fld::FIXANGLE) == 0.0 {
                let va = vm.e_v(player, fld::V_ANGLE);
                angles[PITCH] = -va[PITCH] / 3.0;
                angles[YAW] = va[YAW];
            }
            angles[ROLL] = calc_roll(&angles, &vm.e_v(player, fld::VELOCITY)) * 4.0;
            vm.set_e_v(player, fld::ANGLES, angles);
        }

        self.frametime = ucmd.msec as f64 * 0.001;
        if self.frametime > 0.1 {
            self.frametime = 0.1;
        }

        vm.set_g_f(glob::FRAMETIME, self.frametime as f32);
        vm.set_g_f(glob::TIME, self.time as f32);
        vm.set_g_e(glob::SELF, player);
        let f = vm.g_fn(glob::PLAYERPRETHINK);
        if f != 0 {
            vm.call(self, f)?;
        }
        self.run_think(vm, player)?;

        // pmove
        let mins = vm.e_v(player, fld::MINS);
        let mut origin = [0.0f32; 3];
        let porigin = vm.e_v(player, fld::ORIGIN);
        for i in 0..3 {
            origin[i] = porigin[i] + (mins[i] - PLAYER_MINS[i]);
        }
        let mut pmove_mins = [0.0f32; 3];
        let mut pmove_maxs = [0.0f32; 3];
        for i in 0..3 {
            pmove_mins[i] = origin[i] - 256.0;
            pmove_maxs[i] = origin[i] + 256.0;
        }
        self.add_links_to_pmove(vm, player, &pmove_mins, &pmove_maxs);

        let physents = std::mem::take(&mut self.physents);
        let map = self.map.clone();
        let (onground, waterlevel, watertype, touches, numtouch, pm_origin, pm_velocity, pm_angles, oldbuttons, wjt);
        {
            let mut pm = PlayerMove::new(&map, &physents);
            pm.movevars = self.movevars;
            pm.movevars.entgravity = self.clients[slot].entgravity;
            pm.movevars.maxspeed = self.clients[slot].maxspeed;
            pm.origin = origin;
            pm.velocity = vm.e_v(player, fld::VELOCITY);
            pm.angles = vm.e_v(player, fld::V_ANGLE);
            pm.spectator = false;
            pm.waterjumptime = vm.e_f(player, fld::TELEPORT_TIME);
            pm.cmd = ucmd;
            pm.dead = vm.e_f(player, fld::HEALTH) <= 0.0;
            pm.oldbuttons = self.clients[slot].oldbuttons;
            pm.player_move();
            onground = pm.onground;
            waterlevel = pm.waterlevel;
            watertype = pm.watertype;
            touches = pm.touchindex;
            numtouch = pm.numtouch;
            pm_origin = pm.origin;
            pm_velocity = pm.velocity;
            pm_angles = pm.angles;
            oldbuttons = pm.oldbuttons;
            wjt = pm.waterjumptime;
        }

        self.clients[slot].oldbuttons = oldbuttons;
        vm.set_e_f(player, fld::TELEPORT_TIME, wjt);
        vm.set_e_f(player, fld::WATERLEVEL, waterlevel as f32);
        vm.set_e_f(player, fld::WATERTYPE, watertype as f32);
        if onground != -1 {
            Self::set_flags(vm, player, Self::flags(vm, player) | FL_ONGROUND);
            vm.set_e_e(player, fld::GROUNDENTITY, physents[onground as usize].info as Ent);
        } else {
            Self::set_flags(vm, player, Self::flags(vm, player) & !FL_ONGROUND);
        }
        let mins = vm.e_v(player, fld::MINS);
        let mut no = [0.0f32; 3];
        for i in 0..3 {
            no[i] = pm_origin[i] - (mins[i] - PLAYER_MINS[i]);
        }
        vm.set_e_v(player, fld::ORIGIN, no);
        vm.set_e_v(player, fld::VELOCITY, pm_velocity);
        vm.set_e_v(player, fld::V_ANGLE, pm_angles);

        // link into place and touch triggers
        self.link_edict(vm, player, true)?;

        // touch other objects
        for &ti in touches.iter().take(numtouch) {
            if ti < 0 || ti as usize >= physents.len() {
                continue;
            }
            let n = physents[ti as usize].info as usize;
            if n >= vm.num_edicts() as usize || vm.is_free(n as Ent) {
                continue;
            }
            let tf = vm.e_fn(n as Ent, fld::TOUCH);
            if tf == 0 || self.playertouch[n / 8] & (1 << (n % 8)) != 0 {
                continue;
            }
            vm.set_g_e(glob::SELF, n as Ent);
            vm.set_g_e(glob::OTHER, player);
            vm.call(self, tf)?;
            self.playertouch[n / 8] |= 1 << (n % 8);
        }
        self.physents = physents;
        Ok(())
    }

    /// SV_PreRunCmd + SV_RunCmd + SV_PostRunCmd for one client.
    pub fn client_think(&mut self, vm: &mut Vm, slot: usize) -> Result<(), VmError> {
        for b in self.playertouch.iter_mut() {
            *b = 0;
        }
        self.run_cmd(vm, slot)?;
        // SV_PostRunCmd: run post-think
        let player = Self::slot_edict(slot);
        vm.set_g_f(glob::TIME, self.time as f32);
        vm.set_g_e(glob::SELF, player);
        let f = vm.g_fn(glob::PLAYERPOSTTHINK);
        if f != 0 {
            vm.call(self, f)?;
        }
        self.run_newmis(vm)
    }

    /// the end-of-frame part of SV_UpdateToReliableMessages / SV_WriteClientdataToMessage:
    /// entgravity / maxspeed from QC, damage and fixangle reported and cleared.
    pub fn end_frame_clients(&mut self, vm: &mut Vm) {
        for slot in 0..self.maxclients {
            let c = &mut self.clients[slot];
            c.out_dmg = None;
            c.out_fixangle = None;
            if !c.spawned {
                continue;
            }
            let e = Self::slot_edict(slot);
            if let Some(o) = self.ext.gravity {
                self.clients[slot].entgravity = vm.e_f(e, o);
            }
            if let Some(o) = self.ext.maxspeed {
                self.clients[slot].maxspeed = vm.e_f(e, o);
            }
            let take = vm.e_f(e, fld::DMG_TAKE);
            let save = vm.e_f(e, fld::DMG_SAVE);
            if take != 0.0 || save != 0.0 {
                let other = vm.e_e(e, fld::DMG_INFLICTOR);
                let o = vm.e_v(other, fld::ORIGIN);
                let (mn, mx) = (vm.e_v(other, fld::MINS), vm.e_v(other, fld::MAXS));
                let mut from = [0.0f32; 3];
                for i in 0..3 {
                    from[i] = (o[i] as f64 + 0.5 * (mn[i] + mx[i]) as f64) as f32;
                }
                self.clients[slot].out_dmg = Some((take, save, from));
                self.sink.push(
                    crate::events::Event::new(crate::events::EV_DAMAGE)
                        .a(slot as i32)
                        .b(save as i32)
                        .c(take as i32)
                        .xyz(from),
                );
                vm.set_e_f(e, fld::DMG_TAKE, 0.0);
                vm.set_e_f(e, fld::DMG_SAVE, 0.0);
            }
            if vm.e_f(e, fld::FIXANGLE) != 0.0 {
                self.clients[slot].out_fixangle = Some(vm.e_v(e, fld::ANGLES));
                vm.set_e_f(e, fld::FIXANGLE, 0.0);
            }
        }
    }

    /// set a userinfo key from the game (qt_setinfo) or the client (setinfo)
    pub fn set_userinfo_key(&mut self, vm: &mut Vm, slot: usize, key: &[u8], value: &[u8]) -> Result<(), VmError> {
        self.clients[slot].userinfo.set(key, value);
        if key == b"name" {
            self.extract_from_userinfo(vm, slot)?;
        }
        Ok(())
    }

    /// waterlevel/type sanity used by bots
    pub fn in_water(&self, p: &Vec3) -> bool {
        self.point_contents(p) != CONTENTS_EMPTY
    }
}
