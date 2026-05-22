import { resolveRuntime, safe } from './podman/client.js';
import { rewriteQuadletImage, writeLastGood } from './quadlet/rewriter.js';
import { daemonReload, restartUnit } from './dbus/systemd-user.js';
import { withMutex } from './mutex.js';
import { preSwitchBackup, type BackupResult } from './backup.js';
import type { SwitchResult } from './types.js';
import { setTimeout as delay } from 'node:timers/promises';

const SIGNALK_IMAGE = process.env.SIGNALK_IMAGE ?? 'ghcr.io/dirkwa/signalk-server';
const SIGNALK_QUADLET = 'signalk-server.container';
const SIGNALK_UNIT = 'signalk-server.service';
const SIGNALK_HEALTH_URL = process.env.SIGNALK_HEALTH_URL ?? 'http://127.0.0.1:3000/signalk';

interface SwitchInput {
  tag: string;
  skipBackup?: boolean;
  healthTimeoutMs?: number;
}

async function pollHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(SIGNALK_HEALTH_URL);
      if (res.ok) return true;
    } catch {
      // ignore; retry
    }
    await delay(2000);
  }
  return false;
}

async function pullImage(image: string): Promise<{ ok: boolean; error?: string }> {
  const rt = await resolveRuntime();
  if (!rt) return { ok: false, error: 'runtime unreachable' };
  const r = await safe(
    () =>
      new Promise<void>((resolve, reject) => {
        rt.client.pull(image, {}, (err, stream) => {
          if (err) return reject(err);
          if (!stream) return resolve();
          rt.client.modem.followProgress(
            stream,
            (e) => (e ? reject(e) : resolve()),
            () => {
              /* ignore progress events */
            },
          );
        });
      }),
  );
  return r.ok ? { ok: true } : { ok: false, error: r.error.userMessage };
}

async function trialRun(image: string): Promise<{ ok: boolean; error?: string }> {
  const rt = await resolveRuntime();
  if (!rt) return { ok: false, error: 'runtime unreachable' };
  let c: { id: string; remove: (o?: { force?: boolean }) => Promise<void> } | null = null;
  try {
    const created = await rt.client.createContainer({
      Image: image,
      name: `signalk-updater-trial-${Date.now()}`,
      Cmd: ['node', '--version'], // override to a guaranteed-fast probe; we only need "image starts"
      HostConfig: { AutoRemove: false },
    });
    c = { id: created.id, remove: (o) => created.remove(o ?? { force: true }) };
    await created.start();
    await delay(3000);
    const info = (await created.inspect()) as unknown as {
      State?: { Running?: boolean; ExitCode?: number };
    };
    // For probes that exit fast (like `node --version`), ExitCode 0 = healthy start.
    if (info.State?.Running) return { ok: true };
    if (info.State?.ExitCode === 0) return { ok: true };
    return { ok: false, error: `trial exited with code ${info.State?.ExitCode}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    if (c) {
      try {
        await c.remove({ force: true });
      } catch {
        // best-effort
      }
    }
  }
}

export async function performSwitch(input: SwitchInput): Promise<SwitchResult> {
  return withMutex('switch', () => doSwitch(input));
}

async function doSwitch(input: SwitchInput): Promise<SwitchResult> {
  const start = Date.now();
  const newImage = `${SIGNALK_IMAGE}:${input.tag}`;
  const hooksRun: string[] = [];
  let previousImage: string;
  let snapshotPath: string;

  // 1. Pre-switch backup (best-effort)
  const backupResult: BackupResult = await preSwitchBackup(Boolean(input.skipBackup));
  if (backupResult.taken) {
    hooksRun.push(`backup:${backupResult.via}`);
  } else if (backupResult.reason === 'skipped') {
    hooksRun.push('backup:skipped');
  } else if (backupResult.reason === 'no-backup-installed') {
    hooksRun.push('backup:not-available');
  } else {
    hooksRun.push('backup:failed');
  }

  // 2. Pull
  const pull = await pullImage(newImage);
  if (!pull.ok) {
    return {
      ok: false,
      from: '',
      to: input.tag,
      durationMs: Date.now() - start,
      hooksRun,
      error: `pull failed: ${pull.error}`,
    };
  }

  // 3. Trial run with the new image
  const trial = await trialRun(newImage);
  if (!trial.ok) {
    return {
      ok: false,
      from: '',
      to: input.tag,
      durationMs: Date.now() - start,
      hooksRun,
      error: `trial-run failed: ${trial.error}`,
    };
  }

  // 4. Rewrite Quadlet atomically (snapshots first)
  try {
    const rewrite = await rewriteQuadletImage(SIGNALK_QUADLET, newImage);
    previousImage = rewrite.previousImage;
    snapshotPath = rewrite.snapshotPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      from: '',
      to: input.tag,
      durationMs: Date.now() - start,
      hooksRun,
      error: `quadlet rewrite failed: ${msg}`,
    };
  }

  // 5. daemon-reload + restart
  const dbusOk = await safe(async () => {
    await daemonReload();
    await restartUnit(SIGNALK_UNIT);
  });
  if (!dbusOk.ok) {
    // Try to roll back the Quadlet before bailing
    if (previousImage)
      await rewriteQuadletImage(SIGNALK_QUADLET, previousImage).catch(() => undefined);
    return {
      ok: false,
      from: previousImage,
      to: input.tag,
      durationMs: Date.now() - start,
      hooksRun,
      error: `systemd restart failed: ${dbusOk.error.userMessage}`,
      rolledBack: true,
    };
  }

  // 6. Health poll
  const timeoutMs = input.healthTimeoutMs ?? 60000;
  const healthy = await pollHealth(timeoutMs);
  if (!healthy) {
    if (previousImage) {
      await rewriteQuadletImage(SIGNALK_QUADLET, previousImage).catch(() => undefined);
      await safe(async () => {
        await daemonReload();
        await restartUnit(SIGNALK_UNIT);
      });
    }
    return {
      ok: false,
      from: previousImage,
      to: input.tag,
      durationMs: Date.now() - start,
      hooksRun,
      error: `signalk-server did not become healthy within ${timeoutMs}ms`,
      rolledBack: true,
    };
  }

  // 7. Mark last-good
  await writeLastGood(SIGNALK_QUADLET, {
    tag: input.tag,
    image: newImage,
    snapshotPath,
  }).catch(() => undefined);

  return {
    ok: true,
    from: previousImage,
    to: input.tag,
    durationMs: Date.now() - start,
    hooksRun,
  };
}
