# src/render — the Quake Town renderer

three.js 0.171 (WebGL2, `RawShaderMaterial` everywhere), Quake coordinates (z up) end to end.
Everything drawn comes from one `RenderFrame` per animation frame; the renderer never
touches the sim or the network (DESIGN.md "Rendering", arrr-mono `harness/INTEGRATION.md`).

```ts
import { Renderer, createRenderFrame, MODERN_SETTINGS, CLASSIC_SETTINGS, renderCharacterPreview } from './render';

const r = new Renderer(canvas, vfs, MODERN_SETTINGS);   // vfs: src/content Vfs (needs gfx/palette.lmp, gfx/colormap.lmp)
await r.loadMap('qt_aero');                             // maps/qt_aero.bsp (+ maps/qt_aero.lit if present)
const frame = createRenderFrame();                      // keep ONE and refill it every frame
function tick(now: number) {
  fillFromLockstep(frame, ls.view(now));                // the shell's job, see below
  r.draw(frame);
  requestAnimationFrame(tick);
}
r.resize(cssW, cssH, devicePixelRatio);                 // on window resize
r.setSettings({ flashblend: true });                    // any subset; presets are plain objects
r.stats();                                              // { drawCalls, tris, ms, prepMs, faces, leafs, entities, particles, dlights }
renderCharacterPreview(menuCanvas, vfs, { skin: 0, top: 4, bottom: 12 }, t);   // menu, every frame
```

## RenderFrame (src/render/types.ts — the contract with the shell)

| field | meaning |
|---|---|
| `time` | sim seconds, fractional (the playout clock). Drives texture animation (5 Hz), lightstyles (10 Hz), sky scroll, warp, particles, alias frame lerp. Never a second clock. |
| `camera.origin`, `.angles`, `.fov` | QW `r_refdef`: eye (bob included in z), `[pitch, yaw, roll]` degrees (punch + roll added), horizontal fov of the whole view (ezQuake semantics). |
| `camera.blend` | QW `v_blend` rgba 0..1 from damage / bonus / powerups (see `viewBlend.ts`). The liquid tint is added by the renderer. |
| `camera.contents` | optional; the renderer finds it from the BSP when undefined. |
| `viewmodel` | `{ model, frame, prevFrame, frameLerp, effects, bob }` or `null`. Gun placed like V_CalcRefdef / CalcGunAngle. |
| `entities[0..entityCount)` | `{ num, serial, model, frame, prevFrame, frameLerp, skin, colors, effects, origin, angles, alpha, isLocalPlayer }`. `model` is the precache name ("progs/player.mdl", "*3", "maps/b_bh25.bsp", "progs/s_explod.spr"). Per-entity state is keyed by (num, serial). `prevFrame = -1` lets the renderer lerp frame changes itself at 10 Hz (r_lerpframes). |
| `lightstyles` | 64 strings (`world_lightstyles`), or null = all normal. |
| `events[0..eventCount)` | sim Events of ticks newly passed (kind 2 temp entities, kind 5 muzzle flashes are used), f32 words decoded; `ex/ey/ez` = beam end. |
| `viewEntity` | local player's edict number (beams start at the eye, muzzle flash from the camera). |
| `thirdPerson` | draw the local body too. |

Dynamic lights are derived by the renderer: entity `effects` (EF_BRIGHTLIGHT/DIMLIGHT,
EF_BLUE quad, EF_RED pent, both = purple), rocket model flag, muzzle flashes, explosions —
exactly QW's radii/lifetimes (cl_ents.c, cl_tent.c).

Filling it from the sim: `EntView` → entity (`num`, `serial`, model name from
`world_model_names[modelindex]`, `frame`, `skin`, `effects`, `origin`/`angles` lerped
between the bracketing confirmed ticks, projectiles extrapolated along `velocity`;
`colors` from the ClientRow of `colormap - 1`), `ClientView` of the local player from the
predicted ring → camera + viewmodel (`weaponmodel`, `weaponframe`), `Event`s → events.

## Settings

`RenderSettings` (types.ts) mirrors the QW cvars: `textureFilter` (gl_texturemode),
`dynamicLights` (r_dynamic), `flashblend` (gl_flashblend), `drawflat` (r_drawflat),
`fullbrightSkins` (r_fullbrightskins), `lerpFrames` (r_lerpframes), `waterAlpha`
(r_wateralpha), `drawViewModel`, `viewModelFov`, `particles`, `modelLighting`, post
(`bloom`, `bloomStrength`, `toneMapping` 'aces'|'none', `exposure`, `ssao`, `fxaa`, `msaa`,
`gamma`), `lightmapScale`, `waterWarp`, `resolutionScale`, `maxPixelRatio`.
Presets: `CLASSIC_SETTINGS` (nearest, flashblend, QW particles, GLQuake model shading, no
post — drawn straight to the canvas) and `MODERN_SETTINGS` (trilinear + aniso 8, dlights in
the lightmapped shader, soft particles, directional+rim model light, bloom, ACES, FXAA).

## How it draws

- **World** (`bsp.ts`, `world.ts`, `brushset.ts`): BSP29 and BSP2. Faces → one vertex
  buffer; lightmaps packed into atlas pages (each face's ≤4 style blocks side by side with a
  1-texel clamped border, `.lit` colour when present). The fragment shader sums the style
  blocks × the 64 lightstyle values (computed per frame, 'a'=0, 'm'=264/256) and applies
  Quake's ×2 overbright. Batches = texture × lightmap page, one draw each. Every frame:
  PVS of the camera leaf (decompressed only when the leaf changes) → leaf box vs frustum
  → face backface test → a dynamic index buffer, uploaded with one `bufferSubData`.
  Fullbright texels (colormap-detected) are unlit and feed bloom. `*` textures: per-pixel
  turbulence (EmitWaterPolys). `sky`: two layers scrolled per pixel (EmitSkyPolys).
  `+0..9` / `+a..j` animation chains at 5 Hz, alternate chain for brush entity frame 1.
  `{` textures alpha-tested. Worldspawn `fog` honoured.
- **Brush entities** `*N` and BSP item models (`maps/b_*.bsp`): static meshes at the entity
  origin/angles (R_RotateForEntity).
- **Alias models** (`mdl.ts`, `alias.ts`): every pose of a model in one RGBA8 texture
  (x, y, z, normal index), fetched by vertex id; frame interpolation in the vertex shader;
  group frames/skins animate on their intervals; seam vertices split; player skins
  translated (R_TranslatePlayerSkin rows) and cached per colour pair. Light from
  R_LightPoint (bilinear, coloured with .lit, lightstyles applied) + dlights. Classic =
  GLQuake shadedots (anorm_dots) with QuakeSpasm clamps; modern = hemispherical +
  key + per-vertex dlights + rim, quad/pent shells. Gun in its own pass after a depth
  clear, own fov.
- **Sprites** (`mdl.ts` SPR): instanced billboards, all frames of a model in one atlas.
- **Effects** (`effects.ts`, ported from QW r_part.c / cl_tent.c): particles (explosion,
  blob, gunshot/blood/spike puffs, lava/teleport splash, rocket/grenade/blood/tracer
  trails) with QW physics in fixed typed arrays, one instanced draw; dlights (64 slots,
  16 nearest/brightest go to the shaders); beams (bolt models every 30 units, random roll);
  explosion sprites at 10 fps; gl_flashblend glow balls (R_RenderDlight) + V_AddLightBlend.
- **Post** (`post.ts`): HDR half-float target (optional MSAA, depth texture for SSAO),
  dual-filter bloom fed by the alpha "emissive" weight + HDR overflow, optional SSAO,
  composite (ACES on highlights with an identity toe so dark corners keep detail, view
  blend, gamma, underwater warp), optional FXAA. Classic skips all of it.

No allocation per frame in `draw()`: typed arrays and pooled meshes/materials only.

## Test page

```
npx vite --config src/render/demo/vite.config.js      # http://127.0.0.1:5293/render.html?map=lqdm3
node src/render/demo/shots.mjs maps=lqdm1,lqdm3 views=3    # screenshots + numbers → docs/shots/renderer/
npx tsx src/render/render.test.mjs                     # unit tests (loaders, atlas, PVS, light point, effects)
```

Test data is LibreQuake (BSD-3), copied to `.cache/render-test/` (gitignored, never
committed): `maps/lqdm1..13.bsp/.lit` from `quake-ref/full/id1/maps`, `pak0.pak` from
`quake-ref/lite/id1`. Query string: `map`, `preset=classic|modern`, `fov`, `manual=1`
(no rAF loop; `window.__qt` drives it). Keys: click for mouse look, WASD/QE fly, shift
fast, 1/2 presets, F flashblend, B bloom, P drawflat, R rocket, G gunshot, L lightning,
T teleport, M next map, H hide overlay.
