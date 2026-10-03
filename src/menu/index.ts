/**
 * The start screen. API: README.md — `showMenu(root, deps): Promise<PlayRequest>`, `hideMenu()`.
 *
 * Licence: GPL-2.0-or-later.
 */
import './menu.css';
import {
  MODES, decodeRoomId, homeRegion, isMode, isRegion, regionNodeUrl, roomFromHash, toServerinfo, passwordMatches, mapTitles,
  type Mode, type PackIndexEntry, type RegionId, type RoomConfig,
} from '../rooms/index.js';
import { account, cvars, settings, type AccountState } from '../settings/index.js';
import { h, clear } from './dom.js';
import { pixelText } from './pixelfont.js';
import type { MenuCtx, MenuDeps, PlayRequest, Screen, ScreenId } from './types.js';
import { lobbyScreen } from './lobby.js';
import { hostScreen } from './host.js';
import { playerScreen } from './player.js';
import { settingsScreen } from './settings.js';

export type { PlayRequest, MenuDeps } from './types.js';
export { account } from '../settings/index.js';
export { roomFromHash, roomLink } from '../rooms/index.js';

declare const __BUILD_REV__: string;
const REV = typeof __BUILD_REV__ === 'string' ? __BUILD_REV__ : 'dev';
/** The source this build was made from: the repo at its commit (the repo itself for a dev build). */
const SOURCE_URL = `https://github.com/m0dE/quake-town${REV === 'dev' ? '' : `/tree/${REV}`}`;

/** The top bar's buttons; the servers (the lobby) are home, and Customize opens from the character. */
const NAV: { id: ScreenId; label: string; hint: string }[] = [
  { id: 'host', label: 'Host', hint: 'Start your own server' },
  { id: 'settings', label: 'Settings', hint: 'Mouse, video, sound, keys' },
];

interface Live {
  root: HTMLElement;
  shell: HTMLElement;
  promise: Promise<PlayRequest>;
  resolve: (r: PlayRequest) => void;
  screens: Map<ScreenId, Screen>;
  current: ScreenId | null;
  cleanups: (() => void)[];
}

let live: Live | null = null;
let indexCache: PackIndexEntry[] | null = null;

async function loadIndex(deps: MenuDeps): Promise<PackIndexEntry[]> {
  if (indexCache) return indexCache;
  try {
    if (deps.packIndex) indexCache = await deps.packIndex();
    else {
      const res = await fetch(new URL('packs/index.json', document.baseURI), { cache: 'no-cache' });
      indexCache = res.ok ? ((await res.json()) as PackIndexEntry[]) : [];
    }
  } catch {
    indexCache = [];
  }
  if (!Array.isArray(indexCache)) indexCache = [];
  return indexCache;
}

export function showMenu(root: HTMLElement, deps: MenuDeps = {}): Promise<PlayRequest> {
  if (live) return live.promise;
  settings.start();
  account.start(deps.central);

  let resolve!: (r: PlayRequest) => void;
  const promise = new Promise<PlayRequest>((r) => { resolve = r; });
  let index: PackIndexEntry[] = indexCache ?? [];
  const indexListeners: (() => void)[] = [];

  const region = (): RegionId => { const r = cvars.get('qt_region'); return isRegion(r) ? r : homeRegion(); };
  const quickMode = (): Mode => { const m = cvars.get('qt_quickmode'); return isMode(m) ? m : 'ffa'; };

  const toastEl = h('div.toast', { role: 'status', 'aria-live': 'polite' });
  let toastTimer = 0;
  const toast = (text: string): void => {
    toastEl.textContent = text;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('on'), 3200);
  };

  const finish = (req: Omit<PlayRequest, 'serverinfo' | 'identity' | 'nodeUrl'>): void => {
    console.info('[menu] play', req.roomId, req.offline ? '(offline)' : '', req.spectate ? '(spectate)' : '');
    if (!live) { console.warn('[menu] play ignored: the menu is no longer live'); return; }
    const full: PlayRequest = {
      ...req,
      serverinfo: toServerinfo(req.config),
      identity: account.session(),
      ...(regionNodeUrl(req.config.region) ? { nodeUrl: regionNodeUrl(req.config.region) } : {}),
    };
    if (!full.offline) {
      try { history.replaceState(null, '', `#room=${full.roomId}`); } catch { /* sandboxed */ }
    }
    void settings.flush().catch(() => undefined);
    live.resolve(full);
  };

  const ctx: MenuCtx = {
    deps,
    index: () => index,
    onIndex: (cb) => { indexListeners.push(cb); },
    region,
    quickMode,
    join: (roomId, config, opts = {}) => openJoin(ctx, roomId, config, opts),
    play: finish,
    toast,
    go: (id) => select(id),
  };

  // ------------------------------------------------------------------ the frame
  const shell = h('div.qt-menu');
  const navEl = h('nav.nav', { 'aria-label': 'Menu' });
  const main = h('main.work');
  const noticeEl = deps.notice ? h('div.notice', { role: 'alert' }, deps.notice) : null;
  const accountEl = h('div.account');
  const back = h('button.ghost.small.back', { type: 'button', hidden: true }, '← Servers');
  back.addEventListener('click', () => select('servers'));

  const home = h('button.brand', { type: 'button', title: 'Quake Town: back to the servers' },
    pixelText('Quake Town', { px: 3, bold: true, className: 'wm-svg' }));
  home.addEventListener('click', () => select('servers'));

  const topbar = h('header.topbar', {}, home, back, h('div.top-right', {}, navEl, accountEl));

  const footer = h('footer.foot', {},
    h('a', { href: 'LICENSE.txt', target: '_blank', rel: 'noopener' }, 'Licence (GPL-2.0-or-later)'),
    h('a', { href: 'ASSET-LICENSES.txt', target: '_blank', rel: 'noopener' }, 'Art and map credits'),
    h('a', { href: SOURCE_URL, target: '_blank', rel: 'noopener' }, 'Source code'),
    h('span.rev', { title: 'Build' }, `build ${REV}`),
    h('span.tm', {}, 'Not affiliated with id Software. Game art: LibreQuake.'),
  );

  shell.append(topbar, h('div.workwrap', {}, noticeEl, main), footer, toastEl);
  clear(root);
  root.append(shell);
  root.classList.add('qt-menu-root');

  const screens = new Map<ScreenId, Screen>();
  const factories: Record<ScreenId, (c: MenuCtx) => Screen> = {
    servers: lobbyScreen, host: hostScreen, player: playerScreen, settings: settingsScreen,
  };

  live = { root, shell, promise, resolve, screens, current: null, cleanups: [] };

  for (const n of NAV) {
    const b = h('button.nav-item', { type: 'button', 'data-screen': n.id, title: n.hint }, n.label);
    b.addEventListener('click', () => select(n.id));
    navEl.append(b);
  }

  function select(id: ScreenId): void {
    if (!live) return;
    if (live.current === id) return;
    if (live.current) screens.get(live.current)?.hide?.();
    let s = screens.get(id);
    if (!s) { s = factories[id](ctx); screens.set(id, s); }
    clear(main);
    main.append(s.el);
    s.show?.();
    live.current = id;
    for (const b of navEl.querySelectorAll<HTMLElement>('.nav-item')) {
      const on = b.dataset.screen === id;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    back.hidden = id === 'servers';
    shell.dataset.screen = id;
    main.scrollTop = 0;
  }

  // ------------------------------------------------------------------ account
  const paintAccount = (s: AccountState): void => {
    clear(accountEl);
    const home = settings.status();
    if (s.status === 'signed-in' && s.session) {
      accountEl.append(
        h('span.avatar', {}, s.session.username.charAt(0).toUpperCase()),
        h('span.who', {}, h('b', {}, s.session.username),
          h('small', {}, s.note ?? (home === 'loading' ? 'Loading your settings…' : 'Signed in · settings saved'))),
        h('button.ghost.small', { type: 'button', onclick: () => void account.signOut() }, 'Sign out'),
      );
    } else if (s.status === 'signing-in') {
      accountEl.append(h('span.avatar.guest', {}, '…'), h('span.who', {}, h('b', {}, 'Signing in…'), h('small', {}, 'Finish in the window that opened')));
    } else {
      accountEl.append(
        h('span.avatar.guest', {}, cvars.get('name').charAt(0).toUpperCase() || '?'),
        h('span.who', { title: 'Sign in to keep your name and settings on every device' }, h('b', {}, cvars.get('name')),
          h('small', {}, s.note ?? 'Guest · not signed in')),
        h('button.small', { type: 'button', onclick: () => void account.signIn() }, 'Sign in with ARRR'),
      );
    }
  };
  live.cleanups.push(account.onChange(paintAccount));
  live.cleanups.push(settings.onStatus(() => paintAccount(account.state())));
  live.cleanups.push(cvars.onChange('name', () => paintAccount(account.state())));

  const onHide = (): void => { if (document.visibilityState === 'hidden') void settings.flush().catch(() => undefined); };
  document.addEventListener('visibilitychange', onHide);
  live.cleanups.push(() => document.removeEventListener('visibilitychange', onHide));

  // ------------------------------------------------------------------ go
  select('servers');
  void loadIndex(deps).then((ix) => {
    index = ix;
    for (const cb of indexListeners) { try { cb(); } catch (err) { console.error(err); } }
  });

  // a notice means we are back from a failed or ended game: do not reopen the room it was
  const fromHash = deps.notice ? null : roomFromHash(location.hash);
  if (fromHash) openJoin(ctx, fromHash.roomId, fromHash.config, {});
  else if (/^#room=/.test(location.hash)) toast('That room link is not a Quake Town room, or it is from a newer version.');

  return promise;
}

export function hideMenu(): void {
  if (!live) return;
  for (const s of live.screens.values()) { s.hide?.(); s.dispose?.(); }
  for (const c of live.cleanups) { try { c(); } catch { /* already gone */ } }
  live.shell.remove();
  live.root.classList.remove('qt-menu-root');
  live = null;
}

// ---------------------------------------------------------------------------- join dialog

function openJoin(ctx: MenuCtx, roomId: string, config: RoomConfig, opts: { spectate?: boolean; direct?: boolean }): void {
  if (opts.direct && !config.password && !config.packs.some((p) => !p.url) && !(config.mod && !config.mod.url)) {
    ctx.play({ roomId, config, spectate: opts.spectate });
    return;
  }
  const m = MODES[config.mode];
  const pw = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Password', 'aria-label': 'Password' });
  const err = h('p.err', { role: 'alert' });
  const needs = [...(config.mod ? [{ ...config.mod, what: 'Mod' }] : []), ...config.packs.map((p) => ({ ...p, what: 'Pack' }))];
  const local = needs.filter((p) => !p.url);
  const titles = mapTitles(ctx.index());

  const close = (): void => { dlg.close(); dlg.remove(); };
  const go = async (spectate: boolean): Promise<void> => {
    try {
      if (config.password) {
        if (!(await passwordMatches(config.password, pw.value))) { err.textContent = 'That password is not right.'; pw.focus(); pw.select(); return; }
      }
      close();
      ctx.play({ roomId, config, spectate, ...(config.password ? { password: pw.value } : {}) });
    } catch (e) {
      console.error('[menu] join failed', e);
      err.textContent = `Could not join: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

  const dlg = h('dialog.join', { 'aria-label': `Join ${config.name}` },
    h('form', { method: 'dialog' },
      h('header', {}, h('h3', {}, config.name)),
      h('dl.facts', {},
        h('dt', {}, 'Mode'), h('dd', {}, m.label),
        h('dt', {}, 'Maps'), h('dd', {}, config.rotation.map((n) => titles.get(n)?.title ?? n).join(', ')),
        h('dt', {}, 'Limits'), h('dd', {}, `${config.timelimit ? `${config.timelimit} min` : 'no time limit'}, ${config.fraglimit ? `${m.limitLabel.toLowerCase()} ${config.fraglimit}` : `no ${m.limitLabel.toLowerCase()}`}`),
        h('dt', {}, 'Players'), h('dd', {}, `up to ${config.maxclients}${config.bots ? ', bots fill empty slots' : ''}`),
        needs.length ? h('dt', {}, 'Needs') : null,
        needs.length ? h('dd', {}, [
          needs.length - local.length ? `${needs.length - local.length} extra ${needs.length - local.length === 1 ? 'pack' : 'packs'}, downloaded when you join` : '',
          local.length ? `${local.length} ${local.length === 1 ? 'pack' : 'packs'} from the host’s computer` : '',
        ].filter(Boolean).join('; ')) : null,
      ),
      local.length ? h('p.warn', {}, 'This room uses files the host loaded from their own computer. You can only join if you have the same files in this browser.') : null,
      config.password ? h('label.field', {}, h('span', {}, 'This server has a password'), pw) : null,
      config.password ? h('p.fine', {}, 'The password is checked in your browser. It keeps strangers out, not cheaters.') : null,
      err,
      h('div.actions', {},
        h('button.cta', { type: 'submit', value: 'play' }, 'Join game'),
        h('button.ghost', { type: 'button', value: 'spec', onclick: () => void go(true) }, 'Spectate'),
        h('button.ghost', { type: 'button', onclick: close }, 'Cancel'),
      ),
    ),
  );
  dlg.querySelector('form')!.addEventListener('submit', (e) => { e.preventDefault(); void go(!!opts.spectate); });
  dlg.addEventListener('cancel', () => dlg.remove());
  (live?.shell ?? document.body).append(dlg);
  dlg.showModal();
  if (config.password) pw.focus();
}

/** For tests and the game's ?autostart: the room the page was opened for. */
export function requestFromHash(hash = location.hash): PlayRequest | null {
  const r = roomFromHash(hash);
  if (!r) return null;
  return { roomId: r.roomId, config: r.config, serverinfo: toServerinfo(r.config), identity: account.session(), ...(regionNodeUrl(r.config.region) ? { nodeUrl: regionNodeUrl(r.config.region) } : {}) };
}

export { decodeRoomId };
