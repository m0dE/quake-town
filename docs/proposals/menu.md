# Proposals from the menu part (src/menu, src/rooms, src/settings, tools/export.mjs)

## Game part (src/main.ts)

1. **Wire the 3D preview and the id-pak loader** into `showMenu` deps. `IdPaks` already matches
   `IdPakLoader`. The renderer's `PlayerLook` (`{ model?: path, skin: number, top, bottom }`)
   differs from the settings' `PlayerLook` (`{ model: name, skin: string, topcolor, bottomcolor }`,
   the cvar values), so adapt it:

   ```ts
   import { renderCharacterPreview } from './render/preview.js';
   m.showMenu(menuRoot, {
     central, notice, packIndex, cacheLocalPack,
     idPaks: content.idPaks,                       // or new IdPaks(store, vfs)
     renderPreview: (canvas, look, t) => renderCharacterPreview(canvas, vfs, {
       model: `progs/${look.model}.mdl`, skin: Number.parseInt(look.skin, 10) || 0,
       top: look.topcolor, bottom: look.bottomcolor,
     }, t),
     models: () => vfs.list('progs/').filter((p) => /^progs\/player\w*\.mdl$/.test(p)).map((p) => p.slice(6, -4)),
   });
   ```
   `src/menu/dev.ts` (`?real=1`) does exactly this and works.

2. **Real ping in the server list:** once connected, call
   `rememberNodeRtt(authorityNodeId, lockstep.roundTripMs)` from `src/rooms/ping.ts` (every few
   seconds is fine; it smooths). The node id is the room's `RoomInfo.authorityNodeId` (the menu's
   `ServerRow.node`), or whatever the connection reports. Without it the list shows the region
   node's HTTP RTT (if `VITE_ARRR_NODE_*` is set) or `~` the RTT to central.

3. `PlayRequest.password` is the typed password (already checked); nothing needs it unless the
   game wants to show it. `PlayRequest.nodeUrl` is set only when `VITE_ARRR_NODE_<REGION>` is.

## HUD part

4. Draw the crosshair with `drawCrosshair(ctx, cx, cy, crosshairFromCvars(dpr * hud_scale))`
   from `src/settings/crosshair.ts`, so the game matches the Player screen's designer (shapes
   0–7, `crosshaircolor` is a Quake palette index, `crosshairsize`, `crosshairalpha`,
   `cl_crossx/y`).

## Renderer part

5. `renderCharacterPreview` in the menu's 3:4 canvas (300×400 CSS px at 1920, 260×347 at 1366)
   draws only the contact shadow and a very dark shape at the bottom; the model is not readable
   (SwiftShader, `docs/shots/menu/player-3d-*.png`). Probably the camera framing (fov 32 at
   eye (118,0,18) is tuned for a square/landscape canvas?) and/or exposure. The menu turns it with
   `t + drag offset`, so the renderer's own `yaw = 200 + t * 24` spin is fine.

## Content part

6. **CTF:** standing CTF servers now run `qt_fort, lqdm3, lqdm7, lqdm10, lqdm6` (static table in
   `src/rooms/modes.ts`); 4on4 starts on `qt_fort`, duel and 2on2 include `qt_tower`.
7. Room ids encode map names through an append-only one-byte dictionary (`MAP_DICT` in
   `src/rooms/config.ts`): lqdm1–13, `qt_aero`, `qt_dm1`–`qt_dm6`, `qt_ctf1`, `qt_ctf2`, `qt_tower`, `qt_fort`. Other
   names still work (spelled out, a few more bytes). Tell me new official map names and I append them.

## Mod part

8. Serverinfo the menu produces (`toServerinfo`), fixed key order:
   `*qt 1, hostname, mode, deathmatch, teamplay, timelimit, fraglimit, maxclients, bots,
   rotation, samelevel 0, watervis 0, [region], [overtime 3 for duel], [rounds = fraglimit for ca]`.
   Per mode: ffa dm3/tp0, duel dm3/tp0, 2on2 dm3/tp2, 4on4 dm1/tp2, ctf dm3/tp1 (fraglimit =
   capture limit), ca dm3/tp1 (fraglimit = rounds to win, default 7). Change any of these in
   `MODES` (src/rooms/modes.ts) if the mod wants different numbers.

## Integrator

9. Add `export/` to `.gitignore` (tools/export.mjs already skips it in source.zip).
10. Register the `quake-town` app on cloud.arrr.fun (fps 77) and build with
    `VITE_ARRR_APP_ID=<id>`; `DEFAULT_APP_ID` in `src/rooms/listing.ts` is a placeholder until
    then (listing fails soft: standing servers still show and join). Optionally
    `VITE_ARRR_NODE_NA/EU/ASIA` for regional placement + region ping.
11. The repo has no `@types/node`, so `tsc` reports every test that imports `node:*`. The menu's
    tests use a tiny local assert (`src/rooms/assert.test-util.ts`) to stay clean; adding
    `@types/node` (dev) would let others do the same.
