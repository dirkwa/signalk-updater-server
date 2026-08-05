import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `rolledBack` must describe what actually happened to the Quadlet.
 *
 * Both flows used to swallow a failed rollback rewrite with
 * `.catch(() => undefined)` and then return `rolledBack: true` unconditionally.
 * Two ways that lies:
 *
 *   * the rewrite throws — a full or failing SD card is the realistic cause,
 *     and a version switch is exactly when the card is under pressure;
 *   * `previousImage` is empty, so no rollback is even attempted (reachable
 *     from a malformed `Image=` line with a blank value, which rewriteImageLine
 *     accepts rather than throwing on).
 *
 * In both cases the operator was told the box was back on the old image while
 * it was still on the broken one. `rolledBack` reaches the switch route's log
 * line and the webapp's SwitchResult, so it is the signal someone acts on when
 * deciding whether they still need to intervene.
 */

const mockDaemonReload = vi.fn();
const mockStartUnit = vi.fn();
const mockStopUnitAndWait = vi.fn();
const mockWaitWhileActivating = vi.fn();
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
vi.mock('../src/quadlet/rewriter.js', () => ({
  rewriteQuadletImage: (q: string, i: string) => mockRewriteQuadletImage(q, i),
  writeLastGood: () => Promise.resolve(),
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

/** Switch succeeds up to the health poll, which never comes good. */
function healthFails(previousImage = 'ghcr.io/x/y:old'): void {
  mockRewriteQuadletImage.mockResolvedValue({ previousImage, snapshotPath: '/s' });
  mockPollHealth.mockResolvedValue(false);
  mockWaitWhileActivating.mockResolvedValue('failed');
}

beforeEach(() => {
  for (const m of [
    mockDaemonReload,
    mockStartUnit,
    mockStopUnitAndWait,
    mockWaitWhileActivating,
    mockRewriteQuadletImage,
    mockPollHealth,
  ]) {
    m.mockReset();
  }
  mockDaemonReload.mockResolvedValue(undefined);
  mockStartUnit.mockResolvedValue(undefined);
  mockStopUnitAndWait.mockResolvedValue(undefined);
  // Silence the deliberate console.error from a failed restore.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('performSwitch — rolledBack reflects reality', () => {
  it('reports true when the Quadlet really was restored', async () => {
    const { performSwitch } = await import('../src/switch-service.js');
    healthFails();

    const result = await performSwitch({ tag: 'new' });

    expect(result.rolledBack).toBe(true);
    expect(mockRewriteQuadletImage).toHaveBeenCalledTimes(2);
  });

  it('reports false when the rollback rewrite throws', async () => {
    const { performSwitch } = await import('../src/switch-service.js');
    healthFails();
    // First rewrite (to the new tag) succeeds; the rollback rewrite fails.
    mockRewriteQuadletImage
      .mockResolvedValueOnce({ previousImage: 'ghcr.io/x/y:old', snapshotPath: '/s' })
      .mockRejectedValue(new Error('ENOSPC: no space left on device'));

    const result = await performSwitch({ tag: 'new' });

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(false);
  });

  it('reports false when there is no previous image to restore', async () => {
    const { performSwitch } = await import('../src/switch-service.js');
    healthFails('');

    const result = await performSwitch({ tag: 'new' });

    expect(result.rolledBack).toBe(false);
    // Nothing was attempted: only the forward rewrite ran.
    expect(mockRewriteQuadletImage).toHaveBeenCalledTimes(1);
  });

  // daemon-reload is the difference between restoring the Quadlet and APPLYING
  // it. If it fails, systemd keeps the unit generated from the new image, so
  // the recovery start brings the container back on exactly the image we are
  // rolling away from -- while the file on disk says otherwise.
  it('reports false when the rollback daemon-reload fails', async () => {
    const { performSwitch } = await import('../src/switch-service.js');
    healthFails();
    // First reload is the normal restart's; the rollback's fails.
    mockDaemonReload.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('bus busy'));

    const result = await performSwitch({ tag: 'new' });

    expect(result.rolledBack).toBe(false);
    expect(result.error).toMatch(/could not be applied/i);
    // Recovery is still attempted rather than abandoned.
    expect(mockStartUnit).toHaveBeenCalledTimes(2);
  });

  it('reports false when the systemd restart failed and the rewrite also failed', async () => {
    const { performSwitch } = await import('../src/switch-service.js');
    mockRewriteQuadletImage
      .mockResolvedValueOnce({ previousImage: 'ghcr.io/x/y:old', snapshotPath: '/s' })
      .mockRejectedValue(new Error('EROFS: read-only file system'));
    // Fail the normal restart so the dbus-failure branch is the one exercised.
    mockStopUnitAndWait.mockRejectedValue(new Error('bus down'));

    const result = await performSwitch({ tag: 'new' });

    expect(result.error).toMatch(/systemd restart failed/);
    expect(result.rolledBack).toBe(false);
  });
});

describe('performDoctorSwitch — rolledBack reflects reality', () => {
  it('reports true when the Quadlet really was restored', async () => {
    const { performDoctorSwitch } = await import('../src/doctor-switch-service.js');
    healthFails();

    const result = await performDoctorSwitch({ tag: 'new' });

    expect(result.rolledBack).toBe(true);
  });

  it('reports false when the rollback rewrite throws', async () => {
    const { performDoctorSwitch } = await import('../src/doctor-switch-service.js');
    healthFails();
    mockRewriteQuadletImage
      .mockResolvedValueOnce({ previousImage: 'ghcr.io/x/y:old', snapshotPath: '/s' })
      .mockRejectedValue(new Error('ENOSPC: no space left on device'));

    const result = await performDoctorSwitch({ tag: 'new' });

    expect(result.rolledBack).toBe(false);
  });

  it('reports false when the rollback daemon-reload fails', async () => {
    const { performDoctorSwitch } = await import('../src/doctor-switch-service.js');
    healthFails();
    mockDaemonReload.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('bus busy'));

    const result = await performDoctorSwitch({ tag: 'new' });

    expect(result.rolledBack).toBe(false);
    expect(result.error).toMatch(/could not be applied/i);
    expect(mockStartUnit).toHaveBeenCalledTimes(2);
  });

  it('reports false when there is no previous image to restore', async () => {
    const { performDoctorSwitch } = await import('../src/doctor-switch-service.js');
    healthFails('');

    const result = await performDoctorSwitch({ tag: 'new' });

    expect(result.rolledBack).toBe(false);
  });
});
