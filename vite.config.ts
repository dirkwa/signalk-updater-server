import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

// Inline the engine's own version so the webapp header can show it
// without an /api/health roundtrip just for the brand chip.
const pkgVersion = (
  JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf-8')) as { version: string }
).version;

// Relative base. Two consumers:
// 1. Standalone at :3003 — HTML asset URLs like ./assets/index.js resolve
//    against the page URL (always /), so they end up at /assets/index.js
//    just like an absolute base would.
// 2. Embedded by signalk-updater plugin — the plugin reverse-proxies us
//    under /plugins/signalk-updater/console/. Relative asset URLs there
//    resolve against /plugins/signalk-updater/console/, keeping every
//    asset request inside the proxy's namespace.
// API paths (string literals in JS) take a separate path via the
// <meta name="api-base"> tag the plugin injects — see api.ts.
// Vitest config lives in vitest.config.ts; this file is build-only.
export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  root: resolve(here, 'webapp'),
  publicDir: resolve(here, 'webapp/public'),
  build: {
    outDir: resolve(here, 'public'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  // Dev server: point this at a running engine via VITE_DEV_API so
  // /api/* and SSE requests land on the real backend instead of 404ing.
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API ?? 'http://127.0.0.1:3003',
        changeOrigin: true,
      },
    },
  },
});
