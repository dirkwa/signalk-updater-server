import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordOutcome,
  getLastOutcomes,
  getLastOutcome,
  __resetOutcomesForTests,
} from '../src/last-outcome.js';

describe('last-outcome cache', () => {
  beforeEach(() => __resetOutcomesForTests());

  it('is empty until an operation runs', () => {
    expect(getLastOutcomes()).toEqual([]);
    expect(getLastOutcome('self-update')).toBeUndefined();
  });

  it('records and reads back an outcome, stamping a timestamp', () => {
    recordOutcome({ operation: 'switch', ok: true, from: '1.0.0', to: '1.1.0' });
    const o = getLastOutcome('switch');
    expect(o).toBeDefined();
    if (!o) return;
    expect(o.ok).toBe(true);
    expect(o.to).toBe('1.1.0');
    expect(typeof o.at).toBe('string');
    expect(Number.isNaN(Date.parse(o.at))).toBe(false);
  });

  it('keeps only the latest outcome per operation', () => {
    recordOutcome({ operation: 'self-update', ok: false, error: 'first' });
    recordOutcome({ operation: 'self-update', ok: true });
    expect(getLastOutcome('self-update')?.ok).toBe(true);
    expect(getLastOutcomes().filter((o) => o.operation === 'self-update')).toHaveLength(1);
  });

  it('tracks distinct operations independently', () => {
    recordOutcome({ operation: 'switch', ok: true });
    recordOutcome({ operation: 'doctor-update', ok: false, error: 'boom' });
    expect(getLastOutcomes()).toHaveLength(2);
    expect(getLastOutcome('doctor-update')?.error).toBe('boom');
  });
});
