import { safe } from './podman/client.js';
import { rewriteQuadletImage, writeLastGood } from './quadlet/rewriter.js';
import {
  daemonReload,
  isSafeToStop,
  startUnit,
  stopUnitAndWait,
  waitWhileActivating,
} from './dbus/systemd-user.js';
import { withMutex, MutexBusyError } from './mutex.js';
import {
  DEFAULT_HEALTH_TIMEOUT_MS,
  POST_SETTLE_HEALTH_TIMEOUT_MS,
  pollHealth,
  pullImage,
  trialRun,
} from './container-ops.js';
import { invalidate as invalidateUpdatesCache } from './update-checker.js';
import { pruneOldImagesFor } from './image-retention.js';
import { resolveDoctorHealthUrl } from './signalk-url-resolver.js';
import { publishSwitchEvent } from './switch-progress-broker.js';
import { recordOutcome } from './last-outcome.js';
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

/**
 * Restore the Quadlet to `previousImage`, reporting whether it actually
 * happened. The boolean is the whole point: the old code swallowed a failed
 * rewrite with `.catch(() => undefined)` and then returned `rolledBack: true`
 * regardless, so a rollback that silently did nothing -- a full or failing SD
 * card is the realistic cause, and a switch is exactly when the card is under
 * pressure -- reported success. The operator would be told the box was back on
 * the old image while it was still on the broken one.
 *
 * The raw error is logged, never surfaced: it can carry host paths, and this
 * string reaches the SSE stream and a SignalK notification.
 */
async function restoreQuadlet(previousImage: string): Promise<boolean> {
  try {
    await rewriteQuadletImage(DOCTOR_QUADLET, previousImage);
    return true;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error(`doctor-switch: rollback to ${previousImage} failed: ${raw}`);
    return false;
  }
}

export async function performDoctorSwitch(input: DoctorSwitchInput): Promise<SwitchResult> {
  // Same mutex as signalk-server switch + self-update. CC-5 invariant:
  // only one of these flows can run at a time across the updater AND
  // the doctor (the doctor's recovery flow also takes the same lock).
  try {
    const result = await withMutex('doctor-switch', () => doDoctorSwitch(input));
    recordOutcome({
      operation: 'doctor-update',
      ok: result.ok,
      from: result.from || undefined,
      to: result.to,
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
    return result;
  } catch (err) {
    // Thrown failure still recorded; mutex contention propagates un-recorded.
    if (err instanceof MutexBusyError) throw err;
    // Safe, stable message (surfaced via updater-status → notification); the
    // raw error still propagates via `throw` and is logged by the route.
    recordOutcome({
      operation: 'doctor-update',
      ok: false,
      to: input.tag,
      error: `doctor update to ${input.tag} failed`,
    });
    throw err;
  }
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
    // Raw exception (may carry host paths) → log only; surface a stable string
    // (flows to the SSE event and, via recordOutcome, a SignalK notification).
    const raw = err instanceof Error ? err.message : String(err);
    console.error(`doctor-switch: quadlet rewrite failed for ${input.tag}: ${raw}`);
    emit({ stage: 'failed', to: input.tag, error: 'quadlet rewrite failed' });
    return {
      ok: false,
      from: '',
      to: input.tag,
      durationMs: Date.now() - start,
      hooksRun,
      error: 'quadlet rewrite failed',
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
    const rolledBack = previousImage ? await restoreQuadlet(previousImage) : false;
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
      rolledBack,
    };
  }

  // 5. Health poll
  const timeoutMs = input.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const healthUrl = await resolveDoctorHealthUrl();
  let healthy = await pollHealth(healthUrl, timeoutMs, {
    onProgress: (p) => {
      emit({
        stage: 'health-poll',
        to: input.tag,
        from: previousImage,
        message: `Waiting for doctor health… ${Math.round(p.elapsedMs / 1000)}s of ${Math.round(p.timeoutMs / 1000)}s (attempt ${p.attempt})`,
      });
    },
  });

  // An expired poll does not prove failure: `startUnit` only enqueues a job,
  // and the container create can still be running inside the Quadlet's
  // TimeoutStartSec. Stopping a unit that is still `activating` SIGKILLs
  // `podman run` mid-create and leaves an incomplete overlay layer that wedges
  // podman's global storage lock. Wait for the start to settle, then re-check.
  // Bail without touching the unit or the Quadlet when it is not provably
  // settled. Mirrors switch-service.ts.
  const handsOff = (state: string): SwitchResult => {
    const stuckError =
      `signalk-doctor-server did not reach a settled state after ${timeoutMs}ms ` +
      `of health polling (systemd reports "${state}"); left alone on ` +
      `${input.tag} rather than risk interrupting container creation`;
    emit({
      stage: 'failed',
      to: input.tag,
      from: previousImage,
      error: stuckError,
    });
    return {
      ok: false,
      from: previousImage,
      to: input.tag,
      durationMs: Date.now() - start,
      hooksRun,
      error: stuckError,
      rolledBack: false,
    };
  };

  if (!healthy) {
    const settled = await waitWhileActivating(DOCTOR_UNIT);
    if (settled === 'active') {
      emit({
        stage: 'health-poll',
        to: input.tag,
        from: previousImage,
        message: 'Container finished starting after the poll window; re-checking health…',
      });
      // No allowSelfSigned: the doctor's probe is plain http (see
      // PollHealthOptions), so this matches the first poll's options exactly.
      healthy = await pollHealth(healthUrl, POST_SETTLE_HEALTH_TIMEOUT_MS);
    } else if (!isSafeToStop(settled)) {
      // Already stuck once — do not spend a second full settle window on it.
      return handsOff(settled);
    }
  }

  if (!healthy) {
    // Re-read IMMEDIATELY before touching the unit: the check above is up to
    // POST_SETTLE_HEALTH_TIMEOUT_MS stale, and a container that starts, fails
    // its probe and dies is back in `activating` — a fresh `podman run` mid
    // container-create — within RestartSec. Mirrors switch-service.ts.
    const current = await waitWhileActivating(DOCTOR_UNIT);
    if (!isSafeToStop(current)) return handsOff(current);
  }

  if (!healthy) {
    emit({
      stage: 'rolling-back',
      to: input.tag,
      from: previousImage,
      error: `signalk-doctor-server did not become healthy within ${timeoutMs}ms`,
    });
    // Two independent facts, both required before this counts as a rollback:
    // that the unit actually stopped, and that the Quadlet actually went back.
    // Either one failing leaves the box somewhere other than "on the old image".
    let stopConfirmed = false;
    let quadletRestored = false;
    let configApplied = false;
    if (previousImage) {
      // Stop first, before the fsyncing Quadlet rewrite and the daemon-reload
      // DBus round trip — both take seconds on an SD card, and the safe-state
      // decision above is only valid until the next await. Mirrors
      // switch-service.ts.
      // The stop result is load-bearing, not fire-and-forget: `safe` returns
      // ok:false when the DBus StopUnit rejects, or when stopUnitAndWait gives
      // up polling for a terminal state. Either way the unit may still be
      // running the new image, so a rollback reported as complete would be a
      // lie. Recorded and surfaced below.
      const stopped = await safe(() => stopUnitAndWait(DOCTOR_UNIT));
      stopConfirmed = stopped.ok;
      if (!stopped.ok) {
        console.error(
          `doctor-switch: rollback stop of ${DOCTOR_UNIT} unconfirmed: ${stopped.error.userMessage}`,
        );
      }
      quadletRestored = await restoreQuadlet(previousImage);
      // daemon-reload's result matters as much as the rewrite's: without it
      // systemd keeps the unit it generated from the NEW image's Quadlet, so
      // the start below brings the container back up on exactly the image we
      // are rolling away from, while the Quadlet on disk says otherwise.
      // Restoring the file and applying it are two different claims.
      //
      // Separate safe() calls, NOT one block: we have already stopped the unit,
      // and an intentional Stop suppresses Restart=, so anything that skips the
      // start leaves it deliberately down. Sharing a try with daemonReload would
      // make a reload failure turn a rollback into an outage. Always attempt the
      // start, even against a stale unit definition.
      const reloaded = await safe(() => daemonReload());
      configApplied = reloaded.ok;
      if (!reloaded.ok) {
        console.error(
          `doctor-switch: rollback daemon-reload failed: ${reloaded.error.userMessage}`,
        );
      }
      await safe(() => startUnit(DOCTOR_UNIT));
    }
    // Say which half failed. "did not become healthy" alone would let an
    // operator assume the box is back on the old image when it may not be.
    let rollbackError = `signalk-doctor-server did not become healthy within ${timeoutMs}ms`;
    if (previousImage && !stopConfirmed) {
      rollbackError +=
        ', and the rollback could not confirm the unit stopped -- it may still be ' +
        'running the new image';
    } else if (previousImage && !quadletRestored) {
      rollbackError += ', and the Quadlet could not be restored to the previous image';
    } else if (previousImage && !configApplied) {
      rollbackError +=
        ', and the restored Quadlet could not be applied (daemon-reload failed), so the ' +
        'unit may have restarted on the new image';
    } else if (!previousImage) {
      rollbackError += '; no previous image was recorded, so nothing was rolled back';
    }
    emit({
      stage: 'failed',
      to: input.tag,
      from: previousImage,
      error: rollbackError,
    });
    return {
      ok: false,
      from: previousImage,
      to: input.tag,
      durationMs: Date.now() - start,
      hooksRun,
      error: rollbackError,
      rolledBack: stopConfirmed && quadletRestored && configApplied,
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
