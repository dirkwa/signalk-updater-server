import { describe, it, expect } from 'vitest';
import { classifyChannel, compareSemver } from '../src/tagClassifier.js';

describe('classifyChannel', () => {
  it('stable for plain semver', () => {
    expect(classifyChannel('v1.2.3')).toBe('stable');
    expect(classifyChannel('1.2.3')).toBe('stable');
  });
  it('beta for prerelease semver', () => {
    expect(classifyChannel('v1.2.3-beta.1')).toBe('beta');
    expect(classifyChannel('v2.0.0-rc.2')).toBe('beta');
  });
  it('master for master/main', () => {
    expect(classifyChannel('master')).toBe('master');
    expect(classifyChannel('main-abc123')).toBe('master');
    expect(classifyChannel('master-a8ac65e')).toBe('master');
  });
  it('dirkwa for prefixed', () => {
    expect(classifyChannel('dirkwa-experimental')).toBe('dirkwa');
  });
  it('falls back to dirkwa for unknown', () => {
    expect(classifyChannel('')).toBe('dirkwa');
    expect(classifyChannel('weird')).toBe('dirkwa');
  });
});

describe('compareSemver', () => {
  it('major dominates', () => {
    expect(compareSemver('v2.0.0', 'v1.99.99')).toBeGreaterThan(0);
  });
  it('minor when major equal', () => {
    expect(compareSemver('v1.3.0', 'v1.2.99')).toBeGreaterThan(0);
  });
  it('patch when major+minor equal', () => {
    expect(compareSemver('v1.2.10', 'v1.2.9')).toBeGreaterThan(0);
  });
  it('stable beats prerelease', () => {
    expect(compareSemver('v1.2.3', 'v1.2.3-beta.1')).toBeGreaterThan(0);
  });
  it('returns 0 for non-semver', () => {
    expect(compareSemver('master-abc', 'v1.0.0')).toBe(0);
  });
});
