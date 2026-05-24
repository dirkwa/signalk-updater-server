/**
 * Tracks the in-flight switch flow and fans progress events out to SSE
 * subscribers. Module-level singleton because the CC-5 mutex already
 * guarantees one switch at a time across the updater + doctor.
 *
 * Distinct from `log-stream-broker.ts` (which fans podman container
 * logs to many clients) — switch progress is a different shape and
 * has at most one publisher.
 */

export type SwitchStage =
  | 'idle'
  | 'pulling'
  | 'trial'
  | 'rewriting-quadlet'
  | 'daemon-reload'
  | 'restarting'
  | 'health-poll'
  | 'rolling-back'
  | 'complete'
  | 'failed';

export interface SwitchProgressEvent {
  /** Coarse phase the switch is in right now. */
  stage: SwitchStage;
  /** Free-form human message ("Pulling ghcr.io/dirkwa/signalk-server:0.6.0..."). */
  message?: string;
  /** Target tag. */
  to?: string;
  /** Previous tag, populated once the Quadlet rewrite reads it. */
  from?: string;
  /** Error string when stage === 'failed' or 'rolling-back'. */
  error?: string;
  /** Wall-clock timestamp the event was published; ISO 8601. */
  at: string;
}

type Listener = (ev: SwitchProgressEvent) => void;

let lastEvent: SwitchProgressEvent = { stage: 'idle', at: new Date().toISOString() };
const listeners = new Set<Listener>();

export function getLastSwitchEvent(): SwitchProgressEvent {
  return lastEvent;
}

export function publishSwitchEvent(ev: Omit<SwitchProgressEvent, 'at'>): void {
  const stamped: SwitchProgressEvent = { ...ev, at: new Date().toISOString() };
  lastEvent = stamped;
  for (const l of listeners) {
    try {
      l(stamped);
    } catch {
      // Listener errors must not break the publish path — a dead SSE
      // connection should fall through and be cleaned up by its own
      // teardown, not bring down the next stage emit.
    }
  }
}

export function subscribeSwitchProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function switchProgressSubscriberCount(): number {
  return listeners.size;
}

/** Test-only reset. */
export function __resetSwitchProgressForTests(): void {
  lastEvent = { stage: 'idle', at: new Date().toISOString() };
  listeners.clear();
}
