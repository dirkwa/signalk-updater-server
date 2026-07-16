import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Env before importing the server (mutex reads OPERATION_LOCK at
// module-eval; requireToken needs a real token file) — same pattern as
// lock-route.test.ts.
const dir = mkdtempSync(join(tmpdir(), 'doctor-update-route-'));
process.env.OPERATION_LOCK = join(dir, 'operation.lock');
process.env.DATA_DIR = dir;
const TEST_TOKEN = 'doctor-update-test-token';
writeFileSync(join(dir, 'token'), TEST_TOKEN);
process.env.TOKEN_PATH = join(dir, 'token');

vi.mock('../src/doctor-switch-service.js', () => ({
  performDoctorSwitch: vi.fn(),
}));

const { createServer } = await import('../src/server.js');
const { performDoctorSwitch } = await import('../src/doctor-switch-service.js');
const { MutexBusyError } = await import('../src/mutex.js');
const { subscribeSwitchProgress, __resetSwitchProgressForTests } =
  await import('../src/switch-progress-broker.js');

const performDoctorSwitchMock = vi.mocked(performDoctorSwitch);

let app: Awaited<ReturnType<typeof createServer>>;

beforeAll(async () => {
  app = await createServer();
});

afterAll(async () => {
  if (app) await app.close();
  delete process.env.OPERATION_LOCK;
  delete process.env.DATA_DIR;
  delete process.env.TOKEN_PATH;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  performDoctorSwitchMock.mockReset();
  __resetSwitchProgressForTests();
});

/** Next switch-progress event matching `stage`, so a test can await the
 *  background runner's publication without polling. */
function nextEvent(stage: string): Promise<{ target?: string; error?: string; to?: string }> {
  return new Promise((resolve) => {
    const unsubscribe = subscribeSwitchProgress((ev) => {
      if (ev.stage === stage) {
        unsubscribe();
        resolve(ev);
      }
    });
  });
}

describe('POST /api/doctor/update', () => {
  it('requires the bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/doctor/update',
      payload: { tag: '0.8.3' },
    });
    expect(res.statusCode).toBe(401);
    expect(performDoctorSwitchMock).not.toHaveBeenCalled();
  });

  it('answers 202 immediately while the switch is still running', async () => {
    // The switch outlives the embedded plugin proxy's 15s header watchdog
    // (pull + restart + health-poll); a blocking response surfaced as a
    // 502 on EVERY doctor update. Prove the response does not wait: the
    // mocked switch never resolves until we let it.
    let release: (r: { ok: boolean }) => void = () => {};
    performDoctorSwitchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }) as ReturnType<typeof performDoctorSwitch>,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/doctor/update',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: { tag: '0.8.3' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, accepted: true, to: '0.8.3' });
    expect(performDoctorSwitchMock).toHaveBeenCalledWith({ tag: '0.8.3' });

    release({ ok: true });
  });

  it('publishes mutex-busy as a failed doctor event on the progress stream', async () => {
    // Mutex-busy throws before performDoctorSwitch can publish anything,
    // and the 202 response has already gone out — the SSE stream is the
    // only channel left, and the Dashboard drives its outcome from it.
    performDoctorSwitchMock.mockRejectedValue(
      new MutexBusyError({
        owner: 'updater',
        operation: 'switch',
        startedAt: new Date().toISOString(),
      }),
    );
    const failed = nextEvent('failed');

    const res = await app.inject({
      method: 'POST',
      url: '/api/doctor/update',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: { tag: '0.8.3' },
    });
    expect(res.statusCode).toBe(202);

    const ev = await failed;
    expect(ev.target).toBe('doctor');
    expect(ev.to).toBe('0.8.3');
    expect(ev.error).toMatch(/another operation is in progress/i);
  });

  it('publishes an unexpected throw as a failed doctor event', async () => {
    performDoctorSwitchMock.mockRejectedValue(new Error('podman exploded'));
    const failed = nextEvent('failed');

    const res = await app.inject({
      method: 'POST',
      url: '/api/doctor/update',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: { tag: '0.8.3' },
    });
    expect(res.statusCode).toBe(202);

    const ev = await failed;
    expect(ev.target).toBe('doctor');
    expect(ev.error).toBe('podman exploded');
  });
});
