import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

let rev = 'dev';
try { rev = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a checkout */ }

export default defineConfig({
  base: './',
  define: { __BUILD_REV__: JSON.stringify(rev) },
  server: { port: 5191 },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 2000 },
});
