import { safe } from './podman/client.js';
import { rewriteQuadletImage, writeLastGood } from './quadlet/rewriter.js';
import { daemonReload, startUnit, stopUnitAndWait } from './dbus/systemd-user.js';
import { withMutex } from './mutex.js';
import { DEFAULT_HEALTH_TIMEOUT_MS, pollHealth, pullImage, trialRun } from './container-ops.js';
import { invalidate as invalidateUpdatesCache } from './update-checker.js';
import { pruneOldImagesFor } from './image-retention.js';
import { resolveDoctorHealthUrl } from './signalk-url-resolver.js';
import { publishSwitchEvent } from './switch-progress-broker.js';
import type { SwitchProgressEvent, SwitchResult } from './types.js';

// All progress events from this flow carry target:'doctor' so the UI
// routes them to the Doctor card (the broker is shared with the
// signalk-server switch — the CC-5 mutex guarantees only one runs at a
// time). The browser drives the doctor-update outcome off this stream's
// terminal event, so a proxy that times out the long POST and returns 502
// no longer hides the real result.
function emit(ev: Omit<SwitchProgressEvent, 'at' | 'target'>): void {
  publishSwitchEvent({ ...ev, target: 'doctor' });
}

// Same shape as switch-service.ts but pointed at the doctor's image,
// Quadlet, unit, and health URL. The doctor doesn't take a pre-switch
// backup — it has no database or config to lose — so the backup hook
// from the signalk-server flow is intentionally absent here.
const DOCTOR_IMAGE = process.env.DOCTOR_IMAGE ?? 'ghcr.io/dirkwa/signalk-doctor-server';
const DOCTOR_QUADLET = 'signalk-doctor-server.container';
const DOCTOR_UNIT = 'signalk-doctor-server.service';
const TRIAL_NAME_PREFIX = 'signalk-doctor-trial';

interface DoctorSwitchInput {
  tag: string;
  healthTimeoutMs?: number;
}

export async function performDoctorSwitch(input: DoctorSwitchInput): Promise<SwitchResult> {
  // Same mutex as signalk-server switch + self-update. CC-5 invariant:
  // only one of these flows can run at a time across the updater AND
  // the doctor (the doctor's recovery flow also takes the same lock).
  return withMutex('doctor-switch', () => doDoctorSwitch(input));
}

async function doDoctorSwitch(input: DoctorSwitchInput): Promise<SwitchResult> {
  const start = Date.now();
  const newImage = `${DOCTOR_IMAGE}:${input.tag}`;
  const hooksRun: string[] = [];
  let previousImage: string;
  let snapshotPath: string;

  // 1. Pull
  emit({ stage: 'pulling', to: input.tag, message: `Pulling ${newImage}…` });
  const pull = await pullImage(newImage);
  if (!pull.ok) {
    emit({ stage: 'failed', to: input.tag, error: `pull failed: ${pull.error}` });
    return {
      ok: false,
      from: '',
      to: input.tag,
      durationMs: Date.now() - start,
      hooksRun,
      error: `pull failed: ${pull.error}`,
    };
  }

  // 2. Trial run with the new image
  emit({ stage: 'trial', to: input.tag, message: 'Trial-running new image…' });
  const trial = await trialRun(newImage, TRIAL_NAME_PREFIX);
  if (!trial.ok) {
    emit({ stage: 'failed', to: input.tag, error: `trial-run failed: ${trial.error}` });
    return {
      ok: false,
      from: '',
      to: input.tag,
      durationMs: Date.now() - start,
      hooksRun,
      error: `trial-run failed: ${trial.error}`,
    };
  }

  // 3. Rewrite Quadlet atomically (snapshots first per CC-1)
  emit({ stage: 'rewriting-quadlet', to: input.tag, message: 'Rewriting Quadlet…' });
  try {
    const rewrite = await rewriteQuadletImage(DOCTOR_QUADLET, newImage);
    previousImage = rewrite.previousImage;
    snapshotPath = rewrite.snapshotPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({ stage: 'failed', to: input.tag, error: `quadlet rewrite failed: ${msg}` });
    return {
      ok: false,
      from: '',
      to: input.tag,
      durationMs: Date.now() - start,
      hooksRun,
      error: `quadlet rewrite failed: ${msg}`,
    };
  }

  // 4. daemon-reload + stop + start (NOT RestartUnit — see switch-service.ts
  // for the auto-restart-timer rationale; same applies here)
  emit({
    stage: 'restarting',
    to: input.tag,
    from: previousImage,
    message: 'Restarting signalk-doctor-server…',
  });
  const dbusOk = await safe(async () => {
    await daemonReload();
    await stopUnitAndWait(DOCTOR_UNIT);
    await startUnit(DOCTOR_UNIT);
  });
  if (!dbusOk.ok) {
    emit({
      stage: 'rolling-back',
      to: input.tag,
      from: previousImage,
      error: `systemd restart failed: ${dbusOk.error.userMessage}`,
    });
    if (previousImage) {
      await rewriteQuadletImage(DOCTOR_QUADLET, previousImage).catch(() => undefined);
    }
    emit({
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

  // 5. Health poll
  const timeoutMs = input.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const healthUrl = await resolveDoctorHealthUrl();
  const healthy = await pollHealth(healthUrl, timeoutMs, {
    onProgress: (p) => {
      emit({
        stage: 'health-poll',
        to: input.tag,
        from: previousImage,
        message: `Waiting for doctor health… ${Math.round(p.elapsedMs / 1000)}s of ${Math.round(p.timeoutMs / 1000)}s (attempt ${p.attempt})`,
      });
    },
  });
  if (!healthy) {
    emit({
      stage: 'rolling-back',
      to: input.tag,
      from: previousImage,
      error: `signalk-doctor-server did not become healthy within ${timeoutMs}ms`,
    });
    if (previousImage) {
      await rewriteQuadletImage(DOCTOR_QUADLET, previousImage).catch(() => undefined);
      await safe(async () => {
        await daemonReload();
        await stopUnitAndWait(DOCTOR_UNIT);
        await startUnit(DOCTOR_UNIT);
      });
    }
    emit({
      stage: 'failed',
      to: input.tag,
      from: previousImage,
      error: `signalk-doctor-server did not become healthy within ${timeoutMs}ms`,
    });
    return {
      ok: false,
      from: previousImage,
      to: input.tag,
      durationMs: Date.now() - start,
      hooksRun,
      error: `signalk-doctor-server did not become healthy within ${timeoutMs}ms`,
      rolledBack: true,
    };
  }

  // 6. Mark last-good
  await writeLastGood(DOCTOR_QUADLET, {
    tag: input.tag,
    image: newImage,
    snapshotPath,
  }).catch(() => undefined);

  // 7. Bust the update-checker cache: the doctor's RuntimeIdentity
  // just moved, so the next /api/updates/available read shouldn't be
  // racing against a stale "updateAvailable: true" from before the
  // switch. Fire-and-forget; the refresh happens in the background.
  invalidateUpdatesCache();

  // 8. Reclaim superseded doctor images (running + :latest + previous semver
  //    protected; :latest is a default-protected rolling tag). Awaited inside
  //    the withMutex('doctor-switch') lock (CC-5); `.catch` keeps it best-effort.
  //    Protect the just-replaced tag explicitly — on a downgrade/skip it's the
  //    real rollback target, not necessarily the newest semver the keep keeps.
  const previousTag = previousImage.startsWith(`${DOCTOR_IMAGE}:`)
    ? previousImage.slice(DOCTOR_IMAGE.length + 1)
    : undefined;
  await pruneOldImagesFor(DOCTOR_IMAGE, 'signalk-doctor-server', {
    protectTags: previousTag ? [previousTag] : [],
  }).catch(() => undefined);

  emit({
    stage: 'complete',
    to: input.tag,
    from: previousImage,
    message: `Updated signalk-doctor-server to ${input.tag}`,
  });

  return {
    ok: true,
    from: previousImage,
    to: input.tag,
    durationMs: Date.now() - start,
    hooksRun,
  };
}
