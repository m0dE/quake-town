// Quake Town renderer contract (DESIGN.md "Rendering (renderer)").
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
//
// The shell fills ONE RenderFrame per rendered frame from lockstep.view(now) (already
// interpolated: others from the confirmed ring at alpha, the local player from the
// predicted ring at selfAlpha) and hands it to Renderer.draw(). The renderer never
// touches the sim or the network.
//
// Everything is in Quake units and Quake conventions: z up, angles in degrees as
// [pitch, yaw, roll] (QC `angles` / `v_angle`; camera pitch positive = looking down,
// exactly like QW's r_refdef.viewangles).
//
// Allocation-free use: keep one RenderFrame and reuse its arrays and objects every frame;
// set `entityCount` / `eventCount` instead of resizing the arrays.

/** A mutable xyz triple (an array of 3 numbers or a Float32Array(3)). */
export type Vec3 = { 0: number; 1: number; 2: number; length: number };

export interface RenderCamera {
  /** eye position (QW r_refdef.vieworg: body origin + view_ofs + bob, punch excluded) */
  origin: Vec3;
  /** view angles [pitch, yaw, roll], degrees, Quake convention; punchangle/roll already added */
  angles: Vec3;
  /** horizontal field of view of the whole view in degrees (QW/ezQuake `fov`, 90 default) */
  fov: number;
  /**
   * Screen blend (damage, bonus flash, quad/pent/ring, all but the liquid tint) as
   * straight rgba 0..1, QW's v_blend: drawn as one translucent quad over the view.
   * `viewBlend.ts` has a port of QW's V_CalcBlend the shell can use to compute it.
   */
  blend: { 0: number; 1: number; 2: number; 3: number; length: number };
  /**
   * Contents at the eye (-1 empty, -3 water, -4 slime, -5 lava). Leave undefined to let the
   * renderer find it from the BSP (it does: Mod_PointInLeaf at the eye). Drives the liquid
   * tint (QW cshift_water/slime/lava) and the underwater warp.
   */
  contents?: number;
}

export interface RenderViewModel {
  /** "progs/v_rock.mdl"; '' = no weapon drawn */
  model: string;
  frame: number;
  /** previous frame for interpolation, or -1 to let the renderer track frame changes */
  prevFrame: number;
  /** 0..1 lerp from prevFrame to frame, used when prevFrame >= 0 */
  frameLerp: number;
  /** QW EF_* bits of the player (quad/pent shells, muzzle flash) */
  effects: number;
  /**
   * View bob (QW V_CalcBob, units). The renderer places the gun like V_CalcRefdef:
   * origin = camera.origin + forward·bob·0.4 + fudge, angles = view angles with the
   * pitch inverted for the alias model. camera.origin already contains the +bob in z.
   */
  bob: number;
}

export interface RenderEntity {
  /** edict number (1..maxclients are players) */
  num: number;
  /** bumps when the edict index is reused; the renderer keys its per-entity state on (num, serial) */
  serial: number;
  /** precache name: "progs/player.mdl", "*3" (brush submodel), "progs/s_explod.spr" */
  model: string;
  frame: number;
  /** previous frame for interpolation, or -1 to let the renderer track frame changes (r_lerpframes) */
  prevFrame: number;
  /** 0..1 lerp from prevFrame to frame, used when prevFrame >= 0 */
  frameLerp: number;
  /** skinnum */
  skin: number;
  /** player colours (QW topcolor/bottomcolor 0..13) for player-coloured models, or null */
  colors: { top: number; bottom: number } | null;
  /** QW EF_* bits */
  effects: number;
  origin: Vec3;
  /** QC angles [pitch, yaw, roll], degrees */
  angles: Vec3;
  /** 0..1 (1 opaque) */
  alpha: number;
  /** the body the camera is in: not drawn in first person (its dlights still are) */
  isLocalPlayer: boolean;
}

/**
 * A sim Event (DESIGN.md Event table) passed through, with the f32 words decoded.
 * Only the events of ticks newly passed since the previous frame; the renderer consumes
 * kind 2 (temp entity), kind 5 (muzzle flash) and kind 10 (intermission) and ignores the rest.
 */
export interface RenderEvent {
  kind: number;
  a: number;
  b: number;
  c: number;
  d: number;
  /** x,y,z f32 (origin / TE start) */
  x: number;
  y: number;
  z: number;
  /** TE end point for beams (kind 2: e, f, d words decoded as f32); 0 otherwise */
  ex: number;
  ey: number;
  ez: number;
}

export interface RenderFrame {
  /** sim time in seconds (fractional, the playout clock). Drives texture animation, lightstyles, sky, particles. */
  time: number;
  camera: RenderCamera;
  /** null = no gun drawn (spectator, intermission, dead) */
  viewmodel: RenderViewModel | null;
  entities: RenderEntity[];
  /** number of valid entries in `entities` */
  entityCount: number;
  /** 64 lightstyle strings ("m", "mmnmmommommnonmmonqnmmo", …); null = all "m" */
  lightstyles: ArrayLike<string> | null;
  events: RenderEvent[];
  /** number of valid entries in `events` */
  eventCount: number;
  /** edict number of the local player (beams from it start at the eye), 0 if none */
  viewEntity: number;
  /** draw the local player's own body too (chase camera / third person) */
  thirdPerson?: boolean;
}

export type TextureFilter = 'nearest' | 'linear';

export interface RenderSettings {
  /** gl_texturemode: 'nearest' = GL_NEAREST_MIPMAP_LINEAR (classic pixels), 'linear' = trilinear */
  textureFilter: TextureFilter;
  /** anisotropic filtering (1 = off) */
  anisotropy: number;
  /** r_dynamic: dynamic lights light the world and models */
  dynamicLights: boolean;
  /** gl_flashblend: QW's additive glow balls instead of lighting the world */
  flashblend: boolean;
  /** r_drawflat: flat-coloured world (walls / floors) with lightmaps */
  drawflat: boolean;
  /** r_fullbrightskins: player models unlit */
  fullbrightSkins: boolean;
  /** r_lerpframes: interpolate alias model frames */
  lerpFrames: boolean;
  /** smooth lightstyle animation (interpolate between the 10 Hz steps) */
  smoothLightstyles: boolean;
  /** r_wateralpha 0..1 (maps must be vis'd for transparent water to look right) */
  waterAlpha: number;
  /** r_drawviewmodel */
  drawViewModel: boolean;
  /** fov for the gun; 0 = the camera's fov */
  viewModelFov: number;
  /** particles: 'classic' = QW square dots, 'modern' = soft round, glowing fire */
  particles: 'classic' | 'modern';
  /** modern model lighting (directional + rim + coloured lightgrid) vs GLQuake shadedots */
  modelLighting: 'classic' | 'modern';
  /** post: bloom from emissive/HDR pixels */
  bloom: boolean;
  bloomStrength: number;
  /** post: 'aces' filmic tone mapping (HDR), 'none' = clamp like GLQuake */
  toneMapping: 'none' | 'aces';
  exposure: number;
  /** post: screen-space ambient occlusion (off by default) */
  ssao: boolean;
  /** post: FXAA */
  fxaa: boolean;
  /** MSAA samples on the scene target (0 = off) */
  msaa: number;
  /** v_gamma style: output = color^(1/gamma) (1 = off) */
  gamma: number;
  /** lightmap brightness multiplier on top of Quake's ×2 overbright (1 = Quake) */
  lightmapScale: number;
  /** underwater screen warp (software Quake's r_waterwarp) */
  waterWarp: boolean;
  /** render resolution scale relative to canvas pixels (0.25..1) */
  resolutionScale: number;
  /** cap on devicePixelRatio */
  maxPixelRatio: number;
}

/** The look of a player for the menu preview (DESIGN.md "Customization"). */
export interface PlayerLook {
  /** model path, default "progs/player.mdl" */
  model?: string;
  /** skin index in the model */
  skin: number;
  /** QW topcolor / bottomcolor 0..13 */
  top: number;
  bottom: number;
}

/** GLQuake / QW look: pixels, flashblend balls, no post. */
export const CLASSIC_SETTINGS: RenderSettings = {
  textureFilter: 'nearest', anisotropy: 1, dynamicLights: true, flashblend: true, drawflat: false,
  fullbrightSkins: false, lerpFrames: true, smoothLightstyles: false, waterAlpha: 1, drawViewModel: true,
  viewModelFov: 0, particles: 'classic', modelLighting: 'classic', bloom: false, bloomStrength: 0,
  toneMapping: 'none', exposure: 1, ssao: false, fxaa: false, msaa: 0, gamma: 1, lightmapScale: 1,
  waterWarp: false, resolutionScale: 1, maxPixelRatio: 1,
};

/** Modern look: trilinear + anisotropic, dynamic lights in the lightmapped shader, bloom, ACES. */
export const MODERN_SETTINGS: RenderSettings = {
  textureFilter: 'linear', anisotropy: 8, dynamicLights: true, flashblend: false, drawflat: false,
  fullbrightSkins: false, lerpFrames: true, smoothLightstyles: true, waterAlpha: 1, drawViewModel: true,
  viewModelFov: 0, particles: 'modern', modelLighting: 'modern', bloom: true, bloomStrength: 0.55,
  toneMapping: 'aces', exposure: 1.2, ssao: false, fxaa: true, msaa: 0, gamma: 1, lightmapScale: 1,
  waterWarp: true, resolutionScale: 1, maxPixelRatio: 1.5,
};

export const PRESETS = { classic: CLASSIC_SETTINGS, modern: MODERN_SETTINGS } as const;

export interface RenderStats {
  /** GL draw calls of the last frame (all passes) */
  drawCalls: number;
  /** triangles of the last frame (all passes) */
  tris: number;
  /** CPU ms spent in draw() for the last frame (includes GL command submission) */
  ms: number;
  /** CPU ms of draw() before the first GL render call (culling, entities, effects: pure JS) */
  prepMs?: number;
  /** world faces / leafs drawn after PVS + frustum culling */
  faces?: number;
  leafs?: number;
  entities?: number;
  particles?: number;
  dlights?: number;
}

/** Quake CONTENTS_* for camera.contents */
export const CONTENTS_EMPTY = -1;
export const CONTENTS_SOLID = -2;
export const CONTENTS_WATER = -3;
export const CONTENTS_SLIME = -4;
export const CONTENTS_LAVA = -5;
export const CONTENTS_SKY = -6;

/** QW EF_* bits */
export const EF_BRIGHTFIELD = 1;
export const EF_MUZZLEFLASH = 2;
export const EF_BRIGHTLIGHT = 4;
export const EF_DIMLIGHT = 8;
export const EF_FLAG1 = 16;
export const EF_FLAG2 = 32;
export const EF_BLUE = 64;
export const EF_RED = 128;

/** QW TE_* ids (Event kind 2, word a) */
export const TE_SPIKE = 0;
export const TE_SUPERSPIKE = 1;
export const TE_GUNSHOT = 2;
export const TE_EXPLOSION = 3;
export const TE_TAREXPLOSION = 4;
export const TE_LIGHTNING1 = 5;
export const TE_LIGHTNING2 = 6;
export const TE_WIZSPIKE = 7;
export const TE_KNIGHTSPIKE = 8;
export const TE_LIGHTNING3 = 9;
export const TE_LAVASPLASH = 10;
export const TE_TELEPORT = 11;
export const TE_BLOOD = 12;
export const TE_LIGHTNINGBLOOD = 13;

/** Event kinds the renderer consumes */
export const EV_TEMP_ENTITY = 2;
export const EV_MUZZLEFLASH = 5;

/** A fresh, reusable RenderFrame with `entityCap` entity slots and `eventCap` event slots. */
export function createRenderFrame(entityCap = 512, eventCap = 256): RenderFrame {
  const entities: RenderEntity[] = [];
  for (let i = 0; i < entityCap; i++) {
    entities.push({
      num: 0, serial: 0, model: '', frame: 0, prevFrame: -1, frameLerp: 0, skin: 0, colors: null, effects: 0,
      origin: [0, 0, 0], angles: [0, 0, 0], alpha: 1, isLocalPlayer: false,
    });
  }
  const events: RenderEvent[] = [];
  for (let i = 0; i < eventCap; i++) events.push({ kind: 0, a: 0, b: 0, c: 0, d: 0, x: 0, y: 0, z: 0, ex: 0, ey: 0, ez: 0 });
  return {
    time: 0,
    camera: { origin: [0, 0, 0], angles: [0, 0, 0], fov: 90, blend: [0, 0, 0, 0] },
    viewmodel: null,
    entities, entityCount: 0,
    lightstyles: null,
    events, eventCount: 0,
    viewEntity: 0,
  };
}
