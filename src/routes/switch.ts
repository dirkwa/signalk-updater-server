import type { FastifyInstance } from 'fastify';
import { performSwitch } from '../switch-service.js';
import { readLastGood } from '../quadlet/rewriter.js';
import { requireToken } from '../auth.js';
import { MutexBusyError } from '../mutex.js';

interface SwitchBody {
  tag: string;
  skipBackup?: boolean;
  healthTimeoutMs?: number;
}

export async function registerSwitchRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: SwitchBody }>(
    '/api/versions/switch',
    { preHandler: requireToken },
    async (req, reply) => {
      const body = req.body ?? ({} as SwitchBody);
      if (!body.tag || typeof body.tag !== 'string') {
        reply.code(400);
        return { error: 'tag is required' };
      }
      try {
        return await performSwitch(body);
      } catch (err) {
        if (err instanceof MutexBusyError) {
          reply.code(409);
          return { error: err.message, lock: err.lock };
        }
        reply.code(500);
        return { error: err instanceof Error ? err.message : 'unknown error' };
      }
    },
  );

  app.post('/api/versions/rollback', { preHandler: requireToken }, async (_req, reply) => {
    const lg = await readLastGood();
    const entry = lg?.quadlets['signalk-server.container'];
    if (!entry) {
      reply.code(404);
      return { error: 'no last-known-good recorded' };
    }
    try {
      return await performSwitch({ tag: entry.tag, skipBackup: true });
    } catch (err) {
      if (err instanceof MutexBusyError) {
        reply.code(409);
        return { error: err.message, lock: err.lock };
      }
      reply.code(500);
      return { error: err instanceof Error ? err.message : 'unknown error' };
    }
  });
}
