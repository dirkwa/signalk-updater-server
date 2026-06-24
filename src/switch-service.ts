import { safe } from './podman/client.js';
import { rewriteQuadletImage, writeLastGood } from './quadlet/rewriter.js';
import { daemonReload, startUnit, stopUnitAndWait } from './dbus/systemd-user.js';
import { withMutex } from './mutex.js';
import { preSwitchBackup, type BackupResult } from './backup.js';
import { DEFAULT_HEALTH_TIMEOUT_MS, pollHealth, pullImage, trialRun } from './container-ops.js';
import { publishSwitchEvent } from './switch-progress-broker.js';
import { refreshDoctorDrift } from './drift-client.js';
import { pruneOldImagesFor } from './image-retention.js';
import { resolveSignalkHealthUrl } from './signalk-url-resolver.js';
import type { SwitchResult } from './types.js';

const SIGNALK_IMAGE = process.env.SIGNALK_IMAGE ?? 'ghcr.io/dirkwa/signalk-server';
const SIGNALK_QUADLET = 'signalk-server.container';
const SIGNALK_UNIT = 'signalk-server.service';
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
  // Use stopUnit + startUnit instead of restartUnit. When the old
  // container exits non-zero (status=137 from SIGKILL because
  // signalk-server doesn't trap SIGTERM; or status=143 even on a clean
  // SIGTERM exit because systemd treats signal-deaths as failures), the
  // `Restart=` policy schedules an auto-restart on top of our DBus
  // restart request — adding a ~90s gap before the new container
  // actually starts. An intentional Stop suppresses the Restart= policy
  // for that transition (per systemd.service(5)), so the unit goes
  // Stop → inactive → Start with no auto-restart delay. Observed on
  // both signalk-server (Restart=always) and the doctor/updater
  // (Restart=on-failure) — the auto-restart timer fires regardless of
  // policy choice, only the trigger condition differs.
  const dbusOk = await safe(async () => {
    await daemonReload();
    publishSwitchEvent({
      stage: 'restarting',
      to: input.tag,
      from: previousImage,
      message: 'Stopping signalk-server…',
    });
    await stopUnitAndWait(SIGNALK_UNIT);
    publishSwitchEvent({
      stage: 'restarting',
      to: input.tag,
      from: previousImage,
      message: 'Starting signalk-server on new image…',
    });
    await startUnit(SIGNALK_UNIT);
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
  const timeoutMs = input.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const healthUrl = await resolveSignalkHealthUrl();
  const healthy = await pollHealth(healthUrl, timeoutMs, {
    // signalk-server's SSL plugin redirects :80/signalk to a self-signed
    // https endpoint; accept it on this local liveness probe (see
    // pollHealth's PollHealthOptions doc).
    allowSelfSigned: true,
    onProgress: (p) => {
      // Re-emit on each attempt so the UI shows progress instead of going
      // silent for the (potentially) 3 minutes the wait can take. Same
      // `stage: health-poll`; only the message changes.
      publishSwitchEvent({
        stage: 'health-poll',
        to: input.tag,
        from: previousImage,
        message: `Polling /signalk… ${Math.round(p.elapsedMs / 1000)}s of ${Math.round(p.timeoutMs / 1000)}s (attempt ${p.attempt})`,
      });
    },
  });
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
        await stopUnitAndWait(SIGNALK_UNIT);
        await startUnit(SIGNALK_UNIT);
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

  // 8. Kick the doctor's drift scan. The new image has its own pinned
  //    npm dep set, so the existing drift report is now misleading until
  //    the doctor's next jittered tick (up to 24h away). Fire-and-forget
  //    on a promise that swallows its own errors — never block the
  //    switch's completion path on a doctor-side hiccup.
  void refreshDoctorDrift();

  // 9. Reclaim superseded signalk-server images. The just-switched image, the
  //    rolling tags, and the immediately-previous semver are protected; older
  //    versions are removed. Awaited (not fire-and-forget) so the rmi runs
  //    INSIDE the withMutex('switch') lock wrapping this flow (CC-5) — a bare
  //    void could let removal continue after the lock released. `.catch` keeps
  //    it best-effort: a GC hiccup must never fail an otherwise-good switch.
  // Protect the tag we just switched AWAY from explicitly: on a downgrade or a
  // skipped-version switch the just-replaced image is the real rollback target,
  // which is not necessarily the newest semver that the keep window would keep.
  const previousTag = previousImage.startsWith(`${SIGNALK_IMAGE}:`)
    ? previousImage.slice(SIGNALK_IMAGE.length + 1)
    : undefined;
  await pruneOldImagesFor(SIGNALK_IMAGE, 'signalk-server', {
    // master + beta are channel heads (tagClassifier), not old semver images;
    // latest + dirkwa are protected by default.
    protectTags: ['master', 'beta', ...(previousTag ? [previousTag] : [])],
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
