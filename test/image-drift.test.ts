import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the dockerode-shaped client (same seam as runtime-version.test.ts)
// and the GHCR remote-digest helper. The drift resolver reads the Quadlet
// ref from a per-test mkdtemp via QUADLET_DIR.
const mockResolveRuntime = vi.fn();
const mockSafe = vi.fn();
vi.mock('../src/podman/client.js', () => ({
  resolveRuntime: () => mockResolveRuntime(),
  safe: (fn: () => Promise<unknown>) => mockSafe(fn),
}));

const mockHeadManifestDigest = vi.fn();
vi.mock('../src/ghcr.js', () => ({
  headManifestDigest: (image: string, tag: string) => mockHeadManifestDigest(image, tag),
}));

let dir: string;
const originalQuadletDir = process.env.QUADLET_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'image-drift-test-'));
  process.env.QUADLET_DIR = dir;
  mockResolveRuntime.mockReset();
  mockSafe.mockReset();
  mockHeadManifestDigest.mockReset();
  // Default: safe() forwards through, surfacing thrown errors as !ok.
  mockSafe.mockImplementation(async (fn: () => Promise<unknown>) => {
    try {
      return { ok: true as const, value: await fn() };
    } catch (err) {
      return { ok: false as const, error: { kind: 'unknown', userMessage: String(err), raw: '' } };
    }
  });
});

afterEach(async () => {
  if (originalQuadletDir === undefined) delete process.env.QUADLET_DIR;
  else process.env.QUADLET_DIR = originalQuadletDir;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function writeQuadlet(name: string, imageLine: string): Promise<void> {
  await writeFile(join(dir, name), `[Container]\nImage=${imageLine}\n`);
}

/**
 * Build a dockerode-shaped client whose container/image inspects return
 * the supplied fixtures. `containerInspect` is the running container;
 * `imagesByRef` maps an image ref or id to its inspect payload.
 */
function mockRuntime(opts: {
  containerInspect?: Record<string, unknown> | Error;
  imagesByRef?: Record<string, Record<string, unknown> | Error>;
}): void {
  mockResolveRuntime.mockResolvedValue({
    client: {
      getContainer: () => ({
        inspect: async () => {
          if (opts.containerInspect instanceof Error) throw opts.containerInspect;
          return opts.containerInspect ?? {};
        },
      }),
      getImage: (ref: string) => ({
        inspect: async () => {
          const entry = opts.imagesByRef?.[ref];
          if (entry === undefined) throw new Error(`no such image: ${ref}`);
          if (entry instanceof Error) throw entry;
          return entry;
        },
      }),
    },
  });
}

const REF = 'ghcr.io/dirkwa/signalk-server:dirkwa';

describe('getImageDrift — restart-required (the not-restarted case)', () => {
  it('flags restart-required when running image id != local tag id', async () => {
    await writeQuadlet('server.container', REF);
    // The real scenario on this host: container runs an OLD, now-dangling
    // image (id A, digest from ImageDigest); the :dirkwa tag resolves to a
    // NEWER image (id B). RepoDigests of the running image is empty.
    mockRuntime({
      containerInspect: { Image: 'sha256:AAAA', ImageDigest: 'sha256:run-digest' },
      imagesByRef: {
        'sha256:AAAA': { Id: 'sha256:AAAA', Digest: 'sha256:run-digest', RepoDigests: [] },
        [REF]: {
          Id: 'sha256:BBBB',
          RepoDigests: [
            'ghcr.io/dirkwa/signalk-server@sha256:new-1',
            'ghcr.io/dirkwa/signalk-server@sha256:new-2',
          ],
        },
      },
    });
    const { getImageDrift } = await import('../src/image-drift.js');
    const drift = await getImageDrift('signalk-server', 'server.container', { checkRemote: false });
    expect(drift.state).toBe('restart-required');
    expect(drift.runningDigest).toBe('sha256:run-digest');
    expect(drift.localTagDigests).toEqual(['sha256:new-1', 'sha256:new-2']);
  });

  it('reports in-sync when running id == local tag id', async () => {
    await writeQuadlet('server.container', REF);
    mockRuntime({
      containerInspect: { Image: 'sha256:SAME', ImageDigest: 'sha256:d1' },
      imagesByRef: {
        'sha256:SAME': {
          Id: 'sha256:SAME',
          RepoDigests: ['ghcr.io/dirkwa/signalk-server@sha256:d1'],
        },
        [REF]: {
          Id: 'sha256:SAME',
          RepoDigests: ['ghcr.io/dirkwa/signalk-server@sha256:d1'],
        },
      },
    });
    const { getImageDrift } = await import('../src/image-drift.js');
    const drift = await getImageDrift('signalk-server', 'server.container', { checkRemote: false });
    expect(drift.state).toBe('in-sync');
  });

  it('falls back to digest-set membership when an image id is missing', async () => {
    await writeQuadlet('server.container', REF);
    // No container .Image id (docker edge case); only a digest. The local
    // tag carries a digest set that does NOT include the running digest.
    mockRuntime({
      containerInspect: { ImageDigest: 'sha256:run-only' },
      imagesByRef: {
        [REF]: {
          Id: 'sha256:BBBB',
          RepoDigests: ['ghcr.io/dirkwa/signalk-server@sha256:other'],
        },
      },
    });
    const { getImageDrift } = await import('../src/image-drift.js');
    const drift = await getImageDrift('signalk-server', 'server.container', { checkRemote: false });
    expect(drift.state).toBe('restart-required');
  });
});

describe('getImageDrift — pull-available (the tag-moved-on-GHCR case)', () => {
  it('flags pull-available when remote digest not among local digests', async () => {
    await writeQuadlet('server.container', REF);
    mockRuntime({
      // Running == local, so the only drift is remote.
      containerInspect: { Image: 'sha256:SAME', ImageDigest: 'sha256:local' },
      imagesByRef: {
        'sha256:SAME': {
          Id: 'sha256:SAME',
          RepoDigests: ['ghcr.io/dirkwa/signalk-server@sha256:local'],
        },
        [REF]: {
          Id: 'sha256:SAME',
          RepoDigests: ['ghcr.io/dirkwa/signalk-server@sha256:local'],
        },
      },
    });
    mockHeadManifestDigest.mockResolvedValue('sha256:remote-new');
    const { getImageDrift } = await import('../src/image-drift.js');
    const drift = await getImageDrift('signalk-server', 'server.container', { checkRemote: true });
    expect(drift.state).toBe('pull-available');
    expect(drift.remoteTagDigest).toBe('sha256:remote-new');
    expect(mockHeadManifestDigest).toHaveBeenCalledWith('dirkwa/signalk-server', 'dirkwa');
  });

  it('does NOT call the registry when checkRemote is false', async () => {
    await writeQuadlet('server.container', REF);
    mockRuntime({
      containerInspect: { Image: 'sha256:SAME' },
      imagesByRef: {
        'sha256:SAME': {
          Id: 'sha256:SAME',
          RepoDigests: ['ghcr.io/dirkwa/signalk-server@sha256:x'],
        },
        [REF]: { Id: 'sha256:SAME', RepoDigests: ['ghcr.io/dirkwa/signalk-server@sha256:x'] },
      },
    });
    const { getImageDrift } = await import('../src/image-drift.js');
    const drift = await getImageDrift('signalk-server', 'server.container', { checkRemote: false });
    expect(mockHeadManifestDigest).not.toHaveBeenCalled();
    expect(drift.state).toBe('in-sync');
  });

  it('suppresses pull-available when the registry is unreachable (null digest)', async () => {
    await writeQuadlet('server.container', REF);
    mockRuntime({
      containerInspect: { Image: 'sha256:SAME' },
      imagesByRef: {
        'sha256:SAME': {
          Id: 'sha256:SAME',
          RepoDigests: ['ghcr.io/dirkwa/signalk-server@sha256:x'],
        },
        [REF]: { Id: 'sha256:SAME', RepoDigests: ['ghcr.io/dirkwa/signalk-server@sha256:x'] },
      },
    });
    mockHeadManifestDigest.mockResolvedValue(null);
    const { getImageDrift } = await import('../src/image-drift.js');
    const drift = await getImageDrift('signalk-server', 'server.container', { checkRemote: true });
    // Running == local and remote unknown → in-sync, not a guessed pull.
    expect(drift.state).toBe('in-sync');
  });
});

describe('getImageDrift — combined and edge cases', () => {
  it('reports pull-and-restart when both checks find drift', async () => {
    await writeQuadlet('server.container', REF);
    mockRuntime({
      containerInspect: { Image: 'sha256:OLD', ImageDigest: 'sha256:old' },
      imagesByRef: {
        'sha256:OLD': { Id: 'sha256:OLD', RepoDigests: [] },
        [REF]: {
          Id: 'sha256:LOCALNEW',
          RepoDigests: ['ghcr.io/dirkwa/signalk-server@sha256:localnew'],
        },
      },
    });
    mockHeadManifestDigest.mockResolvedValue('sha256:remotenewer');
    const { getImageDrift } = await import('../src/image-drift.js');
    const drift = await getImageDrift('signalk-server', 'server.container', { checkRemote: true });
    expect(drift.state).toBe('pull-and-restart');
  });

  it('reports pull-available when the tag is not pulled locally at all', async () => {
    await writeQuadlet('server.container', REF);
    mockRuntime({
      containerInspect: { Image: 'sha256:OLD', ImageDigest: 'sha256:old' },
      imagesByRef: {
        'sha256:OLD': {
          Id: 'sha256:OLD',
          RepoDigests: ['ghcr.io/dirkwa/signalk-server@sha256:old'],
        },
        // No entry for REF → getImage(REF) throws → local tag absent.
      },
    });
    mockHeadManifestDigest.mockResolvedValue('sha256:remote');
    const { getImageDrift } = await import('../src/image-drift.js');
    const drift = await getImageDrift('signalk-server', 'server.container', { checkRemote: true });
    // local digests empty + remote resolves → a pull is available. The
    // restart check can't compare (no local id), so it stays null → pull.
    expect(drift.state).toBe('pull-available');
  });

  it('returns unknown for a digest-pinned Quadlet (nothing to drift against)', async () => {
    await writeQuadlet(
      'server.container',
      'ghcr.io/dirkwa/signalk-server@sha256:0000000000000000000000000000000000000000000000000000000000000000',
    );
    const { getImageDrift } = await import('../src/image-drift.js');
    const drift = await getImageDrift('signalk-server', 'server.container', { checkRemote: true });
    expect(drift.state).toBe('unknown');
    expect(mockResolveRuntime).not.toHaveBeenCalled();
  });

  it('returns unknown when the Quadlet file is missing', async () => {
    const { getImageDrift } = await import('../src/image-drift.js');
    const drift = await getImageDrift('signalk-server', 'nope.container', { checkRemote: true });
    expect(drift.state).toBe('unknown');
  });

  it('returns unknown when the runtime is unavailable and remote is off', async () => {
    await writeQuadlet('server.container', REF);
    mockResolveRuntime.mockResolvedValue(null);
    const { getImageDrift } = await import('../src/image-drift.js');
    const drift = await getImageDrift('signalk-server', 'server.container', { checkRemote: false });
    // No running id/digest, no local digests, no remote → both checks null.
    expect(drift.state).toBe('unknown');
  });

  it('skips the remote check for a non-ghcr ref', async () => {
    await writeQuadlet('server.container', 'docker.io/library/redis:7');
    mockRuntime({
      containerInspect: { Image: 'sha256:SAME' },
      imagesByRef: {
        'sha256:SAME': { Id: 'sha256:SAME', RepoDigests: ['docker.io/library/redis@sha256:r'] },
        'docker.io/library/redis:7': {
          Id: 'sha256:SAME',
          RepoDigests: ['docker.io/library/redis@sha256:r'],
        },
      },
    });
    const { getImageDrift } = await import('../src/image-drift.js');
    const drift = await getImageDrift('redis', 'server.container', { checkRemote: true });
    expect(mockHeadManifestDigest).not.toHaveBeenCalled();
    expect(drift.state).toBe('in-sync');
  });
});

describe('deriveState — tri-state folding', () => {
  it('maps the boolean combinations to the wire enum', async () => {
    const { deriveState } = await import('../src/image-drift.js');
    expect(deriveState(true, true)).toBe('pull-and-restart');
    expect(deriveState(false, true)).toBe('pull-available');
    expect(deriveState(true, false)).toBe('restart-required');
    expect(deriveState(false, false)).toBe('in-sync');
    expect(deriveState(null, null)).toBe('unknown');
    // A null check never invents drift; the determinable side wins.
    expect(deriveState(null, true)).toBe('pull-available');
    expect(deriveState(true, null)).toBe('restart-required');
    expect(deriveState(null, false)).toBe('in-sync');
    expect(deriveState(false, null)).toBe('in-sync');
  });
});
