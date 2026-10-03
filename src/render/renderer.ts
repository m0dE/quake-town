// The Quake Town renderer (DESIGN.md "Rendering (renderer)").
// Copyright (C) 1996-1997 Id Software, Inc. (view/gun placement from QW/client/view.c,
// entity effects from cl_ents.c, temp entities from cl_tent.c, alias lighting from
// gl_rmain.c). Copyright (C) 2026 Quake Town contributors.
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.
//
// Draw calls per frame (typical): world batches (one per texture × lightmap page in view),
// brush entities (one per texture), one per alias entity, one per sprite model, particles,
// glows, the gun, and post (bloom 9 small passes + composite + FXAA).
import * as THREE from 'three';
import type { Vfs } from '../content/types';
import { AliasModel, AliasShared, aliasMaterial, bindAliasModel, entityMatrix } from './alias';
import { loadBsp, parseEntities } from './bsp';
import { BrushSet } from './brushset';
import { DL_COLORS, DL_LIGHT_COLORS, Dlights, MAX_BEAMS, MAX_DLIGHT_SLOTS, MAX_EXPLOSIONS, Particles, TempEnts, PT_EXPLODE, PT_EXPLODE2, PT_FIRE, PT_BLOB, PT_BLOB2 } from './effects';
import { MF_GIB, MF_GRENADE, MF_ROCKET, MF_ROTATE, MF_TRACER, MF_TRACER2, MF_TRACER3, MF_ZOMGIB, loadMdl, loadSpr, mdlPose, mdlSkinImage, type Spr } from './mdl';
import { Palette } from './palette';
import { PostFX, type PostOptions } from './post';
import { GLOW_FS, MAX_DLIGHTS, PARTICLE_FS, PARTICLE_VS, SPRITE_FS, SPRITE_VS } from './shaders';
import { applyFilter, rgbaTexture } from './textures';
import {
  CONTENTS_LAVA, CONTENTS_SLIME, CONTENTS_WATER, EF_BLUE, EF_BRIGHTLIGHT, EF_DIMLIGHT, EF_RED, EV_MUZZLEFLASH, EV_TEMP_ENTITY,
  MODERN_SETTINGS, TE_BLOOD, TE_EXPLOSION, TE_GUNSHOT, TE_KNIGHTSPIKE, TE_LAVASPLASH, TE_LIGHTNING1, TE_LIGHTNING2, TE_LIGHTNING3,
  TE_LIGHTNINGBLOOD, TE_SPIKE, TE_SUPERSPIKE, TE_TAREXPLOSION, TE_TELEPORT, TE_WIZSPIKE,
  type RenderFrame, type RenderSettings, type RenderStats, type Vec3,
} from './types';

const MAX_EDICTS = 4096;
const MAX_PARTICLES = 4096;
const MAX_GLOWS = 64;
const MAX_SPRITES = 64;
const DEG = Math.PI / 180;
const PLANE_ORDER = [0, 1, 2, 3, 5]; // three.js frustum: right, left, bottom, top, (far), near
const WHITE = [1, 1, 1];

type ModelEntry =
  | { kind: 'alias'; model: AliasModel }
  | { kind: 'brush'; index: number }
  | { kind: 'sprite'; spr: Spr; batch: SpriteBatch }
  | { kind: 'bspmodel'; set: BrushSet; meshes: THREE.Mesh[]; used: number }
  | { kind: 'none' };

interface AliasInst { mesh: THREE.Mesh; mat: THREE.RawShaderMaterial }

/** Instanced camera-facing quads (sprites, flashblend glows). */
class SpriteBatch {
  readonly geo = new THREE.InstancedBufferGeometry();
  readonly mesh: THREE.Mesh;
  readonly pos: Float32Array; readonly rect: Float32Array; readonly tex: Float32Array; readonly color: Float32Array;
  private attrs: THREE.InstancedBufferAttribute[];
  count = 0;
  /** per (frame group, image): uv rect and left/up/w/h */
  frameUV: Float32Array = new Float32Array(0);
  frameRect: Float32Array = new Float32Array(0);
  frameBase: Int32Array = new Int32Array(0);
  constructor(readonly cap: number, material: THREE.RawShaderMaterial) {
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.pos = new Float32Array(cap * 4); this.rect = new Float32Array(cap * 4);
    this.tex = new Float32Array(cap * 4); this.color = new Float32Array(cap * 4);
    this.attrs = [this.pos, this.rect, this.tex, this.color].map((a) => new THREE.InstancedBufferAttribute(a, 4).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute);
    ['iPos', 'iRect', 'iTex', 'iColor'].forEach((n, i) => this.geo.setAttribute(n, this.attrs[i]));
    this.geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }
  push(x: number, y: number, z: number, left: number, up: number, w: number, h: number, u0: number, v0: number, uw: number, vh: number, r: number, g: number, b: number, a: number): void {
    if (this.count >= this.cap) return;
    const o = this.count++ * 4;
    this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
    this.rect[o] = left; this.rect[o + 1] = up; this.rect[o + 2] = w; this.rect[o + 3] = h;
    this.tex[o] = u0; this.tex[o + 1] = v0; this.tex[o + 2] = uw; this.tex[o + 3] = vh;
    this.color[o] = r; this.color[o + 1] = g; this.color[o + 2] = b; this.color[o + 3] = a;
  }
  commit(): void {
    for (let i = 0; i < this.attrs.length; i++) { const a = this.attrs[i]; a.clearUpdateRanges(); a.addUpdateRange(0, this.count * 4); a.needsUpdate = true; }
    this.geo.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
  }
}

interface MapState {
  name: string;
  set: BrushSet;
  worldGeo: THREE.BufferGeometry;
  worldMesh: THREE.Mesh;
  groups: { start: number; count: number; materialIndex: number }[];
  subMeshes: (THREE.Mesh | null)[];
  subDrawn: Uint8Array;
  fog: THREE.Vector4;
  /** worldspawn wateralpha / _wateralpha: the map was vis'd for translucent water (value), else -1 */
  waterAlpha: number;
}

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  private vfs: Vfs;
  private settings: RenderSettings;
  private pal: Palette;
  private scene = new THREE.Scene();
  private vmScene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(90, 1, 4, 32768);
  private vmCamera = new THREE.PerspectiveCamera(90, 1, 1, 4096);
  private post = new PostFX();
  private aliasShared = new AliasShared();
  private map: MapState | null = null;
  private models = new Map<string, ModelEntry>();
  /** the sprite and BSP-item entries of `models`, for allocation-free per-frame loops */
  private spriteList: { spr: Spr; batch: SpriteBatch }[] = [];
  private bspList: { set: BrushSet; meshes: THREE.Mesh[]; used: number }[] = [];
  private particles = new Particles(MAX_PARTICLES);
  private dl = new Dlights();
  private tents = new TempEnts();
  private lastStats: RenderStats = { drawCalls: 0, tris: 0, ms: 0 };
  private width = 1;
  private height = 1;
  private dpr = 1;
  private lastTime = -1;
  private styleValues = new Float32Array(64);
  // shared uniforms
  private su = {
    uStyles: { value: new Float32Array(64) },
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    uNumDl: { value: 0 },
    uDlPos: { value: Array.from({ length: MAX_DLIGHTS }, () => new THREE.Vector4()) },
    uDlCol: { value: Array.from({ length: MAX_DLIGHTS }, () => new THREE.Vector4()) },
    uFog: { value: new THREE.Vector4(0, 0, 0, 0) },
    uOverbright: { value: 2 },
    uFullbright: { value: 0 },
    uEmissive: { value: 0 },
    uLightClamp: { value: 2 },
    uFlat: { value: new THREE.Vector4() },
    uSkyEmissive: { value: 0 },
    uWarpLight: { value: 1 },
    uAlpha: { value: 1 },
  };
  private modelNoDl = { uNumDl: { value: 0 } };
  // alias pools
  private aliasOpaque: AliasInst[] = [];
  private aliasTrans: AliasInst[] = [];
  private nOpaque = 0;
  private nTrans = 0;
  private vmInst: AliasInst;
  // particles
  private partGeo = new THREE.InstancedBufferGeometry();
  private partPos = new Float32Array(MAX_PARTICLES * 4);
  private partCol = new Float32Array(MAX_PARTICLES * 4);
  private partAttrs: THREE.InstancedBufferAttribute[];
  private partMat: THREE.RawShaderMaterial;
  private partMesh: THREE.Mesh;
  private glow: SpriteBatch;
  private spriteMat: THREE.RawShaderMaterial;
  // per entity state (indexed by edict num)
  private esSerial = new Int32Array(MAX_EDICTS).fill(-1);
  private esModel: string[] = new Array(MAX_EDICTS).fill('');
  private esFrame = new Int32Array(MAX_EDICTS);
  private esOldFrame = new Int32Array(MAX_EDICTS);
  private esFrameTime = new Float64Array(MAX_EDICTS);
  private esOrigin = new Float32Array(MAX_EDICTS * 3);
  private esSeen = new Int32Array(MAX_EDICTS);
  private entIndex = new Int32Array(MAX_EDICTS);
  private frameNo = 0;
  private vmModel = '';
  private vmFrame = 0;
  private vmOldFrame = 0;
  private vmFrameTime = 0;
  // scratch
  private m4 = new THREE.Matrix4();
  private light = new Float32Array(3);
  private fwd = new Float32Array(3);
  private right = new Float32Array(3);
  private up = new Float32Array(3);
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private planes = new Float32Array(5 * 4);
  private blend = new Float32Array(4);
  private dlScore = new Float32Array(MAX_DLIGHT_SLOTS);
  private dlPicked = new Int32Array(MAX_DLIGHTS);
  private zeroVec: Vec3 = [0, 0, 0];

  constructor(canvas: HTMLCanvasElement, vfs: Vfs, settings: Partial<RenderSettings> = {}) {
    this.canvas = canvas;
    this.vfs = vfs;
    this.settings = { ...MODERN_SETTINGS, ...settings };
    this.gl = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.gl.autoClear = false;
    this.gl.info.autoReset = false;
    this.gl.setClearColor(0x000000, 1);
    this.pal = Palette.fromVfs(vfs);
    for (const s of [this.scene, this.vmScene]) { s.matrixWorldAutoUpdate = false; s.matrixAutoUpdate = false; }
    this.camera.matrixAutoUpdate = false;
    this.vmCamera.matrixAutoUpdate = false;
    this.vmInst = this.newAliasInst(false, this.vmScene);
    // particles
    this.partGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    this.partGeo.setIndex([0, 1, 2, 0, 2, 3]);
    this.partAttrs = [this.partPos, this.partCol].map((a) => new THREE.InstancedBufferAttribute(a, 4).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute);
    this.partGeo.setAttribute('iPos', this.partAttrs[0]);
    this.partGeo.setAttribute('iColor', this.partAttrs[1]);
    this.partGeo.instanceCount = 0;
    this.partMat = new THREE.RawShaderMaterial({
      vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS, glslVersion: THREE.GLSL3, transparent: true, depthWrite: false,
      uniforms: {
        uRight: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3() }, uFwd: { value: new THREE.Vector3() },
        uCam: this.su.uCam, uSize: { value: 1 }, uRound: { value: 1 },
      },
    });
    this.partMat.blending = THREE.CustomBlending;
    this.partMat.blendSrc = THREE.SrcAlphaFactor; this.partMat.blendDst = THREE.OneMinusSrcAlphaFactor;
    this.partMat.blendSrcAlpha = THREE.ZeroFactor; this.partMat.blendDstAlpha = THREE.OneFactor;
    this.partMesh = new THREE.Mesh(this.partGeo, this.partMat);
    this.partMesh.frustumCulled = false;
    this.partMesh.matrixAutoUpdate = false;
    this.partMesh.renderOrder = 10;
    this.scene.add(this.partMesh);
    // flashblend glows
    const glowMat = new THREE.RawShaderMaterial({
      vertexShader: SPRITE_VS, fragmentShader: GLOW_FS, glslVersion: THREE.GLSL3, transparent: true, depthWrite: false,
      uniforms: { uRight: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3() } },
    });
    glowMat.blending = THREE.CustomBlending;
    glowMat.blendSrc = THREE.OneFactor; glowMat.blendDst = THREE.OneFactor;
    glowMat.blendSrcAlpha = THREE.ZeroFactor; glowMat.blendDstAlpha = THREE.OneFactor;
    this.glow = new SpriteBatch(MAX_GLOWS, glowMat);
    this.glow.mesh.renderOrder = 20;
    this.scene.add(this.glow.mesh);
    this.spriteMat = new THREE.RawShaderMaterial({
      vertexShader: SPRITE_VS, fragmentShader: SPRITE_FS, glslVersion: THREE.GLSL3,
      uniforms: { uRight: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3() }, uAtlas: { value: null }, uEmissive: { value: 0 } },
    });
    this.resize(canvas.clientWidth || canvas.width || 640, canvas.clientHeight || canvas.height || 480, 1);
  }

  // ------------------------------------------------------------------------------------ API

  /** Load a map from the VFS: "lqdm1" or "maps/lqdm1.bsp" (+ "maps/lqdm1.lit" if present). */
  async loadMap(name: string): Promise<void> {
    const path = name.includes('/') ? name : `maps/${name}.bsp`;
    const data = this.vfs.get(path);
    if (!data) throw new Error(`${path} not found`);
    const lit = this.vfs.get(path.replace(/\.bsp$/i, '.lit'));
    this.unloadMap();
    const bsp = loadBsp(data, lit);
    const set = new BrushSet(bsp, this.pal, this.su);
    const geom = set.geom;
    // the world: shared vertex buffers, dynamic index buffer rebuilt by cull()
    const g = new THREE.BufferGeometry();
    for (const a of ['position', 'normal', 'st', 'lm', 'styles']) g.setAttribute(a, set.geometry.getAttribute(a));
    const index = new THREE.BufferAttribute(geom.worldIndices, 1);
    index.setUsage(THREE.DynamicDrawUsage);
    g.setIndex(index);
    const mesh = new THREE.Mesh(g, set.materials);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);
    const groups = geom.batches.map((b) => ({ start: 0, count: 0, materialIndex: b.id }));
    const subMeshes: (THREE.Mesh | null)[] = [null];
    for (let i = 1; i < bsp.models.length; i++) {
      const sm = set.makeMesh(i);
      if (sm) this.scene.add(sm);
      subMeshes.push(sm);
    }
    // worldspawn fog ("density r g b")
    const fog = new THREE.Vector4(0, 0, 0, 0);
    const ents = parseEntities(bsp.entities);
    const ws = ents.find((e) => e.classname === 'worldspawn');
    if (ws?.fog) {
      const v = ws.fog.trim().split(/\s+/).map(Number);
      if (v.length >= 4 && v[0] > 0) fog.set(v[1], v[2], v[3], v[0] / 64);
      else if (v.length >= 2 && v[0] > 0) fog.set(v[1], v[1], v[1], v[0] / 64);
    }
    const wa = ws ? parseFloat(ws.wateralpha ?? ws._wateralpha ?? '') : NaN;
    this.map = {
      name: path, set, worldGeo: g, worldMesh: mesh, groups, subMeshes, subDrawn: new Uint8Array(bsp.models.length), fog,
      waterAlpha: wa > 0 && wa < 1 ? wa : -1,
    };
    this.particles.clear();
    this.dl.clear();
    this.tents.clear();
    this.esSerial.fill(-1);
    this.lastTime = -1;
    this.applyTextureSettings();
  }

  /** Parsed entities of the loaded map (spawn points for tests, worldspawn keys). */
  mapEntities(): Record<string, string>[] {
    return this.map ? parseEntities(this.map.set.bsp.entities) : [];
  }

  setSettings(s: Partial<RenderSettings>): void {
    const old = this.settings;
    this.settings = { ...this.settings, ...s };
    if (old.textureFilter !== this.settings.textureFilter || old.anisotropy !== this.settings.anisotropy) this.applyTextureSettings();
    if (old.resolutionScale !== this.settings.resolutionScale || old.maxPixelRatio !== this.settings.maxPixelRatio) this.resize(this.width, this.height, this.dpr);
  }

  getSettings(): RenderSettings { return { ...this.settings }; }

  /** CSS size and devicePixelRatio of the canvas. */
  resize(w: number, h: number, dpr: number): void {
    this.width = Math.max(1, w); this.height = Math.max(1, h); this.dpr = dpr;
    const pr = Math.min(dpr, this.settings.maxPixelRatio) * Math.min(1, Math.max(0.25, this.settings.resolutionScale));
    this.gl.setPixelRatio(pr);
    this.gl.setSize(this.width, this.height, false);
  }

  stats(): RenderStats { return this.lastStats; }

  dispose(): void {
    this.unloadMap();
    for (const e of this.models.values()) {
      if (e.kind === 'alias') e.model.dispose();
      if (e.kind === 'bspmodel') { for (const m of e.meshes) this.scene.remove(m); e.set.dispose(); }
      if (e.kind === 'sprite') { e.batch.geo.dispose(); (e.batch.mesh.material as THREE.RawShaderMaterial).uniforms.uAtlas.value?.dispose(); }
    }
    this.models.clear();
    this.spriteList.length = 0;
    this.bspList.length = 0;
    this.post.dispose();
    this.aliasShared.dispose();
    this.gl.dispose();
  }

  // ------------------------------------------------------------------------------------ draw

  draw(f: RenderFrame): void {
    const t0 = performance.now();
    const gl = this.gl;
    gl.info.reset();
    const S = this.settings;
    const map = this.map;
    this.frameNo++;
    const time = f.time;
    let dt = this.lastTime < 0 ? 0 : time - this.lastTime;
    if (dt < 0 || dt > 1) { if (dt < -0.5) { this.particles.clear(); this.dl.clear(); this.tents.clear(); } dt = 0; }
    if (dt > 0.1) dt = 0.1;
    this.lastTime = time;
    this.su.uTime.value = time;

    // lightstyles (R_AnimateLight): 10 Hz steps, 'a' = 0, 'm' = 264/256
    const ls = f.lightstyles;
    const sv = this.styleValues;
    const t10 = time * 10;
    const step = Math.floor(t10), frac = t10 - step;
    for (let i = 0; i < 64; i++) {
      const s = ls ? ls[i] : '';
      if (!s) { sv[i] = 1; continue; }
      const n = s.length;
      const a = (s.charCodeAt(step % n) - 97) * 22 / 256;
      if (S.smoothLightstyles && n > 1) {
        const b = (s.charCodeAt((step + 1) % n) - 97) * 22 / 256;
        sv[i] = a + (b - a) * frac;
      } else sv[i] = a;
    }
    this.su.uStyles.value.set(sv);

    // camera
    const cam = f.camera;
    this.angleVectors(cam.angles[0], cam.angles[1], cam.angles[2]);
    const ox = cam.origin[0], oy = cam.origin[1], oz = cam.origin[2];
    this.setCamera(this.camera, ox, oy, oz, cam.fov, 4, 32768);
    this.su.uCam.value.set(ox, oy, oz);
    this.dl.update(time, dt);
    this.particles.update(time, dt);

    // world culling + materials
    let contents = cam.contents ?? -1;
    if (map) {
      const g = map.set.geom;
      this.frustumPlanes();
      const leaf = g.leafAt(ox, oy, oz);
      if (cam.contents === undefined) contents = g.bsp.leafContents[leaf] ?? -1;
      g.cull(ox, oy, oz, this.planes, 5, false);
      const groups = map.worldGeo.groups as { start: number; count: number; materialIndex: number }[];
      groups.length = 0;
      for (let b = 0; b < g.batches.length; b++) {
        const c = g.batchCount[b];
        if (!c) continue;
        const gr = map.groups[b];
        gr.start = g.batchStart[b]; gr.count = c;
        groups.push(gr);
      }
      const idx = map.worldGeo.index!;
      idx.clearUpdateRanges();
      idx.addUpdateRange(0, g.stats.indices);
      idx.needsUpdate = true;
      map.set.update(time, this.waterAlpha(), S.bloom);
    }

    // events → effects
    for (let i = 0; i < f.eventCount; i++) this.event(f, i, time);

    // entities
    const ents = f.entities;
    this.nOpaque = 0; this.nTrans = 0;
    for (let i = 0; i < this.spriteList.length; i++) this.spriteList[i].batch.count = 0;
    for (let i = 0; i < this.bspList.length; i++) { const e = this.bspList[i]; e.used = 0; e.set.update(time, S.waterAlpha, S.bloom); }
    if (map) map.subDrawn.fill(0);
    const stamp = this.frameNo;
    for (let i = 0; i < f.entityCount; i++) {
      const e = ents[i];
      if (e.num >= 0 && e.num < MAX_EDICTS) { this.entIndex[e.num] = i; this.esSeen[e.num] = stamp; }
    }
    let drawnEnts = 0;
    for (let i = 0; i < f.entityCount; i++) if (this.entity(f, i, time)) drawnEnts++;
    this.updateBeamsAndExplosions(f, time);

    // dlights → uniforms (+ flashblend glows)
    this.uploadDlights(ox, oy, oz);

    // global uniforms from settings
    const modern = S.toneMapping === 'aces' || S.bloom;
    this.su.uOverbright.value = 2 * S.lightmapScale;
    this.su.uLightClamp.value = modern ? 8 : 2;
    this.su.uEmissive.value = S.bloom ? 1 : 0;
    this.su.uSkyEmissive.value = S.bloom ? 0.15 : 0;
    this.su.uFlat.value.x = S.drawflat ? 1 : 0;
    this.su.uWarpLight.value = 1;
    this.su.uAlpha.value = this.waterAlpha();
    if (map) this.su.uFog.value.copy(map.fog); else this.su.uFog.value.set(0, 0, 0, 0);

    // particles
    this.fillParticles(S.particles === 'modern');
    // sprites commit
    for (let i = 0; i < this.spriteList.length; i++) { const e = this.spriteList[i]; this.setSpriteAxes(e.batch, e.spr.type); e.batch.commit(); }
    this.glow.commit();
    for (let k = 0; k < this.bspList.length; k++) { const e = this.bspList[k]; for (let i = e.used; i < e.meshes.length; i++) e.meshes[i].visible = false; }
    for (let i = this.nOpaque; i < this.aliasOpaque.length; i++) this.aliasOpaque[i].mesh.visible = false;
    for (let i = this.nTrans; i < this.aliasTrans.length; i++) this.aliasTrans[i].mesh.visible = false;
    if (map) for (let m = 1; m < map.subMeshes.length; m++) { const sm = map.subMeshes[m]; if (sm) sm.visible = map.subDrawn[m] === 1; }

    // view blend: liquid cshift (QW cshift_water/slime/lava) then the shell's blend
    const bl = this.blend;
    bl[0] = bl[1] = bl[2] = bl[3] = 0;
    if (contents === CONTENTS_WATER) this.addBlend(130, 80, 50, 128);
    else if (contents === CONTENTS_SLIME) this.addBlend(0, 25, 5, 150);
    else if (contents === CONTENTS_LAVA) this.addBlend(255, 80, 0, 150);
    if (cam.blend[3] > 0) this.addBlend(cam.blend[0] * 255, cam.blend[1] * 255, cam.blend[2] * 255, cam.blend[3] * 255);
    this.addGlowBlend(ox, oy, oz);

    // gun
    const vmDrawn = this.setupViewModel(f, time);

    // ---- render
    const tPrep = performance.now();
    const usePost = S.bloom || S.toneMapping !== 'none' || S.fxaa || S.ssao || S.msaa > 0 || S.gamma !== 1 || S.waterWarp && contents <= CONTENTS_WATER && contents >= CONTENTS_LAVA;
    const size = gl.getDrawingBufferSize(this.tmpSize);
    if (usePost) {
      this.post.setSize(size.x, size.y, S.msaa, S.ssao);
      gl.setRenderTarget(this.post.scene);
    } else gl.setRenderTarget(null);
    gl.setClearColor(0x000000, 0);
    gl.clear(true, true, false);
    gl.render(this.scene, this.camera);
    if (vmDrawn) {
      gl.clearDepth();
      gl.render(this.vmScene, this.vmCamera);
    }
    if (usePost) {
      const warp = S.waterWarp && contents <= CONTENTS_WATER && contents >= CONTENTS_LAVA ? 1 : 0;
      const po = this.postOpts;
      po.bloom = S.bloom; po.bloomStrength = S.bloomStrength; po.aces = S.toneMapping === 'aces'; po.exposure = S.exposure;
      po.gamma = S.gamma; po.ssao = S.ssao; po.fxaa = S.fxaa; po.msaa = S.msaa;
      this.post.finish(gl, po, bl, warp, time, this.camera);
    } else {
      this.post.drawBlend(gl, bl);
      // the scene shaders write a bloom weight into alpha; make the canvas opaque again
      const ctx = gl.getContext();
      ctx.colorMask(false, false, false, true);
      ctx.clearColor(0, 0, 0, 1);
      ctx.clear(ctx.COLOR_BUFFER_BIT);
      ctx.colorMask(true, true, true, true);
      ctx.clearColor(0, 0, 0, 0);
    }

    const st = this.lastStats;
    st.drawCalls = gl.info.render.calls;
    st.tris = gl.info.render.triangles;
    st.ms = performance.now() - t0;
    st.prepMs = tPrep - t0;
    st.faces = map ? map.set.geom.stats.faces : 0;
    st.leafs = map ? map.set.geom.stats.leafs : 0;
    st.entities = drawnEnts;
    st.particles = this.particles.count;
    st.dlights = this.su.uNumDl.value;
  }
  private tmpSize = new THREE.Vector2();
  private postOpts: PostOptions = { bloom: false, bloomStrength: 0, aces: false, exposure: 1, gamma: 1, ssao: false, fxaa: false, msaa: 0 };

  /**
   * r_wateralpha: only on maps whose worldspawn says they were vis'd for translucent water
   * (otherwise the void under the surface would show); the map's own value wins.
   */
  private waterAlpha(): number {
    const S = this.settings;
    if (S.waterAlpha >= 1 || !this.map || this.map.waterAlpha < 0) return 1;
    return this.map.waterAlpha;
  }

  // ------------------------------------------------------------------------------------ internals

  private unloadMap(): void {
    const m = this.map;
    if (!m) return;
    this.scene.remove(m.worldMesh);
    m.worldGeo.dispose();
    for (const sm of m.subMeshes) if (sm) this.scene.remove(sm);
    m.set.dispose();
    // brush model entries refer to this map
    for (const [k, e] of this.models) if (e.kind === 'brush') this.models.delete(k);
    this.map = null;
  }

  private applyTextureSettings(): void {
    const S = this.settings;
    this.map?.set.setFilter(S.textureFilter, S.anisotropy);
    for (const e of this.models.values()) {
      if (e.kind === 'alias') e.model.setFilter(S.textureFilter, S.anisotropy);
      if (e.kind === 'bspmodel') e.set.setFilter(S.textureFilter, S.anisotropy);
      if (e.kind === 'sprite') { const t = (e.batch.mesh.material as THREE.RawShaderMaterial).uniforms.uAtlas.value; if (t) applyFilter(t, S.textureFilter, 1); }
    }
  }

  private getModel(name: string): ModelEntry {
    let e = this.models.get(name);
    if (e) return e;
    e = { kind: 'none' };
    try {
      if (name.startsWith('*')) {
        const idx = parseInt(name.slice(1), 10);
        if (this.map && idx > 0 && idx < this.map.subMeshes.length && this.map.subMeshes[idx]) e = { kind: 'brush', index: idx };
        else e = { kind: 'none' };
        if (!this.map) return e; // don't cache before a map
      } else if (name.endsWith('.mdl')) {
        const d = this.vfs.get(name);
        if (d) {
          const model = new AliasModel(loadMdl(d), this.pal);
          model.setFilter(this.settings.textureFilter, this.settings.anisotropy);
          e = { kind: 'alias', model };
        }
      } else if (name.endsWith('.bsp')) {
        if (this.map && name === this.map.name) return e; // the world itself (modelindex 1): never an entity
        const d = this.vfs.get(name);
        if (d) {
          const set = new BrushSet(loadBsp(d, this.vfs.get(name.replace(/\.bsp$/i, '.lit'))), this.pal, this.su);
          set.setFilter(this.settings.textureFilter, this.settings.anisotropy);
          e = { kind: 'bspmodel', set, meshes: [], used: 0 };
        }
      } else if (name.endsWith('.spr')) {
        const d = this.vfs.get(name);
        if (d) e = this.makeSprite(loadSpr(d));
      }
    } catch (err) {
      console.warn(`render: cannot load ${name}:`, err);
      e = { kind: 'none' };
    }
    this.models.set(name, e);
    if (e.kind === 'sprite') this.spriteList.push(e);
    if (e.kind === 'bspmodel') this.bspList.push(e);
    return e;
  }

  private makeSprite(spr: Spr): ModelEntry {
    // pack every image of every frame side by side
    let total = 0, n = 0, maxH = 1;
    for (const fr of spr.frames) for (const im of fr.images) { total += im.width + 2; n++; if (im.height > maxH) maxH = im.height; }
    const W = Math.max(1, total), H = maxH + 2;
    const data = new Uint8Array(W * H * 4);
    const batch = new SpriteBatch(MAX_SPRITES, this.spriteMat.clone());
    batch.frameUV = new Float32Array(n * 4);
    batch.frameRect = new Float32Array(n * 4);
    batch.frameBase = new Int32Array(spr.frames.length);
    let x = 0, k = 0;
    spr.frames.forEach((fr, fi) => {
      batch.frameBase[fi] = k;
      for (const im of fr.images) {
        const rgba = this.pal.toRGBA(im.pixels, im.width, im.height, 255, 'cutout');
        for (let yy = 0; yy < im.height; yy++) {
          data.set(rgba.subarray(yy * im.width * 4, (yy + 1) * im.width * 4), ((yy + 1) * W + x + 1) * 4);
        }
        batch.frameUV.set([(x + 1) / W, 1 / H, im.width / W, im.height / H], k * 4);
        batch.frameRect.set([im.left, im.up, im.width, im.height], k * 4);
        x += im.width + 2; k++;
      }
    });
    const tex = rgbaTexture(data, W, H, false, false);
    applyFilter(tex, this.settings.textureFilter, 1);
    const mat = batch.mesh.material as THREE.RawShaderMaterial;
    mat.uniforms.uAtlas = { value: tex };
    mat.uniforms.uEmissive = { value: 0 };
    mat.uniforms.uRight = { value: new THREE.Vector3() };
    mat.uniforms.uUp = { value: new THREE.Vector3() };
    batch.mesh.renderOrder = 5;
    this.scene.add(batch.mesh);
    return { kind: 'sprite', spr, batch };
  }

  private setSpriteAxes(b: SpriteBatch, type: number): void {
    const u = (b.mesh.material as THREE.RawShaderMaterial).uniforms;
    const r = this.right, up = this.up;
    if (type === 0 || type === 1) {
      // VP_PARALLEL_UPRIGHT: up is world z, right is the view right flattened
      const l = Math.hypot(r[0], r[1]) || 1;
      (u.uRight.value as THREE.Vector3).set(r[0] / l, r[1] / l, 0);
      (u.uUp.value as THREE.Vector3).set(0, 0, 1);
    } else {
      (u.uRight.value as THREE.Vector3).set(r[0], r[1], r[2]);
      (u.uUp.value as THREE.Vector3).set(up[0], up[1], up[2]);
    }
    u.uEmissive.value = this.settings.bloom ? 0.9 : 0;
  }

  private pushSprite(entry: { spr: Spr; batch: SpriteBatch }, frame: number, x: number, y: number, z: number, time: number): void {
    const spr = entry.spr, b = entry.batch;
    if (frame < 0 || frame >= spr.frames.length) frame = 0;
    const fr = spr.frames[frame];
    let im = 0;
    if (fr.intervals && fr.images.length > 1) {
      const full = fr.intervals[fr.images.length - 1];
      const t = time - Math.floor(time / full) * full;
      while (im < fr.images.length - 1 && fr.intervals[im] <= t) im++;
    }
    const k = (b.frameBase[frame] + im) * 4;
    const R = b.frameRect, U = b.frameUV;
    b.push(x, y, z, R[k], R[k + 1], R[k + 2], R[k + 3], U[k], U[k + 1], U[k + 2], U[k + 3], 1, 1, 1, 1);
  }

  private newAliasInst(translucent: boolean, scene: THREE.Scene): AliasInst {
    const mat = aliasMaterial(this.aliasShared, {
      uNumDl: this.su.uNumDl, uDlPos: this.su.uDlPos, uDlCol: this.su.uDlCol, uFog: this.su.uFog, uCam: this.su.uCam,
    }, translucent);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = translucent ? 8 : 0;
    scene.add(mesh);
    return { mesh, mat };
  }

  private allocAlias(translucent: boolean): AliasInst {
    if (translucent) {
      if (this.nTrans >= this.aliasTrans.length) this.aliasTrans.push(this.newAliasInst(true, this.scene));
      return this.aliasTrans[this.nTrans++];
    }
    if (this.nOpaque >= this.aliasOpaque.length) this.aliasOpaque.push(this.newAliasInst(false, this.scene));
    return this.aliasOpaque[this.nOpaque++];
  }

  /** Processes one entity: state tracking, trails and dlights, and queues its drawing. Returns true if drawn. */
  private entity(f: RenderFrame, i: number, time: number): boolean {
    const e = f.entities[i];
    const num = e.num;
    if (num < 0 || num >= MAX_EDICTS) return false;
    const entry = e.model ? this.getModel(e.model) : null;
    const ox = e.origin[0], oy = e.origin[1], oz = e.origin[2];
    // per-entity state
    const fresh = this.esSerial[num] !== e.serial || this.esModel[num] !== e.model;
    if (fresh) {
      this.esSerial[num] = e.serial; this.esModel[num] = e.model;
      this.esFrame[num] = e.frame; this.esOldFrame[num] = e.frame; this.esFrameTime[num] = time - 1;
      this.esOrigin[num * 3] = ox; this.esOrigin[num * 3 + 1] = oy; this.esOrigin[num * 3 + 2] = oz;
    } else if (e.frame !== this.esFrame[num]) {
      this.esOldFrame[num] = this.esFrame[num]; this.esFrame[num] = e.frame; this.esFrameTime[num] = time;
    }
    // effects dlights (CL_LinkPacketEntities / CL_LinkPlayers)
    const fx = e.effects;
    if ((fx & (EF_BLUE | EF_RED)) === (EF_BLUE | EF_RED)) this.dl.set(num, ox, oy, oz, 200 + (Math.random() * 32 | 0), 0.1, 3);
    else if (fx & EF_BLUE) this.dl.set(num, ox, oy, oz, 200 + (Math.random() * 32 | 0), 0.1, 1);
    else if (fx & EF_RED) this.dl.set(num, ox, oy, oz, 200 + (Math.random() * 32 | 0), 0.1, 2);
    else if (fx & EF_BRIGHTLIGHT) this.dl.set(num, ox, oy, oz + 16, 400 + (Math.random() * 32 | 0), 0.1, 0);
    else if (fx & EF_DIMLIGHT) this.dl.set(num, ox, oy, oz, 200 + (Math.random() * 32 | 0), 0.1, 0);

    if (!entry || entry.kind === 'none') return false;
    // trails (model flags)
    if (entry.kind === 'alias') {
      const flags = entry.model.mdl.flags;
      if (flags & ~MF_ROTATE) {
        const px = this.esOrigin[num * 3], py = this.esOrigin[num * 3 + 1], pz = this.esOrigin[num * 3 + 2];
        const far = Math.abs(px - ox) > 128 || Math.abs(py - oy) > 128 || Math.abs(pz - oz) > 128;
        if (!fresh && !far) {
          if (flags & MF_ROCKET) { this.particles.trail(px, py, pz, ox, oy, oz, 0); this.dl.set(num, ox, oy, oz, 200, 0.1, 0); }
          else if (flags & MF_GRENADE) this.particles.trail(px, py, pz, ox, oy, oz, 1);
          else if (flags & MF_GIB) this.particles.trail(px, py, pz, ox, oy, oz, 2);
          else if (flags & MF_ZOMGIB) this.particles.trail(px, py, pz, ox, oy, oz, 4);
          else if (flags & MF_TRACER) this.particles.trail(px, py, pz, ox, oy, oz, 3);
          else if (flags & MF_TRACER2) this.particles.trail(px, py, pz, ox, oy, oz, 5);
          else if (flags & MF_TRACER3) this.particles.trail(px, py, pz, ox, oy, oz, 6);
        }
      }
    }
    this.esOrigin[num * 3] = ox; this.esOrigin[num * 3 + 1] = oy; this.esOrigin[num * 3 + 2] = oz;

    if (e.isLocalPlayer && !f.thirdPerson) return false;
    const map = this.map;
    if (entry.kind === 'brush') {
      if (!map) return false;
      const bm = map.set.geom.bsp.models[entry.index];
      // sphere test of the (possibly rotated) model bounds
      const cx = (bm.mins[0] + bm.maxs[0]) * 0.5 + ox, cy = (bm.mins[1] + bm.maxs[1]) * 0.5 + oy, cz = (bm.mins[2] + bm.maxs[2]) * 0.5 + oz;
      const r = Math.hypot(bm.maxs[0] - bm.mins[0], bm.maxs[1] - bm.mins[1], bm.maxs[2] - bm.mins[2]) * 0.5;
      if (!this.sphereVisible(cx, cy, cz, r)) return false;
      const mesh = map.subMeshes[entry.index]!;
      entityMatrix(mesh.matrixWorld, ox, oy, oz, e.angles[0], e.angles[1], e.angles[2]);
      map.subDrawn[entry.index] = 1;
      map.set.animateModel(entry.index, e.frame, time);
      return true;
    }
    if (entry.kind === 'bspmodel') {
      const bm = entry.set.bsp.models[0];
      const r = Math.hypot(bm.maxs[0] - bm.mins[0], bm.maxs[1] - bm.mins[1], bm.maxs[2] - bm.mins[2]) * 0.5;
      if (!this.sphereVisible(ox + (bm.mins[0] + bm.maxs[0]) * 0.5, oy + (bm.mins[1] + bm.maxs[1]) * 0.5, oz + (bm.mins[2] + bm.maxs[2]) * 0.5, r)) return false;
      if (map && !map.set.geom.leafVisible(map.set.geom.leafAt(ox, oy, oz + 8))) return false;
      if (entry.used >= entry.meshes.length) {
        const mesh = entry.set.makeMesh(0);
        if (!mesh) return false;
        this.scene.add(mesh);
        entry.meshes.push(mesh);
      }
      const mesh = entry.meshes[entry.used++];
      mesh.visible = true;
      entityMatrix(mesh.matrixWorld, ox, oy, oz, e.angles[0], e.angles[1], e.angles[2]);
      return true;
    }
    if (entry.kind === 'sprite') {
      if (!this.sphereVisible(ox, oy, oz, entry.spr.radius + 8)) return false;
      if (map && !map.set.geom.leafVisible(map.set.geom.leafAt(ox, oy, oz))) return false;
      this.pushSprite(entry, e.frame, ox, oy, oz, time);
      return true;
    }
    // alias
    const model = entry.model;
    if (!this.sphereVisible(ox, oy, oz, model.mdl.radius + 4)) return false;
    if (map && !map.set.geom.leafVisible(map.set.geom.leafAt(ox, oy, oz))) return false;
    let lerp = 1, oldFrame = e.frame;
    if (e.prevFrame >= 0) { oldFrame = e.prevFrame; lerp = e.frameLerp; }
    else if (this.settings.lerpFrames) {
      oldFrame = this.esOldFrame[num];
      lerp = (time - this.esFrameTime[num]) * 10;
      if (lerp > 1) lerp = 1; else if (lerp < 0) lerp = 0;
    }
    if (!this.settings.lerpFrames) lerp = 1;
    let yaw = e.angles[1];
    if (model.mdl.flags & MF_ROTATE) yaw = (time * 100) % 360;
    const inst = this.allocAlias(e.alpha < 1);
    this.setupAlias(inst, model, e.model, e.frame, oldFrame, lerp, e.skin, e.colors ? ((e.colors.top & 15) << 4) | (e.colors.bottom & 15) : -1,
      fx, ox, oy, oz, e.angles[0], yaw, e.angles[2], e.alpha, time, false, 1);
    return true;
  }

  private setupAlias(inst: AliasInst, model: AliasModel, name: string, frame: number, oldFrame: number, lerp: number, skin: number, colors: number,
    fx: number, ox: number, oy: number, oz: number, pitch: number, yaw: number, roll: number, alpha: number, time: number, isGun: boolean, fullbright: number): void {
    const S = this.settings;
    const mdl = model.mdl;
    const mat = inst.mat;
    if (inst.mesh.geometry !== model.geometry) { inst.mesh.geometry = model.geometry; bindAliasModel(mat, model); }
    else if (mat.uniforms.uPoses.value !== model.poses) bindAliasModel(mat, model);
    inst.mesh.visible = true;
    entityMatrix(inst.mesh.matrixWorld, ox, oy, oz, pitch, yaw, roll);
    const pa = mdlPose(mdl, oldFrame, time), pb = mdlPose(mdl, frame, time);
    (mat.uniforms.uPose.value as THREE.Vector4).set(pa, pb, pa === pb ? 0 : lerp, model.rows);
    mat.uniforms.uSkin.value = model.skin(skin, mdlSkinImage(mdl, skin, time), colors);
    mat.uniforms.uAlpha.value = alpha;
    // lighting (R_LightPoint + dlights), QuakeSpasm-style clamps
    const L = this.light;
    const map = this.map;
    if (map) map.set.geom.lightPoint(ox, oy, oz, this.styleValues, L); else { L[0] = L[1] = L[2] = 200; }
    const isPlayer = name === 'progs/player.mdl';
    const modern = S.modelLighting === 'modern';
    let full = fullbright === 2 || name === 'progs/flame.mdl' || name === 'progs/flame2.mdl' || name.startsWith('progs/bolt') ? 1 : 0;
    if (isPlayer && S.fullbrightSkins) full = 1;
    if (!modern) {
      // dlights add to the light level (gl_rmain.c R_DrawAliasModel)
      for (let i = 0; i < MAX_DLIGHT_SLOTS; i++) {
        if (!this.dl.alive(i)) continue;
        const add = this.dl.radius[i] - Math.hypot(ox - this.dl.origin[i * 3], oy - this.dl.origin[i * 3 + 1], oz - this.dl.origin[i * 3 + 2]);
        if (add > 0) { L[0] += add; L[1] += add; L[2] += add; }
      }
    }
    const minl = isGun ? 24 : isPlayer ? 8 : 0;
    for (let c = 0; c < 3; c++) if (L[c] < minl) L[c] = minl;
    const lu = mat.uniforms.uLight.value as THREE.Vector4;
    const lc = mat.uniforms.uLightCol.value as THREE.Vector3;
    if (!modern) {
      const sum = L[0] + L[1] + L[2];
      const k = sum > 288 ? 288 / sum : 1; // "clamp lighting so it doesn't overbright as much"
      lc.set(L[0] * k * 2 / 200, L[1] * k * 2 / 200, L[2] * k * 2 / 200);
      lu.set(0, 1, ((yaw * (16 / 360)) | 0) & 15, full);
      mat.uniforms.uModern.value = 0;
      mat.uniforms.uRim.value = 0;
      (mat.uniforms.uShell.value as THREE.Vector3).set(0, 0, 0);
    } else {
      const mx = Math.max(L[0], L[1], L[2], 1);
      const lvl = Math.min(mx, 192) / 128;
      lc.set(L[0] / mx * lvl, L[1] / mx * lvl, L[2] / mx * lvl);
      lu.set(1.0, 0.7, 0, full);
      mat.uniforms.uModern.value = 1;
      mat.uniforms.uRim.value = isGun ? 0.15 : 0.35;
      // key light from above, towards the camera side
      const ld = mat.uniforms.uLightDir.value as THREE.Vector3;
      ld.set(-this.fwd[0] * 0.5 + this.right[0] * 0.3, -this.fwd[1] * 0.5 + this.right[1] * 0.3, 0.8).normalize();
      const sh = mat.uniforms.uShell.value as THREE.Vector3;
      if ((fx & (EF_BLUE | EF_RED)) === (EF_BLUE | EF_RED)) sh.set(0.35, 0.05, 0.35);
      else if (fx & EF_BLUE) sh.set(0.05, 0.12, 0.45);
      else if (fx & EF_RED) sh.set(0.45, 0.05, 0.03);
      else sh.set(0, 0, 0);
      if (isGun) sh.multiplyScalar(0.3);
    }
    mat.uniforms.uEmissive.value = S.bloom ? (full ? 0.6 : 1) : 0;
  }

  private setupViewModel(f: RenderFrame, time: number): boolean {
    const vm = f.viewmodel;
    const S = this.settings;
    this.vmInst.mesh.visible = false;
    if (!vm || !vm.model || !S.drawViewModel) return false;
    const entry = this.getModel(vm.model);
    if (entry.kind !== 'alias') return false;
    if (vm.model !== this.vmModel) { this.vmModel = vm.model; this.vmFrame = vm.frame; this.vmOldFrame = vm.frame; this.vmFrameTime = time - 1; }
    else if (vm.frame !== this.vmFrame) { this.vmOldFrame = this.vmFrame; this.vmFrame = vm.frame; this.vmFrameTime = time; }
    let oldFrame = vm.frame, lerp = 1;
    if (vm.prevFrame >= 0) { oldFrame = vm.prevFrame; lerp = vm.frameLerp; }
    else if (S.lerpFrames) { oldFrame = this.vmOldFrame; lerp = Math.min(1, Math.max(0, (time - this.vmFrameTime) * 10)); }
    const cam = f.camera;
    const bob = vm.bob;
    // V_CalcRefdef: gun at the eye, pushed forward by bob*0.4, angles = view with pitch inverted
    const x = cam.origin[0] + this.fwd[0] * bob * 0.4;
    const y = cam.origin[1] + this.fwd[1] * bob * 0.4;
    const z = cam.origin[2] + this.fwd[2] * bob * 0.4 + 1;
    const fov = S.viewModelFov > 0 ? S.viewModelFov : cam.fov;
    this.setCamera(this.vmCamera, cam.origin[0], cam.origin[1], cam.origin[2], fov, 1, 4096);
    this.setupAlias(this.vmInst, entry.model, vm.model, vm.frame, oldFrame, lerp, 0, -1, vm.effects, x, y, z,
      -cam.angles[0], cam.angles[1], cam.angles[2], 1, time, true, 0);
    return true;
  }

  private event(f: RenderFrame, i: number, time: number): void {
    const ev = f.events[i];
    const P = this.particles;
    P.setTime(time);
    if (ev.kind === EV_MUZZLEFLASH) {
      // CL_MuzzleFlash: 18 units ahead of the shooter, radius 200..231, minlight 32, 0.1 s
      const num = ev.a;
      let x = 0, y = 0, z = 0, yaw = 0, pitch = 0;
      if (num === f.viewEntity && num > 0) {
        x = f.camera.origin[0]; y = f.camera.origin[1]; z = f.camera.origin[2] - 22;
        yaw = f.camera.angles[1]; pitch = f.camera.angles[0];
      } else if (num > 0 && num < MAX_EDICTS && this.esSeen[num] === this.frameNo) {
        const e = f.entities[this.entIndex[num]];
        x = e.origin[0]; y = e.origin[1]; z = e.origin[2]; yaw = e.angles[1]; pitch = -e.angles[0] * 3;
      } else return;
      const cp = Math.cos(pitch * DEG), sp = Math.sin(pitch * DEG), cy = Math.cos(yaw * DEG), sy = Math.sin(yaw * DEG);
      this.dl.set(num, x + cp * cy * 18, y + cp * sy * 18, z - sp * 18, 200 + (Math.random() * 32 | 0), 0.1, 0, 0, 32);
      return;
    }
    if (ev.kind !== EV_TEMP_ENTITY) return;
    const x = ev.x, y = ev.y, z = ev.z;
    switch (ev.a) {
      case TE_WIZSPIKE: P.runEffect(x, y, z, 0, 0, 0, 20, 30); break;
      case TE_KNIGHTSPIKE: P.runEffect(x, y, z, 0, 0, 0, 226, 20); break;
      case TE_SPIKE: P.runEffect(x, y, z, 0, 0, 0, 0, 10); break;
      case TE_SUPERSPIKE: P.runEffect(x, y, z, 0, 0, 0, 0, 20); break;
      case TE_EXPLOSION:
        P.explosion(x, y, z);
        this.dl.set(0, x, y, z, 350, 0.5, 0, 300);
        this.tents.explosion('progs/s_explod.spr', time, x, y, z);
        break;
      case TE_TAREXPLOSION: P.blobExplosion(x, y, z); break;
      case TE_LIGHTNING1: this.tents.beam(ev.c, 'progs/bolt.mdl', time, x, y, z, ev.ex, ev.ey, ev.ez); break;
      case TE_LIGHTNING2: this.tents.beam(ev.c, 'progs/bolt2.mdl', time, x, y, z, ev.ex, ev.ey, ev.ez); break;
      case TE_LIGHTNING3: this.tents.beam(ev.c, 'progs/bolt3.mdl', time, x, y, z, ev.ex, ev.ey, ev.ez); break;
      case TE_LAVASPLASH: P.lavaSplash(x, y, z); break;
      case TE_TELEPORT: P.teleportSplash(x, y, z); break;
      case TE_GUNSHOT: P.runEffect(x, y, z, 0, 0, 0, 0, 20 * Math.max(1, ev.b)); break;
      case TE_BLOOD: P.runEffect(x, y, z, 0, 0, 0, 73, 20 * Math.max(1, ev.b)); break;
      case TE_LIGHTNINGBLOOD: P.runEffect(x, y, z, 0, 0, 0, 225, 50); break;
    }
  }

  /** CL_UpdateBeams + CL_UpdateExplosions */
  private updateBeamsAndExplosions(f: RenderFrame, time: number): void {
    const T = this.tents;
    for (let b = 0; b < MAX_BEAMS; b++) {
      if (!T.beamModel[b] || T.beamEnd[b] < time) continue;
      const entry = this.getModel(T.beamModel[b]);
      if (entry.kind !== 'alias') continue;
      let sx = T.beamStart[b * 3], sy = T.beamStart[b * 3 + 1], sz = T.beamStart[b * 3 + 2];
      if (T.beamEnt[b] === f.viewEntity && f.viewEntity > 0) {
        // from the local player: follow the eye (QW used cl.simorg)
        sx = f.camera.origin[0]; sy = f.camera.origin[1]; sz = f.camera.origin[2] - 16;
      }
      let dx = T.beamStop[b * 3] - sx, dy = T.beamStop[b * 3 + 1] - sy, dz = T.beamStop[b * 3 + 2] - sz;
      let yaw: number, pitch: number;
      if (dx === 0 && dy === 0) { yaw = 0; pitch = dz > 0 ? 90 : 270; }
      else {
        yaw = Math.trunc(Math.atan2(dy, dx) * 180 / Math.PI);
        if (yaw < 0) yaw += 360;
        pitch = Math.trunc(Math.atan2(dz, Math.hypot(dx, dy)) * 180 / Math.PI);
        if (pitch < 0) pitch += 360;
      }
      let d = Math.hypot(dx, dy, dz);
      if (d > 0) { dx /= d; dy /= d; dz /= d; }
      let x = sx, y = sy, z = sz;
      let guard = 0;
      while (d > 0 && guard++ < 256) {
        const inst = this.allocAlias(false);
        this.setupAlias(inst, entry.model, T.beamModel[b], 0, 0, 0, 0, -1, 0, x, y, z, pitch, yaw, Math.random() * 360, 1, time, false, 2);
        x += dx * 30; y += dy * 30; z += dz * 30;
        d -= 30;
      }
      // modern: the bolt lights its impact point (QW had no beam light)
      if (this.settings.bloom) this.dl.set(-1 - b, T.beamStop[b * 3], T.beamStop[b * 3 + 1], T.beamStop[b * 3 + 2], 160 + Math.random() * 40, 0.1, 4);
    }
    for (let k = 0; k < MAX_EXPLOSIONS; k++) {
      const m = T.exModel[k];
      if (!m) continue;
      const entry = this.getModel(m);
      if (entry.kind !== 'sprite') { T.exModel[k] = ''; continue; }
      const fr = Math.floor(10 * (time - T.exStart[k]));
      if (fr >= entry.spr.frames.length || fr < 0) { T.exModel[k] = ''; continue; }
      this.pushSprite(entry, fr, T.exOrigin[k * 3], T.exOrigin[k * 3 + 1], T.exOrigin[k * 3 + 2], time);
    }
  }

  private fillParticles(modern: boolean): void {
    const P = this.particles;
    const pal = this.pal.rgb;
    const n = P.count;
    const pos = this.partPos, col = this.partCol;
    const hot = modern ? 1.6 : 1;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      pos[o] = P.org[i * 3]; pos[o + 1] = P.org[i * 3 + 1]; pos[o + 2] = P.org[i * 3 + 2];
      const c = P.color[i];
      const t = P.type[i];
      let k = 1 / 255, a = 1, s = 1;
      if (t === PT_FIRE) { a = (6 - P.ramp[i]) / 6; k *= hot; if (modern) s = 1.6; }
      else if (t === PT_EXPLODE || t === PT_EXPLODE2 || t === PT_BLOB || t === PT_BLOB2) k *= hot;
      pos[o + 3] = s;
      col[o] = pal[c * 3] * k; col[o + 1] = pal[c * 3 + 1] * k; col[o + 2] = pal[c * 3 + 2] * k; col[o + 3] = a;
    }
    for (let i = 0; i < this.partAttrs.length; i++) { const a = this.partAttrs[i]; a.clearUpdateRanges(); a.addUpdateRange(0, n * 4); a.needsUpdate = true; }
    this.partGeo.instanceCount = n;
    this.partMesh.visible = n > 0;
    const u = this.partMat.uniforms;
    (u.uRight.value as THREE.Vector3).set(this.right[0], this.right[1], this.right[2]);
    (u.uUp.value as THREE.Vector3).set(this.up[0], this.up[1], this.up[2]);
    (u.uFwd.value as THREE.Vector3).set(this.fwd[0], this.fwd[1], this.fwd[2]);
    u.uSize.value = modern ? 1.0 : 0.75;
    u.uRound.value = modern ? 1 : 0;
  }

  /** Pick the 16 most important live dlights for the shaders; fill flashblend glows. */
  private uploadDlights(cx: number, cy: number, cz: number): void {
    const S = this.settings;
    const D = this.dl;
    this.glow.count = 0;
    const gu = (this.glow.mesh.material as THREE.RawShaderMaterial).uniforms;
    (gu.uRight.value as THREE.Vector3).set(this.right[0], this.right[1], this.right[2]);
    (gu.uUp.value as THREE.Vector3).set(this.up[0], this.up[1], this.up[2]);
    const modern = S.modelLighting === 'modern' || S.bloom;
    let n = 0;
    if (S.dynamicLights || S.flashblend) {
      for (let i = 0; i < MAX_DLIGHT_SLOTS; i++) {
        if (!D.alive(i)) { this.dlScore[i] = -1; continue; }
        const d = Math.hypot(D.origin[i * 3] - cx, D.origin[i * 3 + 1] - cy, D.origin[i * 3 + 2] - cz);
        this.dlScore[i] = D.radius[i] / (d + 64);
        if (S.flashblend) {
          // R_RenderDlight: a ball of radius*0.35 pushed towards the viewer
          const rad = D.radius[i] * 0.35;
          if (d < rad) continue; // inside: V_AddLightBlend handled in addGlowBlend
          const c = DL_COLORS[D.type[i]];
          const k = modern ? 3 : 1.6;
          const vx = (D.origin[i * 3] - cx) / d, vy = (D.origin[i * 3 + 1] - cy) / d, vz = (D.origin[i * 3 + 2] - cz) / d;
          this.glow.push(D.origin[i * 3] - vx * rad, D.origin[i * 3 + 1] - vy * rad, D.origin[i * 3 + 2] - vz * rad,
            -rad, rad, rad * 2, rad * 2, 0, 0, 1, 1, c[0] * k, c[1] * k, c[2] * k, 1);
        }
      }
      if (S.dynamicLights && !S.flashblend) {
        while (n < MAX_DLIGHTS) {
          let best = -1, bs = 0;
          for (let i = 0; i < MAX_DLIGHT_SLOTS; i++) if (this.dlScore[i] > bs) { bs = this.dlScore[i]; best = i; }
          if (best < 0) break;
          this.dlScore[best] = -1;
          this.dlPicked[n] = best;
          const c = modern ? DL_LIGHT_COLORS[D.type[best]] : WHITE;
          this.su.uDlPos.value[n].set(D.origin[best * 3], D.origin[best * 3 + 1], D.origin[best * 3 + 2], D.radius[best]);
          this.su.uDlCol.value[n].set(c[0], c[1], c[2], D.minlight[best]);
          n++;
        }
      }
    }
    this.su.uNumDl.value = n;
  }

  /** V_AddLightBlend for gl_flashblend when the eye is inside a glow */
  private addGlowBlend(cx: number, cy: number, cz: number): void {
    if (!this.settings.flashblend) return;
    const D = this.dl;
    for (let i = 0; i < MAX_DLIGHT_SLOTS; i++) {
      if (!D.alive(i)) continue;
      const rad = D.radius[i] * 0.35;
      const d = Math.hypot(D.origin[i * 3] - cx, D.origin[i * 3 + 1] - cy, D.origin[i * 3 + 2] - cz);
      if (d < rad) {
        const a2 = D.radius[i] * 0.0003;
        const bl = this.blend;
        const a = bl[3] + a2 * (1 - bl[3]);
        const f = a > 0 ? a2 / a : 0;
        bl[0] = bl[0] * (1 - f) + 1 * f; bl[1] = bl[1] * (1 - f) + 0.5 * f; bl[2] = bl[2] * (1 - f);
        bl[3] = a;
      }
    }
  }

  /** V_CalcBlend step: blend one cshift (0..255 rgb, percent) onto this.blend */
  private addBlend(r: number, g: number, b: number, percent: number): void {
    const bl = this.blend;
    const a2 = percent / 255;
    if (a2 <= 0) return;
    const a = bl[3] + a2 * (1 - bl[3]);
    const f = a2 / a;
    bl[0] = bl[0] * (1 - f) + (r / 255) * f;
    bl[1] = bl[1] * (1 - f) + (g / 255) * f;
    bl[2] = bl[2] * (1 - f) + (b / 255) * f;
    bl[3] = Math.min(1, a);
  }

  /** AngleVectors into fwd/right/up */
  private angleVectors(pitch: number, yaw: number, roll: number): void {
    const cp = Math.cos(pitch * DEG), sp = Math.sin(pitch * DEG);
    const cy = Math.cos(yaw * DEG), sy = Math.sin(yaw * DEG);
    const cr = Math.cos(roll * DEG), sr = Math.sin(roll * DEG);
    const F = this.fwd, R = this.right, U = this.up;
    F[0] = cp * cy; F[1] = cp * sy; F[2] = -sp;
    R[0] = -sr * sp * cy + cr * sy; R[1] = -sr * sp * sy - cr * cy; R[2] = -sr * cp;
    U[0] = cr * sp * cy + sr * sy; U[1] = cr * sp * sy - sr * cy; U[2] = cr * cp;
  }

  /** Camera world matrix from the current fwd/right/up (Quake axes, z up). */
  private setCamera(c: THREE.PerspectiveCamera, x: number, y: number, z: number, fovX: number, near: number, far: number): void {
    const F = this.fwd, R = this.right, U = this.up;
    c.matrix.set(
      R[0], U[0], -F[0], x,
      R[1], U[1], -F[1], y,
      R[2], U[2], -F[2], z,
      0, 0, 0, 1,
    );
    c.matrixWorld.copy(c.matrix);
    c.matrixWorldInverse.copy(c.matrix).invert();
    const size = this.gl.getDrawingBufferSize(this.tmpSize);
    const aspect = size.x / Math.max(1, size.y);
    const fx = Math.min(170, Math.max(10, fovX));
    const fovY = 2 * Math.atan(Math.tan((fx * DEG) / 2) / aspect) / DEG;
    if (c.fov !== fovY || c.aspect !== aspect || c.near !== near || c.far !== far) {
      c.fov = fovY; c.aspect = aspect; c.near = near; c.far = far;
      c.updateProjectionMatrix();
    }
  }

  private frustumPlanes(): void {
    this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    for (let k = 0; k < 5; k++) {
      const p = this.frustum.planes[PLANE_ORDER[k]];
      this.planes[k * 4] = p.normal.x; this.planes[k * 4 + 1] = p.normal.y; this.planes[k * 4 + 2] = p.normal.z;
      this.planes[k * 4 + 3] = -p.constant;
    }
  }

  private sphereVisible(x: number, y: number, z: number, r: number): boolean {
    const P = this.planes;
    for (let k = 0; k < 5; k++) if (P[k * 4] * x + P[k * 4 + 1] * y + P[k * 4 + 2] * z - P[k * 4 + 3] < -r) return false;
    return true;
  }
}
