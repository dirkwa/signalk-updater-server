import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { AvailableUpdates, CurrentState, ContainerSnapshot } from '../src/types.js';
import type { LockInfo } from '../src/types.js';
import type { OperationOutcome } from '../src/last-outcome.js';

// Mock the three source modules the route reads, so the test drives the
// aggregation deterministically without podman / a real lock file.
const { getCachedUpdates } = vi.hoisted(() => ({ getCachedUpdates: vi.fn() }));
const { getCurrentState } = vi.hoisted(() => ({ getCurrentState: vi.fn() }));
const { readLock } = vi.hoisted(() => ({ readLock: vi.fn() }));
const { getLastOutcomes } = vi.hoisted(() => ({ getLastOutcomes: vi.fn() }));

vi.mock('../src/update-checker.js', () => ({ getCachedUpdates }));
vi.mock('../src/state.js', () => ({ getCurrentState }));
vi.mock('../src/mutex.js', () => ({ readLock, STALE_LOCK_MS: 10 * 60 * 1000 }));
vi.mock('../src/last-outcome.js', () => ({ getLastOutcomes }));

const { registerUpdaterStatusRoutes } = await import('../src/routes/updater-status.js');

function snap(state: ContainerSnapshot['state']): ContainerSnapshot {
  return { tag: 'x', digest: 'd', version: '1.0.0', channel: 'stable', state };
}

const UPDATES: AvailableUpdates = {
  signalkServer: { currentTag: '1', updateAvailable: false, imageState: 'in-sync' },
  updater: { currentTag: '1', updateAvailable: false, imageState: 'in-sync' },
  doctor: { currentTag: '1', updateAvailable: false, imageState: 'in-sync' },
  lastCheckedAt: null,
};
const CURRENT: CurrentState = {
  signalkServer: snap('running'),
  updaterServer: { ...snap('running'), updateAvailable: false },
  doctorServer: snap('running'),
  lastCheck: '2026-01-01T00:00:00Z',
};

async function makeApp() {
  const app = Fastify();
  await registerUpdaterStatusRoutes(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  getCachedUpdates.mockReturnValue(UPDATES);
  getCurrentState.mockResolvedValue(CURRENT);
  readLock.mockResolvedValue(null);
  getLastOutcomes.mockReturnValue([] as OperationOutcome[]);
});

describe('GET /api/updater-status', () => {
  it('returns a doctor-shaped all-ok payload with no token (read route)', async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/updater-status' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        results: { id: string; status: string }[];
        summary: Record<string, number>;
      };
      expect(body.summary.warn).toBe(0);
      expect(body.summary.fail).toBe(0);
      expect(body.results.some((r) => r.id === 'update-available-updater')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('surfaces a stale lock and a failed last-operation as warn/fail', async () => {
    const lock: LockInfo = {
      owner: 'updater',
      operation: 'switch',
      // 20 minutes ago → stale (STALE_LOCK_MS = 10m)
      startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    };
    readLock.mockResolvedValue(lock);
    getLastOutcomes.mockReturnValue([
      { operation: 'self-update', ok: false, at: '2026-07-27T00:00:00Z', error: 'pull failed' },
    ]);
    const app = await makeApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/updater-status' });
      const body = res.json() as { results: { id: string; status: string; message: string }[] };
      const stale = body.results.find((r) => r.id === 'stale-lock');
      const fail = body.results.find((r) => r.id === 'last-self-update');
      expect(stale?.status).toBe('warn');
      expect(fail?.status).toBe('fail');
      expect(fail?.message).toContain('pull failed');
    } finally {
      await app.close();
    }
  });

  it('does not flag a fresh lock as stale', async () => {
    readLock.mockResolvedValue({
      owner: 'updater',
      operation: 'switch',
      startedAt: new Date().toISOString(),
    } as LockInfo);
    const app = await makeApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/updater-status' });
      const body = res.json() as { results: { id: string }[] };
      expect(body.results.some((r) => r.id === 'stale-lock')).toBe(false);
    } finally {
      await app.close();
    }
  });
});
