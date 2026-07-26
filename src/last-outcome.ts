// Records the most recent outcome of each mutating operation (version switch,
// self-update, doctor-update). These flows report progress only as transient
// SSE events (switch-progress-broker) and a return value the caller may
// discard — there is no queryable "did the last self-update fail?" state. The
// updater-status route (and the plugin notifications that mirror it) need a
// durable signal, so we cache the last result per operation here. Module-level
// state is fine: the updater process owns these flows (the mutex serializes
// them across the updater and doctor containers).

export type OutcomeOperation = 'switch' | 'self-update' | 'doctor-update';

export interface OperationOutcome {
  operation: OutcomeOperation;
  ok: boolean;
  at: string; // ISO8601
  from?: string;
  to?: string;
  /** Failure detail (categorized userMessage / SwitchResult.error). */
  error?: string;
}

const outcomes = new Map<OutcomeOperation, OperationOutcome>();

/** Record the outcome of a just-completed operation. Timestamp is stamped
 *  here so callers don't have to. */
export function recordOutcome(o: Omit<OperationOutcome, 'at'> & { at?: string }): void {
  outcomes.set(o.operation, {
    ...o,
    at: o.at ?? new Date().toISOString(),
  });
}

/** All recorded outcomes, newest-per-operation. Empty until an operation runs. */
export function getLastOutcomes(): OperationOutcome[] {
  return [...outcomes.values()];
}

/** The last outcome for one operation, or undefined if it hasn't run. */
export function getLastOutcome(op: OutcomeOperation): OperationOutcome | undefined {
  return outcomes.get(op);
}

/** Test-only: clear recorded outcomes between cases. */
export function __resetOutcomesForTests(): void {
  outcomes.clear();
}
