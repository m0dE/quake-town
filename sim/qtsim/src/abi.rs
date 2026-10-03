// The wasm ABI (DESIGN.md "The wasm ABI"): the only interface between Rust and TS.
// All functions are extern "C" / #[no_mangle]; pointers are offsets into the wasm
// memory; little-endian. Returned buffers stay valid until the next call on the same
// world (or the next content call for content buffers).
// Copyright (C) 2026 Quake Town authors. GPL-2.0-or-later.

use std::cell::RefCell;
use std::sync::Arc;

use qcvm::Progs;

use crate::bsp::Map;
use crate::World;

struct Slot {
    world: World,
    progs_id: u32,
    /// per-world view buffers
    words: Vec<u32>,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct State {
    progs: Vec<Arc<Progs>>,
    maps: Vec<Arc<Map>>,
    map_names: Vec<Vec<u8>>,
    worlds: Vec<Option<Slot>>,
    buf: Vec<u8>,
    error: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

fn set_error(s: &mut State, msg: &str) {
    s.error.clear();
    s.error.extend(msg.bytes().filter(|&c| c != 0));
    s.error.push(0);
}

fn slot(s: &mut State, h: u32) -> Option<&mut Slot> {
    if h == 0 {
        return None;
    }
    s.worlds.get_mut(h as usize - 1).and_then(|w| w.as_mut())
}

fn add_world(s: &mut State, world: World, progs_id: u32) -> u32 {
    let sl = Slot { world, progs_id, words: Vec::new(), bytes: Vec::new() };
    if let Some(i) = s.worlds.iter().position(|w| w.is_none()) {
        s.worlds[i] = Some(sl);
        return i as u32 + 1;
    }
    s.worlds.push(Some(sl));
    s.worlds.len() as u32
}

/// # Safety
/// `ptr` must point to `len` readable bytes (or len = 0).
unsafe fn bytes<'a>(ptr: *const u8, len: u32) -> &'a [u8] {
    if len == 0 || ptr.is_null() {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len as usize)
    }
}

// ---------------------------------------------------------------- memory

#[no_mangle]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(len.max(1) as usize);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`len` must come from `alloc`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: u32) {
    if ptr.is_null() {
        return;
    }
    drop(Vec::from_raw_parts(ptr, 0, len.max(1) as usize));
}

#[no_mangle]
pub extern "C" fn sim_version() -> u32 {
    crate::SIM_VERSION
}

#[no_mangle]
pub extern "C" fn last_error_ptr() -> *const u8 {
    with(|s| {
        if s.error.is_empty() {
            s.error.push(0);
        }
        s.error.as_ptr()
    })
}

// ---------------------------------------------------------------- content

/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn progs_load(ptr: *const u8, len: u32) -> i32 {
    let b = bytes(ptr, len);
    with(|s| match Progs::load(b) {
        Ok(p) => {
            s.progs.push(p);
            (s.progs.len() - 1) as i32
        }
        Err(e) => {
            set_error(s, &format!("progs_load: {e}"));
            e.code().min(-1)
        }
    })
}

/// # Safety
/// `name_ptr`/`ptr` must point to readable bytes of the given lengths.
#[no_mangle]
pub unsafe extern "C" fn map_load(name_ptr: *const u8, name_len: u32, ptr: *const u8, len: u32) -> i32 {
    let name = String::from_utf8_lossy(bytes(name_ptr, name_len)).to_string();
    let b = bytes(ptr, len);
    with(|s| {
        if b.len() > 32 << 20 {
            set_error(s, "map_load: BSP larger than 32 MB");
            return -2;
        }
        match Map::load(&name, b) {
            Ok(m) => {
                let mut n = name.clone().into_bytes();
                n.push(0);
                s.map_names.push(n);
                s.maps.push(Arc::new(m));
                (s.maps.len() - 1) as i32
            }
            Err(e) => {
                set_error(s, &format!("map_load {name}: {e}"));
                -1
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn map_name(map_id: u32) -> *const u8 {
    with(|s| s.map_names.get(map_id as usize).map(|n| n.as_ptr()).unwrap_or(std::ptr::null()))
}

#[no_mangle]
pub extern "C" fn map_count() -> u32 {
    with(|s| s.maps.len() as u32)
}

// ---------------------------------------------------------------- worlds

/// # Safety
/// `info_ptr` must point to `info_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn world_new(progs_id: u32, map_id: u32, seed: u32, info_ptr: *const u8, info_len: u32) -> u32 {
    let info = bytes(info_ptr, info_len).to_vec();
    with(|s| {
        let progs = match s.progs.get(progs_id as usize) {
            Some(p) => p.clone(),
            None => {
                set_error(s, "world_new: bad progs id");
                return 0;
            }
        };
        if map_id as usize >= s.maps.len() {
            set_error(s, "world_new: bad map id");
            return 0;
        }
        match World::new(progs, s.maps.clone(), map_id, seed, &info) {
            Ok(w) => add_world(s, w, progs_id),
            Err(e) => {
                set_error(s, &e);
                0
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn world_free(h: u32) {
    with(|s| {
        if h > 0 && (h as usize) <= s.worlds.len() {
            s.worlds[h as usize - 1] = None;
        }
    })
}

#[no_mangle]
pub extern "C" fn world_clone(h: u32) -> u32 {
    with(|s| {
        let (w, p) = match slot(s, h) {
            Some(sl) => (sl.world.clone(), sl.progs_id),
            None => return 0,
        };
        add_world(s, w, p)
    })
}

#[no_mangle]
pub extern "C" fn world_serialize(h: u32) -> u32 {
    with(|s| {
        let mut buf = std::mem::take(&mut s.buf);
        let n = match slot(s, h) {
            Some(sl) => {
                // the progs id travels with the world so deserialize can pick it
                sl.world.serialize_into(&mut buf);
                buf.extend_from_slice(&sl.progs_id.to_le_bytes());
                buf.len() as u32
            }
            None => {
                buf.clear();
                0
            }
        };
        s.buf = buf;
        n
    })
}

#[no_mangle]
pub extern "C" fn world_buf_ptr() -> *const u8 {
    with(|s| s.buf.as_ptr())
}

/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn world_deserialize(ptr: *const u8, len: u32) -> u32 {
    let b = bytes(ptr, len);
    with(|s| {
        if b.len() < 8 {
            set_error(s, "world_deserialize: too short");
            return 0;
        }
        let (body, tail) = b.split_at(b.len() - 4);
        let progs_id = u32::from_le_bytes([tail[0], tail[1], tail[2], tail[3]]);
        let progs = match s.progs.get(progs_id as usize) {
            Some(p) => p.clone(),
            None => {
                set_error(s, "world_deserialize: progs not loaded");
                return 0;
            }
        };
        match World::deserialize(progs, s.maps.clone(), body) {
            Ok(w) => add_world(s, w, progs_id),
            Err(e) => {
                set_error(s, &e);
                0
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn world_hash(h: u32) -> u32 {
    with(|s| slot(s, h).map(|sl| sl.world.hash()).unwrap_or(0))
}

#[no_mangle]
pub extern "C" fn world_tick_count(h: u32) -> u32 {
    with(|s| slot(s, h).map(|sl| sl.world.sv.tick_count).unwrap_or(0))
}

#[no_mangle]
pub extern "C" fn world_map(h: u32) -> u32 {
    with(|s| slot(s, h).map(|sl| sl.world.sv.map_id).unwrap_or(0))
}

/// 1 if the world stopped on a fatal QuakeC error (text in last_error_ptr)
#[no_mangle]
pub extern "C" fn world_stopped(h: u32) -> u32 {
    with(|s| {
        let msg = slot(s, h).and_then(|sl| sl.world.sv.error.clone());
        match msg {
            Some(m) => {
                set_error(s, &m);
                1
            }
            None => 0,
        }
    })
}

// ---------------------------------------------------------------- membership

#[no_mangle]
pub extern "C" fn world_free_slot(h: u32) -> i32 {
    with(|s| slot(s, h).map(|sl| sl.world.free_slot()).unwrap_or(-1))
}

/// # Safety
/// `ui_ptr` must point to `ui_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn world_client_join(h: u32, slot_: u32, ui_ptr: *const u8, ui_len: u32) {
    let ui = bytes(ui_ptr, ui_len).to_vec();
    with(|s| {
        if let Some(sl) = slot(s, h) {
            sl.world.client_join(slot_ as usize, &ui)
        }
    })
}

#[no_mangle]
pub extern "C" fn world_client_leave(h: u32, slot_: u32) {
    with(|s| {
        if let Some(sl) = slot(s, h) {
            sl.world.client_leave(slot_ as usize)
        }
    })
}

#[no_mangle]
pub extern "C" fn world_client_idle(h: u32, slot_: u32) {
    with(|s| {
        if let Some(sl) = slot(s, h) {
            sl.world.client_idle(slot_ as usize)
        }
    })
}

/// # Safety
/// `ui_ptr` must point to `ui_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn world_set_userinfo(h: u32, slot_: u32, ui_ptr: *const u8, ui_len: u32) {
    let ui = bytes(ui_ptr, ui_len).to_vec();
    with(|s| {
        if let Some(sl) = slot(s, h) {
            sl.world.set_userinfo(slot_ as usize, &ui)
        }
    })
}

/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn world_client_command(h: u32, slot_: u32, ptr: *const u8, len: u32) {
    let text = bytes(ptr, len).to_vec();
    with(|s| {
        if let Some(sl) = slot(s, h) {
            sl.world.client_command(slot_ as usize, &text)
        }
    })
}

// ---------------------------------------------------------------- input / tick

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn world_set_cmd(h: u32, slot_: u32, pitch16: i32, yaw16: i32, forward: i32, side: i32, up: i32, buttons: i32, impulse: i32) {
    with(|s| {
        if let Some(sl) = slot(s, h) {
            sl.world.set_cmd(slot_ as usize, pitch16, yaw16, forward, side, up, buttons, impulse)
        }
    })
}

#[no_mangle]
pub extern "C" fn world_tick(h: u32) {
    with(|s| {
        if let Some(sl) = slot(s, h) {
            sl.world.tick()
        }
    })
}

// ---------------------------------------------------------------- views

fn words_view(h: u32, f: impl FnOnce(&World, &mut Vec<u32>)) -> *const u32 {
    with(|s| match slot(s, h) {
        Some(sl) => {
            let mut v = std::mem::take(&mut sl.words);
            f(&sl.world, &mut v);
            sl.words = v;
            sl.words.as_ptr()
        }
        None => std::ptr::null(),
    })
}

fn bytes_view(h: u32, f: impl FnOnce(&World, &mut Vec<u8>)) -> *const u8 {
    with(|s| match slot(s, h) {
        Some(sl) => {
            let mut v = std::mem::take(&mut sl.bytes);
            f(&sl.world, &mut v);
            sl.bytes = v;
            sl.bytes.as_ptr()
        }
        None => std::ptr::null(),
    })
}

#[no_mangle]
pub extern "C" fn world_view_ents(h: u32) -> *const u32 {
    words_view(h, |w, v| w.view_ents(v))
}

#[no_mangle]
pub extern "C" fn world_view_client(h: u32, slot_: u32) -> *const u32 {
    words_view(h, |w, v| w.view_client(slot_ as usize, v))
}

#[no_mangle]
pub extern "C" fn world_view_clients(h: u32) -> *const u32 {
    words_view(h, |w, v| w.view_clients(v))
}

#[no_mangle]
pub extern "C" fn world_client_info(h: u32, slot_: u32) -> *const u8 {
    bytes_view(h, |w, v| w.client_info(slot_ as usize, v))
}

#[no_mangle]
pub extern "C" fn world_events(h: u32) -> *const u32 {
    words_view(h, |w, v| w.view_events(v))
}

#[no_mangle]
pub extern "C" fn world_strings(h: u32) -> *const u8 {
    bytes_view(h, |w, v| w.event_strings(v))
}

#[no_mangle]
pub extern "C" fn world_model_names(h: u32) -> *const u8 {
    bytes_view(h, |w, v| w.model_names(v))
}

#[no_mangle]
pub extern "C" fn world_sound_names(h: u32) -> *const u8 {
    bytes_view(h, |w, v| w.sound_names(v))
}

#[no_mangle]
pub extern "C" fn world_lightstyles(h: u32) -> *const u8 {
    bytes_view(h, |w, v| w.lightstyle_names(v))
}

#[no_mangle]
pub extern "C" fn world_serverinfo(h: u32) -> *const u8 {
    bytes_view(h, |w, v| w.serverinfo(v))
}

/// (extension) u32 count, then count × (sound, volume, atten×64, x, y, z f32)
#[no_mangle]
pub extern "C" fn world_ambients(h: u32) -> *const u32 {
    words_view(h, |w, v| w.view_ambients(v))
}

// ---------------------------------------------------------------- tests / tools

/// # Safety
/// pointers must point to readable bytes of the given lengths.
#[no_mangle]
pub unsafe extern "C" fn world_set_cvar(h: u32, name_ptr: *const u8, name_len: u32, value_ptr: *const u8, value_len: u32) {
    let name = bytes(name_ptr, name_len).to_vec();
    let value = bytes(value_ptr, value_len).to_vec();
    with(|s| {
        if let Some(sl) = slot(s, h) {
            sl.world.set_cvar(&name, &value)
        }
    })
}
