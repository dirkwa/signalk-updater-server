import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';

/**
 * Resolve URLs used to reach sibling host-network containers from inside
 * this pasta-networked container.
 *
 * Why this exists: the updater runs on rootless-podman's default `pasta`
 * network, where `127.0.0.1` is the container's own loopback. signalk-server
 * runs with `Network=host`, listening on the host's `127.0.0.1:3000`. The
 * naive default `http://127.0.0.1:<port>` therefore probes nothing — the
 * post-switch health poll always times out at 180s and the switch rolls back
 * even when the new image is fine. Same root cause hit the doctor at
 * `:3004/api/health` (PR after the bug-report 2026-05-26T01:19Z, where the
 * doctor-switch silently rolled back and left the cache showing stale
 * `updateAvailable: true` after the user clicked Update on the Doctor card).
 *
 * The fix is templated `Environment=…_URL=…` in the installer Quadlet. But
 * existing installs that never re-run the installer still ship the old
 * template, so this module adds a runtime fallback: if no env var is set
 * AND we're in a container AND `host.containers.internal` resolves, use
 * that instead of `127.0.0.1`. Local dev (`npm start` on the host) hits
 * neither branch and keeps the loopback default.
 *
 * The host detection is memoized — `host.containers.internal` resolution
 * doesn't change at runtime, and a per-attempt DNS hit would add cost to
 * every pollHealth tick.
 */

const LOOPBACK_HOST = '127.0.0.1';
const CONTAINER_HOST = 'host.containers.internal';

let resolvedHost: string | undefined;
let resolveLogged = false;

async function detectContainerHost(): Promise<string> {
  // Not in a container → operator is running `npm start` on the host
  // (local dev). Loopback is correct and host.containers.internal won't
  // resolve anyway.
  if (!existsSync('/run/.containerenv') && !existsSync('/.dockerenv')) {
    return LOOPBACK_HOST;
  }
  try {
    await lookup(CONTAINER_HOST);
    return CONTAINER_HOST;
  } catch {
    // No host.containers.internal — either an older podman or a custom
    // network without the host alias. Stick with loopback; the operator
    // can still override via env. Better to surface the misconfiguration
    // as a switch failure than to silently rewrite to a guess that may
    // also be wrong.
    return LOOPBACK_HOST;
  }
}

async function getHost(): Promise<string> {
  if (resolvedHost !== undefined) return resolvedHost;
  resolvedHost = await detectContainerHost();
  if (!resolveLogged) {
    resolveLogged = true;
    // eslint-disable-next-line no-console
    console.log(`[signalk-url-resolver] no env override; using ${resolvedHost}`);
  }
  return resolvedHost;
}

/**
 * URL the post-switch / post-hardware-apply signalk-server health poll
 * hits. Returns the `SIGNALK_HEALTH_URL` env var verbatim if set
 * (installer-provided), else derives one from the resolved host.
 */
export async function resolveSignalkHealthUrl(): Promise<string> {
  const override = process.env.SIGNALK_HEALTH_URL;
  if (override) return override;
  return `http://${await getHost()}:3000/signalk`;
}

/**
 * Base URL for signalk-server API calls (currently only the backup-plugin
 * snapshot endpoint). Mirrors `resolveSignalkHealthUrl`'s fallback, but
 * keyed on `SIGNALK_URL`.
 */
export async function resolveSignalkBaseUrl(): Promise<string> {
  const override = process.env.SIGNALK_URL;
  if (override) return override;
  return `http://${await getHost()}:3000`;
}

/**
 * URL the post-doctor-switch health poll hits, AND the URL the engine's
 * own RuntimeIdentity resolver uses to ask the doctor "what version are
 * you?". Returns the `DOCTOR_HEALTH_URL` env var verbatim if set, else
 * derives one from the resolved host.
 */
export async function resolveDoctorHealthUrl(): Promise<string> {
  const override = process.env.DOCTOR_HEALTH_URL;
  if (override) return override;
  return `http://${await getHost()}:3004/api/health`;
}

/** Test-only: drop the memoized host so the next call re-runs detection. */
export function resetSignalkUrlResolverForTests(): void {
  resolvedHost = undefined;
  resolveLogged = false;
}
