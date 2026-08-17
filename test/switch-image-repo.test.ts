import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The signalk-server image repo is a runtime setting (Advanced tab). These
 * tests pin the two switch-side contracts that make that safe:
 *
 *   * a forward switch resolves the repo through `resolveSignalkImage()` and
 *     uses that ONE value for pull, Quadlet rewrite and prune;
 *   * a rollback (`input.image` = the last-good entry's recorded full ref)
 *     goes back to the repo it was recorded from — NOT `<current repo>:<tag>`
 *     — even after the operator changed the repo, and prunes THAT repo.
 *
 * Same seams as rolledback-report.test.ts, plus version-settings so the
 * stored override is under test control.
 */

const mockReadVersionSettings = vi.fn();
vi.mock('../src/version-settings.js', () => ({
  readVersionSettings: () => mockReadVersionSettings(),
}));

vi.mock('../src/dbus/systemd-user.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/dbus/systemd-user.js')>();
  return {
    isSafeToStop: actual.isSafeToStop,
    daemonReload: () => Promise.resolve(),
    startUnit: () => Promise.resolve(),
    stopUnitAndWait: () => Promise.resolve(),
    waitWhileActivating: () => Promise.resolve('active'),
  };
});

const mockRewriteQuadletImage = vi.fn();
const mockWriteLastGood = vi.fn();
vi.mock('../src/quadlet/rewriter.js', () => ({
  rewriteQuadletImage: (q: string, i: string) => mockRewriteQuadletImage(q, i),
  writeLastGood: (q: string, e: unknown) => mockWriteLastGood(q, e),
}));

const mockPullImage = vi.fn();
const mockTrialRun = vi.fn();
vi.mock('../src/container-ops.js', () => ({
  DEFAULT_HEALTH_TIMEOUT_MS: 180_000,
  POST_SETTLE_HEALTH_TIMEOUT_MS: 60_000,
  pollHealth: () => Promise.resolve(true),
  pullImage: (ref: string) => mockPullImage(ref),
  trialRun: (ref: string, prefix: string) => mockTrialRun(ref, prefix),
}));

const mockInspectImage = vi.fn();
vi.mock('../src/podman/client.js', () => ({
  resolveRuntime: async () => ({
    kind: 'podman',
    socketPath: '/dev/null',
    client: { getImage: (ref: string) => ({ inspect: () => mockInspectImage(ref) }) },
  }),
  safe: async (fn: () => Promise<unknown>) => {
    try {
      return { ok: true as const, value: await fn() };
    } catch (err) {
      return { ok: false as const, error: { kind: 'unknown', userMessage: String(err), raw: '' } };
    }
  },
}));
vi.mock('../src/mutex.js', () => ({
  withMutex: (_op: string, fn: () => Promise<unknown>) => fn(),
  MutexBusyError: class MutexBusyError extends Error {},
}));
vi.mock('../src/backup.js', () => ({
  preSwitchBackup: () => Promise.resolve({ taken: false, reason: 'skipped' }),
}));
vi.mock('../src/switch-progress-broker.js', () => ({ publishSwitchEvent: vi.fn() }));
vi.mock('../src/drift-client.js', () => ({ refreshDoctorDrift: vi.fn() }));
const mockPrune = vi.fn();
vi.mock('../src/image-retention.js', () => ({
  pruneOldImagesFor: (repo: string, name: string, opts: unknown) => mockPrune(repo, name, opts),
}));
vi.mock('../src/update-checker.js', () => ({ invalidate: vi.fn() }));
const mockRecordImageSource = vi.fn();
const mockRecordImageSourceForRef = vi.fn();
vi.mock('../src/image-source.js', () => ({
  recordImageSource: (q: string, rec: unknown) => mockRecordImageSource(q, rec),
  recordImageSourceForRef: (q: string, ref: string) => mockRecordImageSourceForRef(q, ref),
}));
vi.mock('../src/last-outcome.js', () => ({ recordOutcome: vi.fn() }));
vi.mock('../src/signalk-url-resolver.js', () => ({
  resolveSignalkHealthUrl: () => Promise.resolve('http://127.0.0.1/signalk'),
  resolveDoctorHealthUrl: () => Promise.resolve('http://127.0.0.1:3004/api/health'),
}));

const { performSwitch } = await import('../src/switch-service.js');

const FORK = 'ghcr.io/fork/signalk-server';
const DIRKWA = 'ghcr.io/dirkwa/signalk-server';
const prevSignalkImage = process.env.SIGNALK_IMAGE;

afterEach(() => {
  if (prevSignalkImage === undefined) delete process.env.SIGNALK_IMAGE;
  else process.env.SIGNALK_IMAGE = prevSignalkImage;
});

beforeEach(() => {
  for (const m of [
    mockReadVersionSettings,
    mockRewriteQuadletImage,
    mockWriteLastGood,
    mockPullImage,
    mockTrialRun,
    mockPrune,
    mockInspectImage,
    mockRecordImageSource,
    mockRecordImageSourceForRef,
  ]) {
    m.mockReset();
  }
  mockInspectImage.mockResolvedValue({ Id: 'sha256:local' });
  mockRecordImageSource.mockResolvedValue(undefined);
  mockRecordImageSourceForRef.mockResolvedValue(undefined);
  delete process.env.SIGNALK_IMAGE;
  mockReadVersionSettings.mockResolvedValue({
    showBeta: false,
    showMaster: false,
    imageRepo: FORK,
  });
  mockPullImage.mockResolvedValue({ ok: true });
  mockTrialRun.mockResolvedValue({ ok: true });
  mockWriteLastGood.mockResolvedValue(undefined);
  mockPrune.mockResolvedValue({ removed: [] });
});

describe('performSwitch — image repo setting', () => {
  it('pulls, rewrites and prunes with the configured repo on a forward switch', async () => {
    // Quadlet was on the dirkwa repo → cross-repo switch.
    mockRewriteQuadletImage.mockResolvedValue({
      previousImage: `${DIRKWA}:dirkwa-old`,
      snapshotPath: '/s',
    });

    const result = await performSwitch({ tag: 'v2.24.0' });

    expect(result.ok).toBe(true);
    expect(mockPullImage).toHaveBeenCalledWith(`${FORK}:v2.24.0`);
    expect(mockTrialRun).toHaveBeenCalledWith(`${FORK}:v2.24.0`, expect.any(String));
    expect(mockRewriteQuadletImage).toHaveBeenCalledWith(
      'signalk-server.container',
      `${FORK}:v2.24.0`,
    );
    expect(mockWriteLastGood).toHaveBeenCalledWith(
      'signalk-server.container',
      expect.objectContaining({ tag: 'v2.24.0', image: `${FORK}:v2.24.0` }),
    );
    // Prune targets the repo we switched TO; the previous (other-repo) tag
    // can't be expressed as a protectTag of this repo and is simply left
    // alone — the old repo's images are never touched.
    expect(mockPrune).toHaveBeenCalledTimes(1);
    const [repo, name, opts] = mockPrune.mock.calls[0] as [
      string,
      string,
      { protectTags: string[] },
    ];
    expect(repo).toBe(FORK);
    expect(name).toBe('signalk-server');
    expect(opts.protectTags).not.toContain('dirkwa-old');
  });

  it('protects the previous tag when the switch stays inside one repo', async () => {
    mockRewriteQuadletImage.mockResolvedValue({
      previousImage: `${FORK}:v2.23.1`,
      snapshotPath: '/s',
    });

    await performSwitch({ tag: 'v2.24.0' });

    const [repo, , opts] = mockPrune.mock.calls[0] as [string, string, { protectTags: string[] }];
    expect(repo).toBe(FORK);
    expect(opts.protectTags).toContain('v2.23.1');
  });

  it('rollback honours the recorded full ref, not <current repo>:<tag>', async () => {
    // Operator has switched to the fork; the last-good entry was recorded
    // back when the box ran dirkwa. The rollback route hands us that ref.
    mockRewriteQuadletImage.mockResolvedValue({
      previousImage: `${FORK}:v2.24.0`,
      snapshotPath: '/s',
    });

    const result = await performSwitch({
      tag: 'dirkwa-old',
      image: `${DIRKWA}:dirkwa-old`,
      skipBackup: true,
    });

    expect(result.ok).toBe(true);
    expect(mockPullImage).toHaveBeenCalledWith(`${DIRKWA}:dirkwa-old`);
    expect(mockRewriteQuadletImage).toHaveBeenCalledWith(
      'signalk-server.container',
      `${DIRKWA}:dirkwa-old`,
    );
    // The setting still says fork, but the ref we actually wrote wins for
    // the prune too — nothing in the fork repo is touched by this rollback.
    expect(mockPrune.mock.calls[0]?.[0]).toBe(DIRKWA);
    expect(mockPullImage).not.toHaveBeenCalledWith(`${FORK}:dirkwa-old`);
    // Provenance for an internally supplied ref is looked up per ref, so an
    // archive-sourced ref rolled back to stays archive-sourced.
    expect(mockRecordImageSourceForRef).toHaveBeenCalledWith(
      'signalk-server.container',
      `${DIRKWA}:dirkwa-old`,
    );
    expect(mockRecordImageSource).not.toHaveBeenCalled();
  });

  it('falls back to the built-in repo when no setting is stored', async () => {
    mockReadVersionSettings.mockResolvedValue({
      showBeta: false,
      showMaster: false,
      imageRepo: null,
    });
    mockRewriteQuadletImage.mockResolvedValue({
      previousImage: `${DIRKWA}:dirkwa-old`,
      snapshotPath: '/s',
    });

    await performSwitch({ tag: 'dirkwa-new' });

    expect(mockPullImage).toHaveBeenCalledWith(`${DIRKWA}:dirkwa-new`);
    const [, , opts] = mockPrune.mock.calls[0] as [string, string, { protectTags: string[] }];
    expect(opts.protectTags).toContain('dirkwa-old');
  });

  it('records registry provenance after a normal switch', async () => {
    mockRewriteQuadletImage.mockResolvedValue({
      previousImage: `${FORK}:v2.23.1`,
      snapshotPath: '/s',
    });
    await performSwitch({ tag: 'v2.24.0' });
    expect(mockRecordImageSource).toHaveBeenCalledWith('signalk-server.container', {
      ref: `${FORK}:v2.24.0`,
      source: 'registry',
    });
  });

  it('skipPull: never pulls, confirms the local image, records archive provenance', async () => {
    mockRewriteQuadletImage.mockResolvedValue({
      previousImage: `${DIRKWA}:dirkwa-old`,
      snapshotPath: '/s',
    });
    const result = await performSwitch({
      tag: '2.24.0',
      image: `${DIRKWA}:2.24.0`,
      skipPull: true,
      source: { kind: 'archive', name: 'sk.tar', mtimeMs: 1234 },
    });
    expect(result.ok).toBe(true);
    expect(mockPullImage).not.toHaveBeenCalled();
    expect(mockInspectImage).toHaveBeenCalledWith(`${DIRKWA}:2.24.0`);
    expect(mockTrialRun).toHaveBeenCalledWith(`${DIRKWA}:2.24.0`, expect.any(String));
    expect(mockRewriteQuadletImage).toHaveBeenCalledWith(
      'signalk-server.container',
      `${DIRKWA}:2.24.0`,
    );
    expect(mockRecordImageSource).toHaveBeenCalledWith('signalk-server.container', {
      ref: `${DIRKWA}:2.24.0`,
      source: 'archive',
      archive: 'sk.tar',
      archiveMtimeMs: 1234,
    });
  });

  it('skipPull: fails cleanly (no rewrite) when the image is not in the local store', async () => {
    mockInspectImage.mockRejectedValue(new Error('no such image'));
    const result = await performSwitch({ tag: '9.9.9', image: `${DIRKWA}:9.9.9`, skipPull: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in local store/);
    expect(mockRewriteQuadletImage).not.toHaveBeenCalled();
    expect(mockPullImage).not.toHaveBeenCalled();
  });
});
