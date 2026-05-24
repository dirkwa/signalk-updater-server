import { resolveRuntime, safe } from './podman/client.js';
import { listTags } from './ghcr.js';
import { compareSemver } from './tagClassifier.js';
import type { AvailableUpdates, UpdateInfo } from './types.js';

const UPDATER_IMAGE = process.env.SELF_IMAGE ?? 'ghcr.io/dirkwa/signalk-updater-server';
const DOCTOR_IMAGE = process.env.DOCTOR_IMAGE ?? 'ghcr.io/dirkwa/signalk-doctor-server';
const UPDATER_CONTAINER = 'signalk-updater-server';
const DOCTOR_CONTAINER = 'signalk-doctor-server';

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

async function readRunningTag(container: string): Promise<string> {
  const rt = await resolveRuntime();
  if (!rt) return 'unknown';
  const r = await safe(() => rt.client.getContainer(container).inspect());
  if (!r.ok) return 'unknown';
  const info = r.value as unknown as { Image?: string; ImageName?: string };
  const image = info.ImageName ?? info.Image ?? '';
  return image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : 'unknown';
}

async function deriveLatestStable(image: string): Promise<string | null> {
  const r = await listTags(image.replace(/^ghcr\.io\//, ''));
  if (!r.ok) return null;
  const stable = r.tags.filter((t) => t.channel === 'stable');
  stable.sort((a, b) => compareSemver(b.name, a.name));
  return stable[0]?.name ?? null;
}

async function checkOne(image: string, container: string): Promise<UpdateInfo> {
  const [currentTag, latest] = await Promise.all([
    readRunningTag(container),
    deriveLatestStable(image),
  ]);
  return {
    currentTag,
    ...(latest !== null ? { availableTag: latest } : {}),
    updateAvailable:
      latest !== null && currentTag !== 'unknown' && compareSemver(latest, currentTag) > 0,
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
  const [updater, doctor] = await Promise.all([
    checkOne(UPDATER_IMAGE, UPDATER_CONTAINER),
    checkOne(DOCTOR_IMAGE, DOCTOR_CONTAINER),
  ]);
  cache = { updater, doctor, lastCheckedAt: new Date().toISOString() };
  if (log) {
    log.info(
      {
        updater: { current: updater.currentTag, latest: updater.availableTag },
        doctor: { current: doctor.currentTag, latest: doctor.availableTag },
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
