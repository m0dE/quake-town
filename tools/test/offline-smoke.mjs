// Quake Town — single-player offline smoke test (Playwright, one headless Chromium).
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
//
//   npx vite --port 5191 &      (the shell's dev server)
//   node tools/test/offline-smoke.mjs [--url=http://localhost:5191/] [--map=qt_aero] [--fake] [--secs=20]
//
// Plays offline against bots with scripted inputs, screenshots into docs/shots/game/,
// prints the page's numbers (fps, sim µs/tick, rollbacks, entities) and fails on errors.
import { chromium } from '/app/data/home/arrr-mono/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const BASE = arg('url', 'http://localhost:5191/');
const MAP = arg('map', 'qt_aero');
const SECS = Number(arg('secs', '20'));
const FAKE = process.argv.includes('--fake');
const OUT = 'docs/shots/game';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  const url = `${BASE}?offline=1&map=${MAP}&test=1&name=smoke&maxclients=${arg('max', '4')}${FAKE ? '&fake=1' : ''}`;
  console.log(`open ${url}`);
  await page.goto(url);
  await page.waitForFunction(() => window.__game && window.__game.debug().slot >= 0, null, { timeout: 90_000 });
  console.log('in the game, slot', await page.evaluate(() => window.__game.debug().slot));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/offline-spawn.png` });

  // scripted play: run, turn, jump, shoot
  const t0 = Date.now();
  let shot = 0;
  await page.evaluate(() => { window.__game.testHold('forward', true); });
  while (Date.now() - t0 < SECS * 1000) {
    const k = (Date.now() - t0) / 1000;
    await page.evaluate((k) => {
      const g = window.__game;
      g.testLook(Math.sin(k * 0.7) * 10, (k * 40) % 360);
      g.testHold('attack', Math.floor(k * 2) % 3 === 0);
      g.testHold('jump', Math.floor(k * 3) % 4 === 0);
      if (Math.floor(k) % 5 === 0) g.testImpulse(7);
    }, k);
    if (k > 4 && shot === 0) { await page.screenshot({ path: `${OUT}/offline-running.png` }); shot++; }
    if (k > SECS / 2 && shot === 1) {
      await page.keyboard.down('Tab');
      await page.evaluate(() => window.__game.testHold('showscores', true));
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}/offline-scores.png` });
      await page.evaluate(() => window.__game.testHold('showscores', false));
      shot++;
    }
    await page.waitForTimeout(250);
  }
  await page.evaluate(() => { const g = window.__game; g.testHold('forward', false); g.testHold('attack', false); });
  // console
  await page.evaluate(() => { window.__qtcmd?.('toggleconsole'); });
  await page.keyboard.press('Backquote');
  await page.waitForTimeout(600);
  await page.keyboard.type('cvarlist sens');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/offline-console.png` });
  await page.keyboard.press('Backquote');
  const d = await page.evaluate(() => window.__game.debug());
  console.log(JSON.stringify({
    fps: Math.round(d.fps), fpsNow: Math.round(d.fpsNow), stepUs: Math.round(d.stepUs), steps: d.steps, renderMs: +d.renderMs.toFixed(2),
    entities: d.entities, rollbacks: d.rollbacks, mispredictions: d.mispredictions, desyncs: d.desyncs, starvations: d.starvations,
    lead: d.lead, delayMs: Math.round(d.delayMs), clones: d.clones, decodes: d.decodes, liveWorlds: d.liveWorlds, health: d.health, frags: d.frags, pos: d.pos, map: d.map,
  }));
  if (errors.length) { console.log('ERRORS:\n' + errors.slice(0, 20).join('\n')); process.exitCode = 1; }
} finally {
  await browser.close();
}
