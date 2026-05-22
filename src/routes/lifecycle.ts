import type { FastifyInstance } from 'fastify';
import { resolveRuntime, safe } from '../podman/client.js';
import { startUnit, stopUnit, restartUnit } from '../dbus/systemd-user.js';
import { requireToken } from '../auth.js';

type Op = 'start' | 'stop' | 'restart';

interface ContainerInspect {
  State?: { Running?: boolean; Status?: string };
}

const SIGNALK_UNIT = 'signalk-server.service';
const SIGNALK_CONTAINER = 'signalk-server';

async function containerRunning(): Promise<boolean | null> {
  const rt = await resolveRuntime();
  if (!rt) return null;
  const r = await safe(
    async () => (await rt.client.getContainer(SIGNALK_CONTAINER).inspect()) as ContainerInspect,
  );
  if (!r.ok) return null;
  return Boolean(r.value.State?.Running);
}

async function actOn(op: Op): Promise<{ ok: boolean; error?: string; noop?: true }> {
  // start/stop/restart go through systemctl --user, not dockerode directly.
  // Reason: the Quadlet's default behavior on `systemctl stop` is to REMOVE
  // the container, so a subsequent dockerode `c.start()` would fail with
  // 'Resource not found'. systemctl owns the lifecycle; dockerode just
  // observes it.
  const running = await containerRunning();
  if (op === 'start' && running === true) return { ok: true, noop: true };
  if (op === 'stop' && running === false) return { ok: true, noop: true };

  const r = await safe(async () => {
    if (op === 'start') await startUnit(SIGNALK_UNIT);
    else if (op === 'stop') await stopUnit(SIGNALK_UNIT);
    else await restartUnit(SIGNALK_UNIT);
  });
  if (!r.ok) return { ok: false, error: r.error.userMessage };
  return { ok: true };
}

export async function registerLifecycleRoutes(app: FastifyInstance): Promise<void> {
  for (const op of ['start', 'stop', 'restart'] as const) {
    app.post(`/api/signalk/${op}`, { preHandler: requireToken }, async (_req, reply) => {
      const result = await actOn(op);
      if (!result.ok) reply.code(502);
      return result;
    });
  }
}
