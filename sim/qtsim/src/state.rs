// World serialization, cloning and hashing (DESIGN.md "Determinism rules").
// Copyright (C) 2026 Quake Town authors. GPL-2.0-or-later.

use std::sync::Arc;

use qcvm::{Progs, StateHasher, Vm};

use crate::bsp::Map;
use crate::events::{EventSink, MsgBuf};
use crate::info::Info;
use crate::pmove::{MoveVars, UserCmd};
use crate::trace::BoxHull;
use crate::world::*;

const MAGIC: u32 = 0x5754_5451; // "QTTW"

struct W<'a> {
    b: &'a mut Vec<u8>,
}
impl W<'_> {
    fn u32(&mut self, v: u32) {
        self.b.extend_from_slice(&v.to_le_bytes());
    }
    fn i32(&mut self, v: i32) {
        self.u32(v as u32);
    }
    fn u64(&mut self, v: u64) {
        self.b.extend_from_slice(&v.to_le_bytes());
    }
    fn f32(&mut self, v: f32) {
        self.u32(crate::mathlib::canon(v));
    }
    fn f64(&mut self, v: f64) {
        self.u64(if v.is_nan() { 0x7FF8_0000_0000_0000 } else { v.to_bits() });
    }
    fn bytes(&mut self, v: &[u8]) {
        self.u32(v.len() as u32);
        self.b.extend_from_slice(v);
    }
    fn v3(&mut self, v: &[f32; 3]) {
        for x in v {
            self.f32(*x);
        }
    }
}

struct R<'a> {
    b: &'a [u8],
    p: usize,
}
type Res<T> = Result<T, ()>;
impl R<'_> {
    fn take(&mut self, n: usize) -> Res<&[u8]> {
        if self.p + n > self.b.len() {
            return Err(());
        }
        let s = &self.b[self.p..self.p + n];
        self.p += n;
        Ok(s)
    }
    fn u32(&mut self) -> Res<u32> {
        let s = self.take(4)?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn i32(&mut self) -> Res<i32> {
        Ok(self.u32()? as i32)
    }
    fn u64(&mut self) -> Res<u64> {
        let s = self.take(8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(s);
        Ok(u64::from_le_bytes(a))
    }
    fn f32(&mut self) -> Res<f32> {
        Ok(f32::from_bits(self.u32()?))
    }
    fn f64(&mut self) -> Res<f64> {
        Ok(f64::from_bits(self.u64()?))
    }
    fn bytes(&mut self) -> Res<Vec<u8>> {
        let n = self.u32()? as usize;
        if n > self.b.len() {
            return Err(());
        }
        Ok(self.take(n)?.to_vec())
    }
    fn v3(&mut self) -> Res<[f32; 3]> {
        Ok([self.f32()?, self.f32()?, self.f32()?])
    }
    fn count(&mut self, max: usize) -> Res<usize> {
        let n = self.u32()? as usize;
        if n > max {
            return Err(());
        }
        Ok(n)
    }
}

fn w_info(w: &mut W, i: &Info) {
    w.u32(i.pairs.len() as u32);
    for (k, v) in &i.pairs {
        w.bytes(k);
        w.bytes(v);
    }
}
fn r_info(r: &mut R) -> Res<Info> {
    let n = r.count(4096)?;
    let mut i = Info::default();
    for _ in 0..n {
        let k = r.bytes()?;
        let v = r.bytes()?;
        i.pairs.push((k, v));
    }
    Ok(i)
}
fn w_list(w: &mut W, l: &[Vec<u8>]) {
    w.u32(l.len() as u32);
    for s in l {
        w.bytes(s);
    }
}
fn r_list(r: &mut R, max: usize) -> Res<Vec<Vec<u8>>> {
    let n = r.count(max)?;
    (0..n).map(|_| r.bytes()).collect()
}
fn w_cmd(w: &mut W, c: &UserCmd) {
    w.u32(c.msec as u32);
    w.v3(&c.angles);
    w.i32(c.forwardmove as i32);
    w.i32(c.sidemove as i32);
    w.i32(c.upmove as i32);
    w.u32(c.buttons as u32);
    w.u32(c.impulse as u32);
}
fn r_cmd(r: &mut R) -> Res<UserCmd> {
    Ok(UserCmd {
        msec: r.u32()? as u8,
        angles: r.v3()?,
        forwardmove: r.i32()? as i16,
        sidemove: r.i32()? as i16,
        upmove: r.i32()? as i16,
        buttons: r.u32()? as u8,
        impulse: r.u32()? as u8,
    })
}
/// Everything in Server that is state, in a fixed order (used by both serialize and
/// hash so the two can never disagree about what the state is).
fn write_server(w: &mut W, sv: &Server, for_hash: bool) {
    w.u32(sv.map_id);
    w.u64(sv.seed);
    w.u32(sv.tick_count);
    w.u32(sv.map_ticks);
    w.f64(sv.time);
    w.f64(sv.frametime);
    w.u32(sv.maxclients as u32);
    w.u32(sv.bots_enabled as u32);
    w_info(w, &sv.serverinfo);
    w.u32(sv.cvars.len() as u32);
    for (k, v) in &sv.cvars {
        w.bytes(k);
        w.bytes(v);
    }
    let m = &sv.movevars;
    for x in [m.gravity, m.stopspeed, m.maxspeed, m.spectatormaxspeed, m.accelerate, m.airaccelerate, m.wateraccelerate, m.friction, m.waterfriction, m.entgravity] {
        w.f32(x);
    }
    w_list(w, &sv.model_precache);
    w_list(w, &sv.sound_precache);
    w_list(w, &sv.lightstyles);
    w.u32(sv.loading as u32);
    w.f32(sv.serverflags);
    for c in &sv.clients {
        w.u32(c.state as u32);
        w.u32(c.spawned as u32);
        w_info(w, &c.userinfo);
        w.bytes(&c.name);
        w_cmd(w, &c.cmd);
        w.i32(c.oldbuttons);
        for p in &c.spawn_parms {
            w.f32(*p);
        }
        w.f32(c.entgravity);
        w.f32(c.maxspeed);
        for s in &c.stats {
            w.i32(*s);
        }
    }
    if !for_hash {
        w.u32(sv.links.len() as u32);
        for l in &sv.links {
            w.u32(l.prev);
            w.u32(l.next);
        }
    }
    w.i32(sv.lastcheck);
    w.f64(sv.lastchecktime);
    w.bytes(&sv.checkpvs);
    w.u32(sv.statics.len() as u32);
    for s in &sv.statics {
        w.i32(s.modelindex);
        w.i32(s.frame);
        w.i32(s.colormap);
        w.i32(s.skin);
        w.v3(&s.origin);
        w.v3(&s.angles);
    }
    w.u32(sv.ambients.len() as u32);
    for a in &sv.ambients {
        w.i32(a.sound);
        w.i32(a.volume);
        w.i32(a.atten);
        w.v3(&a.origin);
    }
    match &sv.changelevel {
        Some(c) => {
            w.u32(1);
            w.bytes(c);
        }
        None => w.u32(0),
    }
    let ms = &sv.matchstate;
    for x in [ms.phase, ms.endtime, ms.countdown, ms.score1, ms.score2, ms.round] {
        w.f32(x);
    }
    match &sv.intermission {
        Some(o) => {
            w.u32(1);
            w.v3(o);
        }
        None => w.u32(0),
    }
    match &sv.error {
        Some(e) => {
            w.u32(1);
            w.bytes(e.as_bytes());
        }
        None => w.u32(0),
    }
    w.bytes(&sv.spawn_info);
    if !for_hash {
        let mut b = Vec::new();
        sv.botsys.serialize(&mut b);
        w.bytes(&b);
    }
}

/// 4-lane 64-bit multiply-xor mixing over words (independent chains, so it runs at
/// several words per cycle); fed into the StateHasher as one u64
fn lanes_hash(words: impl Iterator<Item = u32>, n: usize) -> u64 {
    const K: [u64; 4] = [0x9e37_79b9_7f4a_7c15, 0xc2b2_ae3d_27d4_eb4f, 0x1656_67b1_9e37_79f9, 0x85eb_ca77_c2b2_ae63];
    let mut l = [K[0] ^ n as u64, K[1], K[2], K[3]];
    let mut i = 0usize;
    for w in words {
        let k = i & 3;
        l[k] = (l[k] ^ w as u64).wrapping_mul(0xff51_afd7_ed55_8ccd).rotate_left(29);
        i += 1;
    }
    let mut h = l[0];
    for x in &l[1..] {
        h = (h ^ x.rotate_left(17)).wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    }
    h ^ (h >> 31)
}

impl World {
    pub fn serialize_into(&self, out: &mut Vec<u8>) {
        out.clear();
        let mut w = W { b: out };
        w.u32(MAGIC);
        w.u32(crate::SIM_VERSION);
        write_server(&mut w, &self.sv, false);
        self.vm.serialize(out);
    }

    /// world_deserialize: progs and maps must be the ones the world was made with.
    pub fn deserialize(progs: Arc<Progs>, maps: Vec<Arc<Map>>, bytes: &[u8]) -> Result<World, String> {
        let mut r = R { b: bytes, p: 0 };
        let bad = |_| "world_deserialize: bad data".to_string();
        if r.u32().map_err(bad)? != MAGIC {
            return Err("world_deserialize: not a world".into());
        }
        if r.u32().map_err(bad)? != crate::SIM_VERSION {
            return Err("world_deserialize: other sim version".into());
        }
        let mut sv = read_server(&mut r, progs.clone(), maps).map_err(bad)?;
        let (vm, _used) = Vm::deserialize(progs, &bytes[r.p..]).map_err(|e| format!("world_deserialize: {e}"))?;
        if vm.max_edicts() != sv.max_edicts || vm.client_edicts() as usize != sv.maxclients {
            return Err("world_deserialize: vm/world mismatch".into());
        }
        sv.playertouch = vec![0u8; (sv.max_edicts as usize + 7) / 8];
        Ok(World { vm, sv })
    }

    /// world_hash: the whole state, NaN-canonical, events excluded.
    pub fn hash(&self) -> u32 {
        thread_local! {
            static BUF: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
        }
        let mut h = StateHasher::new();
        BUF.with(|b| {
            let mut buf = b.borrow_mut();
            buf.clear();
            let mut w = W { b: &mut buf };
            write_server(&mut w, &self.sv, true);
            let n = buf.len();
            buf.resize((n + 3) & !3, 0);
            let words = buf.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]));
            h.u64(lanes_hash(words, n));
        });
        let links = &self.sv.links;
        h.u64(lanes_hash(links.iter().flat_map(|l| [l.prev, l.next]), links.len()));
        h.u64(self.sv.botsys.hash());
        self.vm.hash_into(&mut h);
        h.finish32()
    }
}

fn read_server(r: &mut R, progs: Arc<Progs>, maps: Vec<Arc<Map>>) -> Res<Server> {
    let map_id = r.u32()?;
    let map = maps.get(map_id as usize).cloned().ok_or(())?;
    let seed = r.u64()?;
    let tick_count = r.u32()?;
    let map_ticks = r.u32()?;
    let time = r.f64()?;
    let frametime = r.f64()?;
    let maxclients = r.u32()? as usize;
    if !(1..=32).contains(&maxclients) {
        return Err(());
    }
    let bots_enabled = r.u32()? != 0;
    let serverinfo = r_info(r)?;
    let n = r.count(65536)?;
    let mut cvars = std::collections::BTreeMap::new();
    for _ in 0..n {
        let k = r.bytes()?;
        let v = r.bytes()?;
        cvars.insert(k, v);
    }
    let movevars = MoveVars {
        gravity: r.f32()?,
        stopspeed: r.f32()?,
        maxspeed: r.f32()?,
        spectatormaxspeed: r.f32()?,
        accelerate: r.f32()?,
        airaccelerate: r.f32()?,
        wateraccelerate: r.f32()?,
        friction: r.f32()?,
        waterfriction: r.f32()?,
        entgravity: r.f32()?,
    };
    let model_precache = r_list(r, MAX_MODELS)?;
    let sound_precache = r_list(r, MAX_SOUNDS)?;
    let lightstyles = r_list(r, MAX_LIGHTSTYLES)?;
    if lightstyles.len() != MAX_LIGHTSTYLES || model_precache.len() < 2 || sound_precache.is_empty() {
        return Err(());
    }
    let loading = r.u32()? != 0;
    let serverflags = r.f32()?;
    let mut clients = Vec::with_capacity(maxclients);
    for _ in 0..maxclients {
        let mut c = Client::new();
        c.state = r.u32()? as u8;
        if c.state > CS_IDLE {
            return Err(());
        }
        c.spawned = r.u32()? != 0;
        c.userinfo = r_info(r)?;
        c.name = r.bytes()?;
        c.cmd = r_cmd(r)?;
        c.oldbuttons = r.i32()?;
        for p in c.spawn_parms.iter_mut() {
            *p = r.f32()?;
        }
        c.entgravity = r.f32()?;
        c.maxspeed = r.f32()?;
        for s in c.stats.iter_mut() {
            *s = r.i32()?;
        }
        clients.push(c);
    }
    let nlinks = r.count(1 << 20)?;
    let mut links = Vec::with_capacity(nlinks);
    for _ in 0..nlinks {
        links.push(Link { prev: r.u32()?, next: r.u32()? });
    }
    let lastcheck = r.i32()?;
    let lastchecktime = r.f64()?;
    let checkpvs = r.bytes()?;
    let n = r.count(1 << 16)?;
    let mut statics = Vec::with_capacity(n);
    for _ in 0..n {
        statics.push(StaticEnt {
            modelindex: r.i32()?,
            frame: r.i32()?,
            colormap: r.i32()?,
            skin: r.i32()?,
            origin: r.v3()?,
            angles: r.v3()?,
        });
    }
    let n = r.count(1 << 16)?;
    let mut ambients = Vec::with_capacity(n);
    for _ in 0..n {
        ambients.push(Ambient { sound: r.i32()?, volume: r.i32()?, atten: r.i32()?, origin: r.v3()? });
    }
    let changelevel = if r.u32()? != 0 { Some(r.bytes()?) } else { None };
    let matchstate = MatchState {
        phase: r.f32()?,
        endtime: r.f32()?,
        countdown: r.f32()?,
        score1: r.f32()?,
        score2: r.f32()?,
        round: r.f32()?,
    };
    let intermission = if r.u32()? != 0 { Some(r.v3()?) } else { None };
    let error = if r.u32()? != 0 { Some(String::from_utf8_lossy(&r.bytes()?).to_string()) } else { None };
    let spawn_info = r.bytes()?;
    let bb = r.bytes()?;
    let (botsys, used) = crate::bots::BotSys::deserialize(&bb).map_err(|_| ())?;
    if used != bb.len() {
        return Err(());
    }

    let ext = ExtFields {
        gravity: progs.find_field("gravity").map(|d| d.ofs),
        maxspeed: progs.find_field("maxspeed").map(|d| d.ofs),
        alpha: progs.find_field("alpha").map(|d| d.ofs),
    };
    let extf = ExtFuncs {
        parse_client_command: progs.find_function("SV_ParseClientCommand"),
        userinfo_changed: progs.find_function("UserInfo_Changed"),
    };
    let mut sv = Server {
        progs,
        maps,
        map_id,
        map,
        ext,
        extf,
        seed,
        tick_count,
        map_ticks,
        tick_msec: crate::world::TICK_MSEC, // set at the start of every tick
        time,
        frametime,
        maxclients,
        bots_enabled,
        serverinfo,
        cvars,
        movevars,
        model_precache,
        sound_precache,
        model_sub: Vec::new(),
        lightstyles,
        loading,
        serverflags,
        clients,
        botsys,
        spawn_info,
        static_brushes: None,
        areanodes: Vec::new(),
        links: Vec::new(),
        max_edicts: 0,
        lastcheck,
        lastchecktime,
        checkpvs,
        statics,
        ambients,
        changelevel,
        matchstate,
        intermission,
        error,
        sink: EventSink::default(),
        pending: EventSink::default(),
        buf_all: MsgBuf::default(),
        buf_multicast: MsgBuf::default(),
        buf_one: vec![MsgBuf::default(); maxclients],
        boxhull: Box::new(BoxHull::new()),
        physents: Vec::with_capacity(crate::pmove::MAX_PHYSENTS),
        playertouch: Vec::new(),
        log: Vec::new(),
        log_enabled: false,
    };
    // derived: area nodes from the map (always 31 for AREA_DEPTH 4)
    sv.max_edicts = 0;
    sv.clear_world();
    let nn = sv.areanodes.len() * 2;
    if nlinks < nn + 2 {
        return Err(());
    }
    sv.max_edicts = (nlinks - nn) as u32;
    sv.clear_world();
    if !links_valid(&links, sv.max_edicts as usize) {
        return Err(());
    }
    sv.links = links;
    sv.update_model_sub();
    Ok(sv)
}

/// every area list is a proper cycle through its head and every linked edict is in
/// exactly one list (so a bad snapshot cannot make list walks loop forever)
fn links_valid(links: &[Link], max_edicts: usize) -> bool {
    let n = links.len();
    let nil = u32::MAX;
    let mut seen = vec![false; max_edicts];
    for head in max_edicts..n {
        let mut at = head;
        let mut steps = 0;
        loop {
            let l = links[at];
            if l.next == nil || l.next as usize >= n {
                return false;
            }
            if links[l.next as usize].prev as usize != at {
                return false;
            }
            at = l.next as usize;
            if at == head {
                break;
            }
            if at >= max_edicts || seen[at] {
                return false;
            }
            seen[at] = true;
            steps += 1;
            if steps > max_edicts {
                return false;
            }
        }
    }
    (0..max_edicts).all(|e| (links[e].prev == nil) == !seen[e] && (links[e].next == nil) == !seen[e])
}
