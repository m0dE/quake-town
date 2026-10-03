/**
 * The server browser: every Quake Town room central knows, the standing servers, and
 * your favourites; filters, sort by any column, refresh, double-click (or Enter) to join,
 * join by room code or link.
 *
 * Licence: GPL-2.0-or-later.
 */
import {
  MODES, MODE_ORDER, REGIONS, botsEstimate, decodeRoomId, favourites, fetchServers, formatAge, isFavourite,
  mapTitles, pingFor, pingText, roomFromHash, roomLink, toggleFavourite, regionOf,
  type Mode, type Ping, type ServerRow,
} from '../rooms/index.js';
import { h, clear } from './dom.js';
import { pixelText } from './pixelfont.js';
import type { MenuCtx, Screen } from './types.js';

const REFRESH_SECONDS = 20;

type SortKey = 'best' | 'name' | 'mode' | 'map' | 'players' | 'ping' | 'mod';

interface Filters {
  text: string;
  mode: Mode | 'all';
  region: string;
  hideFull: boolean;
  hideEmpty: boolean;
  hidePassword: boolean;
  favsOnly: boolean;
}

export function serversScreen(ctx: MenuCtx): Screen {
  let rows: ServerRow[] = [];
  let offline = false;
  let updatedAt = 0;
  let busy = false;
  let timer = 0;
  let ageTimer = 0;
  let indexHooked = false;
  let selected: string | null = null;
  let sort: SortKey = 'best';
  let desc = true;
  const pings = new Map<string, Ping | null>();
  const f: Filters = { text: '', mode: 'all', region: 'all', hideFull: false, hideEmpty: false, hidePassword: false, favsOnly: false };

  // ------------------------------------------------------------------ toolbar
  const search = h('input.search', { type: 'search', placeholder: 'Search servers and maps', 'aria-label': 'Search servers' });
  search.addEventListener('input', () => { f.text = search.value.trim().toLowerCase(); render(); });

  const chips = h('div.chips', { role: 'radiogroup', 'aria-label': 'Mode' });
  const chip = (id: Mode | 'all', label: string): HTMLButtonElement => {
    const b = h('button.chip', { type: 'button', role: 'radio', 'aria-checked': String(f.mode === id) }, label);
    b.addEventListener('click', () => {
      f.mode = id;
      for (const c of chips.children) c.setAttribute('aria-checked', String(c === b));
      render();
    });
    return b;
  };
  chips.append(chip('all', 'All'), ...MODE_ORDER.map((m) => chip(m, MODES[m].short)));

  const regionSel = h('select', { 'aria-label': 'Region' }, h('option', { value: 'all' }, 'All regions'),
    ...REGIONS.map((r) => h('option', { value: r.id }, r.label)), h('option', { value: 'none' }, 'No region'));
  regionSel.addEventListener('change', () => { f.region = regionSel.value; render(); });

  const toggle = (label: string, key: 'hideFull' | 'hideEmpty' | 'hidePassword' | 'favsOnly'): HTMLElement => {
    const cb = h('input', { type: 'checkbox' });
    cb.addEventListener('change', () => { f[key] = cb.checked; render(); });
    return h('label.tog', {}, cb, h('span', {}, label));
  };

  const refreshBtn = h('button.ghost.small', { type: 'button', title: 'Refresh the list' }, 'Refresh');
  refreshBtn.addEventListener('click', () => void refresh());
  const status = h('span.list-status', { 'aria-live': 'polite' });

  const code = h('input.code', { type: 'text', placeholder: 'Paste a room link or code', 'aria-label': 'Room link or code', spellcheck: 'false' });
  const codeGo = h('button.small', { type: 'submit' }, 'Join');
  const codeForm = h('form.joincode', {}, code, codeGo);
  codeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = code.value.trim();
    let id = raw;
    try { if (/^https?:/.test(raw)) id = roomFromHash(new URL(raw).hash)?.roomId ?? ''; } catch { id = ''; }
    const c = decodeRoomId(id);
    if (!c) { ctx.toast('That is not a Quake Town room code. Codes start with qt1.'); return; }
    ctx.join(id, c);
  });

  // ------------------------------------------------------------------ table
  const cols: { key: SortKey; label: string; cls: string }[] = [
    { key: 'name', label: 'Server', cls: 'c-name' },
    { key: 'mode', label: 'Mode', cls: 'c-mode' },
    { key: 'map', label: 'Map', cls: 'c-map' },
    { key: 'players', label: 'Players', cls: 'c-pl' },
    { key: 'ping', label: 'Ping', cls: 'c-ping' },
    { key: 'mod', label: 'Mod', cls: 'c-mod' },
  ];
  const head = h('div.srow.shead', { role: 'row' },
    h('span.c-fav', { role: 'columnheader' }, h('span.sr', {}, 'Favourite')),
    ...cols.map((c) => {
      const b = h('button.sort', { type: 'button', 'data-key': c.key }, c.label);
      b.addEventListener('click', () => {
        if (sort === c.key) desc = !desc; else { sort = c.key; desc = c.key === 'players'; }
        render();
      });
      return h(`span.${c.cls}`, { role: 'columnheader' }, b);
    }),
  );
  const body = h('div.sbody', { role: 'rowgroup' });
  const table = h('div.stable', { role: 'table', 'aria-label': 'Servers' }, head, body);
  const detail = h('div.detail', { 'aria-live': 'polite' });

  body.addEventListener('click', (e) => {
    const t = e.target as Element;
    const row = t.closest<HTMLElement>('[data-room]');
    if (!row) return;
    if (t.closest('.fav')) {
      const on = toggleFavourite(row.dataset.room!);
      ctx.toast(on ? 'Added to favourites.' : 'Removed from favourites.');
      render();
      return;
    }
    selected = row.dataset.room!;
    render();
  });
  body.addEventListener('dblclick', (e) => {
    const row = (e.target as Element).closest<HTMLElement>('[data-room]');
    if (row && !(e.target as Element).closest('.fav')) joinRow(row.dataset.room!);
  });
  body.addEventListener('keydown', (e) => {
    const row = (e.target as Element).closest<HTMLElement>('[data-room]');
    if (!row) return;
    if (e.key === 'Enter') { e.preventDefault(); joinRow(row.dataset.room!); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const sib = (e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
      if (sib?.dataset.room) { selected = sib.dataset.room; render(); (body.querySelector(`[data-room="${CSS.escape(selected)}"]`) as HTMLElement | null)?.focus(); }
    } else if (e.key === ' ') { e.preventDefault(); selected = row.dataset.room!; render(); }
  });

  const joinRow = (id: string, spectate = false): void => {
    const r = shownRows().find((x) => x.roomId === id);
    if (r) ctx.join(r.roomId, r.config, { spectate, direct: true });
  };

  const el = h('section.screen.servers', { 'aria-labelledby': 'srv-title' },
    h('div.screen-head', {},
      h('h2#srv-title', {}, pixelText('Servers', { px: 4, bold: true })),
      h('div.head-tools', {}, status, refreshBtn),
    ),
    h('div.toolbar', {}, search, chips),
    h('div.toolbar.sub', {}, regionSel, toggle('Hide full', 'hideFull'), toggle('Hide empty', 'hideEmpty'),
      toggle('No password', 'hidePassword'), toggle('Favourites', 'favsOnly'), codeForm),
    table,
    detail,
  );

  // ------------------------------------------------------------------ data
  function shownRows(): ServerRow[] {
    // Favourites the listing does not have (an empty custom room) are still rows: the id is the config.
    const have = new Set(rows.map((r) => r.roomId));
    const extra: ServerRow[] = [];
    for (const id of favourites()) {
      if (have.has(id)) continue;
      const c = decodeRoomId(id);
      if (c) extra.push({ roomId: id, config: c, humans: 0, bots: botsEstimate(c, 0), live: false, node: null, ageSeconds: null, standingIndex: 0 });
    }
    return [...rows, ...extra];
  }

  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    refreshBtn.disabled = true;
    if (!rows.length) status.textContent = 'Looking for servers…';
    const res = await fetchServers({ central: ctx.deps.central, index: ctx.index() });
    busy = false;
    refreshBtn.disabled = false;
    rows = res.rows;
    offline = !res.ok;
    updatedAt = Date.now();
    render();
    measurePings();
  }

  function measurePings(): void {
    for (const r of shownRows()) {
      const key = `${r.node ?? ''}|${r.config.region ?? ''}`;
      if (pings.has(key)) continue;
      pings.set(key, null);
      void pingFor({ node: r.node, region: r.config.region }, ctx.deps.central).then((p) => { pings.set(key, p); render(); });
    }
  }
  const pingOf = (r: ServerRow): Ping | null => pings.get(`${r.node ?? ''}|${r.config.region ?? ''}`) ?? null;

  function paintStatus(): void {
    if (busy && !rows.length) return;
    const s = Math.round((Date.now() - updatedAt) / 1000);
    status.textContent = offline
      ? 'The server list is not answering. Standing servers still work.'
      : `Updated ${s < 5 ? 'just now' : `${s}s ago`}`;
    status.classList.toggle('bad', offline);
  }

  // ------------------------------------------------------------------ render
  const titles = (): Map<string, { title?: string }> => mapTitles(ctx.index());
  const modName = (r: ServerRow): string => {
    if (!r.config.mod) return 'qtdm';
    const p = ctx.index().find((x) => x.id.startsWith(r.config.mod!.id));
    return p?.name ?? r.config.mod.id.slice(0, 8);
  };

  function filtered(): ServerRow[] {
    const home = ctx.region();
    const favs = new Set(favourites());
    const t = titles();
    let list = shownRows().filter((r) => {
      const c = r.config;
      if (f.mode !== 'all' && c.mode !== f.mode) return false;
      if (f.region === 'none' ? c.region !== null : f.region !== 'all' && c.region !== f.region) return false;
      if (f.hideFull && r.humans >= c.maxclients) return false;
      if (f.hideEmpty && r.humans === 0) return false;
      if (f.hidePassword && c.password) return false;
      if (f.favsOnly && !favs.has(r.roomId)) return false;
      if (f.text) {
        const hay = `${c.name} ${c.rotation.join(' ')} ${c.rotation.map((m) => t.get(m)?.title ?? '').join(' ')} ${MODES[c.mode].label}`.toLowerCase();
        if (!hay.includes(f.text)) return false;
      }
      return true;
    });
    const dir = desc ? -1 : 1;
    const ping = (r: ServerRow): number => pingOf(r)?.ms ?? 1e9;
    const by: Record<SortKey, (a: ServerRow, b: ServerRow) => number> = {
      best: (a, b) => Number(favs.has(b.roomId)) - Number(favs.has(a.roomId))
        || Number(b.config.region === home) - Number(a.config.region === home)
        || b.humans - a.humans
        || Number(b.config.standing) - Number(a.config.standing)
        || MODE_ORDER.indexOf(a.config.mode) - MODE_ORDER.indexOf(b.config.mode)
        || REGIONS.findIndex((x) => x.id === a.config.region) - REGIONS.findIndex((x) => x.id === b.config.region)
        || a.standingIndex - b.standingIndex
        || a.config.name.localeCompare(b.config.name),
      name: (a, b) => dir * -a.config.name.localeCompare(b.config.name),
      mode: (a, b) => dir * (MODE_ORDER.indexOf(b.config.mode) - MODE_ORDER.indexOf(a.config.mode)),
      map: (a, b) => dir * -a.config.rotation[0].localeCompare(b.config.rotation[0]),
      players: (a, b) => dir * (a.humans - b.humans) || dir * (a.bots - b.bots),
      ping: (a, b) => dir * (ping(a) - ping(b)),
      mod: (a, b) => dir * -modName(a).localeCompare(modName(b)),
    };
    list = list.sort(by[sort]);
    return list;
  }

  function render(): void {
    paintStatus();
    for (const b of head.querySelectorAll<HTMLElement>('.sort')) {
      const on = b.dataset.key === sort;
      b.classList.toggle('on', on);
      b.parentElement!.setAttribute('aria-sort', on ? (desc ? 'descending' : 'ascending') : 'none');
      b.dataset.dir = on ? (desc ? '▼' : '▲') : '';
    }
    const list = filtered();
    const t = titles();
    const favs = new Set(favourites());
    const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.room;
    clear(body);
    if (!list.length) {
      body.append(h('div.empty', {}, rows.length
        ? 'No server matches these filters. Clear a filter, or host one yourself.'
        : 'Looking for servers…'));
    }
    for (const r of list) {
      const c = r.config;
      const full = r.humans >= c.maxclients;
      const map = c.rotation[0];
      const p = pingOf(r);
      const row = h('div.srow', {
        role: 'row', tabindex: '0', 'data-room': r.roomId, 'aria-selected': String(r.roomId === selected),
        class: [r.humans ? 'busy' : 'quiet', full ? 'full' : ''].join(' ').trim(),
      },
        h('span.c-fav', { role: 'cell' }, h('button.fav', { type: 'button', 'aria-pressed': String(favs.has(r.roomId)), title: favs.has(r.roomId) ? 'Remove from favourites' : 'Add to favourites' }, favs.has(r.roomId) ? '★' : '☆')),
        h('span.c-name', { role: 'cell' },
          h('b', {}, c.name),
          c.password ? h('i.lock', { title: 'Password' }, 'locked') : null,
          c.region && !c.name.startsWith(`${regionOf(c.region).short} `) ? h('i.reg', { title: regionOf(c.region).label }, regionOf(c.region).short) : null,
        ),
        h('span.c-mode', { role: 'cell' }, MODES[c.mode].short),
        h('span.c-map', { role: 'cell', title: c.rotation.map((m) => t.get(m)?.title ?? m).join(' → ') },
          h('b', {}, map), h('small', {}, t.get(map)?.title ?? '')),
        h('span.c-pl', { role: 'cell' },
          h('b', {}, `${r.humans}`), h('span.max', {}, `/${c.maxclients}`),
          r.bots ? h('small', { title: 'Empty slots are played by bots' }, `+${r.bots} bots`) : null,
          h('i.fill', { style: `--h:${Math.min(100, (r.humans / c.maxclients) * 100)}%;--b:${Math.min(100, ((r.humans + r.bots) / c.maxclients) * 100)}%` })),
        h('span.c-ping', {
          role: 'cell',
          class: !p ? '' : p.ms < 60 ? 'good' : p.ms < 120 ? 'ok' : 'bad',
          title: !p ? 'Not measured' : p.kind === 'known' ? 'Measured when you last played on this server’s machine' : p.kind === 'region' ? 'Round trip to this region’s server machine' : 'Round trip to the network. This room’s machine is not known until you join.',
        }, pingText(p)),
        h('span.c-mod', { role: 'cell' }, modName(r)),
      );
      body.append(row);
    }
    if (focusedId) (body.querySelector(`[data-room="${CSS.escape(focusedId)}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
    paintDetail(list);
    // On a phone the details open under the tapped row, not at the foot of a long list.
    const sel = selected ? body.querySelector<HTMLElement>(`[data-room="${CSS.escape(selected)}"]`) : null;
    if (sel && matchMedia('(max-width: 760px)').matches) sel.after(detail);
    else if (detail.parentElement !== el) table.after(detail);
  }

  function paintDetail(list: ServerRow[]): void {
    clear(detail);
    const r = list.find((x) => x.roomId === selected);
    if (!r) {
      detail.append(h('p.hint', {}, matchMedia('(pointer: coarse)').matches ? 'Tap a server to see its maps, then join.' : 'Double-click a server to join. Select one to see its maps and share it.'));
      return;
    }
    const c = r.config;
    const m = MODES[c.mode];
    const t = titles();
    const copy = h('button.ghost.small', { type: 'button' }, 'Copy link');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(roomLink(r.roomId)); ctx.toast('Link copied. Anyone with it joins this server.'); } catch { ctx.toast(roomLink(r.roomId)); }
    });
    const join = h('button.cta', { type: 'button' }, 'Join game');
    join.addEventListener('click', () => joinRow(r.roomId));
    const spec = h('button.ghost', { type: 'button' }, 'Spectate');
    spec.addEventListener('click', () => joinRow(r.roomId, true));
    detail.append(
      h('div.d-main', {},
        h('h3', {}, c.name),
        h('p.d-sub', {}, `${m.label}. ${c.timelimit ? `${c.timelimit} minutes` : 'No time limit'}, ${c.fraglimit ? `${m.limitLabel.toLowerCase()} ${c.fraglimit}` : `no ${m.limitLabel.toLowerCase()}`}. ${r.live ? `Open for ${formatAge(r.ageSeconds)}.` : 'Nobody is here yet: joining starts it.'}`),
        h('ol.rot', { 'aria-label': 'Map rotation' }, ...c.rotation.map((name) => h('li', {}, h('b', {}, t.get(name)?.title ?? name), h('small', {}, name)))),
      ),
      h('div.d-act', {}, join, spec, copy),
    );
  }

  return {
    el,
    show() {
      void refresh();
      clearInterval(timer);
      timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, REFRESH_SECONDS * 1000);
      clearInterval(ageTimer);
      ageTimer = window.setInterval(paintStatus, 5000);
      if (!indexHooked) { indexHooked = true; ctx.onIndex(() => void refresh()); }
    },
    hide() { clearInterval(timer); clearInterval(ageTimer); },
  };
}

export { isFavourite };
