// Quake Town — multiplayer lockstep test on the local arrr cluster (one headless Chromium,
// 2-3 pages), scripted inputs for 2+ minutes, zero-desync assertion, numbers.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
//
//   cd ../arrr-mono && E2E_EXTRA_PORTS=0 node e2e/cluster.js &        (central :9201, nodes :8201/:8202)
//   APP=qt-$(date +%s); curl -XPOST -H 'content-type: application/json' -d '{"fps":77}' \
//        localhost:9201/api/apps/$APP/rooms/probe/connect                # the app, at 77 Hz
//   node tools/test/multiplayer.mjs --app=$APP [--pages=3] [--secs=150] [--max=4] [--bots=0]
//
// Asserts: every page's lockstep reports 0 desyncs, and all pages hash the same at common
// frames. Prints per page: fps, sim µs/tick, rollbacks, mispredictions, starvations, tick
// arrival stats; screenshots into docs/shots/game/.
import { chromium } from '/app/data/home/arrr-mono/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';
import { connect } from 'arrr-network';

/** A silent member in Node: records when each tick arrives (the node's timer, off the browser's main thread). */
async function tickProbe(roomId) {
  const at = [];
  let fps = 0;
  const conn = await connect(roomId, {
    appId: APP, centralServiceUrl: CENTRAL, fps: 77, user: { id: `tickprobe${Date.now()}` },
    onConnect: (_s, _i, _f, _n, f) => { fps = f; },
    onTick: (frame) => { at.push([frame, performance.now()]); },
    onDisconnect: () => {}, onError: () => {},
  });
  return {
    stop() { try { conn.leaveRoom(); } catch { /* gone */ } },
    stats() {
      const iv = [];
      for (let i = 1; i < at.length; i++) if (at[i][0] === at[i - 1][0] + 1) iv.push(at[i][1] - at[i - 1][1]);
      if (iv.length < 10) return null;
      const sorted = [...iv].sort((a, b) => a - b);
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
      const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
      const sd = Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / iv.length);
      const span = at[at.length - 1][1] - at[0][1], frames = at[at.length - 1][0] - at[0][0];
      return { nodeFps: fps, ticks: at.length, hz: +(frames * 1000 / span).toFixed(2), meanMs: +mean.toFixed(3), sdMs: +sd.toFixed(3), p50: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), p99: +q(0.99).toFixed(2), p999: +q(0.999).toFixed(2), maxMs: +sorted[sorted.length - 1].toFixed(2), over26ms: iv.filter((x) => x > 26).length, over39ms: iv.filter((x) => x > 39).length, gaps: at.length - 1 - iv.length };
    },
  };
}

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const BASE = arg('url', 'http://localhost:5191/');
const APP = arg('app', process.env.APP ?? '');
const PAGES = Number(arg('pages', '3'));
const SECS = Number(arg('secs', '150'));
const MAX = arg('max', '4');
const BOTS = arg('bots', '0');
const MAP = arg('map', 'qt_aero');
// 3D costs swiftshader seconds per frame on a loaded box; the netcode is the same either way
const RENDERER = arg('renderer', 'topdown');
const CENTRAL = arg('central', 'http://localhost:9201');
const ROOM = arg('room', `mp${Date.now().toString(36)}`);
const OUT = 'docs/shots/game';
if (!APP) { console.error('--app=<app id created at 77 fps> is required'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const errors = [];
const pages = [];
try {
  for (let i = 0; i < PAGES; i++) {
    const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`p${i} pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404|cloud\.arrr/.test(m.text())) errors.push(`p${i} console: ${m.text().slice(0, 200)}`); });
    const url = `${BASE}?room=${ROOM}&central=${encodeURIComponent(CENTRAL)}&app=${APP}&test=1&name=player${i}&maxclients=${MAX}&bots=${BOTS}&map=${MAP}${RENDERER === '3d' ? '' : `&renderer=${RENDERER}`}`;
    await page.goto(url);
    pages.push(page);
    console.log(`p${i} ${url}`);
    await page.waitForTimeout(1500);
  }
  for (const [i, p] of pages.entries()) {
    await p.waitForFunction(() => window.__game && window.__game.debug().slot >= 0, null, { timeout: 400_000, polling: 1000 });
    console.log(`p${i} joined, slot ${await p.evaluate(() => window.__game.debug().slot)}`);
  }
  const roomId = await pages[0].evaluate(() => window.__game.session.roomId);
  const probe = await tickProbe(roomId).catch((e) => { console.log('tick probe failed:', e.message); return null; });
  const t0 = Date.now();
  let lastLog = 0;
  let shots = 0;
  const hashChecks = { compared: 0, agreed: 0, mismatches: [] };
  while (Date.now() - t0 < SECS * 1000) {
    const k = (Date.now() - t0) / 1000;
    await Promise.all(pages.map((p, i) => p.evaluate(([k, i]) => {
      const g = window.__game;
      if (!g) return;
      g.testHold('forward', Math.floor(k / 3 + i) % 4 !== 3);
      g.testHold('moveleft', Math.floor(k * 2 + i) % 5 === 0);
      g.testHold('moveright', Math.floor(k * 2 + i) % 5 === 2);
      g.testHold('attack', Math.floor(k * 1.5 + i) % 3 === 0);
      g.testHold('jump', Math.floor(k * 4 + i) % 3 === 0);
      g.testLook(Math.sin(k * 0.5 + i) * 15, (k * (30 + i * 11) + i * 120) % 360);
      if (Math.floor(k) % 7 === i) g.testImpulse(7);
    }, [k, i]).catch(() => {})));
    if (k - lastLog >= 10) {
      lastLog = k;
      const ds = await Promise.all(pages.map((p) => p.evaluate(() => ({ d: window.__game.debug(), t: window.__game.totals() }))));
      // hashes at a frame every page has confirmed
      const common = (Math.min(...ds.map((x) => x.t.frame)) - 8) & ~3;   // a multiple of 4 works for any HASH_EVERY in 1, 2, 4
      const hs = await Promise.all(pages.map((p) => p.evaluate((f) => window.__game.session.lockstep.world.hashAt(f), common)));
      if (hs.every((h) => h !== undefined)) {
        hashChecks.compared++;
        if (hs.every((h) => h === hs[0])) hashChecks.agreed++; else hashChecks.mismatches.push({ frame: common, hs });
      }
      console.log(`t=${k.toFixed(0)}s ` + ds.map(({ d }, i) => `p${i}[f${d.frame} fps${d.fpsNow.toFixed(0)} sim${Math.round(d.stepUs)}us rb${d.rollbacks} mp${d.mispredictions} ds${d.desyncs} st${d.starvations} lead${d.lead} dly${Math.round(d.delayMs)}]`).join(' ') + ` hash@${common} ${hs.every((h) => h === hs[0]) ? 'agree' : 'DIFFER'}`);
    }
    if (k > 30 && shots === 0) { for (const [i, p] of pages.entries()) await p.screenshot({ path: `${OUT}/mp-p${i}.png` }); shots++; }
    await new Promise((r) => setTimeout(r, 200));
  }
  // final numbers
  const final = await Promise.all(pages.map((p) => p.evaluate(() => ({ d: window.__game.debug(), ticks: window.__game.tickStats(4000), rep: window.__game.session.lockstep.report() }))));
  for (const [i, p] of pages.entries()) await p.screenshot({ path: `${OUT}/mp-end-p${i}.png` });
  let desyncs = 0;
  for (const [i, { d, ticks, rep }] of final.entries()) {
    desyncs += d.desyncs + d.resyncs;
    console.log(`p${i}: ` + JSON.stringify({
      frame: d.frame, nodeFps: d.nodeFps, fps: +d.fps.toFixed(1), simUsPerTick: Math.round(d.stepUs), steps: d.steps, renderMs: +d.renderMs.toFixed(1),
      rollbacks: d.rollbacks, mispredictions: d.mispredictions, reseats: d.reseats, starvations: d.starvations, desyncs: d.desyncs, resyncs: d.resyncs,
      verdicts: d.verdicts, noVerdict: d.noVerdict, reconnects: d.reconnects, rtt: d.rtt === null ? null : +d.rtt.toFixed(1), delayMs: Math.round(d.delayMs), lead: d.lead,
      clones: d.clones, decodes: d.decodes, liveWorlds: d.liveWorlds, frags: d.frags,
      echoes: rep.clock?.echoes, beats: rep.prediction?.beats, slackMissed: rep.clock?.slack?.missed,
    }));
    if (ticks) console.log(`p${i} tick arrivals: ${JSON.stringify(Object.fromEntries(Object.entries(ticks).map(([k, v]) => [k, +(+v).toFixed(2)])))}`);
  }
  if (probe) { console.log(`node tick stability (Node probe, ${roomId}): ${JSON.stringify(probe.stats())}`); probe.stop(); }
  console.log(`hash checks: ${hashChecks.agreed}/${hashChecks.compared} agreed${hashChecks.mismatches.length ? ' MISMATCH ' + JSON.stringify(hashChecks.mismatches.slice(0, 3)) : ''}`);
  console.log(`desyncs+resyncs over all pages: ${desyncs}`);
  if (errors.length) console.log(`errors (${errors.length}):\n${[...new Set(errors)].slice(0, 15).join('\n')}`);
  if (desyncs || hashChecks.mismatches.length) process.exitCode = 1;
} finally {
  await browser.close();
}
