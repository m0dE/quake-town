// Quake Town - qcvm: builtins that need no world (port of parts of QW/server/pr_cmds.c,
// plus the FTE string/math extensions by number)
// Copyright (C) 1996-1997 Id Software, Inc.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.

use crate::defs::{fld, glob};
use crate::error::{ErrorKind, VmError};
use crate::math;
use crate::parse::{atof, com_parse, ftos, vtos};
use crate::vm::Vm;
use crate::{Host, Print};

/// Most tokens `tokenize` keeps.
pub const MAX_TOKENS: usize = 80;

/// Builtin numbers the VM implements (the host never sees them).
pub const PURE_BUILTINS: &[u32] = &[
    1, 6, 7, 9, 10, 11, 12, 13, 18, 22, 25, 26, 27, 28, 29, 30, 31, 36, 37, 38, 43, 47, 51, 60, 61, 62, 81, 94, 95,
    96, 97, 114, 115, 116, 117, 118, 119, 441, 442,
];

/// Run builtin `num` if it is one of the VM's; None otherwise.
pub(crate) fn builtin<H: Host + ?Sized>(vm: &mut Vm, host: &mut H, num: u32) -> Option<Result<(), VmError>> {
    let r = match num {
        1 => {
            let (f, r, u) = math::angle_vectors(vm.parm_v(0));
            vm.set_g_v(glob::V_FORWARD, f);
            vm.set_g_v(glob::V_RIGHT, r);
            vm.set_g_v(glob::V_UP, u);
            Ok(())
        }
        6 => Err(VmError::new(ErrorKind::Break, "break statement")),
        7 => {
            let x = vm.rng.qc_random();
            vm.ret_f(x);
            Ok(())
        }
        9 => {
            let v = math::normalize(vm.parm_v(0));
            vm.ret_v(v);
            Ok(())
        }
        10 | 11 => {
            let s = vm.var_string(0);
            let fname = String::from_utf8_lossy(vm.progs.function_name(vm.xfunction)).into_owned();
            let kind = if num == 10 { "SERVER" } else { "OBJECT" };
            let mut text = format!("======{} ERROR in {}:\n{}\n", kind, fname, String::from_utf8_lossy(&s)).into_bytes();
            let selfe = vm.g_e(glob::SELF);
            text.extend_from_slice(&vm.edict_text(selfe));
            host.print(vm, Print::Error, &text);
            let k = if num == 10 { ErrorKind::QcError } else { ErrorKind::ObjError };
            Err(VmError::new(k, String::from_utf8_lossy(&text).into_owned()))
        }
        12 => {
            let x = math::vlen(vm.parm_v(0));
            vm.ret_f(x);
            Ok(())
        }
        13 => {
            let x = math::vectoyaw(vm.parm_v(0));
            vm.ret_f(x);
            Ok(())
        }
        18 => find(vm),
        22 => {
            findradius(vm);
            Ok(())
        }
        25 => {
            let s = vm.var_string(0);
            host.print(vm, Print::Dprint, &s);
            Ok(())
        }
        26 => {
            let s = ftos(vm.parm_f(0));
            vm.ret_temp(&s)
        }
        27 => {
            let s = vtos(vm.parm_v(0));
            vm.ret_temp(&s)
        }
        28 => {
            for e in 0..vm.num_edicts() {
                let t = vm.edict_text(e);
                host.print(vm, Print::Eprint, &t);
            }
            Ok(())
        }
        29 | 30 => Ok(()), // traceon / traceoff
        31 => match vm.parm_ent(0) {
            Ok(e) => {
                let t = vm.edict_text(e);
                host.print(vm, Print::Eprint, &t);
                Ok(())
            }
            Err(e) => Err(e),
        },
        36 => {
            let f = vm.parm_f(0);
            let r = if f > 0.0 { (f as f64 + 0.5) as i32 } else { (f as f64 - 0.5) as i32 };
            vm.ret_f(r as f32);
            Ok(())
        }
        37 => {
            let x = libm::floor(vm.parm_f(0) as f64) as f32;
            vm.ret_f(x);
            Ok(())
        }
        38 => {
            let x = libm::ceil(vm.parm_f(0) as f64) as f32;
            vm.ret_f(x);
            Ok(())
        }
        43 => {
            let x = vm.parm_f(0).abs();
            vm.ret_f(x);
            Ok(())
        }
        47 => nextent(vm),
        51 => {
            let v = math::vectoangles(vm.parm_v(0));
            vm.ret_v(v);
            Ok(())
        }
        60 => {
            let x = libm::sin(vm.parm_f(0) as f64) as f32;
            vm.ret_f(x);
            Ok(())
        }
        61 => {
            let x = libm::cos(vm.parm_f(0) as f64) as f32;
            vm.ret_f(x);
            Ok(())
        }
        62 => {
            let x = vm.parm_f(0).sqrt();
            vm.ret_f(x);
            Ok(())
        }
        81 => {
            let x = atof(vm.parm_str(0)) as f32;
            vm.ret_f(x);
            Ok(())
        }
        94 | 95 => {
            let n = vm.argc().max(1) as u32;
            let mut r = vm.parm_f(0);
            for i in 1..n.min(8) {
                let x = vm.parm_f(i);
                r = if num == 94 { if x < r { x } else { r } } else if x > r { x } else { r };
            }
            vm.ret_f(r);
            Ok(())
        }
        96 => {
            let (lo, v, hi) = (vm.parm_f(0), vm.parm_f(1), vm.parm_f(2));
            let m = if v < hi { v } else { hi };
            let r = if lo > m { lo } else { m };
            vm.ret_f(r);
            Ok(())
        }
        97 => {
            let x = libm::pow(vm.parm_f(0) as f64, vm.parm_f(1) as f64) as f32;
            vm.ret_f(x);
            Ok(())
        }
        114 => {
            let n = vm.parm_str(0).len();
            vm.ret_f(n as f32);
            Ok(())
        }
        115 => {
            let s = vm.var_string(0);
            vm.ret_temp(&s)
        }
        116 => {
            let s = vm.parm_str(0);
            let slen = s.len() as i64;
            let mut start = vm.parm_f(1) as i64;
            let mut length = vm.parm_f(2) as i64;
            if start < 0 {
                start += slen;
            }
            if length < 0 {
                length = slen - start + (length + 1);
            }
            if start < 0 {
                start = 0;
            }
            let out: Vec<u8> = if start >= slen || length <= 0 {
                Vec::new()
            } else {
                let length = length.min(slen - start);
                s[start as usize..(start + length) as usize].to_vec()
            };
            vm.ret_temp(&out)
        }
        117 => {
            let v = stov(vm.parm_str(0));
            vm.ret_v(v);
            Ok(())
        }
        118 => {
            let s = vm.var_string(0);
            match vm.zone_string(&s) {
                Ok(h) => {
                    vm.ret_s(h);
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        119 => {
            let h = vm.parm_s(0);
            vm.unzone(h);
            Ok(())
        }
        441 => {
            let mut toks = Vec::new();
            let s = vm.parm_str(0).to_vec();
            let mut d = &s[..];
            while toks.len() < MAX_TOKENS {
                match com_parse(d) {
                    Some((t, r)) => {
                        toks.push(t);
                        d = r;
                    }
                    None => break,
                }
            }
            let n = toks.len();
            vm.tokens = toks;
            vm.ret_f(n as f32);
            Ok(())
        }
        442 => {
            let mut i = vm.parm_f(0) as i64;
            let n = vm.tokens.len() as i64;
            if i < 0 {
                i += n;
            }
            let t = if i >= 0 && i < n { vm.tokens[i as usize].clone() } else { Vec::new() };
            vm.ret_temp(&t)
        }
        _ => return None,
    };
    Some(r)
}

fn find(vm: &mut Vm) -> Result<(), VmError> {
    let mut e = vm.parm_ent(0)?;
    let f = vm.parm_i(1);
    if f < 0 || f as u32 >= vm.ef {
        return Err(VmError::new(ErrorKind::BadField, format!("find: bad field {}", f)));
    }
    let s = vm.parm_s(2);
    e += 1;
    while e < vm.num_edicts {
        if !vm.meta[e as usize].free {
            let t = vm.e_s(e, f as u32);
            if vm.string(t) == vm.string(s) {
                vm.ret_e(e);
                return Ok(());
            }
        }
        e += 1;
    }
    vm.ret_e(0);
    Ok(())
}

fn nextent(vm: &mut Vm) -> Result<(), VmError> {
    let mut i = vm.parm_ent(0)?;
    loop {
        i += 1;
        if i >= vm.num_edicts {
            vm.ret_e(0);
            return Ok(());
        }
        if !vm.meta[i as usize].free {
            vm.ret_e(i);
            return Ok(());
        }
    }
}

fn findradius(vm: &mut Vm) {
    const SOLID_NOT: f32 = 0.0;
    let org = vm.parm_v(0);
    let rad = vm.parm_f(1);
    let mut chain = 0u32;
    for i in 1..vm.num_edicts {
        if vm.meta[i as usize].free {
            continue;
        }
        if vm.e_f(i, fld::SOLID) == SOLID_NOT {
            continue;
        }
        let o = vm.e_v(i, fld::ORIGIN);
        let mn = vm.e_v(i, fld::MINS);
        let mx = vm.e_v(i, fld::MAXS);
        let mut eorg = [0f32; 3];
        for j in 0..3 {
            eorg[j] = (org[j] as f64 - (o[j] as f64 + (mn[j] + mx[j]) as f64 * 0.5)) as f32;
        }
        if math::vlen(eorg) > rad {
            continue;
        }
        vm.set_e_e(i, fld::CHAIN, chain);
        chain = i;
    }
    vm.ret_e(chain);
}

/// FTE `stov`: optional leading quote, three floats separated by spaces/tabs.
fn stov(s: &[u8]) -> [f32; 3] {
    let mut i = 0;
    if s.first() == Some(&b'\'') {
        i = 1;
    }
    let mut v = [0f32; 3];
    for k in 0..3 {
        while i < s.len() && (s[i] == b' ' || s[i] == b'\t') {
            i += 1;
        }
        v[k] = atof(&s[i..]) as f32;
        while i < s.len() && s[i] != b' ' && s[i] != b'\t' {
            i += 1;
        }
    }
    v
}
