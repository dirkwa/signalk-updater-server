import type { FastifyInstance } from 'fastify';
import { listTags } from '../ghcr.js';
import { compareSemver } from '../tagClassifier.js';
import { resolveRuntime, safe } from '../podman/client.js';
import { requireToken } from '../auth.js';
import { performDoctorSwitch } from '../doctor-switch-service.js';
import { MutexBusyError } from '../mutex.js';
import type { DoctorState } from '../types.js';

const DOCTOR_IMAGE = process.env.DOCTOR_IMAGE ?? 'ghcr.io/dirkwa/signalk-doctor-server';
const DOCTOR_CONTAINER = 'signalk-doctor-server';

async function readDoctorTag(): Promise<string> {
  const rt = await resolveRuntime();
  if (!rt) return 'unknown';
  const inspectResult = await safe(() => rt.client.getContainer(DOCTOR_CONTAINER).inspect());
  if (!inspectResult.ok) return 'unknown';
  const info = inspectResult.value as unknown as { Image?: string; ImageName?: string };
  const image = info.ImageName ?? info.Image ?? '';
  return image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : 'unknown';
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
    return {
      currentTag: current,
      ...(latest !== null ? { availableTag: latest } : {}),
      updateAvailable:
        latest !== null && current !== 'unknown' && compareSemver(latest, current) > 0,
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
