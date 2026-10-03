# Brief for every part (read before you start)

You are one of several agents building **Quake Town** in parallel, in the repository
`/app/data/home/quake-town` (its own git repo, GPL-2.0-or-later). Read `DESIGN.md` first: it is
the contract. Then read the prior art your part needs.

Rules
- Own only your directories (DESIGN.md "Layout and ownership"). Read anything; edit only yours.
  Need a change elsewhere or in DESIGN.md? Write it in `docs/proposals/<your-part>.md` and
  mention it in your final report. Do not edit DESIGN.md.
- **Do not commit, do not push, do not run `git stash`/`git checkout`/`git reset`.** The
  integrator commits. Others are editing the same working tree right now.
- The box is small: 2 cores, ~2-3 GB free RAM, shared with 6 other agents.
  `export CARGO_BUILD_JOBS=1`; run heavy compiles with `nice`; at most ONE headless Chromium
  at a time, and close it; kill every process you start (no `lsof` here: use
  `ss -tlnpH 'sport = :PORT'` and `pkill -f`). Never kill processes you did not start.
  Pick a dev-server port unique to your part (given in your task) to avoid clashes.
- Rust: `export PATH=$HOME/.cargo/bin:$PATH` (rustc 1.99, wasm32-unknown-unknown installed).
  Node 22. Deps are installed (`node_modules`: three, fflate, arrr-network, vite, tsx, typescript).
  Need another npm dep? Propose it; don't `npm install` yourself.
- Headless Chromium: `import { chromium } from '/app/data/home/arrr-mono/node_modules/playwright/index.mjs'`
  and `chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] })`. Never run
  `npx playwright install`. Screenshot what you build and LOOK at the PNGs (Read the file).
  Put screenshots under `docs/shots/<your-part>/`.
- Licensing: id's Quake/QW source (GPL-2.0-or-later) is at `/app/data/home/quake-ref/Quake`
  (`QW/client`, `QW/server`, `qw-qc`). Keep id's copyright notice in the header of every file
  ported from it. ezQuake/FTE/KTX are GPL-2.0-or-later too (keep their notices if you port).
  No GPL-3-only code. Never copy id's game data (no id pak, no id map) into the repo.
- Reference data: LibreQuake v0.09 (BSD-3 assets) at `/app/data/home/quake-ref/full/id1`
  (`maps/lqdm1..13.bsp` + `.lit`; `pak0.pak`/`pak1.pak` are inside
  `/app/data/home/quake-ref/lq-full.zip` under `full/id1/` - unzip what you need into
  `/app/data/home/quake-ref/`, not into the repo). id's compiled `qwprogs.dat` (GPL) is at
  `/app/data/home/quake-ref/Quake/QW/progs/qwprogs.dat` and is fine for testing.
- Prior art, same team and stack: `/app/data/home/doom-arrr` (Doom on arrr-network: `DESIGN.md`,
  `sim/` Rust→wasm C ABI, `src/sim/doomsim.ts`, `src/net/session.ts`, `src/render/`, `src/menu/`,
  `tools/export.mjs`), `/app/data/home/vibe-strike` (CS 1.6 clone: menu, rooms, regions,
  account), `/app/data/home/arrr-mono` (`sdk/docs/lockstep.md`, `harness/INTEGRATION.md`,
  `central/`, `e2e/cluster.js`).
- Quality bar: it must feel exactly like QuakeWorld, be extremely optimized and beautiful.
  Write tests. Measure. Be honest in the report: what works, what does not, numbers.

Final report (your last message): what you built (files), how to run/test it, numbers,
screenshots you looked at, known gaps, proposals for other parts.
