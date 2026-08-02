import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';

// Mock the busctl shell-out layer: these tests drive the route/observe logic
// (latch clearing, outcome reporting), not DBus itself. Same seam style as
// image-drift.test.ts.
const mockStartUnit = vi.fn();
const mockStopUnit = vi.fn();
const mockRestartUnit = vi.fn();
const mockDaemonReload = vi.fn();
const mockStopUnitAndWait = vi.fn();
const mockResetFailedUnit = vi.fn();
const mockGetActiveState = vi.fn();
vi.mock('../src/dbus/systemd-user.js', () => ({
  startUnit: (u: string) => mockStartUnit(u),
  stopUnit: (u: string) => mockStopUnit(u),
  restartUnit: (u: string) => mockRestartUnit(u),
  daemonReload: () => mockDaemonReload(),
  stopUnitAndWait: (u: string) => mockStopUnitAndWait(u),
  resetFailedUnit: (u: string) => mockResetFailedUnit(u),
  getActiveState: (u: string) => mockGetActiveState(u),
}));

const mockResolveRuntime = vi.fn();
vi.mock('../src/podman/client.js', () => ({
  resolveRuntime: () => mockResolveRuntime(),
  // Forward-through safe(): surfaces thrown errors as !ok, like the real one.
  safe: async (fn: () => Promise<unknown>) => {
    try {
      return { ok: true as const, value: await fn() };
    } catch (err) {
      return { ok: false as const, error: { kind: 'unknown', userMessage: String(err), raw: '' } };
    }
  },
}));

const mockSetQuadletBootStart = vi.fn();
vi.mock('../src/quadlet/rewriter.js', () => ({
  setQuadletBootStart: (q: string, enabled: boolean) => mockSetQuadletBootStart(q, enabled),
}));

vi.mock('../src/mutex.js', () => ({
  withMutex: async (_op: string, fn: () => Promise<unknown>) => fn(),
  MutexBusyError: class MutexBusyError extends Error {},
}));

vi.mock('../src/auth.js', () => ({
  requireToken: async () => {},
}));

const { registerLifecycleRoutes, startUnitAndObserve } = await import('../src/routes/lifecycle.js');

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify();
  await registerLifecycleRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// A dockerode-shaped runtime whose signalk-server inspect reports `running`.
function runtimeWithRunning(running: boolean): unknown {
  return {
    client: {
      getContainer: () => ({ inspect: async () => ({ State: { Running: running } }) }),
    },
  };
}

// invocationCallOrder with strict-TS defaults: a missing call collapses the
// comparison to a guaranteed failure instead of a non-null assertion.
function firstCallOrder(fn: ReturnType<typeof vi.fn>, whenMissing: number): number {
  return fn.mock.invocationCallOrder[0] ?? whenMissing;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: runtime unreachable (containerRunning → null, treated as "not
  // provably running", so start paths proceed), quadlet already resumed,
  // start settles to active on the first observation.
  mockResolveRuntime.mockResolvedValue(null);
  mockSetQuadletBootStart.mockResolvedValue({ changed: false });
  mockResetFailedUnit.mockResolvedValue(undefined);
  mockStartUnit.mockResolvedValue(undefined);
  mockStopUnit.mockResolvedValue(undefined);
  mockRestartUnit.mockResolvedValue(undefined);
  mockDaemonReload.mockResolvedValue(undefined);
  mockStopUnitAndWait.mockResolvedValue(undefined);
  mockGetActiveState.mockResolvedValue('active');
});

describe('startUnitAndObserve', () => {
  it('starts, then observes until active', async () => {
    mockGetActiveState.mockResolvedValueOnce('activating').mockResolvedValueOnce('active');
    const state = await startUnitAndObserve('signalk-server.service', 1_000, 5);
    expect(state).toBe('active');
    expect(mockStartUnit).toHaveBeenCalledWith('signalk-server.service');
    expect(firstCallOrder(mockStartUnit, Number.POSITIVE_INFINITY)).toBeLessThan(
      firstCallOrder(mockGetActiveState, Number.NEGATIVE_INFINITY),
    );
  });

  it('returns failed as soon as the unit reports it', async () => {
    mockGetActiveState.mockResolvedValue('failed');
    const state = await startUnitAndObserve('signalk-server.service', 1_000, 5);
    expect(state).toBe('failed');
    expect(mockGetActiveState).toHaveBeenCalledTimes(1);
  });

  it('window expiry is not an error: returns the last observed state', async () => {
    // Fake timers: with a real 40 ms window a loaded CI box can stall after
    // the first observation, leaving only one getActiveState call and a
    // flaky assertion. Advancing the mocked clock walks the poll loop
    // deterministically to the deadline (cr finding on this PR).
    vi.useFakeTimers();
    try {
      mockGetActiveState.mockResolvedValue('activating');
      const statePromise = startUnitAndObserve('signalk-server.service', 40, 5);
      await vi.advanceTimersByTimeAsync(40);
      const state = await statePromise;
      expect(state).toBe('activating');
      expect(mockGetActiveState.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a StartUnit failure', async () => {
    mockStartUnit.mockRejectedValue(new Error('busctl StartUnit failed'));
    await expect(startUnitAndObserve('signalk-server.service', 40, 5)).rejects.toThrow(
      'StartUnit failed',
    );
    expect(mockGetActiveState).not.toHaveBeenCalled();
  });
});

describe('POST /api/signalk/resume', () => {
  it('clears a start-limit latch before issuing the start', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/signalk/resume' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, state: 'active' });
    expect(mockResetFailedUnit).toHaveBeenCalledWith('signalk-server.service');
    expect(firstCallOrder(mockResetFailedUnit, Number.POSITIVE_INFINITY)).toBeLessThan(
      firstCallOrder(mockStartUnit, Number.NEGATIVE_INFINITY),
    );
  });

  it('answers 502 when the unit lands in failed instead of 2xx-and-hope', async () => {
    mockGetActiveState.mockResolvedValue('failed');
    const res = await app.inject({ method: 'POST', url: '/api/signalk/resume' });
    expect(res.statusCode).toBe(502);
    const body = res.json() as { ok: boolean; error?: string; state?: string };
    expect(body.ok).toBe(false);
    expect(body.state).toBe('failed');
    expect(body.error).toMatch(/failed state/);
  });

  it('still starts when reset-failed itself errors (best-effort)', async () => {
    mockResetFailedUnit.mockRejectedValue(new Error('NoSuchUnit'));
    const res = await app.inject({ method: 'POST', url: '/api/signalk/resume' });
    expect(res.statusCode).toBe(200);
    expect(mockStartUnit).toHaveBeenCalled();
  });

  it('no-ops without touching the unit when already running', async () => {
    mockResolveRuntime.mockResolvedValue(runtimeWithRunning(true));
    const res = await app.inject({ method: 'POST', url: '/api/signalk/resume' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, noop: true });
    expect(mockResetFailedUnit).not.toHaveBeenCalled();
    expect(mockStartUnit).not.toHaveBeenCalled();
  });

  it('answers 502 when restoring boot-start fails, without starting', async () => {
    mockSetQuadletBootStart.mockRejectedValue(new Error('EROFS'));
    const res = await app.inject({ method: 'POST', url: '/api/signalk/resume' });
    expect(res.statusCode).toBe(502);
    expect(mockStartUnit).not.toHaveBeenCalled();
  });
});

describe('POST /api/signalk/start', () => {
  it('clears the latch, then reports the observed state', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/signalk/start' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, state: 'active' });
    expect(firstCallOrder(mockResetFailedUnit, Number.POSITIVE_INFINITY)).toBeLessThan(
      firstCallOrder(mockStartUnit, Number.NEGATIVE_INFINITY),
    );
  });

  it('answers 502 when the start lands in failed', async () => {
    mockGetActiveState.mockResolvedValue('failed');
    const res = await app.inject({ method: 'POST', url: '/api/signalk/start' });
    expect(res.statusCode).toBe(502);
  });
});

describe('POST /api/signalk/stop', () => {
  it('never touches reset-failed on the way down', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/signalk/stop' });
    expect(res.statusCode).toBe(200);
    expect(mockStopUnit).toHaveBeenCalledWith('signalk-server.service');
    expect(mockResetFailedUnit).not.toHaveBeenCalled();
  });
});

describe('POST /api/signalk/restart', () => {
  it('clears the latch before RestartUnit (its start half is refusable too)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/signalk/restart' });
    expect(res.statusCode).toBe(200);
    expect(mockRestartUnit).toHaveBeenCalledWith('signalk-server.service');
    expect(firstCallOrder(mockResetFailedUnit, Number.POSITIVE_INFINITY)).toBeLessThan(
      firstCallOrder(mockRestartUnit, Number.NEGATIVE_INFINITY),
    );
  });
});
