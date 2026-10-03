import { chromium } from '/app/data/home/arrr-mono/node_modules/playwright/index.mjs';
const [url, out] = [process.argv[2], process.argv[3]];
const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.goto(url);
await page.waitForFunction(() => window.__game && window.__game.debug().slot >= 0, null, { timeout: 120000 });
await page.waitForTimeout(5000);
for (const yaw of [0, 90, 180, 270]) {
  await page.evaluate((y) => window.__game.testLook(0, y), yaw);
  await page.waitForTimeout(4000);
  const d = await page.evaluate(() => { const g = window.__game; const f = g['frame']; return { pos: g.debug().pos, health: g.debug().health, cam: Array.from(f.camera.origin).map(Math.round), ang: Array.from(f.camera.angles).map((x) => Math.round(x)), blend: Array.from(f.camera.blend).map((x) => +x.toFixed(2)), ents: f.entityCount }; });
  console.log(yaw, JSON.stringify(d));
  await page.screenshot({ path: `${out}-${yaw}.png` });
}
await browser.close();
