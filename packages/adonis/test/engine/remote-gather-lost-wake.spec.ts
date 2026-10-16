import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  Heartbeat,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowRun,
  WorkflowTask,
} from '../../src/interfaces.js';
import { RemoteWorkflowExecutor } from '../../src/remote-workflow-executor.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * REGRESSION: a remote turn must not park a run on blocking ops that have ALREADY settled.
 *
 * A turn is computed from a SNAPSHOT of history, and the ops it declares can all have settled while
 * its decision was in flight. The canonical case is a `gather_calls` fan-out whose LAST call lands
 * while the turn holding the run lease is still deciding: that call runs `completeRemoteResult` ->
 * `resume` -> `execute`, `execute` finds the lease contended and returns silently —
 *
 *     if (!(await this.store.tryLockRun(...))) {
 *       return { runId: run.id, status: run.status };   // no retry, no reschedule
 *     }
 *
 * — so the call's wake is spent with nothing to show for it, and the decision then parks the run on
 * a `call` that is already complete. Every call is settled, nothing holds the lease, and nothing is
 * scheduled to wake it: the run sits `suspended` until the `reconcileMs` orphan sweep re-drives it,
 * minutes later.
 *
 * Rather than re-race the scheduler, this reproduces the STATE that race produces: the worker
 * returns one decision that re-emits a call whose checkpoint has already completed. The engine must
 * notice it has nothing left to wait for and re-drive, instead of parking. `reconcileMs: 0`
 * disables the orphan sweep, so what is asserted is the wake itself and not the safety net.
 *
 * Traced in the NestJS sibling against a real broker + database driving a remote worker, this
 * stalled 23% of a seven-call fan-out's runs for 301 seconds each.
 */

const FAN = 3;
const GROUP = 'proc';

/**
 * A transport that carries workflow TURNS as well as steps, point to point: the engine's task goes
 * to a served handler, and the decision comes back on the decisions channel. The bundled
 * `InMemoryTransport` carries steps only, which is why this lives here.
 */
class DecisionTransport implements Transport {
  private steps = new Map<string, (input: unknown) => Promise<unknown>>();
  private serve?: (task: WorkflowTask) => WorkflowDecision;
  private results: ((result: StepResult) => Promise<void>)[] = [];
  private decisions: ((decision: WorkflowDecision) => Promise<void>)[] = [];

  handle(name: string, fn: (input: never) => Promise<unknown>): void {
    this.steps.set(name, fn as (input: unknown) => Promise<unknown>);
  }

  serveWorkflow(fn: (task: WorkflowTask) => WorkflowDecision): void {
    this.serve = fn;
  }

  async dispatch(task: RemoteTask): Promise<void> {
    const handler = this.steps.get(task.name);
    // On a macrotask, like a broker: the engine must have finished suspending before a result lands.
    setTimeout(() => {
      void (async () => {
        const output = handler === undefined ? null : await handler(task.input as never);
        for (const onResult of this.results) {
          await onResult({
            runId: task.runId,
            seq: task.seq,
            stepId: task.stepId,
            status: 'completed',
            output,
          } as StepResult);
        }
      })();
    }, 0);
  }

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.results.push(handler);
  }

  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    const decide = this.serve;
    if (decide === undefined) return;
    const decision = decide(task);
    setTimeout(() => {
      void (async () => {
        for (const onDecision of this.decisions) await onDecision(decision);
      })();
    }, 0);
  }

  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decisions.push(handler);
  }
}

/** Poll until the run leaves the states a live run passes through. */
async function settle(store: InMemoryStateStore, runId: string, max = 200): Promise<WorkflowRun> {
  for (let attempt = 0; attempt < max; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended' && run.status !== 'pending') {
      return run;
    }
  }
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run ${runId} missing`);
  return run;
}

describe('REGRESSION: a remote turn parked on already-settled ops must be re-driven', () => {
  it('a stale gather decision does not orphan the run — it completes without the reconcile sweep', async () => {
    const store = new InMemoryStateStore();
    const transport = new DecisionTransport();
    for (let i = 0; i < FAN; i += 1) {
      transport.handle(`leaf_${i}`, async () => ({ r: i }));
    }

    // One stale decision, delivered on the turn where every call HAS settled: it re-emits the last
    // call, as a turn computed a moment earlier would have. This is the decision the dropped-wake
    // race makes the engine apply.
    let staleServed = false;
    transport.serveWorkflow((task: WorkflowTask): WorkflowDecision => {
      const seen = new Set(task.history.map((event) => event.seq));
      const base = { taskId: task.taskId, runId: task.runId } as const;
      const missing = Array.from({ length: FAN }, (_, seq) => seq).filter((seq) => !seen.has(seq));

      if (missing.length === 0 && !staleServed) {
        staleServed = true;
        return {
          ...base,
          status: 'continue',
          commands: [
            {
              kind: 'call' as const,
              seq: FAN - 1,
              name: `leaf_${FAN - 1}`,
              group: 'steps',
              input: { i: FAN - 1 },
              parallelGroup: 'gather:0',
            },
          ],
        } as WorkflowDecision;
      }
      if (missing.length > 0) {
        return {
          ...base,
          status: 'continue',
          commands: missing.map((seq) => ({
            kind: 'call' as const,
            seq,
            name: `leaf_${seq}`,
            group: 'steps',
            input: { i: seq },
            parallelGroup: 'gather:0',
          })),
        } as WorkflowDecision;
      }
      return {
        ...base,
        status: 'completed',
        commands: [],
        output: { fan: FAN },
      } as WorkflowDecision;
    });

    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    engine.registerRemote('proc', '1', {
      group: GROUP,
      executor: new RemoteWorkflowExecutor(transport, GROUP),
    });

    await engine.start('proc', {}, 'run1');
    const run = await settle(store, 'run1');

    // Without the re-drive this sits `suspended` — every call settled, nothing holding the lease,
    // nothing scheduled to wake it — until the orphan sweep, which `reconcileMs: 0` turns off.
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ fan: FAN });
  });
});
