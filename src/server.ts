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
import { registerDoctorRoutes } from './routes/doctor.js';
import { registerUpdateRoutes } from './routes/updates.js';
import { registerLogStreamRoutes } from './routes/logs-stream.js';
import { registerHardwareRoutes } from './routes/hardware.js';
import { registerLockRoutes } from './routes/lock.js';
import { startUpdateChecker } from './update-checker.js';

// Built webapp directory inside the container image. The Vite build
// emits to public/ at the repo root, and the Dockerfile copies that
// into /app/public. The env var lets local dev point WEBAPP_ROOT at
// the source tree's public/ folder (or skip it entirely — falling
// through to the API-only mode that returns a 404 for GET /).
const WEBAPP_ROOT = process.env.WEBAPP_ROOT ?? '/app/public';

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
  await registerDoctorRoutes(app);
  await registerUpdateRoutes(app);
  await registerLogStreamRoutes(app);
  await registerHardwareRoutes(app);
  await registerLockRoutes(app);

  // Boot the daily GHCR check. Runs once immediately so the
  // /api/updates/available cache is warm by the time the dashboard
  // polls; the periodic refresh keeps the notification badge accurate
  // for clients that never reload.
  startUpdateChecker(app.log);

  // Serve the built React webapp at /. Without this, opening the
  // Updater Console URL in a browser hits Fastify's default 404 for
  // GET / — confusing UX.
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
