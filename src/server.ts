import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { registerHealthRoutes } from './routes/health.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerStateRoutes } from './routes/state.js';
import { registerLifecycleRoutes } from './routes/lifecycle.js';
import { registerVersionRoutes } from './routes/versions.js';
import { registerSwitchRoutes } from './routes/switch.js';
import { registerSelfRoutes } from './routes/self.js';
import { registerLogStreamRoutes } from './routes/logs-stream.js';
import { registerHardwareRoutes } from './routes/hardware.js';

// Webapp directory inside the container image. Build copies webapp/ to
// /app/webapp; the env var lets dev mode point at the source tree.
const WEBAPP_ROOT = process.env.WEBAPP_ROOT ?? '/app/webapp';

export async function createServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  // API routes first so they take precedence over the static fallback.
  await registerHealthRoutes(app);
  await registerSessionRoutes(app);
  await registerStateRoutes(app);
  await registerLifecycleRoutes(app);
  await registerVersionRoutes(app);
  await registerSwitchRoutes(app);
  await registerSelfRoutes(app);
  await registerLogStreamRoutes(app);
  await registerHardwareRoutes(app);

  // Serve the webapp at /. Without this, opening the Updater Console URL
  // in a browser hits Fastify's default 404 for GET / — confusing UX.
  // The placeholder index.html will be replaced by a real Vite+React
  // build in a later phase; this just lays down the route.
  if (existsSync(WEBAPP_ROOT)) {
    await app.register(fastifyStatic, {
      root: resolve(WEBAPP_ROOT),
      prefix: '/',
      // Don't shadow API routes (which use prefix /api/) with static
      // 404 fall-throughs.
      decorateReply: false,
    });
  }

  return app;
}
