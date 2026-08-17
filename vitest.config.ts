import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Two projects: server tests in node, webapp tests in jsdom with React.
// Splitting keeps the server suite from paying for jsdom startup and
// lets the webapp suite pull in @testing-library setup files.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [],
        test: {
          name: 'server',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          // Keeps createServer()'s boot-time GHCR query off the network for
          // every server test — see test/test-setup.ts for why.
          setupFiles: [resolve(here, 'test/test-setup.ts')],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'webapp',
          environment: 'jsdom',
          include: ['webapp/**/*.test.{ts,tsx}'],
          setupFiles: [resolve(here, 'webapp/test-setup.ts')],
          globals: true,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**', 'webapp/src/**'],
    },
  },
});
