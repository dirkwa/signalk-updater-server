import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * tmp + fsync + rename + dir-fsync — the same durable-write shape the
 * Quadlet rewriter, the mutex and version-settings use (each has its own
 * private copy; new modules import this one). Without the directory fsync
 * the renamed entry isn't durable across a power loss, which on a boat is
 * the realistic failure.
 */
let seq = 0;

export async function writeAtomic(path: string, body: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Unique per call, not just per process: two concurrent writers in the
  // same process (e.g. the webapp poll and the update-checker both
  // refreshing the archive index) must not share a tmp file, or one
  // rename can publish the other's half-written content.
  const tmp = `${path}.${process.pid}.${++seq}.tmp`;
  const fh = await open(tmp, 'w', mode);
  try {
    try {
      // writeFile loops until the whole payload is written; a bare write()
      // may report fewer bytes than given.
      await fh.writeFile(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (err) {
    // Don't leave a half-written tmp behind on a failed write/rename.
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  const dh = await open(dirname(path), 'r');
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
}

/** JSON convenience over {@link writeAtomic}. */
export async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, JSON.stringify(value, null, 2));
}
