// Dev server for the renderer test page (render.html):
//   npx vite --config src/render/demo/vite.config.js      → http://127.0.0.1:5293/render.html
// (port 5293: 5193 was taken on the dev box). Content comes from the built packs in
// public/packs (npm run build:content), through src/content like the game.
import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export default defineConfig({
  root,
  base: './',
  define: { __BUILD_REV__: JSON.stringify('render-test') },
  server: { port: Number(process.env.RENDER_PORT ?? 5293), strictPort: true, host: '127.0.0.1', hmr: false },
});
