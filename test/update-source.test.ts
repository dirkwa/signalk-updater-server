import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Source-aware "update available" for signalk-server:
 *  - custom repo (Advanced tab) → the drift check asks GHCR about THAT
 *    repo's tag (the Quadlet ref), never dirkwa's;
 *  - archive-sourced → GHCR is not asked at all; the signal is a NEWER
 *    FILE in the local image folder;
 *  - hand-edited Quadlet (ref ≠ recorded) → falls back to registry mode.
 *
 * Real files: Quadlet dir, image-source.json, image folder. Mocked: GHCR
 * HEAD (`headManifestDigest`), the dockerode client (no local image /
 * container), runtime identity, drift-report client.
 */

const dir = mkdtempSync(join(tmpdir(), 'update-source-'));
const quadlets = join(dir, 'quadlets');
const images = join(dir, 'images');
mkdirSync(quadlets);
mkdirSync(images);
process.env.QUADLET_DIR = quadlets;
process.env.DATA_DIR = dir;
process.env.LOCAL_IMAGES_DIR = images;
process.env.ARCHIVE_INDEX_PATH = join(dir, 'archive-index.json');
process.env.IMAGE_SOURCE_PATH = join(dir, 'image-source.json');

const mockHead = vi.fn();
vi.mock('../src/ghcr.js', () => ({
  headManifestDigest: (image: string, tag: string) => mockHead(image, tag),
  listTags: async () => ({ ok: true, cachedAt: '', tags: [] }),
  clearListTagsCache: () => undefined,
}));
vi.mock('../src/podman/client.js', () => ({
  resolveRuntime: async () => ({
    kind: 'podman',
    socketPath: '/dev/null',
    client: {
      listImages: async () => [],
      getContainer: () => ({ inspect: async () => Promise.reject(new Error('no such container')) }),
      getImage: () => ({ inspect: async () => Promise.reject(new Error('no such image')) }),
    },
  }),
  safe: async (fn: () => Promise<unknown>) => {
    try {
      return { ok: true as const, value: await fn() };
    } catch (err) {
      return { ok: false as const, error: { kind: 'unknown', userMessage: String(err), raw: '' } };
    }
  },
}));
vi.mock('../src/runtime-version.js', () => ({
  getRuntimeIdentity: async () => ({ version: '2.24.0', channel: 'stable' }),
}));
vi.mock('../src/drift-client.js', () => ({ fetchDriftReport: async () => null }));
vi.mock('../src/signalk-url-resolver.js', () => ({
  resolveSignalkHealthUrl: async () => 'http://127.0.0.1/signalk',
  resolveDoctorHealthUrl: async () => 'http://127.0.0.1:3004/api/health',
}));
vi.mock('../src/routes/health.js', () => ({ getSelfVersion: () => '1.0.0' }));

const { triggerCheck } = await import('../src/update-checker.js');
const { recordImageSource, resolveImageSource } = await import('../src/image-source.js');

const Q = 'signalk-server.container';
function writeQuadlet(ref: string): void {
  writeFileSync(join(quadlets, Q), `[Container]\nImage=${ref}\n`);
  writeFileSync(
    join(quadlets, 'signalk-updater-server.container'),
    `[Container]\nImage=ghcr.io/dirkwa/signalk-updater-server:latest\n`,
  );
  writeFileSync(
    join(quadlets, 'signalk-doctor-server.container'),
    `[Container]\nImage=ghcr.io/dirkwa/signalk-doctor-server:latest\n`,
  );
}

beforeEach(async () => {
  mockHead.mockReset();
  mockHead.mockResolvedValue(null);
  await rm(process.env.IMAGE_SOURCE_PATH as string, { force: true });
  await rm(images, { recursive: true, force: true });
  mkdirSync(images);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('resolveImageSource', () => {
  it('is registry when nothing is recorded, archive when the record matches the live ref', async () => {
    writeQuadlet('ghcr.io/dirkwa/signalk-server:2.24.0');
    expect(await resolveImageSource(Q)).toEqual({ source: 'registry' });
    await recordImageSource(Q, {
      ref: 'ghcr.io/dirkwa/signalk-server:2.24.0',
      source: 'archive',
      archive: 'a.tar',
      archiveMtimeMs: 1000,
    });
    expect(await resolveImageSource(Q)).toEqual({
      source: 'archive',
      archive: 'a.tar',
      archiveMtimeMs: 1000,
    });
    // Quadlet edited by hand / rolled back to another ref → registry again.
    writeQuadlet('ghcr.io/dirkwa/signalk-server:2.23.0');
    expect(await resolveImageSource(Q)).toEqual({ source: 'registry' });
  });
});

describe('resolveImageSource — history', () => {
  it('a rollback ref remembered as archive-sourced stays archive-sourced', async () => {
    const { recordImageSourceForRef } = await import('../src/image-source.js');
    writeQuadlet('ghcr.io/dirkwa/signalk-server:2.24.0');
    await recordImageSource(Q, {
      ref: 'ghcr.io/dirkwa/signalk-server:2.24.0',
      source: 'archive',
      archive: 'a.tar',
      archiveMtimeMs: 1000,
    });
    // Later a registry switch to 2.25.0…
    await recordImageSource(Q, { ref: 'ghcr.io/dirkwa/signalk-server:2.25.0', source: 'registry' });
    // …then a rollback re-applies 2.24.0 without knowing where it came from.
    await recordImageSourceForRef(Q, 'ghcr.io/dirkwa/signalk-server:2.24.0');
    expect(await resolveImageSource(Q)).toEqual({
      source: 'archive',
      archive: 'a.tar',
      archiveMtimeMs: 1000,
    });
    // An unknown ref falls back to registry.
    writeQuadlet('ghcr.io/dirkwa/signalk-server:1.0.0');
    await recordImageSourceForRef(Q, 'ghcr.io/dirkwa/signalk-server:1.0.0');
    expect(await resolveImageSource(Q)).toEqual({ source: 'registry' });
  });

  it('archive record without a usable mtime yields no update signal', async () => {
    writeQuadlet('ghcr.io/dirkwa/signalk-server:2.24.0');
    writeFileSync(join(images, 'some.tar'), 'x');
    writeFileSync(
      process.env.IMAGE_SOURCE_PATH as string,
      JSON.stringify({
        [Q]: {
          ref: 'ghcr.io/dirkwa/signalk-server:2.24.0',
          source: 'archive',
          archive: 'gone.tar',
        },
      }),
    );
    const r = await triggerCheck();
    expect(r.signalkServer).toMatchObject({ source: 'archive', updateAvailable: false });
    expect(r.signalkServer.availableArchive).toBeUndefined();
  });
});

describe('triggerCheck — signalk-server source awareness', () => {
  it('custom repo: asks GHCR about the fork repo from the Quadlet, not dirkwa', async () => {
    writeQuadlet('ghcr.io/fork/signalk-server:dirkwa');
    const r = await triggerCheck();
    expect(r.signalkServer.source).toBe('registry');
    expect(mockHead).toHaveBeenCalledWith('fork/signalk-server', 'dirkwa');
    expect(mockHead).not.toHaveBeenCalledWith('dirkwa/signalk-server', expect.anything());
    expect(r.signalkServer.updateAvailable).toBe(false);
    expect(r.signalkServer.availableArchive).toBeUndefined();
  });

  it('archive-sourced: never asks GHCR; flags only a newer file in the folder', async () => {
    writeQuadlet('ghcr.io/dirkwa/signalk-server:2.24.0');
    const T0 = Date.parse('2026-08-01T00:00:00Z');
    writeFileSync(join(images, 'current.tar'), 'x');
    utimesSync(join(images, 'current.tar'), new Date(T0), new Date(T0));
    await recordImageSource(Q, {
      ref: 'ghcr.io/dirkwa/signalk-server:2.24.0',
      source: 'archive',
      archive: 'current.tar',
      archiveMtimeMs: T0,
    });

    // The updater/doctor engines still do their own GHCR HEADs; the
    // signalk-server image must not appear among them.
    const signalkAsked = (): boolean =>
      mockHead.mock.calls.some(([img]) => String(img).endsWith('/signalk-server'));
    let r = await triggerCheck();
    expect(signalkAsked()).toBe(false);
    expect(r.signalkServer).toMatchObject({ source: 'archive', updateAvailable: false });
    expect(r.signalkServer.availableArchive).toBeUndefined();

    // A newer file appears → update available, named; still no GHCR.
    writeFileSync(join(images, 'newer.tar'), 'y');
    utimesSync(join(images, 'newer.tar'), new Date(T0 + 60_000), new Date(T0 + 60_000));
    r = await triggerCheck();
    expect(signalkAsked()).toBe(false);
    expect(r.signalkServer).toMatchObject({
      source: 'archive',
      updateAvailable: true,
      availableArchive: 'newer.tar',
    });

    // The same file name re-copied with newer content counts as new too
    // (mtime-based, not name-based).
    writeFileSync(join(images, 'current.tar'), 'x-rebuilt');
    utimesSync(join(images, 'current.tar'), new Date(T0 + 120_000), new Date(T0 + 120_000));
    r = await triggerCheck();
    expect(r.signalkServer.updateAvailable).toBe(true);
    expect(r.signalkServer.availableArchive).toBe('current.tar');
  });
});
