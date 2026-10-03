/**
 * Player: name, team, model, skin, shirt and pants colours (QW palette rows), crosshair
 * designer, HUD layout — with the character preview.
 *
 * Licence: GPL-2.0-or-later.
 */
import {
  CROSSHAIR_NAMES, PALETTE_ROWS, cvars, drawCrosshair, paletteCss, playerLook, rowRamp, rowSwatch,
} from '../settings/index.js';
import { h, clear } from './dom.js';
import { pixelText } from './pixelfont.js';
import { drawPlaceholder } from './preview.js';
import type { MenuCtx, Screen } from './types.js';

export function playerScreen(ctx: MenuCtx): Screen {
  const unsubs: (() => void)[] = [];
  let raf = 0;
  let turn = 0;

  // ------------------------------------------------------------------ preview
  const canvas = h('canvas.preview', { width: '360', height: '480', 'aria-label': 'Your character' });
  const plate = h('div.plate', {}, h('b.pname'), h('small.pteam'));
  const previewBox = h('div.previewbox', {}, canvas, plate,
    h('p.fine', {}, ctx.deps.renderPreview ? 'Drag to turn.' : 'Drag to turn. The full 3D model shows once the game has loaded.'));
  let dragX: number | null = null;
  canvas.addEventListener('pointerdown', (e) => { dragX = e.clientX; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => { if (dragX !== null) { turn += (e.clientX - dragX) / 80; dragX = e.clientX; } });
  canvas.addEventListener('pointerup', () => { dragX = null; });

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t0 = performance.now();
  const frame = (): void => {
    const t = reduce ? 0.9 : (performance.now() - t0) / 1000;
    const look = playerLook();
    if (ctx.deps.renderPreview) {
      // The renderer sizes its own WebGL canvas; `t + turn` turns the model.
      ctx.deps.renderPreview(canvas, look, t + turn);
    } else {
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = Math.round(canvas.clientWidth * dpr);
      const hh = Math.round(canvas.clientHeight * dpr);
      if (w && hh && (canvas.width !== w || canvas.height !== hh)) { canvas.width = w; canvas.height = hh; }
      drawPlaceholder(canvas, look, t, turn);
    }
    raf = requestAnimationFrame(frame);
  };

  // ------------------------------------------------------------------ identity
  const name = h('input', { type: 'text', maxlength: '20', 'aria-label': 'Name', autocomplete: 'nickname' });
  name.value = cvars.get('name');
  name.addEventListener('change', () => { cvars.set('name', name.value); name.value = cvars.get('name'); });
  name.addEventListener('input', () => paintPlate());
  const team = h('input', { type: 'text', maxlength: '8', 'aria-label': 'Team', placeholder: 'Auto', list: 'qt-teams' });
  team.value = cvars.get('team');
  team.addEventListener('change', () => { cvars.set('team', team.value); team.value = cvars.get('team'); paintPlate(); });
  const teams = h('datalist#qt-teams', {}, h('option', { value: 'red' }), h('option', { value: 'blue' }));

  const models = ctx.deps.models?.() ?? ['player'];
  const skins = ctx.deps.skins?.() ?? ['base'];
  const sel = (cvar: string, opts: string[], label: string): HTMLSelectElement => {
    const s = h('select', { 'aria-label': label }, ...[...new Set([cvars.get(cvar), ...opts])].map((o) => h('option', { value: o }, o)));
    s.value = cvars.get(cvar);
    s.addEventListener('change', () => cvars.set(cvar, s.value));
    return s;
  };

  function paintPlate(): void {
    plate.querySelector('.pname')!.textContent = name.value || cvars.get('name');
    plate.querySelector('.pteam')!.textContent = cvars.get('team') ? `team ${cvars.get('team')}` : '';
  }

  // ------------------------------------------------------------------ colours
  const colourRow = (cvar: 'topcolor' | 'bottomcolor', label: string): HTMLElement => {
    const group = h('div.swatches', { role: 'radiogroup', 'aria-label': label });
    for (const r of PALETTE_ROWS) {
      const ramp = rowRamp(r.row);
      const b = h('button.sw', {
        type: 'button', role: 'radio', title: `${r.name} (${r.row})`, 'aria-label': r.name, 'data-v': String(r.row),
        style: `--a:${ramp[4]};--b:${ramp[9]};--c:${ramp[14]};--s:${rowSwatch(r.row)}`,
      });
      b.addEventListener('click', () => cvars.set(cvar, r.row));
      group.append(b);
    }
    const paint = (): void => {
      for (const b of group.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.v === cvars.get(cvar)));
    };
    paint();
    unsubs.push(cvars.onChange(cvar, paint));
    return h('div.field', {}, h('span', {}, label), group);
  };

  // ------------------------------------------------------------------ crosshair
  const xcanvas = h('canvas.xh-view', { width: '320', height: '180', 'aria-label': 'Crosshair preview' });
  const shapes = h('div.xh-shapes', { role: 'radiogroup', 'aria-label': 'Crosshair shape' });
  CROSSHAIR_NAMES.forEach((n, i) => {
    const icon = h('canvas', { width: '40', height: '40', 'aria-hidden': 'true' });
    const b = h('button.xh-shape', { type: 'button', role: 'radio', title: n, 'aria-label': n, 'data-v': String(i) }, icon);
    b.addEventListener('click', () => cvars.set('crosshair', i));
    shapes.append(b);
  });
  const grid = h('div.pal', { role: 'radiogroup', 'aria-label': 'Crosshair colour' });
  for (let i = 0; i < 256; i++) {
    const b = h('button.pc', { type: 'button', role: 'radio', 'aria-label': `Colour ${i}`, title: String(i), style: `background:${paletteCss(i)}`, 'data-v': String(i) });
    b.addEventListener('click', () => cvars.set('crosshaircolor', i));
    grid.append(b);
  }
  const range = (cvar: string, label: string): HTMLElement => {
    const d = cvars.def(cvar)!;
    const r = h('input', { type: 'range', min: String(d.min), max: String(d.max), step: String(d.step ?? 0.05), 'aria-label': label });
    const out = h('output');
    const paint = (): void => { r.value = cvars.get(cvar); out.textContent = cvars.get(cvar); };
    r.addEventListener('input', () => cvars.set(cvar, r.value));
    paint();
    unsubs.push(cvars.onChange(cvar, paint));
    return h('label.field.range', {}, h('span', {}, label), r, out);
  };

  function paintCrosshair(): void {
    const shape = cvars.num('crosshair');
    const style = { shape, size: cvars.num('crosshairsize'), color: paletteCss(cvars.num('crosshaircolor')), alpha: cvars.num('crosshairalpha') };
    const g = xcanvas.getContext('2d')!;
    const W = xcanvas.width, H = xcanvas.height;
    // a wall: stone blocks lit from above, so the colour is judged against the game's browns
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#5b4632'); grad.addColorStop(1, '#2a1f16');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    for (let y = 0; y < H; y += 30) {
      g.fillRect(0, y, W, 2);
      for (let x = (y / 30) % 2 ? 0 : 40; x < W; x += 80) g.fillRect(x, y, 2, 30);
    }
    g.fillStyle = 'rgba(255,220,160,0.08)'; g.fillRect(0, 0, W / 2, H);
    drawCrosshair(g, W / 2 + cvars.num('cl_crossx'), H / 2 + cvars.num('cl_crossy'), { ...style, scale: 2 });
    for (const b of shapes.children) {
      const i = Number((b as HTMLElement).dataset.v);
      b.setAttribute('aria-checked', String(i === shape));
      const c = (b.firstChild as HTMLCanvasElement).getContext('2d')!;
      c.clearRect(0, 0, 40, 40);
      if (i === 0) { c.fillStyle = '#8c785f'; c.font = '600 12px "Space Grotesk", sans-serif'; c.textAlign = 'center'; c.fillText('off', 20, 24); }
      else drawCrosshair(c, 20, 20, { shape: i, size: 1, color: '#e8d9bb', alpha: 1, scale: 1 });
    }
    for (const b of grid.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.v === cvars.get('crosshaircolor')));
  }
  for (const k of ['crosshair', 'crosshaircolor', 'crosshairsize', 'crosshairalpha', 'cl_crossx', 'cl_crossy']) unsubs.push(cvars.onChange(k, paintCrosshair));

  // ------------------------------------------------------------------ hud
  const huds = h('div.huds', { role: 'radiogroup', 'aria-label': 'HUD layout' });
  const hudCard = (id: 'classic' | 'modern', label: string, desc: string): HTMLButtonElement => {
    const mock = id === 'classic'
      ? h('div.mock.mock-classic', { 'aria-hidden': 'true' }, h('i.bar', {}, h('b', {}, '100'), h('b.face'), h('b', {}, '200'), h('b', {}, '25')))
      : h('div.mock.mock-modern', { 'aria-hidden': 'true' }, h('i.hp', {}, '100', h('small', {}, '200')), h('i.am', {}, '25'));
    const b = h('button.hudcard', { type: 'button', role: 'radio', 'data-v': id }, mock, h('b', {}, label), h('small', {}, desc));
    b.addEventListener('click', () => cvars.set('hud_layout', id));
    return b;
  };
  huds.append(hudCard('classic', 'Classic', 'The QuakeWorld status bar.'), hudCard('modern', 'Modern', 'Small numbers in the corners.'));
  const paintHud = (): void => { for (const b of huds.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.v === cvars.get('hud_layout'))); };
  unsubs.push(cvars.onChange('hud_layout', paintHud));

  const field = (label: string, input: HTMLElement, hint?: string): HTMLElement => h('label.field', {}, h('span', {}, label), input, hint ? h('small', {}, hint) : null);

  const el = h('section.screen.player', { 'aria-labelledby': 'pl-title' },
    h('div.screen-head', {}, h('h2#pl-title', {}, pixelText('Player', { px: 4, bold: true }))),
    h('div.player-grid', {},
      previewBox,
      h('div.col', {},
        h('div.row2', {}, field('Name', name), field('Team', team, 'Team modes pick one for you when empty')), teams,
        h('div.row2', {}, field('Model', sel('model', models, 'Model')), field('Skin', sel('skin', skins, 'Skin'))),
        colourRow('topcolor', 'Shirt'),
        colourRow('bottomcolor', 'Pants'),
        h('div.field', {}, h('span', {}, 'HUD'), huds),
      ),
      h('div.col.xh', {},
        h('div.field', {}, h('span', {}, 'Crosshair'), xcanvas, shapes),
        h('div.field', {}, h('span', {}, 'Crosshair colour'), grid),
        range('crosshairsize', 'Size'),
        range('crosshairalpha', 'Opacity'),
      ),
    ),
  );

  return {
    el,
    show() {
      paintPlate();
      paintCrosshair();
      paintHud();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    },
    hide() { cancelAnimationFrame(raf); },
    dispose() { for (const u of unsubs) u(); },
  };
}

export { clear };
