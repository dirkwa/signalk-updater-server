import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchDriftReport,
  refreshDoctorDrift,
  __resetDoctorTokenCacheForTests,
} from '../src/drift-client.js';
import type { DriftReport } from '../src/types.js';

const VALID_REPORT: DriftReport = {
  signalkImageTag: 'ghcr.io/dirkwa/signalk-server:dirkwa',
  lastScannedAt: '2026-05-24T00:00:00.000Z',
  lastSuccessfulScanAt: '2026-05-24T00:00:00.000Z',
  online: true,
  packages: [
    {
      name: 'bonjour-service',
      installed: '1.3.0',
      latest: '1.4.0',
      classification: 'minor',
      lastFetchedAt: '2026-05-24T00:00:00.000Z',
    },
  ],
};

describe('fetchDriftReport', () => {
  const prevUrl = process.env.DOCTOR_DRIFT_URL;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.DOCTOR_DRIFT_URL = 'http://doctor.example';
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    if (prevUrl === undefined) delete process.env.DOCTOR_DRIFT_URL;
    else process.env.DOCTOR_DRIFT_URL = prevUrl;
    fetchSpy.mockRestore();
  });

  it('returns the parsed report on 200', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(VALID_REPORT), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const r = await fetchDriftReport();
    expect(r).toEqual(VALID_REPORT);
    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error('expected one fetch call');
    expect(String(call[0])).toBe('http://doctor.example/api/drift');
  });

  it('returns null when the doctor is unreachable', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await fetchDriftReport()).toBeNull();
  });

  it('returns null on non-2xx response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }));
    expect(await fetchDriftReport()).toBeNull();
  });

  it('returns null on malformed payload (missing packages array)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ packages: 'not an array' }), { status: 200 }),
    );
    expect(await fetchDriftReport()).toBeNull();
  });

  it('returns null on the "never scanned yet" sentinel report', async () => {
    const empty: DriftReport = {
      signalkImageTag: null,
      lastScannedAt: '1970-01-01T00:00:00.000Z',
      lastSuccessfulScanAt: null,
      online: false,
      packages: [],
    };
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(empty), { status: 200 }));
    expect(await fetchDriftReport()).toBeNull();
  });
});

describe('refreshDoctorDrift', () => {
  let dir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const prevTokenPath = process.env.DOCTOR_TOKEN_PATH;
  const prevDoctorUrl = process.env.DOCTOR_DRIFT_URL;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'drift-client-'));
    process.env.DOCTOR_DRIFT_URL = 'http://doctor.example';
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    __resetDoctorTokenCacheForTests();
  });

  afterEach(async () => {
    if (prevTokenPath === undefined) delete process.env.DOCTOR_TOKEN_PATH;
    else process.env.DOCTOR_TOKEN_PATH = prevTokenPath;
    if (prevDoctorUrl === undefined) delete process.env.DOCTOR_DRIFT_URL;
    else process.env.DOCTOR_DRIFT_URL = prevDoctorUrl;
    fetchSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
    __resetDoctorTokenCacheForTests();
  });

  it('skips the call when no token file is present', async () => {
    process.env.DOCTOR_TOKEN_PATH = join(dir, 'missing-token');
    await refreshDoctorDrift();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts to the doctor with the bearer token when present', async () => {
    const tokenPath = join(dir, 'token');
    await writeFile(tokenPath, 'sekret\n', { encoding: 'utf8', mode: 0o600 });
    await chmod(tokenPath, 0o600);
    process.env.DOCTOR_TOKEN_PATH = tokenPath;
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await refreshDoctorDrift();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error('expected one fetch call');
    expect(String(call[0])).toBe('http://doctor.example/api/drift/refresh');
    const init = call[1] as { method: string; headers: Record<string, string> };
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sekret');
  });

  it('swallows network errors silently (best-effort)', async () => {
    const tokenPath = join(dir, 'token');
    await writeFile(tokenPath, 'sekret\n', { encoding: 'utf8', mode: 0o600 });
    await chmod(tokenPath, 0o600);
    process.env.DOCTOR_TOKEN_PATH = tokenPath;
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(refreshDoctorDrift()).resolves.toBeUndefined();
  });
});
