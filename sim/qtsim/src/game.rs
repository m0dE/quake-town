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
//! The world's life: SV_SpawnServer (sv_init.c), the per-tick frame (DESIGN.md
//! "Simulation architecture" order), changelevel, membership, client commands.

use std::sync::Arc;

use qcvm::defs::{fld, glob};
use qcvm::{Progs, Vm, VmConfig, VmError};

use crate::bsp::Map;
use crate::events::*;
use crate::info::Info;
use crate::pmove::{MoveVars, UserCmd};
use crate::trace::BoxHull;
use crate::world::*;

/// instruction budget per tick (all QC calls together)
pub const TICK_BUDGET: u64 = 20_000_000;

/// QW cvar defaults the sim knows; serverinfo keys override / add.
const DEFAULT_CVARS: &[(&str, &str)] = &[
    ("deathmatch", "1"),
    ("teamplay", "0"),
    ("timelimit", "0"),
    ("fraglimit", "0"),
    ("samelevel", "0"),
    ("noexit", "0"),
    ("skill", "0"),
    ("coop", "0"),
    ("registered", "1"),
    ("temp1", "0"),
    ("sv_gravity", "800"),
    ("sv_stopspeed", "100"),
    ("sv_maxspeed", "320"),
    ("sv_spectatormaxspeed", "500"),
    ("sv_accelerate", "10"),
    ("sv_airaccelerate", "0.7"),
    ("sv_wateraccelerate", "10"),
    ("sv_friction", "4"),
    ("sv_waterfriction", "4"),
    ("sv_maxvelocity", "2000"),
    ("sv_aim", "2"),
];

impl World {
    /// world_new: `info` is the serverinfo infostring.
    pub fn new(progs: Arc<Progs>, maps: Vec<Arc<Map>>, map_id: u32, seed: u32, info: &[u8]) -> Result<World, String> {
        let map = maps.get(map_id as usize).cloned().ok_or_else(|| format!("world_new: no map {map_id}"))?;
        let serverinfo = Info::parse(info);
        let mc = qcvm::atoi(serverinfo.get(b"maxclients"));
        let maxclients = if mc == 0 { 8 } else { mc.clamp(2, 32) } as usize;
        let bots_enabled = {
            let b = serverinfo.get(b"bots");
            !b.is_empty() && qcvm::atof(b) != 0.0
        };
        let cfg = VmConfig { client_edicts: maxclients as u32, ..VmConfig::default() };
        let vm = Vm::new(progs.clone(), cfg, seed as u64);
        let max_edicts = vm.max_edicts();

        let mut cvars = std::collections::BTreeMap::new();
        for (k, v) in DEFAULT_CVARS {
            cvars.insert(k.as_bytes().to_vec(), v.as_bytes().to_vec());
        }
        for (k, v) in &serverinfo.pairs {
            cvars.insert(k.clone(), v.clone());
        }
        cvars.insert(b"maxclients".to_vec(), maxclients.to_string().into_bytes());

        let ext = ExtFields {
            gravity: progs.find_field("gravity").map(|d| d.ofs),
            maxspeed: progs.find_field("maxspeed").map(|d| d.ofs),
            alpha: progs.find_field("alpha").map(|d| d.ofs),
        };
        let extf = ExtFuncs {
            parse_client_command: progs.find_function("SV_ParseClientCommand"),
            userinfo_changed: progs.find_function("UserInfo_Changed"),
        };

        let sv = Server {
            progs,
            maps,
            map_id,
            map,
            ext,
            extf,
            seed: seed as u64,
            tick_count: 0,
            map_ticks: 0,
            time: 1.0,
            frametime: 0.0,
            maxclients,
            bots_enabled,
            serverinfo,
            cvars,
            movevars: MoveVars::default(),
            model_precache: Vec::new(),
            sound_precache: Vec::new(),
            model_sub: Vec::new(),
            lightstyles: vec![Vec::new(); MAX_LIGHTSTYLES],
            loading: false,
            serverflags: 0.0,
            clients: vec![Client::new(); maxclients],
            botsys: crate::bots::BotSys::new(maxclients),
            spawn_info: Vec::new(),
            static_brushes: None,
            areanodes: Vec::new(),
            links: Vec::new(),
            max_edicts,
            lastcheck: 0,
            lastchecktime: 0.0,
            checkpvs: Vec::new(),
            statics: Vec::new(),
            ambients: Vec::new(),
            changelevel: None,
            matchstate: MatchState::default(),
            intermission: None,
            error: None,
            sink: EventSink::default(),
            pending: EventSink::default(),
            buf_all: MsgBuf::default(),
            buf_multicast: MsgBuf::default(),
            buf_one: vec![MsgBuf::default(); maxclients],
            boxhull: Box::new(BoxHull::new()),
            physents: Vec::with_capacity(crate::pmove::MAX_PHYSENTS),
            playertouch: vec![0u8; (max_edicts as usize + 7) / 8],
            log: Vec::new(),
            log_enabled: false,
        };
        let mut w = World { vm, sv };
        let r = w.spawn_server(map_id, true).and_then(|_| {
            if w.sv.bots_enabled {
                for slot in 0..w.sv.maxclients {
                    w.sv.connect_client(&mut w.vm, slot, crate::bots::bot_userinfo(slot), CS_BOT)?;
                }
            }
            Ok(())
        });
        if let Err(e) = r {
            return Err(e.to_string());
        }
        w.flush_tick_buffers();
        let made = std::mem::take(&mut w.sv.sink);
        w.sv.pending.append(made);
        Ok(w)
    }

    /// enables the text log (qtrun)
    pub fn set_log(&mut self, on: bool) {
        self.sv.log_enabled = on;
    }

    /// SV_SpawnServer
    fn spawn_server(&mut self, map_id: u32, first: bool) -> Result<(), VmError> {
        let (vm, sv) = (&mut self.vm, &mut self.sv);
        if !first {
            vm.restart();
        }
        sv.map_id = map_id;
        sv.map = sv.maps[map_id as usize].clone();
        sv.map_ticks = 0;
        sv.time = 1.0;
        sv.lightstyles = vec![Vec::new(); MAX_LIGHTSTYLES];
        sv.statics.clear();
        sv.ambients.clear();
        sv.lastcheck = 0;
        sv.lastchecktime = 0.0;
        sv.checkpvs.clear();
        sv.changelevel = None;
        sv.intermission = None;
        sv.spawn_info = sv.serverinfo.encode();
        sv.botsys.new_map(sv.maxclients);
        sv.static_brushes = None;

        // clear physics interaction links
        sv.clear_world();

        let modelname = format!("maps/{}.bsp", sv.map.name).into_bytes();
        sv.sound_precache = vec![Vec::new()];
        sv.model_precache = vec![Vec::new(), modelname.clone()];
        for i in 1..sv.map.models.len() {
            sv.model_precache.push(format!("*{i}").into_bytes());
        }
        sv.update_model_sub();

        // precache and static commands can be issued during map initialization
        sv.loading = true;

        let h = vm.new_string(&modelname)?;
        vm.set_e_s(0, fld::MODEL, h);
        vm.set_e_f(0, fld::MODELINDEX, 1.0);
        vm.set_e_f(0, fld::SOLID, SOLID_BSP as f32);
        vm.set_e_f(0, fld::MOVETYPE, MOVETYPE_PUSH as f32);

        let h = vm.new_string(sv.map.name.as_bytes())?;
        vm.set_g_s(glob::MAPNAME, h);
        // serverflags are for cross level information (sigils)
        vm.set_g_f(glob::SERVERFLAGS, sv.serverflags);

        // run the frame start qc function to let progs check cvars
        sv.prog_start_frame(vm)?;

        // load and spawn all other entities
        let map = sv.map.clone();
        let stats = vm.load_entities(sv, &map.entities, sv.time)?;
        let _ = stats;

        // all spawning is completed
        sv.loading = false;
        vm.set_world_locked(true);

        // run two frames to allow everything to settle
        sv.physics(vm, 0.1)?;
        sv.physics(vm, 0.1)?;

        // save movement vars
        sv.movevars = MoveVars {
            gravity: sv.cvar(b"sv_gravity"),
            stopspeed: sv.cvar(b"sv_stopspeed"),
            maxspeed: sv.cvar(b"sv_maxspeed"),
            spectatormaxspeed: sv.cvar(b"sv_spectatormaxspeed"),
            accelerate: sv.cvar(b"sv_accelerate"),
            airaccelerate: sv.cvar(b"sv_airaccelerate"),
            wateraccelerate: sv.cvar(b"sv_wateraccelerate"),
            friction: sv.cvar(b"sv_friction"),
            waterfriction: sv.cvar(b"sv_waterfriction"),
            entgravity: 1.0,
        };
        let name = sv.map.name.clone();
        sv.serverinfo.set(b"map", name.as_bytes());
        Ok(())
    }

    pub fn stopped(&self) -> bool {
        self.sv.error.is_some()
    }

    fn fail(&mut self, e: VmError) {
        let msg = e.to_string();
        if self.sv.log_enabled {
            self.sv.log.extend_from_slice(format!("SV_Error: {msg}\n").as_bytes());
        }
        self.sv.error = Some(msg);
    }

    fn flush_tick_buffers(&mut self) {
        let sv = &mut self.sv;
        let mut b = std::mem::take(&mut sv.buf_all);
        b.drain(-1, &mut sv.sink, true);
        sv.buf_all = b;
        for slot in 0..sv.maxclients {
            let mut b = std::mem::take(&mut sv.buf_one[slot]);
            b.drain(slot as i32, &mut sv.sink, true);
            sv.buf_one[slot] = b;
        }
        sv.buf_multicast = MsgBuf::default();
        // intermission is a world state for the views
        for ev in &sv.sink.events {
            if ev.kind() == EV_INTERMISSION {
                sv.intermission = Some([f32::from_bits(ev.w[5]), f32::from_bits(ev.w[6]), f32::from_bits(ev.w[7])]);
            }
        }
    }

    /// world_tick
    pub fn tick(&mut self) {
        self.sv.sink = std::mem::take(&mut self.sv.pending);
        if self.stopped() {
            return;
        }
        if let Err(e) = self.tick_inner() {
            self.fail(e);
        }
        self.flush_tick_buffers();
    }

    fn tick_inner(&mut self) -> Result<(), VmError> {
        let (vm, sv) = (&mut self.vm, &mut self.sv);
        vm.set_budget(TICK_BUDGET);
        sv.tick_count = sv.tick_count.wrapping_add(1);
        sv.map_ticks += 1;
        sv.time = 1.0 + sv.map_ticks as f64 * (TICK_MSEC as f64 * 0.001);

        // 1. bots compute their usercmds
        sv.bots_think(vm);
        // 2. clients in slot order
        for slot in 0..sv.maxclients {
            if sv.clients[slot].spawned {
                sv.client_think(vm, slot)?;
                sv.clients[slot].cmd.impulse = 0;
            }
        }
        // 3. SV_Physics
        sv.physics(vm, TICK_MSEC as f64 * 0.001)?;
        sv.end_frame_clients(vm);

        // 4. pending changelevel
        if let Some(name) = sv.changelevel.take() {
            self.do_changelevel(&name)?;
        }
        Ok(())
    }

    /// changelevel at the end of a tick (DESIGN.md "Maps and changelevel")
    fn do_changelevel(&mut self, name: &[u8]) -> Result<(), VmError> {
        let target = {
            let n = String::from_utf8_lossy(name).to_string();
            let n = n.trim().trim_start_matches("maps/").trim_end_matches(".bsp").to_string();
            self.sv.maps.iter().position(|m| m.name.eq_ignore_ascii_case(&n)).map(|i| i as u32).unwrap_or(self.sv.map_id)
        };
        // SV_SaveSpawnparms
        {
            let (vm, sv) = (&mut self.vm, &mut self.sv);
            sv.serverflags = vm.g_f(glob::SERVERFLAGS);
            for slot in 0..sv.maxclients {
                if !sv.clients[slot].spawned {
                    continue;
                }
                vm.set_g_e(glob::SELF, Server::slot_edict(slot));
                let f = vm.g_fn(glob::SETCHANGEPARMS);
                if f != 0 {
                    vm.call(sv, f)?;
                }
                for j in 0..NUM_SPAWN_PARMS {
                    sv.clients[slot].spawn_parms[j] = vm.g_f(glob::PARM1 + j as u32);
                }
            }
        }
        // keep this tick's events: the old map's buffers are flushed first
        self.flush_tick_buffers();
        self.spawn_server(target, false)?;
        let (vm, sv) = (&mut self.vm, &mut self.sv);
        for slot in 0..sv.maxclients {
            if sv.clients[slot].state != CS_EMPTY {
                sv.clients[slot].spawned = false;
                sv.spawn_client(vm, slot)?;
            }
        }
        sv.sink.push(Event::new(EV_CHANGELEVEL).a(target as i32));
        Ok(())
    }

    // ------------------------------------------------------------------ membership

    pub fn free_slot(&self) -> i32 {
        self.sv.clients.iter().position(|c| c.state == CS_EMPTY || c.state == CS_BOT).map(|i| i as i32).unwrap_or(-1)
    }

    fn guarded(&mut self, f: impl FnOnce(&mut Vm, &mut Server) -> Result<(), VmError>) {
        if self.stopped() {
            return;
        }
        self.vm.set_budget(TICK_BUDGET);
        // the last tick's events stay readable; new ones go out with the next tick
        let last = std::mem::take(&mut self.sv.sink);
        let r = f(&mut self.vm, &mut self.sv);
        if let Err(e) = r {
            self.fail(e);
        }
        self.flush_tick_buffers();
        let made = std::mem::replace(&mut self.sv.sink, last);
        self.sv.pending.append(made);
    }

    /// world_client_join
    pub fn client_join(&mut self, slot: usize, ui: &[u8]) {
        if slot >= self.sv.maxclients {
            return;
        }
        let info = client_userinfo(ui);
        self.guarded(|vm, sv| match sv.clients[slot].state {
            CS_HUMAN => Ok(()),
            CS_IDLE => {
                sv.clients[slot].state = CS_HUMAN;
                sv.botsys.remove(slot);
                sv.clients[slot].cmd = UserCmd { msec: TICK_MSEC, ..Default::default() };
                apply_userinfo(vm, sv, slot, &info)
            }
            CS_BOT => {
                sv.drop_client(vm, slot)?;
                sv.connect_client(vm, slot, info, CS_HUMAN)
            }
            _ => sv.connect_client(vm, slot, info, CS_HUMAN),
        });
    }

    /// world_client_leave
    pub fn client_leave(&mut self, slot: usize) {
        if slot >= self.sv.maxclients {
            return;
        }
        self.guarded(|vm, sv| {
            let st = sv.clients[slot].state;
            if st != CS_HUMAN && st != CS_IDLE {
                return Ok(());
            }
            sv.drop_client(vm, slot)?;
            if sv.bots_enabled {
                sv.connect_client(vm, slot, crate::bots::bot_userinfo(slot), CS_BOT)?;
            }
            Ok(())
        });
    }

    /// world_client_idle
    pub fn client_idle(&mut self, slot: usize) {
        if slot < self.sv.maxclients && self.sv.clients[slot].state == CS_HUMAN {
            self.sv.clients[slot].state = CS_IDLE;
            let sk = crate::bots::bot_skill(&self.sv, slot);
            self.sv.botsys.add(slot, sk);
        }
    }

    /// world_set_userinfo
    pub fn set_userinfo(&mut self, slot: usize, ui: &[u8]) {
        if slot >= self.sv.maxclients || self.sv.clients[slot].state == CS_EMPTY {
            return;
        }
        let info = client_userinfo(ui);
        self.guarded(|vm, sv| apply_userinfo(vm, sv, slot, &info));
    }

    /// world_client_command
    pub fn client_command(&mut self, slot: usize, text: &[u8]) {
        if slot >= self.sv.maxclients || !self.sv.clients[slot].spawned {
            return;
        }
        let text: Vec<u8> = text.iter().copied().take(256).filter(|&c| c >= 32 && c < 127).collect();
        self.guarded(|vm, sv| {
            let e = Server::slot_edict(slot);
            if let Some(f) = sv.extf.parse_client_command {
                let h = vm.temp_string(&text)?;
                vm.set_g_f(glob::TIME, sv.time as f32);
                vm.set_g_e(glob::SELF, e);
                vm.set_parm_s(0, h);
                vm.call(sv, f)
            } else {
                let first: Vec<u8> = qcvm::com_parse(&text).map(|(t, _)| t).unwrap_or_default();
                if first == b"kill" {
                    sv.kill_command(vm, slot)
                } else {
                    Ok(())
                }
            }
        });
    }

    /// world_set_cmd
    #[allow(clippy::too_many_arguments)]
    pub fn set_cmd(&mut self, slot: usize, pitch16: i32, yaw16: i32, forward: i32, side: i32, up: i32, buttons: i32, impulse: i32) {
        if slot >= self.sv.maxclients {
            return;
        }
        let a = |s: i32| ((s as i16) as f64 * (360.0 / 65536.0)) as f32;
        let c = &mut self.sv.clients[slot];
        c.cmd = UserCmd {
            msec: TICK_MSEC,
            angles: [a(pitch16), a(yaw16), 0.0],
            forwardmove: forward.clamp(-500, 500) as i16,
            sidemove: side.clamp(-500, 500) as i16,
            upmove: up.clamp(-500, 500) as i16,
            buttons: (buttons & 0xff) as u8,
            impulse: (impulse & 0xff) as u8,
        };
    }

    /// world_set_cvar (tests / tools; only before the first tick)
    pub fn set_cvar(&mut self, name: &[u8], value: &[u8]) {
        if self.sv.tick_count == 0 {
            self.sv.cvar_set(name, value);
        }
    }

    pub fn time(&self) -> f64 {
        self.sv.time
    }
}

/// a client's userinfo: '*' keys are the engine's
fn client_userinfo(ui: &[u8]) -> Info {
    let mut i = Info::default();
    for (k, v) in Info::parse(ui).pairs {
        if k.first() != Some(&b'*') {
            i.set(&k, &v);
        }
    }
    i
}

/// world_set_userinfo for an occupied slot
fn apply_userinfo(vm: &mut Vm, sv: &mut Server, slot: usize, info: &Info) -> Result<(), VmError> {
    let old = sv.clients[slot].userinfo.clone();
    let mut ui = Info::default();
    // keep the engine's '*' keys
    for (k, v) in &old.pairs {
        if k.first() == Some(&b'*') {
            ui.set(k, v);
        }
    }
    for (k, v) in &info.pairs {
        ui.set(k, v);
    }
    if ui == old {
        return Ok(());
    }
    sv.clients[slot].userinfo = ui;
    sv.extract_from_userinfo(vm, slot)?;
    if sv.clients[slot].spawned {
        if let Some(f) = sv.extf.userinfo_changed {
            vm.set_g_f(glob::TIME, sv.time as f32);
            vm.set_g_e(glob::SELF, Server::slot_edict(slot));
            vm.call(sv, f)?;
        }
    }
    Ok(())
}
