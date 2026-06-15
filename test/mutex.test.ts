import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { writeFile, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The mutex reads its lock path from OPERATION_LOCK at module-evaluation
// time, so the env MUST be set before the static import below runs. Use a
// single fixed temp dir for the whole file and reset the lock file
// between tests rather than re-importing the module per test.
const dir = mkdtempSync(join(tmpdir(), 'mutex-test-'));
const lockPath = join(dir, 'operation.lock');
process.env.OPERATION_LOCK = lockPath;

const { withMutex, MutexBusyError, STALE_LOCK_MS, forceClear, readLock, releaseStaleLockAtBoot } =
  await import('../src/mutex.js');

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  await rm(lockPath, { force: true });
});

afterAll(async () => {
  delete process.env.OPERATION_LOCK;
  await rm(dir, { recursive: true, force: true });
});

describe('withMutex / stale-lock reclaim', () => {
  it('runs the critical section and releases the lock', async () => {
    let ran = false;
    const result = await withMutex('switch', async () => {
      ran = true;
      expect(await exists(lockPath)).toBe(true);
      return 42;
    });
    expect(ran).toBe(true);
    expect(result).toBe(42);
    expect(await exists(lockPath)).toBe(false);
  });

  it('rejects a second concurrent acquire with MutexBusyError', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = withMutex('switch', async () => {
      await gate;
    });
    await expect(withMutex('doctor-switch', async () => undefined)).rejects.toBeInstanceOf(
      MutexBusyError,
    );
    release();
    await first;
  });

  it('reclaims a STALE lock (older than the TTL) left by a crashed op', async () => {
    const staleStarted = new Date(Date.now() - (STALE_LOCK_MS + 60_000)).toISOString();
    await writeFile(
      lockPath,
      JSON.stringify({ owner: 'updater', operation: 'switch', startedAt: staleStarted }),
    );
    let ran = false;
    await withMutex('doctor-switch', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(await exists(lockPath)).toBe(false);
  });

  it('lets only ONE of two concurrent reclaimers steal the same stale lock', async () => {
    // The TOCTOU guard: two in-process callers both see the stale lock and
    // race to reclaim. The rename-to-claim must let exactly one win so the
    // critical sections never overlap (CC-5). We can't fork real
    // processes in-suite, but two concurrent withMutex calls exercise the
    // same tryAcquire path against one shared lock file.
    const staleStarted = new Date(Date.now() - (STALE_LOCK_MS + 60_000)).toISOString();
    await writeFile(
      lockPath,
      JSON.stringify({ owner: 'updater', operation: 'switch', startedAt: staleStarted }),
    );
    let inside = 0;
    let maxConcurrent = 0;
    let releaseAll!: () => void;
    const gate = new Promise<void>((r) => (releaseAll = r));
    const body = async (): Promise<'ran'> => {
      inside += 1;
      maxConcurrent = Math.max(maxConcurrent, inside);
      await gate;
      inside -= 1;
      return 'ran';
    };
    const a = withMutex('switch', body).catch((e) => e as Error);
    const b = withMutex('doctor-switch', body).catch((e) => e as Error);
    // Let both reach their acquire decision, then release whoever got in.
    await new Promise((r) => setTimeout(r, 50));
    releaseAll();
    const [ra, rb] = await Promise.all([a, b]);
    const ran = [ra, rb].filter((x) => x === 'ran').length;
    const busy = [ra, rb].filter((x) => x instanceof MutexBusyError).length;
    // Exactly one acquired; the other was rejected busy. Never both inside.
    expect(maxConcurrent).toBe(1);
    expect(ran).toBe(1);
    expect(busy).toBe(1);
  });

  it('does NOT steal a FRESH lock (younger than the TTL)', async () => {
    const freshStarted = new Date(Date.now() - 5_000).toISOString();
    await writeFile(
      lockPath,
      JSON.stringify({ owner: 'updater', operation: 'switch', startedAt: freshStarted }),
    );
    await expect(withMutex('doctor-switch', async () => undefined)).rejects.toBeInstanceOf(
      MutexBusyError,
    );
    expect(await exists(lockPath)).toBe(true);
  });

  it('forceClear removes the lock regardless of age', async () => {
    await writeFile(
      lockPath,
      JSON.stringify({
        owner: 'updater',
        operation: 'switch',
        startedAt: new Date().toISOString(),
      }),
    );
    expect(await exists(lockPath)).toBe(true);
    await forceClear();
    expect(await exists(lockPath)).toBe(false);
  });

  it('readLock returns the parsed lock or null', async () => {
    expect(await readLock()).toBeNull();
    await writeFile(
      lockPath,
      JSON.stringify({ owner: 'updater', operation: 'switch', startedAt: 'X' }),
    );
    const read = await readLock();
    expect(read?.operation).toBe('switch');
  });

  it('treats an unparseable startedAt as non-stale (does not reclaim)', async () => {
    await writeFile(
      lockPath,
      JSON.stringify({ owner: 'updater', operation: 'switch', startedAt: 'not-a-date' }),
    );
    await expect(withMutex('switch', async () => undefined)).rejects.toBeInstanceOf(MutexBusyError);
    expect(await exists(lockPath)).toBe(true);
    expect(await readFile(lockPath, 'utf8')).toContain('not-a-date');
  });
});

describe('releaseStaleLockAtBoot', () => {
  it('clears a stale lock and reports what it cleared', async () => {
    const staleStarted = new Date(Date.now() - (STALE_LOCK_MS + 60_000)).toISOString();
    await writeFile(
      lockPath,
      JSON.stringify({ owner: 'updater', operation: 'doctor-switch', startedAt: staleStarted }),
    );
    const out = await releaseStaleLockAtBoot();
    expect(out.cleared).toBe(true);
    if (out.cleared) {
      expect(out.lock.operation).toBe('doctor-switch');
      expect(out.ageMs).toBeGreaterThan(STALE_LOCK_MS);
    }
    expect(await exists(lockPath)).toBe(false);
    // And the box is immediately operable again.
    let ran = false;
    await withMutex('self-update', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('leaves a FRESH lock untouched (does not clobber an in-flight op)', async () => {
    await writeFile(
      lockPath,
      JSON.stringify({
        owner: 'updater',
        operation: 'switch',
        startedAt: new Date(Date.now() - 5_000).toISOString(),
      }),
    );
    const out = await releaseStaleLockAtBoot();
    expect(out).toEqual({ cleared: false, reason: 'fresh' });
    expect(await exists(lockPath)).toBe(true);
  });

  it('is a no-op when there is no lock', async () => {
    const out = await releaseStaleLockAtBoot();
    expect(out).toEqual({ cleared: false, reason: 'no-lock' });
  });

  it('leaves a lock with an unparseable timestamp (fail-safe)', async () => {
    await writeFile(
      lockPath,
      JSON.stringify({ owner: 'updater', operation: 'switch', startedAt: 'not-a-date' }),
    );
    const out = await releaseStaleLockAtBoot();
    expect(out.cleared).toBe(false);
    expect(await exists(lockPath)).toBe(true);
  });
});
