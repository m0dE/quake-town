import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

let rev = 'dev';
try { rev = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a checkout */ }

/**
 * Packs are binary: say so. Vite sends .pk3/.pak with an empty Content-Type, and a proxy or
 * port forward in between may then treat them as text and mangle the bytes (the client
 * refuses them on the sha256 check). Never let anything transform or cache them stale.
 */
function binaryPacks() {
  const mw = (req, res, next) => {
    if (/\.(pk3|pak|json)(\?|$)/i.test(req.url ?? '')) {
      res.on('finish', () => appendFileSync('.cache/requests.log', `${new Date().toISOString()} ${req.method} ${req.url} host=${req.headers.host} from=${req.socket.remoteAddress} -> ${res.statusCode} ${res.getHeader('content-type') ?? ''}\n`));
    }
    if (/\.(pk3|pak)(\?|$)/i.test(req.url ?? '')) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-transform, max-age=0, must-revalidate');
    }
    next();
  };
  return {
    name: 'quake-town-binary-packs',
    configureServer(server) { server.middlewares.use(mw); },
    configurePreviewServer(server) { server.middlewares.use(mw); },
  };
}

export default defineConfig({
  plugins: [binaryPacks()],
  base: './',
  define: { __BUILD_REV__: JSON.stringify(rev) },
  // RunHQ serves branch previews on *.tank.fish through a tunnel; Vite refuses unknown hosts.
  server: { port: 5191, allowedHosts: ['.tank.fish', 'localhost', '127.0.0.1'] },
  preview: { port: 5191, allowedHosts: ['.tank.fish', 'localhost', '127.0.0.1'] },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 2000 },
});
