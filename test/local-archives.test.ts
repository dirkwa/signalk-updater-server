import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';

// dockerode seam (same style as image-retention.test.ts): a fake client
// with listImages + loadImage drives every path.
const mockResolveRuntime = vi.fn();
vi.mock('../src/podman/client.js', () => ({
  resolveRuntime: () => mockResolveRuntime(),
  safe: async (fn: () => Promise<unknown>) => {
    try {
      return { ok: true as const, value: await fn() };
    } catch (err) {
      return {
        ok: false as const,
        error: {
          kind: 'unknown',
          userMessage: err instanceof Error ? err.message : String(err),
          raw: '',
        },
      };
    }
  },
}));

const dir = mkdtempSync(join(tmpdir(), 'local-archives-'));
process.env.LOCAL_IMAGES_DIR = join(dir, 'images');
process.env.ARCHIVE_INDEX_PATH = join(dir, 'archive-index.json');

const {
  archiveFormat,
  deleteArchive,
  interpretManifests,
  isValidArchiveName,
  listArchives,
  loadArchive,
  parseLoadedRefs,
  pickArchiveRef,
} = await import('../src/local-archives.js');
const { peekTarFile, peekTarStream } = await import('../src/tar-peek.js');

// ------------------------------------------------------------ tar builder

interface Member {
  name: string;
  data: Buffer;
  type?: string;
  /** Emit a PAX `path=` header naming this entry (name field then holds junk). */
  pax?: boolean;
  /** Emit a GNU LongLink header naming this entry. */
  longlink?: boolean;
}

function header(name: string, size: number, type: string, prefix = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148); // checksum placeholder
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  if (prefix) h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

function pad(buf: Buffer): Buffer {
  const rem = buf.length % 512;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - rem)]);
}

function buildTar(members: Member[]): Buffer {
  const parts: Buffer[] = [];
  for (const m of members) {
    if (m.pax) {
      const rec = `path=${m.name}\n`;
      const len = rec.length + String(rec.length + 3).length + 1; // "<len> " + rec
      const line = `${len} ${rec}`;
      const data = Buffer.from(line);
      parts.push(header('PaxHeader/x', data.length, 'x'), pad(data));
      parts.push(header('x', m.data.length, m.type ?? '0'), pad(m.data));
      continue;
    }
    if (m.longlink) {
      const data = Buffer.from(m.name + '\0');
      parts.push(header('././@LongLink', data.length, 'L'), pad(data));
      parts.push(header('trunc', m.data.length, m.type ?? '0'), pad(m.data));
      continue;
    }
    parts.push(header(m.name, m.data.length, m.type ?? '0'), pad(m.data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const CFG_HEX = 'a'.repeat(64);
const dockerManifest = (repoTags: string[] | null): Buffer =>
  Buffer.from(
    JSON.stringify([{ Config: `blobs/sha256/${CFG_HEX}`, RepoTags: repoTags, Layers: [] }]),
  );
const ociIndex = (ref: string): Buffer =>
  Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      manifests: [{ annotations: { 'org.opencontainers.image.ref.name': ref } }],
    }),
  );
const bigLayer = Buffer.alloc(3 * 512 + 17, 1);

function dockerArchive(repoTags: string[] | null): Buffer {
  return buildTar([
    { name: 'blobs/sha256/deadbeef', data: bigLayer },
    { name: `blobs/sha256/${CFG_HEX}`, data: Buffer.from('{}') },
    { name: 'manifest.json', data: dockerManifest(repoTags) },
    { name: 'repositories', data: Buffer.from('{}') },
  ]);
}

// ------------------------------------------------------------------ tests

describe('isValidArchiveName / archiveFormat', () => {
  it('accepts plain names with the three extensions and rejects paths/dotfiles', () => {
    for (const ok of ['sk.tar', 'signalk-server_2.24.0.tar.gz', 'x.tgz', 'A1.tar']) {
      expect(isValidArchiveName(ok), ok).toBe(true);
    }
    for (const bad of [
      '../sk.tar',
      'a/b.tar',
      '.hidden.tar',
      'sk.zip',
      'sk.tar.xz',
      '',
      'sk.TAR',
      'sk .tar',
    ]) {
      expect(isValidArchiveName(bad), bad).toBe(false);
    }
    expect(archiveFormat('a.tar')).toBe('tar');
    expect(archiveFormat('a.tar.gz')).toBe('tgz');
    expect(archiveFormat('a.tgz')).toBe('tgz');
  });
});

describe('tar peek', () => {
  const W = new Set(['manifest.json', 'index.json']);

  it('finds manifest.json in a docker-archive by seeking, without reading layers', async () => {
    const path = join(dir, 'peek-docker.tar');
    writeFileSync(path, dockerArchive(['ghcr.io/x/y:1.0.0']));
    const found = await peekTarFile(path, W);
    expect([...found.keys()]).toEqual(['manifest.json']);
    expect(interpretManifests(found)).toEqual({
      refs: ['ghcr.io/x/y:1.0.0'],
      imageId: `sha256:${CFG_HEX}`,
    });
  });

  it('reads an oci-archive index.json (ref, no image id) and ./-prefixed names', async () => {
    const path = join(dir, 'peek-oci.tar');
    writeFileSync(
      path,
      buildTar([
        { name: './oci-layout', data: Buffer.from('{}') },
        { name: './index.json', data: ociIndex('ghcr.io/x/y:2.0.0') },
      ]),
    );
    const found = await peekTarFile(path, W);
    expect(interpretManifests(found)).toEqual({ refs: ['ghcr.io/x/y:2.0.0'], imageId: null });
  });

  it('honours PAX path and GNU LongLink names', async () => {
    const path = join(dir, 'peek-long.tar');
    writeFileSync(
      path,
      buildTar([{ name: 'manifest.json', data: dockerManifest(['ghcr.io/x/y:pax']), pax: true }]),
    );
    expect(interpretManifests(await peekTarFile(path, W)).refs).toEqual(['ghcr.io/x/y:pax']);
    const path2 = join(dir, 'peek-long2.tar');
    writeFileSync(
      path2,
      buildTar([
        { name: 'manifest.json', data: dockerManifest(['ghcr.io/x/y:ll']), longlink: true },
      ]),
    );
    expect(interpretManifests(await peekTarFile(path2, W)).refs).toEqual(['ghcr.io/x/y:ll']);
  });

  it('streams a gzipped archive and returns the same answer', async () => {
    const gz = gzipSync(dockerArchive(['ghcr.io/x/y:gz']));
    const { createGunzip } = await import('node:zlib');
    const found = await peekTarStream(Readable.from([gz]).pipe(createGunzip()), W);
    expect(interpretManifests(found).refs).toEqual(['ghcr.io/x/y:gz']);
  });

  it('streams in tiny chunks (header split across chunks) correctly', async () => {
    const tar = dockerArchive(['ghcr.io/x/y:chunky']);
    const chunks: Buffer[] = [];
    for (let i = 0; i < tar.length; i += 7) chunks.push(tar.subarray(i, i + 7));
    const found = await peekTarStream(Readable.from(chunks), W);
    expect(interpretManifests(found).refs).toEqual(['ghcr.io/x/y:chunky']);
  });

  it('stops (no hang, no throw) on non-tar bytes and on a bad checksum, in both walkers', async () => {
    const garbage = Buffer.alloc(4096, 0x41); // "AAAA…" — parses to nonsense sizes
    const path = join(dir, 'peek-garbage.tar');
    writeFileSync(path, garbage);
    expect((await peekTarFile(path, W)).size).toBe(0);
    expect((await peekTarStream(Readable.from([garbage]), W)).size).toBe(0);
    // A real header with a corrupted checksum byte is rejected too.
    const tar = dockerArchive(['ghcr.io/x/y:1.0.0']);
    tar[150] = 0x39; // stomp the checksum field
    expect((await peekTarStream(Readable.from([tar]), W)).size).toBe(0);
  });

  it('never allocates for an entry that claims to be huge (skips it instead)', async () => {
    // A manifest.json header claiming ~5 GB with no data behind it: the
    // seek walker must not Buffer.alloc that; it just runs off the end.
    const h = header('manifest.json', 0, '0');
    h.write('45000000000\0', 124); // octal 45000000000 ≈ 5.0 GB
    // recompute checksum
    h.write('        ', 148);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    const path = join(dir, 'peek-huge.tar');
    writeFileSync(path, Buffer.concat([h, Buffer.alloc(1024)]));
    expect((await peekTarFile(path, W)).size).toBe(0);
    expect(
      (await peekTarStream(Readable.from([Buffer.concat([h, Buffer.alloc(1024)])]), W)).size,
    ).toBe(0);
  });

  it('reports unknown for a tar without manifests and empty refs for an id-only save', async () => {
    const none = join(dir, 'peek-none.tar');
    writeFileSync(none, buildTar([{ name: 'random.txt', data: Buffer.from('hi') }]));
    expect(interpretManifests(await peekTarFile(none, W))).toEqual({ refs: null, imageId: null });
    const idOnly = join(dir, 'peek-idonly.tar');
    writeFileSync(idOnly, dockerArchive(null));
    expect(interpretManifests(await peekTarFile(idOnly, W))).toEqual({
      refs: [],
      imageId: `sha256:${CFG_HEX}`,
    });
  });
});

describe('parseLoadedRefs / pickArchiveRef', () => {
  it('extracts refs and the image id from daemon output', () => {
    expect(
      parseLoadedRefs(
        'Getting image source signatures\nLoaded image: ghcr.io/x/y:1.0.0\nLoaded image: ghcr.io/x/y:latest\nLoaded image ID: sha256:' +
          CFG_HEX,
      ),
    ).toEqual({ refs: ['ghcr.io/x/y:1.0.0', 'ghcr.io/x/y:latest'], imageId: `sha256:${CFG_HEX}` });
    expect(parseLoadedRefs('nothing here')).toEqual({ refs: [], imageId: null });
  });

  it('prefers a ref under the configured repo, else the first; null without refs', () => {
    expect(
      pickArchiveRef(
        { refs: ['ghcr.io/a/x:1', 'ghcr.io/fork/signalk-server:1'] },
        'ghcr.io/fork/signalk-server',
      ),
    ).toEqual({ ref: 'ghcr.io/fork/signalk-server:1', tag: '1' });
    expect(pickArchiveRef({ refs: ['ghcr.io/a/x:1'] }, 'ghcr.io/fork/signalk-server')).toEqual({
      ref: 'ghcr.io/a/x:1',
      tag: '1',
    });
    expect(pickArchiveRef({ refs: [] }, 'x')).toBeNull();
    expect(pickArchiveRef({ refs: null }, 'x')).toBeNull();
  });
});

describe('listArchives / loadArchive / deleteArchive', () => {
  const images = join(dir, 'images');
  let listImagesPayload: Array<{ Id: string; RepoTags: string[] | null }> = [];
  let loadOutput = '';
  let loadCalls: Array<{ bytes: number }> = [];

  beforeEach(async () => {
    await rm(images, { recursive: true, force: true });
    mkdirSync(images, { recursive: true });
    await rm(process.env.ARCHIVE_INDEX_PATH as string, { force: true });
    listImagesPayload = [];
    loadOutput = '';
    loadCalls = [];
    mockResolveRuntime.mockReset();
    mockResolveRuntime.mockResolvedValue({
      kind: 'podman',
      socketPath: '/dev/null',
      client: {
        listImages: async () => listImagesPayload,
        loadImage: (
          body: Readable,
          _opts: unknown,
          cb: (err: Error | null, stream?: Readable) => void,
        ) => {
          // Drain the upload, then answer with docker-style JSON lines.
          let bytes = 0;
          body.on('data', (c: Buffer) => {
            bytes += c.length;
          });
          body.on('end', () => {
            loadCalls.push({ bytes });
            cb(null, Readable.from([Buffer.from(JSON.stringify({ stream: loadOutput }) + '\n')]));
          });
        },
        modem: {
          followProgress: (
            stream: Readable,
            onFinished: (err: Error | null) => void,
            onProgress: (ev: unknown) => void,
          ) => {
            let text = '';
            stream.on('data', (c: Buffer) => {
              text += c.toString();
            });
            stream.on('end', () => {
              for (const line of text.split('\n').filter(Boolean)) onProgress(JSON.parse(line));
              onFinished(null);
            });
          },
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates the folder, lists only valid archives, peeks refs, and marks loaded ones', async () => {
    rmSync(images, { recursive: true, force: true });
    const first = await listArchives();
    expect(first.dir).toBe(images);
    expect(first.archives).toEqual([]);

    writeFileSync(join(images, 'a.tar'), dockerArchive(['ghcr.io/x/y:1.0.0']));
    writeFileSync(join(images, 'b.tar.gz'), gzipSync(dockerArchive(['ghcr.io/x/y:2.0.0'])));
    writeFileSync(join(images, 'notes.txt'), 'ignored');
    writeFileSync(join(images, '.hidden.tar'), 'ignored');
    // b's tag is in the store AND resolves to the archive's image id → loaded.
    listImagesPayload = [{ Id: `sha256:${CFG_HEX}`, RepoTags: ['ghcr.io/x/y:2.0.0'] }];

    const r = await listArchives();
    expect(r.archives.map((a) => a.name)).toEqual(['a.tar', 'b.tar.gz']);
    const a = r.archives[0]!;
    const b = r.archives[1]!;
    expect(a).toMatchObject({ format: 'tar', refs: ['ghcr.io/x/y:1.0.0'], loaded: false });
    expect(a.imageId).toBe(`sha256:${CFG_HEX}`);
    expect(b).toMatchObject({ format: 'tgz', refs: ['ghcr.io/x/y:2.0.0'], loaded: true });
    expect(typeof a.size).toBe('number');
    expect(Date.parse(a.mtime)).not.toBeNaN();
  });

  it('"loaded" means the ref resolves to THIS archive\'s image, and peeks are cached by size+mtime', async () => {
    writeFileSync(join(images, 'a.tar'), dockerArchive(['ghcr.io/x/y:1.0.0']));
    // Same id in the store but under a different tag → a Switch to the
    // archive's ref would not start it → not loaded.
    listImagesPayload = [{ Id: `sha256:${CFG_HEX}`, RepoTags: ['something/else:1'] }];
    expect((await listArchives()).archives[0]?.loaded).toBe(false);
    // The tag exists but points at a DIFFERENT image (re-pulled later) → not loaded.
    listImagesPayload = [{ Id: 'sha256:' + 'e'.repeat(64), RepoTags: ['ghcr.io/x/y:1.0.0'] }];
    expect((await listArchives()).archives[0]?.loaded).toBe(false);
    // Tag present and resolving to the archive's id → loaded.
    listImagesPayload = [{ Id: `sha256:${CFG_HEX}`, RepoTags: ['ghcr.io/x/y:1.0.0'] }];
    expect((await listArchives()).archives[0]?.loaded).toBe(true);

    // Second listing hits the index: same size + same mtime → no re-peek,
    // even though the content now says a different tag (same length). Pin
    // a whole-second mtime first so it can be reproduced exactly.
    const { statSync } = await import('node:fs');
    const pinned = new Date('2026-08-01T00:00:00Z');
    utimesSync(join(images, 'a.tar'), pinned, pinned);
    expect((await listArchives()).archives[0]?.refs).toEqual(['ghcr.io/x/y:1.0.0']);
    const before = statSync(join(images, 'a.tar'));
    writeFileSync(join(images, 'a.tar'), dockerArchive(['ghcr.io/x/y:1.0.1']));
    utimesSync(join(images, 'a.tar'), pinned, pinned);
    expect(statSync(join(images, 'a.tar')).size).toBe(before.size);
    expect((await listArchives()).archives[0]?.refs).toEqual(['ghcr.io/x/y:1.0.0']);

    // Touch mtime → re-peek picks up new content.
    writeFileSync(join(images, 'a.tar'), dockerArchive(['ghcr.io/x/y:9.9.9']));
    const t = new Date(Date.now() + 5000);
    utimesSync(join(images, 'a.tar'), t, t);
    expect((await listArchives()).archives[0]?.refs).toEqual(['ghcr.io/x/y:9.9.9']);
  });

  it('lists an unreadable file with unknown refs instead of failing the whole listing', async () => {
    writeFileSync(join(images, 'a.tar'), dockerArchive(['ghcr.io/x/y:1.0.0']));
    writeFileSync(join(images, 'garbage.tar.gz'), Buffer.from('this is not gzip'));
    const r = await listArchives();
    expect(r.archives.map((a) => a.name)).toEqual(['a.tar', 'garbage.tar.gz']);
    expect(r.archives[1]).toMatchObject({ refs: null, imageId: null, loaded: false });
  });

  it('loadArchive streams the file (gunzipped for .tar.gz), parses refs, updates the index', async () => {
    const tar = dockerArchive(['ghcr.io/x/y:2.0.0']);
    writeFileSync(join(images, 'b.tar.gz'), gzipSync(tar));
    await listArchives(); // peek first, as the UI does — the id comes from the peek
    loadOutput = 'Loaded image: ghcr.io/x/y:2.0.0\n';
    const progress: number[] = [];
    const r = await loadArchive('b.tar.gz', (p) => progress.push(p.bytesRead));
    expect(r).toEqual({ ok: true, refs: ['ghcr.io/x/y:2.0.0'], imageId: `sha256:${CFG_HEX}` });
    // The daemon received the DEcompressed tar.
    expect(loadCalls[0]?.bytes).toBe(tar.length);
    expect(progress.length).toBeGreaterThan(0);
    const listed = await listArchives();
    expect(listed.archives[0]?.refs).toEqual(['ghcr.io/x/y:2.0.0']);
  });

  it('loadArchive fails cleanly (no crash) on a corrupt .tar.gz', async () => {
    writeFileSync(join(images, 'bad.tar.gz'), Buffer.from('definitely not gzip data'));
    const r = await loadArchive('bad.tar.gz');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/incorrect header check|invalid|gzip|zlib/i);
  });

  it('survives a garbage index file (drops bad entries, re-peeks)', async () => {
    writeFileSync(join(images, 'a.tar'), dockerArchive(['ghcr.io/x/y:1.0.0']));
    writeFileSync(
      process.env.ARCHIVE_INDEX_PATH as string,
      JSON.stringify({ 'a.tar': { size: 'nope', refs: 'not-an-array' }, '../x.tar': {} }),
    );
    const r = await listArchives();
    expect(r.archives[0]?.refs).toEqual(['ghcr.io/x/y:1.0.0']);
    writeFileSync(process.env.ARCHIVE_INDEX_PATH as string, '{not json');
    expect((await listArchives()).archives[0]?.refs).toEqual(['ghcr.io/x/y:1.0.0']);
  });

  it('loadArchive rejects bad names and missing files without touching the runtime', async () => {
    expect(await loadArchive('../x.tar')).toEqual({ ok: false, error: 'invalid archive name' });
    expect(await loadArchive('nope.tar')).toEqual({ ok: false, error: 'archive not found' });
    expect(mockResolveRuntime).not.toHaveBeenCalled();
  });

  it('loadArchive surfaces a daemon error line', async () => {
    writeFileSync(join(images, 'a.tar'), dockerArchive(['ghcr.io/x/y:1.0.0']));
    mockResolveRuntime.mockResolvedValue({
      kind: 'podman',
      socketPath: '/dev/null',
      client: {
        listImages: async () => [],
        loadImage: (_b: Readable, _o: unknown, cb: (e: Error | null) => void) =>
          cb(new Error('no space left on device')),
        modem: { followProgress: () => undefined },
      },
    });
    const r = await loadArchive('a.tar');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no space/);
  });

  it('deleteArchive removes the file and its index entry; false for unknown/invalid', async () => {
    writeFileSync(join(images, 'a.tar'), dockerArchive(['ghcr.io/x/y:1.0.0']));
    await listArchives();
    expect(await deleteArchive('a.tar')).toBe(true);
    expect((await listArchives()).archives).toEqual([]);
    expect(await deleteArchive('a.tar')).toBe(false);
    expect(await deleteArchive('../a.tar')).toBe(false);
  });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
