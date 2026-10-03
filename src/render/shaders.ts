// GLSL (WebGL2 / GLSL ES 3.00) for the Quake Town renderer.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
// The sky and warp math follows GLQuake's gl_warp.c (EmitSkyPolys, EmitWaterPolys),
// Copyright (C) 1996-1997 Id Software, Inc., GPL-2.0-or-later.
//
// Colour convention: everything is in Quake's gamma space (textures × lightmap, like the
// original); the post pass converts to linear only for ACES. Every scene shader writes an
// "emissive" weight into alpha that the bloom pass reads.

export const MAX_DLIGHTS = 16;

const DLIGHT_DECL = /* glsl */ `
uniform int uNumDl;
uniform vec4 uDlPos[${MAX_DLIGHTS}];   // xyz, radius
uniform vec4 uDlCol[${MAX_DLIGHTS}];   // rgb (1 = Quake white), minlight
`;

const FOG_DECL = /* glsl */ `
uniform vec4 uFog; // rgb, density (0 = off)
vec3 applyFog(vec3 c, float dist) {
  if (uFog.w <= 0.0) return c;
  float f = exp2(-uFog.w * uFog.w * dist * dist * 1.442695);
  return mix(uFog.rgb, c, clamp(f, 0.0, 1.0));
}
`;

// ------------------------------------------------------------------------------ world

export const WORLD_VS = /* glsl */ `
precision highp float;
uniform mat4 modelMatrix, viewMatrix, projectionMatrix;
uniform float uStyles[64];
uniform vec2 uTexSize;
in vec3 position;
in vec3 normal;
in vec2 st;
in vec3 lm;
in vec4 styles;
out vec2 vUV;
out vec2 vST;
out vec2 vLM;
out float vStep;
out vec4 vStyle;
out vec3 vWorld;
out vec3 vNormal;
float sv(float s) { return s < 254.5 ? uStyles[int(s)] : 0.0; }
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vST = st;
  vUV = st / uTexSize;
  vLM = lm.xy;
  vStep = lm.z;
  vStyle = vec4(sv(styles.x), sv(styles.y), sv(styles.z), sv(styles.w));
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const WORLD_FS = /* glsl */ `
precision highp float;
uniform sampler2D uTex;
uniform sampler2D uLM;
uniform float uOverbright;   // 2 × lightmapScale
uniform float uFullbright;   // 1: map without light data
uniform float uEmissive;     // bloom weight of fullbright texels
uniform float uLightClamp;   // max light factor (classic 2.0, modern large)
uniform vec4 uFlat;          // r_drawflat: x = on
uniform vec3 uCam;
uniform float uOpaque;      // 1: drawing straight to the canvas (alpha = 1), 0: alpha = bloom weight
${DLIGHT_DECL}
${FOG_DECL}
in vec2 vUV;
in vec2 vST;
in vec2 vLM;
in float vStep;
in vec4 vStyle;
in vec3 vWorld;
in vec3 vNormal;
uniform float uOutScale;   // 0.5 into the 8-bit HDR target (range 0..2), 1 to the canvas
layout(location = 0) out vec4 outColor;
void main() {
  vec4 t = texture(uTex, vUV);
#ifdef CUTOUT
  if (t.a < 0.5) discard;
  t.a = 1.0;
#endif
  if (uFlat.x > 0.5) {
    t.rgb = abs(vNormal.z) > 0.7 ? vec3(0.55, 0.45, 0.33) : vec3(0.42, 0.40, 0.38);
    t.a = 1.0;
  }
  vec3 light = texture(uLM, vLM).rgb * vStyle.x;
  if (vStyle.y > 0.0) light += texture(uLM, vLM + vec2(vStep, 0.0)).rgb * vStyle.y;
  if (vStyle.z > 0.0) light += texture(uLM, vLM + vec2(vStep * 2.0, 0.0)).rgb * vStyle.z;
  if (vStyle.w > 0.0) light += texture(uLM, vLM + vec2(vStep * 3.0, 0.0)).rgb * vStyle.w;
#ifdef DLIGHTS
  // only faces a light reaches are drawn with this variant (WorldGeometry.cull)
  vec3 n = normalize(vNormal);
  for (int i = 0; i < ${MAX_DLIGHTS}; i++) {
    if (i >= uNumDl) break;
    vec3 d = uDlPos[i].xyz - vWorld;
    float pd = dot(d, n);
    float rad = uDlPos[i].w - abs(pd);
    if (rad <= uDlCol[i].w) continue;
    float ip = length(d - n * pd);
    float a = rad - ip;
    if (a > 0.0) light += uDlCol[i].rgb * (a * (1.0 / 255.0));
  }
#endif
  light = min(light * uOverbright, vec3(uLightClamp));
  light = mix(light, vec3(1.0), uFullbright);
  vec3 c = t.rgb * mix(vec3(1.0), light, t.a);
  c = applyFog(c, length(vWorld - uCam));
  outColor = vec4(c * uOutScale, max((1.0 - t.a) * uEmissive, uOpaque));
}
`;

/** EmitSkyPolys per fragment: two layers scrolling at 8 and 16 units/s. */
export const SKY_FS = /* glsl */ `
precision highp float;
uniform sampler2D uSkyBack;
uniform sampler2D uSkyFront;
uniform float uTime;
uniform vec3 uCam;
uniform float uSkyEmissive;
uniform float uOpaque;
uniform vec4 uFog;
in vec2 vUV;
in vec2 vST;
in vec2 vLM;
in float vStep;
in vec4 vStyle;
in vec3 vWorld;
in vec3 vNormal;
uniform float uOutScale;   // 0.5 into the 8-bit HDR target (range 0..2), 1 to the canvas
layout(location = 0) out vec4 outColor;
void main() {
  vec3 dir = vWorld - uCam;
  dir.z *= 3.0;
  float len = 6.0 * 63.0 / length(dir);
  vec2 d = dir.xy * len;
  vec2 back = (vec2(uTime * 8.0) + d) * (1.0 / 128.0);
  vec2 front = (vec2(uTime * 16.0) + d) * (1.0 / 128.0);
  vec3 b = texture(uSkyBack, back).rgb;
  vec4 f = texture(uSkyFront, front);
  vec3 c = mix(b, f.rgb, f.a);
  if (uFog.w > 0.0) c = mix(c, uFog.rgb, 0.35);
  outColor = vec4(c * uOutScale, max(uSkyEmissive, uOpaque));
}
`;

/** EmitWaterPolys per fragment: turbulent liquids, unlit. */
export const WARP_FS = /* glsl */ `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexSize;
uniform float uTime;
uniform float uAlpha;
uniform float uEmissive;
uniform float uWarpLight; // brightness of liquids (Quake draws them unlit at 1.0)
uniform float uOpaque;
uniform vec3 uCam;
${FOG_DECL}
in vec2 vUV;
in vec2 vST;
in vec2 vLM;
in float vStep;
in vec4 vStyle;
in vec3 vWorld;
in vec3 vNormal;
uniform float uOutScale;   // 0.5 into the 8-bit HDR target (range 0..2), 1 to the canvas
layout(location = 0) out vec4 outColor;
void main() {
  vec2 st = vST;
  vec2 uv = vec2(st.x + 8.0 * sin(st.y * 0.125 + uTime), st.y + 8.0 * sin(st.x * 0.125 + uTime)) / uTexSize;
  vec3 c = texture(uTex, uv).rgb * uWarpLight;
  c = applyFog(c, length(vWorld - uCam));
#ifdef TRANSLUCENT
  outColor = vec4(c * uOutScale, uAlpha);
#else
  outColor = vec4(c * uOutScale, max(uEmissive, uOpaque));
#endif
}
`;

// ------------------------------------------------------------------------------ alias models

export const ALIAS_VS = /* glsl */ `
precision highp float;
precision highp int;
uniform mat4 modelMatrix, viewMatrix, projectionMatrix;
uniform highp sampler2D uPoses;   // RGBA8: x, y, z, normal index
uniform highp sampler2D uNormals; // 162 × 1 RGB32F
uniform highp sampler2D uDots;    // 162 × 16 R32F (anorm_dots)
uniform vec4 uPose;    // poseA, poseB, lerp, rows per pose
uniform vec3 uScale;
uniform vec3 uOrigin;
uniform float uWidth;  // pose texture width
uniform vec4 uLight;   // ambient, shade, shadedots row, fullbright (1 = unlit)
uniform vec3 uLightCol; // light colour (rgb, normalised to max 1)
uniform vec3 uLightDir; // modern: key light direction (world, normalised)
uniform float uModern;
uniform vec3 uCam;
${DLIGHT_DECL}
in float vert;
in vec2 uv;
out vec2 vUV;
out vec3 vLight;
out vec3 vWorld;
out vec3 vNormal;
vec4 fetchPose(float pose, float v) {
  float row = pose * uPose.w + floor(v / uWidth);
  float col = mod(v, uWidth);
  return texelFetch(uPoses, ivec2(int(col), int(row)), 0);
}
void main() {
  vec4 a = fetchPose(uPose.x, vert);
  vec4 b = fetchPose(uPose.y, vert);
  vec3 p = mix(a.xyz, b.xyz, uPose.z) * 255.0 * uScale + uOrigin;
  int na = int(a.w * 255.0 + 0.5), nb = int(b.w * 255.0 + 0.5);
  vec3 n = normalize(mix(texelFetch(uNormals, ivec2(na, 0), 0).xyz, texelFetch(uNormals, ivec2(nb, 0), 0).xyz, uPose.z));
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vUV = uv;
  vec3 wn = normalize(mat3(modelMatrix) * n);
  vNormal = wn;
  vec3 light;
  if (uModern < 0.5) {
    float da = texelFetch(uDots, ivec2(na, int(uLight.z)), 0).r;
    float db = texelFetch(uDots, ivec2(nb, int(uLight.z)), 0).r;
    light = uLightCol * (mix(da, db, uPose.z) * uLight.y);
  } else {
    float k = max(dot(wn, uLightDir), 0.0);
    float hemi = 0.5 + 0.5 * wn.z;
    light = uLightCol * (uLight.x * (0.55 + 0.45 * hemi) + uLight.y * k);
    for (int i = 0; i < ${MAX_DLIGHTS}; i++) {
      if (i >= uNumDl) break;
      vec3 d = uDlPos[i].xyz - w.xyz;
      float dist = length(d);
      float add = uDlPos[i].w - dist;
      if (add > 0.0) light += uDlCol[i].rgb * (add / 160.0) * (0.35 + 0.65 * max(dot(wn, d / max(dist, 1.0)), 0.0));
    }
  }
  vLight = mix(light, vec3(1.0), uLight.w);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const ALIAS_FS = /* glsl */ `
precision highp float;
uniform sampler2D uSkin;
uniform float uAlpha;
uniform float uEmissive;
uniform float uRim;        // modern rim light strength
uniform vec3 uCam;
uniform vec3 uShell;       // quad/pent shell tint (0 = none)
uniform float uOpaque;
${FOG_DECL}
in vec2 vUV;
in vec3 vLight;
in vec3 vWorld;
in vec3 vNormal;
uniform float uOutScale;   // 0.5 into the 8-bit HDR target (range 0..2), 1 to the canvas
layout(location = 0) out vec4 outColor;
void main() {
  vec4 t = texture(uSkin, vUV);
  vec3 c = t.rgb * mix(vec3(1.0), vLight, t.a);
  vec3 v = normalize(uCam - vWorld);
  float ndv = clamp(dot(normalize(vNormal), v), 0.0, 1.0);
  float rim = pow(1.0 - ndv, 3.0);
  c += t.rgb * uRim * rim * (0.5 + 0.5 * clamp(vLight, 0.0, 1.5));
  c += uShell * (0.25 + 1.2 * rim);
  c = applyFog(c, length(vWorld - uCam));
  float e = (1.0 - t.a) * uEmissive + dot(uShell, vec3(0.3)) * rim;
#ifdef TRANSLUCENT
  outColor = vec4(c * uOutScale, uAlpha);
#else
  outColor = vec4(c * uOutScale, max(e, uOpaque));
#endif
}
`;

// ------------------------------------------------------------------------------ sprites, particles, glows

/** Instanced billboard quads: sprites (explosions) and flashblend glows. */
export const SPRITE_VS = /* glsl */ `
precision highp float;
uniform mat4 viewMatrix, projectionMatrix;
uniform vec3 uRight;
uniform vec3 uUp;
in vec3 position;          // quad corner (0..1, 0..1)
in vec4 iPos;              // xyz, unused
in vec4 iRect;             // left, up(top), width, height (units)
in vec4 iTex;              // atlas uv rect x, y, w, h
in vec4 iColor;            // rgba tint
out vec2 vUV;
out vec4 vColor;
void main() {
  vec2 c = position.xy;
  float dx = iRect.x + c.x * iRect.z;
  float dy = iRect.y - (1.0 - c.y) * iRect.w;
  vec3 p = iPos.xyz + uRight * dx + uUp * dy;
  vUV = iTex.xy + vec2(c.x, 1.0 - c.y) * iTex.zw;
  vColor = iColor;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

export const SPRITE_FS = /* glsl */ `
precision highp float;
uniform sampler2D uAtlas;
uniform float uEmissive;
uniform float uOpaque;
in vec2 vUV;
in vec4 vColor;
uniform float uOutScale;   // 0.5 into the 8-bit HDR target (range 0..2), 1 to the canvas
layout(location = 0) out vec4 outColor;
void main() {
  vec4 t = texture(uAtlas, vUV);
  if (t.a < 0.5) discard;
  outColor = vec4(t.rgb * vColor.rgb * uOutScale, max(uEmissive * vColor.a, uOpaque));
}
`;

export const PARTICLE_VS = /* glsl */ `
precision highp float;
uniform mat4 viewMatrix, projectionMatrix;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uCam;
uniform vec3 uFwd;
uniform float uSize;
uniform float uRound;
in vec3 position;          // corner -1..1
in vec4 iPos;              // xyz, size scale
in vec4 iColor;            // rgb, alpha
out vec2 vC;
out vec4 vColor;
void main() {
  // GLQuake: scale up with distance so particles don't vanish
  float d = dot(iPos.xyz - uCam, uFwd);
  float s = (d < 20.0 ? 1.0 : 1.0 + d * 0.004) * uSize * iPos.w;
  vec3 p = iPos.xyz + (uRight * position.x + uUp * position.y) * s;
  vC = position.xy;
  vColor = iColor;
  // modern: particles inside the eye (your own teleport splash) fade instead of filling the screen
  if (uRound > 0.5) vColor.a *= smoothstep(8.0, 32.0, d);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

export const PARTICLE_FS = /* glsl */ `
precision highp float;
uniform float uRound;      // 1 = soft round dots, 0 = square
in vec2 vC;
in vec4 vColor;
uniform float uOutScale;   // 0.5 into the 8-bit HDR target (range 0..2), 1 to the canvas
layout(location = 0) out vec4 outColor;
void main() {
  float r = dot(vC, vC);
  float a = uRound > 0.5 ? smoothstep(1.0, 0.35, r) : 1.0;
  if (a < 0.02) discard;
  outColor = vec4(vColor.rgb * uOutScale, vColor.a * a);
}
`;

/**
 * gl_flashblend: R_RenderDlight's glow — a fan whose centre is pulled towards the viewer by
 * the radius and whose rim (black) sits at the light, drawn additively.
 */
export const GLOW_VS = /* glsl */ `
precision highp float;
uniform mat4 viewMatrix, projectionMatrix;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uFwd;
in vec3 position;          // ring: (cos, sin, 0); centre: (0, 0, 1)
in vec4 iPos;              // light origin xyz, radius
in vec4 iRect;
in vec4 iTex;
in vec4 iColor;
out vec4 vColor;
void main() {
  float r = iPos.w;
  vec3 p = iPos.xyz + (uRight * position.x + uUp * position.y) * r - uFwd * (position.z * r);
  vColor = vec4(iColor.rgb * position.z, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

export const GLOW_FS = /* glsl */ `
precision highp float;
in vec4 vColor;
uniform float uOutScale;   // 0.5 into the 8-bit HDR target (range 0..2), 1 to the canvas
layout(location = 0) out vec4 outColor;
void main() { outColor = vec4(vColor.rgb * uOutScale, vColor.a); }
`;

// ------------------------------------------------------------------------------ post

export const FULLSCREEN_VS = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUV;
void main() {
  vUV = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const BLOOM_EXTRACT_FS = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
in vec2 vUV;
layout(location = 0) out vec4 outColor;
uniform float uInScale;
vec3 pick(vec2 uv) {
  vec4 c = texture(uSrc, uv);
  c.rgb *= uInScale;
  float l = max(c.r, max(c.g, c.b));
  return c.rgb * clamp(c.a, 0.0, 1.0) + c.rgb * max(l - uThreshold, 0.0) / max(l, 1e-4);
}
void main() {
  vec3 c = pick(vUV + uTexel * vec2(-0.5, -0.5)) + pick(vUV + uTexel * vec2(0.5, -0.5))
         + pick(vUV + uTexel * vec2(-0.5, 0.5)) + pick(vUV + uTexel * vec2(0.5, 0.5));
  outColor = vec4(c * 0.25, 1.0);
}
`;

export const BLOOM_DOWN_FS = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
in vec2 vUV;
layout(location = 0) out vec4 outColor;
void main() {
  vec3 c = texture(uSrc, vUV).rgb * 4.0;
  c += texture(uSrc, vUV + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(uSrc, vUV + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture(uSrc, vUV + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture(uSrc, vUV + uTexel * vec2(1.0, 1.0)).rgb;
  outColor = vec4(c / 8.0, 1.0);
}
`;

export const BLOOM_UP_FS = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uBase;
uniform vec2 uTexel;
in vec2 vUV;
layout(location = 0) out vec4 outColor;
void main() {
  vec3 c = texture(uSrc, vUV + uTexel * vec2(-2.0, 0.0)).rgb;
  c += texture(uSrc, vUV + uTexel * vec2(-1.0, 1.0)).rgb * 2.0;
  c += texture(uSrc, vUV + uTexel * vec2(0.0, 2.0)).rgb;
  c += texture(uSrc, vUV + uTexel * vec2(1.0, 1.0)).rgb * 2.0;
  c += texture(uSrc, vUV + uTexel * vec2(2.0, 0.0)).rgb;
  c += texture(uSrc, vUV + uTexel * vec2(1.0, -1.0)).rgb * 2.0;
  c += texture(uSrc, vUV + uTexel * vec2(0.0, -2.0)).rgb;
  c += texture(uSrc, vUV + uTexel * vec2(-1.0, -1.0)).rgb * 2.0;
  outColor = vec4(c / 12.0 + texture(uBase, vUV).rgb, 1.0);
}
`;

/** Scalable ambient obscurance from depth only (half res), off by default. */
export const SSAO_FS = /* glsl */ `
precision highp float;
uniform highp sampler2D uDepth;
uniform vec2 uTexel;
uniform vec4 uProj;   // near, far, tanHalfFovX, tanHalfFovY
uniform float uRadius;
in vec2 vUV;
layout(location = 0) out vec4 outColor;
float linDepth(vec2 uv) {
  float z = texture(uDepth, uv).r * 2.0 - 1.0;
  return 2.0 * uProj.x * uProj.y / (uProj.y + uProj.x - z * (uProj.y - uProj.x));
}
vec3 viewPos(vec2 uv) {
  float d = linDepth(uv);
  return vec3((uv * 2.0 - 1.0) * uProj.zw * d, -d);
}
void main() {
  vec3 p = viewPos(vUV);
  vec3 n = normalize(cross(dFdx(p), dFdy(p)));
  float ao = 0.0;
  float rr = uRadius / max(-p.z, 1.0);
  const int N = 12;
  float ang = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
  for (int i = 0; i < N; i++) {
    float fi = (float(i) + 0.5) / float(N);
    float a = ang + fi * 6.2831 * 3.0;
    vec2 o = vec2(cos(a), sin(a)) * rr * fi;
    vec3 q = viewPos(vUV + o / uProj.zw * 0.5);
    vec3 v = q - p;
    float vv = dot(v, v);
    float vn = dot(v, n);
    ao += max(vn - 0.02 * (-p.z), 0.0) / (vv + 0.01) * smoothstep(uRadius * uRadius * 4.0, 0.0, vv);
  }
  ao = clamp(1.0 - ao * 2.0 / float(N) * uRadius, 0.0, 1.0);
  outColor = vec4(ao, ao, ao, 1.0);
}
`;

/**
 * Composite: (FXAA on the scene, fused here to save a full-screen pass) + SSAO + bloom,
 * tone map (ACES on the highlights, identity toe), view blend, gamma, underwater warp.
 * Gamma 2.2 is approximated by square / square root (cheap on software GL).
 */
export const COMPOSITE_FS = /* glsl */ `
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uAO;
uniform vec2 uTexel;
uniform float uFxaa;
uniform float uBloomStrength;
uniform float uAOOn;
uniform float uAces;
uniform float uExposure;
uniform float uGamma;
uniform vec4 uBlend;
uniform float uWarp;     // underwater warp amount
uniform float uTime;
in vec2 vUV;
layout(location = 0) out vec4 outColor;
vec3 aces(vec3 x) {
  // Narkowicz 2015 fit of the ACES RRT+ODT
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
uniform float uInScale;   // undo the scene target's 0.5 storage scale
float luma(vec3 c) { return dot(min(c * uInScale, vec3(1.0)), vec3(0.299, 0.587, 0.114)); }
vec3 fxaa(vec2 uv) {
  vec3 rgbM = texture(uScene, uv).rgb;
  float lM = luma(rgbM);
  float lNW = luma(texture(uScene, uv + vec2(-1.0, -1.0) * uTexel).rgb), lNE = luma(texture(uScene, uv + vec2(1.0, -1.0) * uTexel).rgb);
  float lSW = luma(texture(uScene, uv + vec2(-1.0, 1.0) * uTexel).rgb), lSE = luma(texture(uScene, uv + vec2(1.0, 1.0) * uTexel).rgb);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.0312, lMax * 0.125)) return rgbM;
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float red = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
  dir = clamp(dir * rcp, -8.0, 8.0) * uTexel;
  vec3 a = 0.5 * (texture(uScene, uv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(uScene, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(uScene, uv - dir * 0.5).rgb + texture(uScene, uv + dir * 0.5).rgb);
  float lB = luma(b);
  return (lB < lMin || lB > lMax) ? a : b;
}
void main() {
  vec2 uv = vUV;
  if (uWarp > 0.0) {
    uv += uWarp * vec2(sin(uv.y * 18.0 + uTime * 2.3), cos(uv.x * 14.0 + uTime * 1.9)) * 0.004;
  }
  vec3 c = (uFxaa > 0.5 ? fxaa(uv) : texture(uScene, uv).rgb) * uInScale;
  if (uAOOn > 0.5) c *= texture(uAO, uv).r;
  c += texture(uBloom, uv).rgb * uBloomStrength;
  if (uAces > 0.5) {
    // ACES on the highlights; below the knee the curve blends back to identity so Quake's
    // dark corners keep their detail (plain ACES has a slope of ~0.2 at black).
    vec3 lin = max(c, 0.0); lin = lin * lin * uExposure;
    vec3 w = smoothstep(vec3(0.0), vec3(0.6), lin);
    c = sqrt(mix(lin, aces(lin), w));
  } else {
    c = clamp(c * uExposure, 0.0, 1.0);
  }
  c = mix(c, uBlend.rgb, uBlend.a);
  if (uGamma != 1.0) c = pow(c, vec3(1.0 / uGamma));
  outColor = vec4(c, 1.0);
}
`;

/** Classic path (no post): the view blend as one translucent quad. */
export const BLEND_FS = /* glsl */ `
precision highp float;
uniform vec4 uBlend;
in vec2 vUV;
layout(location = 0) out vec4 outColor;
void main() { outColor = uBlend; }
`;

/** Copies a texture to the screen (used for the preview / debugging). */
export const COPY_FS = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
in vec2 vUV;
layout(location = 0) out vec4 outColor;
void main() { outColor = texture(uSrc, vUV); }
`;
