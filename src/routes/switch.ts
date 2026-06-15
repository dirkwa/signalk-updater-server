import type { FastifyInstance } from 'fastify';
import { performSwitch } from '../switch-service.js';
import { readLastGood } from '../quadlet/rewriter.js';
import { requireToken } from '../auth.js';
import { MutexBusyError } from '../mutex.js';
import {
  getLastSwitchEvent,
  publishSwitchEvent,
  subscribeSwitchProgress,
} from '../switch-progress-broker.js';

interface SwitchBody {
  tag: string;
  skipBackup?: boolean;
  healthTimeoutMs?: number;
}

const SSE_HEARTBEAT_MS = 15000;

interface MinimalLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

/**
 * Run a switch in the background. performSwitch already publishes every
 * stage (pulling → … → complete / failed-with-rollback) over the broker,
 * so the only outcome it can't surface itself is a mutex-busy rejection
 * (thrown before any event) — publish that as a `failed` event so the
 * webapp, which drives the result off SSE, learns about it. Invoked
 * fire-and-forget from the 202 routes; never throws.
 */
async function runBackgroundSwitch(body: SwitchBody, log: MinimalLogger): Promise<void> {
  try {
    const result = await performSwitch(body);
    log.info({ to: body.tag, ok: result.ok, rolledBack: result.rolledBack }, 'switch finished');
  } catch (err) {
    if (err instanceof MutexBusyError) {
      publishSwitchEvent({
        stage: 'failed',
        target: 'signalk-server',
        to: body.tag,
        error: 'Another operation is in progress — try again once it finishes.',
      });
    } else {
      // performSwitch normally publishes its own 'failed' on internal
      // errors, but guard the unexpected-throw path too.
      publishSwitchEvent({
        stage: 'failed',
        target: 'signalk-server',
        to: body.tag,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    log.warn({ to: body.tag, err }, 'background switch error');
  }
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
      // Return 202 immediately and run the switch in the background. The
      // full flow (pull → trial → rewrite → restart → health-poll, up to
      // ~3min) already streams stage events over the switch-progress
      // broker, and the webapp drives the outcome off that SSE stream. A
      // blocking response would sit headerless for minutes and get killed
      // by the embedded plugin proxy's 15s header-timeout → 502 mid-switch.
      // Same fix shape as the pre-pull and doctor-update flows.
      void runBackgroundSwitch(body, app.log);
      reply.code(202);
      return { ok: true, accepted: true, to: body.tag };
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
    // The last-good lookup is instant, so resolve it synchronously to give
    // a clean 404 when there's nothing to roll back to. The switch itself
    // runs in the background (202 + SSE), same as the forward switch.
    const lg = await readLastGood();
    const entry = lg?.quadlets['signalk-server.container'];
    if (!entry) {
      reply.code(404);
      return { error: 'no last-known-good recorded' };
    }
    void runBackgroundSwitch({ tag: entry.tag, skipBackup: true }, app.log);
    reply.code(202);
    return { ok: true, accepted: true, to: entry.tag };
  });
}
