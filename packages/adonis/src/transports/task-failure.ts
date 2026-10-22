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
