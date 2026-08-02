import type { FastifyInstance } from 'fastify';
import { resolveRuntime, safe } from '../podman/client.js';
import {
  startUnit,
  stopUnit,
  restartUnit,
  daemonReload,
  stopUnitAndWait,
  resetFailedUnit,
  getActiveState,
} from '../dbus/systemd-user.js';
import { setQuadletBootStart } from '../quadlet/rewriter.js';
import { withMutex, MutexBusyError } from '../mutex.js';
import { requireToken } from '../auth.js';
import type { FastifyReply } from 'fastify';

type Op = 'start' | 'stop' | 'restart';

interface LifecycleResult {
  ok: boolean;
  error?: string;
  noop?: true;
  /** Last observed unit state after a start request (start/resume only). */
  state?: string;
}

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

// Issue a start and watch the unit until it settles or the observation
// window closes. `startUnit` alone proves nothing: the DBus StartUnit call
// only ENQUEUES a job, so it returns success even when systemd then refuses
// the job (start-limit latch) or the container dies on creation — this route
// used to answer 2xx over a server that never came up
// (signalk-universal-installer#235). Unlike stopUnitAndWait, hitting the
// window is NOT an error: a cold `podman run --replace` create on SD-card
// storage can legitimately take minutes (the server Quadlet allows
// TimeoutStartSec=300), far longer than an HTTP caller will wait — the
// window only bounds how long we OBSERVE (it must stay well inside the
// CLI's 30s curl --max-time), and the last seen state is returned so the
// caller can report honestly: `active` = up, `failed` = refused or dead,
// anything else = still coming up, keep watching via `signalk health`.
// Exported for tests.
export async function startUnitAndObserve(
  unit: string,
  windowMs = 15_000,
  pollMs = 500,
): Promise<string> {
  await startUnit(unit);
  const deadline = Date.now() + windowMs;
  for (;;) {
    const state = await getActiveState(unit);
    if (state === 'active' || state === 'failed') return state;
    if (Date.now() >= deadline) return state;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

// Start the unit with the full honesty protocol: clear a start-limit latch
// first (on pre-#235 Quadlets a latched unit refuses every start request,
// and reset-failed is the only thing that revives it — best-effort, because
// a reset failure must not turn a still-possible start into an error and a
// reset on a healthy unit is a no-op), then start and observe the outcome.
async function startVerified(): Promise<LifecycleResult> {
  await safe(() => resetFailedUnit(SIGNALK_UNIT));
  const r = await safe(() => startUnitAndObserve(SIGNALK_UNIT));
  if (!r.ok) return { ok: false, error: r.error.userMessage };
  if (r.value === 'failed') {
    return {
      ok: false,
      state: r.value,
      error:
        'signalk-server entered the failed state after the start request; ' +
        'check `systemctl --user status signalk-server` and ' +
        '`journalctl --user -u signalk-server`.',
    };
  }
  return { ok: true, state: r.value };
}

async function actOn(op: Op): Promise<LifecycleResult> {
  // start/stop/restart go through systemctl --user, not dockerode directly.
  // Reason: the Quadlet's default behavior on `systemctl stop` is to REMOVE
  // the container, so a subsequent dockerode `c.start()` would fail with
  // 'Resource not found'. systemctl owns the lifecycle; dockerode just
  // observes it.
  const running = await containerRunning();
  if (op === 'start' && running === true) return { ok: true, noop: true };
  if (op === 'stop' && running === false) return { ok: true, noop: true };

  if (op === 'start') return startVerified();

  // restart: clear a latch first for the same reason as startVerified — the
  // start half of RestartUnit is refused while the unit sits in
  // failed (start-limit-hit). No observation here: restart is only offered
  // on a running server (the CLI refuses it when down), so the refused-start
  // window doesn't apply the same way, and the Dashboard polls state anyway.
  const r = await safe(async () => {
    if (op === 'stop') {
      await stopUnit(SIGNALK_UNIT);
    } else {
      await safe(() => resetFailedUnit(SIGNALK_UNIT));
      await restartUnit(SIGNALK_UNIT);
    }
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
async function pause(): Promise<LifecycleResult> {
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

async function resume(): Promise<LifecycleResult> {
  // 1. Restore boot-start (un-comment WantedBy=) and reload so it's wired
  //    back into default.target for the next boot.
  const r = await safe(async () => {
    const { changed } = await setQuadletBootStart(SIGNALK_QUADLET, true);
    if (changed) await daemonReload();
  });
  if (!r.ok) return { ok: false, error: r.error.userMessage };
  // 2. Start it now, unless it's somehow already up — via the verified path:
  //    clear a start-limit latch first and observe the outcome instead of
  //    trusting StartUnit's job-enqueued "success"
  //    (signalk-universal-installer#235: this route answered 2xx while
  //    systemd refused the start and the CLI printed [OK] over a dead
  //    server).
  const running = await containerRunning();
  if (running === true) return { ok: true, noop: true };
  return startVerified();
}

// Run a mutex-guarded lifecycle op and shape the HTTP response. Mirrors the
// other mutating routes (switch/doctor/hardware): a busy lock is a 409 with the
// `{ error, lock }` shape (not a 500), and a failed op is a 502.
async function runGuarded(
  reply: FastifyReply,
  fn: () => Promise<LifecycleResult>,
): Promise<unknown> {
  try {
    const result = await withMutex('pause', fn);
    if (!result.ok) reply.code(502);
    return result;
  } catch (err) {
    if (err instanceof MutexBusyError) {
      reply.code(409);
      return { error: err.message, lock: err.lock };
    }
    reply.code(500);
    return { error: err instanceof Error ? err.message : 'unknown error' };
  }
}

export async function registerLifecycleRoutes(app: FastifyInstance): Promise<void> {
  for (const op of ['start', 'stop', 'restart'] as const) {
    app.post(`/api/signalk/${op}`, { preHandler: requireToken }, async (_req, reply) => {
      const result = await actOn(op);
      if (!result.ok) reply.code(502);
      return result;
    });
  }

  app.post('/api/signalk/pause', { preHandler: requireToken }, (_req, reply) =>
    runGuarded(reply, pause),
  );

  app.post('/api/signalk/resume', { preHandler: requireToken }, (_req, reply) =>
    runGuarded(reply, resume),
  );
}
