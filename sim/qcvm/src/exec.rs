// Quake Town - qcvm: the interpreter (port of QW/server/pr_exec.c)
// Copyright (C) 1996-1997 Id Software, Inc.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.

use crate::defs::{fld, glob, op, OFS_PARM0, OFS_RETURN};
use crate::error::{ErrorKind, VmError};
use crate::progs::Progs;
use crate::vm::{Frame, Vm};
use crate::{canon, Func, Host};
use std::sync::Arc;

#[inline(always)]
fn b2f(b: bool) -> u32 {
    if b {
        0x3F80_0000
    } else {
        0
    }
}

impl Vm {
    /// Run QC function `f` (PR_ExecuteProgram). Re-entrant from builtins.
    pub fn call<H: Host + ?Sized>(&mut self, host: &mut H, f: Func) -> Result<(), VmError> {
        if let Some(e) = &self.stopped {
            let mut e2 = VmError::new(ErrorKind::Stopped, format!("VM stopped: {}", e.message));
            e2.trace = e.trace.clone();
            return Err(e2);
        }
        match self.execute(host, f) {
            Ok(()) => Ok(()),
            Err(e) => Err(self.fail(e)),
        }
    }

    /// Call a function by name; Ok(false) if no such function.
    pub fn call_name<H: Host + ?Sized>(&mut self, host: &mut H, name: &str) -> Result<bool, VmError> {
        match self.progs.find_function(name) {
            Some(f) => self.call(host, f).map(|_| true),
            None => Ok(false),
        }
    }

    #[inline]
    fn enter_function(&mut self, progs: &Progs, fnum: u32, ret_s: i32) -> Result<i32, VmError> {
        let f = &progs.functions[fnum as usize];
        if self.stack.len() >= self.cfg.max_depth as usize {
            return Err(VmError::new(ErrorKind::StackOverflow, "stack overflow"));
        }
        self.stack.push(Frame { s: ret_s, f: self.xfunction });
        let c = f.locals as usize;
        let ps = f.parm_start as usize;
        if self.localstack.len() + c > self.cfg.local_stack as usize {
            return Err(VmError::new(ErrorKind::LocalStackOverflow, "PR_ExecuteProgram: locals stack overflow"));
        }
        // Progs::load guarantees parm_start + locals <= globals_len.
        self.localstack.extend_from_slice(&self.globals[ps..ps + c]);
        let mut o = ps;
        for i in 0..f.numparms as usize {
            for j in 0..f.parm_size[i] as usize {
                self.globals[o] = self.globals[OFS_PARM0 as usize + i * 3 + j];
                o += 1;
            }
        }
        self.xfunction = fnum;
        Ok(f.first_statement)
    }

    #[inline]
    fn leave_function(&mut self, progs: &Progs) -> Result<i32, VmError> {
        let f = &progs.functions[self.xfunction as usize];
        let c = f.locals as usize;
        let ps = f.parm_start as usize;
        if self.localstack.len() < c || self.stack.is_empty() {
            return Err(VmError::new(ErrorKind::LocalStackOverflow, "PR_ExecuteProgram: locals stack underflow"));
        }
        let start = self.localstack.len() - c;
        self.globals[ps..ps + c].copy_from_slice(&self.localstack[start..]);
        self.localstack.truncate(start);
        let fr = self.stack.pop().unwrap_or(Frame { s: 0, f: 0 });
        self.xfunction = fr.f;
        Ok(fr.s)
    }

    pub(crate) fn dispatch_builtin<H: Host + ?Sized>(&mut self, host: &mut H, num: u32) -> Result<(), VmError> {
        match crate::pure::builtin(self, host, num) {
            Some(r) => r,
            None => host.builtin(self, num),
        }
    }

    #[allow(unused_assignments)]
    fn execute<H: Host + ?Sized>(&mut self, host: &mut H, fnum: Func) -> Result<(), VmError> {
        let progs: Arc<Progs> = self.progs.clone();
        if fnum == 0 {
            return Err(VmError::new(ErrorKind::NullFunction, "PR_ExecuteProgram: NULL function"));
        }
        let first = match progs.functions.get(fnum as usize) {
            Some(f) => f.first_statement,
            None => return Err(VmError::new(ErrorKind::BadFunction, format!("bad function number {}", fnum))),
        };
        if first < 0 {
            self.argc = 0;
            return self.dispatch_builtin(host, first.unsigned_abs());
        }
        let stmts = &progs.statements[..];
        let ef = self.ef as usize;
        let exitdepth = self.stack.len();
        let mut s = self.enter_function(&progs, fnum, self.xstatement)?;

        // Budget: `n` statements since the last sync; `limit` = how many may run before
        // either the per-call runaway or the total budget is exhausted.
        let mut run_left: u64 = self.cfg.runaway;
        let mut n: u64 = 0;
        let mut limit: u64 = run_left.min(self.budget);
        if limit == 0 {
            self.xstatement = s;
            return Err(VmError::new(ErrorKind::Runaway, "runaway loop error (budget exhausted)"));
        }

        #[allow(unused_assignments)]
        macro_rules! sync {
            () => {{
                run_left -= n;
                self.budget -= n;
                self.instructions += n;
                n = 0;
                limit = run_left.min(self.budget);
            }};
        }
        macro_rules! err {
            ($k:expr, $($m:tt)*) => {{
                sync!();
                self.xstatement = s;
                return Err(VmError::new($k, format!($($m)*)));
            }};
        }
        macro_rules! gi {
            ($i:expr) => {
                self.globals[$i]
            };
        }
        macro_rules! gf {
            ($i:expr) => {
                f32::from_bits(self.globals[$i])
            };
        }
        macro_rules! setf {
            ($i:expr, $v:expr) => {
                self.globals[$i] = canon($v).to_bits()
            };
        }

        loop {
            let st = match stmts.get(s as usize) {
                Some(st) => *st,
                None => err!(ErrorKind::BadStatement, "statement {} out of range", s),
            };
            n += 1;
            if n >= limit {
                sync!();
                if limit == 0 {
                    err!(ErrorKind::Runaway, "runaway loop error");
                }
            }
            let (a, b, c) = (st.a as usize, st.b as usize, st.c as usize);
            match st.op {
                op::ADD_F => setf!(c, gf!(a) + gf!(b)),
                op::ADD_V => {
                    setf!(c, gf!(a) + gf!(b));
                    setf!(c + 1, gf!(a + 1) + gf!(b + 1));
                    setf!(c + 2, gf!(a + 2) + gf!(b + 2));
                }
                op::SUB_F => setf!(c, gf!(a) - gf!(b)),
                op::SUB_V => {
                    setf!(c, gf!(a) - gf!(b));
                    setf!(c + 1, gf!(a + 1) - gf!(b + 1));
                    setf!(c + 2, gf!(a + 2) - gf!(b + 2));
                }
                op::MUL_F => setf!(c, gf!(a) * gf!(b)),
                op::MUL_V => setf!(c, gf!(a) * gf!(b) + gf!(a + 1) * gf!(b + 1) + gf!(a + 2) * gf!(b + 2)),
                op::MUL_FV => {
                    let k = gf!(a);
                    let v = [gf!(b), gf!(b + 1), gf!(b + 2)];
                    setf!(c, k * v[0]);
                    setf!(c + 1, k * v[1]);
                    setf!(c + 2, k * v[2]);
                }
                op::MUL_VF => {
                    let k = gf!(b);
                    let v = [gf!(a), gf!(a + 1), gf!(a + 2)];
                    setf!(c, k * v[0]);
                    setf!(c + 1, k * v[1]);
                    setf!(c + 2, k * v[2]);
                }
                op::DIV_F => setf!(c, gf!(a) / gf!(b)),
                op::BITAND => setf!(c, ((gf!(a) as i32) & (gf!(b) as i32)) as f32),
                op::BITOR => setf!(c, ((gf!(a) as i32) | (gf!(b) as i32)) as f32),
                op::GE => gi!(c) = b2f(gf!(a) >= gf!(b)),
                op::LE => gi!(c) = b2f(gf!(a) <= gf!(b)),
                op::GT => gi!(c) = b2f(gf!(a) > gf!(b)),
                op::LT => gi!(c) = b2f(gf!(a) < gf!(b)),
                op::AND => gi!(c) = b2f(gf!(a) != 0.0 && gf!(b) != 0.0),
                op::OR => gi!(c) = b2f(gf!(a) != 0.0 || gf!(b) != 0.0),
                op::NOT_F => gi!(c) = b2f(gf!(a) == 0.0),
                op::NOT_V => gi!(c) = b2f(gf!(a) == 0.0 && gf!(a + 1) == 0.0 && gf!(a + 2) == 0.0),
                op::NOT_S => {
                    let h = gi!(a) as i32;
                    gi!(c) = b2f(h == 0 || self.string(h).is_empty());
                }
                op::NOT_FNC | op::NOT_ENT => gi!(c) = b2f(gi!(a) == 0),
                op::EQ_F => gi!(c) = b2f(gf!(a) == gf!(b)),
                op::EQ_V => {
                    gi!(c) = b2f(gf!(a) == gf!(b) && gf!(a + 1) == gf!(b + 1) && gf!(a + 2) == gf!(b + 2))
                }
                op::EQ_S => {
                    let r = self.string(gi!(a) as i32) == self.string(gi!(b) as i32);
                    gi!(c) = b2f(r);
                }
                op::EQ_E | op::EQ_FNC => gi!(c) = b2f(gi!(a) == gi!(b)),
                op::NE_F => gi!(c) = b2f(gf!(a) != gf!(b)),
                op::NE_V => {
                    gi!(c) = b2f(gf!(a) != gf!(b) || gf!(a + 1) != gf!(b + 1) || gf!(a + 2) != gf!(b + 2))
                }
                op::NE_S => {
                    let r = self.string(gi!(a) as i32) != self.string(gi!(b) as i32);
                    gi!(c) = b2f(r);
                }
                op::NE_E | op::NE_FNC => gi!(c) = b2f(gi!(a) != gi!(b)),

                op::STORE_F | op::STORE_ENT | op::STORE_FLD | op::STORE_S | op::STORE_FNC => gi!(b) = gi!(a),
                op::STORE_V => {
                    gi!(b) = gi!(a);
                    gi!(b + 1) = gi!(a + 1);
                    gi!(b + 2) = gi!(a + 2);
                }
                op::STOREP_F | op::STOREP_ENT | op::STOREP_FLD | op::STOREP_S | op::STOREP_FNC => {
                    let p = gi!(b) as usize;
                    match self.edicts.get_mut(p) {
                        Some(w) => *w = self.globals[a],
                        None => err!(ErrorKind::BadPointer, "bad pointer {}", p as i32),
                    }
                }
                op::STOREP_V => {
                    let p = gi!(b) as usize;
                    if p.checked_add(3).map_or(true, |e| e > self.edicts.len()) {
                        err!(ErrorKind::BadPointer, "bad pointer {}", p as i32);
                    }
                    self.edicts[p] = gi!(a);
                    self.edicts[p + 1] = gi!(a + 1);
                    self.edicts[p + 2] = gi!(a + 2);
                }
                op::ADDRESS => {
                    let e = gi!(a);
                    let f = gi!(b);
                    if e >= self.num_edicts {
                        err!(ErrorKind::BadEntity, "bad entity number {}", e as i32);
                    }
                    if e == 0 && self.world_locked {
                        err!(ErrorKind::WorldAssignment, "assignment to world entity");
                    }
                    if f as usize >= ef {
                        err!(ErrorKind::BadField, "bad field offset {}", f as i32);
                    }
                    gi!(c) = e * ef as u32 + f;
                }
                op::LOAD_F | op::LOAD_FLD | op::LOAD_ENT | op::LOAD_S | op::LOAD_FNC => {
                    let e = gi!(a);
                    let f = gi!(b);
                    if e >= self.num_edicts {
                        err!(ErrorKind::BadEntity, "bad entity number {}", e as i32);
                    }
                    if f as usize >= ef {
                        err!(ErrorKind::BadField, "bad field offset {}", f as i32);
                    }
                    gi!(c) = self.edicts[e as usize * ef + f as usize];
                }
                op::LOAD_V => {
                    let e = gi!(a);
                    let f = gi!(b);
                    if e >= self.num_edicts {
                        err!(ErrorKind::BadEntity, "bad entity number {}", e as i32);
                    }
                    if f as usize + 3 > ef {
                        err!(ErrorKind::BadField, "bad field offset {}", f as i32);
                    }
                    let i = e as usize * ef + f as usize;
                    gi!(c) = self.edicts[i];
                    gi!(c + 1) = self.edicts[i + 1];
                    gi!(c + 2) = self.edicts[i + 2];
                }

                op::IFNOT => {
                    if gi!(a) == 0 {
                        s = s.wrapping_add(st.b as i16 as i32);
                        continue;
                    }
                }
                op::IF => {
                    if gi!(a) != 0 {
                        s = s.wrapping_add(st.b as i16 as i32);
                        continue;
                    }
                }
                op::GOTO => {
                    s = s.wrapping_add(st.a as i16 as i32);
                    continue;
                }
                op::CALL0..=op::CALL8 => {
                    self.argc = (st.op - op::CALL0) as u32;
                    let fnum = gi!(a);
                    if fnum == 0 {
                        err!(ErrorKind::NullFunction, "NULL function");
                    }
                    let first = match progs.functions.get(fnum as usize) {
                        Some(f) => f.first_statement,
                        None => err!(ErrorKind::BadFunction, "bad function number {}", fnum as i32),
                    };
                    if first < 0 {
                        sync!();
                        self.xstatement = s;
                        self.dispatch_builtin(host, first.unsigned_abs())?;
                        limit = run_left.min(self.budget);
                        if limit == 0 {
                            err!(ErrorKind::Runaway, "runaway loop error");
                        }
                    } else {
                        s = match self.enter_function(&progs, fnum, s) {
                            Ok(x) => x,
                            Err(e) => {
                                sync!();
                                self.xstatement = s;
                                return Err(e);
                            }
                        };
                        continue;
                    }
                }
                op::DONE | op::RETURN => {
                    gi!(OFS_RETURN as usize) = gi!(a);
                    gi!(OFS_RETURN as usize + 1) = gi!(a + 1);
                    gi!(OFS_RETURN as usize + 2) = gi!(a + 2);
                    s = match self.leave_function(&progs) {
                        Ok(x) => x,
                        Err(e) => {
                            sync!();
                            return Err(e);
                        }
                    };
                    if self.stack.len() == exitdepth {
                        sync!();
                        self.xstatement = s;
                        return Ok(());
                    }
                }
                op::STATE => {
                    let e = gi!(glob::SELF as usize);
                    if e >= self.num_edicts {
                        err!(ErrorKind::BadEntity, "OP_STATE: bad self {}", e as i32);
                    }
                    let base = e as usize * ef;
                    let time = gf!(glob::TIME as usize);
                    self.edicts[base + fld::NEXTTHINK as usize] = canon((time as f64 + 0.1) as f32).to_bits();
                    let frame = f32::from_bits(self.edicts[base + fld::FRAME as usize]);
                    if gf!(a) != frame {
                        self.edicts[base + fld::FRAME as usize] = gi!(a);
                    }
                    self.edicts[base + fld::THINK as usize] = gi!(b);
                }
                other => err!(ErrorKind::BadOpcode, "Bad opcode {}", other),
            }
            s = s.wrapping_add(1);
        }
    }
}
