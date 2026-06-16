import Docker from 'dockerode';
import { stat } from 'node:fs/promises';
import type { RuntimeKind } from '../types.js';
import { categorizeError, type CategorizedError } from '../errors.js';

const DEFAULT_SOCKETS = [
  '/var/run/docker.sock',
  `/run/user/${process.getuid?.() ?? 1000}/podman/podman.sock`,
  '/run/podman/podman.sock',
];

export interface ResolvedRuntime {
  client: Docker;
  socketPath: string;
  kind: RuntimeKind;
}

async function pickSocket(): Promise<string | null> {
  for (const candidate of DEFAULT_SOCKETS) {
    try {
      const s = await stat(candidate);
      if (s.isSocket()) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

async function detectKind(client: Docker, socketPath: string): Promise<RuntimeKind> {
  try {
    const v = await client.version();
    const components = (v as { Components?: Array<{ Name?: string }> }).Components ?? [];
    if (components.some((c) => /podman/i.test(c.Name ?? ''))) return 'podman';
    if (v.Platform?.Name && /podman/i.test(v.Platform.Name)) return 'podman';
    return 'docker';
  } catch {
    // /version failed (commonly: socket exists but our uid can't read it).
    // Fall back to a heuristic based on socket path: the rootless-podman
    // socket lives under /run/user/<uid>/podman/, the system-wide podman
    // socket under /run/podman/, and the Docker daemon's socket at
    // /var/run/docker.sock. Reporting 'podman' here is informational —
    // routes that actually need the API will still surface the error
    // via the safe() wrapper.
    if (/\/podman\/podman\.sock$/.test(socketPath)) return 'podman';
    return 'unknown';
  }
}

// Module-scope cache for the resolved runtime. The runtime KIND (podman vs
// docker) and socket path are immutable for the life of this process — a
// running engine's socket never flips between runtimes — so re-detecting on
// every call is pure waste. detectKind() does `client.version()`, and
// podman's /version (like /info) shells out `dpkg-query --search` on every
// helper binary (netavark, aardvark-dns, slirp4netns, crun, pasta, conmon)
// to report provenance. With ~14 resolveRuntime() call sites hit per
// request cycle and multiple engines polling the socket concurrently, that
// fan-out becomes a dpkg-query storm that pegs slow (Pi-class) boxes —
// observed at load 188 when the Updater panel bursts API calls. Caching
// collapses it to a single version() per process lifetime. dockerode opens
// a fresh connection per request, so a podman.socket restart does not
// invalidate the cached client object.
let cachedRuntime: ResolvedRuntime | null = null;
// In-flight detection promise. Memoizing the PROMISE (not just the resolved
// value) is essential: the storm happens precisely when many callers fire
// concurrently, and they'd all find `cachedRuntime` still null and each run
// their own detectKind()/version() — a cache stampede that defeats the
// point. Sharing the in-flight promise collapses a concurrent burst to a
// single version() call.
let inFlight: Promise<ResolvedRuntime | null> | null = null;

async function detectRuntimeOnce(): Promise<ResolvedRuntime | null> {
  const socketPath = await pickSocket();
  if (!socketPath) return null;
  const client = new Docker({ socketPath });
  const kind = await detectKind(client, socketPath);
  return { client, socketPath, kind };
}

export async function resolveRuntime(): Promise<ResolvedRuntime | null> {
  if (cachedRuntime) return cachedRuntime;
  // Coalesce concurrent callers onto one detection.
  if (!inFlight) {
    inFlight = detectRuntimeOnce();
  }
  const resolved = await inFlight;
  if (resolved) {
    cachedRuntime = resolved; // memoize success for the process lifetime
  }
  // Clear the in-flight handle so a failed detection (null — e.g. socket not
  // up yet at boot) is retried on the next call rather than stuck.
  inFlight = null;
  return resolved;
}

/** Test-only: drop the memoized runtime so the next resolveRuntime()
 *  re-detects. */
export function __resetRuntimeCacheForTests(): void {
  cachedRuntime = null;
  inFlight = null;
}

export async function safe<T>(
  op: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: CategorizedError }> {
  try {
    return { ok: true, value: await op() };
  } catch (err) {
    return { ok: false, error: categorizeError(err) };
  }
}
