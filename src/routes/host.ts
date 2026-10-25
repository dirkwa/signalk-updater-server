import type { FastifyInstance, FastifyReply } from 'fastify';
import { safe } from '../podman/client.js';
import {
  getActiveState,
  getLoadState,
  resetFailedUnit,
  startUnit,
  stopUnitAndWait,
} from '../dbus/systemd-user.js';
import { withMutex, MutexBusyError } from '../mutex.js';
import { requireToken } from '../auth.js';
import type { HostPowerAction, HostPowerResult, HostPowerState } from '../types.js';

const POWER_UNITS: Record<HostPowerAction, string> = {
  poweroff: 'signalk-poweroff.service',
  reboot: 'signalk-reboot.service',
};

// Both units are written by the installer only after its polkit rule, and only
// outside a podman machine VM, so "loaded" is the signal that this host can be
// powered off from here.
export async function hostPowerAvailable(): Promise<boolean> {
  const states = await Promise.all(Object.values(POWER_UNITS).map((u) => getLoadState(u)));
  return states.every((s) => s === 'loaded');
}

// The units are oneshots with RemainAfterExit=yes: `active` once
// `systemctl poweroff|reboot` returned 0 (logind accepted the request),
// `failed` when it was refused. Each call starts from `inactive` so the state
// read afterwards belongs to this request: reset-failed clears an earlier
// refusal, and a unit an earlier accepted request left `active` is stopped
// first (no ExecStop, so that is immediate). StartUnit only queues the job,
// so `inactive` while polling means not run yet. The window must outlast
// logind's polkit check, which waits up to 25s for polkitd. Exported for
// tests.
export async function runPowerUnit(unit: string, windowMs = 30_000, pollMs = 250): Promise<string> {
  await safe(() => resetFailedUnit(unit));
  // Starting a unit an unread state may have left `active` runs nothing and
  // would read back as success, so a failed read ends the request here.
  const initial = await getActiveState(unit);
  if (initial === 'unknown') return initial;
  if (initial === 'active') await stopUnitAndWait(unit);
  await startUnit(unit);
  const deadline = Date.now() + windowMs;
  for (;;) {
    const state = await getActiveState(unit);
    if (state === 'active' || state === 'failed') return state;
    if (Date.now() >= deadline) return state;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

async function powerAction(action: HostPowerAction, reply: FastifyReply): Promise<HostPowerResult> {
  const unit = POWER_UNITS[action];
  if (!(await hostPowerAvailable())) {
    reply.code(404);
    return {
      ok: false,
      error: `${unit} is not set up on this host; re-run the installer to add it.`,
    };
  }
  // A switch or update cut off by the shutdown leaves a half-written Quadlet
  // or image behind, so the request takes the shared operation lock and is
  // refused while another operation holds it (a stale lock is reclaimed).
  const r = await withMutex('host-power', () => safe(() => runPowerUnit(unit))).catch(
    (err: unknown) => {
      if (err instanceof MutexBusyError) return err;
      throw err;
    },
  );
  if (r instanceof MutexBusyError) {
    reply.code(409);
    return {
      ok: false,
      error: `${r.lock.operation} is in progress; try again when it has finished.`,
    };
  }
  if (!r.ok) {
    reply.code(502);
    return { ok: false, error: r.error.userMessage };
  }
  if (r.value === 'active') return { ok: true };
  reply.code(502);
  return {
    ok: false,
    error:
      r.value === 'failed'
        ? `The host refused the ${action}; see \`journalctl --user -u ${unit}\`. ` +
          'Re-run the installer if its polkit rule is missing.'
        : `No answer from ${unit} (state: ${r.value}); see \`journalctl --user -u ${unit}\`.`,
  };
}

export async function registerHostRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/host/power', async (): Promise<HostPowerState> => ({
    available: await hostPowerAvailable(),
  }));

  for (const action of ['poweroff', 'reboot'] as const) {
    app.post(`/api/host/${action}`, { preHandler: requireToken }, (_req, reply) =>
      powerAction(action, reply),
    );
  }
}
