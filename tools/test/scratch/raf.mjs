import { chromium } from '/app/data/home/arrr-mono/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('about:blank');
const n2 = await page.evaluate(() => new Promise((res) => { const c = document.createElement('canvas'); c.width=1280;c.height=720; c.style.cssText='position:fixed;inset:0;width:100%;height:100%'; document.body.append(c); const x=c.getContext('2d'); let n = 0; const t0 = performance.now(); const f = () => { n++; x.fillStyle='#'+(n%9)+'00'; x.fillRect(0,0,1280,720); if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(n / 3); }; requestAnimationFrame(f); }));
console.log('2d canvas rAF/s', n2);
await browser.close();
