// Alias (MDL) models on the GPU: all poses in one RGBA8 texture fetched by vertex id,
// frame interpolation in the vertex shader, translated player skins cached per colour pair.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import * as THREE from 'three';
import { ANORMS, ANORM_DOTS } from './anorms';
import { type Mdl } from './mdl';
import { type Palette, playerTranslation } from './palette';
import { ALIAS_FS, ALIAS_VS } from './shaders';
import { applyFilter, rgbaTexture } from './textures';
import type { TextureFilter } from './types';

const MAX_W = 2048;

export class AliasShared {
  readonly normals: THREE.DataTexture;
  readonly dots: THREE.DataTexture;
  constructor() {
    const n = new Float32Array(162 * 4);
    for (let i = 0; i < 162; i++) { n[i * 4] = ANORMS[i * 3]; n[i * 4 + 1] = ANORMS[i * 3 + 1]; n[i * 4 + 2] = ANORMS[i * 3 + 2]; n[i * 4 + 3] = 1; }
    this.normals = new THREE.DataTexture(n, 162, 1, THREE.RGBAFormat, THREE.FloatType);
    this.normals.needsUpdate = true;
    const d = new Float32Array(256 * 16 * 4);
    for (let i = 0; i < 256 * 16; i++) d[i * 4] = ANORM_DOTS[i] ?? 1;
    this.dots = new THREE.DataTexture(d, 256, 16, THREE.RGBAFormat, THREE.FloatType);
    this.dots.needsUpdate = true;
  }
  dispose(): void { this.normals.dispose(); this.dots.dispose(); }
}

export class AliasModel {
  readonly mdl: Mdl;
  readonly geometry: THREE.BufferGeometry;
  readonly poses: THREE.DataTexture;
  readonly width: number;
  readonly rows: number;
  private skins = new Map<number, THREE.DataTexture>();
  private pal: Palette;
  private filter: TextureFilter = 'linear';
  private aniso = 1;
  private trans = new Uint8Array(256);

  constructor(mdl: Mdl, pal: Palette) {
    this.mdl = mdl;
    this.pal = pal;
    const g = new THREE.BufferGeometry();
    const vert = new Float32Array(mdl.numDrawVerts);
    for (let i = 0; i < mdl.numDrawVerts; i++) vert[i] = mdl.drawVertSrc[i];
    g.setAttribute('vert', new THREE.BufferAttribute(vert, 1));
    g.setAttribute('uv', new THREE.BufferAttribute(mdl.drawUV, 2));
    // three needs a 'position' attribute for bookkeeping (draw range); reuse vert
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mdl.numDrawVerts * 3), 3));
    g.setIndex(new THREE.BufferAttribute(mdl.indices, 1));
    this.geometry = g;
    this.width = Math.min(Math.max(1, mdl.numVerts), MAX_W);
    this.rows = Math.ceil(mdl.numVerts / this.width);
    const h = Math.max(1, mdl.numPoses * this.rows);
    const data = new Uint8Array(this.width * h * 4);
    for (let p = 0; p < mdl.numPoses; p++) {
      for (let v = 0; v < mdl.numVerts; v++) {
        const row = p * this.rows + Math.floor(v / this.width), col = v % this.width;
        const s = (p * mdl.numVerts + v) * 4, d = (row * this.width + col) * 4;
        data[d] = mdl.poses[s]; data[d + 1] = mdl.poses[s + 1]; data[d + 2] = mdl.poses[s + 2]; data[d + 3] = mdl.poses[s + 3];
      }
    }
    this.poses = new THREE.DataTexture(data, this.width, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.poses.minFilter = this.poses.magFilter = THREE.NearestFilter;
    this.poses.generateMipmaps = false;
    this.poses.needsUpdate = true;
  }

  setFilter(filter: TextureFilter, aniso: number): void {
    this.filter = filter; this.aniso = aniso;
    for (const t of this.skins.values()) applyFilter(t, filter, aniso);
  }

  /** skin texture: `colors` -1 = untranslated, else top*16+bottom */
  skin(skin: number, image: number, colors: number): THREE.DataTexture {
    const m = this.mdl;
    if (skin < 0 || skin >= m.skins.length) skin = 0;
    if (!m.skins.length) return this.blank();
    const key = (skin * 64 + image) * 512 + (colors < 0 ? 511 : colors);
    let t = this.skins.get(key);
    if (t) return t;
    const src = m.skins[skin].images[Math.min(image, m.skins[skin].images.length - 1)];
    const tr = colors >= 0 ? playerTranslation(colors >> 4, colors & 15, this.trans) : undefined;
    t = rgbaTexture(this.pal.toRGBA(src, m.skinWidth, m.skinHeight, -1, 'lit', tr), m.skinWidth, m.skinHeight, true, false);
    applyFilter(t, this.filter, this.aniso);
    this.skins.set(key, t);
    return t;
  }

  private blankTex: THREE.DataTexture | null = null;
  private blank(): THREE.DataTexture {
    return (this.blankTex ??= rgbaTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, false));
  }

  dispose(): void {
    this.geometry.dispose();
    this.poses.dispose();
    for (const t of this.skins.values()) t.dispose();
    this.blankTex?.dispose();
  }
}

/** Shared uniforms an alias material references (dlights, fog, camera). */
export interface AliasSharedUniforms {
  uNumDl: THREE.IUniform<number>;
  uDlPos: THREE.IUniform<THREE.Vector4[]>;
  uDlCol: THREE.IUniform<THREE.Vector4[]>;
  uFog: THREE.IUniform<THREE.Vector4>;
  uCam: THREE.IUniform<THREE.Vector3>;
  uOpaque: THREE.IUniform<number>;
  uOutScale: THREE.IUniform<number>;
}

export function aliasMaterial(shared: AliasShared, su: AliasSharedUniforms, translucent: boolean): THREE.RawShaderMaterial {
  const m = new THREE.RawShaderMaterial({
    vertexShader: ALIAS_VS,
    fragmentShader: ALIAS_FS,
    glslVersion: THREE.GLSL3,
    defines: translucent ? { TRANSLUCENT: 1 } : {},
    transparent: translucent,
    depthWrite: !translucent,
    uniforms: {
      uPoses: { value: null }, uNormals: { value: shared.normals }, uDots: { value: shared.dots },
      uPose: { value: new THREE.Vector4() }, uScale: { value: new THREE.Vector3() }, uOrigin: { value: new THREE.Vector3() },
      uWidth: { value: 1 }, uLight: { value: new THREE.Vector4() }, uLightCol: { value: new THREE.Vector3(1, 1, 1) },
      uLightDir: { value: new THREE.Vector3(0, 0, 1) }, uModern: { value: 0 },
      uSkin: { value: null }, uAlpha: { value: 1 }, uEmissive: { value: 0 }, uRim: { value: 0 }, uShell: { value: new THREE.Vector3() },
      ...su,
    },
  });
  if (translucent) {
    m.blending = THREE.CustomBlending;
    m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
  }
  return m;
}

/** Sets the pose/scale uniforms of `m` for `model`. */
export function bindAliasModel(m: THREE.RawShaderMaterial, model: AliasModel): void {
  const u = m.uniforms;
  u.uPoses.value = model.poses;
  u.uWidth.value = model.width;
  (u.uScale.value as THREE.Vector3).set(model.mdl.scale[0], model.mdl.scale[1], model.mdl.scale[2]);
  (u.uOrigin.value as THREE.Vector3).set(model.mdl.origin[0], model.mdl.origin[1], model.mdl.origin[2]);
}

/**
 * Entity transform like GLQuake's R_RotateForEntity: T(origin) · Rz(yaw) · Ry(-pitch) · Rx(roll).
 * Writes into `out` (column-major three.js Matrix4). No allocation.
 */
export function entityMatrix(out: THREE.Matrix4, ox: number, oy: number, oz: number, pitch: number, yaw: number, roll: number): void {
  const d = Math.PI / 180;
  const cy = Math.cos(yaw * d), sy = Math.sin(yaw * d);
  const cp = Math.cos(-pitch * d), sp = Math.sin(-pitch * d);
  const cr = Math.cos(roll * d), sr = Math.sin(roll * d);
  // Rz(yaw) * Ry(p) * Rx(r)
  const e = out.elements;
  e[0] = cy * cp; e[1] = sy * cp; e[2] = -sp; e[3] = 0;
  e[4] = cy * sp * sr - sy * cr; e[5] = sy * sp * sr + cy * cr; e[6] = cp * sr; e[7] = 0;
  e[8] = cy * sp * cr + sy * sr; e[9] = sy * sp * cr - cy * sr; e[10] = cp * cr; e[11] = 0;
  e[12] = ox; e[13] = oy; e[14] = oz; e[15] = 1;
}
