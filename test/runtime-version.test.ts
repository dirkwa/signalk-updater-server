import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We import via dynamic import inside each test because the module under
// test reads QUADLET_DIR via the quadlet-image-tag helper (which calls
// process.env per-call — see that module's comment). The mocks for
// dockerode and fetch don't need that, but the Quadlet directory lives
// in a per-test mkdtemp so we DO need a fresh env var per case.

// Mock dockerode-shaped client through src/podman/client.ts.
const mockResolveRuntime = vi.fn();
const mockSafe = vi.fn();
vi.mock('../src/podman/client.js', () => ({
  resolveRuntime: () => mockResolveRuntime(),
  safe: (fn: () => Promise<unknown>) => mockSafe(fn),
}));

let dir: string;
const originalQuadletDir = process.env.QUADLET_DIR;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runtime-version-test-'));
  process.env.QUADLET_DIR = dir;
  mockResolveRuntime.mockReset();
  mockSafe.mockReset();
});

afterEach(async () => {
  if (originalQuadletDir === undefined) delete process.env.QUADLET_DIR;
  else process.env.QUADLET_DIR = originalQuadletDir;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function writeQuadlet(name: string, imageLine: string): Promise<void> {
  await writeFile(join(dir, name), `[Container]\nImage=${imageLine}\n`);
}

describe('getRuntimeIdentity — selfVersion shortcut', () => {
  it('returns the self-supplied version without HTTP or dockerode', async () => {
    await writeQuadlet('updater.container', 'ghcr.io/dirkwa/signalk-updater-server:latest');
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-updater-server',
      quadletName: 'updater.container',
      selfVersion: () => '0.6.4',
    });
    expect(identity).toEqual({ version: '0.6.4', source: 'health', channel: 'stable' });
    expect(mockResolveRuntime).not.toHaveBeenCalled();
  });

  it('falls through when selfVersion returns "unknown"', async () => {
    await writeQuadlet('updater.container', 'ghcr.io/dirkwa/signalk-updater-server:0.6.3');
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-updater-server',
      quadletName: 'updater.container',
      selfVersion: () => 'unknown',
    });
    expect(identity.version).toBe('0.6.3');
    expect(identity.source).toBe('quadlet-tag');
  });
});

describe('getRuntimeIdentity — health probe', () => {
  it('returns the version reported by /api/health on a sibling engine', async () => {
    await writeQuadlet('doctor.container', 'ghcr.io/dirkwa/signalk-doctor-server:latest');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ version: '0.6.1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-doctor-server',
      quadletName: 'doctor.container',
      healthUrl: 'http://127.0.0.1:3004/api/health',
    });
    expect(identity).toEqual({ version: '0.6.1', source: 'health', channel: 'stable' });
  });

  it('falls through on non-2xx health response', async () => {
    await writeQuadlet('doctor.container', 'ghcr.io/dirkwa/signalk-doctor-server:0.6.0');
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 503 })) as typeof fetch;
    // Image-label fallback: dockerode returns no useful label.
    mockResolveRuntime.mockResolvedValue(null);
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-doctor-server',
      quadletName: 'doctor.container',
      healthUrl: 'http://127.0.0.1:3004/api/health',
    });
    // Falls through to quadlet-tag (0.6.0 is a valid semver tag).
    expect(identity).toEqual({ version: '0.6.0', source: 'quadlet-tag', channel: 'stable' });
  });

  it('ignores "unknown" version string from health', async () => {
    await writeQuadlet('doctor.container', 'ghcr.io/dirkwa/signalk-doctor-server:latest');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ version: 'unknown' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    mockResolveRuntime.mockResolvedValue(null);
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-doctor-server',
      quadletName: 'doctor.container',
      healthUrl: 'http://127.0.0.1:3004/api/health',
    });
    expect(identity.version).toBeNull();
    expect(identity.source).toBe('unknown');
    expect(identity.channel).toBe('stable'); // from `latest`
  });
});

describe('getRuntimeIdentity — signalk discovery probe', () => {
  it('reads endpoints.v1.version from /signalk', async () => {
    await writeQuadlet('server.container', 'ghcr.io/dirkwa/signalk-server:dirkwa');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ endpoints: { v1: { version: '2.27.0' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-server',
      quadletName: 'server.container',
      signalkUrl: 'http://host.containers.internal:3000/signalk',
    });
    expect(identity).toEqual({ version: '2.27.0', source: 'health', channel: 'dirkwa' });
  });

  it('falls through when /signalk returns the wrong shape', async () => {
    await writeQuadlet('server.container', 'ghcr.io/dirkwa/signalk-server:2.26.0');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ unrelated: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    mockResolveRuntime.mockResolvedValue(null);
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-server',
      quadletName: 'server.container',
      signalkUrl: 'http://host.containers.internal:3000/signalk',
    });
    // Falls through to quadlet-tag (2.26.0 is a valid semver).
    expect(identity).toEqual({ version: '2.26.0', source: 'quadlet-tag', channel: 'stable' });
  });

  it('ignores empty version string from /signalk', async () => {
    await writeQuadlet('server.container', 'ghcr.io/dirkwa/signalk-server:dirkwa');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ endpoints: { v1: { version: '' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    mockResolveRuntime.mockResolvedValue(null);
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-server',
      quadletName: 'server.container',
      signalkUrl: 'http://host.containers.internal:3000/signalk',
    });
    expect(identity.version).toBeNull();
    expect(identity.channel).toBe('dirkwa');
  });
});

describe('getRuntimeIdentity — OCI image label', () => {
  it('reads org.opencontainers.image.version from the image inspect', async () => {
    await writeQuadlet('server.container', 'ghcr.io/dirkwa/signalk-server:dirkwa');
    mockResolveRuntime.mockResolvedValue({
      client: {
        getContainer: () => ({
          inspect: async () => ({ Image: 'sha256:abc123' }),
        }),
        getImage: () => ({
          inspect: async () => ({
            Config: { Labels: { 'org.opencontainers.image.version': 'v2.24.0' } },
          }),
        }),
      },
    });
    // safe() just forwards through.
    mockSafe.mockImplementation(async (fn: () => Promise<unknown>) => {
      try {
        return { ok: true as const, value: await fn() };
      } catch (err) {
        return {
          ok: false as const,
          error: { kind: 'unknown', userMessage: String(err), raw: '' },
        };
      }
    });
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-server',
      quadletName: 'server.container',
    });
    expect(identity).toEqual({ version: '2.24.0', source: 'image-label', channel: 'dirkwa' });
  });

  it('strips the v prefix from the label so the field is clean semver', async () => {
    await writeQuadlet('updater.container', 'ghcr.io/dirkwa/signalk-updater-server:latest');
    mockResolveRuntime.mockResolvedValue({
      client: {
        getContainer: () => ({ inspect: async () => ({ Image: 'sha256:xyz' }) }),
        getImage: () => ({
          inspect: async () => ({
            Config: { Labels: { 'org.opencontainers.image.version': 'v0.6.4' } },
          }),
        }),
      },
    });
    mockSafe.mockImplementation(async (fn: () => Promise<unknown>) => ({
      ok: true as const,
      value: await fn(),
    }));
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-updater-server',
      quadletName: 'updater.container',
    });
    expect(identity.version).toBe('0.6.4');
    expect(identity.source).toBe('image-label');
  });

  it('falls through when the label is missing or not a semver shape', async () => {
    await writeQuadlet('foo.container', 'ghcr.io/foo/bar:latest');
    mockResolveRuntime.mockResolvedValue({
      client: {
        getContainer: () => ({ inspect: async () => ({ Image: 'sha256:xyz' }) }),
        getImage: () => ({
          inspect: async () => ({
            Config: { Labels: { 'org.opencontainers.image.title': 'foo' } },
          }),
        }),
      },
    });
    mockSafe.mockImplementation(async (fn: () => Promise<unknown>) => ({
      ok: true as const,
      value: await fn(),
    }));
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'foo',
      quadletName: 'foo.container',
    });
    // No semver from any source. Channel still derives from the Quadlet
    // tag (`latest` is stable).
    expect(identity.version).toBeNull();
    expect(identity.source).toBe('unknown');
    expect(identity.channel).toBe('stable');
  });
});

describe('getRuntimeIdentity — Quadlet tag fallback', () => {
  it('returns the Quadlet tag when it is a semver and no other source answers', async () => {
    await writeQuadlet('foo.container', 'ghcr.io/foo/bar:1.2.3');
    mockResolveRuntime.mockResolvedValue(null);
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'foo',
      quadletName: 'foo.container',
    });
    expect(identity).toEqual({ version: '1.2.3', source: 'quadlet-tag', channel: 'stable' });
  });

  it('returns null + correct channel when the Quadlet tag is floating', async () => {
    await writeQuadlet('foo.container', 'ghcr.io/foo/bar:latest');
    mockResolveRuntime.mockResolvedValue(null);
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'foo',
      quadletName: 'foo.container',
    });
    expect(identity.version).toBeNull();
    expect(identity.source).toBe('unknown');
    expect(identity.channel).toBe('stable');
  });

  it('returns channel="unknown" when the Quadlet file is missing', async () => {
    mockResolveRuntime.mockResolvedValue(null);
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'foo',
      quadletName: 'does-not-exist.container',
    });
    expect(identity.version).toBeNull();
    expect(identity.channel).toBe('unknown');
  });
});
