import { safe } from './podman/client.js';
import { rewriteQuadletImage, writeLastGood } from './quadlet/rewriter.js';
import { daemonReload, startUnit, stopUnitAndWait } from './dbus/systemd-user.js';
import { withMutex } from './mutex.js';
import { DEFAULT_HEALTH_TIMEOUT_MS, pollHealth, pullImage, trialRun } from './container-ops.js';
import { invalidate as invalidateUpdatesCache } from './update-checker.js';
import type { SwitchResult } from './types.js';

// Same shape as switch-service.ts but pointed at the doctor's image,
// Quadlet, unit, and health URL. The doctor doesn't take a pre-switch
// backup — it has no database or config to lose — so the backup hook
// from the signalk-server flow is intentionally absent here.
const DOCTOR_IMAGE = process.env.DOCTOR_IMAGE ?? 'ghcr.io/dirkwa/signalk-doctor-server';
const DOCTOR_QUADLET = 'signalk-doctor-server.container';
const DOCTOR_UNIT = 'signalk-doctor-server.service';
const DOCTOR_HEALTH_URL = process.env.DOCTOR_HEALTH_URL ?? 'http://127.0.0.1:3004/api/health';
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

  // 2. Trial run with the new image
  const trial = await trialRun(newImage, TRIAL_NAME_PREFIX);
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

  // 3. Rewrite Quadlet atomically (snapshots first per CC-1)
  try {
    const rewrite = await rewriteQuadletImage(DOCTOR_QUADLET, newImage);
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

  // 4. daemon-reload + stop + start (NOT RestartUnit — see switch-service.ts
  // for the auto-restart-timer rationale; same applies here)
  const dbusOk = await safe(async () => {
    await daemonReload();
    await stopUnitAndWait(DOCTOR_UNIT);
    await startUnit(DOCTOR_UNIT);
  });
  if (!dbusOk.ok) {
    if (previousImage) {
      await rewriteQuadletImage(DOCTOR_QUADLET, previousImage).catch(() => undefined);
    }
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
  const healthy = await pollHealth(DOCTOR_HEALTH_URL, timeoutMs);
  if (!healthy) {
    if (previousImage) {
      await rewriteQuadletImage(DOCTOR_QUADLET, previousImage).catch(() => undefined);
      await safe(async () => {
        await daemonReload();
        await stopUnitAndWait(DOCTOR_UNIT);
        await startUnit(DOCTOR_UNIT);
      });
    }
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

  return {
    ok: true,
    from: previousImage,
    to: input.tag,
    durationMs: Date.now() - start,
    hooksRun,
  };
}
