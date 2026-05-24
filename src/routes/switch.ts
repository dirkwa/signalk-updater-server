import type { FastifyInstance } from 'fastify';
import { performSwitch } from '../switch-service.js';
import { readLastGood } from '../quadlet/rewriter.js';
import { requireToken } from '../auth.js';
import { MutexBusyError } from '../mutex.js';
import { getLastSwitchEvent, subscribeSwitchProgress } from '../switch-progress-broker.js';

interface SwitchBody {
  tag: string;
  skipBackup?: boolean;
  healthTimeoutMs?: number;
}

const SSE_HEARTBEAT_MS = 15000;

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

  // SSE stream of switch progress events. Read-only — same posture as
  // /api/state etc.: any client on the trust boundary can subscribe.
  // Browser EventSource can't set the bearer header, so requiring it
  // here would just block the legitimate UI use case.
  app.get('/api/versions/switch/stream', async (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    // Send the current snapshot first so a late subscriber sees the
    // active flow's stage without waiting for the next transition.
    let alive = true;
    const emit = (data: object): void => {
      if (!alive) return;
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    emit(getLastSwitchEvent());

    const unsubscribe = subscribeSwitchProgress((ev) => {
      emit(ev);
    });

    const heartbeat = setInterval(() => {
      if (alive) reply.raw.write(`: heartbeat\n\n`);
    }, SSE_HEARTBEAT_MS);

    req.raw.on('close', () => {
      alive = false;
      clearInterval(heartbeat);
      unsubscribe();
    });

    return reply;
  });

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
