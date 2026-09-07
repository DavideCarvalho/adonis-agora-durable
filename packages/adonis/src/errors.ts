import { CONTROL_FLOW_SIGNAL, type isWorkflowControlFlowSignal } from './control-flow-signal.js';

/**
 * Thrown inside a step to signal an unrecoverable failure: the engine will NOT retry it,
 * regardless of the step's `retries` setting, and fails the run immediately. Use it for
 * business errors that retrying cannot fix (e.g. a declined card, invalid input).
 */
export class FatalError extends Error {
  readonly code?: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'FatalError';
    this.code = code;
  }
}

/**
 * Thrown by `start` when a singleton workflow's wait queue is full: the count of in-flight + gated
 * runs sharing the key already equals `limit + maxQueueDepth`, so admitting another would let the
 * same-key backlog grow unbounded. Back-pressure — the caller should retry later or shed load. Only
 * raised when {@link SingletonConfig.maxQueueDepth} is set (omit it for the old unbounded behavior).
 */
export class SingletonQueueFullError extends Error {
  readonly workflow: string;
  readonly key: string;
  readonly maxQueueDepth: number;
  constructor(workflow: string, key: string, maxQueueDepth: number) {
    super(
      `singleton queue for ${workflow} key "${key}" is full (maxQueueDepth=${maxQueueDepth}); retry later`,
    );
    this.name = 'SingletonQueueFullError';
    this.workflow = workflow;
    this.key = key;
    this.maxQueueDepth = maxQueueDepth;
  }
}

/**
 * Internal control signal thrown to suspend a run (e.g. on a durable sleep). Not an error the
 * user should throw or catch; the engine uses it to stop execution and persist `wakeAt`.
 */
export class SignalTimeoutError extends Error {
  readonly token: string;
  readonly timeoutMs: number;
  constructor(token: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for signal "${token}"`);
    this.name = 'SignalTimeoutError';
    this.token = token;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when a remote step produces no result and no heartbeat within its `timeoutMs` window —
 * i.e. the worker is presumed dead. Subject to the step's `retries` (it's retryable), so the engine
 * re-dispatches before giving up.
 */
export class RemoteStepTimeout extends Error {
  readonly stepId: string;
  readonly timeoutMs: number;
  constructor(stepId: string, timeoutMs: number) {
    super(`remote step ${stepId} produced no result/heartbeat within ${timeoutMs}ms`);
    this.name = 'RemoteStepTimeout';
    this.stepId = stepId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown on resume when the workflow code no longer matches the recorded history: the step at a
 * logical position has a different name/kind than the checkpoint saved there. This means the
 * workflow definition changed (a step was added/removed/reordered) under an in-flight run without a
 * new workflow version — continuing would replay the wrong checkpoint into the wrong step and
 * silently corrupt the run, so the engine fails loudly instead. Register a new workflow version for
 * breaking changes (old runs finish on the version they started on).
 */
export class NonDeterminismError extends Error {
  readonly runId: string;
  readonly seq: number;
  constructor(runId: string, seq: number, expected: string, recorded: string) {
    super(
      `non-determinism at ${runId}#${seq}: code expects "${expected}" but history recorded ` +
        `"${recorded}". The workflow changed under an in-flight run — register a new workflow version.`,
    );
    this.name = 'NonDeterminismError';
    this.runId = runId;
    this.seq = seq;
  }
}

/**
 * Thrown by `ctx.all` when one or more parallel child workflows fail. Carries the per-item failures
 * (input index, child run id, error message) and presents an aggregate message summarizing the count
 * and the failing ids — the wait-all/fail-fast counterpart to a single child's FatalError. Mirrors
 * the Python SDK's `GatherFailed`.
 */
export class GatherError extends Error {
  readonly failures: { index: number; id: string; error: string }[];
  constructor(failures: { index: number; id: string; error: string }[], total?: number) {
    const ids = failures.map((f) => f.id).join(', ');
    const denom = total ?? failures.length;
    super(`ctx.all: ${failures.length} of ${denom} child(ren) failed: ${ids}`);
    this.name = 'GatherError';
    this.failures = failures;
  }
}

export class WorkflowSuspended extends Error {
  /** Epoch ms to auto-resume (durable sleep), or undefined when waiting on an external signal. */
  readonly wakeAt?: number | undefined;
  /**
   * The checkpoint seq(s) this suspension is parked on (a signal/event/child wait's waiter seq, a
   * dispatched remote step's seq). Lets the settle path close the lost-wake race: a delivery that
   * landed WHILE the turn was still executing wrote the checkpoint but its resume no-oped against
   * the held lease — after suspending, the engine re-checks these seqs and re-drives if one already
   * completed. Optional: a suspension without it just relies on the reconcile fallback as before.
   */
  readonly waitSeqs?: number[] | undefined;
  /** Marks this as a control-flow signal — see {@link isWorkflowControlFlowSignal}. */
  readonly [CONTROL_FLOW_SIGNAL] = true;
  constructor(wakeAt?: number, waitSeqs?: number[]) {
    super('workflow suspended');
    this.name = 'WorkflowSuspended';
    this.wakeAt = wakeAt;
    this.waitSeqs = waitSeqs;
  }
}

/**
 * Thrown by `ctx.continueAsNew(input)` to end the current run and hand off to a fresh execution of
 * the same workflow with a clean history — for long-running / looping workflows that would otherwise
 * accumulate unbounded checkpoints. The engine completes this run and starts the next one.
 */
export class ContinueAsNew extends Error {
  /** Marks this as a control-flow signal — see {@link isWorkflowControlFlowSignal}. */
  readonly [CONTROL_FLOW_SIGNAL] = true;
  constructor(readonly input: unknown) {
    super('workflow continued as new');
    this.name = 'ContinueAsNew';
  }
}
