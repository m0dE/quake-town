// Quake Town - qcvm: opcode / interpreter unit tests on hand-assembled progs.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later

mod common;
use common::*;
use qcvm::defs::{fld, glob, op::*, OFS_PARM0, OFS_RETURN};
use qcvm::{ErrorKind, Host, Progs, Vm, VmConfig, VmError};

const P0: u16 = OFS_PARM0 as u16;
const RET: u16 = OFS_RETURN as u16;

fn vm_of(a: &Asm) -> Vm {
    let p = Progs::load(&a.build()).expect("assembled progs loads");
    Vm::new(p, VmConfig::default(), 1)
}

fn f(vm: &Vm, o: u16) -> f32 {
    vm.g_f(o as u32)
}

#[test]
fn arithmetic_and_compare() {
    let mut a = Asm::new();
    let x = a.gf(6.0);
    let y = a.gf(4.0);
    let z = a.gf(0.0);
    let v1 = a.gv([1.0, 2.0, 3.0]);
    let v2 = a.gv([4.0, 5.0, 6.0]);
    let r: Vec<u16> = (0..24).map(|_| a.gf(0.0)).collect();
    let rv = a.gv([0.0; 3]);
    let rv2 = a.gv([0.0; 3]);
    let rv3 = a.gv([0.0; 3]);
    let rv4 = a.gv([0.0; 3]);
    let fr = a.gf(5.7);
    let three = a.gf(3.0);
    a.func("main", 0, 0, &[]);
    a.st(ADD_F, x, y, r[0]);
    a.st(SUB_F, x, y, r[1]);
    a.st(MUL_F, x, y, r[2]);
    a.st(DIV_F, x, y, r[3]);
    a.st(DIV_F, z, z, r[4]); // NaN, canonical
    a.st(MUL_V, v1, v2, r[5]);
    a.st(ADD_V, v1, v2, rv);
    a.st(SUB_V, v2, v1, rv2);
    a.st(MUL_FV, x, v1, rv3);
    a.st(MUL_VF, v1, y, rv4);
    a.st(BITAND, fr, three, r[6]);
    a.st(BITOR, fr, three, r[7]);
    a.st(GT, x, y, r[8]);
    a.st(LT, x, y, r[9]);
    a.st(GE, x, x, r[10]);
    a.st(LE, y, x, r[11]);
    a.st(AND, x, z, r[12]);
    a.st(OR, x, z, r[13]);
    a.st(NOT_F, z, 0, r[14]);
    a.st(NOT_V, v1, 0, r[15]);
    a.st(EQ_F, x, x, r[16]);
    a.st(NE_F, x, y, r[17]);
    a.st(EQ_V, v1, v1, r[18]);
    a.st(NE_V, v1, v2, r[19]);
    a.st(EQ_E, x, x, r[20]);
    a.st(NE_FNC, x, y, r[21]);
    a.st(DONE, 0, 0, 0);
    let mut vm = vm_of(&a);
    vm.call(&mut NullHost, 1).unwrap();
    let got: Vec<f32> = r.iter().map(|&o| f(&vm, o)).collect();
    assert_eq!(&got[0..4], &[10.0, 2.0, 24.0, 1.5]);
    assert_eq!(vm.g_i(r[4] as u32) as u32, qcvm::CANON_NAN_BITS);
    assert_eq!(got[5], 32.0);
    assert_eq!(vm.g_v(rv as u32), [5.0, 7.0, 9.0]);
    assert_eq!(vm.g_v(rv2 as u32), [3.0, 3.0, 3.0]);
    assert_eq!(vm.g_v(rv3 as u32), [6.0, 12.0, 18.0]);
    assert_eq!(vm.g_v(rv4 as u32), [4.0, 8.0, 12.0]);
    assert_eq!(&got[6..8], &[1.0, 7.0]);
    assert_eq!(&got[8..22], &[1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
}

#[test]
fn strings_compare_by_content() {
    let mut a = Asm::new();
    let s1 = a.string("abc");
    let s2 = a.string("abc");
    let s3 = a.string("");
    let g1 = a.global(s1 as u32);
    let g2 = a.global(s2 as u32);
    let g3 = a.global(s3 as u32);
    let r: Vec<u16> = (0..4).map(|_| a.gf(0.0)).collect();
    a.func("main", 0, 0, &[]);
    a.st(EQ_S, g1, g2, r[0]);
    a.st(NE_S, g1, g3, r[1]);
    a.st(NOT_S, g3, 0, r[2]);
    a.st(NOT_S, g1, 0, r[3]);
    a.st(DONE, 0, 0, 0);
    let mut vm = vm_of(&a);
    vm.call(&mut NullHost, 1).unwrap();
    let got: Vec<f32> = r.iter().map(|&o| f(&vm, o)).collect();
    assert_eq!(got, vec![1.0, 1.0, 1.0, 0.0]);
}

#[test]
fn loops_and_recursion_preserve_locals() {
    let mut a = Asm::new();
    let one = a.gf(1.0);
    let ten = a.gf(10.0);
    let result = a.gf(0.0);
    let counter = a.gf(0.0);
    let limit = a.gf(1000.0);
    let tmp = a.gf(0.0);
    // locals of fact: n, t1, t2
    let n = a.gf(0.0);
    let t1 = a.gf(0.0);
    let t2 = a.gf(0.0);
    let factg = a.global(0);
    // fact(n)
    let fact = a.func("fact", n as u32, 3, &[1]);
    a.st(LE, n, one, t1);
    a.st(IFNOT, t1, 2, 0);
    a.st(RETURN, one, 0, 0);
    a.st(SUB_F, n, one, t2);
    a.st(STORE_F, t2, P0, 0);
    a.st(CALL1, factg, 0, 0);
    a.st(MUL_F, n, RET, t2);
    a.st(RETURN, t2, 0, 0);
    a.globals[factg as usize] = fact;
    // main: result = fact(10); counter counts to 1000 with a backward GOTO
    let main = a.func("main", 0, 0, &[]);
    a.st(STORE_F, ten, P0, 0);
    a.st(CALL1, factg, 0, 0);
    a.st(STORE_F, RET, result, 0);
    a.st(ADD_F, counter, one, counter); // loop top
    a.st(LT, counter, limit, tmp);
    a.st(IFNOT, tmp, 2, 0);
    a.st(GOTO, (-3i16) as u16, 0, 0);
    a.st(DONE, 0, 0, 0);
    let mut vm = vm_of(&a);
    vm.call(&mut NullHost, main).unwrap();
    assert_eq!(f(&vm, result), 3628800.0);
    assert_eq!(f(&vm, counter), 1000.0);
    assert!(!vm.executing());
}

#[test]
fn fields_pointers_state_and_world_lock() {
    let mut a = Asm::new();
    let ent = a.global(0);
    let forigin = a.global(fld::ORIGIN);
    let fhealth = a.global(fld::HEALTH);
    let ptr = a.global(0);
    let val = a.gf(77.0);
    let vec = a.gv([1.0, 2.0, 3.0]);
    let out = a.gf(0.0);
    let outv = a.gv([0.0; 3]);
    let frame = a.gf(5.0);
    let thinkf = a.global(0);
    let main = a.func("main", 0, 0, &[]);
    a.st(ADDRESS, ent, fhealth, ptr);
    a.st(STOREP_F, val, ptr, 0);
    a.st(ADDRESS, ent, forigin, ptr);
    a.st(STOREP_V, vec, ptr, 0);
    a.st(LOAD_F, ent, fhealth, out);
    a.st(LOAD_V, ent, forigin, outv);
    a.st(STATE, frame, thinkf, 0);
    a.st(DONE, 0, 0, 0);
    a.globals[thinkf as usize] = main;
    let mut vm = vm_of(&a);
    let e = vm.alloc_edict(1.0).ent;
    assert_eq!(e, 33);
    vm.set_g_e(ent as u32, e);
    vm.set_g_e(glob::SELF, e);
    vm.set_g_f(glob::TIME, 2.5);
    vm.call(&mut NullHost, main).unwrap();
    assert_eq!(vm.e_f(e, fld::HEALTH), 77.0);
    assert_eq!(vm.e_v(e, fld::ORIGIN), [1.0, 2.0, 3.0]);
    assert_eq!(f(&vm, out), 77.0);
    assert_eq!(vm.g_v(outv as u32), [1.0, 2.0, 3.0]);
    assert_eq!(vm.e_f(e, fld::NEXTTHINK), (2.5f32 as f64 + 0.1) as f32);
    assert_eq!(vm.e_f(e, fld::FRAME), 5.0);
    assert_eq!(vm.e_fn(e, fld::THINK), main);
    // world assignment once locked
    vm.set_g_e(ent as u32, 0);
    vm.set_world_locked(true);
    let err = vm.call(&mut NullHost, main).unwrap_err();
    assert_eq!(err.kind, ErrorKind::WorldAssignment);
    assert!(err.to_string().contains("main"), "{}", err);
    let err = vm.call(&mut NullHost, main).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Stopped);
    vm.clear_error();
    // bad entity
    vm.set_g_e(ent as u32, 5000);
    assert_eq!(vm.call(&mut NullHost, main).unwrap_err().kind, ErrorKind::BadEntity);
    vm.clear_error();
    // bad field
    vm.set_g_e(ent as u32, e);
    vm.set_g_i(fhealth as u32, 100000);
    assert_eq!(vm.call(&mut NullHost, main).unwrap_err().kind, ErrorKind::BadField);
}

#[test]
fn runaway_overflow_and_null_function() {
    let mut a = Asm::new();
    let selfg = a.global(0);
    let nullg = a.global(0);
    let spin = a.func("spin", 0, 0, &[]);
    a.st(GOTO, 0, 0, 0);
    let rec = a.func("rec", 0, 0, &[]);
    a.st(CALL0, selfg, 0, 0);
    a.st(DONE, 0, 0, 0);
    let nul = a.func("nul", 0, 0, &[]);
    a.st(CALL0, nullg, 0, 0);
    a.st(DONE, 0, 0, 0);
    a.globals[selfg as usize] = rec;
    let mut vm = vm_of(&a);
    assert_eq!(vm.call(&mut NullHost, spin).unwrap_err().kind, ErrorKind::Runaway);
    vm.clear_error();
    vm.set_budget(1000);
    let e = vm.call(&mut NullHost, spin).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Runaway);
    vm.clear_error();
    vm.set_budget(u64::MAX);
    assert_eq!(vm.call(&mut NullHost, rec).unwrap_err().kind, ErrorKind::StackOverflow);
    vm.clear_error();
    assert_eq!(vm.call(&mut NullHost, nul).unwrap_err().kind, ErrorKind::NullFunction);
    vm.clear_error();
    assert_eq!(vm.call(&mut NullHost, 0).unwrap_err().kind, ErrorKind::NullFunction);
    vm.clear_error();
    assert_eq!(vm.call(&mut NullHost, 999).unwrap_err().kind, ErrorKind::BadFunction);
}

/// A host whose builtin #500 calls QC function in parm0 (nested execution), and #501 counts.
struct NestHost {
    count: u32,
}
impl Host for NestHost {
    fn builtin(&mut self, vm: &mut Vm, num: u32) -> Result<(), VmError> {
        match num {
            500 => {
                let f = vm.parm_fn(0);
                vm.call(self, f)?;
                vm.ret_f(42.0);
                Ok(())
            }
            501 => {
                self.count += 1;
                Ok(())
            }
            _ => Err(VmError::unknown_builtin(num)),
        }
    }
}

#[test]
fn nested_calls_from_builtins_and_pure_builtins() {
    let mut a = Asm::new();
    let b500 = a.builtin("nest", 500);
    let b501 = a.builtin("count", 501);
    let ftos = a.builtin("ftos", 26);
    let strcat = a.builtin("strcat", 115);
    let strzone = a.builtin("strzone", 118);
    let vtos = a.builtin("vtos", 27);
    let g500 = a.global(b500);
    let g501 = a.global(b501);
    let gftos = a.global(ftos);
    let gcat = a.global(strcat);
    let gzone = a.global(strzone);
    let gvtos = a.global(vtos);
    let innerg = a.global(0);
    let loc = a.gf(0.0);
    let res = a.gf(0.0);
    let s1 = a.global(0);
    let s2 = a.global(0);
    let s3 = a.global(0);
    let s4 = a.global(0);
    let num = a.gf(12.5);
    let v = a.gv([1.0, 2.0, 3.0]);
    let seven = a.gf(7.0);
    let inner = a.func("inner", loc as u32, 1, &[]);
    a.st(STORE_F, seven, loc, 0);
    a.st(CALL0, g501, 0, 0);
    a.st(DONE, 0, 0, 0);
    a.globals[innerg as usize] = inner;
    let main = a.func("main", 0, 0, &[]);
    a.st(STORE_FNC, innerg, P0, 0);
    a.st(CALL1, g500, 0, 0);
    a.st(STORE_F, RET, res, 0);
    a.st(STORE_F, num, P0, 0);
    a.st(CALL1, gftos, 0, 0);
    a.st(STORE_S, RET, s1, 0);
    a.st(STORE_V, v, P0, 0);
    a.st(CALL1, gvtos, 0, 0);
    a.st(STORE_S, RET, s2, 0);
    a.st(STORE_S, s1, P0, 0);
    a.st(STORE_S, s2, P0 + 3, 0);
    a.st(CALL2, gcat, 0, 0);
    a.st(STORE_S, RET, s3, 0);
    a.st(STORE_S, s3, P0, 0);
    a.st(CALL1, gzone, 0, 0);
    a.st(STORE_S, RET, s4, 0);
    a.st(DONE, 0, 0, 0);
    let mut vm = vm_of(&a);
    let mut h = NestHost { count: 0 };
    vm.call(&mut h, main).unwrap();
    assert_eq!(h.count, 1);
    assert_eq!(f(&vm, res), 42.0);
    assert_eq!(vm.g_str(s1 as u32), b" 12.5");
    assert_eq!(vm.g_str(s2 as u32), b"'  1.0   2.0   3.0'");
    assert_eq!(vm.g_str(s3 as u32), b" 12.5'  1.0   2.0   3.0'");
    assert_eq!(vm.g_str(s4 as u32), b" 12.5'  1.0   2.0   3.0'");
    // the zone string survives temp ring rotation; unzone frees it
    for i in 0..40 {
        vm.temp_string(format!("t{}", i).as_bytes()).unwrap();
    }
    assert_eq!(vm.g_str(s4 as u32), b" 12.5'  1.0   2.0   3.0'");
    let h4 = vm.g_s(s4 as u32);
    assert!(vm.unzone(h4));
    assert!(!vm.unzone(h4));
    assert_eq!(vm.string(h4), b"");
    // interning
    let p1 = vm.new_string(b"hello").unwrap();
    let p2 = vm.new_string(b"hello").unwrap();
    assert_eq!(p1, p2);
    // unknown builtin is an error
    let mut a2 = Asm::new();
    let bx = a2.builtin("x", 777);
    let gx = a2.global(bx);
    let m2 = a2.func("main", 0, 0, &[]);
    a2.st(CALL0, gx, 0, 0);
    a2.st(DONE, 0, 0, 0);
    let mut vm2 = vm_of(&a2);
    assert_eq!(vm2.call(&mut NullHost, m2).unwrap_err().kind, ErrorKind::UnknownBuiltin);
}

#[test]
fn edict_alloc_reuse_rule() {
    let a = Asm::new();
    let mut vm = vm_of(&a);
    let e1 = vm.alloc_edict(5.0).ent;
    let e2 = vm.alloc_edict(5.0).ent;
    assert_eq!((e1, e2), (33, 34));
    let s1 = vm.serial(e1);
    vm.free_edict(e1, 5.0);
    assert_eq!(vm.e_f(e1, fld::NEXTTHINK), -1.0);
    // freed at 5.0: not reusable before 5.5
    assert_eq!(vm.alloc_edict(5.3).ent, 35);
    assert_eq!(vm.alloc_edict(5.6).ent, 33);
    assert_eq!(vm.serial(33), s1 + 1);
    // freetime < 2: reusable at once
    vm.free_edict(34, 1.5);
    assert_eq!(vm.alloc_edict(1.5).ent, 34);
    // cap: step on the last edict
    let mut vm = Vm::new(vm.progs().clone(), VmConfig { max_edicts: 36, ..Default::default() }, 1);
    assert_eq!(vm.alloc_edict(1.0).ent, 33);
    assert_eq!(vm.alloc_edict(1.0).ent, 34);
    assert_eq!(vm.alloc_edict(1.0).ent, 35);
    let a = vm.alloc_edict(1.0);
    assert_eq!((a.ent, a.stepped_on), (35, true));
}

#[test]
fn pure_math_builtins() {
    let mut a = Asm::new();
    let nums: &[(i32, &str)] = &[(36, "rint"), (37, "floor"), (38, "ceil"), (43, "fabs"), (13, "vectoyaw"), (114, "strlen"), (81, "stof")];
    let gs: Vec<u16> = nums.iter().map(|(n, s)| { let b = a.builtin(s, *n); a.global(b) }).collect();
    let x = a.gf(-2.5);
    let vy = a.gv([0.0, -3.0, 0.0]);
    let st = a.string("  -12.75e1junk");
    let sg = a.global(st as u32);
    let outs: Vec<u16> = (0..7).map(|_| a.gf(0.0)).collect();
    let main = a.func("main", 0, 0, &[]);
    for i in 0..4 {
        a.st(STORE_F, x, P0, 0);
        a.st(CALL1, gs[i], 0, 0);
        a.st(STORE_F, RET, outs[i], 0);
    }
    a.st(STORE_V, vy, P0, 0);
    a.st(CALL1, gs[4], 0, 0);
    a.st(STORE_F, RET, outs[4], 0);
    a.st(STORE_S, sg, P0, 0);
    a.st(CALL1, gs[5], 0, 0);
    a.st(STORE_F, RET, outs[5], 0);
    a.st(STORE_S, sg, P0, 0);
    a.st(CALL1, gs[6], 0, 0);
    a.st(STORE_F, RET, outs[6], 0);
    a.st(DONE, 0, 0, 0);
    let mut vm = vm_of(&a);
    vm.call(&mut NullHost, main).unwrap();
    let got: Vec<f32> = outs.iter().map(|&o| f(&vm, o)).collect();
    assert_eq!(got, vec![-3.0, -3.0, -2.0, 2.5, 270.0, 14.0, -127.5]);
}

#[test]
fn entity_text_parsing() {
    let mut a = Asm::new();
    let spawn = a.func("info_thing", 0, 0, &[]);
    a.st(DONE, 0, 0, 0);
    a.func("worldspawn", 0, 0, &[]);
    a.st(DONE, 0, 0, 0);
    let _ = spawn;
    let mut vm = vm_of(&a);
    let text = br#"
{ "classname" "worldspawn" "message" "line\nnext" }
{ "classname" "info_thing" "origin" "1 2 3" "angle" "90" "health" "25.5" "owner" "1" "_comment" "x" }
{ "classname" "info_thing" "spawnflags" "2048" }
{ "classname" "no_such_thing" }
{ "classname" "info_thing" "origin" "4" }
"#;
    let st = vm.load_entities(&mut NullHost, text, 1.0).unwrap();
    assert_eq!(st.spawned, 3);
    assert_eq!(st.inhibited, 1);
    assert_eq!(st.no_spawn_fn, 1);
    assert_eq!(vm.e_str(0, fld::MESSAGE), b"line\nnext");
    assert_eq!(vm.e_v(33, fld::ORIGIN), [1.0, 2.0, 3.0]);
    assert_eq!(vm.e_v(33, fld::ANGLES), [0.0, 90.0, 0.0]);
    assert_eq!(vm.e_f(33, fld::HEALTH), 25.5);
    assert_eq!(vm.e_e(33, fld::OWNER), 1);
    // freed edicts (freetime 1.0 < 2) are reused at once: the last block lands in 34
    assert_eq!(vm.e_v(34, fld::ORIGIN), [4.0, 0.0, 0.0]);
    assert!(vm.is_free(35) || vm.num_edicts() == 35);
    // garbage is a parse error, not a panic
    let mut vm2 = vm_of(&a);
    assert!(vm2.load_entities(&mut NullHost, b"{ \"classname\" ", 1.0).is_err());
    let mut vm3 = vm_of(&a);
    assert!(vm3.load_entities(&mut NullHost, b"classname", 1.0).is_err());
}

#[test]
fn bench_raw_ops() {
    // loop body: LOAD_F, ADD_F, ADDRESS, STOREP_F, MUL_F, LT, IFNOT, GOTO + a call every iteration
    let mut a = Asm::new();
    let one = a.gf(1.0);
    let counter = a.gf(0.0);
    let limit = a.gf(2_000_000.0);
    let tmp = a.gf(0.0);
    let ent = a.global(0);
    let fh = a.global(fld::HEALTH);
    let ptr = a.global(0);
    let hv = a.gf(0.0);
    let k = a.gf(0.0);
    let loc = a.gf(0.0);
    let leaf = a.func("leaf", loc as u32, 1, &[1]);
    a.st(ADD_F, loc, one, loc);
    a.st(RETURN, loc, 0, 0);
    let leafg = a.global(leaf);
    let main = a.func("main", 0, 0, &[]);
    let top = a.st(LOAD_F, ent, fh, hv);
    a.st(ADD_F, hv, one, hv);
    a.st(ADDRESS, ent, fh, ptr);
    a.st(STOREP_F, hv, ptr, 0);
    a.st(MUL_F, hv, one, k);
    a.st(STORE_F, k, P0, 0);
    a.st(CALL1, leafg, 0, 0);
    a.st(ADD_F, counter, one, counter);
    a.st(LT, counter, limit, tmp);
    a.st(IFNOT, tmp, 2, 0);
    let here = a.statements.len();
    a.st(GOTO, (top as i32 - here as i32) as i16 as u16, 0, 0);
    a.st(DONE, 0, 0, 0);
    let mut vm = vm_of(&a);
    let e = vm.alloc_edict(1.0).ent;
    vm.set_g_e(ent as u32, e);
    vm.set_budget(u64::MAX);
    let mut vm = Vm::new(vm.progs().clone(), VmConfig { runaway: u64::MAX, ..Default::default() }, 1);
    let e = vm.alloc_edict(1.0).ent;
    vm.set_g_e(ent as u32, e);
    vm.set_budget(u64::MAX);
    let t0 = cpu_time();
    vm.call(&mut NullHost, main).unwrap();
    let dt = cpu_time() - t0;
    let ops = vm.instructions();
    assert_eq!(vm.e_f(e, fld::HEALTH), 2_000_000.0);
    eprintln!("raw VM: {} ops in {:.3} s cpu = {:.0} M ops/s", ops, dt, ops as f64 / dt / 1e6);
}
