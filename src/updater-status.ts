// Aggregate the updater's scattered warn/fail-worthy conditions into a single
// doctor-shaped result list, so the signalk-updater plugin can poll ONE route
// and republish them as `notifications.updater.*` (mirroring how the doctor
// plugin consumes /api/probes). The updater has no probe engine of its own —
// its signals live across the update cache, container state, the operation
// lock, and the last-operation-outcome cache — so we fold them here.

import type { AvailableUpdates, CurrentState, ImageState, LockInfo } from './types.js';
import type { OperationOutcome } from './last-outcome.js';

export type StatusLevel = 'ok' | 'warn' | 'fail' | 'unknown';

export interface StatusResult {
  id: string;
  label: string;
  status: StatusLevel;
  message: string;
}

export interface UpdaterStatus {
  ranAt: string;
  results: StatusResult[];
  summary: { ok: number; warn: number; fail: number; unknown: number };
}

// imageState values that mean "a newer image is available" (moved GHCR tag or
// a pulled-but-not-restarted image). Used for the dirkwa/master channels and
// signalk-server, which have no semver update stream.
const IMAGE_UPDATE_STATES: ReadonlySet<ImageState> = new Set<ImageState>([
  'pull-available',
  'pull-and-restart',
  'restart-required',
]);

function imageStateMessage(s: ImageState): string {
  switch (s) {
    case 'pull-available':
      return 'a newer image is available to pull';
    case 'restart-required':
      return 'a newer image is pulled but not yet running (restart to apply)';
    case 'pull-and-restart':
      return 'a newer image is available to pull and apply';
    default:
      return 'up to date';
  }
}

// One "update available for <name>" result. updateAvailable (channel-aware
// semver, computed in update-checker) OR an image-drift state both warrant a
// warn; the semver case carries the target tag, the imageState case explains
// the drift. dirkwa/master users only ever hit the imageState branch (their
// updateAvailable is always false — no semver stream).
function updateResult(
  id: string,
  label: string,
  info: { updateAvailable: boolean; availableTag?: string; imageState?: ImageState },
): StatusResult {
  if (info.updateAvailable && info.availableTag) {
    return { id, label, status: 'warn', message: `update available: ${info.availableTag}` };
  }
  if (info.imageState && IMAGE_UPDATE_STATES.has(info.imageState)) {
    return { id, label, status: 'warn', message: imageStateMessage(info.imageState) };
  }
  return { id, label, status: 'ok', message: 'up to date' };
}

function containerResult(id: string, label: string, state: string): StatusResult {
  // running / starting are fine; everything else is a real fault.
  if (state === 'running' || state === 'starting') {
    return { id, label, status: 'ok', message: state };
  }
  // stopped / unhealthy / missing — all real faults.
  return { id, label, status: 'fail', message: `container is ${state}` };
}

export interface StatusInputs {
  updates: AvailableUpdates;
  current: CurrentState;
  lock: { lock: LockInfo | null; stale: boolean };
  outcomes: OperationOutcome[];
}

/** Fold the updater's live signals into a doctor-shaped status list. Pure —
 *  all I/O happens in the route; this is unit-testable in isolation. */
export function buildUpdaterStatus(now: string, inputs: StatusInputs): UpdaterStatus {
  const results: StatusResult[] = [];

  // 1. Channel-aware "update available" per engine (semver or image drift).
  results.push(
    updateResult('update-available-updater', 'Updater update', inputs.updates.updater),
    updateResult('update-available-doctor', 'Doctor update', inputs.updates.doctor),
  );
  // signalk-server has no semver stream — imageState only.
  results.push(
    updateResult('update-available-signalk', 'SignalK server image', inputs.updates.signalkServer),
  );

  // 2. Container health (stopped / unhealthy / missing = fail).
  results.push(
    containerResult(
      'container-signalk-server',
      'SignalK server container',
      inputs.current.signalkServer.state,
    ),
    containerResult(
      'container-signalk-doctor-server',
      'Doctor container',
      inputs.current.doctorServer.state,
    ),
  );

  // 3. Stale operation lock — a crashed op wedges every future mutation.
  if (inputs.lock.stale && inputs.lock.lock) {
    results.push({
      id: 'stale-lock',
      label: 'Operation lock',
      status: 'warn',
      message: `a ${inputs.lock.lock.operation} operation left the lock held; force-clear it to unwedge controls`,
    });
  }

  // 4. Last mutating-operation failures (self-update / switch / doctor-update).
  for (const o of inputs.outcomes) {
    if (!o.ok) {
      results.push({
        id: `last-${o.operation}`,
        label: `Last ${o.operation}`,
        status: 'fail',
        message: `last ${o.operation} failed${o.error ? `: ${o.error}` : ''}`,
      });
    }
  }

  const summary = { ok: 0, warn: 0, fail: 0, unknown: 0 };
  for (const r of results) summary[r.status]++;
  return { ranAt: now, results, summary };
}
