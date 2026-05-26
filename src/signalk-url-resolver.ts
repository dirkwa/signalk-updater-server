import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';

/**
 * Resolve the URL used to reach signalk-server from inside this container.
 *
 * Why this exists: the updater runs on rootless-podman's default `pasta`
 * network, where `127.0.0.1` is the container's own loopback. signalk-server
 * runs with `Network=host`, listening on the host's `127.0.0.1:3000`. The
 * naive default `http://127.0.0.1:3000` therefore probes nothing — the
 * post-switch health poll always times out at 180s and the switch rolls back
 * even when the new image is fine. Incident: bug-report 2026-05-25T23:57Z.
 *
 * The fix is a templated `Environment=SIGNALK_HEALTH_URL=…` in the installer
 * Quadlet. But existing installs that never re-run the installer still ship
 * the old template, so this module adds a runtime fallback: if no env var is
 * set AND we're in a container AND `host.containers.internal` resolves, use
 * that instead of `127.0.0.1`. Local dev (`npm start` on the host) hits
 * neither branch and keeps the loopback default.
 *
 * The result is memoized — `host.containers.internal` resolution doesn't
 * change at runtime, and a per-attempt DNS hit would add cost to every
 * pollHealth tick.
 */

const LOOPBACK_BASE = 'http://127.0.0.1:3000';
const CONTAINER_HOST_BASE = 'http://host.containers.internal:3000';

let resolvedBase: string | undefined;
let resolveLogged = false;

async function detectContainerHost(): Promise<string> {
  // Not in a container → operator is running `npm start` on the host
  // (local dev). Loopback is correct and host.containers.internal won't
  // resolve anyway.
  if (!existsSync('/run/.containerenv') && !existsSync('/.dockerenv')) {
    return LOOPBACK_BASE;
  }
  try {
    await lookup('host.containers.internal');
    return CONTAINER_HOST_BASE;
  } catch {
    // No host.containers.internal — either an older podman or a custom
    // network without the host alias. Stick with loopback; the operator
    // can still override via env. Better to surface the misconfiguration
    // as a switch failure than to silently rewrite to a guess that may
    // also be wrong.
    return LOOPBACK_BASE;
  }
}

async function getBase(): Promise<string> {
  if (resolvedBase !== undefined) return resolvedBase;
  resolvedBase = await detectContainerHost();
  if (!resolveLogged) {
    resolveLogged = true;
    // eslint-disable-next-line no-console
    console.log(`[signalk-url-resolver] no env override; using ${resolvedBase}`);
  }
  return resolvedBase;
}

/**
 * URL the post-switch / post-hardware-apply health poll hits. Returns the
 * `SIGNALK_HEALTH_URL` env var verbatim if set (installer-provided), else
 * derives one from the base via the container-host fallback.
 */
export async function resolveSignalkHealthUrl(): Promise<string> {
  const override = process.env.SIGNALK_HEALTH_URL;
  if (override) return override;
  return `${await getBase()}/signalk`;
}

/**
 * Base URL for signalk-server API calls (currently only the backup-plugin
 * snapshot endpoint). Mirrors `resolveSignalkHealthUrl`'s fallback, but
 * keyed on `SIGNALK_URL`.
 */
export async function resolveSignalkBaseUrl(): Promise<string> {
  const override = process.env.SIGNALK_URL;
  if (override) return override;
  return getBase();
}

/** Test-only: drop the memoized base so the next call re-runs detection. */
export function resetSignalkUrlResolverForTests(): void {
  resolvedBase = undefined;
  resolveLogged = false;
}
