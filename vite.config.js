import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

let rev = 'dev';
try { rev = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a checkout */ }

export default defineConfig({
  base: './',
  define: { __BUILD_REV__: JSON.stringify(rev) },
  // RunHQ serves branch previews on *.tank.fish through a tunnel; Vite refuses unknown hosts.
  server: { port: 5191, allowedHosts: ['.tank.fish', 'localhost', '127.0.0.1'] },
  preview: { port: 5191, allowedHosts: ['.tank.fish', 'localhost', '127.0.0.1'] },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 2000 },
});
