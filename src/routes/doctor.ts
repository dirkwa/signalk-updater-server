import type { FastifyInstance } from 'fastify';
import { listTags } from '../ghcr.js';
import { compareSemver, isSemverTag } from '../tagClassifier.js';
import { requireToken } from '../auth.js';
import { performDoctorSwitch } from '../doctor-switch-service.js';
import { MutexBusyError } from '../mutex.js';
import { readQuadletImageTag } from '../quadlet-image-tag.js';
import type { DoctorState } from '../types.js';

const DOCTOR_IMAGE = process.env.DOCTOR_IMAGE ?? 'ghcr.io/dirkwa/signalk-doctor-server';
const DOCTOR_QUADLET = 'signalk-doctor-server.container';

// See routes/self.ts for the digest-vs-tag rationale — same fix, same
// reason. The Quadlet is the source-of-truth for what the operator
// pinned.
function readDoctorTag(): Promise<string> {
  return readQuadletImageTag(DOCTOR_QUADLET);
}

async function deriveLatest(): Promise<string | null> {
  const r = await listTags(DOCTOR_IMAGE.replace(/^ghcr\.io\//, ''));
  if (!r.ok) return null;
  const stable = r.tags.filter((t) => t.channel === 'stable');
  stable.sort((a, b) => compareSemver(b.name, a.name));
  return stable[0]?.name ?? null;
}

export async function registerDoctorRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/doctor/state', async (): Promise<DoctorState> => {
    const current = await readDoctorTag();
    const latest = await deriveLatest();
    // When the running Quadlet pins a floating tag like `:latest` or
    // `:master-abc1234`, compareSemver is undefined (returns 0). Treat
    // any concrete semver-shaped `latest` as an upgrade target in
    // that case — otherwise the Update button stays greyed for the
    // exact installs that most need to be moved off `:latest`.
    let updateAvailable = false;
    if (latest !== null && current !== 'unknown') {
      updateAvailable = isSemverTag(current)
        ? compareSemver(latest, current) > 0
        : isSemverTag(latest);
    }
    return {
      currentTag: current,
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
