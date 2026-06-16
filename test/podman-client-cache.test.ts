import { describe, it, expect, beforeEach, vi } from 'vitest';

// Count how many times dockerode's version() is hit. version() is the call
// that, on podman, fans out `dpkg-query --search` per helper binary — the
// proven source of the load storm. The cache must collapse N
// resolveRuntime() calls to exactly ONE version() per process.
let versionCalls = 0;

vi.mock('dockerode', () => {
  return {
    default: class FakeDocker {
      async version() {
        versionCalls += 1;
        return { Components: [{ Name: 'Podman Engine' }], Platform: { Name: 'podman' } };
      }
    },
  };
});

// pickSocket() stats real paths; force a deterministic socket hit so
// resolveRuntime gets past pickSocket without depending on the host.
vi.mock('node:fs/promises', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    stat: async () => ({ isSocket: () => true }),
  };
});

describe('resolveRuntime caching', () => {
  beforeEach(async () => {
    versionCalls = 0;
    const m = await import('../src/podman/client.js');
    m.__resetRuntimeCacheForTests();
  });

  it('calls version() only once across many resolveRuntime() calls', async () => {
    const { resolveRuntime } = await import('../src/podman/client.js');
    // Simulate the ~14 call sites per request cycle, plus concurrent bursts.
    const results = await Promise.all(Array.from({ length: 20 }, () => resolveRuntime()));
    expect(results.every((r) => r !== null)).toBe(true);
    // All callers get the exact same cached instance (coalesced, not 20 copies).
    expect(results.every((r) => r === results[0])).toBe(true);
    expect(results[0]?.kind).toBe('podman');
    // The whole point: one version() for 20 resolves (was 20 before caching).
    expect(versionCalls).toBe(1);
  });

  it('returns the same cached instance on repeat calls', async () => {
    const { resolveRuntime } = await import('../src/podman/client.js');
    const a = await resolveRuntime();
    const b = await resolveRuntime();
    expect(a).toBe(b);
  });

  it('re-detects after the test reset (one fresh version() call)', async () => {
    const { resolveRuntime, __resetRuntimeCacheForTests } = await import('../src/podman/client.js');
    await resolveRuntime();
    expect(versionCalls).toBe(1);
    __resetRuntimeCacheForTests();
    await resolveRuntime();
    expect(versionCalls).toBe(2);
  });
});
