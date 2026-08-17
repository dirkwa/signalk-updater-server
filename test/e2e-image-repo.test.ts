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
// Test-unique owner so no dev box or CI runner can plausibly have images
// under it — the "no local images for the fork" assertion depends on that.
const FORK_OWNER = `e2e-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const FORK = `ghcr.io/${FORK_OWNER}/signalk-server`;
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
        LOCAL_IMAGES_DIR: join(dir, 'images'),
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
      body: JSON.stringify({ imageRepo: FORK }),
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
      // Mixed case + scheme + trailing slash → canonical form.
      body: JSON.stringify({
        imageRepo: `https://GHCR.io/${FORK_OWNER.toUpperCase()}/SignalK-Server/`,
      }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      imageRepo: FORK,
      effectiveImageRepo: FORK,
      imageRepoSource: 'setting',
      defaultImageRepo: 'ghcr.io/dirkwa/signalk-server',
    });

    const onDisk = JSON.parse(await readFile(join(dir, 'data', 'version-settings.json'), 'utf8'));
    expect(onDisk).toEqual({ showBeta: false, showMaster: false, imageRepo: FORK });

    const get = (await (await fetch(settingsUrl())).json()) as { effectiveImageRepo: string };
    expect(get.effectiveImageRepo).toBe(FORK);
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

  it('lists local image files from the folder (peeked, not loaded) and validates names', async () => {
    // A docker-archive with only manifest.json — enough for the peek. No
    // podman load happens here (that path is covered by unit tests).
    const cfgHex = 'd'.repeat(64);
    const manifest = Buffer.from(
      JSON.stringify([
        { Config: `blobs/sha256/${cfgHex}`, RepoTags: ['ghcr.io/dirkwa/signalk-server:9.9.9-e2e'] },
      ]),
    );
    const hdr = Buffer.alloc(512);
    hdr.write('manifest.json', 0, 100);
    hdr.write('0000644\0', 100);
    hdr.write('0000000\0', 108);
    hdr.write('0000000\0', 116);
    hdr.write(manifest.length.toString(8).padStart(11, '0') + '\0', 124);
    hdr.write('00000000000\0', 136);
    hdr.write('        ', 148);
    hdr.write('0', 156);
    hdr.write('ustar\0', 257);
    hdr.write('00', 263);
    let sum = 0;
    for (const b of hdr) sum += b;
    hdr.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    const padded = Buffer.concat([manifest, Buffer.alloc(512 - (manifest.length % 512 || 512))]);
    const tar = Buffer.concat([hdr, padded, Buffer.alloc(1024)]);
    mkdirSync(join(dir, 'images'), { recursive: true });
    writeFileSync(join(dir, 'images', 'sk-e2e.tar'), tar);
    writeFileSync(join(dir, 'images', 'README.txt'), 'not an archive');

    const r = await fetch(`${base}/api/versions/archives`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      dir: string;
      archives: Array<{
        name: string;
        refs: string[] | null;
        imageId: string | null;
        loaded: boolean;
        format: string;
      }>;
    };
    expect(body.dir).toBe(join(dir, 'images'));
    expect(body.archives.map((a) => a.name)).toEqual(['sk-e2e.tar']);
    expect(body.archives[0]).toMatchObject({
      format: 'tar',
      refs: ['ghcr.io/dirkwa/signalk-server:9.9.9-e2e'],
      imageId: `sha256:${cfgHex}`,
      loaded: false,
    });

    // Name validation on the mutating routes — never a path.
    const bad = await fetch(`${base}/api/versions/archives/load`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: '../sk-e2e.tar' }),
    });
    expect(bad.status).toBe(400);
    const notLoaded = await fetch(`${base}/api/versions/archives/switch`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'sk-e2e.tar' }),
    });
    expect(notLoaded.status).toBe(409);
    expect(((await notLoaded.json()) as { error: string }).error).toMatch(
      /load the archive first/i,
    );

    // Delete works and is bearer-gated.
    const noAuth = await fetch(`${base}/api/versions/archives/sk-e2e.tar`, { method: 'DELETE' });
    expect(noAuth.status).toBe(401);
    const del = await fetch(`${base}/api/versions/archives/sk-e2e.tar`, {
      method: 'DELETE',
      // No content-type: Fastify 400s a JSON content-type with an empty body.
      headers: { authorization: auth.authorization },
    });
    expect(del.status).toBe(204);
    const after = (await (await fetch(`${base}/api/versions/archives`)).json()) as {
      archives: unknown[];
    };
    expect(after.archives).toEqual([]);
  });

  it('serves a webapp bundle that carries the Advanced tab', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const scripts = [...html.matchAll(/src="\.?\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    let found = false;
    for (const s of scripts) {
      const js = await (await fetch(`${base}/${s}`)).text();
      if (
        js.includes('Advanced') &&
        js.includes('/api/versions/settings') &&
        js.includes('/api/versions/archives')
      ) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});
