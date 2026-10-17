import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * invalidate() declares the cached update check stale (a switch just moved
 * the running image) and starts a fresh check. A check that was already in
 * flight measured the old state; if it finishes after the fresh one it must
 * not write that old state back over the cache.
 *
 * The runtime identity is the seam: checks started before the invalidation
 * wait on a gate and report the old version, later ones report the new one.
 */

const dir = mkdtempSync(join(tmpdir(), 'update-cache-invalidate-'));
const quadlets = join(dir, 'quadlets');
mkdirSync(quadlets);
process.env.QUADLET_DIR = quadlets;
process.env.DATA_DIR = dir;
process.env.LOCAL_IMAGES_DIR = join(dir, 'images');
process.env.IMAGE_SOURCE_PATH = join(dir, 'image-source.json');
for (const [name, ref] of [
  ['signalk-server.container', 'ghcr.io/dirkwa/signalk-server:dirkwa'],
  ['signalk-updater-server.container', 'ghcr.io/dirkwa/signalk-updater-server:latest'],
  ['signalk-doctor-server.container', 'ghcr.io/dirkwa/signalk-doctor-server:latest'],
]) {
  writeFileSync(join(quadlets, name), `[Container]\nImage=${ref}\n`);
}

// One identity lookup per target: signalk-server, updater, doctor.
const TARGETS = 3;
let switched = false;
let gatedLookups = 0;
let openGate: () => void = () => undefined;
const gate = new Promise<void>((resolve) => {
  openGate = resolve;
});
vi.mock('../src/runtime-version.js', () => ({
  getRuntimeIdentity: async () => {
    if (switched) return { version: '2.25.0', channel: 'stable' };
    gatedLookups++;
    await gate;
    return { version: '2.24.0', channel: 'stable' };
  },
}));
vi.mock('../src/ghcr.js', () => ({
  headManifestDigest: async () => null,
  listTags: async () => ({ ok: true, cachedAt: '', tags: [] }),
  clearListTagsCache: () => undefined,
}));
vi.mock('../src/podman/client.js', () => ({
  resolveRuntime: async () => null,
  safe: async (fn: () => Promise<unknown>) => ({ ok: true as const, value: await fn() }),
}));
vi.mock('../src/drift-client.js', () => ({ fetchDriftReport: async () => null }));
vi.mock('../src/signalk-url-resolver.js', () => ({
  resolveSignalkHealthUrl: async () => 'http://127.0.0.1/signalk',
  resolveDoctorHealthUrl: async () => 'http://127.0.0.1:3004/api/health',
}));
vi.mock('../src/routes/health.js', () => ({ getSelfVersion: () => '1.0.0' }));

const { triggerCheck, invalidate, getCachedUpdates } = await import('../src/update-checker.js');

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('invalidate', () => {
  it('keeps a check begun before it from overwriting the fresh result', async () => {
    const before = triggerCheck();
    await vi.waitFor(() => {
      expect(gatedLookups).toBe(TARGETS);
    });

    switched = true;
    invalidate();
    await vi.waitFor(() => {
      expect(getCachedUpdates().signalkServer.currentTag).toBe('2.25.0');
    });

    openGate();
    await before;

    expect(getCachedUpdates().signalkServer.currentTag).toBe('2.25.0');
  });
});
