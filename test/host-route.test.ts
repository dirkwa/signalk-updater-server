import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';

// Mock the busctl shell-out layer: these tests drive availability, the lock
// guard and outcome reporting, not DBus itself. Same seam as
// lifecycle-route.test.ts.
const mockStartUnit = vi.fn();
const mockStopUnitAndWait = vi.fn();
const mockResetFailedUnit = vi.fn();
const mockGetActiveState = vi.fn();
const mockGetLoadState = vi.fn();
vi.mock('../src/dbus/systemd-user.js', () => ({
  startUnit: (u: string) => mockStartUnit(u),
  stopUnitAndWait: (u: string) => mockStopUnitAndWait(u),
  resetFailedUnit: (u: string) => mockResetFailedUnit(u),
  getActiveState: (u: string) => mockGetActiveState(u),
  getLoadState: (u: string) => mockGetLoadState(u),
}));

vi.mock('../src/podman/client.js', () => ({
  safe: async (fn: () => Promise<unknown>) => {
    try {
      return { ok: true as const, value: await fn() };
    } catch (err) {
      return { ok: false as const, error: { kind: 'unknown', userMessage: String(err), raw: '' } };
    }
  },
}));

class MockMutexBusyError extends Error {
  constructor(public lock: { operation: string }) {
    super('busy');
  }
}
const mockWithMutex = vi.fn();
vi.mock('../src/mutex.js', () => ({
  withMutex: (op: string, fn: () => Promise<unknown>) => mockWithMutex(op, fn),
  MutexBusyError: MockMutexBusyError,
}));

vi.mock('../src/auth.js', () => ({
  requireToken: async () => {},
}));

const { registerHostRoutes, runPowerUnit } = await import('../src/routes/host.js');

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify();
  await registerHostRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLoadState.mockResolvedValue('loaded');
  mockWithMutex.mockImplementation((_op: string, fn: () => Promise<unknown>) => fn());
  mockStartUnit.mockResolvedValue(undefined);
  mockStopUnitAndWait.mockResolvedValue(undefined);
  mockResetFailedUnit.mockResolvedValue(undefined);
});

describe('GET /api/host/power', () => {
  it('is available when both power units are loaded', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/host/power' });
    expect(res.json()).toEqual({ available: true });
    expect(mockGetLoadState).toHaveBeenCalledWith('signalk-poweroff.service');
    expect(mockGetLoadState).toHaveBeenCalledWith('signalk-reboot.service');
  });

  it('is unavailable when a unit is missing (podman machine, old install)', async () => {
    mockGetLoadState.mockImplementation(async (u: string) =>
      u === 'signalk-reboot.service' ? 'not-found' : 'loaded',
    );
    const res = await app.inject({ method: 'GET', url: '/api/host/power' });
    expect(res.json()).toEqual({ available: false });
  });
});

describe('POST /api/host/{poweroff,reboot}', () => {
  it('runs the matching unit under the lock and reports success once it is active', async () => {
    mockGetActiveState
      .mockResolvedValueOnce('inactive')
      .mockResolvedValueOnce('inactive')
      .mockResolvedValueOnce('activating')
      .mockResolvedValue('active');
    const res = await app.inject({ method: 'POST', url: '/api/host/reboot' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mockWithMutex).toHaveBeenCalledWith('host-power', expect.any(Function));
    expect(mockResetFailedUnit).toHaveBeenCalledWith('signalk-reboot.service');
    expect(mockStopUnitAndWait).not.toHaveBeenCalled();
    expect(mockStartUnit).toHaveBeenCalledWith('signalk-reboot.service');
  });

  it('stops a unit an earlier request left active before starting it again', async () => {
    mockGetActiveState.mockResolvedValueOnce('active').mockResolvedValue('failed');
    const res = await app.inject({ method: 'POST', url: '/api/host/poweroff' });
    expect(mockStopUnitAndWait).toHaveBeenCalledWith('signalk-poweroff.service');
    const stopOrder = mockStopUnitAndWait.mock.invocationCallOrder[0] ?? Infinity;
    const startOrder = mockStartUnit.mock.invocationCallOrder[0] ?? -Infinity;
    expect(stopOrder).toBeLessThan(startOrder);
    // The earlier `active` is not taken for this request's outcome.
    expect(res.statusCode).toBe(502);
  });

  it('answers 502 with the journal hint when the host refuses', async () => {
    mockGetActiveState.mockResolvedValue('failed');
    const res = await app.inject({ method: 'POST', url: '/api/host/poweroff' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('journalctl --user -u signalk-poweroff.service');
  });

  it('answers 404 and starts nothing when the units are not set up', async () => {
    mockGetLoadState.mockResolvedValue('not-found');
    const res = await app.inject({ method: 'POST', url: '/api/host/poweroff' });
    expect(res.statusCode).toBe(404);
    expect(mockStartUnit).not.toHaveBeenCalled();
  });

  it('answers 409 and starts nothing while another operation holds the lock', async () => {
    mockWithMutex.mockRejectedValue(new MockMutexBusyError({ operation: 'switch' }));
    const res = await app.inject({ method: 'POST', url: '/api/host/poweroff' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('switch');
    expect(mockStartUnit).not.toHaveBeenCalled();
  });

  it('answers 502 when the start call itself fails', async () => {
    mockGetActiveState.mockResolvedValue('inactive');
    mockStartUnit.mockRejectedValue(new Error('busctl StartUnit failed'));
    const res = await app.inject({ method: 'POST', url: '/api/host/reboot' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('busctl StartUnit failed');
  });
});

describe('runPowerUnit', () => {
  it('keeps polling through a queued (inactive) job and returns the last state when the window closes', async () => {
    mockGetActiveState.mockResolvedValue('inactive');
    await expect(runPowerUnit('signalk-poweroff.service', 20, 5)).resolves.toBe('inactive');
  });
});
