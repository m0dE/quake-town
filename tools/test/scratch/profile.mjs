import { chromium } from '/app/data/home/arrr-mono/node_modules/playwright/index.mjs';
const url = process.argv[2];
const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(url);
await page.waitForFunction(() => window.__game && window.__game.debug().slot >= 0, null, { timeout: 120000 });
await page.waitForTimeout(Number(process.argv[3] ?? 4000));
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
await page.waitForTimeout(6000);
const { profile } = await cdp.send('Profiler.stop');
const self = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
for (let i = 0; i < profile.samples.length; i++) { const n = byId.get(profile.samples[i]); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0)); }
const tot = [...self.values()].reduce((a, b) => a + b, 0);
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log((v / 1000).toFixed(0).padStart(6), 'ms', (100 * v / tot).toFixed(1).padStart(5), '%', k.slice(0, 90));
const d = await page.evaluate(() => window.__game.debug()); console.log('fps', d.fpsNow, 'renderMs', d.renderMs, 'stepUs', d.stepUs);
await browser.close();
