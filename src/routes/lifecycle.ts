import type { FastifyInstance } from 'fastify';
import { resolveRuntime, safe } from '../podman/client.js';
import { requireToken } from '../auth.js';

type Op = 'start' | 'stop' | 'restart';

async function actOn(container: string, op: Op): Promise<{ ok: boolean; error?: string }> {
  const rt = await resolveRuntime();
  if (!rt) return { ok: false, error: 'container runtime not reachable' };
  const c = rt.client.getContainer(container);
  const r = await safe(async () => {
    if (op === 'start') await c.start();
    else if (op === 'stop') await c.stop({ t: 30 });
    else await c.restart({ t: 30 });
  });
  if (!r.ok) return { ok: false, error: r.error.userMessage };
  return { ok: true };
}

export async function registerLifecycleRoutes(app: FastifyInstance): Promise<void> {
  for (const op of ['start', 'stop', 'restart'] as const) {
    app.post(`/api/signalk/${op}`, { preHandler: requireToken }, async (_req, reply) => {
      const result = await actOn('signalk-server', op);
      if (!result.ok) reply.code(502);
      return result;
    });
  }
}
