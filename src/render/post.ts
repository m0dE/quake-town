// Post-processing: HDR scene target (optional MSAA, depth texture for SSAO), dual-filter
// bloom fed by emissive alpha + HDR overflow, optional SSAO, composite (ACES, view blend,
// gamma, underwater warp), optional FXAA.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import * as THREE from 'three';
import {
  BLEND_FS, BLOOM_DOWN_FS, BLOOM_EXTRACT_FS, BLOOM_UP_FS, COMPOSITE_FS, FULLSCREEN_VS, FXAA_FS, SSAO_FS,
} from './shaders';

const LEVELS = 5;

function rt(w: number, h: number, type: THREE.TextureDataType, depth: boolean, samples = 0): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    type, format: THREE.RGBAFormat, depthBuffer: depth, stencilBuffer: false, samples,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
  });
}

function pass(fs: string, uniforms: Record<string, THREE.IUniform>, blend = false): THREE.RawShaderMaterial {
  const m = new THREE.RawShaderMaterial({
    vertexShader: FULLSCREEN_VS, fragmentShader: fs, uniforms, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
  });
  if (blend) { m.transparent = true; m.blending = THREE.NormalBlending; }
  return m;
}

export interface PostOptions {
  bloom: boolean;
  bloomStrength: number;
  aces: boolean;
  exposure: number;
  gamma: number;
  ssao: boolean;
  fxaa: boolean;
  msaa: number;
}

export class PostFX {
  scene: THREE.WebGLRenderTarget;
  private ldr: THREE.WebGLRenderTarget;
  private ao: THREE.WebGLRenderTarget;
  private down: THREE.WebGLRenderTarget[] = [];
  private up: THREE.WebGLRenderTarget[] = [];
  private quad: THREE.Mesh;
  private qscene = new THREE.Scene();
  private qcam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private extract: THREE.RawShaderMaterial;
  private downM: THREE.RawShaderMaterial;
  private upM: THREE.RawShaderMaterial;
  private ssaoM: THREE.RawShaderMaterial;
  private fxaaM: THREE.RawShaderMaterial;
  readonly composite: THREE.RawShaderMaterial;
  readonly blendM: THREE.RawShaderMaterial;
  private w = 0;
  private h = 0;
  private samples = -1;
  private depthTex = false;

  constructor() {
    this.scene = rt(1, 1, THREE.HalfFloatType, true);
    this.ldr = rt(1, 1, THREE.UnsignedByteType, false);
    this.ao = rt(1, 1, THREE.UnsignedByteType, false);
    for (let i = 0; i < LEVELS; i++) {
      this.down.push(rt(1, 1, THREE.HalfFloatType, false));
      this.up.push(rt(1, 1, THREE.HalfFloatType, false));
    }
    this.extract = pass(BLOOM_EXTRACT_FS, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.0 } });
    this.downM = pass(BLOOM_DOWN_FS, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.upM = pass(BLOOM_UP_FS, { uSrc: { value: null }, uBase: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.ssaoM = pass(SSAO_FS, {
      uDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, uProj: { value: new THREE.Vector4() }, uRadius: { value: 24 },
    });
    this.fxaaM = pass(FXAA_FS, { uSrc: { value: this.ldr.texture }, uTexel: { value: new THREE.Vector2() } });
    this.composite = pass(COMPOSITE_FS, {
      uScene: { value: this.scene.texture }, uBloom: { value: null }, uAO: { value: null }, uBloomStrength: { value: 0 },
      uAOOn: { value: 0 }, uAces: { value: 0 }, uExposure: { value: 1 }, uGamma: { value: 1 }, uBlend: { value: new THREE.Vector4() },
      uWarp: { value: 0 }, uTime: { value: 0 },
    });
    this.blendM = pass(BLEND_FS, { uBlend: { value: new THREE.Vector4() } }, true);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(g, this.composite);
    this.quad.frustumCulled = false;
    this.qscene.add(this.quad);
    this.qscene.matrixWorldAutoUpdate = false;
  }

  /** (Re)size targets; `samples` MSAA, `depthTexture` for SSAO. */
  setSize(w: number, h: number, samples: number, depthTexture: boolean): void {
    if (w === this.w && h === this.h && samples === this.samples && depthTexture === this.depthTex) return;
    if (samples !== this.samples || depthTexture !== this.depthTex) {
      this.scene.dispose();
      this.scene = rt(w, h, THREE.HalfFloatType, true, samples);
      if (depthTexture) {
        this.scene.depthTexture = new THREE.DepthTexture(w, h);
        this.scene.depthTexture.type = THREE.UnsignedIntType;
      }
      this.composite.uniforms.uScene.value = this.scene.texture;
      this.samples = samples; this.depthTex = depthTexture;
    }
    this.w = w; this.h = h;
    this.scene.setSize(w, h);
    this.ldr.setSize(w, h);
    this.ao.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    let lw = w, lh = h;
    for (let i = 0; i < LEVELS; i++) {
      lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
      this.down[i].setSize(lw, lh);
      this.up[i].setSize(lw, lh);
    }
  }

  private run(r: THREE.WebGLRenderer, m: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = m;
    r.setRenderTarget(target);
    r.render(this.qscene, this.qcam);
  }

  /** The classic path: blend quad straight onto the current target. */
  drawBlend(r: THREE.WebGLRenderer, rgba: ArrayLike<number>): void {
    if (rgba[3] <= 0) return;
    (this.blendM.uniforms.uBlend.value as THREE.Vector4).set(rgba[0], rgba[1], rgba[2], rgba[3]);
    this.quad.material = this.blendM;
    r.render(this.qscene, this.qcam);
  }

  finish(r: THREE.WebGLRenderer, o: PostOptions, blend: ArrayLike<number>, warp: number, time: number, cam: THREE.PerspectiveCamera): void {
    const bloom = o.bloom && o.bloomStrength > 0;
    const u = this.composite.uniforms;
    if (bloom) {
      this.extract.uniforms.uSrc.value = this.scene.texture;
      (this.extract.uniforms.uTexel.value as THREE.Vector2).set(1 / this.w, 1 / this.h);
      this.run(r, this.extract, this.down[0]);
      for (let i = 1; i < LEVELS; i++) {
        const src = this.down[i - 1];
        this.downM.uniforms.uSrc.value = src.texture;
        (this.downM.uniforms.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
        this.run(r, this.downM, this.down[i]);
      }
      let src = this.down[LEVELS - 1];
      for (let i = LEVELS - 2; i >= 0; i--) {
        this.upM.uniforms.uSrc.value = src.texture;
        this.upM.uniforms.uBase.value = this.down[i].texture;
        (this.upM.uniforms.uTexel.value as THREE.Vector2).set(0.5 / src.width, 0.5 / src.height);
        this.run(r, this.upM, this.up[i]);
        src = this.up[i];
      }
      u.uBloom.value = this.up[0].texture;
    } else {
      u.uBloom.value = this.scene.texture;
    }
    if (o.ssao && this.scene.depthTexture) {
      const su = this.ssaoM.uniforms;
      su.uDepth.value = this.scene.depthTexture;
      (su.uTexel.value as THREE.Vector2).set(2 / this.w, 2 / this.h);
      const ty = Math.tan((cam.fov * Math.PI) / 360);
      (su.uProj.value as THREE.Vector4).set(cam.near, cam.far, ty * cam.aspect, ty);
      this.run(r, this.ssaoM, this.ao);
      u.uAO.value = this.ao.texture;
      u.uAOOn.value = 1;
    } else {
      u.uAO.value = this.scene.texture;
      u.uAOOn.value = 0;
    }
    u.uBloomStrength.value = bloom ? o.bloomStrength : 0;
    u.uAces.value = o.aces ? 1 : 0;
    u.uExposure.value = o.exposure;
    u.uGamma.value = o.gamma;
    u.uWarp.value = warp;
    u.uTime.value = time;
    (u.uBlend.value as THREE.Vector4).set(blend[0], blend[1], blend[2], blend[3]);
    if (o.fxaa) {
      this.run(r, this.composite, this.ldr);
      (this.fxaaM.uniforms.uTexel.value as THREE.Vector2).set(1 / this.w, 1 / this.h);
      this.run(r, this.fxaaM, null);
    } else {
      this.run(r, this.composite, null);
    }
  }

  dispose(): void {
    this.scene.dispose(); this.ldr.dispose(); this.ao.dispose();
    for (const t of [...this.down, ...this.up]) t.dispose();
    for (const m of [this.extract, this.downM, this.upM, this.composite, this.ssaoM, this.fxaaM, this.blendM]) m.dispose();
    this.quad.geometry.dispose();
  }
}
