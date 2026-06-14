import type { FastifyInstance } from 'fastify';
import { requireToken } from '../auth.js';
import { forceClear, readLock, STALE_LOCK_MS } from '../mutex.js';
import type { LockInfo, LockStatus } from '../types.js';

function ageOf(lock: LockInfo): number | null {
  const t = Date.parse(lock.startedAt);
  return Number.isNaN(t) ? null : Date.now() - t;
}

export async function registerLockRoutes(app: FastifyInstance): Promise<void> {
  // Read-only: lets the UI show whether a switch / update / self-update is
  // in flight and surface a stale lock that's wedging the controls. Same
  // token-or-localhost posture as the other read routes.
  app.get('/api/lock', async (): Promise<LockStatus> => {
    const lock = await readLock();
    if (!lock) return { lock: null, ageMs: null, stale: false };
    const ageMs = ageOf(lock);
    const stale = ageMs !== null && ageMs > STALE_LOCK_MS;
    return { lock, ageMs, stale };
  });

  // Force-clear the operation lock. The escape hatch for the case the
  // mutex's own stale-reclaim can't cover from the user's point of view:
  // a process SIGKILLed mid-operation leaves the lock until either the
  // 10-min stale window passes or someone clears it. Bearer-gated — this
  // is a mutating recovery action, and clearing a lock under a genuinely
  // in-flight operation could let a second writer race it.
  app.post('/api/lock/clear', { preHandler: requireToken }, async () => {
    const before = await readLock();
    await forceClear();
    return { ok: true, cleared: before };
  });
}
