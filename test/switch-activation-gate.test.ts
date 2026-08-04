import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Flow-level guard: neither switch service may enter its rollback path while
 * the unit is still `activating`.
 *
 * `waitWhileActivating` returns `"activating"` when its OWN deadline expires —
 * the container create is genuinely still running. If the caller falls through
 * to rollback on that value it calls `stopUnitAndWait` on a unit mid-create,
 * which is exactly the damage the wait was added to prevent: systemd SIGTERMs
 * `podman run`, SIGKILLs it at TimeoutStopSec, and the orphaned incomplete
 * overlay layer wedges podman's global c/storage lock until someone SSHes in.
 *
 * The correct answer is hands-off. If we are not confident enough to stop the
 * start, we are not confident enough to call the image bad either — so the
 * Quadlet is left alone too, and the failure is reported as NOT rolled back.
 */

const mockDaemonReload = vi.fn();
const mockStartUnit = vi.fn();
const mockStopUnitAndWait = vi.fn();
const mockWaitWhileActivating = vi.fn();
// isSafeToStop is taken from the REAL module, not stubbed: the allowlist it
// encodes is the thing under test here. Stubbing it would let these tests pass
// against a gate that treats `unknown` as safe.
vi.mock('../src/dbus/systemd-user.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/dbus/systemd-user.js')>();
  return {
    isSafeToStop: actual.isSafeToStop,
    daemonReload: () => mockDaemonReload(),
    startUnit: (u: string) => mockStartUnit(u),
    stopUnitAndWait: (u: string) => mockStopUnitAndWait(u),
    waitWhileActivating: (u: string) => mockWaitWhileActivating(u),
  };
});

const mockRewriteQuadletImage = vi.fn();
const mockWriteLastGood = vi.fn();
vi.mock('../src/quadlet/rewriter.js', () => ({
  rewriteQuadletImage: (q: string, i: string) => mockRewriteQuadletImage(q, i),
  writeLastGood: (q: string, v: unknown) => mockWriteLastGood(q, v),
}));

const mockPollHealth = vi.fn();
vi.mock('../src/container-ops.js', () => ({
  DEFAULT_HEALTH_TIMEOUT_MS: 180_000,
  POST_SETTLE_HEALTH_TIMEOUT_MS: 60_000,
  pollHealth: (...a: unknown[]) => mockPollHealth(...a),
  pullImage: () => Promise.resolve({ ok: true }),
  trialRun: () => Promise.resolve({ ok: true }),
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

// Run the body straight through: these tests are about the flow, not locking.
vi.mock('../src/mutex.js', () => ({
  withMutex: (_op: string, fn: () => Promise<unknown>) => fn(),
  MutexBusyError: class MutexBusyError extends Error {},
}));

vi.mock('../src/backup.js', () => ({
  preSwitchBackup: () => Promise.resolve({ taken: false, reason: 'skipped' }),
}));

vi.mock('../src/switch-progress-broker.js', () => ({ publishSwitchEvent: vi.fn() }));
vi.mock('../src/drift-client.js', () => ({ refreshDoctorDrift: vi.fn() }));
vi.mock('../src/image-retention.js', () => ({ pruneOldImagesFor: vi.fn() }));
vi.mock('../src/update-checker.js', () => ({ invalidate: vi.fn() }));
vi.mock('../src/last-outcome.js', () => ({ recordOutcome: vi.fn() }));
vi.mock('../src/signalk-url-resolver.js', () => ({
  resolveSignalkHealthUrl: () => Promise.resolve('http://127.0.0.1/signalk'),
  resolveDoctorHealthUrl: () => Promise.resolve('http://127.0.0.1:3004/api/health'),
}));

function resetAll(): void {
  for (const m of [
    mockDaemonReload,
    mockStartUnit,
    mockStopUnitAndWait,
    mockWaitWhileActivating,
    mockRewriteQuadletImage,
    mockWriteLastGood,
    mockPollHealth,
  ]) {
    m.mockReset();
  }
  mockRewriteQuadletImage.mockResolvedValue({
    previousImage: 'ghcr.io/x/y:old',
    snapshotPath: '/s',
  });
  mockWriteLastGood.mockResolvedValue(undefined);
  mockDaemonReload.mockResolvedValue(undefined);
  mockStartUnit.mockResolvedValue(undefined);
  mockStopUnitAndWait.mockResolvedValue(undefined);
  // Health never comes up, so the flow always reaches the activation gate.
  mockPollHealth.mockResolvedValue(false);
}

describe('performSwitch — activation gate before rollback', () => {
  beforeEach(resetAll);

  it('does not stop the unit when activation never settles', async () => {
    const { performSwitch } = await import('../src/switch-service.js');
    mockWaitWhileActivating.mockResolvedValue('activating');

    const result = await performSwitch({ tag: 'new' });

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(false);
    // The message must name the state systemd actually reported, so an
    // operator reading it knows whether to wait or to investigate.
    expect(result.error).toMatch(/did not reach a settled state/i);
    expect(result.error).toContain('activating');
    // Both flows deliberately stop the unit ONCE in the normal restart
    // sequence before starting the new image. What must never happen is a
    // SECOND stop from the rollback path, landing on a live container create.
    expect(mockStopUnitAndWait).toHaveBeenCalledTimes(1);
    // And the Quadlet is left on the new tag — we are not confident enough to
    // stop the start, so we are not confident enough to revert it either.
    expect(mockRewriteQuadletImage).toHaveBeenCalledTimes(1);
  });

  // getActiveState returns 'unknown' whenever the busctl call itself fails. A
  // transient DBus hiccup must not be read as permission to stop a unit that
  // may still be mid-container-create.
  it('does not stop the unit when the state cannot be determined', async () => {
    const { performSwitch } = await import('../src/switch-service.js');
    mockWaitWhileActivating.mockResolvedValue('unknown');

    const result = await performSwitch({ tag: 'new' });

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(mockStopUnitAndWait).toHaveBeenCalledTimes(1);
    expect(mockRewriteQuadletImage).toHaveBeenCalledTimes(1);
  });

  it('still rolls back when the start genuinely failed', async () => {
    const { performSwitch } = await import('../src/switch-service.js');
    mockWaitWhileActivating.mockResolvedValue('failed');

    const result = await performSwitch({ tag: 'new' });

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    // Twice: the planned pre-start stop, then the rollback's stop — which is
    // now safe because the unit has settled out of `activating`.
    expect(mockStopUnitAndWait).toHaveBeenCalledTimes(2);
    expect(mockStopUnitAndWait).toHaveBeenCalledWith('signalk-server.service');
    // Quadlet rewritten twice: once to the new tag, once back to the old.
    expect(mockRewriteQuadletImage).toHaveBeenCalledTimes(2);
  });

  it('rolls back from inactive too — the start is provably over', async () => {
    const { performSwitch } = await import('../src/switch-service.js');
    mockWaitWhileActivating.mockResolvedValue('inactive');

    const result = await performSwitch({ tag: 'new' });

    expect(result.rolledBack).toBe(true);
    expect(mockStopUnitAndWait).toHaveBeenCalledTimes(2);
  });
});

describe('performDoctorSwitch — activation gate before rollback', () => {
  beforeEach(resetAll);

  it('does not stop the unit when activation never settles', async () => {
    const { performDoctorSwitch } = await import('../src/doctor-switch-service.js');
    mockWaitWhileActivating.mockResolvedValue('activating');

    const result = await performDoctorSwitch({ tag: 'new' });

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(false);
    // The message must name the state systemd actually reported, so an
    // operator reading it knows whether to wait or to investigate.
    expect(result.error).toMatch(/did not reach a settled state/i);
    expect(result.error).toContain('activating');
    expect(mockStopUnitAndWait).toHaveBeenCalledTimes(1);
    expect(mockRewriteQuadletImage).toHaveBeenCalledTimes(1);
  });

  it('does not stop the unit when the state cannot be determined', async () => {
    const { performDoctorSwitch } = await import('../src/doctor-switch-service.js');
    mockWaitWhileActivating.mockResolvedValue('unknown');

    const result = await performDoctorSwitch({ tag: 'new' });

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(mockStopUnitAndWait).toHaveBeenCalledTimes(1);
    expect(mockRewriteQuadletImage).toHaveBeenCalledTimes(1);
  });

  it('still rolls back when the start genuinely failed', async () => {
    const { performDoctorSwitch } = await import('../src/doctor-switch-service.js');
    mockWaitWhileActivating.mockResolvedValue('failed');

    const result = await performDoctorSwitch({ tag: 'new' });

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(mockStopUnitAndWait).toHaveBeenCalledTimes(2);
    expect(mockStopUnitAndWait).toHaveBeenCalledWith('signalk-doctor-server.service');
    expect(mockRewriteQuadletImage).toHaveBeenCalledTimes(2);
  });
});
