import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { SELF_SIGNED_CERT, SELF_SIGNED_KEY } from './fixtures/self-signed-cert.js';
import { port, listen, closeAllServers, jsonServer } from './fixtures/local-server.js';

// We import via dynamic import inside each test because the module under
// test reads QUADLET_DIR via the quadlet-image-tag helper (which calls
// process.env per-call — see that module's comment). The mock for
// dockerode doesn't need that, but the Quadlet directory lives in a
// per-test mkdtemp so we DO need a fresh env var per case.
//
// The health / signalk probes go over real local HTTP(S) servers: the
// probes run on node:http, not fetch (self-signed redirect support), so
// fetch stubs would test nothing.

// Mock dockerode-shaped client through src/podman/client.ts.
const mockResolveRuntime = vi.fn();
const mockSafe = vi.fn();
vi.mock('../src/podman/client.js', () => ({
  resolveRuntime: () => mockResolveRuntime(),
  safe: (fn: () => Promise<unknown>) => mockSafe(fn),
}));

let dir: string;
const originalQuadletDir = process.env.QUADLET_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runtime-version-test-'));
  process.env.QUADLET_DIR = dir;
  mockResolveRuntime.mockReset();
  mockSafe.mockReset();
});

afterEach(async () => {
  if (originalQuadletDir === undefined) delete process.env.QUADLET_DIR;
  else process.env.QUADLET_DIR = originalQuadletDir;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
  await closeAllServers();
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
    const base = await jsonServer(200, { version: '0.6.1' });
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-doctor-server',
      quadletName: 'doctor.container',
      healthUrl: `${base}/api/health`,
    });
    expect(identity).toEqual({ version: '0.6.1', source: 'health', channel: 'stable' });
  });

  it('falls through on non-2xx health response', async () => {
    await writeQuadlet('doctor.container', 'ghcr.io/dirkwa/signalk-doctor-server:0.6.0');
    const base = await jsonServer(503, { error: 'boom' });
    // Image-label fallback: dockerode returns no useful label.
    mockResolveRuntime.mockResolvedValue(null);
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-doctor-server',
      quadletName: 'doctor.container',
      healthUrl: `${base}/api/health`,
    });
    // Falls through to quadlet-tag (0.6.0 is a valid semver tag).
    expect(identity).toEqual({ version: '0.6.0', source: 'quadlet-tag', channel: 'stable' });
  });

  it('ignores "unknown" version string from health', async () => {
    await writeQuadlet('doctor.container', 'ghcr.io/dirkwa/signalk-doctor-server:latest');
    const base = await jsonServer(200, { version: 'unknown' });
    mockResolveRuntime.mockResolvedValue(null);
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-doctor-server',
      quadletName: 'doctor.container',
      healthUrl: `${base}/api/health`,
    });
    expect(identity.version).toBeNull();
    expect(identity.source).toBe('unknown');
    expect(identity.channel).toBe('stable'); // from `latest`
  });

  it('falls through when the health endpoint is unreachable', async () => {
    await writeQuadlet('doctor.container', 'ghcr.io/dirkwa/signalk-doctor-server:0.6.0');
    mockResolveRuntime.mockResolvedValue(null);
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-doctor-server',
      quadletName: 'doctor.container',
      // Port 1 is privileged + unused — connect refused, no hang.
      healthUrl: 'http://127.0.0.1:1/api/health',
    });
    expect(identity).toEqual({ version: '0.6.0', source: 'quadlet-tag', channel: 'stable' });
  });
});

describe('getRuntimeIdentity — signalk discovery probe', () => {
  it('reads endpoints.v1.version from /signalk', async () => {
    await writeQuadlet('server.container', 'ghcr.io/dirkwa/signalk-server:dirkwa');
    const base = await jsonServer(200, { endpoints: { v1: { version: '2.27.0' } } });
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-server',
      quadletName: 'server.container',
      signalkUrl: `${base}/signalk`,
    });
    expect(identity).toEqual({ version: '2.27.0', source: 'health', channel: 'dirkwa' });
  });

  it('follows the SSL-plugin redirect to a self-signed https /signalk', async () => {
    // The 2026-07-12 field failure behind the dashboard's "—": with TLS
    // enabled, :80/signalk 302s to a self-signed https endpoint. The
    // version probe must follow the hop and accept the cert.
    await writeQuadlet('server.container', 'ghcr.io/dirkwa/signalk-server:dirkwa');
    const https = createHttpsServer(
      { cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ endpoints: { v1: { version: '2.30.0' } } }));
      },
    );
    await listen(https);
    const httpsPort = port(https);
    const http = createHttpServer((_req, res) => {
      res.writeHead(302, { location: `https://127.0.0.1:${httpsPort}/signalk` });
      res.end();
    });
    await listen(http);
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-server',
      quadletName: 'server.container',
      signalkUrl: `http://127.0.0.1:${port(http)}/signalk`,
    });
    expect(identity).toEqual({ version: '2.30.0', source: 'health', channel: 'dirkwa' });
  });

  it('falls through when /signalk returns the wrong shape', async () => {
    await writeQuadlet('server.container', 'ghcr.io/dirkwa/signalk-server:2.26.0');
    const base = await jsonServer(200, { unrelated: true });
    mockResolveRuntime.mockResolvedValue(null);
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-server',
      quadletName: 'server.container',
      signalkUrl: `${base}/signalk`,
    });
    // Falls through to quadlet-tag (2.26.0 is a valid semver).
    expect(identity).toEqual({ version: '2.26.0', source: 'quadlet-tag', channel: 'stable' });
  });

  it('ignores empty version string from /signalk', async () => {
    await writeQuadlet('server.container', 'ghcr.io/dirkwa/signalk-server:dirkwa');
    const base = await jsonServer(200, { endpoints: { v1: { version: '' } } });
    mockResolveRuntime.mockResolvedValue(null);
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const identity = await getRuntimeIdentity({
      container: 'signalk-server',
      quadletName: 'server.container',
      signalkUrl: `${base}/signalk`,
    });
    expect(identity.version).toBeNull();
    expect(identity.channel).toBe('dirkwa');
  });
});

describe('getRuntimeIdentity — probe failure logging', () => {
  it('warns once per failure reason and once on recovery', async () => {
    await writeQuadlet('doctor.container', 'ghcr.io/dirkwa/signalk-doctor-server:latest');
    // Same URL throughout so the transition map sees one probe target:
    // fail twice (one warn), then recover (one more warn).
    let status = 503;
    const srv = createHttpServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '0.6.1' }));
    });
    await listen(srv);
    const url = `http://127.0.0.1:${port(srv)}/api/health`;
    mockResolveRuntime.mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getRuntimeIdentity } = await import('../src/runtime-version.js');
    const target = {
      container: 'signalk-doctor-server',
      quadletName: 'doctor.container',
      healthUrl: url,
    };

    await getRuntimeIdentity(target);
    await getRuntimeIdentity(target);
    const failWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes(url));
    expect(failWarns).toHaveLength(1);
    expect(String(failWarns[0]?.[0])).toContain('http-503');

    status = 200;
    await getRuntimeIdentity(target);
    const allWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes(url));
    expect(allWarns).toHaveLength(2);
    expect(String(allWarns[1]?.[0])).toContain('recovered');
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
