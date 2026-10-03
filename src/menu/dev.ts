/**
 * The menu on its own (no game): http://localhost:5192/src/menu/dev.html
 *   ?mock=1     fake room listing + fake id-pak loader, for screenshots and layout work
 *   ?screen=id  open a screen (servers, host, player, settings, paks)
 */
import { showMenu } from './index.js';
import { encodeRoomId, standingConfig, defaultConfig } from '../rooms/index.js';
import type { IdPakLoader } from './types.js';

const q = new URLSearchParams(location.search);
const mock = q.has('mock');

if (mock) {
  const now = Date.now();
  const iso = (minAgo: number): string => new Date(now - minAgo * 60_000).toISOString();
  const rooms = [
    { id: encodeRoomId(standingConfig('eu', 'ffa', 1)!), clientCount: 11, authorityNodeId: 'node_eu1', createdAt: iso(140) },
    { id: encodeRoomId(standingConfig('eu', 'duel', 1)!), clientCount: 2, authorityNodeId: 'node_eu1', createdAt: iso(12) },
    { id: encodeRoomId(standingConfig('na', 'ffa', 1)!), clientCount: 6, authorityNodeId: 'node_na1', createdAt: iso(55) },
    { id: encodeRoomId(standingConfig('na', '4on4', 1)!), clientCount: 5, authorityNodeId: 'node_na1', createdAt: iso(31) },
    { id: encodeRoomId(standingConfig('asia', 'ca', 1)!), clientCount: 3, authorityNodeId: 'node_as1', createdAt: iso(8) },
    { id: encodeRoomId({ ...defaultConfig('duel'), name: 'Tuesday ladder', region: 'eu', rotation: ['lqdm12', 'lqdm11'], password: { salt: '01020304', check: 'aabbccdd' } }), clientCount: 1, authorityNodeId: 'node_eu1', createdAt: iso(3) },
    { id: encodeRoomId({ ...defaultConfig('ffa'), name: 'rocket arena 24/7', region: 'na', maxclients: 12, rotation: ['lqdm7', 'lqdm3'], packs: [{ id: '3fa9c2d1e0b7', url: 'https://maps.example.org/ra.pk3' }] }), clientCount: 4, authorityNodeId: 'node_na1', createdAt: iso(400) },
    { id: encodeRoomId({ ...defaultConfig('2on2'), name: 'scrim: [hx] vs rage', region: 'eu', bots: false, rotation: ['lqdm2', 'lqdm8'] }), clientCount: 4, authorityNodeId: 'node_eu1', createdAt: iso(22) },
  ];
  const real = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/rooms/list')) return new Response(JSON.stringify({ rooms, total: rooms.length, limit: 100, offset: 0 }), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/health')) { await new Promise((r) => setTimeout(r, 20 + Math.random() * 30)); return new Response('ok'); }
    return real(input, init);
  }) as typeof fetch;
}

const idPaks: IdPakLoader | undefined = mock ? {
  async status() { return { loaded: false, files: [] }; },
  async load(files) { return { ok: true, message: `Loaded ${files.length} file(s).` }; },
  async forget() { /* nothing */ },
} : undefined;

// ?real=1: the renderer's 3D preview and the content part's id-pak loader, wired as main.ts would.
async function realDeps(): Promise<Partial<import('./types.js').MenuDeps>> {
  const { createContent } = await import('../content/index.js');
  const { renderCharacterPreview } = await import('../render/preview.js');
  const content = createContent();
  await content.loadBase();
  return {
    idPaks: content.idPaks,
    renderPreview: (canvas, look, t) => renderCharacterPreview(canvas, content.vfs, {
      model: `progs/${look.model}.mdl`, skin: Number.parseInt(look.skin, 10) || 0, top: look.topcolor, bottom: look.bottomcolor,
    }, t),
  };
}
const extra = q.has('real') ? await realDeps() : {};

const out = document.createElement('pre');
out.style.cssText = 'position:fixed;right:8px;bottom:48px;max-width:50vw;max-height:40vh;overflow:auto;background:#000c;color:#9f9;font:11px monospace;padding:8px;z-index:99;margin:0';

void showMenu(document.getElementById('app')!, { idPaks, notice: q.get('notice') ?? undefined, ...extra }).then((req) => {
  out.textContent = JSON.stringify({ ...req, identity: req.identity ? req.identity.username : null }, null, 2);
  document.body.append(out);
});

const screen = q.get('screen');
if (screen) document.querySelector<HTMLElement>(`.nav-item[data-screen="${screen}"]`)?.click();
