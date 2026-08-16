import { open } from 'node:fs/promises';
import type { Readable } from 'node:stream';

/**
 * Minimal tar reader that extracts ONLY the named entries and skips
 * everything else — enough to read `manifest.json` / `index.json` out of a
 * multi-GB image archive without unpacking a single layer.
 *
 * Two entry points:
 *   * {@link peekTarFile} — plain `.tar` on disk. Reads each 512-byte
 *     header and SEEKS past the entry data, so cost is O(entries), not
 *     O(bytes): a 1 GB archive peeks in milliseconds.
 *   * {@link peekTarStream} — any Readable (e.g. `.tar.gz` through
 *     `zlib.createGunzip()`). Has to consume the whole stream, but never
 *     buffers more than one wanted entry (manifests are tiny).
 *
 * Handles ustar `prefix`, GNU `././@LongLink` (typeflag `L`) and PAX
 * `path=` extended headers (Go's archive/tar, which podman/buildah use,
 * emits PAX for long names and >8 GB entries), base-256 sizes, and the
 * `./` prefix some writers put on member names.
 */

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);
/** Largest entry we are willing to hold in memory (manifests are a few
 *  KB; PAX/LongLink headers a few hundred bytes). Anything bigger that we
 *  would otherwise keep is skipped — a corrupt or hostile archive must not
 *  be able to make us `Buffer.alloc()` gigabytes. */
export const MAX_KEPT_ENTRY_BYTES = 16 * 1024 * 1024;
/** Sanity ceiling for any entry size (1 TiB). Bigger = corrupt header. */
const MAX_ENTRY_BYTES = 2 ** 40;

interface TarHeader {
  name: string;
  size: number;
  typeflag: string;
}

function parseOctalOrBase256(field: Buffer): number {
  const first = field[0] ?? 0;
  if (first & 0x80) {
    // GNU base-256: big-endian, high bit of first byte set.
    let n = 0;
    for (let i = 0; i < field.length; i++) {
      const b = field[i] ?? 0;
      n = n * 256 + (i === 0 ? b & 0x7f : b);
    }
    return n;
  }
  const s = field.toString('ascii').replace(/\0.*$/, '').trim();
  return s === '' ? 0 : parseInt(s, 8);
}

function cstr(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8');
}

/** Header checksum: sum of all bytes with the checksum field taken as
 *  spaces. Rejecting a bad checksum is what stops us from walking a file
 *  that isn't a tar at all (garbage sizes → garbage seeks / a stuck
 *  stream walker). Both the unsigned (POSIX) and signed (old GNU) sums are
 *  accepted, like every tar implementation does. */
function checksumOk(block: Buffer): boolean {
  const stored = parseInt(
    block.subarray(148, 156).toString('ascii').replace(/\0.*$/, '').trim(),
    8,
  );
  if (!Number.isFinite(stored)) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return stored === unsigned || stored === signed;
}

/** Parse a header block. Returns null at the end-of-archive marker AND for
 *  anything that isn't a plausible tar header (bad checksum, non-finite or
 *  absurd size) — the walkers stop there rather than seek into nonsense. */
function parseHeader(block: Buffer): TarHeader | null {
  if (block.length < BLOCK || block.equals(ZERO_BLOCK)) return null;
  if (!checksumOk(block)) return null;
  const name = cstr(block, 0, 100);
  const size = parseOctalOrBase256(block.subarray(124, 136));
  if (!Number.isFinite(size) || size < 0 || size > MAX_ENTRY_BYTES) return null;
  const typeflag = String.fromCharCode(block[156] ?? 0);
  const magic = cstr(block, 257, 6);
  const prefix = magic.startsWith('ustar') ? cstr(block, 345, 155) : '';
  return { name: prefix ? `${prefix}/${name}` : name, size, typeflag };
}

function normalizeName(name: string): string {
  return name.replace(/^\.\//, '');
}

function paxPath(data: Buffer): string | null {
  // "<len> path=<value>\n" records; we only care about `path`.
  const text = data.toString('utf8');
  let pos = 0;
  while (pos < text.length) {
    const sp = text.indexOf(' ', pos);
    if (sp === -1) break;
    const len = parseInt(text.slice(pos, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(sp + 1, pos + len - 1); // drop trailing \n
    if (record.startsWith('path=')) return record.slice('path='.length);
    pos += len;
  }
  return null;
}

const roundUp = (n: number): number => Math.ceil(n / BLOCK) * BLOCK;

/**
 * Peek a plain tar file for `wanted` member names. Returns the entries
 * found (name → contents). Stops early once every wanted entry is seen.
 */
export async function peekTarFile(path: string, wanted: Set<string>): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>();
  const fh = await open(path, 'r');
  try {
    let pos = 0;
    let pendingName: string | null = null;
    const header = Buffer.alloc(BLOCK);
    for (;;) {
      const { bytesRead } = await fh.read(header, 0, BLOCK, pos);
      if (bytesRead < BLOCK) break;
      const h = parseHeader(header);
      if (!h) break;
      pos += BLOCK;
      const dataLen = roundUp(h.size);
      if (h.typeflag === 'L' || h.typeflag === 'x') {
        // Long-name / PAX header: its data names the NEXT entry. An
        // implausibly large one is ignored (still skipped) rather than read.
        if (h.size <= MAX_KEPT_ENTRY_BYTES) {
          const data = Buffer.alloc(h.size);
          await fh.read(data, 0, h.size, pos);
          pendingName =
            h.typeflag === 'L' ? cstr(data, 0, data.length) : (paxPath(data) ?? pendingName);
        }
        pos += dataLen;
        continue;
      }
      const name = normalizeName(pendingName ?? h.name);
      pendingName = null;
      if (
        (h.typeflag === '0' || h.typeflag === '\0') &&
        wanted.has(name) &&
        h.size <= MAX_KEPT_ENTRY_BYTES
      ) {
        const data = Buffer.alloc(h.size);
        await fh.read(data, 0, h.size, pos);
        found.set(name, data);
        if (found.size === wanted.size) break;
      }
      pos += dataLen;
    }
  } finally {
    await fh.close();
  }
  return found;
}

/**
 * Peek a tar delivered as a stream (e.g. gunzipped). Consumes the stream.
 * Same result shape as {@link peekTarFile}.
 */
export async function peekTarStream(
  stream: Readable,
  wanted: Set<string>,
): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>();
  let buf: Buffer = Buffer.alloc(0);
  let pendingName: string | null = null;
  // State: either waiting for a header, or inside an entry's data.
  let entry: { name: string; size: number; typeflag: string; keep: boolean } | null = null;
  let remaining = 0; // bytes of the current entry (padded) still to consume
  let collected: Buffer[] = [];
  let done = false;

  for await (const chunk of stream) {
    if (done) break;
    const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    buf = buf.length === 0 ? c : Buffer.concat([buf, c]);
    for (;;) {
      if (entry) {
        const take = Math.min(remaining, buf.length);
        if (take === 0) break;
        if (entry.keep) collected.push(buf.subarray(0, take));
        buf = buf.subarray(take);
        remaining -= take;
        if (remaining > 0) break;
        // Entry complete.
        if (entry.keep) {
          const data = Buffer.concat(collected).subarray(0, entry.size);
          if (entry.typeflag === 'L') pendingName = cstr(data, 0, data.length);
          else if (entry.typeflag === 'x') pendingName = paxPath(data) ?? pendingName;
          else {
            found.set(entry.name, data);
            if (found.size === wanted.size) done = true;
          }
        }
        entry = null;
        collected = [];
        if (done) break;
        continue;
      }
      if (buf.length < BLOCK) break;
      const h = parseHeader(buf.subarray(0, BLOCK));
      buf = buf.subarray(BLOCK);
      if (!h) {
        done = true;
        break;
      }
      const meta = h.typeflag === 'L' || h.typeflag === 'x';
      const name = meta ? h.name : normalizeName(pendingName ?? h.name);
      if (!meta) pendingName = null;
      const isFile = h.typeflag === '0' || h.typeflag === '\0';
      entry = {
        name,
        size: h.size,
        typeflag: h.typeflag,
        keep: (meta || (isFile && wanted.has(name))) && h.size <= MAX_KEPT_ENTRY_BYTES,
      };
      remaining = roundUp(h.size);
      if (remaining === 0) {
        // Zero-length entry (dir or empty file): nothing to consume.
        if (entry.keep && !meta) found.set(name, Buffer.alloc(0));
        entry = null;
      }
    }
  }
  // Drain politely if we bailed early so the source can close.
  if (done && typeof (stream as Readable).destroy === 'function') stream.destroy();
  return found;
}
