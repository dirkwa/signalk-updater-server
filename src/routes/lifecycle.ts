import type { FastifyInstance } from 'fastify';
import { resolveRuntime, safe } from '../podman/client.js';
import {
  startUnit,
  stopUnit,
  restartUnit,
  daemonReload,
  stopUnitAndWait,
} from '../dbus/systemd-user.js';
import { setQuadletBootStart } from '../quadlet/rewriter.js';
import { withMutex } from '../mutex.js';
import { requireToken } from '../auth.js';

type Op = 'start' | 'stop' | 'restart';

interface ContainerInspect {
  State?: { Running?: boolean; Status?: string };
}

const SIGNALK_UNIT = 'signalk-server.service';
const SIGNALK_QUADLET = 'signalk-server.container';
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

// Durable pause / resume. Unlike start/stop (which only change the unit's
// current runtime state), these also toggle whether signalk-server starts at
// the NEXT boot, by commenting/uncommenting its `[Install] WantedBy=` line in
// the Quadlet (setQuadletBootStart). That makes `signalk stop` survive a reboot
// on Linux — matching the Windows shim, which gets durability for free by
// stopping the whole Podman machine + disabling its boot task.
//
// The CLI must never edit systemd enablement itself (installer invariant: it
// only touches signalk-server's lifecycle through this API). And `disable` on a
// Quadlet-GENERATED unit isn't durable anyway — daemon-reload regenerates the
// wants symlink from the .container source — so the durable lever has to be the
// Quadlet rewrite, which is exactly what this engine already owns for version
// switches (CC-1: snapshot, atomic write, keep last 10).
//
// Wrapped in withMutex('pause') because it rewrites signalk-server.container +
// daemon-reloads, the same class of mutation a switch performs; it must not
// interleave with a switch / rollback / self-update (CC-5, shared with the
// doctor).
async function pause(): Promise<{ ok: boolean; error?: string; noop?: true }> {
  const r = await safe(async () => {
    // 1. Stop auto-start at boot (snapshot + rewrite the Quadlet, then reload
    //    so the generator drops the default.target wants symlink now).
    const { changed } = await setQuadletBootStart(SIGNALK_QUADLET, false);
    if (changed) await daemonReload();
    // 2. Stop it now. stopUnitAndWait so we don't return before it's actually
    //    down (StopUnit only enqueues the job). A genuine Stop also suppresses
    //    the unit's Restart= policy for this transition.
    await stopUnitAndWait(SIGNALK_UNIT);
  });
  if (!r.ok) return { ok: false, error: r.error.userMessage };
  return { ok: true };
}

async function resume(): Promise<{ ok: boolean; error?: string; noop?: true }> {
  const r = await safe(async () => {
    // 1. Restore boot-start (un-comment WantedBy=) and reload so it's wired
    //    back into default.target for the next boot.
    const { changed } = await setQuadletBootStart(SIGNALK_QUADLET, true);
    if (changed) await daemonReload();
    // 2. Start it now, unless it's somehow already up.
    const running = await containerRunning();
    if (running !== true) await startUnit(SIGNALK_UNIT);
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

  app.post('/api/signalk/pause', { preHandler: requireToken }, async (_req, reply) => {
    const result = await withMutex('pause', pause);
    if (!result.ok) reply.code(502);
    return result;
  });

  app.post('/api/signalk/resume', { preHandler: requireToken }, async (_req, reply) => {
    const result = await withMutex('pause', resume);
    if (!result.ok) reply.code(502);
    return result;
  });
}
