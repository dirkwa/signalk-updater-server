import { open, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { LockInfo } from './types.js';

export type { LockInfo };

// The operations that take the lock. Kept here (mutex's concern), and
// must stay in sync with LockInfo.operation's union in types.ts (the wire
// shape mirrored by the webapp).
export type Operation = LockInfo['operation'];

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const LOCK_PATH = process.env.OPERATION_LOCK ?? join(DATA_DIR, 'operation.lock');

async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  const fh = await open(tmp, 'w', 0o644);
  try {
    await fh.write(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  const dirFh = await open(dirname(path), 'r');
  try {
    await dirFh.sync();
  } finally {
    await dirFh.close();
  }
}

export async function readLock(): Promise<LockInfo | null> {
  try {
    const fh = await open(LOCK_PATH, 'r');
    try {
      const text = (await fh.readFile()).toString('utf8');
      return JSON.parse(text) as LockInfo;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

export class MutexBusyError extends Error {
  constructor(public lock: LockInfo) {
    super(`operation lock held by ${lock.owner}/${lock.operation} since ${lock.startedAt}`);
    this.name = 'MutexBusyError';
  }
}

// A lock older than this is treated as stale and reclaimable. It must be
// comfortably longer than the slowest legitimate operation — a switch can
// take a full image pull plus the 180s health-poll — but short enough
// that a process SIGKILLed mid-operation (OOM, host reboot) doesn't wedge
// every future switch/update forever. There is no liveness handshake to
// renew the lock, so this is a pure age cutoff. 10 min clears comfortably
// after the worst real case (~4 min) without leaving a crashed box stuck
// for an operator-noticeable stretch.
export const STALE_LOCK_MS = 10 * 60 * 1000;

function lockAgeMs(lock: LockInfo): number | null {
  const t = Date.parse(lock.startedAt);
  return Number.isNaN(t) ? null : Date.now() - t;
}

async function writeLockFile(info: LockInfo): Promise<boolean> {
  try {
    const fh = await open(LOCK_PATH, 'wx', 0o600);
    try {
      const body = JSON.stringify(info);
      await fh.write(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'EEXIST') return false;
    throw err;
  }
}

let stealSeq = 0;

/**
 * Atomically claim a stale lock by RENAMING it out of the way, not
 * unlink+recreate. `rename(LOCK_PATH, …)` of the same source path is
 * atomic: when two processes both try to steal the same stale lock, only
 * one rename of LOCK_PATH succeeds — the others get ENOENT because the
 * file is already gone. So exactly one process "wins" the steal and then
 * creates the fresh lock with `wx`. unlink+recreate is NOT race-free here:
 * two reclaimers can both unlink (idempotent) and both `wx`-create in the
 * gap, double-acquiring. Returns true only for the single winner.
 */
async function stealStaleLock(info: LockInfo): Promise<boolean> {
  stealSeq += 1;
  const claimPath = `${LOCK_PATH}.steal.${process.pid}.${stealSeq}`;
  try {
    await rename(LOCK_PATH, claimPath);
  } catch {
    // Lost the rename race (someone else stole/released it first), or the
    // file vanished. Either way we did not win — fall through to a plain
    // create attempt in case it's now free.
    return writeLockFile(info);
  }
  // We won the steal. Drop the carcass and install our lock.
  await unlink(claimPath).catch(() => undefined);
  return writeLockFile(info);
}

async function tryAcquire(info: LockInfo): Promise<boolean> {
  if (await writeLockFile(info)) return true;
  // Lock file exists. Reclaim it only if it's stale — a crashed operation
  // that never ran its release `finally`. A fresh lock is a real in-flight
  // operation and we must not steal it.
  const existing = await readLock();
  if (existing) {
    const age = lockAgeMs(existing);
    if (age === null || age <= STALE_LOCK_MS) return false;
    return stealStaleLock(info);
  }
  // The lock vanished between our write and our read (the holder released).
  // Try once more.
  return writeLockFile(info);
}

export async function withMutex<T>(operation: Operation, fn: () => Promise<T>): Promise<T> {
  const info: LockInfo = {
    owner: 'updater',
    operation,
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };
  const ok = await tryAcquire(info);
  if (!ok) {
    const lock = await readLock();
    if (lock) throw new MutexBusyError(lock);
    // racy read; assume held
    throw new MutexBusyError({
      owner: 'updater',
      operation: 'switch',
      startedAt: new Date().toISOString(),
    });
  }
  try {
    return await fn();
  } finally {
    try {
      await unlink(LOCK_PATH);
    } catch {
      // best-effort
    }
  }
}

export async function forceClear(): Promise<void> {
  try {
    await unlink(LOCK_PATH);
  } catch {
    // already clear
  }
}

export async function writeLockInfo(info: LockInfo): Promise<void> {
  await writeAtomic(LOCK_PATH, JSON.stringify(info));
}
