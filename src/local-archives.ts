import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import { resolveRuntime, safe } from './podman/client.js';
import { peekTarFile, peekTarStream } from './tar-peek.js';
import { writeAtomicJson } from './atomic-file.js';
import { repoOfRef } from './signalk-image.js';
import type { ArchiveInfo, ArchivesResponse } from './types.js';

/**
 * Local image files: `podman save` archives the operator drops into
 * `~/.signalk-updater/images` on the host (= `/data/images` in here) so a
 * boat with no internet can still load and switch to a new signalk-server
 * image.
 *
 * Rules that keep this safe:
 *  - The folder is FIXED (`LOCAL_IMAGES_DIR` env, default `/data/images`).
 *    Every API takes a bare file NAME validated by {@link isValidArchiveName};
 *    a path never crosses the wire, so there is nothing to traverse.
 *  - Archives are PEEKED, never extracted: `manifest.json` (docker-archive)
 *    or `index.json` (oci-archive) is read out of the tar via
 *    src/tar-peek.ts. Plain tars are seeked (milliseconds); compressed
 *    ones must be streamed once and the result is cached.
 *  - Peek results live in `/data/archive-index.json`, keyed by file
 *    size+mtime; a `podman load` also records the refs it printed, so a
 *    compressed archive whose peek failed still becomes switchable.
 */

const DATA_DIR = (): string => process.env.DATA_DIR ?? '/data';
export const localImagesDir = (): string =>
  process.env.LOCAL_IMAGES_DIR ?? join(DATA_DIR(), 'images');
const indexPath = (): string =>
  process.env.ARCHIVE_INDEX_PATH ?? join(DATA_DIR(), 'archive-index.json');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(tar|tar\.gz|tgz)$/;

export function isValidArchiveName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes('..') && name.length <= 255;
}

export function archiveFormat(name: string): 'tar' | 'tgz' {
  return name.endsWith('.tar') ? 'tar' : 'tgz';
}

interface IndexEntry {
  size: number;
  mtimeMs: number;
  refs: string[] | null;
  imageId: string | null;
}
type ArchiveIndex = Record<string, IndexEntry>;

/** Only well-formed entries survive a read; anything else (hand edit,
 *  older shape, corruption) is dropped and simply re-peeked. */
function sanitizeIndex(parsed: unknown): ArchiveIndex {
  const out: ArchiveIndex = {};
  if (typeof parsed !== 'object' || parsed === null) return out;
  for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isValidArchiveName(name) || typeof v !== 'object' || v === null) continue;
    const e = v as Record<string, unknown>;
    const refsOk =
      e.refs === null || (Array.isArray(e.refs) && e.refs.every((r) => typeof r === 'string'));
    if (
      typeof e.size !== 'number' ||
      typeof e.mtimeMs !== 'number' ||
      !refsOk ||
      !(e.imageId === null || typeof e.imageId === 'string')
    ) {
      continue;
    }
    out[name] = {
      size: e.size,
      mtimeMs: e.mtimeMs,
      refs: e.refs as string[] | null,
      imageId: e.imageId as string | null,
    };
  }
  return out;
}

// Serialise every read-modify-write of the index file within this
// process: listArchives (webapp + update-checker), loadArchive and
// deleteArchive can otherwise interleave and one writer clobber another's
// update. Simple promise chain — no cross-process locking needed (single
// engine process owns /data).
let indexQueue: Promise<unknown> = Promise.resolve();
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexQueue.then(fn, fn);
  indexQueue = run.catch(() => undefined);
  return run;
}

async function readIndex(): Promise<ArchiveIndex> {
  try {
    return sanitizeIndex(JSON.parse(await readFile(indexPath(), 'utf8')));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- peeking

interface DockerManifestEntry {
  Config?: string;
  RepoTags?: string[] | null;
}
interface OciIndex {
  manifests?: Array<{ annotations?: Record<string, string> }>;
}

const WANTED = new Set(['manifest.json', 'index.json']);

/** Interpret the peeked members. Exported for tests. */
export function interpretManifests(found: Map<string, Buffer>): {
  refs: string[] | null;
  imageId: string | null;
} {
  const manifest = found.get('manifest.json');
  if (manifest) {
    try {
      const arr = JSON.parse(manifest.toString('utf8')) as DockerManifestEntry[];
      const first = Array.isArray(arr) ? arr[0] : undefined;
      if (first) {
        const refs = (first.RepoTags ?? []).filter((r) => typeof r === 'string' && r.includes(':'));
        // Config is "<hex>.json" (docker) or "blobs/sha256/<hex>" (podman ≥4).
        const cfg = first.Config ?? '';
        const hex =
          cfg
            .replace(/\.json$/, '')
            .split('/')
            .pop() ?? '';
        const imageId = /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : null;
        return { refs: refs.length > 0 ? refs : [], imageId };
      }
    } catch {
      // fall through to OCI / unknown
    }
  }
  const index = found.get('index.json');
  if (index) {
    try {
      const idx = JSON.parse(index.toString('utf8')) as OciIndex;
      const refs: string[] = [];
      for (const m of idx.manifests ?? []) {
        const ref =
          m.annotations?.['org.opencontainers.image.ref.name'] ??
          m.annotations?.['io.containers.image.ref.name'];
        // podman writes the full `repo:tag`; a bare tag can't be switched to.
        if (ref && ref.includes('/') && ref.includes(':')) refs.push(ref);
      }
      return { refs, imageId: null };
    } catch {
      // unknown
    }
  }
  return { refs: null, imageId: null };
}

// Concurrent listings (webapp refresh + update-checker tick) must not
// decompress the same big .tar.gz twice; share the in-flight peek per
// (path, size, mtime).
const inflightPeeks = new Map<string, Promise<Map<string, Buffer>>>();

function peekArchiveShared(
  path: string,
  format: 'tar' | 'tgz',
  size: number,
  mtimeMs: number,
): Promise<Map<string, Buffer>> {
  const key = `${path}|${size}|${mtimeMs}`;
  const existing = inflightPeeks.get(key);
  if (existing) return existing;
  const p = peekArchive(path, format).finally(() => {
    inflightPeeks.delete(key);
  });
  inflightPeeks.set(key, p);
  return p;
}

async function peekArchive(path: string, format: 'tar' | 'tgz'): Promise<Map<string, Buffer>> {
  if (format === 'tar') return peekTarFile(path, WANTED);
  // The stream walker may bail out early (both manifests seen) or the
  // gunzip may error on a corrupt file; either way the SOURCE read stream
  // must be closed too, or its fd leaks until GC. `pipe()` alone won't
  // do that. Errors surface to the caller (which lists the file with
  // unknown refs) instead of becoming an unhandled 'error' event.
  const file = createReadStream(path);
  const gunzip = createGunzip();
  const failure = new Promise<never>((_, reject) => {
    file.once('error', reject);
    gunzip.once('error', reject);
  });
  try {
    return await Promise.race([peekTarStream(file.pipe(gunzip), WANTED), failure]);
  } finally {
    file.destroy();
    gunzip.destroy();
  }
}

// -------------------------------------------------------- local image set

async function localImageSet(): Promise<{ tagToId: Map<string, string>; ids: Set<string> } | null> {
  const rt = await resolveRuntime();
  if (!rt) return null;
  const r = await safe(() => rt.client.listImages({}));
  if (!r.ok) return null;
  const tagToId = new Map<string, string>();
  const ids = new Set<string>();
  for (const img of r.value as Array<{ Id: string; RepoTags?: string[] | null }>) {
    ids.add(img.Id);
    for (const t of img.RepoTags ?? []) tagToId.set(t, img.Id);
  }
  return { tagToId, ids };
}

/**
 * "Loaded" answers "will a Switch to this archive's ref start THIS
 * archive's image?" — so the ref must exist in the store and, when the
 * archive tells us its image id (docker-archive), the tag must resolve to
 * that id (a later pull can re-take the tag for a different image). An
 * archive with an id but no ref counts as loaded when the id is present
 * (it still can't be switched to — the route says so).
 */
export function isLoaded(
  a: Pick<ArchiveInfo, 'refs' | 'imageId'>,
  local: { tagToId: Map<string, string>; ids: Set<string> },
): boolean {
  const refs = a.refs ?? [];
  if (refs.length > 0) {
    return refs.some((ref) => {
      const id = local.tagToId.get(ref);
      if (id === undefined) return false;
      return a.imageId === null || id === a.imageId;
    });
  }
  return a.imageId !== null && local.ids.has(a.imageId);
}

// ---------------------------------------------------------------- listing

/**
 * Enumerate the folder. Creates it on first call so the operator finds it
 * ready. Peeks new/changed files, refreshes the index, and marks each
 * archive `loaded` when its ref is in podman's store and resolves to the
 * archive's image (see {@link isLoaded}).
 */
export async function listArchives(): Promise<ArchivesResponse> {
  const dir = localImagesDir();
  await mkdir(dir, { recursive: true });
  const names = (await readdir(dir)).filter(isValidArchiveName).sort();
  const index = await readIndex();
  const next: ArchiveIndex = {};
  let changed = false;

  const stats = await Promise.all(
    names.map(async (name) => {
      try {
        const st = await stat(join(dir, name));
        return st.isFile() ? { name, st } : null;
      } catch {
        return null;
      }
    }),
  );

  const present: Array<{ name: string; size: number; mtimeMs: number }> = [];
  for (const item of stats) {
    if (!item) continue;
    const { name, st } = item;
    present.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    const cached = index[name];
    let entry: IndexEntry;
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      entry = cached;
    } else {
      let peek = { refs: null as string[] | null, imageId: null as string | null };
      try {
        peek = interpretManifests(
          await peekArchiveShared(join(dir, name), archiveFormat(name), st.size, st.mtimeMs),
        );
      } catch {
        // unreadable / not a tar — keep it listed with unknown refs so the
        // operator sees the file and gets an honest error on Load.
      }
      entry = { size: st.size, mtimeMs: st.mtimeMs, ...peek };
      changed = true;
    }
    next[name] = entry;
  }
  // Merge under the lock against a FRESH read: a load that finished while
  // we were peeking may have enriched an entry (refs for a gz whose peek
  // came up empty) — an entry for the same file (size+mtime) already on
  // disk wins over what we computed. The response is built from the merged
  // map, so callers see the enriched entry immediately, not on the next
  // listing.
  const merged = await withIndexLock(async () => {
    const cur = await readIndex();
    const out: ArchiveIndex = {};
    for (const [n, e] of Object.entries(next)) {
      const c = cur[n];
      out[n] = c && c.size === e.size && c.mtimeMs === e.mtimeMs ? c : e;
    }
    const dirty =
      changed ||
      Object.keys(cur).length !== Object.keys(out).length ||
      Object.keys(out).some((n) => !(n in cur));
    if (dirty) await writeAtomicJson(indexPath(), out).catch(() => undefined);
    return out;
  }).catch(() => next);

  const rows: Array<Omit<ArchiveInfo, 'loaded'>> = present.map(({ name, size, mtimeMs }) => {
    const e = merged[name] ?? next[name] ?? { size, mtimeMs, refs: null, imageId: null };
    return {
      name,
      size,
      mtime: new Date(mtimeMs).toISOString(),
      format: archiveFormat(name),
      refs: e.refs,
      imageId: e.imageId,
    };
  });

  const local = await localImageSet();
  const archives: ArchiveInfo[] = rows.map((r) => ({
    ...r,
    loaded: local !== null && isLoaded(r, local),
  }));
  return { dir, archives };
}

// ---------------------------------------------------------------- loading

export interface LoadProgress {
  bytesRead: number;
  totalBytes: number;
}

/** Pull `Loaded image: <ref>` / `Loaded image ID: <id>` out of the daemon's
 *  load output. Exported for tests. */
export function parseLoadedRefs(text: string): { refs: string[]; imageId: string | null } {
  const refs = new Set<string>();
  let imageId: string | null = null;
  for (const m of text.matchAll(/Loaded image(?: ID)?:\s*(\S+)/g)) {
    const v = m[1] ?? '';
    if (/^sha256:[0-9a-f]{64}$/.test(v)) imageId = v;
    else if (v.includes(':')) refs.add(v);
  }
  return { refs: [...refs], imageId };
}

interface LoadEvent {
  stream?: string;
  status?: string;
  error?: string;
}

/**
 * `podman load` the archive through the socket. Streams the file (gunzipping
 * a `.tar.gz`/`.tgz` ourselves), reports byte progress, parses the loaded
 * refs and records them in the index so a compressed archive is switchable
 * even if its peek failed.
 */
export async function loadArchive(
  name: string,
  onProgress?: (p: LoadProgress) => void,
): Promise<{ ok: true; refs: string[]; imageId: string | null } | { ok: false; error: string }> {
  if (!isValidArchiveName(name)) return { ok: false, error: 'invalid archive name' };
  const path = join(localImagesDir(), name);
  let st;
  try {
    st = await stat(path);
  } catch {
    return { ok: false, error: 'archive not found' };
  }
  const rt = await resolveRuntime();
  if (!rt) return { ok: false, error: 'container runtime unreachable' };

  let bytesRead = 0;
  const file = createReadStream(path);
  file.on('data', (chunk: Buffer | string) => {
    bytesRead += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    try {
      onProgress?.({ bytesRead, totalBytes: st.size });
    } catch {
      // never let a progress listener break the load
    }
  });
  const gunzip = archiveFormat(name) === 'tgz' ? createGunzip() : null;
  const body: Readable = gunzip ? file.pipe(gunzip) : file;

  const r = await safe(
    () =>
      new Promise<string>((resolve, reject) => {
        // A read error or a corrupt .tar.gz must reject the load, not
        // surface as an unhandled 'error' event and take the engine down.
        file.once('error', reject);
        gunzip?.once('error', reject);
        rt.client.loadImage(body, { quiet: false }, (err, stream) => {
          if (err) return reject(err);
          if (!stream) return resolve('');
          const lines: string[] = [];
          rt.client.modem.followProgress(
            stream,
            (e) => (e ? reject(e) : resolve(lines.join('\n'))),
            (ev: LoadEvent) => {
              if (ev.error) lines.push(`error: ${ev.error}`);
              if (ev.stream) lines.push(ev.stream);
              if (ev.status) lines.push(ev.status);
            },
          );
        });
      }),
  );
  file.destroy();
  gunzip?.destroy();
  if (!r.ok) return { ok: false, error: r.error.userMessage };
  const parsed = parseLoadedRefs(r.value);
  if (/^error:/m.test(r.value) && parsed.refs.length === 0) {
    const line = r.value.split('\n').find((l) => l.startsWith('error:')) ?? 'error: load failed';
    return { ok: false, error: line.slice('error:'.length).trim() };
  }

  // Record what the daemon told us (fills in refs for archives whose peek
  // came up empty). Preserve a peeked imageId if load didn't report one.
  const entry = await withIndexLock(async () => {
    const index = await readIndex();
    const prev = index[name];
    const e: IndexEntry = {
      size: st.size,
      mtimeMs: st.mtimeMs,
      refs: parsed.refs.length > 0 ? parsed.refs : (prev?.refs ?? null),
      imageId: parsed.imageId ?? prev?.imageId ?? null,
    };
    index[name] = e;
    await writeAtomicJson(indexPath(), index).catch(() => undefined);
    return e;
  });
  return { ok: true, refs: entry.refs ?? [], imageId: entry.imageId };
}

// ------------------------------------------------------------- resolution

/**
 * The ref a Switch should target for this archive: prefer one under
 * `preferredRepo` (the Advanced-tab repo), else the first. Null when the
 * archive carries no `repo:tag` (saved by id) or was never peeked/loaded.
 * Pure — the caller already has the listing.
 */
export function pickArchiveRef(
  a: Pick<ArchiveInfo, 'refs'>,
  preferredRepo: string,
): { ref: string; tag: string } | null {
  if (!a.refs || a.refs.length === 0) return null;
  const ref = a.refs.find((r) => repoOfRef(r) === preferredRepo) ?? a.refs[0];
  if (!ref) return null;
  return { ref, tag: ref.slice(ref.lastIndexOf(':') + 1) };
}

export async function deleteArchive(name: string): Promise<boolean> {
  if (!isValidArchiveName(name)) return false;
  try {
    await unlink(join(localImagesDir(), name));
  } catch {
    return false;
  }
  await withIndexLock(async () => {
    const index = await readIndex();
    if (name in index) {
      delete index[name];
      await writeAtomicJson(indexPath(), index);
    }
  }).catch(() => undefined);
  return true;
}
