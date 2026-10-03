// Menu 3D preview: a lit, slowly turning player model in its colours and skin, with a rim
// light and a soft contact shadow. One small WebGL context per preview canvas, cached.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import * as THREE from 'three';
import type { Vfs } from '../content/types';
import { AliasModel, AliasShared, aliasMaterial, bindAliasModel, entityMatrix } from './alias';
import { MAX_DLIGHTS } from './shaders';
import { loadMdl, mdlPose, mdlSkinImage } from './mdl';
import { Palette } from './palette';
import type { PlayerLook } from './types';

const SHADOW_VS = /* glsl */ `
precision highp float;
uniform mat4 modelMatrix, viewMatrix, projectionMatrix;
in vec3 position;
out vec2 vP;
void main() { vP = position.xy; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }
`;
const SHADOW_FS = /* glsl */ `
precision highp float;
uniform float uStrength;
in vec2 vP;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 p = vP * vec2(1.0, 1.25);
  float r = length(p);
  float a = pow(clamp(1.0 - r, 0.0, 1.0), 1.6) * uStrength;
  outColor = vec4(0.0, 0.0, 0.0, a);
}
`;

interface PreviewState {
  gl: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  shared: AliasShared;
  mesh: THREE.Mesh;
  mat: THREE.RawShaderMaterial;
  shadow: THREE.Mesh;
  pal: Palette;
  vfs: Vfs;
  models: Map<string, AliasModel | null>;
  w: number;
  h: number;
  dpr: number;
}

const states = new WeakMap<HTMLCanvasElement, PreviewState>();

function init(canvas: HTMLCanvasElement, vfs: Vfs): PreviewState {
  const gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'low-power' });
  gl.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.matrixWorldAutoUpdate = false;
  const camera = new THREE.PerspectiveCamera(32, 1, 4, 1000);
  camera.matrixAutoUpdate = false;
  const shared = new AliasShared();
  const su = {
    uNumDl: { value: 0 },
    uDlPos: { value: Array.from({ length: MAX_DLIGHTS }, () => new THREE.Vector4()) },
    uDlCol: { value: Array.from({ length: MAX_DLIGHTS }, () => new THREE.Vector4()) },
    uFog: { value: new THREE.Vector4() },
    uCam: { value: new THREE.Vector3() },
  };
  const mat = aliasMaterial(shared, su, false);
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  scene.add(mesh);
  const sg = new THREE.PlaneGeometry(2, 2);
  const smat = new THREE.RawShaderMaterial({
    vertexShader: SHADOW_VS, fragmentShader: SHADOW_FS, glslVersion: THREE.GLSL3, transparent: true, depthWrite: false,
    uniforms: { uStrength: { value: 0.6 } },
  });
  const shadow = new THREE.Mesh(sg, smat);
  shadow.frustumCulled = false;
  shadow.matrixAutoUpdate = false;
  shadow.renderOrder = -1;
  scene.add(shadow);
  // camera: front, slightly above the chest, looking at the model's centre (Quake axes, z up)
  const eye = new THREE.Vector3(118, 0, 18), target = new THREE.Vector3(0, 0, 2);
  const f = target.clone().sub(eye).normalize();
  const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 0, 1)).normalize();
  const u = new THREE.Vector3().crossVectors(r, f);
  camera.matrix.set(r.x, u.x, -f.x, eye.x, r.y, u.y, -f.y, eye.y, r.z, u.z, -f.z, eye.z, 0, 0, 0, 1);
  camera.matrixWorld.copy(camera.matrix);
  camera.matrixWorldInverse.copy(camera.matrix).invert();
  su.uCam.value.copy(eye);
  return {
    gl, scene, camera, shared, mesh, mat, shadow, pal: Palette.fromVfs(vfs), vfs, models: new Map(), w: 0, h: 0, dpr: 0,
  };
}

/**
 * Draw the menu preview of `look` at time `t` (seconds; call every animation frame).
 * Cheap: one model draw + one shadow quad.
 */
export function renderCharacterPreview(canvas: HTMLCanvasElement, vfs: Vfs, look: PlayerLook, t: number): void {
  let s = states.get(canvas);
  if (!s || s.vfs !== vfs) { if (s) disposeCharacterPreview(canvas); s = init(canvas, vfs); states.set(canvas, s); }
  const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  if (w !== s.w || h !== s.h || dpr !== s.dpr) {
    s.w = w; s.h = h; s.dpr = dpr;
    s.gl.setPixelRatio(dpr);
    s.gl.setSize(w, h, false);
    s.camera.aspect = w / Math.max(1, h);
    s.camera.updateProjectionMatrix();
  }
  const name = look.model || 'progs/player.mdl';
  let model = s.models.get(name);
  if (model === undefined) {
    const d = vfs.get(name);
    model = d ? new AliasModel(loadMdl(d), s.pal) : null;
    model?.setFilter('linear', 4);
    s.models.set(name, model);
  }
  s.gl.clear();
  if (!model) return;
  const mat = s.mat;
  if (s.mesh.geometry !== model.geometry) { s.mesh.geometry = model.geometry; bindAliasModel(mat, model); }
  // stand1..stand5 at 10 Hz (player.mdl frames 12..16), interpolated; other models: frame 0
  const isPlayer = model.mdl.frames.length > 16;
  const ft = t * 10;
  const fa = isPlayer ? 12 + (Math.floor(ft) % 5) : 0, fb = isPlayer ? 12 + ((Math.floor(ft) + 1) % 5) : 0;
  const pa = mdlPose(model.mdl, fa, t), pb = mdlPose(model.mdl, fb, t);
  (mat.uniforms.uPose.value as THREE.Vector4).set(pa, pb, ft - Math.floor(ft), model.rows);
  const yaw = 200 + t * 24;
  // feet on the ground: put the lowest point of the model at z = -24
  entityMatrix(s.mesh.matrixWorld, 0, 0, 0, 0, yaw, 0);
  mat.uniforms.uSkin.value = model.skin(look.skin, mdlSkinImage(model.mdl, look.skin, t), ((look.top & 15) << 4) | (look.bottom & 15));
  (mat.uniforms.uLight.value as THREE.Vector4).set(0.62, 0.9, 0, 0);
  (mat.uniforms.uLightCol.value as THREE.Vector3).set(1.12, 1.06, 0.98);
  (mat.uniforms.uLightDir.value as THREE.Vector3).set(0.55, 0.45, 0.7).normalize();
  mat.uniforms.uModern.value = 1;
  mat.uniforms.uRim.value = 0.75;
  (mat.uniforms.uShell.value as THREE.Vector3).set(0, 0, 0);
  mat.uniforms.uEmissive.value = 0;
  mat.uniforms.uAlpha.value = 1;
  const b = model.mdl.poseBounds;
  const zmin = Math.min(b[pa * 6 + 2], b[pb * 6 + 2]);
  const m = s.shadow.matrixWorld;
  m.makeScale(30, 30, 1);
  m.setPosition(0, 0, zmin + 0.5);
  s.gl.render(s.scene, s.camera);
}

export function disposeCharacterPreview(canvas: HTMLCanvasElement): void {
  const s = states.get(canvas);
  if (!s) return;
  for (const m of s.models.values()) m?.dispose();
  s.shared.dispose();
  s.mat.dispose();
  s.shadow.geometry.dispose();
  (s.shadow.material as THREE.Material).dispose();
  s.gl.dispose();
  states.delete(canvas);
}
