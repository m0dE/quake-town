# tools/qc — building the QuakeC mod

`node tools/qc/build-mod.mjs` (`npm run build:mod`) compiles `mod/qtdm/progs.src` into
`mod/qtdm/build/qwprogs.dat`, checks it is a QuakeWorld progs (version 6, progdefs CRC
54730, vanilla opcodes), and packs it with `mod/qtdm/qtdm.txt` into
`public/packs/qtdm-<sha12>.pk3` — a deterministic zip (entries sorted, fixed timestamps,
deflate level 9), so the same source always gives the same sha256. Older `qtdm-*.pk3`
files are removed. It also writes `mod/qtdm/build/pack.json`
(`{ id, name, kind, file, bytes, files }`) for the content part's `index.json`.

`mod/qtdm/build/qtcfg.qc` is generated on every build: the CTF flag model is
`progs/flag.mdl` when a content pack (`public/packs/index.json`) or `content/` has one,
else `progs/backpack.mdl` with a red / blue glow. Force it with `QT_FLAG_MODEL=1|0`.
Note that the pack's sha changes when that choice changes, so build content first.

`QC_VERBOSE=1` prints the compiler's full output (warnings come from id's original code;
the build fails on any error).

## The compiler

The build looks for, in order: `$QCC`, `/app/data/home/quake-ref/tools/fteqcc`, then
`fteqcc` / `gmqcc` on `PATH`. The compiler is a build-time tool and is never shipped
(the repo carries no compiler binary or source).

**fteqcc** (used; GPL-2.0-or-later, from FTEQW's `engine/qclib`). Build it outside the
repo, about a minute on one core:

```sh
mkdir -p /app/data/home/quake-ref/tools && cd /app/data/home/quake-ref/tools
git clone --depth 1 --filter=blob:none --sparse https://github.com/fte-team/fteqw.git fteqw-src
cd fteqw-src && git sparse-checkout set engine/qclib
cd engine/qclib
# NO_ZLIB: the box has no zlib headers; zlib is only for pk3 output, which we don't use
nice make -j1 qcc BASE_CFLAGS="-Wall -DNO_ZLIB" BASE_LDFLAGS=""
cp fteqcc.bin /app/data/home/quake-ref/tools/fteqcc
```

Built from fteqw commit `f937b9d88f71` (2026-06-04). The build passes `-Tq1` (id's
progs format, no extension opcodes).

**gmqcc** (MIT) also works in principle (`QCC=/path/to/gmqcc`; the script passes
`-std=fteqcc`), but the shipped pack is built with fteqcc.

## Notes for QuakeC authors

- fteqcc treats an initialised global (`float x = 1;`) as a constant and folds it; a
  global that code changes must be declared without an initialiser (see `rj` in
  `defs.qc`, set in `QT_InitMode`).
- `ftos` / `infokey` may share one result buffer (as in QW): use a result before the next
  call (`strcat` copies).
- The system globals and fields in `defs.qc` up to `end_sys_fields` must not change: they
  define the QW progdefs CRC the engine checks.

## Testing the mod

`QTRUN=… node tools/qc/test-modes.mjs` runs every mode in the engine's native runner
(`sim/qtsim/src/bin/qtrun.rs`) with bots on LibreQuake maps and checks the match flow
(warmup/ready/break, countdown, timelimit, overtime, intermission, rotation, team scores,
CA rounds). CTF captures, drops, teammate returns and the 30 s auto return are scripted
inside the world by `mod/qtdm/selftest.qc`, active only with serverinfo `qt_selftest ctf`.
