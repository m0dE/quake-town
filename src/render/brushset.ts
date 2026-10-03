// A loaded BSP's drawable resources: textures, lightmap pages, vertex buffers, one material
// per batch (texture × lightmap page), and static meshes for its models. Used for the map
// (the world model gets a dynamic PVS-culled index buffer in the renderer) and for item
// models that are BSP files themselves ("maps/b_bh25.bsp").
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import * as THREE from 'three';
import type { Bsp } from './bsp';
import type { Palette } from './palette';
import { SKY_FS, WARP_FS, WORLD_FS, WORLD_VS } from './shaders';
import { applyFilter, buildWorldTextures, rgbaTexture, type WorldTextures } from './textures';
import type { TextureFilter } from './types';
import { WorldGeometry } from './world';

/** Uniform objects shared by every world material (updated once per frame). */
export interface WorldUniforms {
  uStyles: THREE.IUniform<Float32Array>;
  uTime: THREE.IUniform<number>;
  uCam: THREE.IUniform<THREE.Vector3>;
  uNumDl: THREE.IUniform<number>;
  uDlPos: THREE.IUniform<THREE.Vector4[]>;
  uDlCol: THREE.IUniform<THREE.Vector4[]>;
  uFog: THREE.IUniform<THREE.Vector4>;
  uOverbright: THREE.IUniform<number>;
  uFullbright: THREE.IUniform<number>;
  uEmissive: THREE.IUniform<number>;
  uLightClamp: THREE.IUniform<number>;
  uFlat: THREE.IUniform<THREE.Vector4>;
  uSkyEmissive: THREE.IUniform<number>;
  uWarpLight: THREE.IUniform<number>;
  uAlpha: THREE.IUniform<number>;
}

export class BrushSet {
  readonly bsp: Bsp;
  readonly geom: WorldGeometry;
  readonly wtex: WorldTextures;
  readonly lmTex: THREE.DataTexture[];
  readonly geometry: THREE.BufferGeometry;
  /** per batch: the material in use (warp swaps between opaque/translucent) */
  readonly materials: THREE.RawShaderMaterial[] = [];
  readonly warpOpaque: (THREE.RawShaderMaterial | null)[] = [];
  readonly warpTrans: (THREE.RawShaderMaterial | null)[] = [];
  /** per model: materials per group (own copies where the texture animates) */
  readonly modelMats: THREE.RawShaderMaterial[][] = [];
  readonly modelGeo: (THREE.BufferGeometry | null)[] = [];
  private fullbright: THREE.IUniform<number>;
  private extraMats: THREE.RawShaderMaterial[] = [];

  constructor(bsp: Bsp, pal: Palette, private su: WorldUniforms) {
    this.bsp = bsp;
    const geom = (this.geom = new WorldGeometry(bsp));
    this.wtex = buildWorldTextures(bsp, pal, geom.tex.kind);
    this.lmTex = geom.pages.map((p) => {
      const t = rgbaTexture(p.data, p.width, p.height, false, false);
      t.magFilter = t.minFilter = THREE.LinearFilter;
      return t;
    });
    // maps without light data draw fullbright; item models use their own flag
    this.fullbright = { value: geom.hasLight ? 0 : 1 };
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(geom.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(geom.normal, 3));
    g.setAttribute('st', new THREE.BufferAttribute(geom.st, 2));
    g.setAttribute('lm', new THREE.BufferAttribute(geom.lm, 3));
    g.setAttribute('styles', new THREE.BufferAttribute(geom.styles, 4));
    this.geometry = g;
    for (const b of geom.batches) {
      const m = this.batchMaterial(b.kind, b.tex, b.page, false);
      this.warpOpaque.push(b.kind === 'warp' ? m : null);
      this.warpTrans.push(b.kind === 'warp' ? this.batchMaterial('warp', b.tex, 0, true) : null);
      this.materials.push(m);
    }
    for (let i = 0; i < bsp.models.length; i++) { this.modelMats.push([]); this.modelGeo.push(null); }
  }

  /** A mesh drawing every face of model `m` (static index buffer, one group per batch). */
  makeMesh(m: number): THREE.Mesh | null {
    const sm = this.geom.submodels[m];
    if (!sm || sm.groups.length === 0) return null;
    let sg = this.modelGeo[m];
    if (!sg) {
      sg = new THREE.BufferGeometry();
      for (const a of ['position', 'normal', 'st', 'lm', 'styles']) sg.setAttribute(a, this.geometry.getAttribute(a));
      sg.setIndex(new THREE.BufferAttribute(sm.indices, 1));
      const mats: THREE.RawShaderMaterial[] = [];
      sm.groups.forEach((gr, k) => {
        const b = this.geom.batches[gr.batch];
        const anim = b.tex >= 0 && (this.geom.tex.anims[b.tex] || this.geom.tex.altAnims[b.tex]);
        let mat = this.materials[gr.batch];
        if (anim) { mat = this.batchMaterial(b.kind, b.tex, b.page, false); this.extraMats.push(mat); }
        mats.push(mat);
        sg!.addGroup(gr.start, gr.count, k);
      });
      this.modelMats[m] = mats;
      this.modelGeo[m] = sg;
    }
    const mesh = new THREE.Mesh(sg, this.modelMats[m]);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    return mesh;
  }

  private batchMaterial(kind: string, tex: number, page: number, translucent: boolean): THREE.RawShaderMaterial {
    const su = this.su, wtex = this.wtex;
    const texSize = new THREE.Vector2(tex >= 0 ? wtex.size[tex * 2] || 64 : 64, tex >= 0 ? wtex.size[tex * 2 + 1] || 64 : 64);
    const common = { uStyles: su.uStyles, uTexSize: { value: texSize }, uCam: su.uCam, uFog: su.uFog, uTime: su.uTime };
    if (kind === 'sky') {
      return new THREE.RawShaderMaterial({
        vertexShader: WORLD_VS, fragmentShader: SKY_FS, glslVersion: THREE.GLSL3,
        uniforms: {
          ...common, uSkyBack: { value: (tex >= 0 && wtex.skyBack[tex]) || wtex.missing },
          uSkyFront: { value: (tex >= 0 && wtex.skyFront[tex]) || wtex.missing }, uSkyEmissive: su.uSkyEmissive,
        },
      });
    }
    if (kind === 'warp') {
      const m = new THREE.RawShaderMaterial({
        vertexShader: WORLD_VS, fragmentShader: WARP_FS, glslVersion: THREE.GLSL3,
        defines: translucent ? { TRANSLUCENT: 1 } : {},
        transparent: translucent, depthWrite: !translucent,
        uniforms: {
          ...common, uTex: { value: (tex >= 0 && wtex.tex[tex]) || wtex.missing }, uAlpha: su.uAlpha,
          uEmissive: { value: 0 }, uWarpLight: su.uWarpLight,
        },
      });
      if (translucent) {
        m.blending = THREE.CustomBlending;
        m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
        m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
      }
      return m;
    }
    return new THREE.RawShaderMaterial({
      vertexShader: WORLD_VS, fragmentShader: WORLD_FS, glslVersion: THREE.GLSL3,
      defines: kind === 'cutout' ? { CUTOUT: 1 } : {},
      uniforms: {
        ...common, uTex: { value: (tex >= 0 && wtex.tex[tex]) || wtex.missing }, uLM: { value: this.lmTex[page] ?? this.lmTex[0] },
        uOverbright: su.uOverbright, uFullbright: this.fullbright, uEmissive: su.uEmissive, uLightClamp: su.uLightClamp,
        uFlat: su.uFlat, uNumDl: su.uNumDl, uDlPos: su.uDlPos, uDlCol: su.uDlCol,
      },
    });
  }

  /** Per frame: animated textures (a frame every 0.2 s), warp opaque/translucent, lava glow. */
  update(time: number, waterAlpha: number, bloom: boolean): void {
    const g = this.geom;
    const tick = Math.floor(time * 5);
    for (let b = 0; b < g.batches.length; b++) {
      const bt = g.batches[b];
      if (bt.kind === 'warp') {
        const name = bt.tex >= 0 ? g.bsp.textures[bt.tex]?.name ?? '' : '';
        // only water and slime turn translucent (lava and teleporters stay solid, as in QS)
        const clear = waterAlpha < 1 && !name.includes('lava') && !name.includes('tele');
        const want = clear ? this.warpTrans[b]! : this.warpOpaque[b]!;
        if (this.materials[b] !== want) this.materials[b] = want;
        want.uniforms.uEmissive.value = bloom ? (name.includes('lava') ? 0.7 : name.includes('tele') ? 0.4 : name.includes('slime') ? 0.25 : 0.03) : 0;
        continue;
      }
      if (bt.tex < 0) continue;
      const chain = g.tex.anims[bt.tex];
      if (!chain) continue;
      this.materials[b].uniforms.uTex.value = this.wtex.tex[chain[tick % chain.length]] ?? this.wtex.missing;
    }
  }

  /** Brush entity frame: alternate animation chain when frame != 0 (R_TextureAnimation). */
  animateModel(m: number, frame: number, time: number): void {
    const sm = this.geom.submodels[m];
    const mats = this.modelMats[m];
    if (!sm || !mats.length) return;
    const g = this.geom;
    const tick = Math.floor(time * 5);
    for (let k = 0; k < sm.groups.length; k++) {
      const bt = g.batches[sm.groups[k].batch];
      if (bt.tex < 0 || bt.kind === 'warp' || bt.kind === 'sky') continue;
      const chain = frame && g.tex.altAnims[bt.tex] ? g.tex.altAnims[bt.tex] : g.tex.anims[bt.tex];
      if (!chain) continue;
      mats[k].uniforms.uTex.value = this.wtex.tex[chain[tick % chain.length]] ?? this.wtex.missing;
    }
  }

  setFilter(filter: TextureFilter, aniso: number): void {
    for (const t of this.wtex.tex) if (t) applyFilter(t, filter, aniso);
    for (const t of this.wtex.skyBack) if (t) applyFilter(t, filter, 1);
    for (const t of this.wtex.skyFront) if (t) applyFilter(t, filter, 1);
  }

  dispose(): void {
    this.geometry.dispose();
    for (const g of this.modelGeo) g?.dispose();
    const mats = new Set<THREE.Material>([...this.materials, ...this.extraMats]);
    for (const x of this.warpOpaque) if (x) mats.add(x);
    for (const x of this.warpTrans) if (x) mats.add(x);
    for (const x of mats) x.dispose();
    for (const t of this.wtex.tex) t?.dispose();
    for (const t of this.wtex.skyBack) t?.dispose();
    for (const t of this.wtex.skyFront) t?.dispose();
    this.wtex.missing.dispose();
    for (const t of this.lmTex) t.dispose();
  }
}
