import { mkdir, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * tmp + fsync + rename + dir-fsync — the same durable-write shape the
 * Quadlet rewriter, the mutex and version-settings use (each has its own
 * private copy; new modules import this one). Without the directory fsync
 * the renamed entry isn't durable across a power loss, which on a boat is
 * the realistic failure.
 */
export async function writeAtomic(path: string, body: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fh = await open(tmp, 'w', mode);
  try {
    await fh.write(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
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
