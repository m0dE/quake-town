# Proposals from the renderer part (src/render)

## Shell (game loop) — filling RenderFrame

The contract is `src/render/types.ts` (documented in `src/render/README.md`). Use
`createRenderFrame()` once and refill it each rAF from `lockstep.view(now)`:

1. **Entities**: one `RenderEntity` per `EntView` (`entityCount` = how many). `model` =
   `world_model_names[modelindex]` (interned strings, no per-frame allocation), `num`/`serial`
   straight from the EntView, `origin`/`angles` lerped between the bracketing confirmed ticks
   (angles lerped the short way round, like CL_LinkPacketEntities), projectiles
   (MOVETYPE_FLY/FLYMISSILE/BOUNCE) extrapolated along `velocity`. `colors` = `{ top, bottom }`
   of ClientRow `colormap - 1` when `colormap != 0`, else `null`. Leave `prevFrame = -1`: the
   renderer lerps frame changes itself at 10 Hz against `time` (r_lerpframes); set
   `isLocalPlayer` on the camera's own body.
2. **Camera**: eye = predicted origin + `view_ofs_z` + bob; angles = view angles + punchangle +
   V_CalcViewRoll + damage kick (`ViewBlend.kickRollNow/kickPitchNow`); `fov` = the `fov` cvar.
   `blend` = `ViewBlend.update(dt, items)` (`src/render/viewBlend.ts`, a port of V_CalcBlend:
   call `.damage(...)` on Event kind 6 for the local slot and `.bonus()` on kind 14). Leave
   `contents` undefined: the renderer finds the liquid from the BSP and adds the QW tint.
3. **Viewmodel**: `{ model: world_model_names[weaponmodel], frame: weaponframe, prevFrame: -1,
   effects, bob }` from the predicted ClientView, `null` when dead / intermission / spectating
   in free fly.
4. **Events**: pass every Event of ticks newly passed, with the f32 words decoded
   (`x,y,z`; for kind 2 beams `ex,ey,ez` = e, f, d words as f32). Muzzle flashes (kind 5) and
   temp entities (kind 2) are drawn; the rest is ignored.
5. `lightstyles` = the 64 strings of `world_lightstyles` (re-read on Event kind 9 only).
6. `viewEntity` = the local player's entnum (beams and muzzle flash start at the eye).
7. Call `renderer.resize(cssW, cssH, devicePixelRatio)` on resize, `renderer.loadMap(name)`
   on world creation and on Event 13 (changelevel), and map the cvars to `setSettings`:
   `gl_flashblend`→`flashblend`, `r_dynamic`→`dynamicLights`, `r_drawflat`→`drawflat`,
   `r_fullbrightskins`→`fullbrightSkins`, `gl_texturemode`→`textureFilter`,
   `r_lerpframes`→`lerpFrames`, `r_wateralpha`→`waterAlpha`, `r_drawviewmodel`→
   `drawViewModel`, `gamma`→`gamma`; a "video quality" menu entry → `CLASSIC_SETTINGS` /
   `MODERN_SETTINGS`.

## Engine (sim)

8. **Static entities.** QW's `makestatic` (torches, flames: `light_torch_small_walltorch`,
   `light_flame_*`) removes the edict and the server sends `svc_spawnstatic`. EntView only lists
   live edicts, so torches would disappear. Please either keep `makestatic`'d entities as
   EntViews (simplest: don't free the edict, mark it static so physics skips it) or add
   `world_static_ents(h)` (same EntView layout, rebuilt on map load). The renderer draws
   whatever it is given.
9. Item `EF_ROTATE` spinning is done by the renderer from the model flags (no sim work).

## Content

10. The base pack must contain what the renderer loads by name: `gfx/palette.lmp`,
    `gfx/colormap.lmp`, `progs/s_explod.spr`, `progs/bolt.mdl`, `bolt2.mdl`, `bolt3.mdl`,
    and every item BSP the mod precaches (`maps/b_bh10/25/100.bsp`, `b_shell0/1`, `b_nail0/1`,
    `b_rock0/1`, `b_batt0/1`, `b_explob`) — they are drawn as brush models with their own
    lightmaps. `.lit` files next to the maps are used when present.
11. Maps with translucent water should keep `_wateralpha` (or `wateralpha`) in worldspawn:
    the renderer only draws water translucent when the map says it was vis'd for it. The
    worldspawn `fog "density r g b"` key is honoured.

## Menu

12. `renderCharacterPreview`: the "dark shape" in `docs/shots/menu/player-3d-*.png` was a
    renderer bug (fog uniform defaulted to density 1), fixed. The model now starts in a 3/4
    front view; framing is tuned for a 3:4 canvas. `docs/shots/renderer/preview-*.png`.
