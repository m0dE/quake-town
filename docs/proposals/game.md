# Proposals from the game part (shell: net, game loop, HUD, console, audio, demos)

## 1. Settings (menu part) — adopted, nothing to change

The console uses `src/settings` directly: `cvars` (the registry), `binds`, `configs`,
`settings.exportText()` for `writeconfig`, `userinfo()`, `drawCrosshair()`. The shell
registers its own few cvars in group `game` (`src/console/cvars.ts` `SHELL_CVARS`:
`cl_yawspeed`, `cl_pitchspeed`, `con_notifylines`, `show_net`, `hud_killfeed`,
`cl_chasecam`, `cl_predict_projectiles`, `cl_demospeed`, `gl_cshiftpercent`,
`scr_conspeed`, `cl_hudswap`). Aliases are kept by the console (`qt.aliases` in
localStorage); they could join the settings document (`aliases` record) so they follow
the account — proposal to the menu part. The settings default binds use
`weapon 7 5 4 3 2 1` (q) and `weapon 8 5 3 2 1` (e): the shell implements ezQuake's
`weapon` command (first owned weapon with ammo → its impulse).

## 2. Engine (`sim/qtsim`)

1. ~~`world_hash` costs as much as a tick~~ — done: after the cheaper hash landed it
   measures 51–81 µs (Node, qt_aero, 4–8 slots, was 0.6–0.8 ms), so `HASH_EVERY` in
   `src/net/session.ts` is back to 1 (a verdict on every frame).
2. **`world_tick` at 0.6 ms (4 slots, no bots) to 1.1 ms (16 slots with bots)** on this
   box under load. At 77 Hz with whole-world prediction a client steps the world about
   2–3 times per tick (confirmed + predicted + replays after a misprediction): budget is
   tight on a laptop. Profile `SV_Physics`/bots.
3. ~~ClientView word 49 = sim time~~ — landed and used for the match clock. Was: **ClientView word 49 = sim time (f32)**. The shell needs the sim's `time` for the
   match clock (`phaseEnd - time`). It derives it as `1 + (frame - mapStartFrame) × 0.013`
   with `mapStartFrame` from event 13, which is exact only while ticksPerFrame = 1 and
   the world was seen from its first changelevel. One word removes the guess.
4. **Reconnect after idle keeps frags.** `world_client_join` on a slot whose state is 3
   (idle-human, the same member coming back) should keep frags and stats; DESIGN says join
   resets them. (The fake sim, `src/sim/fake.ts`, does this.)
5. `world_ambients` / `world_stopped` are used by the shell (static sounds; a fatal QC
   error ends the match with the message). Please add both to DESIGN's ABI table.

## 3. Content / mod

1. **`public/packs/index.json` goes stale while `build:mod` runs**: the index named
   `qtdm-6253a9071f97.pk3` while the directory held `qtdm-7340…`, then `qtdm-8f09…`; the
   page fetches the missing file, the dev server answers with index.html, and the sha256
   check refuses it ("Could not start: sha256 mismatch"). `build:mod` should rewrite the
   index entry (atomically: write a temp file and rename) in the same step it writes the
   pack. The shell's tests use `tools/test/test-public.mjs` (a scratch copy of public/
   with the index recomputed from the files present) until then.
2. The id-pak loader for the menu (`MenuDeps.idPaks`) is not wired by the shell yet:
   `main.ts` passes `packIndex` and `cacheLocalPack`; once content exports an
   `IdPakLoader`, main mounts the player's paks with role `idpak` (art only; progs and
   BSPs always come from `vfs.sim`).

## 4. Repository

1. **`@types/node`** is not installed, so the Node tests in `tools/test/*.ts` carry
   `// @ts-nocheck` (they run fine under tsx). Adding `@types/node` to devDependencies and
   `"types": ["vite/client", "node"]` for `tools/` would type-check them.
2. `vite.config.js`: the shell's long browser tests use `tools/test/vite.test.config.js`
   + `tools/test/serve-build.sh` (a built bundle on :5191): the dev server reloads every
   page whenever any part edits a file, which ends a two-minute multiplayer run.

## 5. Tick rate measurements (for DESIGN.md "Tick rate")

Measured 2026-10-03 on the local cluster (`arrr-mono/e2e/cluster.js`: central :9201,
nodes :8201/:8202), app created at `fps: 77` (first connect of a fresh app id: central
stores the client's rate; an existing app keeps its own), room `qt_aero`, 3 browser
pages (one headless Chromium, real `qtsim.wasm`, top-down view), 150 s of scripted play,
`tools/test/multiplayer.mjs`. **The box was at load average 20–31 on 2 cores** (six
other agents compiling Rust, building maps, running Chromium), so every number below is
a worst case, not a target.

| what | value |
|---|---|
| node rate stated at connect | 77 |
| node rate measured by a Node client (2,270 ticks) | **72.1 Hz**, interval mean 13.88 ms, sd 3.56, p50 13.32, p90 17.89, p99 25.93, p99.9 34.35, max 42.0 ms; 22 intervals > 2 ticks, 1 > 3 ticks, 0 gaps |
| tick arrival in the pages (busy main threads) | 62–69 Hz, p50 8.6–10.3 ms, p99 80–103 ms, max 177–570 ms |
| desyncs / resyncs, 3 pages | **0 / 0**; 10/10 cross-page hash checks agreed; ~2,900 verdicts per page |
| rollbacks / mispredictions per page | 800–944 / 130–343 in 150 s (pages drew at 0.2 fps: their beats ran late, inputs landed late) |
| sim cost per tick in the page (4 slots, no bots) | 390–490 µs (`world_tick` + event copy) |

Reading: the node's timer held 72 of 77 Hz under that load with a tight p50 (13.3 ms)
and a 26 ms p99; nothing here says 77 Hz is unsustainable on an idle node, but it
should be re-measured on a quiet box (and on the production node) before DESIGN
calls it settled. The lockstep agreed on every frame it judged.

Arena judge (`arrr-mono/harness/scenarios/arena-judge.ts clean --fps=77 --walkers=2
--no-gpu`, the page with `?probe=1`, same loaded box): **unjudgeable** — the page drew
42 frames in 30 s (1 fps on swiftshader at load ~15), so the clock and screen rules
abstained; desync 1,192 verdicts agreed, 0 disagreed, 0 resyncs. It needs a quiet box
with a GPU (the judge's default with `--url`). The probe hooks are wired in `main.ts`
(`clock` with `at`, `drawn`/`sim` in metres at 0.0254 m per unit, `self`). The harness's
own Playwright (1.234) needs `PLAYWRIGHT_BROWSERS_PATH` pointing at a directory that
aliases `chromium_headless_shell-1234` to the 1243 build installed here.
