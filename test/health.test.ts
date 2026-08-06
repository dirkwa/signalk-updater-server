import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * /api/health's contract, tested without a live container daemon.
 *
 * This test used to call the real podman socket, and that made it flaky in a
 * way that read as "slow CI" but was the opposite: CI has no podman socket, so
 * resolveRuntime() returns null immediately and the test is fast. On a host
 * that HAS one -- a dev box, a boat -- the route spends seconds in the daemon
 * and the test tips over the 5s default.
 *
 * Measured on a Pi 4: `GET /api/health` took 4074ms, against 95ms for the
 * `podman version` CLI. The socket's /version endpoint alone was 2055ms, and
 * the route calls it twice (detectKind, then probeRuntimeVersion). That cost is
 * the dpkg fan-out health.ts already memoises against; the memo just cannot
 * help the first call, which is the only one a test makes.
 *
 * So the daemon is stubbed. The route's job is to map a runtime (or its
 * absence) onto a response shape, and that is what is asserted here --
 * deterministically, and without depending on what happens to be installed on
 * the machine running the suite. Real socket detection is runtime-version's and
 * podman-client's to cover.
 */

const mockResolveRuntime = vi.fn();
const mockVersion = vi.fn();

vi.mock('../src/podman/client.js', () => ({
  resolveRuntime: () => mockResolveRuntime(),
  // Pass-through, matching the real wrapper's shape: surfaces a throw as !ok.
  safe: async (fn: () => Promise<unknown>) => {
    try {
      return { ok: true as const, value: await fn() };
    } catch (err) {
      return { ok: false as const, error: { kind: 'unknown', userMessage: String(err), raw: '' } };
    }
  },
}));

// The update-checker fires a boot-time GHCR query from createServer(). Stubbed
// so the suite does not reach the internet to test a local route.
vi.mock('../src/update-checker.js', () => ({
  startUpdateChecker: vi.fn(),
  invalidate: vi.fn(),
}));

interface HealthBody {
  ok: boolean;
  runtime: string;
  socketPath?: string;
  uptimeSeconds: number;
  version: string;
  runtimeVersion?: string;
}

async function getHealth(): Promise<{ status: number; body: HealthBody }> {
  // health.ts memoises the probed runtime version at module scope, so each case
  // needs a fresh module graph or the second one reads the first one's answer.
  vi.resetModules();
  const { createServer } = await import('../src/server.js');
  const app = await createServer();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    return { status: res.statusCode, body: res.json() as HealthBody };
  } finally {
    await app.close();
  }
}

describe('GET /api/health', () => {
  beforeEach(() => {
    mockResolveRuntime.mockReset();
    mockVersion.mockReset();
  });

  it('reports the runtime when a daemon is reachable', async () => {
    mockVersion.mockResolvedValue({ Version: '5.4.2' });
    mockResolveRuntime.mockResolvedValue({
      kind: 'podman',
      socketPath: '/run/user/1000/podman/podman.sock',
      client: { version: mockVersion },
    });

    const { status, body } = await getHealth();

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.runtime).toBe('podman');
    expect(body.socketPath).toBe('/run/user/1000/podman/podman.sock');
    expect(body.runtimeVersion).toBe('5.4.2');
    expect(typeof body.uptimeSeconds).toBe('number');
    // RuntimeIdentity: the engine's own package.json semver, or a documented
    // 'unknown' when the file could not be read.
    expect(body.version).toMatch(/^(\d+\.\d+\.\d+|unknown)/);
  });

  it('degrades to unknown when no daemon is reachable', async () => {
    // The case CI actually runs in, now asserted rather than accidental.
    mockResolveRuntime.mockResolvedValue(null);

    const { status, body } = await getHealth();

    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.runtime).toBe('unknown');
    expect(body.socketPath).toBeUndefined();
    expect(body.runtimeVersion).toBeUndefined();
    expect(typeof body.uptimeSeconds).toBe('number');
  });

  it('still answers when the daemon refuses a version probe', async () => {
    // A daemon that is up but failing this one call must not take the health
    // endpoint down with it -- it is what everything else polls to decide
    // whether the engine is alive.
    mockVersion.mockRejectedValue(new Error('connection reset'));
    mockResolveRuntime.mockResolvedValue({
      kind: 'docker',
      socketPath: '/var/run/docker.sock',
      client: { version: mockVersion },
    });

    const { status, body } = await getHealth();

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.runtime).toBe('docker');
    expect(body.runtimeVersion).toBeUndefined();
  });
});
