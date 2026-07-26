import type { FastifyInstance } from 'fastify';
import { getCachedUpdates } from '../update-checker.js';
import { getCurrentState } from '../state.js';
import { readLock, STALE_LOCK_MS } from '../mutex.js';
import { getLastOutcomes } from '../last-outcome.js';
import { buildUpdaterStatus, type UpdaterStatus } from '../updater-status.js';

// GET /api/updater-status — a single doctor-shaped aggregate of the updater's
// warn/fail conditions, for the signalk-updater plugin to poll and republish
// as notifications.updater.*. Read-only, no requireToken preHandler (CC-2:
// read routes are token-or-localhost; like /api/state, it carries no gate —
// reaching the published port is the trust boundary, and the payload is
// non-secret status). Reads the ALREADY-CACHED update result (no forced GHCR
// round-trip on the plugin's poll cadence) plus live container/lock state.
export async function registerUpdaterStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/updater-status', async (): Promise<UpdaterStatus> => {
    const [current, lock] = await Promise.all([getCurrentState(), readLock()]);
    // Match /api/lock's staleness rule: an unparseable startedAt yields a null
    // age and is treated as NOT stale (fail safe toward "leave the lock").
    const started = lock ? Date.parse(lock.startedAt) : NaN;
    const ageMs = Number.isNaN(started) ? null : Date.now() - started;
    const stale = ageMs !== null && ageMs > STALE_LOCK_MS;
    return buildUpdaterStatus(new Date().toISOString(), {
      updates: getCachedUpdates(),
      current,
      lock: { lock, stale },
      outcomes: getLastOutcomes(),
    });
  });
}
