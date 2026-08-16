import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockReadVersionSettings = vi.fn();
vi.mock('../src/version-settings.js', () => ({
  readVersionSettings: () => mockReadVersionSettings(),
}));

const { BUILTIN_SIGNALK_IMAGE, ghcrPath, normalizeImageRepo, repoOfRef, resolveSignalkImage } =
  await import('../src/signalk-image.js');

describe('normalizeImageRepo', () => {
  const ok = (input: string, expected: string): void => {
    const r = normalizeImageRepo(input);
    expect(r, input).toEqual({ ok: true, value: expected });
  };
  const bad = (input: string, pattern: RegExp): void => {
    const r = normalizeImageRepo(input);
    expect(r.ok, input).toBe(false);
    if (!r.ok) expect(r.error).toMatch(pattern);
  };

  it('canonicalises accepted forms to ghcr.io/<owner>/<name>', () => {
    ok('dirkwa/signalk-server', 'ghcr.io/dirkwa/signalk-server');
    ok('ghcr.io/dirkwa/signalk-server', 'ghcr.io/dirkwa/signalk-server');
    ok('  GHCR.IO/Someone/SignalK-Server/ ', 'ghcr.io/someone/signalk-server');
    ok('https://ghcr.io/someone/signalk-server', 'ghcr.io/someone/signalk-server');
    ok('http://ghcr.io/someone/signalk-server/', 'ghcr.io/someone/signalk-server');
    // GHCR nests namespaces; more than two segments is fine.
    ok('ghcr.io/org/team/signalk-server', 'ghcr.io/org/team/signalk-server');
    ok('owner/my_image.v2-x', 'ghcr.io/owner/my_image.v2-x');
  });

  it('rejects tags, digests, other registries, and malformed paths', () => {
    bad('', /empty/i);
    bad('ghcr.io/dirkwa/signalk-server:latest', /tag/i);
    bad('dirkwa/signalk-server:2.24.0', /tag/i);
    bad('ghcr.io/dirkwa/signalk-server@sha256:abcdef', /digest/i);
    bad('docker.io/library/nginx', /only ghcr\.io/i);
    bad('registry.example.com/x/y', /only ghcr\.io/i);
    bad('ghcr.io:443/dirkwa/signalk-server', /only ghcr\.io/i);
    bad('signalk-server', /owner/i);
    bad('ghcr.io/signalk-server', /owner/i);
    bad('ghcr.io/dirkwa/signal k', /segment/i);
    bad('ghcr.io/dirkwa/-bad', /segment/i);
    bad('ghcr.io/dirkwa//double', /segment/i);
    bad('ghcr.io/dirkwa/a..b', /segment/i);
  });
});

describe('ghcrPath / repoOfRef', () => {
  it('strips the ghcr.io host and leaves hostless values alone', () => {
    expect(ghcrPath('ghcr.io/dirkwa/signalk-server')).toBe('dirkwa/signalk-server');
    expect(ghcrPath('dirkwa/signalk-server')).toBe('dirkwa/signalk-server');
  });

  it('drops the tag (and digest) but not a registry port', () => {
    expect(repoOfRef('ghcr.io/dirkwa/signalk-server:dirkwa-abc')).toBe(
      'ghcr.io/dirkwa/signalk-server',
    );
    expect(repoOfRef('ghcr.io/dirkwa/signalk-server:2.24.0@sha256:abc')).toBe(
      'ghcr.io/dirkwa/signalk-server',
    );
    expect(repoOfRef('ghcr.io/dirkwa/signalk-server')).toBe('ghcr.io/dirkwa/signalk-server');
    expect(repoOfRef('ghcr.io:443/dirkwa/signalk-server')).toBe(
      'ghcr.io:443/dirkwa/signalk-server',
    );
  });
});

describe('resolveSignalkImage', () => {
  const prevEnv = process.env.SIGNALK_IMAGE;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.SIGNALK_IMAGE;
    mockReadVersionSettings.mockReset();
    mockReadVersionSettings.mockResolvedValue({
      showBeta: false,
      showMaster: false,
      imageRepo: null,
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SIGNALK_IMAGE;
    else process.env.SIGNALK_IMAGE = prevEnv;
    warnSpy.mockRestore();
  });

  it('falls back to the built-in repo with no setting and no env', async () => {
    await expect(resolveSignalkImage()).resolves.toEqual({
      image: BUILTIN_SIGNALK_IMAGE,
      source: 'default',
      defaultImage: BUILTIN_SIGNALK_IMAGE,
    });
  });

  it('uses SIGNALK_IMAGE (normalised) as the default when set', async () => {
    process.env.SIGNALK_IMAGE = 'someone/signalk-server';
    await expect(resolveSignalkImage()).resolves.toEqual({
      image: 'ghcr.io/someone/signalk-server',
      source: 'default',
      defaultImage: 'ghcr.io/someone/signalk-server',
    });
  });

  it('prefers the stored setting over env, and reports env as the default', async () => {
    process.env.SIGNALK_IMAGE = 'ghcr.io/env/signalk-server';
    mockReadVersionSettings.mockResolvedValue({
      showBeta: false,
      showMaster: false,
      imageRepo: 'ghcr.io/fork/signalk-server',
    });
    await expect(resolveSignalkImage()).resolves.toEqual({
      image: 'ghcr.io/fork/signalk-server',
      source: 'setting',
      defaultImage: 'ghcr.io/env/signalk-server',
    });
  });

  it('ignores an invalid stored value and an invalid env, warning once each', async () => {
    process.env.SIGNALK_IMAGE = 'docker.io/x/y';
    mockReadVersionSettings.mockResolvedValue({
      showBeta: false,
      showMaster: false,
      imageRepo: 'ghcr.io/fork/signalk-server:latest',
    });
    await expect(resolveSignalkImage()).resolves.toEqual({
      image: BUILTIN_SIGNALK_IMAGE,
      source: 'default',
      defaultImage: BUILTIN_SIGNALK_IMAGE,
    });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('treats a non-string stored value as unset', async () => {
    mockReadVersionSettings.mockResolvedValue({
      showBeta: false,
      showMaster: false,
      imageRepo: 42,
    });
    const r = await resolveSignalkImage();
    expect(r.source).toBe('default');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
