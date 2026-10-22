import type {
  HistoryEvent,
  Transport,
  WorkflowDecision,
  WorkflowExecutor,
  WorkflowRun,
  WorkflowTask,
} from './interfaces.js';
import { runWorkflowTurn, type WorkflowBodyResolver } from './workflow-turn.js';

/**
 * A {@link WorkflowExecutor} backed by a {@link Transport}: it advances a remote workflow by
 * DISPATCHING a {@link WorkflowTask} over the broker under the ENGINE-SUPPLIED `taskId`, WITHOUT
 * awaiting the decision. Pass one to `engine.registerRemote(name, version, { group, executor })` so a
 * workflow authored in another SDK (e.g. the Python `durable-worker`) is driven over Redis/BullMQ.
 *
 * Multi-instance safe by construction: the executor holds NO in-memory state correlating a turn to its
 * decision. The engine records the `taskId` on the run as the awaited marker and releases the run lease
 * BEFORE calling {@link dispatch}; the worker's {@link WorkflowDecision} comes back over the transport's
 * `onDecision` and is applied durably (by run id) by whichever engine replica consumes it — even one
 * that did not dispatch the turn. A point-to-point decisions queue can therefore hand the decision to
 * any replica without it being dropped.
 *
 * Recovery-safe: when a decision is genuinely lost (the worker died mid-turn), the awaited turn's
 * liveness window (`remoteAdvanceSilenceMs` on the engine, or `timeoutMs` here; run-scoped heartbeats
 * rearm it) lapses and the timer poller re-dispatches a fresh turn with the same history — the
 * worker's replay is deterministic, so it returns the same decision, and a late decision for the old
 * `taskId` no longer matches the run's marker and is dropped.
 */
export class RemoteWorkflowExecutor implements WorkflowExecutor {
  #subscribed = false;
  /**
   * The executor's own liveness window for a dispatched turn, from `opts.timeoutMs`. It no longer fails
   * the run: a lapsed window re-drives the turn (see the class doc).
   */
  readonly decisionTimeoutMs: number | undefined;

  /**
   * @param group The worker group the turns are dispatched to — or a function of the run, for a
   *   group that depends on it (the engine's convention routing sends each run to the group of its own
   *   namespace, `<workflow>@<tenant>`).
   */
  constructor(
    private readonly transport: Transport,
    private readonly group: string | ((run: WorkflowRun) => string),
    opts: { timeoutMs?: number } = {},
  ) {
    this.decisionTimeoutMs = opts.timeoutMs || undefined;
  }

  /** Subscribe the engine's (stable) decision handler to this executor's transport, once. */
  subscribeDecisions(handler: (decision: WorkflowDecision) => Promise<void>): void {
    if (this.#subscribed || !this.transport.onDecision) return;
    this.#subscribed = true;
    this.transport.onDecision(handler);
  }

  /**
   * Enqueue one workflow turn under the engine-supplied `taskId`. Does NOT await the decision — the
   * engine has already suspended the run on `taskId` and applies the decision durably via `onDecision`.
   */
  async dispatch(
    run: WorkflowRun,
    history: HistoryEvent[],
    taskId: string,
    pendingSignals?: WorkflowTask['pendingSignals'],
  ): Promise<void> {
    if (!this.transport.dispatchWorkflowTask) {
      throw new Error('transport does not support workflow tasks (dispatchWorkflowTask)');
    }
    if (!this.transport.onDecision) {
      throw new Error('transport does not support workflow decisions (onDecision)');
    }
    const task: WorkflowTask = {
      taskId,
      runId: run.id,
      workflow: run.workflow,
      workflowVersion: run.workflowVersion,
      input: run.input,
      history,
      ...(pendingSignals ? { pendingSignals } : {}),
      group: typeof this.group === 'function' ? this.group(run) : this.group,
      priority: run.priority,
      attempt: 1,
    };
    await this.transport.dispatchWorkflowTask(task);
  }
}

/**
 * A {@link WorkflowExecutor} that advances a workflow turn IN-PROCESS through the shared, pure
 * {@link runWorkflowTurn} body — no broker, no store. It is the store-backed engine's counterpart to
 * the store-less {@link import('./worker-runtime/worker-runtime.js').WorkerRuntime}'s workflow path:
 * BOTH drive a TS workflow turn through the exact same replay code (design §4 — "shared step/workflow
 * execution stays in the shared body"), so a turn body verified through the engine behaves identically
 * on a thin worker. Pass one to `engine.registerRemote(name, version, { group, executor })` to run a
 * polyglot-style TS workflow (authored against {@link import('./workflow-turn.js').WorkflowTurnCtx})
 * with the engine owning durability/recovery/timers and this owning only the deterministic replay.
 *
 * Recovery-safe for the same reason {@link RemoteWorkflowExecutor} is: the engine re-drives a turn with
 * the same history, and the replay is deterministic, so it produces the same decision.
 */
export class LocalWorkflowTurnExecutor implements WorkflowExecutor {
  #counter = 0;

  constructor(
    private readonly bodies: WorkflowBodyResolver,
    private readonly opts: { group?: string; partition?: string } = {},
  ) {}

  async advance(
    run: WorkflowRun,
    history: HistoryEvent[],
    pendingSignals?: WorkflowTask['pendingSignals'],
  ): Promise<WorkflowDecision> {
    this.#counter += 1;
    const task: WorkflowTask = {
      taskId: `${run.id}:wf:${this.#counter}`,
      runId: run.id,
      workflow: run.workflow,
      workflowVersion: run.workflowVersion,
      input: run.input,
      history,
      ...(pendingSignals ? { pendingSignals } : {}),
      group: this.opts.group ?? '',
      ...(run.priority !== undefined ? { priority: run.priority } : {}),
      attempt: 1,
    };
    return runWorkflowTurn(this.bodies, task, {
      ...(this.opts.partition !== undefined ? { partition: this.opts.partition } : {}),
    });
  }
}
