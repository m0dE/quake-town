/**
 * Host: build a room config, turn it into a room id, join it. The first player to join
 * creates the room (DESIGN.md "Hosting").
 *
 * Licence: GPL-2.0-or-later.
 */
import {
  MAX_CLIENTS, MAX_PACKS, MAX_ROOM_ID, MAX_ROTATION, MIN_CLIENTS, MODES, MODE_ORDER, REGIONS, RoomConfigError,
  cleanRoomName, defaultConfig, encodeRoomId, makePasswordCheck, mapTitles, roomLink,
  type Mode, type PackRef, type RoomConfig, type RegionId,
} from '../rooms/index.js';
import { cvars } from '../settings/index.js';
import { h, clear, fmtKB } from './dom.js';
import { pixelText } from './pixelfont.js';
import type { MenuCtx, Screen } from './types.js';

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface PackRow extends PackRef { label: string; bytes?: number }

export function hostScreen(ctx: MenuCtx): Screen {
  let mode: Mode = ctx.quickMode();
  let c: RoomConfig = defaultConfig(mode, { name: cleanRoomName(`${cvars.get('name')}'s server`) || 'My server', region: ctx.region() });
  let password = '';
  let mod: PackRow | null = null;
  const packs: PackRow[] = [];
  let builtId: string | null = null;
  let hooked = false;

  // ------------------------------------------------------------------ fields
  const name = h('input', { type: 'text', maxlength: '40', value: c.name, 'aria-label': 'Server name' });
  name.addEventListener('input', () => { c.name = cleanRoomName(name.value); update(); });

  const modes = h('div.seg', { role: 'radiogroup', 'aria-label': 'Mode' });
  const modeBlurb = h('p.fine');
  for (const m of MODE_ORDER) {
    const b = h('button.seg-btn', { type: 'button', role: 'radio', 'data-mode': m }, MODES[m].label);
    b.addEventListener('click', () => setMode(m));
    modes.append(b);
  }

  const region = h('select', { 'aria-label': 'Region' }, h('option', { value: '' }, 'No region'), ...REGIONS.map((r) => h('option', { value: r.id }, r.label)));
  region.value = c.region ?? '';
  region.addEventListener('change', () => { c.region = (region.value || null) as RegionId | null; update(); });

  const num = (min: number, max: number, label: string): HTMLInputElement => h('input', { type: 'number', min: String(min), max: String(max), step: '1', inputmode: 'numeric', 'aria-label': label });
  const maxP = num(MIN_CLIENTS, MAX_CLIENTS, 'Max players');
  const tl = num(0, 255, 'Time limit');
  const fl = num(0, 9999, 'Limit');
  const flLabel = h('span');
  const bots = h('input', { type: 'checkbox' });
  maxP.addEventListener('input', () => { c.maxclients = clampInt(maxP.value, MIN_CLIENTS, MAX_CLIENTS); update(); });
  tl.addEventListener('input', () => { c.timelimit = clampInt(tl.value, 0, 255); update(); });
  fl.addEventListener('input', () => { c.fraglimit = clampInt(fl.value, 0, 9999); update(); });
  bots.addEventListener('change', () => { c.bots = bots.checked; update(); });

  const pw = h('input', { type: 'text', autocomplete: 'off', placeholder: 'Leave empty for a public server', 'aria-label': 'Password', maxlength: '32' });
  pw.addEventListener('input', () => { password = pw.value; update(); });

  // ------------------------------------------------------------------ maps
  const rotList = h('ol.rotation', { 'aria-label': 'Map rotation' });
  const avail = h('div.maplist', { role: 'list', 'aria-label': 'Maps' });
  const customMap = h('input', { type: 'text', placeholder: 'Map from a pack, e.g. aerowalk', 'aria-label': 'Map name', spellcheck: 'false' });
  const customAdd = h('button.ghost.small', { type: 'button' }, 'Add');
  customAdd.addEventListener('click', () => {
    const m = customMap.value.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(m)) { ctx.toast('Map names are letters, digits, _ and -, as in the pack (maps/<name>.bsp).'); return; }
    addMap(m);
    customMap.value = '';
  });

  function addMap(m: string): void {
    if (c.rotation.length >= MAX_ROTATION) { ctx.toast(`A rotation holds ${MAX_ROTATION} maps.`); return; }
    c.rotation.push(m);
    update();
  }

  function paintMaps(): void {
    const titles = mapTitles(ctx.index());
    clear(rotList);
    c.rotation.forEach((m, i) => {
      const up = h('button.icon', { type: 'button', title: 'Earlier', 'aria-label': `Move ${m} earlier`, disabled: i === 0 }, '↑');
      const down = h('button.icon', { type: 'button', title: 'Later', 'aria-label': `Move ${m} later`, disabled: i === c.rotation.length - 1 }, '↓');
      const rm = h('button.icon', { type: 'button', title: 'Remove', 'aria-label': `Remove ${m}` }, '×');
      up.addEventListener('click', () => { [c.rotation[i - 1], c.rotation[i]] = [c.rotation[i], c.rotation[i - 1]]; update(); });
      down.addEventListener('click', () => { [c.rotation[i + 1], c.rotation[i]] = [c.rotation[i], c.rotation[i + 1]]; update(); });
      rm.addEventListener('click', () => { c.rotation.splice(i, 1); update(); });
      rotList.append(h('li', {}, h('span.rname', {}, h('b', {}, titles.get(m)?.title ?? m), h('small', {}, m)), h('span.rbtn', {}, up, down, rm)));
    });
    if (!c.rotation.length) rotList.append(h('li.none', {}, 'Add at least one map.'));

    clear(avail);
    const all = [...titles.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const m of all) {
      const suits = !m.modes?.length || m.modes.includes(mode);
      const b = h('button.mapbtn', { type: 'button', role: 'listitem', class: suits ? '' : 'off', title: `${m.title ?? m.name}${m.author ? ` by ${m.author}` : ''}${m.modes?.length ? `. Made for ${m.modes.join(', ')}` : ''}` },
        h('b', {}, m.title ?? m.name), h('small', {}, m.name), c.rotation.includes(m.name) ? h('i', {}, 'in rotation') : null);
      b.addEventListener('click', () => addMap(m.name));
      avail.append(b);
    }
  }

  // ------------------------------------------------------------------ mod + packs
  const modSel = h('select', { 'aria-label': 'Mod' });
  const modOther = h('div.packadd', { hidden: true });
  const modUrl = h('input', { type: 'url', placeholder: 'https://… .pk3 (must allow cross-site downloads)', 'aria-label': 'Mod link' });
  const modFetch = h('button.small', { type: 'button' }, 'Check link');
  modOther.append(modUrl, modFetch);
  modFetch.addEventListener('click', async () => {
    const r = await fromUrl(modUrl.value.trim());
    if (r) { mod = r; update(); }
  });
  modSel.addEventListener('change', () => {
    const v = modSel.value;
    modOther.hidden = v !== 'other';
    if (v === 'qtdm' || v === 'other') mod = null;
    else {
      const p = ctx.index().find((x) => x.id === v);
      mod = p ? { id: p.id.slice(0, 12), label: p.name, bytes: p.bytes } : null;
    }
    update();
  });
  function paintMods(): void {
    const keep = modSel.value || 'qtdm';
    clear(modSel);
    modSel.append(h('option', { value: 'qtdm' }, 'Quake Town deathmatch (built in)'));
    for (const p of ctx.index()) if (p.kind === 'mod' && p.name !== 'qtdm') modSel.append(h('option', { value: p.id }, p.name));
    modSel.append(h('option', { value: 'other' }, 'Another mod, by link…'));
    modSel.value = [...modSel.options].some((o) => o.value === keep) ? keep : 'qtdm';
  }

  const packList = h('ul.packs');
  const packUrl = h('input', { type: 'url', placeholder: 'https://example.org/maps.pk3', 'aria-label': 'Pack link' });
  const packAdd = h('button.small', { type: 'button' }, 'Add link');
  const packFile = h('input', { type: 'file', accept: '.pk3,.pak,.zip', hidden: true });
  const packFileBtn = h('button.ghost.small', { type: 'button' }, 'Add a file from this computer');
  packFileBtn.addEventListener('click', () => packFile.click());
  packAdd.addEventListener('click', async () => {
    if (packs.length >= MAX_PACKS) { ctx.toast(`At most ${MAX_PACKS} extra packs.`); return; }
    const r = await fromUrl(packUrl.value.trim());
    if (r) { packs.push(r); packUrl.value = ''; update(); }
  });
  packFile.addEventListener('change', async () => {
    const file = packFile.files?.[0];
    packFile.value = '';
    if (!file) return;
    if (file.size > 64 * 1024 * 1024) { ctx.toast('A pack can be at most 64 MB.'); return; }
    try {
      let id: string;
      if (ctx.deps.cacheLocalPack) id = (await ctx.deps.cacheLocalPack(file)).id;
      else id = await sha256Hex(await file.arrayBuffer());
      packs.push({ id: id.slice(0, 12), label: file.name, bytes: file.size });
      update();
    } catch (err) {
      ctx.toast(`Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  async function fromUrl(url: string): Promise<PackRow | null> {
    if (!/^https:\/\/\S+$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
      ctx.toast('Use an https:// link to the .pk3 or .pak file.');
      return null;
    }
    ctx.toast('Downloading to check it…');
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 64 * 1024 * 1024) throw new Error('it is over 64 MB');
      const id = await sha256Hex(buf);
      ctx.toast(`Added: ${fmtKB(buf.byteLength)}, fingerprint ${id.slice(0, 12)}.`);
      return { id: id.slice(0, 12), url, label: url.split('/').pop() || url, bytes: buf.byteLength };
    } catch (err) {
      ctx.toast(`That link did not work (${err instanceof Error ? err.message : String(err)}). The host must allow cross-site downloads (CORS).`);
      return null;
    }
  }

  function paintPacks(): void {
    clear(packList);
    packs.forEach((p, i) => {
      const rm = h('button.icon', { type: 'button', 'aria-label': `Remove ${p.label}` }, '×');
      rm.addEventListener('click', () => { packs.splice(i, 1); update(); });
      packList.append(h('li', {}, h('b', {}, p.label), h('small', {}, `${p.id}${p.bytes ? `, ${fmtKB(p.bytes)}` : ''}${p.url ? '' : ', from your computer: players need the same file'}`), rm));
    });
    if (mod) packList.prepend(h('li.modrow', {}, h('b', {}, `Mod: ${mod.label}`), h('small', {}, mod.id)));
  }

  // ------------------------------------------------------------------ result
  const codeOut = h('code.roomcode', { 'aria-label': 'Room code' });
  const meter = h('span.meter');
  const err = h('p.err', { role: 'alert' });
  const start = h('button.cta.big', { type: 'button' }, 'Start server');
  const copy = h('button.ghost', { type: 'button' }, 'Copy invite link');
  start.addEventListener('click', () => void build().then((r) => { if (r) ctx.play({ roomId: r.id, config: r.config, ...(password ? { password } : {}) }); }));
  copy.addEventListener('click', () => void build().then(async (r) => {
    if (!r) return;
    try { await navigator.clipboard.writeText(roomLink(r.id)); ctx.toast('Invite link copied.'); } catch { ctx.toast(roomLink(r.id)); }
  }));

  async function build(): Promise<{ id: string; config: RoomConfig } | null> {
    const cfg: RoomConfig = {
      ...c, rotation: [...c.rotation], mod: mod ? { id: mod.id, ...(mod.url ? { url: mod.url } : {}) } : null,
      packs: packs.map((p) => ({ id: p.id, ...(p.url ? { url: p.url } : {}) })),
      password: password ? await makePasswordCheck(password) : null,
    };
    try {
      const id = encodeRoomId(cfg);
      err.textContent = '';
      return { id, config: cfg };
    } catch (e) {
      err.textContent = e instanceof RoomConfigError ? e.message : String(e);
      return null;
    }
  }

  function update(): void {
    for (const b of modes.querySelectorAll<HTMLElement>('.seg-btn')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    modeBlurb.textContent = MODES[mode].blurb;
    flLabel.textContent = MODES[mode].limitLabel;
    if (document.activeElement !== maxP) maxP.value = String(c.maxclients);
    if (document.activeElement !== tl) tl.value = String(c.timelimit);
    if (document.activeElement !== fl) fl.value = String(c.fraglimit);
    bots.checked = c.bots;
    paintMaps();
    paintPacks();
    // A preview id with a fixed salt, so the code does not flicker while typing; Start makes a fresh salt.
    const preview: RoomConfig = { ...c, mod: mod ? { id: mod.id, ...(mod.url ? { url: mod.url } : {}) } : null, packs: packs.map((p) => ({ id: p.id, ...(p.url ? { url: p.url } : {}) })), password: password ? { salt: '00000000', check: '00000000' } : null };
    try {
      builtId = encodeRoomId(preview);
      codeOut.textContent = builtId;
      meter.textContent = `${builtId.length} / ${MAX_ROOM_ID} characters`;
      meter.classList.remove('bad');
      err.textContent = '';
      start.disabled = false;
    } catch (e) {
      builtId = null;
      codeOut.textContent = '—';
      meter.textContent = '';
      err.textContent = e instanceof RoomConfigError ? e.message : String(e);
      start.disabled = true;
    }
  }

  function setMode(m: Mode): void {
    mode = m;
    const d = defaultConfig(m);
    c = { ...c, mode: m, timelimit: d.timelimit, fraglimit: d.fraglimit, maxclients: d.maxclients, bots: d.bots, rotation: d.rotation.length ? d.rotation : c.rotation };
    update();
  }

  const field = (label: string | HTMLElement, input: HTMLElement, hint?: string): HTMLElement =>
    h('label.field', {}, h('span', {}, label), input, hint ? h('small', {}, hint) : null);

  const el = h('section.screen.host', { 'aria-labelledby': 'host-title' },
    h('div.screen-head', {}, h('h2#host-title', {}, pixelText('Host a server', { px: 4, bold: true }))),
    h('div.host-grid', {},
      h('div.col', {},
        field('Server name', name),
        h('div.field', {}, h('span', {}, 'Mode'), modes, modeBlurb),
        h('div.row3', {},
          field('Max players', maxP),
          field('Time limit (min)', tl, '0 = none'),
          field(flLabel, fl, '0 = none'),
        ),
        h('div.row2', {},
          field('Region', region, 'Where it is listed'),
          h('label.field.check', {}, bots, h('span', {}, 'Bots fill empty slots')),
        ),
        field('Password', pw, 'Checked in each player’s browser: it keeps strangers out, not cheaters.'),
        h('div.field', {}, h('span', {}, 'Mod'), modSel, modOther),
        h('div.field', {}, h('span', {}, 'Extra packs (maps, models, sounds)'),
          packList, h('div.packadd', {}, packUrl, packAdd), packFileBtn, packFile),
      ),
      h('div.col', {},
        h('div.field', {}, h('span', {}, 'Rotation, in order'), rotList),
        h('div.field', {}, h('span', {}, 'Maps (click to add)'), avail, h('div.packadd', {}, customMap, customAdd)),
      ),
    ),
    h('div.host-foot', {},
      h('div.codebox', {}, h('span', {}, 'Room code'), codeOut, meter, err),
      h('div.d-act', {}, start, copy),
    ),
  );

  return {
    el,
    show() {
      paintMods();
      update();
      if (!hooked) { hooked = true; ctx.onIndex(() => { paintMods(); update(); }); }
    },
  };
}

function clampInt(v: string, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}
