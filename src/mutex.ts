import { link, open, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { LockInfo } from './types.js';

export type { LockInfo };

// The operations that take the lock. Kept here (mutex's concern), and
// must stay in sync with LockInfo.operation's union in types.ts (the wire
// shape mirrored by the webapp). `pause` covers both signalk pause and
// resume — both rewrite signalk-server.container, so they serialize against
// switches like every other Quadlet mutation.
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
  return readLockAt(LOCK_PATH);
}

async function readLockAt(path: string): Promise<LockInfo | null> {
  try {
    const fh = await open(path, 'r');
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

type ClaimOutcome = 'won' | 'lost' | 'yanked-fresh';

/**
 * Atomically claim a stale lock by RENAMING it out of the way, not
 * unlink+recreate. `rename(LOCK_PATH, …)` of the same source path is
 * atomic: when two processes both try to steal the same stale lock, only
 * one rename of LOCK_PATH succeeds — the others get ENOENT because the
 * file is already gone. unlink+recreate is NOT race-free here: two
 * reclaimers can both unlink (idempotent) and both `wx`-create in the gap,
 * double-acquiring.
 *
 * The rename alone is not enough either (CI flake, 2026-07 and 2026-08):
 * it moves whatever is at LOCK_PATH AT RENAME TIME, not the stale lock the
 * caller examined. A and B both read the stale lock; A wins the rename,
 * `wx`-creates its FRESH lock and enters the critical section; B's rename
 * then succeeds by yanking A's fresh lock, and B enters too — CC-5
 * violated. So after winning we RE-EXAMINE the carcass: if it is fresh (or
 * unreadable — a lock caught mid-write, whose owner will finish writing
 * into the same inode) we yanked a live lock and put it back with
 * `link()`, which fails with EEXIST instead of clobbering a lock that
 * appeared meanwhile. Only a carcass that is really stale counts as won.
 *
 * Residual: a three-party sub-millisecond window (B yanks A's fresh lock,
 * C `wx`-creates before B's link, so A and C both believe they hold it).
 * Locks are held for minutes and reclaim is a rare recovery path, so this
 * is accepted rather than adding a heavier protocol.
 */
async function claimLockIfStale(kind: 'steal' | 'bootsteal'): Promise<ClaimOutcome> {
  stealSeq += 1;
  const claimPath = `${LOCK_PATH}.${kind}.${process.pid}.${stealSeq}`;
  try {
    await rename(LOCK_PATH, claimPath);
  } catch {
    return 'lost';
  }
  const carcass = await readLockAt(claimPath);
  const age = carcass ? lockAgeMs(carcass) : null;
  const reallyStale = carcass !== null && age !== null && age > STALE_LOCK_MS;
  if (!reallyStale) {
    // Live (or not-yet-readable) lock — restore it non-clobberingly.
    try {
      await link(claimPath, LOCK_PATH);
    } catch {
      // EEXIST: someone else already installed a lock; theirs stands.
    }
    await unlink(claimPath).catch(() => undefined);
    return 'yanked-fresh';
  }
  await unlink(claimPath).catch(() => undefined);
  return 'won';
}

async function stealStaleLock(info: LockInfo): Promise<boolean> {
  const outcome = await claimLockIfStale('steal');
  if (outcome === 'yanked-fresh') return false;
  // 'won': the stale lock is gone, install ours. 'lost': someone else
  // stole/released it first, or it vanished — a plain create may now
  // succeed, and if not the caller reports busy.
  return writeLockFile(info);
}

/** Test seam: drive the reclaim path directly against whatever is at
 *  LOCK_PATH, without racing two withMutex bodies. */
export const __stealStaleLockForTests = stealStaleLock;

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

export type BootLockOutcome =
  | { cleared: false; reason: 'no-lock' | 'fresh' }
  | { cleared: true; lock: LockInfo; ageMs: number | null };

/**
 * Boot-time recovery: clear the operation lock IF it's stale. Called once
 * at startup, before the server accepts requests, so an updater that
 * restarts for any reason (crashloop, host reboot, a self-update that
 * managed to fire) heals a lock orphaned by a process killed mid-operation
 * — without waiting for the runtime stale-reclaim window or a manual rm.
 *
 * Crucially this only clears a STALE lock (age > STALE_LOCK_MS). A fresh
 * lock is a real in-flight operation — possibly the doctor's, since the
 * lock is shared — and must survive our boot. The reclaim uses the same
 * atomic rename-to-claim as tryAcquire so a doctor that legitimately holds
 * a fresh lock while we boot is never clobbered. Best-effort and never
 * throws: a recovery step must not be the thing that stops boot.
 */
export async function releaseStaleLockAtBoot(): Promise<BootLockOutcome> {
  try {
    const lock = await readLock();
    if (!lock) return { cleared: false, reason: 'no-lock' };
    const age = lockAgeMs(lock);
    // null age = unparseable startedAt; fail safe toward "leave it" so we
    // never steal something we can't reason about.
    if (age === null || age <= STALE_LOCK_MS) return { cleared: false, reason: 'fresh' };
    // Atomic claim-then-drop with the same fresh-carcass guard as the
    // runtime reclaim: only the winner of the rename removes it, and a lock
    // that turned fresh between our read and our rename (a doctor that just
    // acquired) is put back untouched.
    const outcome = await claimLockIfStale('bootsteal');
    if (outcome !== 'won') return { cleared: false, reason: 'fresh' };
    return { cleared: true, lock, ageMs: age };
  } catch {
    // Any unexpected fs error: leave the lock and let boot proceed. The
    // runtime stale-reclaim is still there as a backstop.
    return { cleared: false, reason: 'no-lock' };
  }
}

export async function writeLockInfo(info: LockInfo): Promise<void> {
  await writeAtomic(LOCK_PATH, JSON.stringify(info));
}
