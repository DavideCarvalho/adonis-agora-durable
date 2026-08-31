import type {
  HistoryEvent,
  Transport,
  WorkflowDecision,
  WorkflowExecutor,
  WorkflowRun,
  WorkflowTask,
} from './interfaces.js';
import { runWorkflowTurn, type WorkflowBodyResolver } from './workflow-turn.js';

let taskCounter = 0;

/**
 * A {@link WorkflowExecutor} backed by a {@link Transport}: it advances a remote workflow by
 * dispatching a {@link WorkflowTask} over the broker and awaiting the matching {@link WorkflowDecision}
 * (correlated by `taskId`). Pass one to `engine.registerRemote(name, version, { group, executor })` so
 * a workflow authored in another SDK (e.g. the Python `durable-worker`) is driven over Redis/BullMQ.
 *
 * Recovery-safe: if the engine crashes awaiting a decision, the re-drive dispatches a fresh task with
 * the same history — the worker's replay is deterministic, so it returns the same decision; a late
 * decision for the old `taskId` simply finds no waiter and is dropped.
 */
export class RemoteWorkflowExecutor implements WorkflowExecutor {
  private readonly pending = new Map<string, (decision: WorkflowDecision) => void>();
  private subscribed = false;

  constructor(
    private readonly transport: Transport,
    private readonly group: string,
    private readonly opts: { timeoutMs?: number } = {},
  ) {}

  private ensureSubscribed(): void {
    if (this.subscribed) return;
    if (!this.transport.onDecision) {
      throw new Error('transport does not support workflow decisions (onDecision)');
    }
    this.subscribed = true;
    this.transport.onDecision(async (decision) => {
      const resolve = this.pending.get(decision.taskId);
      if (resolve) {
        this.pending.delete(decision.taskId);
        resolve(decision);
      }
    });
  }

  async advance(run: WorkflowRun, history: HistoryEvent[]): Promise<WorkflowDecision> {
    if (!this.transport.dispatchWorkflowTask) {
      throw new Error('transport does not support workflow tasks (dispatchWorkflowTask)');
    }
    this.ensureSubscribed();
    taskCounter += 1;
    const taskId = `${run.id}:wf:${taskCounter}`;
    const task: WorkflowTask = {
      taskId,
      runId: run.id,
      workflow: run.workflow,
      workflowVersion: run.workflowVersion,
      input: run.input,
      history,
      group: this.group,
      priority: run.priority,
      attempt: 1,
    };
    const decision = new Promise<WorkflowDecision>((resolve, reject) => {
      this.pending.set(taskId, resolve);
      if (this.opts.timeoutMs) {
        const timer = setTimeout(() => {
          this.pending.delete(taskId);
          reject(new Error(`workflow task ${taskId} timed out after ${this.opts.timeoutMs}ms`));
        }, this.opts.timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }
    });
    await this.transport.dispatchWorkflowTask(task);
    return decision;
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
