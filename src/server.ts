import Fastify, { type FastifyInstance } from 'fastify';
import { registerHealthRoutes } from './routes/health.js';
import { registerStateRoutes } from './routes/state.js';
import { registerLifecycleRoutes } from './routes/lifecycle.js';
import { registerVersionRoutes } from './routes/versions.js';
import { registerSwitchRoutes } from './routes/switch.js';
import { registerSelfRoutes } from './routes/self.js';
import { registerLogStreamRoutes } from './routes/logs-stream.js';

export async function createServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  await registerHealthRoutes(app);
  await registerStateRoutes(app);
  await registerLifecycleRoutes(app);
  await registerVersionRoutes(app);
  await registerSwitchRoutes(app);
  await registerSelfRoutes(app);
  await registerLogStreamRoutes(app);

  return app;
}
