import type { FastifyInstance } from 'fastify';
import { listTags } from '../ghcr.js';
import { compareSemver, pickLatestStable } from '../tagClassifier.js';
import { requireToken } from '../auth.js';
import { performDoctorSwitch } from '../doctor-switch-service.js';
import { MutexBusyError } from '../mutex.js';
import { getRuntimeIdentity, type VersionTarget } from '../runtime-version.js';
import { resolveDoctorHealthUrl } from '../signalk-url-resolver.js';
import { publishSwitchEvent } from '../switch-progress-broker.js';
import type { DoctorState } from '../types.js';

interface MinimalLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

/**
 * Run the doctor switch in the background. performDoctorSwitch already
 * publishes every stage (target:'doctor') over the switch-progress broker,
 * so the only outcome it can't surface itself is a mutex-busy rejection
 * (thrown before any event) — publish that as a `failed` event so the
 * Dashboard, which drives the result off SSE, learns about it. Invoked
 * fire-and-forget from the 202 route; never throws. Same shape as
 * runBackgroundSwitch in routes/switch.ts.
 */
async function runBackgroundDoctorSwitch(tag: string, log: MinimalLogger): Promise<void> {
  try {
    const result = await performDoctorSwitch({ tag });
    log.info({ to: tag, ok: result.ok }, 'doctor switch finished');
  } catch (err) {
    if (err instanceof MutexBusyError) {
      publishSwitchEvent({
        stage: 'failed',
        target: 'doctor',
        to: tag,
        error: 'Another operation is in progress — try again once it finishes.',
      });
    } else {
      publishSwitchEvent({
        stage: 'failed',
        target: 'doctor',
        to: tag,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    log.warn({ to: tag, err }, 'background doctor switch error');
  }
}

const DOCTOR_IMAGE = process.env.DOCTOR_IMAGE ?? 'ghcr.io/dirkwa/signalk-doctor-server';

// Build the doctor's RuntimeIdentity target through the shared resolver,
// NOT a hardcoded `127.0.0.1:3004` fallback. Inside the pasta-networked
// updater, `127.0.0.1` is our OWN loopback, so a hardcoded fallback
// probes the updater instead of the doctor; the health tier then fails
// and getRuntimeIdentity drops to the flakier OCI-label / Quadlet-tag
// tiers, whose per-request answer makes `updateAvailable` flicker between
// reloads. state.ts and update-checker.ts already resolve this way — this
// is the 4th doctor call site and must match (single-resolver invariant).
async function doctorTarget(): Promise<VersionTarget> {
  return {
    container: 'signalk-doctor-server',
    quadletName: 'signalk-doctor-server.container',
    healthUrl: await resolveDoctorHealthUrl(),
  };
}

async function deriveLatest(): Promise<string | null> {
  const r = await listTags(DOCTOR_IMAGE.replace(/^ghcr\.io\//, ''));
  if (!r.ok) return null;
  return pickLatestStable(r.tags)?.name ?? null;
}

export async function registerDoctorRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/doctor/state', async (): Promise<DoctorState> => {
    const [identity, latest] = await Promise.all([
      doctorTarget().then(getRuntimeIdentity),
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
      // Return 202 immediately and run the switch in the background — same
      // fix shape as /api/versions/switch. The full pull → trial → rewrite
      // → restart → health-poll flow outlives the embedded plugin proxy's
      // 15s header watchdog, so the old synchronous response surfaced as
      // "502 Bad Gateway" on EVERY doctor update even though the switch
      // succeeded out-of-band. The Dashboard drives the real outcome off
      // the switch-progress SSE (doctor events carry target:'doctor'),
      // including mutex-busy, which now arrives as a `failed` event.
      void runBackgroundDoctorSwitch(target, app.log);
      reply.code(202);
      return { ok: true, accepted: true, to: target };
    },
  );
}
