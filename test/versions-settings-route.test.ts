import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Env before importing: version-settings.ts resolves VERSION_SETTINGS_PATH
// and auth.ts resolves TOKEN_PATH at module-eval. Same pattern as
// doctor-update-route.test.ts. The settings file is REAL (tmp dir) so the
// atomic writer + re-read round-trip is exercised, not mocked.
const dir = mkdtempSync(join(tmpdir(), 'versions-settings-route-'));
process.env.DATA_DIR = dir;
process.env.VERSION_SETTINGS_PATH = join(dir, 'version-settings.json');
const TEST_TOKEN = 'versions-settings-test-token';
writeFileSync(join(dir, 'token'), TEST_TOKEN);
process.env.TOKEN_PATH = join(dir, 'token');
const prevSignalkImage = process.env.SIGNALK_IMAGE;
delete process.env.SIGNALK_IMAGE;

// GHCR + podman seams. listTags records the image it was asked for so we
// can assert the repo setting actually steers the listing.
const mockListTags = vi.fn();
vi.mock('../src/ghcr.js', () => ({
  listTags: (image: string, opts?: unknown) => mockListTags(image, opts),
  clearListTagsCache: vi.fn(),
}));
const mockListLocal = vi.fn();
vi.mock('../src/local-images.js', () => ({
  listLocalImagesFor: (prefixes: string[]) => mockListLocal(prefixes),
}));
const mockPullImage = vi.fn();
vi.mock('../src/container-ops.js', () => ({
  pullImage: (ref: string, onProgress?: unknown) => mockPullImage(ref, onProgress),
}));
vi.mock('../src/mutex.js', () => ({
  withMutex: async (_op: string, fn: () => Promise<unknown>) => fn(),
  MutexBusyError: class MutexBusyError extends Error {},
}));
const mockPublish = vi.fn();
vi.mock('../src/switch-progress-broker.js', () => ({
  publishSwitchEvent: (ev: unknown) => mockPublish(ev),
}));

const { registerVersionRoutes } = await import('../src/routes/versions.js');
const { BUILTIN_SIGNALK_IMAGE } = await import('../src/signalk-image.js');

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify();
  await registerVersionRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  delete process.env.DATA_DIR;
  delete process.env.VERSION_SETTINGS_PATH;
  delete process.env.TOKEN_PATH;
  if (prevSignalkImage === undefined) delete process.env.SIGNALK_IMAGE;
  else process.env.SIGNALK_IMAGE = prevSignalkImage;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  mockListTags.mockReset();
  mockListTags.mockResolvedValue({ ok: true, cachedAt: '2026-08-17T00:00:00Z', tags: [] });
  mockListLocal.mockReset();
  mockListLocal.mockResolvedValue({ images: [] });
  mockPullImage.mockReset();
  mockPullImage.mockResolvedValue({ ok: true });
  mockPublish.mockReset();
  // Start every test from "no override".
  await rm(process.env.VERSION_SETTINGS_PATH as string, { force: true });
});

const auth = { authorization: `Bearer ${TEST_TOKEN}` };

async function putSettings(body: unknown, headers: Record<string, string> = auth) {
  return app.inject({ method: 'PUT', url: '/api/versions/settings', headers, payload: body });
}

describe('GET /api/versions/settings', () => {
  it('reports the built-in default with no override stored', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/versions/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      showBeta: false,
      showMaster: false,
      imageRepo: null,
      effectiveImageRepo: BUILTIN_SIGNALK_IMAGE,
      imageRepoSource: 'default',
      defaultImageRepo: BUILTIN_SIGNALK_IMAGE,
    });
  });
});

describe('PUT /api/versions/settings imageRepo', () => {
  it('stores the canonical form and reports it as the effective repo', async () => {
    const res = await putSettings({ imageRepo: 'Someone/SignalK-Server/' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      imageRepo: 'ghcr.io/someone/signalk-server',
      effectiveImageRepo: 'ghcr.io/someone/signalk-server',
      imageRepoSource: 'setting',
      defaultImageRepo: BUILTIN_SIGNALK_IMAGE,
    });
    // Round-trips through the real file.
    const onDisk = JSON.parse(await readFile(process.env.VERSION_SETTINGS_PATH as string, 'utf8'));
    expect(onDisk.imageRepo).toBe('ghcr.io/someone/signalk-server');
    const get = await app.inject({ method: 'GET', url: '/api/versions/settings' });
    expect(get.json().effectiveImageRepo).toBe('ghcr.io/someone/signalk-server');
  });

  it('rejects an invalid repo with 400 and leaves the stored value alone', async () => {
    await putSettings({ imageRepo: 'ghcr.io/someone/signalk-server' });
    const res = await putSettings({ imageRepo: 'docker.io/library/nginx' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/only ghcr\.io/i);
    const get = await app.inject({ method: 'GET', url: '/api/versions/settings' });
    expect(get.json().imageRepo).toBe('ghcr.io/someone/signalk-server');
  });

  it('rejects a tagged ref', async () => {
    const res = await putSettings({ imageRepo: 'ghcr.io/someone/signalk-server:latest' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/tag/i);
  });

  it('clears the override on null and on empty string', async () => {
    await putSettings({ imageRepo: 'ghcr.io/someone/signalk-server' });
    let res = await putSettings({ imageRepo: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ imageRepo: null, imageRepoSource: 'default' });

    await putSettings({ imageRepo: 'ghcr.io/someone/signalk-server' });
    res = await putSettings({ imageRepo: '' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ imageRepo: null, imageRepoSource: 'default' });
  });

  it('ignores non-string/non-null imageRepo and unknown keys, keeps the boolean whitelist', async () => {
    const res = await putSettings({ imageRepo: 42, showBeta: true, bogus: 'x' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      imageRepo: null,
      showBeta: true,
      imageRepoSource: 'default',
    });
    const onDisk = JSON.parse(await readFile(process.env.VERSION_SETTINGS_PATH as string, 'utf8'));
    expect(onDisk).not.toHaveProperty('bogus');
  });

  it('requires a bearer token', async () => {
    const res = await putSettings({ imageRepo: 'ghcr.io/someone/signalk-server' }, {});
    expect(res.statusCode).toBe(401);
  });
});

describe('the repo setting steers the other versions routes', () => {
  it('lists tags and local images from the configured repo (path form)', async () => {
    await putSettings({ imageRepo: 'ghcr.io/someone/signalk-server' });
    const res = await app.inject({ method: 'GET', url: '/api/versions' });
    expect(res.statusCode).toBe(200);
    expect(mockListTags).toHaveBeenCalledWith('someone/signalk-server', { force: false });
    expect(mockListLocal).toHaveBeenCalledWith(['someone/signalk-server']);

    mockListLocal.mockClear();
    await app.inject({ method: 'GET', url: '/api/versions/local' });
    expect(mockListLocal).toHaveBeenCalledWith(['someone/signalk-server']);
  });

  it('falls back to the default repo when the override is cleared', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/versions' });
    expect(res.statusCode).toBe(200);
    expect(mockListTags).toHaveBeenCalledWith('dirkwa/signalk-server', { force: false });
  });

  it('pre-pulls the full ref from the configured repo', async () => {
    await putSettings({ imageRepo: 'ghcr.io/someone/signalk-server' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/versions/pull',
      headers: auth,
      payload: { tag: 'v2.24.0' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().image).toBe('ghcr.io/someone/signalk-server:v2.24.0');
    // The background pull is fire-and-forget; give it a tick to dispatch.
    await vi.waitFor(() => {
      expect(mockPullImage).toHaveBeenCalledWith(
        'ghcr.io/someone/signalk-server:v2.24.0',
        expect.any(Function),
      );
    });
  });
});
