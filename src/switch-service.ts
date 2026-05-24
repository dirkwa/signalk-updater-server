import { safe } from './podman/client.js';
import { rewriteQuadletImage, writeLastGood } from './quadlet/rewriter.js';
import { daemonReload, restartUnit } from './dbus/systemd-user.js';
import { withMutex } from './mutex.js';
import { preSwitchBackup, type BackupResult } from './backup.js';
import { pollHealth, pullImage, trialRun } from './container-ops.js';
import { publishSwitchEvent } from './switch-progress-broker.js';
import type { SwitchResult } from './types.js';

const SIGNALK_IMAGE = process.env.SIGNALK_IMAGE ?? 'ghcr.io/dirkwa/signalk-server';
const SIGNALK_QUADLET = 'signalk-server.container';
const SIGNALK_UNIT = 'signalk-server.service';
const SIGNALK_HEALTH_URL = process.env.SIGNALK_HEALTH_URL ?? 'http://127.0.0.1:3000/signalk';
const TRIAL_NAME_PREFIX = 'signalk-updater-trial';

interface SwitchInput {
  tag: string;
  skipBackup?: boolean;
  healthTimeoutMs?: number;
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
  publishSwitchEvent({ stage: 'pulling', to: input.tag, message: `Pulling ${newImage}…` });
  const pull = await pullImage(newImage);
  if (!pull.ok) {
    publishSwitchEvent({
      stage: 'failed',
      to: input.tag,
      error: `pull failed: ${pull.error}`,
    });
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
  publishSwitchEvent({ stage: 'trial', to: input.tag, message: 'Trial-running new image…' });
  const trial = await trialRun(newImage, TRIAL_NAME_PREFIX);
  if (!trial.ok) {
    publishSwitchEvent({
      stage: 'failed',
      to: input.tag,
      error: `trial-run failed: ${trial.error}`,
    });
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
  publishSwitchEvent({
    stage: 'rewriting-quadlet',
    to: input.tag,
    message: 'Rewriting Quadlet…',
  });
  try {
    const rewrite = await rewriteQuadletImage(SIGNALK_QUADLET, newImage);
    previousImage = rewrite.previousImage;
    snapshotPath = rewrite.snapshotPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    publishSwitchEvent({
      stage: 'failed',
      to: input.tag,
      error: `quadlet rewrite failed: ${msg}`,
    });
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
  publishSwitchEvent({
    stage: 'daemon-reload',
    to: input.tag,
    from: previousImage,
    message: 'Reloading systemd and restarting signalk-server…',
  });
  const dbusOk = await safe(async () => {
    await daemonReload();
    publishSwitchEvent({
      stage: 'restarting',
      to: input.tag,
      from: previousImage,
      message: 'Restarting signalk-server…',
    });
    await restartUnit(SIGNALK_UNIT);
  });
  if (!dbusOk.ok) {
    // Try to roll back the Quadlet before bailing
    publishSwitchEvent({
      stage: 'rolling-back',
      to: input.tag,
      from: previousImage,
      error: `systemd restart failed: ${dbusOk.error.userMessage}`,
    });
    if (previousImage)
      await rewriteQuadletImage(SIGNALK_QUADLET, previousImage).catch(() => undefined);
    publishSwitchEvent({
      stage: 'failed',
      to: input.tag,
      from: previousImage,
      error: `systemd restart failed: ${dbusOk.error.userMessage}`,
    });
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
  publishSwitchEvent({
    stage: 'health-poll',
    to: input.tag,
    from: previousImage,
    message: 'Waiting for signalk-server to become healthy…',
  });
  const timeoutMs = input.healthTimeoutMs ?? 60000;
  const healthy = await pollHealth(SIGNALK_HEALTH_URL, timeoutMs);
  if (!healthy) {
    publishSwitchEvent({
      stage: 'rolling-back',
      to: input.tag,
      from: previousImage,
      error: `signalk-server did not become healthy within ${timeoutMs}ms`,
    });
    if (previousImage) {
      await rewriteQuadletImage(SIGNALK_QUADLET, previousImage).catch(() => undefined);
      await safe(async () => {
        await daemonReload();
        await restartUnit(SIGNALK_UNIT);
      });
    }
    publishSwitchEvent({
      stage: 'failed',
      to: input.tag,
      from: previousImage,
      error: `signalk-server did not become healthy within ${timeoutMs}ms`,
    });
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

  publishSwitchEvent({
    stage: 'complete',
    to: input.tag,
    from: previousImage,
    message: `Switched to ${input.tag}`,
  });

  return {
    ok: true,
    from: previousImage,
    to: input.tag,
    durationMs: Date.now() - start,
    hooksRun,
  };
}
