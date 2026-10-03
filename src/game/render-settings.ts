/*
 * Quake Town — the renderer's settings from the cvars (r_preset and the QW names).
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */
import { PRESETS, type RenderSettings } from '../render/types.js';
import type { Cvars } from '../console/cvars.js';

const WATCHED = ['r_preset', 'r_bloom', 'r_ssao', 'r_tonemap', 'r_dynamic', 'gl_flashblend', 'gl_texturemode', 'r_drawflat',
  'r_fullbrightskins', 'r_waterwarp', 'r_drawviewmodel', 'r_lerpmodels', 'gamma', 'r_scale', 'r_particles'];

export function renderSettingsFromCvars(c: Cvars): Partial<RenderSettings> {
  const preset = c.get('r_preset') === 'classic' ? PRESETS.classic : PRESETS.modern;
  const on = (n: string, d: boolean): boolean => (c.has(n) ? c.num(n) !== 0 : d);
  const tm = c.get('gl_texturemode');
  return {
    ...preset,
    bloom: on('r_bloom', preset.bloom),
    ssao: on('r_ssao', preset.ssao),
    toneMapping: on('r_tonemap', preset.toneMapping === 'aces') ? 'aces' : 'none',
    dynamicLights: on('r_dynamic', preset.dynamicLights),
    flashblend: on('gl_flashblend', preset.flashblend),
    textureFilter: tm ? (tm.includes('NEAREST') ? 'nearest' : 'linear') : preset.textureFilter,
    drawflat: on('r_drawflat', false),
    fullbrightSkins: on('r_fullbrightskins', false),
    waterWarp: on('r_waterwarp', preset.waterWarp),
    drawViewModel: on('r_drawviewmodel', true),
    lerpFrames: on('r_lerpmodels', true),
    gamma: c.has('gamma') ? 1 / Math.max(0.3, c.num('gamma') || 1) : 1,
    resolutionScale: c.has('r_scale') ? Math.max(0.25, Math.min(1, c.num('r_scale') || 1)) : 1,
    particles: c.has('r_particles') && c.num('r_particles') === 0 ? preset.particles : preset.particles,
  };
}

/** Re-apply when any render cvar changes. Returns the unsubscribe. */
export function watchRenderCvars(c: Cvars, apply: (s: Partial<RenderSettings>) => void): () => void {
  const offs = WATCHED.map((n) => c.onChange(n, () => apply(renderSettingsFromCvars(c))));
  return () => { for (const o of offs) o(); };
}
