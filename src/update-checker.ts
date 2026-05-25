import { listTags } from './ghcr.js';
import { compareSemver, pickLatestStable } from './tagClassifier.js';
import { fetchDriftReport } from './drift-client.js';
import { getRuntimeIdentity, type VersionTarget } from './runtime-version.js';
import { getSelfVersion } from './routes/health.js';
import type { AvailableUpdates, UpdateInfo } from './types.js';

const UPDATER_IMAGE = process.env.SELF_IMAGE ?? 'ghcr.io/dirkwa/signalk-updater-server';
const DOCTOR_IMAGE = process.env.DOCTOR_IMAGE ?? 'ghcr.io/dirkwa/signalk-doctor-server';

// Resolver targets. The updater reads its own version from the cached
// package.json (no self-HTTP). The doctor goes over the host loopback
// to its `/api/health`.
const UPDATER_TARGET: VersionTarget = {
  container: 'signalk-updater-server',
  quadletName: 'signalk-updater-server.container',
  selfVersion: getSelfVersion,
};

const DOCTOR_TARGET: VersionTarget = {
  container: 'signalk-doctor-server',
  quadletName: 'signalk-doctor-server.container',
  healthUrl: process.env.DOCTOR_HEALTH_URL ?? 'http://127.0.0.1:3004/api/health',
};

// 24h interval keeps GHCR API hits to ~2 per day. Even unauthenticated
// pulls are well inside ghcr.io's per-IP budget (~50 req/h) at that rate.
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Module-level cache. Read via getCachedUpdates() from the route handler.
// Module state is fine here — the updater process owns this; another
// instance running in parallel would race on the Quadlet anyway.
let cache: AvailableUpdates = {
  updater: { currentTag: 'unknown', updateAvailable: false },
  doctor: { currentTag: 'unknown', updateAvailable: false },
  lastCheckedAt: null,
};

let timer: ReturnType<typeof setInterval> | null = null;

async function deriveLatestStable(image: string): Promise<string | null> {
  const r = await listTags(image.replace(/^ghcr\.io\//, ''));
  if (!r.ok) return null;
  return pickLatestStable(r.tags)?.name ?? null;
}

async function checkOne(image: string, target: VersionTarget): Promise<UpdateInfo> {
  // currentTag in the response is the RuntimeIdentity version (a clean
  // semver from /api/health or the OCI image label). When neither
  // source can answer, we fall back to the OperatorIntent label string
  // (the Quadlet's tag) so the field stays human-meaningful — but
  // updateAvailable stays false in that case because comparing a
  // floating tag like `:latest` against a semver is undefined.
  const [identity, latest] = await Promise.all([
    getRuntimeIdentity(target),
    deriveLatestStable(image),
  ]);
  const updateAvailable =
    identity.version !== null && latest !== null && compareSemver(latest, identity.version) > 0;
  return {
    // Wire field name stays "currentTag" for backward compat with the
    // pre-refactor webapp; the value is now an honest semver when the
    // engine could report it.
    currentTag: identity.version ?? 'unknown',
    ...(latest !== null ? { availableTag: latest } : {}),
    updateAvailable,
  };
}

/**
 * Run the GHCR check for both peer engines. Refreshes the module-level
 * cache. Safe to call concurrently — `listTags` has its own 6h cache,
 * so a manual `triggerCheck` after a recent run will be a no-op for
 * the upstream API and just freshen the comparison.
 */
// Loose logger shape so Fastify's FastifyBaseLogger or a plain pino
// Logger both satisfy it without dragging in the pino types here.
interface MinimalLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export async function triggerCheck(log?: MinimalLogger): Promise<AvailableUpdates> {
  // Drift fetch is parallel and silent on failure (fetchDriftReport
  // returns null when the doctor is unreachable, malformed, or has
  // nothing to show yet). That keeps a slow / down doctor from blocking
  // the engine check that drives the badge for the engines themselves.
  const [updater, doctor, drift] = await Promise.all([
    checkOne(UPDATER_IMAGE, UPDATER_TARGET),
    checkOne(DOCTOR_IMAGE, DOCTOR_TARGET),
    fetchDriftReport(),
  ]);
  cache = {
    updater,
    doctor,
    ...(drift !== null ? { signalkDeps: drift } : {}),
    lastCheckedAt: new Date().toISOString(),
  };
  if (log) {
    log.info(
      {
        updater: { current: updater.currentTag, latest: updater.availableTag },
        doctor: { current: doctor.currentTag, latest: doctor.availableTag },
        drift: drift
          ? {
              imageTag: drift.signalkImageTag,
              packages: drift.packages.length,
              drifting: drift.packages.filter((p) => p.classification !== 'up-to-date').length,
            }
          : null,
      },
      'update-checker: refreshed available-updates cache',
    );
  }
  return cache;
}

export function getCachedUpdates(): AvailableUpdates {
  return cache;
}

/**
 * Bust the cache and trigger an immediate refresh. Called after a
 * successful self-update / doctor-update — the just-completed flow
 * means our knowledge of RuntimeIdentity moved, so the staleness
 * window the 24h interval otherwise leaves becomes a non-issue. The
 * call is fire-and-forget; the next `/api/updates/available` read
 * either races the in-flight refresh (which is fine — it returns the
 * previous cache during the request) or sees the new value.
 *
 * Safe even when called immediately before the DBus restart in
 * self-update — the refresh will either complete pre-shutdown or be
 * cut short by the SIGTERM that follows `restartUnit`; either way
 * the cache the next boot reads is fresh because the next boot's
 * first action is its own boot-time refresh in startUpdateChecker.
 */
export function invalidate(log?: MinimalLogger): void {
  cache = {
    updater: { currentTag: 'unknown', updateAvailable: false },
    doctor: { currentTag: 'unknown', updateAvailable: false },
    lastCheckedAt: null,
  };
  void triggerCheck(log).catch(() => {
    // swallowed; next scheduled tick will re-attempt
  });
}

/**
 * Boot the daily check. Runs once immediately (so the cache is warm by
 * the time the dashboard polls), then on a 24h interval. The boot-time
 * check is best-effort: if GHCR is down it leaves the cache at its
 * "unknown" defaults, which the webapp interprets as "no badge."
 */
export function startUpdateChecker(log: MinimalLogger, intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer !== null) return;
  void triggerCheck(log).catch((err) => {
    log.warn({ err }, 'update-checker: initial check failed');
  });
  timer = setInterval(() => {
    void triggerCheck(log).catch((err) => {
      log.warn({ err }, 'update-checker: scheduled check failed');
    });
  }, intervalMs);
  // Don't keep the event loop alive on shutdown.
  timer.unref?.();
}

export function stopUpdateChecker(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
