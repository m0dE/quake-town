/**
 * The start screen's main view: your character on the left with Customize under it,
 * quick play and the server list on the right.
 *
 * Licence: GPL-2.0-or-later.
 */
import {
  MODES, MODE_ORDER, REGIONS, encodeRoomId, homeRegion, standingConfig, quickPlay, fetchServers,
  type RoomConfig,
} from '../rooms/index.js';
import { cvars, rowSwatch } from '../settings/index.js';
import { h } from './dom.js';
import { characterView } from './preview.js';
import { serversScreen } from './servers.js';
import type { MenuCtx, Screen } from './types.js';

export function lobbyScreen(ctx: MenuCtx): Screen {
  const unsubs: (() => void)[] = [];

  // ------------------------------------------------------------------ character
  const view = characterView(ctx.deps, 'preview hero-view');
  const pname = h('b.pname');
  const pteam = h('small.pteam');
  const shirt = h('i.chip-c', { title: 'Shirt' });
  const pants = h('i.chip-c', { title: 'Pants' });
  const paint = (): void => {
    pname.textContent = cvars.get('name');
    pteam.textContent = cvars.get('team') ? `team ${cvars.get('team')}` : '';
    shirt.style.background = rowSwatch(cvars.num('topcolor'));
    pants.style.background = rowSwatch(cvars.num('bottomcolor'));
  };
  for (const k of ['name', 'team', 'topcolor', 'bottomcolor']) unsubs.push(cvars.onChange(k, paint));
  const customize = h('button.ghost.customize', { type: 'button' }, 'Customize');
  customize.addEventListener('click', () => ctx.go('player'));

  const hero = h('section.hero', { 'aria-label': 'Your character' },
    h('div.stage', {}, view.canvas),
    h('div.ident', {}, pname, h('span.colours', { 'aria-hidden': 'true' }, shirt, pants), pteam),
    customize,
  );

  // ------------------------------------------------------------------ servers
  const servers = serversScreen(ctx);
  const el = h('div.lobby', {}, hero, h('div.lobby-play', {}, quickBar(ctx), servers.el));

  return {
    el,
    show() { paint(); view.start(); servers.show?.(); },
    hide() { view.stop(); servers.hide?.(); },
    dispose() { for (const u of unsubs) u(); servers.dispose?.(); },
  };
}

function quickBar(ctx: MenuCtx): HTMLElement {
  const modeSel = h('select', { 'aria-label': 'Mode' }, ...MODE_ORDER.map((m) => h('option', { value: m }, MODES[m].label)));
  const regionSel = h('select', { 'aria-label': 'Region' },
    h('option', { value: 'auto' }, `Nearest (${REGIONS.find((r) => r.id === homeRegion())!.short})`),
    ...REGIONS.map((r) => h('option', { value: r.id }, r.label)));
  modeSel.value = ctx.quickMode();
  regionSel.value = cvars.get('qt_region');
  modeSel.addEventListener('change', () => cvars.set('qt_quickmode', modeSel.value));
  regionSel.addEventListener('change', () => cvars.set('qt_region', regionSel.value));

  const go = h('button.cta', { type: 'button' }, 'Quick play');
  go.addEventListener('click', async () => {
    go.disabled = true;
    go.textContent = 'Finding a server…';
    const res = await fetchServers({ central: ctx.deps.central, index: ctx.index() });
    go.disabled = false;
    go.textContent = 'Quick play';
    const row = quickPlay(res.rows, ctx.region(), ctx.quickMode(), ctx.index());
    if (!row) { ctx.toast(`No maps for ${MODES[ctx.quickMode()].label} in this build yet.`); return; }
    ctx.join(row.roomId, row.config, { direct: true });
  });

  const practice = h('button.ghost.small', { type: 'button' }, 'Practice offline with bots');
  practice.addEventListener('click', () => {
    const mode = ctx.quickMode() === 'duel' ? 'ffa' : ctx.quickMode();
    const c = standingConfig(ctx.region(), mode, 1, ctx.index()) ?? standingConfig(ctx.region(), 'ffa', 1)!;
    const config: RoomConfig = { ...c, name: 'Practice', standing: false, bots: true, region: null };
    ctx.play({ roomId: encodeRoomId(config), config, offline: true });
  });

  return h('section.quick', { 'aria-label': 'Quick play' }, go, modeSel, regionSel, practice);
}
