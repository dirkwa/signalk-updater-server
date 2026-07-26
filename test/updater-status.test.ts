import { describe, it, expect } from 'vitest';
import { buildUpdaterStatus, type StatusInputs } from '../src/updater-status.js';
import type { AvailableUpdates, ContainerSnapshot, CurrentState } from '../src/types.js';

function snap(state: ContainerSnapshot['state']): ContainerSnapshot {
  return { tag: 'x', digest: 'd', version: '1.0.0', channel: 'stable', state };
}

function inputs(over: Partial<StatusInputs> = {}): StatusInputs {
  const updates: AvailableUpdates = {
    signalkServer: { currentTag: '1', updateAvailable: false, imageState: 'in-sync' },
    updater: { currentTag: '1', updateAvailable: false, imageState: 'in-sync' },
    doctor: { currentTag: '1', updateAvailable: false, imageState: 'in-sync' },
    lastCheckedAt: null,
  };
  const current: CurrentState = {
    signalkServer: snap('running'),
    updaterServer: { ...snap('running'), updateAvailable: false },
    doctorServer: snap('running'),
    lastCheck: '2026-01-01T00:00:00Z',
  };
  return {
    updates,
    current,
    lock: { lock: null, stale: false },
    outcomes: [],
    ...over,
  };
}

const NOW = '2026-07-27T00:00:00Z';
const by = (s: ReturnType<typeof buildUpdaterStatus>, id: string) =>
  s.results.find((r) => r.id === id);

describe('buildUpdaterStatus', () => {
  it('all-clear → every result ok, no warn/fail/unknown', () => {
    const s = buildUpdaterStatus(NOW, inputs());
    expect(s.summary.warn).toBe(0);
    expect(s.summary.fail).toBe(0);
    expect(s.summary.unknown).toBe(0);
    expect(s.results.every((r) => r.status === 'ok')).toBe(true);
  });

  it('reports unknown (not false-green) when image freshness is undetermined', () => {
    const s = buildUpdaterStatus(
      NOW,
      inputs({
        updates: {
          ...inputs().updates,
          updater: { currentTag: '1', updateAvailable: false, imageState: 'unknown' },
        },
      }),
    );
    expect(by(s, 'update-available-updater')?.status).toBe('unknown');
  });

  it('includes the updater container in health', () => {
    const c = inputs().current;
    const s = buildUpdaterStatus(
      NOW,
      inputs({ current: { ...c, updaterServer: { ...c.updaterServer, state: 'unhealthy' } } }),
    );
    expect(by(s, 'container-signalk-updater-server')?.status).toBe('fail');
  });

  it('warns on a channel-aware semver update available (updater)', () => {
    const s = buildUpdaterStatus(
      NOW,
      inputs({
        updates: {
          ...inputs().updates,
          updater: { currentTag: '0.7.5', updateAvailable: true, availableTag: '0.8.0' },
        },
      }),
    );
    const r = by(s, 'update-available-updater');
    expect(r?.status).toBe('warn');
    expect(r?.message).toContain('0.8.0');
  });

  it('warns on image drift when there is no semver target (dirkwa/master path)', () => {
    const s = buildUpdaterStatus(
      NOW,
      inputs({
        updates: {
          ...inputs().updates,
          // dirkwa: updateAvailable stays false, imageState carries the signal
          updater: { currentTag: 'dirkwa', updateAvailable: false, imageState: 'pull-available' },
        },
      }),
    );
    const r = by(s, 'update-available-updater');
    expect(r?.status).toBe('warn');
    expect(r?.message).toContain('pull');
  });

  it('warns on signalk-server image drift', () => {
    const s = buildUpdaterStatus(
      NOW,
      inputs({
        updates: {
          ...inputs().updates,
          signalkServer: {
            currentTag: 'dirkwa',
            updateAvailable: false,
            imageState: 'restart-required',
          },
        },
      }),
    );
    expect(by(s, 'update-available-signalk')?.status).toBe('warn');
  });

  it('fails on a stopped/unhealthy/missing container', () => {
    const c = inputs().current;
    const s = buildUpdaterStatus(
      NOW,
      inputs({ current: { ...c, signalkServer: snap('unhealthy') } }),
    );
    const r = by(s, 'container-signalk-server');
    expect(r?.status).toBe('fail');
    expect(r?.message).toContain('unhealthy');
  });

  it('warns on a stale lock with the holder operation', () => {
    const s = buildUpdaterStatus(
      NOW,
      inputs({
        lock: {
          lock: { owner: 'updater', operation: 'switch', startedAt: NOW },
          stale: true,
        },
      }),
    );
    const r = by(s, 'stale-lock');
    expect(r?.status).toBe('warn');
    expect(r?.message).toContain('switch');
  });

  it('does not emit a stale-lock result when the lock is fresh or absent', () => {
    const s = buildUpdaterStatus(NOW, inputs());
    expect(by(s, 'stale-lock')).toBeUndefined();
  });

  it('fails on a recorded last-operation failure (e.g. self-update)', () => {
    const s = buildUpdaterStatus(
      NOW,
      inputs({
        outcomes: [
          { operation: 'self-update', ok: false, at: NOW, error: 'pull failed: net down' },
          { operation: 'switch', ok: true, at: NOW },
        ],
      }),
    );
    const r = by(s, 'last-self-update');
    expect(r?.status).toBe('fail');
    expect(r?.message).toContain('pull failed');
    // a successful outcome produces no result
    expect(by(s, 'last-switch')).toBeUndefined();
  });

  it('summary counts match the results', () => {
    const s = buildUpdaterStatus(
      NOW,
      inputs({
        updates: {
          ...inputs().updates,
          updater: { currentTag: '1', updateAvailable: true, availableTag: '2' },
        },
        current: { ...inputs().current, doctorServer: snap('missing') },
      }),
    );
    const counts = { ok: 0, warn: 0, fail: 0, unknown: 0 };
    for (const r of s.results) counts[r.status]++;
    expect(s.summary).toEqual(counts);
    expect(s.summary.warn).toBeGreaterThanOrEqual(1);
    expect(s.summary.fail).toBeGreaterThanOrEqual(1);
  });
});
