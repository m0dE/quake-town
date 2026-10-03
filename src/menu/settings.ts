/**
 * Settings: mouse, video (classic / modern presets + every option), HUD, audio, keys.
 * Controls are generated from the cvar definitions, so the menu and the console agree.
 *
 * Licence: GPL-2.0-or-later.
 */
import { binds, cvars, mouseKeyName, keyName, wheelKeyName, settings, type CvarDef, type CvarGroup } from '../settings/index.js';
import { h, clear } from './dom.js';
import { pixelText } from './pixelfont.js';
import type { MenuCtx, Screen } from './types.js';

/** Menu ranges where they are narrower than the cvar's (the console still takes the full range). */
const MENU_RANGE: Record<string, [number, number, number]> = {
  fov: [90, 130, 1],
  sensitivity: [0.5, 20, 0.1],
  m_pitch: [-0.044, 0.044, 0.001],
};

const ACTIONS: [string, string][] = [
  ['+forward', 'Move forward'], ['+back', 'Move back'], ['+moveleft', 'Strafe left'], ['+moveright', 'Strafe right'],
  ['+jump', 'Jump / swim up'], ['+movedown', 'Swim down'], ['+attack', 'Fire'], ['+speed', 'Walk / run toggle'],
  ['impulse 1', 'Axe'], ['impulse 2', 'Shotgun'], ['impulse 3', 'Super shotgun'], ['impulse 4', 'Nailgun'],
  ['impulse 5', 'Super nailgun'], ['impulse 6', 'Grenade launcher'], ['impulse 7', 'Rocket launcher'], ['impulse 8', 'Thunderbolt'],
  ['impulse 10', 'Next weapon'], ['impulse 12', 'Previous weapon'],
  ['+showscores', 'Scoreboard'], ['messagemode', 'Chat'], ['messagemode2', 'Team chat'], ['toggleconsole', 'Console'],
  ['ready', 'Ready up'], ['break', 'Not ready'],
];

type Tab = 'mouse' | 'video' | 'hud' | 'audio' | 'keys';

export function settingsScreen(ctx: MenuCtx): Screen {
  const unsubs: (() => void)[] = [];
  let tab: Tab = 'mouse';
  const body = h('div.set-body');
  const tabs = h('div.tabs', { role: 'tablist', 'aria-label': 'Settings' });
  const TABS: [Tab, string][] = [['mouse', 'Mouse'], ['video', 'Video'], ['hud', 'HUD'], ['audio', 'Sound'], ['keys', 'Keys']];
  for (const [id, label] of TABS) {
    const b = h('button.tab', { type: 'button', role: 'tab', 'data-tab': id }, label);
    b.addEventListener('click', () => { tab = id; paint(); });
    tabs.append(b);
  }

  // ------------------------------------------------------------------ one control per cvar
  function control(d: CvarDef): HTMLElement {
    const label = h('span.lab', {}, d.label, h('code.cv', {}, d.name));
    if (d.kind === 'bool') {
      const cb = h('input', { type: 'checkbox', role: 'switch' });
      const paintV = (): void => { cb.checked = cvars.bool(d.name); };
      cb.addEventListener('change', () => cvars.set(d.name, cb.checked));
      paintV();
      unsubs.push(cvars.onChange(d.name, paintV));
      return h('label.opt.opt-bool', { title: d.help }, label, h('span.switch', {}, cb, h('i')), h('small', {}, d.help));
    }
    if (d.kind === 'enum') {
      const seg = h('div.seg', { role: 'radiogroup', 'aria-label': d.label });
      d.options!.forEach((o, i) => {
        const b = h('button.seg-btn', { type: 'button', role: 'radio', 'data-v': o }, d.optionLabels?.[i] ?? o);
        b.addEventListener('click', () => (d.name === 'r_preset' ? cvars.applyPreset(o as 'classic' | 'modern') : cvars.set(d.name, o)));
        seg.append(b);
      });
      const paintV = (): void => { for (const b of seg.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.v === cvars.get(d.name))); };
      paintV();
      unsubs.push(cvars.onChange(d.name, paintV));
      return h('div.opt', { title: d.help }, label, seg, h('small', {}, d.help));
    }
    if (d.kind === 'float' || d.kind === 'int') {
      const [lo, hi, step] = MENU_RANGE[d.name] ?? [d.min ?? 0, d.max ?? 1, d.step ?? 0.01];
      const r = h('input', { type: 'range', min: String(lo), max: String(hi), step: String(step), 'aria-label': d.label });
      const n = h('input.numv', { type: 'number', min: String(d.min ?? ''), max: String(d.max ?? ''), step: String(step), 'aria-label': `${d.label} value` });
      const paintV = (): void => { r.value = cvars.get(d.name); if (document.activeElement !== n) n.value = cvars.get(d.name); };
      r.addEventListener('input', () => cvars.set(d.name, r.value));
      n.addEventListener('change', () => { cvars.set(d.name, n.value); paintV(); });
      paintV();
      unsubs.push(cvars.onChange(d.name, paintV));
      return h('label.opt.opt-num', { title: d.help }, label, h('span.numrow', {}, r, n), h('small', {}, d.help));
    }
    const t = h('input', { type: 'text', 'aria-label': d.label });
    t.value = cvars.get(d.name);
    t.addEventListener('change', () => { cvars.set(d.name, t.value); t.value = cvars.get(d.name); });
    return h('label.opt', { title: d.help }, label, t, h('small', {}, d.help));
  }

  const group = (g: CvarGroup, only?: (d: CvarDef) => boolean): HTMLElement[] =>
    cvars.group(g).filter((d) => d.kind !== 'palette' && d.kind !== 'color' && (!only || only(d))).map(control);

  function presetCards(): HTMLElement {
    const wrap = h('div.presets', { role: 'radiogroup', 'aria-label': 'Look' });
    const card = (id: 'classic' | 'modern', title: string, desc: string): HTMLElement => {
      const b = h('button.preset', { type: 'button', role: 'radio', 'data-v': id },
        h('span.swatch', { class: `sw-${id}`, 'aria-hidden': 'true' }), h('b', {}, title), h('small', {}, desc));
      b.addEventListener('click', () => cvars.applyPreset(id));
      return b;
    };
    wrap.append(
      card('classic', 'Classic', 'GL QuakeWorld as it looked: pixelated textures, glow-ball lights, no bloom.'),
      card('modern', 'Modern', 'Smooth textures, lights that light the walls, bloom and filmic colour.'),
    );
    const note = h('p.fine.preset-note');
    const paintV = (): void => {
      const cur = cvars.currentPreset();
      for (const b of wrap.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.v === cur));
      note.textContent = cur === 'custom' ? 'You changed some options below, so neither look is exact. Pick one to reset them.' : '';
    };
    paintV();
    for (const k of ['r_preset', 'r_bloom', 'r_ssao', 'r_tonemap', 'r_dynamic', 'gl_flashblend', 'gl_texturemode']) unsubs.push(cvars.onChange(k, paintV));
    return h('div', {}, wrap, note);
  }

  // ------------------------------------------------------------------ keys
  let capturing: { cmd: string; btn: HTMLButtonElement } | null = null;
  function keysPane(): HTMLElement {
    const list = h('div.keys', { role: 'table', 'aria-label': 'Key bindings' });
    const paintK = (): void => {
      clear(list);
      for (const [cmd, label] of ACTIONS) {
        const keys = binds.keysFor(cmd);
        const b = h('button.keycap', { type: 'button', title: 'Click, then press a key or mouse button. Escape cancels, Backspace clears.' },
          keys.length ? keys.join('  ') : 'unbound');
        b.addEventListener('click', () => startCapture(cmd, b));
        list.append(h('div.krow', { role: 'row' }, h('span', { role: 'cell' }, label), h('code.cv', { role: 'cell' }, cmd), h('span', { role: 'cell' }, b)));
      }
    };
    paintK();
    unsubs.push(binds.onChange(paintK));
    const reset = h('button.ghost.small', { type: 'button' }, 'Reset all keys');
    reset.addEventListener('click', () => { binds.resetDefaults(); ctx.toast('Keys reset to the defaults.'); });
    return h('div', {}, h('p.fine', {}, 'Key names follow QuakeWorld, so binds made here and in the console (bind, unbind) are the same thing.'), list, reset);
  }

  function startCapture(cmd: string, btn: HTMLButtonElement): void {
    stopCapture();
    capturing = { cmd, btn };
    btn.classList.add('listening');
    btn.textContent = 'Press a key…';
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
  }
  function stopCapture(): void {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', onMouse, true);
    window.removeEventListener('wheel', onWheel, true);
    if (capturing) { capturing.btn.classList.remove('listening'); capturing = null; }
  }
  function assign(key: string): void {
    if (!capturing) return;
    const { cmd } = capturing;
    stopCapture();
    const prev = binds.get(key);
    binds.set(key, cmd);
    if (prev && prev !== cmd) ctx.toast(`${key} was “${prev}”; now it is “${cmd}”.`);
  }
  function onKey(e: KeyboardEvent): void {
    e.preventDefault(); e.stopPropagation();
    if (!capturing) return;
    if (e.key === 'Escape') { stopCapture(); paint(); return; }
    if (e.key === 'Backspace') { const { cmd } = capturing; stopCapture(); for (const k of binds.keysFor(cmd)) binds.unbind(k); paint(); return; }
    assign(keyName(e));
  }
  function onMouse(e: MouseEvent): void {
    if (!capturing) return;
    e.preventDefault(); e.stopPropagation();
    assign(mouseKeyName(e.button));
  }
  function onWheel(e: WheelEvent): void { e.preventDefault(); assign(wheelKeyName(e.deltaY)); }

  // ------------------------------------------------------------------ panes
  function paint(): void {
    stopCapture();
    for (const u of unsubs.splice(0)) u();
    for (const b of tabs.children) b.setAttribute('aria-selected', String((b as HTMLElement).dataset.tab === tab));
    clear(body);
    const reset = (g: CvarGroup, what: string): HTMLElement => {
      const b = h('button.ghost.small', { type: 'button' }, `Reset ${what}`);
      b.addEventListener('click', () => { cvars.resetAll(g); ctx.toast(`${what[0].toUpperCase()}${what.slice(1)} reset to the defaults.`); });
      return b;
    };
    if (tab === 'mouse') body.append(h('div.opts', {}, ...group('input')), reset('input', 'mouse and movement'));
    if (tab === 'video') {
      body.append(presetCards(),
        h('div.opts', {}, ...group('video', (d) => d.name !== 'r_preset')), reset('video', 'video'));
    }
    if (tab === 'hud') body.append(h('p.fine', {}, 'Crosshair shape and colour are on the Player page.'), h('div.opts', {}, ...group('hud', (d) => !d.name.startsWith('crosshair'))), reset('hud', 'HUD'));
    if (tab === 'audio') body.append(h('div.opts', {}, ...group('audio')), reset('audio', 'sound'));
    if (tab === 'keys') body.append(keysPane());
  }

  const where = h('p.fine.where');
  const paintWhere = (): void => {
    const s = settings.status();
    where.textContent = s === 'account' ? 'Saved to your ARRR account: they follow you to any browser you sign in on.'
      : s === 'loading' ? 'Loading your settings from your account…'
        : 'Saved in this browser. Sign in with ARRR to keep them on every device.';
  };
  const offStatus = settings.onStatus(paintWhere);

  const el = h('section.screen.settings', { 'aria-labelledby': 'set-title' },
    h('div.screen-head', {}, h('h2#set-title', {}, pixelText('Settings', { px: 4, bold: true })), where),
    tabs,
    body,
  );

  return {
    el,
    show() { paintWhere(); paint(); },
    hide() { stopCapture(); },
    dispose() { stopCapture(); offStatus(); for (const u of unsubs) u(); },
  };
}
