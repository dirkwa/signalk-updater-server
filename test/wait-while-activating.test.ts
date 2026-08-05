import { describe, it, expect, vi } from 'vitest';
import { waitWhileActivating } from '../src/dbus/systemd-user.js';

/**
 * waitWhileActivating is the guard that keeps a slow container create from
 * being mistaken for a failed one.
 *
 * Incident it exists for: `startUnit` only ENQUEUES a systemd job, so the
 * switch flow's 180s health poll runs concurrently with the unit's own 300s
 * TimeoutStartSec rather than after it. On an SD-card host `podman run` can
 * spend most of that budget just creating the container, so the poll expires
 * while the unit is still legitimately `activating`. The old code rolled back
 * immediately: systemd SIGTERMed `podman run` mid-create, SIGKILLed it at
 * TimeoutStopSec, and the orphaned incomplete overlay layer wedged podman's
 * global c/storage lock until someone SSHed in. A failed switch became a dead
 * host.
 *
 * The state reader is injected rather than vi.mock'd: `waitWhileActivating`
 * calls `getActiveState` intra-module, which an export mock cannot intercept —
 * an earlier version of this file mocked the export and silently tested the
 * host's real systemd instead (a nonexistent unit came back `inactive`).
 */
describe('waitWhileActivating', () => {
  const UNIT = 'signalk-server.service';

  it('returns immediately when the unit has already settled', async () => {
    const readState = vi.fn().mockResolvedValue('active');

    expect(await waitWhileActivating(UNIT, 5_000, readState)).toBe('active');
    expect(readState).toHaveBeenCalledTimes(1);
    expect(readState).toHaveBeenCalledWith(UNIT);
  });

  // The case that caused the outage: still creating the container when the
  // health poll gave up. The caller must block, not roll back.
  it('waits out an activating unit and reports the settled state', async () => {
    const readState = vi
      .fn()
      .mockResolvedValueOnce('activating')
      .mockResolvedValueOnce('activating')
      .mockResolvedValueOnce('active');

    expect(await waitWhileActivating(UNIT, 30_000, readState)).toBe('active');
    expect(readState).toHaveBeenCalledTimes(3);
  });

  // A start that genuinely failed still settles — into `failed`, not `active`.
  // The caller reads that and proceeds to roll back, which is now safe because
  // nothing is mid-create.
  it('returns failed so the caller still rolls back', async () => {
    const readState = vi.fn().mockResolvedValueOnce('activating').mockResolvedValueOnce('failed');

    expect(await waitWhileActivating(UNIT, 30_000, readState)).toBe('failed');
  });

  // Never block forever: a unit wedged in `activating` must eventually release
  // the caller, or a stuck switch would hold the operation mutex indefinitely.
  it('gives up at the deadline and returns the last state seen', async () => {
    const readState = vi.fn().mockResolvedValue('activating');

    const started = Date.now();
    expect(await waitWhileActivating(UNIT, 1_200, readState)).toBe('activating');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(readState.mock.calls.length).toBeGreaterThan(1);
  });

  it('tolerates a unit systemd cannot report on', async () => {
    const readState = vi.fn().mockResolvedValue('unknown');

    expect(await waitWhileActivating('nope.service', 5_000, readState)).toBe('unknown');
  });
});
