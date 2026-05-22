import type { FastifyInstance } from 'fastify';
import type Docker from 'dockerode';
import { resolveRuntime, safe } from '../podman/client.js';
import { requireToken } from '../auth.js';

type Op = 'start' | 'stop' | 'restart';

interface ContainerInspect {
  State?: { Running?: boolean; Status?: string };
}

async function inspectRunning(c: Docker.Container): Promise<boolean | null> {
  const r = await safe(async () => (await c.inspect()) as ContainerInspect);
  if (!r.ok) return null;
  return Boolean(r.value.State?.Running);
}

async function actOn(
  container: string,
  op: Op,
): Promise<{ ok: boolean; error?: string; noop?: true }> {
  const rt = await resolveRuntime();
  if (!rt) return { ok: false, error: 'container runtime not reachable' };
  const c = rt.client.getContainer(container);

  // start/stop are idempotent — if the container is already in the requested
  // state, return ok without an API call. The bash installer calls start on
  // every install, and systemd may have already brought it up.
  const running = await inspectRunning(c);
  if (op === 'start' && running === true) return { ok: true, noop: true };
  if (op === 'stop' && running === false) return { ok: true, noop: true };

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
