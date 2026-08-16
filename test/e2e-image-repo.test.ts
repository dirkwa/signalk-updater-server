import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End-to-end: the REAL built engine (`dist/index.js`, what the container
 * image ships) as a child process, real HTTP over loopback, real
 * `/data`-style dirs on disk, real Quadlet parsing — no vi.mock anywhere.
 *
 * Exercises the Advanced-tab image-repo setting the way the plugin proxy
 * and the webapp do: bearer-gated PUT, unauthenticated GET, persistence
 * across requests, `/api/state.signalkServer.imageRepo` read from the
 * Quadlet, `/api/versions/local` steered by the setting, and the served
 * webapp bundle exposing the Advanced tab.
 *
 * Off the network on purpose: `/api/versions` (GHCR) and `/api/versions/pull`
 * (podman pull) are not called — the route-level tests cover the ref they
 * build; here we only assert what a real process persists and reports.
 * `/api/state` talks to whatever podman socket exists — none in CI, so
 * the container reads as `missing`, which is fine: `tag`/`imageRepo` come
 * from the Quadlet, not from podman.
 *
 * Skips (loudly) when `dist/` hasn't been built — CI builds before test.
 */

const DIST = join(process.cwd(), 'dist', 'index.js');
const TOKEN = 'e2e-image-repo-token';
const FAKE_QUADLET_IMAGE = 'ghcr.io/dirkwa/signalk-server:dirkwa-e2e0001';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`engine exited early: ${child.exitCode}`);
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`engine did not answer ${url} within ${timeoutMs}ms`);
}

describe.skipIf(!existsSync(DIST))('e2e: image repo setting through the built engine', () => {
  let dir: string;
  let child: ChildProcess;
  let base: string;
  let stderr = '';

  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const settingsUrl = (): string => `${base}/api/versions/settings`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'updater-e2e-'));
    const data = join(dir, 'data');
    const quadlets = join(dir, 'quadlets');
    mkdirSync(data);
    mkdirSync(quadlets);
    writeFileSync(join(data, 'token'), TOKEN, { mode: 0o600 });
    writeFileSync(
      join(quadlets, 'signalk-server.container'),
      ['[Container]', `Image=${FAKE_QUADLET_IMAGE}`, 'ContainerName=signalk-server', ''].join('\n'),
    );
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [DIST], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: data,
        TOKEN_PATH: join(data, 'token'),
        OPERATION_LOCK: join(data, 'operation.lock'),
        VERSION_SETTINGS_PATH: join(data, 'version-settings.json'),
        QUADLET_DIR: quadlets,
        DOCTOR_DATA: join(dir, 'doctor-data'),
        WEBAPP_ROOT: join(process.cwd(), 'public'),
        LOG_LEVEL: 'warn',
        // Make sure the env default doesn't leak into the assertions.
        SIGNALK_IMAGE: '',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    await waitFor(`${base}/api/health`, 15_000, child);
  }, 30_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (dir) await rm(dir, { recursive: true, force: true });
    if (stderr.trim()) console.info(`[e2e engine stderr]\n${stderr}`);
  });

  it('starts on the built-in default with no override', async () => {
    const r = await fetch(settingsUrl());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      showBeta: false,
      showMaster: false,
      imageRepo: null,
      effectiveImageRepo: 'ghcr.io/dirkwa/signalk-server',
      imageRepoSource: 'default',
      defaultImageRepo: 'ghcr.io/dirkwa/signalk-server',
    });
  });

  it('refuses an unauthenticated PUT and an invalid repo', async () => {
    const noAuth = await fetch(settingsUrl(), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageRepo: 'ghcr.io/fork/signalk-server' }),
    });
    expect(noAuth.status).toBe(401);

    const bad = await fetch(settingsUrl(), {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ imageRepo: 'docker.io/library/nginx' }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/only ghcr\.io/i);

    // Nothing was written.
    const after = (await (await fetch(settingsUrl())).json()) as { imageRepo: string | null };
    expect(after.imageRepo).toBeNull();
  });

  it('stores a canonicalised override, persists it to disk, and reports it as effective', async () => {
    const put = await fetch(settingsUrl(), {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ imageRepo: 'https://GHCR.io/Fork/SignalK-Server/' }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      imageRepo: 'ghcr.io/fork/signalk-server',
      effectiveImageRepo: 'ghcr.io/fork/signalk-server',
      imageRepoSource: 'setting',
      defaultImageRepo: 'ghcr.io/dirkwa/signalk-server',
    });

    const onDisk = JSON.parse(await readFile(join(dir, 'data', 'version-settings.json'), 'utf8'));
    expect(onDisk).toEqual({
      showBeta: false,
      showMaster: false,
      imageRepo: 'ghcr.io/fork/signalk-server',
    });

    const get = (await (await fetch(settingsUrl())).json()) as { effectiveImageRepo: string };
    expect(get.effectiveImageRepo).toBe('ghcr.io/fork/signalk-server');
  });

  it('exposes the Quadlet repo on /api/state so the webapp can flag the mismatch', async () => {
    const r = await fetch(`${base}/api/state`);
    expect(r.status).toBe(200);
    const s = (await r.json()) as { signalkServer: { tag: string; imageRepo?: string } };
    expect(s.signalkServer.tag).toBe('dirkwa-e2e0001');
    expect(s.signalkServer.imageRepo).toBe('ghcr.io/dirkwa/signalk-server');
  });

  it('lists local images for the configured repo (none for a fork this box never pulled)', async () => {
    const r = await fetch(`${base}/api/versions/local`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { images: Array<{ tag: string }> };
    // Whatever podman is or isn't reachable, a repo nobody has pulled from
    // yields an empty list — and never leaks dirkwa images under the fork.
    expect(Array.isArray(body.images)).toBe(true);
    expect(body.images).toEqual([]);
  });

  it('clears the override and falls back to the default', async () => {
    const put = await fetch(settingsUrl(), {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ imageRepo: null }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ imageRepo: null, imageRepoSource: 'default' });
    const onDisk = JSON.parse(await readFile(join(dir, 'data', 'version-settings.json'), 'utf8'));
    expect(onDisk.imageRepo).toBeNull();
  });

  it('serves a webapp bundle that carries the Advanced tab', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const scripts = [...html.matchAll(/src="\.?\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    let found = false;
    for (const s of scripts) {
      const js = await (await fetch(`${base}/${s}`)).text();
      if (js.includes('Advanced') && js.includes('/api/versions/settings')) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});
