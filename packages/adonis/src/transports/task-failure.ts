import type { StepResult } from '../interfaces.js';

/** The fields a step result is correlated by (a {@link StepResult} carries no step `name`). */
export interface TaskIdentity {
  runId: string;
  seq: number;
  stepId: string;
}

/**
 * Narrow a FAILED task job's payload to the {@link import('../interfaces.js').RemoteTask} fields the
 * terminal-failure bridge needs (runId/seq/stepId), WITHOUT an unsafe cast. Returns `undefined` for a
 * payload the broker has already GC'd, a malformed job, or a workflow-turn job (no step identity) —
 * so the bridge safely no-ops instead of publishing a bogus result.
 */
export function failedTaskIdentity(data: unknown): TaskIdentity | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  if (!('runId' in data) || !('seq' in data) || !('stepId' in data)) return undefined;
  const { runId, seq, stepId } = data as Record<string, unknown>;
  if (typeof runId !== 'string' || typeof seq !== 'number' || typeof stepId !== 'string') {
    return undefined;
  }
  return { runId, seq, stepId };
}

/**
 * The synthetic FAILED {@link StepResult} a transport publishes for a task that failed at the
 * infrastructure level (a worker crash, stalled-count exhaustion) — no handler ever produced a result,
 * so without it the run would wait on its `pending` checkpoint forever. RETRYABLE, so the engine's
 * durable retry re-dispatches while the step has attempts left and fails the step after that.
 */
export function infrastructureFailure(identity: TaskIdentity, reason: string): StepResult {
  return {
    runId: identity.runId,
    seq: identity.seq,
    stepId: identity.stepId,
    status: 'failed',
    error: { message: `remote step worker failed: ${reason}`, retryable: true },
  };
}

/**
 * Hand `decision` to every `onDecision` handler and wait for ALL of them to settle before reporting.
 * With `Promise.all` the carrier failed (and redelivered) the job the moment the first handler
 * rejected, while the others were still running, so the redelivery ran them again concurrently with
 * themselves, and only that first failure was ever reported. Each failure but the first goes to
 * `onError`; the first is rethrown so the carrier reports it and redelivers the decision, which is
 * safe: the engine applies a decision at most once, fenced by its task id.
 */
export async function fanOutDecision<D>(
  handlers: Iterable<(decision: D) => Promise<void>>,
  decision: D,
  onError: (err: unknown) => void,
): Promise<void> {
  const settled = await Promise.allSettled([...handlers].map((h) => h(decision)));
  const failures = settled.flatMap((s) => (s.status === 'rejected' ? [s.reason] : []));
  if (failures.length === 0) return;
  for (const err of failures.slice(1)) onError(err);
  throw failures[0];
}
