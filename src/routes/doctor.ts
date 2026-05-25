import type { FastifyInstance } from 'fastify';
import { listTags } from '../ghcr.js';
import { compareSemver, pickLatestStable } from '../tagClassifier.js';
import { requireToken } from '../auth.js';
import { performDoctorSwitch } from '../doctor-switch-service.js';
import { MutexBusyError } from '../mutex.js';
import { getRuntimeIdentity, type VersionTarget } from '../runtime-version.js';
import type { DoctorState } from '../types.js';

const DOCTOR_IMAGE = process.env.DOCTOR_IMAGE ?? 'ghcr.io/dirkwa/signalk-doctor-server';

const DOCTOR_TARGET: VersionTarget = {
  container: 'signalk-doctor-server',
  quadletName: 'signalk-doctor-server.container',
  healthUrl: process.env.DOCTOR_HEALTH_URL ?? 'http://127.0.0.1:3004/api/health',
};

async function deriveLatest(): Promise<string | null> {
  const r = await listTags(DOCTOR_IMAGE.replace(/^ghcr\.io\//, ''));
  if (!r.ok) return null;
  return pickLatestStable(r.tags)?.name ?? null;
}

export async function registerDoctorRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/doctor/state', async (): Promise<DoctorState> => {
    const [identity, latest] = await Promise.all([
      getRuntimeIdentity(DOCTOR_TARGET),
      deriveLatest(),
    ]);
    // Both sides are clean semvers (or null) now that currentTag comes
    // from the doctor's own /api/health. No floating-tag special case
    // needed; the digest-vs-tag bug is gone.
    const updateAvailable =
      identity.version !== null && latest !== null && compareSemver(latest, identity.version) > 0;
    return {
      // Wire field stays "currentTag" for backward compat with the
      // pre-refactor webapp; value is the honest RuntimeIdentity.
      currentTag: identity.version ?? 'unknown',
      ...(latest !== null ? { availableTag: latest } : {}),
      updateAvailable,
    };
  });

  app.post<{ Body: { tag?: string } }>(
    '/api/doctor/update',
    { preHandler: requireToken },
    async (req, reply) => {
      const target = req.body?.tag ?? (await deriveLatest());
      if (!target) {
        reply.code(400);
        return { error: 'no target tag available' };
      }
      try {
        const result = await performDoctorSwitch({ tag: target });
        if (!result.ok) {
          reply.code(500);
          return { error: result.error ?? 'doctor switch failed', result };
        }
        return result;
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
