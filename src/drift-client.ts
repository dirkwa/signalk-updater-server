import { readFile } from 'node:fs/promises';
import type { DriftReport } from './types.js';

// Resolved at request time so tests can swap them and the installer can
// adjust without rebuilding the image.
function doctorBase(): string {
  return process.env.DOCTOR_DRIFT_URL ?? 'http://127.0.0.1:3004';
}

// The doctor's bearer token lives at ~/.signalk-doctor/token (mode 0600);
// we mount that dir read-only at /doctor-data already (for the operation
// lock file, see CC-5), so reading the token from there is free — no new
// env var, no installer plumbing required.
function doctorTokenPath(): string {
  return process.env.DOCTOR_TOKEN_PATH ?? '/doctor-data/token';
}

let cachedToken: string | null = null;

async function loadDoctorToken(): Promise<string | null> {
  if (cachedToken !== null) return cachedToken;
  try {
    const raw = (await readFile(doctorTokenPath(), 'utf8')).trim();
    if (raw.length > 0) {
      cachedToken = raw;
      return cachedToken;
    }
  } catch {
    // fall through to return null — refreshDoctorDrift is best-effort
  }
  return null;
}

export function __resetDoctorTokenCacheForTests(): void {
  cachedToken = null;
}

const TIMEOUT_MS = 5000;

const CLASSIFICATIONS = new Set(['up-to-date', 'patch', 'minor', 'major', 'prerelease', 'unknown']);

function isDriftPackage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.installed === 'string' &&
    (typeof v.latest === 'string' || v.latest === null) &&
    typeof v.classification === 'string' &&
    CLASSIFICATIONS.has(v.classification) &&
    (typeof v.lastFetchedAt === 'string' || v.lastFetchedAt === null)
  );
}

function isDriftReport(value: unknown): value is DriftReport {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<DriftReport>;
  return (
    (typeof v.signalkImageTag === 'string' || v.signalkImageTag === null) &&
    typeof v.lastScannedAt === 'string' &&
    (typeof v.lastSuccessfulScanAt === 'string' || v.lastSuccessfulScanAt === null) &&
    typeof v.online === 'boolean' &&
    Array.isArray(v.packages) &&
    v.packages.every(isDriftPackage)
  );
}

/** Fetch the cached drift report from the doctor's GET /api/drift.
 *  Returns null when the doctor is unreachable, returns a malformed
 *  payload, or returns the sentinel "no scan has run yet" report
 *  (empty packages list + epoch lastScannedAt). The caller treats
 *  null as "no signalkDeps slot in the merged AvailableUpdates". */
export async function fetchDriftReport(): Promise<DriftReport | null> {
  const url = `${doctorBase()}/api/drift`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (!isDriftReport(body)) return null;
    // Treat the doctor's empty/never-scanned sentinel as "nothing to show"
    // so the badge stays quiet during the doctor's 60s startup window.
    if (body.packages.length === 0 && body.lastSuccessfulScanAt === null) return null;
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fire a refresh on the doctor's POST /api/drift/refresh. Best-effort:
 *  failures (network, auth, unreachable) are swallowed because this is
 *  always called as a side effect of another operation (update check,
 *  post-switch hook). The doctor's scheduler will catch up on its next
 *  jittered tick regardless. */
export async function refreshDoctorDrift(): Promise<void> {
  const token = await loadDoctorToken();
  if (!token) return;
  const url = `${doctorBase()}/api/drift/refresh`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort; intentional
  } finally {
    clearTimeout(timer);
  }
}
