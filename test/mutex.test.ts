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

const {
  withMutex,
  MutexBusyError,
  STALE_LOCK_MS,
  forceClear,
  readLock,
  releaseStaleLockAtBoot,
  __stealStaleLockForTests,
} = await import('../src/mutex.js');

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
    let entered!: () => void;
    const held = new Promise<void>((r) => (entered = r));
    const first = withMutex('switch', async () => {
      // Signal that the lock is actually acquired BEFORE we attempt the
      // second one. tryAcquire is async, so without this the second
      // withMutex can race ahead of the first lock's write and acquire it
      // (the first lock isn't on disk yet) — which is exactly the
      // ordering CI hit. Await `held` first to make the test deterministic.
      entered();
      await gate;
    });
    await held;
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

  it('the reclaim path puts back a FRESH lock it renamed away (the TOCTOU guard)', async () => {
    // Drives stealStaleLock directly against a lock that is fresh AT RENAME
    // TIME — the exact state B sees after A won the steal and installed its
    // own lock. Before the guard, B renamed A's fresh lock away, unlinked
    // it, wx-created its own and entered: two holders (the CI flake).
    const fresh = {
      owner: 'updater',
      operation: 'switch',
      startedAt: new Date().toISOString(),
      pid: 4242,
    };
    await writeFile(lockPath, JSON.stringify(fresh));
    const me = {
      owner: 'updater' as const,
      operation: 'doctor-switch' as const,
      startedAt: new Date().toISOString(),
      pid: process.pid,
    };
    const won = await __stealStaleLockForTests(me);
    expect(won).toBe(false);
    // The live lock is back at LOCK_PATH, byte-for-byte, and no claim
    // carcass was left behind.
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(fresh);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir).filter((f) => f.includes('.steal.'))).toEqual([]);
  });

  it('the reclaim path wins a genuinely stale lock and installs its own', async () => {
    const stale = {
      owner: 'updater',
      operation: 'switch',
      startedAt: new Date(Date.now() - (STALE_LOCK_MS + 60_000)).toISOString(),
    };
    await writeFile(lockPath, JSON.stringify(stale));
    const me = {
      owner: 'updater' as const,
      operation: 'doctor-switch' as const,
      startedAt: new Date().toISOString(),
      pid: process.pid,
    };
    expect(await __stealStaleLockForTests(me)).toBe(true);
    expect(await readLock()).toEqual(me);
  });

  it('an unreadable carcass (lock caught mid-write) is treated as live, not stolen', async () => {
    await writeFile(lockPath, ''); // wx-created, contents not yet written
    const me = {
      owner: 'updater' as const,
      operation: 'switch' as const,
      startedAt: new Date().toISOString(),
      pid: process.pid,
    };
    expect(await __stealStaleLockForTests(me)).toBe(false);
    expect(await exists(lockPath)).toBe(true);
    expect(await readFile(lockPath, 'utf8')).toBe('');
  });

  it('two concurrent reclaimers never both enter — 25 rounds', async () => {
    // The original race, repeated: the guard must hold every time, not
    // just when the scheduler happens to be kind.
    for (let round = 0; round < 25; round++) {
      await rm(lockPath, { force: true });
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
      // Deterministic: the loser settles with MutexBusyError while the
      // winner is parked on the gate — wait for that, then release. If BOTH
      // got in (the bug), neither settles; the timeout keeps the test from
      // hanging and the assertions below fail loudly.
      const first = await Promise.race([
        a,
        b,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 2000)),
      ]);
      releaseAll();
      const [ra, rb] = await Promise.all([a, b]);
      expect(first, `round ${round}: loser should have been rejected busy`).toBeInstanceOf(
        MutexBusyError,
      );
      expect(maxConcurrent, `round ${round}`).toBe(1);
      expect([ra, rb].filter((x) => x === 'ran').length, `round ${round}`).toBe(1);
    }
  });

  it('release only removes OUR lock, never one that replaced it', async () => {
    // If, on the residual reclaim path, someone else's lock ends up at
    // LOCK_PATH while we think we hold it, our release must not remove
    // theirs (that would open the door for a second operation).
    const foreign = {
      owner: 'doctor',
      operation: 'doctor-switch',
      startedAt: new Date().toISOString(),
      pid: 999999,
    };
    const { warn } = console;
    console.warn = () => undefined;
    try {
      await withMutex('switch', async () => {
        await writeFile(lockPath, JSON.stringify(foreign));
      });
    } finally {
      console.warn = warn;
    }
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(foreign);
    await rm(lockPath, { force: true });
    // …and a normal run still releases its own lock.
    await withMutex('switch', async () => undefined);
    expect(await exists(lockPath)).toBe(false);
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
