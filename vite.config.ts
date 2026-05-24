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

// The webapp is served by Fastify at /, so no base prefix.
// Vitest config lives in vitest.config.ts; this file is build-only.
export default defineConfig({
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
