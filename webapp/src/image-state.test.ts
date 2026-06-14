import { describe, it, expect } from 'vitest';
import { mergeImageState } from './image-state';

describe('mergeImageState', () => {
  it('takes the union of the two signals', () => {
    // restart from /api/state, pull from /api/updates → both.
    expect(mergeImageState('restart-required', 'pull-available')).toBe('pull-and-restart');
    expect(mergeImageState('pull-available', 'restart-required')).toBe('pull-and-restart');
  });

  it('surfaces a single drift from whichever side reports it', () => {
    expect(mergeImageState('restart-required', 'in-sync')).toBe('restart-required');
    expect(mergeImageState('in-sync', 'pull-available')).toBe('pull-available');
    expect(mergeImageState(undefined, 'restart-required')).toBe('restart-required');
    expect(mergeImageState('pull-available', undefined)).toBe('pull-available');
  });

  it('reports in-sync only when at least one side is definitely in-sync', () => {
    expect(mergeImageState('in-sync', 'in-sync')).toBe('in-sync');
    expect(mergeImageState('in-sync', undefined)).toBe('in-sync');
    expect(mergeImageState('in-sync', 'unknown')).toBe('in-sync');
  });

  it('reports unknown when neither side can tell', () => {
    expect(mergeImageState(undefined, undefined)).toBe('unknown');
    expect(mergeImageState('unknown', 'unknown')).toBe('unknown');
    expect(mergeImageState('unknown', undefined)).toBe('unknown');
  });

  it('a pull-and-restart on either side propagates', () => {
    expect(mergeImageState('pull-and-restart', undefined)).toBe('pull-and-restart');
    expect(mergeImageState(undefined, 'pull-and-restart')).toBe('pull-and-restart');
  });
});
