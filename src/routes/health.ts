import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Docker from 'dockerode';
import type { HealthResponse } from '../types.js';
import { resolveRuntime } from '../podman/client.js';

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

async function probeRuntimeVersion(client: Docker): Promise<string | undefined> {
  try {
    const v = (await client.version()) as { Version?: string };
    return typeof v.Version === 'string' && v.Version.length > 0 ? v.Version : undefined;
  } catch {
    return undefined;
  }
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
