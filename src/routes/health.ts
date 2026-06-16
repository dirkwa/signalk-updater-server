import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Docker from 'dockerode';
import type { HealthResponse } from '../types.js';
import { resolveRuntime, safe } from '../podman/client.js';

const startedAt = Date.now();

// Resolve the engine container's own package.json from dist/routes/
// (this file at runtime). We cache the version once at module load so
// /api/health stays a cheap call. Falls back to "unknown" if the read
// fails — the route still answers, the version just shows up empty in
// the UI rather than blocking healthcheck.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = resolve(__dirname, '..', '..', 'package.json');

let cachedVersion = 'unknown';
async function loadVersion(): Promise<void> {
  try {
    const raw = await readFile(PKG_PATH, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      cachedVersion = pkg.version;
    }
  } catch {
    // leave cachedVersion = 'unknown'
  }
}
void loadVersion();

/** Returns the engine's own package.json version, or 'unknown' if the
 *  package.json wasn't readable at boot. Exported so the RuntimeIdentity
 *  resolver in src/runtime-version.ts can answer "what version am I?"
 *  for our own container without an HTTP round-trip to ourselves. */
export function getSelfVersion(): string {
  return cachedVersion;
}

// Memoized podman/docker daemon version. Like the runtime kind, the daemon
// version is fixed for the life of the daemon, and `client.version()` is one
// of the podman API calls that fans out `dpkg-query` per helper binary. The
// /api/health poll runs every 15s from the webapp, so without this the
// runtime-version chip cost a dpkg fan-out on every poll. Probe once, then
// serve the cached string. Stays undefined (and re-probable) until the first
// successful probe so a daemon that wasn't up at first poll still fills in.
let cachedRuntimeVersion: string | undefined;
let runtimeVersionProbed = false;

async function probeRuntimeVersion(client: Docker): Promise<string | undefined> {
  if (runtimeVersionProbed) return cachedRuntimeVersion;
  const r = await safe(async () => (await client.version()) as { Version?: string });
  if (!r.ok) return undefined; // leave un-probed so a later poll retries
  const v = r.value;
  cachedRuntimeVersion =
    typeof v.Version === 'string' && v.Version.length > 0 ? v.Version : undefined;
  runtimeVersionProbed = true;
  return cachedRuntimeVersion;
}

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (): Promise<HealthResponse> => {
    const runtime = await resolveRuntime();
    const runtimeVersion = runtime ? await probeRuntimeVersion(runtime.client) : undefined;
    return {
      ok: runtime !== null,
      runtime: runtime?.kind ?? 'unknown',
      socketPath: runtime?.socketPath,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      version: cachedVersion,
      runtimeVersion,
    };
  });
}
