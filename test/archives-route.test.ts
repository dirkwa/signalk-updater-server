import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'archives-route-'));
const TEST_TOKEN = 'archives-route-token';
writeFileSync(join(dir, 'token'), TEST_TOKEN);
process.env.TOKEN_PATH = join(dir, 'token');
process.env.DATA_DIR = dir;
process.env.VERSION_SETTINGS_PATH = join(dir, 'version-settings.json');

// The route is thin glue over local-archives + switch-service; mock both so
// the test pins the HTTP contract (validation, status codes, what gets
// dispatched) without podman.
const mockList = vi.fn();
const mockLoad = vi.fn();
const mockDelete = vi.fn();
vi.mock('../src/local-archives.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/local-archives.js')>();
  return {
    isValidArchiveName: actual.isValidArchiveName,
    pickArchiveRef: actual.pickArchiveRef,
    listArchives: () => mockList(),
    loadArchive: (name: string, onProgress?: (p: unknown) => void) => mockLoad(name, onProgress),
    deleteArchive: (name: string) => mockDelete(name),
  };
});
const mockPerformSwitch = vi.fn();
vi.mock('../src/switch-service.js', () => ({
  performSwitch: (input: unknown) => mockPerformSwitch(input),
}));
vi.mock('../src/mutex.js', () => ({
  withMutex: async (_op: string, fn: () => Promise<unknown>) => fn(),
  MutexBusyError: class MutexBusyError extends Error {},
}));
const events: Array<{ stage: string; to?: string; message?: string; error?: string }> = [];
vi.mock('../src/switch-progress-broker.js', () => ({
  publishSwitchEvent: (ev: { stage: string; to?: string; message?: string; error?: string }) =>
    events.push(ev),
}));

const { registerArchiveRoutes } = await import('../src/routes/archives.js');

let app: ReturnType<typeof Fastify>;
const auth = { authorization: `Bearer ${TEST_TOKEN}` };

const archive = (over: Partial<Record<string, unknown>> = {}) => ({
  name: 'sk.tar',
  size: 10,
  mtime: '2026-08-17T00:00:00.000Z',
  format: 'tar',
  refs: ['ghcr.io/dirkwa/signalk-server:2.24.0'],
  imageId: null,
  loaded: true,
  ...over,
});

beforeAll(async () => {
  app = Fastify();
  await registerArchiveRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  delete process.env.TOKEN_PATH;
  delete process.env.DATA_DIR;
  delete process.env.VERSION_SETTINGS_PATH;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  events.length = 0;
  mockList.mockReset();
  mockList.mockResolvedValue({ dir: '/data/images', archives: [archive()] });
  mockLoad.mockReset();
  mockLoad.mockResolvedValue({
    ok: true,
    refs: ['ghcr.io/dirkwa/signalk-server:2.24.0'],
    imageId: null,
  });
  mockDelete.mockReset();
  mockDelete.mockResolvedValue(true);
  mockPerformSwitch.mockReset();
  mockPerformSwitch.mockResolvedValue({ ok: true, rolledBack: false });
});

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe('GET /api/versions/archives', () => {
  it('returns the listing without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/versions/archives' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dir: '/data/images', archives: [archive()] });
  });
});

describe('POST /api/versions/archives/load', () => {
  it('requires a bearer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/versions/archives/load',
      payload: { name: 'sk.tar' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects names that are not bare archive file names', async () => {
    for (const name of ['../sk.tar', 'a/b.tar', 'sk.zip', 42, undefined]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/versions/archives/load',
        headers: auth,
        payload: { name },
      });
      expect(res.statusCode, String(name)).toBe(400);
    }
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('404s for a name not in the folder', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/versions/archives/load',
      headers: auth,
      payload: { name: 'other.tar' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('202s and streams loading → complete over the broker', async () => {
    mockLoad.mockImplementation(async (_n: string, onProgress?: (p: unknown) => void) => {
      onProgress?.({ bytesRead: 5, totalBytes: 10 });
      return { ok: true, refs: ['ghcr.io/dirkwa/signalk-server:2.24.0'], imageId: null };
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/versions/archives/load',
      headers: auth,
      payload: { name: 'sk.tar' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, accepted: true, name: 'sk.tar' });
    await flush();
    expect(mockLoad).toHaveBeenCalledWith('sk.tar', expect.any(Function));
    // initial 'loading' (the progress tick is throttled to ≥1.5 s, so a
    // fast load emits none), then 'complete'
    expect(events.map((e) => e.stage)).toEqual(['loading', 'complete']);
    expect(events.at(-1)?.message).toMatch(/Loaded ghcr\.io\/dirkwa\/signalk-server:2\.24\.0/);
  });

  it('reports a load failure as a failed event', async () => {
    mockLoad.mockResolvedValue({ ok: false, error: 'boom' });
    await app.inject({
      method: 'POST',
      url: '/api/versions/archives/load',
      headers: auth,
      payload: { name: 'sk.tar' },
    });
    await flush();
    expect(events.at(-1)).toMatchObject({ stage: 'failed', error: 'load failed: boom' });
  });
});

describe('POST /api/versions/archives/switch', () => {
  it('dispatches performSwitch with the archive ref, skipPull and provenance', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/versions/archives/switch',
      headers: auth,
      payload: { name: 'sk.tar', skipBackup: true },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      ok: true,
      accepted: true,
      to: '2.24.0',
      image: 'ghcr.io/dirkwa/signalk-server:2.24.0',
    });
    await flush();
    expect(mockPerformSwitch).toHaveBeenCalledWith({
      tag: '2.24.0',
      image: 'ghcr.io/dirkwa/signalk-server:2.24.0',
      skipPull: true,
      skipBackup: true,
      source: { kind: 'archive', name: 'sk.tar', mtimeMs: Date.parse('2026-08-17T00:00:00.000Z') },
    });
  });

  it('409s when the archive is not loaded, and when it carries no ref', async () => {
    mockList.mockResolvedValue({ dir: '/data/images', archives: [archive({ loaded: false })] });
    let res = await app.inject({
      method: 'POST',
      url: '/api/versions/archives/switch',
      headers: auth,
      payload: { name: 'sk.tar' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/load the archive first/i);

    mockList.mockResolvedValue({ dir: '/data/images', archives: [archive({ refs: [] })] });
    res = await app.inject({
      method: 'POST',
      url: '/api/versions/archives/switch',
      headers: auth,
      payload: { name: 'sk.tar' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/no repository:tag/i);
    expect(mockPerformSwitch).not.toHaveBeenCalled();
  });

  it('never accepts a client-supplied image ref', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/versions/archives/switch',
      headers: auth,
      payload: { name: 'sk.tar', image: 'ghcr.io/evil/x:1' },
    });
    expect(res.statusCode).toBe(202);
    await flush();
    expect(mockPerformSwitch.mock.calls[0]?.[0]).toMatchObject({
      image: 'ghcr.io/dirkwa/signalk-server:2.24.0',
    });
  });

  it('turns a mutex-busy rejection into a failed event', async () => {
    const { MutexBusyError } = await import('../src/mutex.js');
    mockPerformSwitch.mockRejectedValue(new MutexBusyError('busy'));
    await app.inject({
      method: 'POST',
      url: '/api/versions/archives/switch',
      headers: auth,
      payload: { name: 'sk.tar' },
    });
    await flush();
    expect(events.at(-1)).toMatchObject({
      stage: 'failed',
      error: expect.stringMatching(/in progress/),
    });
  });
});

describe('DELETE /api/versions/archives/:name', () => {
  it('204 on success, 404 when missing, 400 on a bad name, 401 without token', async () => {
    let res = await app.inject({
      method: 'DELETE',
      url: '/api/versions/archives/sk.tar',
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith('sk.tar');

    mockDelete.mockResolvedValue(false);
    res = await app.inject({
      method: 'DELETE',
      url: '/api/versions/archives/nope.tar',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);

    res = await app.inject({
      method: 'DELETE',
      url: '/api/versions/archives/..%2Fsk.tar',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'DELETE', url: '/api/versions/archives/sk.tar' });
    expect(res.statusCode).toBe(401);
  });
});
