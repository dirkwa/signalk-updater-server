import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set OPERATION_LOCK before importing the server (which transitively
// imports the mutex, which reads the env at module-eval). One fixed temp
// dir for the file; reset the lock file between tests.
const dir = mkdtempSync(join(tmpdir(), 'lock-route-test-'));
const lockPath = join(dir, 'operation.lock');
const tokenPath = join(dir, 'token');
process.env.OPERATION_LOCK = lockPath;
// Point the data dir somewhere harmless too (session token reads /data).
process.env.DATA_DIR = dir;
// A real token file so requireToken can validate the bearer on the
// mutating /api/lock/clear route (otherwise it 503s "auth not init").
const TEST_TOKEN = 'lock-route-test-token';
writeFileSync(tokenPath, TEST_TOKEN);
process.env.TOKEN_PATH = tokenPath;

const { createServer } = await import('../src/server.js');
const { STALE_LOCK_MS } = await import('../src/mutex.js');

let app: Awaited<ReturnType<typeof createServer>>;

beforeAll(async () => {
  // One app for the file; the lock file is read fresh per request, so
  // each test just rewrites it. Avoids leaking N update-checker intervals.
  app = await createServer();
});

beforeEach(async () => {
  await rm(lockPath, { force: true });
});

afterAll(async () => {
  if (app) await app.close();
  delete process.env.OPERATION_LOCK;
  delete process.env.DATA_DIR;
  delete process.env.TOKEN_PATH;
  await rm(dir, { recursive: true, force: true });
});

describe('GET /api/lock', () => {
  it('reports no lock when nothing is running', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/lock' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { lock: unknown; stale: boolean };
    expect(body.lock).toBeNull();
    expect(body.stale).toBe(false);
  });

  it('reports a held lock as not-stale when fresh', async () => {
    await writeFile(
      lockPath,
      JSON.stringify({
        owner: 'updater',
        operation: 'doctor-switch',
        startedAt: new Date(Date.now() - 5_000).toISOString(),
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/lock' });
    const body = res.json() as { lock: { operation: string } | null; stale: boolean };
    expect(body.lock?.operation).toBe('doctor-switch');
    expect(body.stale).toBe(false);
  });

  it('flags an old lock as stale', async () => {
    await writeFile(
      lockPath,
      JSON.stringify({
        owner: 'updater',
        operation: 'doctor-switch',
        startedAt: new Date(Date.now() - (STALE_LOCK_MS + 60_000)).toISOString(),
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/lock' });
    const body = res.json() as { stale: boolean; ageMs: number | null };
    expect(body.stale).toBe(true);
    expect(body.ageMs).toBeGreaterThan(STALE_LOCK_MS);
  });
});

describe('POST /api/lock/clear', () => {
  it('rejects without a bearer token', async () => {
    await writeFile(
      lockPath,
      JSON.stringify({
        owner: 'updater',
        operation: 'doctor-switch',
        startedAt: new Date().toISOString(),
      }),
    );
    const res = await app.inject({ method: 'POST', url: '/api/lock/clear' });
    expect(res.statusCode).toBe(401);
    // The lock must survive an unauthorized clear attempt.
    const after = await app.inject({ method: 'GET', url: '/api/lock' });
    expect((after.json() as { lock: unknown }).lock).not.toBeNull();
  });

  it('clears the lock and returns the cleared info with a valid token', async () => {
    await writeFile(
      lockPath,
      JSON.stringify({
        owner: 'updater',
        operation: 'doctor-switch',
        startedAt: new Date().toISOString(),
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/lock/clear',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; cleared: { operation: string } | null };
    expect(body.ok).toBe(true);
    expect(body.cleared?.operation).toBe('doctor-switch');
    // Lock is gone afterward.
    const after = await app.inject({ method: 'GET', url: '/api/lock' });
    expect((after.json() as { lock: unknown }).lock).toBeNull();
  });

  it('is a no-op (ok, cleared:null) when no lock is held', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/lock/clear',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; cleared: unknown };
    expect(body.ok).toBe(true);
    expect(body.cleared).toBeNull();
  });
});
