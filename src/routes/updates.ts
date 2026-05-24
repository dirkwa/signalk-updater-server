import type { FastifyInstance } from 'fastify';
import { requireToken } from '../auth.js';
import { getCachedUpdates, triggerCheck } from '../update-checker.js';
import type { AvailableUpdates } from '../types.js';

export async function registerUpdateRoutes(app: FastifyInstance): Promise<void> {
  // Read-only snapshot of the daily check. No auth — same posture as
  // /api/self/state and /api/doctor/state: read-only views over an
  // already-cached GHCR result, useful from the webapp without
  // forwarding the bearer.
  app.get('/api/updates/available', async (): Promise<AvailableUpdates> => {
    return getCachedUpdates();
  });

  // Manual refresh — bearer-gated because it forces a GHCR round-trip,
  // bypassing the 24h cache. Used by the UI's "Check now" affordance,
  // though the default daily tick already covers operators who never
  // click anything.
  app.post('/api/updates/check', { preHandler: requireToken }, async (req) => {
    return triggerCheck(req.log);
  });
}
