import type { FastifyInstance } from 'fastify';
import { getCurrentState, tailContainerLogs } from '../state.js';

export async function registerStateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/state', async () => getCurrentState());

  app.get<{ Querystring: { lines?: string } }>('/api/signalk/logs', async (req, reply) => {
    const linesRaw = req.query.lines ?? '200';
    const lines = Math.max(1, Math.min(5000, Number.parseInt(linesRaw, 10) || 200));
    const text = await tailContainerLogs('signalk-server', lines);
    reply.type('text/plain; charset=utf-8').send(text);
  });
}
