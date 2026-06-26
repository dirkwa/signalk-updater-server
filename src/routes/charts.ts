import type { FastifyInstance } from 'fastify';
import { pollHealth } from '../container-ops.js';
import {
  applyCharts,
  readHardware,
  renderChartsBlock,
  spliceChartsBlock,
  validateChartsHostPathLexical,
  writeHardware,
  CHARTS_MOUNT_TARGET,
  type ChartsConfig,
} from '../hardware.js';
import { withMutex, MutexBusyError } from '../mutex.js';
import { rewriteQuadletBody, restoreQuadletBody } from '../quadlet/rewriter.js';
import { daemonReload, startUnit, stopUnitAndWait } from '../dbus/systemd-user.js';
import { safe } from '../podman/client.js';
import { requireToken } from '../auth.js';
import { resolveSignalkHealthUrl } from '../signalk-url-resolver.js';

const SERVER_QUADLET = 'signalk-server.container';
const SERVER_UNIT = 'signalk-server.service';

// Request body for POST /api/charts/apply (narrowed at runtime from `unknown`):
// - { hostPath: "/home/<user>/Charts" }     -> mount that folder, enabled
// - { hostPath: "", enabled: false } / {}    -> clear the mount (revert to the
//   in-data-volume default on the next plugin start)
//
// Same charts config? Used to skip a needless Quadlet rewrite + signalk-server
// restart when a re-apply (or a clear-when-already-clear) changes nothing.
function sameCharts(a: ChartsConfig | undefined, b: ChartsConfig): boolean {
  const an = a ?? { hostPath: '', enabled: false };
  return an.enabled === b.enabled && an.hostPath.trim() === b.hostPath.trim();
}

// Restart signalk-server (daemon-reload + stop + start). Returns a userMessage
// on failure, null on success. Shared by the forward apply and the rollback.
async function restartServer(): Promise<string | null> {
  const r = await safe(async () => {
    await daemonReload();
    await stopUnitAndWait(SERVER_UNIT);
    await startUnit(SERVER_UNIT);
  });
  return r.ok ? null : r.error.userMessage;
}

export async function registerChartsRoutes(app: FastifyInstance): Promise<void> {
  // Read-only: surface the current charts config. No preHandler — same
  // token-or-localhost posture as the other read routes (GET /api/state,
  // /api/hardware): open at Fastify, gated by the plugin proxy / localhost
  // (CC-2).
  app.get('/api/charts', async () => {
    const hw = await readHardware();
    return { charts: hw.charts ?? null, mountTarget: CHARTS_MOUNT_TARGET };
  });

  app.post<{ Body: unknown }>(
    '/api/charts/apply',
    { preHandler: requireToken },
    async (req, reply) => {
      const raw = req.body;
      // Reject null / arrays / non-objects up front. `req.body ?? {}` would turn
      // a JSON `null` payload into an empty object and silently treat it as a
      // valid "clear charts" instead of a 400.
      if (raw === null || (raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw)))) {
        reply.code(400);
        return { ok: false, error: 'request body must be a JSON object' };
      }
      const body = (raw ?? {}) as { hostPath?: unknown; enabled?: unknown };
      // Validate the request shape: a non-string hostPath / non-boolean enabled
      // would otherwise throw a 500 on `.trim()` instead of a clean 400.
      if (body.hostPath !== undefined && typeof body.hostPath !== 'string') {
        reply.code(400);
        return { ok: false, error: 'hostPath must be a string' };
      }
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
        reply.code(400);
        return { ok: false, error: 'enabled must be a boolean' };
      }
      const rawPath = (body.hostPath ?? '').trim();
      // enabled defaults to true when a path is given, false when it's cleared.
      const enabled = body.enabled ?? rawPath !== '';
      // Enabling without a path is a contradiction (would persist enabled:true
      // with an empty hostPath, which renders no mount) — reject it.
      if (enabled && rawPath === '') {
        reply.code(400);
        return { ok: false, error: 'hostPath is required when enabled is true' };
      }

      // A clear (disable) needs no path validation.
      if (enabled) {
        const lexicalError = validateChartsHostPathLexical(rawPath);
        if (lexicalError) {
          reply.code(400);
          return { ok: false, error: `invalid charts host path: ${lexicalError}` };
        }
      }

      const charts: ChartsConfig = { hostPath: enabled ? rawPath : '', enabled };

      try {
        return await withMutex('hardware-apply', async () => {
          const current = await readHardware();

          // No-op: don't snapshot/rewrite/restart signalk-server for a re-apply
          // of the same value (a stop+start is a multi-second data-plane outage).
          if (sameCharts(current.charts, charts)) {
            return { ok: true, charts: current.charts ?? null, unchanged: true };
          }

          const next = applyCharts(current, charts);

          // Rewrite ONLY the CHARTS block via the rewriter (snapshot + atomic
          // write + prune all stay centralized there — CC-1). The HARDWARE block
          // and everything else are left untouched. `original` lets us roll the
          // Quadlet back if the restart/health step fails. hardware.json is
          // persisted AFTER the Quadlet write succeeds, so a Quadlet-write
          // failure can't leave hardware.json diverging from the unit.
          const block = renderChartsBlock(next);
          const { original } = await rewriteQuadletBody(SERVER_QUADLET, (b) =>
            spliceChartsBlock(b, block),
          );

          // Roll the Quadlet + hardware.json back to their pre-apply state and
          // restart. Charts adds a real new failure surface vs hardware-apply: a
          // host path podman rejects at container-create makes the unit fail to
          // start — without a rollback the server would stay wedged. Each step is
          // best-effort so a later failure can't skip the restart (which is what
          // gets the data plane back); the restart error is the one surfaced.
          const rollback = async (): Promise<string | null> => {
            await restoreQuadletBody(SERVER_QUADLET, original).catch(() => undefined);
            await writeHardware(current).catch(() => undefined);
            return restartServer();
          };

          // Persist hardware.json AFTER the Quadlet write. If it throws, the
          // Quadlet is already changed — roll back rather than leave the unit
          // and hardware.json diverged.
          try {
            await writeHardware(next);
          } catch (err) {
            await rollback();
            return {
              ok: false,
              error: `failed to persist charts config: ${err instanceof Error ? err.message : String(err)}`,
              rolledBack: true,
            };
          }

          const restartErr = await restartServer();
          if (restartErr !== null) {
            const rollbackErr = await rollback();
            return {
              ok: false,
              error: `systemd: ${restartErr}`,
              rolledBack: rollbackErr === null,
              ...(rollbackErr !== null ? { rollbackError: rollbackErr } : {}),
            };
          }

          const healthUrl = await resolveSignalkHealthUrl();
          // signalk-server SSL plugin redirects :80 → self-signed :443; accept
          // it on this local liveness probe (see pollHealth doc).
          const healthy = await pollHealth(healthUrl, 120000, { allowSelfSigned: true });
          if (!healthy) {
            const rollbackErr = await rollback();
            return {
              ok: false,
              error: 'signalk-server did not return to health within 120s; reverted',
              rolledBack: rollbackErr === null,
              ...(rollbackErr !== null ? { rollbackError: rollbackErr } : {}),
            };
          }
          return { ok: true, charts: next.charts ?? null };
        });
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
}
