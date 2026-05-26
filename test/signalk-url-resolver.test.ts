import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mocks for the resolver's two side-channels: `fs.existsSync` (container
// detection) and `dns/promises.lookup` (host.containers.internal probe).
const mockExistsSync = vi.fn();
const mockLookup = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

const originalHealthUrl = process.env.SIGNALK_HEALTH_URL;
const originalSignalkUrl = process.env.SIGNALK_URL;
const originalDoctorUrl = process.env.DOCTOR_HEALTH_URL;

beforeEach(() => {
  delete process.env.SIGNALK_HEALTH_URL;
  delete process.env.SIGNALK_URL;
  delete process.env.DOCTOR_HEALTH_URL;
  mockExistsSync.mockReset();
  mockLookup.mockReset();
});

afterEach(async () => {
  if (originalHealthUrl === undefined) delete process.env.SIGNALK_HEALTH_URL;
  else process.env.SIGNALK_HEALTH_URL = originalHealthUrl;
  if (originalSignalkUrl === undefined) delete process.env.SIGNALK_URL;
  else process.env.SIGNALK_URL = originalSignalkUrl;
  if (originalDoctorUrl === undefined) delete process.env.DOCTOR_HEALTH_URL;
  else process.env.DOCTOR_HEALTH_URL = originalDoctorUrl;
  const mod = await import('../src/signalk-url-resolver.js');
  mod.resetSignalkUrlResolverForTests();
});

describe('resolveSignalkHealthUrl', () => {
  it('returns SIGNALK_HEALTH_URL verbatim when set (installer override)', async () => {
    process.env.SIGNALK_HEALTH_URL = 'http://host.containers.internal:3000/signalk';
    const { resolveSignalkHealthUrl } = await import('../src/signalk-url-resolver.js');
    expect(await resolveSignalkHealthUrl()).toBe('http://host.containers.internal:3000/signalk');
    // No container/DNS probing when override is set.
    expect(mockExistsSync).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('falls back to host.containers.internal in a container when DNS resolves', async () => {
    mockExistsSync.mockReturnValue(true);
    mockLookup.mockResolvedValue({ address: '10.0.2.2', family: 4 });
    const { resolveSignalkHealthUrl } = await import('../src/signalk-url-resolver.js');
    expect(await resolveSignalkHealthUrl()).toBe('http://host.containers.internal:3000/signalk');
  });

  it('falls back to loopback outside a container (local dev)', async () => {
    mockExistsSync.mockReturnValue(false);
    const { resolveSignalkHealthUrl } = await import('../src/signalk-url-resolver.js');
    expect(await resolveSignalkHealthUrl()).toBe('http://127.0.0.1:3000/signalk');
    // No DNS probe needed once we know we're on the host.
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('falls back to loopback in a container when host.containers.internal does not resolve', async () => {
    mockExistsSync.mockReturnValue(true);
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
    const { resolveSignalkHealthUrl } = await import('../src/signalk-url-resolver.js');
    expect(await resolveSignalkHealthUrl()).toBe('http://127.0.0.1:3000/signalk');
  });

  it('memoizes the resolved base across calls', async () => {
    mockExistsSync.mockReturnValue(true);
    mockLookup.mockResolvedValue({ address: '10.0.2.2', family: 4 });
    const mod = await import('../src/signalk-url-resolver.js');
    mod.resetSignalkUrlResolverForTests();
    await mod.resolveSignalkHealthUrl();
    await mod.resolveSignalkHealthUrl();
    await mod.resolveSignalkHealthUrl();
    // existsSync may be called twice (once for /run/.containerenv, once for /.dockerenv)
    // but only on the first resolution. DNS lookup only once.
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });
});

describe('resolveSignalkBaseUrl', () => {
  it('returns SIGNALK_URL verbatim when set', async () => {
    process.env.SIGNALK_URL = 'http://some.host:3000';
    const { resolveSignalkBaseUrl } = await import('../src/signalk-url-resolver.js');
    expect(await resolveSignalkBaseUrl()).toBe('http://some.host:3000');
  });

  it('shares the container-host fallback with the health URL resolver', async () => {
    mockExistsSync.mockReturnValue(true);
    mockLookup.mockResolvedValue({ address: '10.0.2.2', family: 4 });
    const mod = await import('../src/signalk-url-resolver.js');
    mod.resetSignalkUrlResolverForTests();
    expect(await mod.resolveSignalkBaseUrl()).toBe('http://host.containers.internal:3000');
    expect(await mod.resolveSignalkHealthUrl()).toBe(
      'http://host.containers.internal:3000/signalk',
    );
    // One detection across both resolvers.
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });
});

describe('resolveDoctorHealthUrl', () => {
  it('returns DOCTOR_HEALTH_URL verbatim when set', async () => {
    process.env.DOCTOR_HEALTH_URL = 'http://host.containers.internal:3004/api/health';
    const { resolveDoctorHealthUrl } = await import('../src/signalk-url-resolver.js');
    expect(await resolveDoctorHealthUrl()).toBe('http://host.containers.internal:3004/api/health');
    expect(mockExistsSync).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('falls back to host.containers.internal:3004 in a container when DNS resolves', async () => {
    mockExistsSync.mockReturnValue(true);
    mockLookup.mockResolvedValue({ address: '10.0.2.2', family: 4 });
    const { resolveDoctorHealthUrl } = await import('../src/signalk-url-resolver.js');
    expect(await resolveDoctorHealthUrl()).toBe('http://host.containers.internal:3004/api/health');
  });

  it('falls back to loopback outside a container', async () => {
    mockExistsSync.mockReturnValue(false);
    const { resolveDoctorHealthUrl } = await import('../src/signalk-url-resolver.js');
    expect(await resolveDoctorHealthUrl()).toBe('http://127.0.0.1:3004/api/health');
  });

  it('shares the container-host fallback with the signalk resolvers', async () => {
    mockExistsSync.mockReturnValue(true);
    mockLookup.mockResolvedValue({ address: '10.0.2.2', family: 4 });
    const mod = await import('../src/signalk-url-resolver.js');
    mod.resetSignalkUrlResolverForTests();
    await mod.resolveSignalkHealthUrl();
    await mod.resolveDoctorHealthUrl();
    await mod.resolveSignalkBaseUrl();
    // One detection across all three resolvers.
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });
});
