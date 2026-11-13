import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { Heartbeat, RemoteTask, StepResult } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/** A transport under full manual control: dispatch parks the task; the test decides when (and
 *  whether) the "worker" replies. */
class ManualTransport {
  readonly tasks: RemoteTask[] = [];
  #onResult?: (r: StepResult) => Promise<void>;
  #onHeartbeat?: (b: Heartbeat) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.tasks.push(task);
  }
  onResult(h: (r: StepResult) => Promise<void>): void {
    this.#onResult = h;
  }
  onHeartbeat(h: (b: Heartbeat) => Promise<void>): void {
    this.#onHeartbeat = h;
  }
  async reply(r: StepResult): Promise<void> {
    await this.#onResult?.(r);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A result that arrives AFTER its run went terminal must never bring the run back to life.
 *
 * Observed in production: a run failed on liveness timeouts while its (healthy, just slow) worker
 * kept executing the dispatched batch; when the batch's result finally landed, the engine settled
 * the checkpoint and resumed the FAILED run — `failed` flipped to `suspended` and the workflow
 * carried on as if the failure never happened, racing whatever the operator had done about it.
 * Terminal is terminal: recovery belongs to an explicit `requeue`/`durable:runs:retry`.
 */
describe('late results for terminal runs', () => {
  async function failedRunWithLateWorker() {
    const store = new InMemoryStateStore();
    const transport = new ManualTransport();
    const engine = new WorkflowEngine({ store, transport: transport as never });
    engine.register('harvest', '1', async (ctx) => {
      await ctx.step('lote', {}, { timeoutMs: 40, retries: 1 });
      return 'done';
    });
    await engine.start('harvest', {}, 'run-late');
    const final = await engine.waitForRun('run-late', { terminal: true });
    expect(final.status).toBe('failed'); // liveness timeout, worker never picked up
    expect(transport.tasks.length).toBe(1);
    return { store, transport, engine, task: transport.tasks[0]! };
  }

  it('a late SUCCESS salvages the checkpoint but the run STAYS failed (no resurrection)', async () => {
    const { store, transport, task } = await failedRunWithLateWorker();

    await transport.reply({
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output: { ingeridas: 50 },
      startedAt: Date.now(),
    });
    await sleep(20); // the (would-be) resume is fire-and-forget — give it room to NOT happen

    // The finished work is kept: an explicit retry's replay short-circuits this step.
    const cp = await store.getCheckpoint('run-late', task.seq);
    expect(cp?.status).toBe('completed');
    expect(cp?.output).toEqual({ ingeridas: 50 });
    // But the run did not move: still failed, not revived into running/suspended/completed.
    expect((await store.getRun('run-late'))?.status).toBe('failed');
  });

  it('a REDELIVERED result for an already-settled checkpoint does not resume a terminal run', async () => {
    const { store, transport, task } = await failedRunWithLateWorker();
    const result: StepResult = {
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output: 'ok',
      startedAt: Date.now(),
    };
    await transport.reply(result); // settles the checkpoint (salvage path)
    await transport.reply(result); // at-least-once redelivery hits the settled-checkpoint branch
    await sleep(20);
    expect((await store.getRun('run-late'))?.status).toBe('failed');
  });

  it('a late FAILURE for a failed run is dropped outright (nothing to salvage)', async () => {
    const { store, transport, task } = await failedRunWithLateWorker();
    await transport.reply({
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'failed',
      error: { message: 'boom' },
      startedAt: Date.now(),
    });
    await sleep(20);
    const cp = await store.getCheckpoint('run-late', task.seq);
    expect(cp?.status).toBe('pending'); // untouched
    expect((await store.getRun('run-late'))?.status).toBe('failed');
  });
});
