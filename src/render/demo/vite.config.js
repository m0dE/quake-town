// Dev server (port 5293; 5193 was taken on the dev box) for the renderer test page (render.html): `npx vite --config src/render/demo/vite.config.js`
// Serves the test data copied into .cache/render-test/ (LibreQuake maps + pak0; never committed)
// under /render-test/.
import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const data = path.join(root, '.cache/render-test');

export default defineConfig({
  root,
  base: './',
  define: { __BUILD_REV__: JSON.stringify('render-test') },
  server: { port: Number(process.env.RENDER_PORT ?? 5293), strictPort: true, host: '127.0.0.1', hmr: false },
  plugins: [{
    name: 'render-test-data',
    configureServer(server) {
      server.middlewares.use('/render-test/', (req, res, next) => {
        const rel = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '');
        const file = path.join(data, rel);
        if (!file.startsWith(data) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'max-age=3600');
        fs.createReadStream(file).pipe(res);
      });
    },
  }],
});
