# qcvm — public API (for the engine, `sim/qtsim`)

Status: **published, stable**. Any later change is listed here first.

Changes:
- 2026-10-03 (additions only, nothing changed): `vm.call_name`, `vm.parse_globals`,
  `vm.edict_text`, `vm.stack_trace`, `vm.executing`, `vm.current_function`,
  `vm.check_ent`, `vm.set_parm_i`, `vm.return_i`, `vm.globals()`, `vm.string_bytes`,
  `vm.rng() -> &mut Pcg32` (`below(n)`, `f01()`), `qcvm::{PURE_BUILTINS, DEFAULT_BUDGET,
  ftos, vtos, atof, atoi, com_parse}`, `Def::save`, `StateHasher::{words, words_typed,
  pair, bytes, f32, f64, finish32}`.

`qcvm` is a deterministic QuakeC VM for **QW progs** (version 6, progdefs CRC 54730).
No dependency on the engine; no `std::time`, no HashMap iteration, no host math
(transcendentals via `libm`). Everything is bounds-checked: a malicious progs or a
malicious serialized state produces `Err`, never a panic or an out-of-bounds read.

```rust
use qcvm::{Progs, Vm, VmConfig, Host, VmError, Ent, Str, Func, Alloc, Print};
use qcvm::defs::{glob, fld, OFS_RETURN, OFS_PARM0};   // QW progdefs.h offsets (words)
```

## Types

| type | meaning |
|---|---|
| `Ent = u32` | edict **number** (0 = world, 1..=client_edicts = clients). QC entity values ARE edict numbers (not byte offsets as in id's C). |
| `Str = i32` | `string_t` handle. `>= 0`: offset in the progs string table; `< 0`: engine/temp/zone string. Plain integer, fully serializable. Unknown handle reads as `""`. |
| `Func = u32` | `func_t`: index into the progs function table (0 = null). |
| `Def { ofs: u32, ty: u16, name: String }` | a field or global definition (`ty` = `defs::ty::*`, SAVEGLOBAL bit stripped). |

## Loading progs (once per page, shared by every world)

```rust
let progs: Arc<Progs> = Progs::load(&bytes)?;      // Result<Arc<Progs>, LoadError>
LoadError::code() -> i32   // negative ABI error code; Display gives the text
//  -1 truncated/garbage   -2 wrong version (not 6)   -3 NetQuake progs (CRC 5927)
//  -4 unknown progdefs CRC  -5 lump out of range   -6 too big (> 4 MB / limits)
//  -7 bad layout (fields/globals smaller than QW progdefs)  -8 bad function table
progs.find_function("PlayerPreThink") -> Option<Func>   // first function with that name (as QW)
progs.find_field("gravity") -> Option<&Def>              // optional QW fields: gravity, maxspeed, alpha …
progs.find_global("deathmatch") -> Option<&Def>
progs.entityfields() -> u32 ; progs.crc() -> i32 ; progs.fingerprint() -> u64 (hash of the bytes)
progs.function_name(f) -> &[u8]
```

Because the CRC is 54730 the system globals/fields are at fixed offsets:
`defs::glob::{SELF, OTHER, WORLD, TIME, FRAMETIME, NEWMIS, FORCE_RETOUCH, MAPNAME, …,
PARM1..PARM16, V_FORWARD, V_UP, V_RIGHT, TRACE_*, MSG_ENTITY, MAIN, STARTFRAME,
PLAYERPRETHINK, PLAYERPOSTTHINK, CLIENTKILL, CLIENTCONNECT, PUTCLIENTINSERVER,
CLIENTDISCONNECT, SETNEWPARMS, SETCHANGEPARMS}` and `defs::fld::{MODELINDEX, ABSMIN,
ABSMAX, LTIME, LASTRUNTIME, MOVETYPE, SOLID, ORIGIN, OLDORIGIN, VELOCITY, ANGLES,
AVELOCITY, CLASSNAME, MODEL, FRAME, SKIN, EFFECTS, MINS, MAXS, SIZE, TOUCH, USE, THINK,
BLOCKED, NEXTTHINK, GROUNDENTITY, HEALTH, FRAGS, WEAPON, …, NOISE3}` (names = the C
names upper-cased, e.g. `PutClientInServer` → `PUTCLIENTINSERVER`). The loader refuses a
progs whose `entityfields`/`numglobals` are smaller than these structs.

## A world's VM

```rust
let mut vm = Vm::new(progs.clone(), VmConfig::default(), seed /* u64 world seed */);
```

`VmConfig` (all deterministic, part of the serialized state):

| field | default | meaning |
|---|---|---|
| `max_edicts` | 2048 | QW's 1024 + 1024 extra; `alloc_edict` at the cap steps on the last edict (QW) |
| `client_edicts` | 32 | edicts 1..=32 are client bodies (QW MAX_CLIENTS); `alloc_edict` starts after them |
| `max_depth` | 64 | QC call depth (QW 32) |
| `local_stack` | 16384 | words of saved locals (QW 2048) |
| `runaway` | 1_000_000 | statements per `call` (QW 100000) → `Err(Runaway)` |
| `string_bytes` | 4 MiB | cap on engine + zone + temp string bytes → `Err(StringLimit)` |

`Vm::new` = QW `PR_LoadProgs` + the edict part of `SV_SpawnServer`: globals from the
progs, `num_edicts = client_edicts + 1`, all of them zeroed and **not** free.
`vm.restart()` does the same again for a map change (globals reset, edicts reset, all
non-progs strings dropped); the PRNG continues. Engine keeps the clients' `parm1..16`
itself across the restart (QW `spawn_parms`).

### Calling QuakeC

```rust
vm.set_g_e(glob::SELF, ent);
vm.set_g_f(glob::TIME, world_time as f32);
vm.call(&mut host, vm.g_fn(glob::PLAYERPRETHINK))?;      // Result<(), VmError>
```

- `call` is re-entrant: a builtin may call `vm.call(self, f)` (touch functions from
  `setorigin`/`walkmove` etc. — QW's nested `PR_ExecuteProgram`).
- Calling `Func` 0 or out of range → `Err(NullFunction/BadFunction)` (QW SV_Error).
  Calling a builtin's `Func` directly runs the builtin.
- Arguments: `vm.set_parm_f(i, x)`, `set_parm_v`, `set_parm_e`, `set_parm_s` (parm i at
  `OFS_PARM0 + 3*i`). Results: `vm.return_f()`, `return_v()`, `return_e()`, `return_s()`.
- **Any error is fatal** (QW turns every PR_RunError/`error()`/`objerror()` into
  SV_Error). The VM becomes *stopped*: `vm.stopped() -> Option<&VmError>`, every later
  `call` returns `Err` at once. The engine turns that into a stopped world.
- Budgets: `runaway` per `call` (each nested call has its own, like QW) **and** a
  total budget across calls: `vm.set_budget(n: u64)` (default 50_000_000; the engine
  should reset it every tick). Exhausting either → `Err(Runaway)`. Neither is part of
  the hash. `vm.instructions() -> u64` counts executed statements (stats).
- `vm.set_world_locked(true)` after spawning (QW `sv.state == ss_active`): QC writing a
  field of the world entity is then an error, as in QW.

### The `Host` trait (implemented by the engine)

```rust
pub trait Host {
    /// Engine builtins (every number the VM does not implement itself, see below).
    /// Read args with vm.parm_*, write the result with vm.ret_*. Unknown number:
    /// return Err(VmError::unknown_builtin(num)).
    fn builtin(&mut self, vm: &mut Vm, num: u32) -> Result<(), VmError>;
    /// dprint / eprint / error text / coredump. Default: ignore.
    fn print(&mut self, _vm: &Vm, _kind: Print, _text: &[u8]) {}
    /// Only called by `load_entities` when `alloc_edict` stepped on a live edict
    /// (edict cap reached): unlink it from the world. Default: nothing.
    fn unlink(&mut self, _vm: &mut Vm, _e: Ent) {}
}
```

Borrowing pattern: keep the `Vm` and the rest of the world in separate struct fields
and implement `Host` on the rest: `self.vm.call(&mut self.rest, f)`. Inside a builtin,
`vm.call(self, f)` nests.

**Builtins the VM implements itself** (the host never sees these numbers):
`#1 makevectors, #6 break (error), #7 random, #9 normalize, #10 error, #11 objerror,
#12 vlen, #13 vectoyaw, #18 find, #22 findradius, #25 dprint, #26 ftos, #27 vtos,
#28 coredump, #29 traceon, #30 traceoff, #31 eprint, #36 rint, #37 floor, #38 ceil,
#43 fabs, #47 nextent, #51 vectoangles, #81 stof`, FTE: `#60 sin, #61 cos, #62 sqrt,
#94 min, #95 max, #96 bound, #97 pow, #114 strlen, #115 strcat, #116 substring,
#117 stov, #118 strzone, #119 strunzone, #441 tokenize, #442 argv`.
Semantics are QW's `pr_cmds.c` (ftos `%d` / `%5.1f`, vtos `'%5.1f %5.1f %5.1f'`, rint
`(int)(f±0.5)`, vectoyaw/vectoangles truncate to int degrees, random =
`(rng & 0x7fff) / 32767.0`). objerror does not free `self` (the world stops anyway).
Everything else (spawn, remove, setorigin, traceline, sound, cvar, WriteByte,
precache_*, infokey, qt_* #9000+, cvar_string #448 …) goes to `Host::builtin`.

### Builtin argument helpers

```rust
vm.argc() -> usize                                  // pr_argc of the current builtin call
vm.parm_f(i) -> f32 ; parm_v(i) -> [f32;3] ; parm_i(i) -> i32 ; parm_s(i) -> Str
vm.parm_str(i) -> &[u8]                             // string contents
vm.parm_ent(i) -> Result<Ent, VmError>              // validated (< num_edicts), QW NUM_FOR_EDICT
vm.parm_fn(i) -> Func
vm.var_string(first) -> Vec<u8>                     // PF_VarString: concat parms first..argc
vm.ret_f(x); ret_v(v); ret_i(i); ret_e(e); ret_s(h); vm.ret_temp(bytes)  // ret_temp = temp string
```

### Globals and fields

```rust
// globals (word offsets; out of range reads 0 / writes are ignored)
vm.g_f(o) -> f32   g_v(o) -> [f32;3]   g_i(o) -> i32   g_e(o) -> Ent   g_s(o) -> Str   g_fn(o) -> Func
vm.g_str(o) -> &[u8]
vm.set_g_f(o, x)   set_g_v(o, v)   set_g_i(o, i)   set_g_e(o, e)   set_g_s(o, h)   set_g_fn(o, f)
// fields of edict e (out of range e/ofs reads 0 / writes are ignored)
vm.e_f(e, o) -> f32   e_v(e, o) -> [f32;3]   e_i   e_e   e_s   e_fn   e_str(e, o) -> &[u8]
vm.set_e_f(e, o, x)   set_e_v   set_e_i   set_e_e   set_e_s   set_e_fn
vm.edict_words(e) -> &[u32] ; edict_words_mut(e) -> &mut [u32]   // raw entityfields words
```
Float setters canonicalise NaN. Interpreter float ops (add/sub/mul/div) canonicalise NaN
results, so VM memory never holds a non-canonical NaN produced at run time.

### Edicts (pr_edict.c semantics)

```rust
vm.num_edicts() -> u32 ; vm.max_edicts() -> u32 ; vm.client_edicts() -> u32
vm.is_free(e) -> bool ; vm.free_time(e) -> f32
vm.serial(e) -> u32            // bumps on every alloc of e (EntView serial)
vm.alloc_edict(time: f64) -> Alloc { ent: Ent, stepped_on: bool }
    // ED_Alloc: first free edict after the clients with freetime < 2 or time - freetime > 0.5,
    // else grow num_edicts; at max_edicts steps on the last edict (stepped_on = true: the
    // engine must unlink it first). The edict is zeroed, not free, serial bumped.
vm.free_edict(e, time: f64)    // ED_Free minus the unlink (engine unlinks first): free=true,
                               // model/takedamage/modelindex/colormap/skin/frame/origin/angles/solid = 0,
                               // nextthink = -1, freetime = time
vm.clear_edict(e)              // ED_ClearEdict (zero fields, not free)
vm.load_entities(&mut host, entity_lump: &[u8], time: f64) -> Result<LoadStats, VmError>
    // ED_LoadFromFile: edict 0 gets the first block (worldspawn), others ED_Alloc; drops
    // spawnflags & 2048 (not in deathmatch), no classname, no spawn function; sets time and
    // self, calls the spawn function by classname. LoadStats { spawned, inhibited, no_spawn_fn }.
```

### Strings

```rust
vm.string(h: Str) -> &[u8]          // bytes without NUL
vm.new_string(bytes) -> Result<Str, VmError>   // permanent engine string until restart();
                                    // interned (same bytes → same handle). ED_NewString, netname…
vm.temp_string(bytes) -> Result<Str, VmError>  // rotating ring of 16 (ftos/vtos/strcat/argv…)
vm.zone_string(bytes) -> Result<Str, VmError>  // strzone; vm.unzone(h) -> bool (strunzone)
```

### PRNG (the world PRNG — QC random(), bots, engine all draw from it)

```rust
vm.random() -> f32 ; vm.rng_u32() -> u32 ; vm.rng_f01() -> f32  // [0,1)
```
PCG32 seeded from `Vm::new`'s seed; serialized and hashed.

### Clone, serialize, hash

```rust
let w2 = vm.clone();                         // full independent copy (Arc'd progs shared)
let mut buf = Vec::new(); vm.serialize(&mut buf);       // appends; little-endian words
let (vm2, used) = Vm::deserialize(progs.clone(), &buf)?; // validates everything; Err on
                                             // bad/mismatched data (progs fingerprint checked)
vm.hash() -> u64 ; vm.hash_into(&mut qcvm::StateHasher)  // canonicalises NaN in float-typed words
```
Serialize only between calls (not from inside a builtin). The stopped/error state,
config, edicts (+ free/freetime/serial), globals, all strings, tokenize state and PRNG
are included; budgets are not.

### Math helpers (exact QW float behaviour, libm only)

`qcvm::math::{angle_vectors(angles) -> (fwd, right, up), vectoyaw(v), vectoangles(v),
normalize(v), vlen(v), anglemod(a)}` — the engine's pmove/physics should use these so
QC and engine agree bit for bit.

### Errors

`VmError { kind: ErrorKind, message: String, trace: String }`, `Display` = message +
QC stack trace. `ErrorKind`: `NullFunction, BadFunction, BadOpcode, StackOverflow,
LocalStackOverflow, Runaway, BadEntity, BadField, BadPointer, WorldAssignment,
BadStatement, QcError, ObjError, Break, StringLimit, UnknownBuiltin, Host, Stopped,
BadState, Parse`. `VmError::host(msg)` for engine-raised errors.
