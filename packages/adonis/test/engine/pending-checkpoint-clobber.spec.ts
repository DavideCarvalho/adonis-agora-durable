import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { RemoteTask, StepCheckpoint, StepResult, Transport } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * REGRESSION: a turn that stamps a pending step's redispatch deadline must not put a result that
 * landed meanwhile back to `pending`.
 *
 * The turn reads the step `pending`, the worker's result saves it `completed`, then the turn writes
 * `{ ...pendingRow, wakeAt }`. With a blind save, the step is `pending` again with no result, and the
 * run is parked until the deadline, where the step runs a second time. A wide `ctx.all` on six
 * workers left ~4k children in exactly that state. The store below lands the result between the
 * turn's read and its write.
 */

const PING = 'ext.ping';

class ResultBeforeStampStore extends InMemoryStateStore {
  landResult: (() => Promise<void>) | undefined;

  override async saveCheckpointIfPending(checkpoint: StepCheckpoint): Promise<boolean> {
    if (checkpoint.status === 'pending' && checkpoint.wakeAt != null && this.landResult) {
      const land = this.landResult;
      this.landResult = undefined;
      await land();
    }
    return super.saveCheckpointIfPending(checkpoint);
  }
}

class HeldTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  result?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(): void {}
}

describe('REGRESSION: a redispatch stamp racing the step result', () => {
  it('keeps the landed result and completes the run without re-running the step', async () => {
    let now = 1_000_000;
    const store = new ResultBeforeStampStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({
      store,
      transports: [{ id: 't', transport }],
      clock: () => now,
      reconcileMs: 0,
      remoteRedispatchMs: 60_000,
    });
    engine.register('wf', '1', async (ctx) => ctx.step<{ pong: boolean }>(PING, {}));

    await startRun(engine, 'wf', {}, 'r1');
    const task = transport.dispatched[0];
    if (!task) throw new Error('expected a dispatched task');

    // The result lands while the next turn sits between reading the step and stamping it. Its own
    // resume finds that turn's lease and is dropped, as it is in production.
    store.landResult = async () => {
      await store.saveCheckpoint({
        ...((await store.getCheckpoint('r1', task.seq)) as StepCheckpoint),
        status: 'completed',
        output: { pong: true },
      });
    };
    now += 1;
    await engine.runOne('r1');

    const cp = await store.getCheckpoint('r1', task.seq);
    expect(cp?.status).toBe('completed');
    expect(cp?.output).toEqual({ pong: true });
    const run = await store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toEqual({ pong: true });
    expect(transport.dispatched).toHaveLength(1);
  });

  it('drops a duplicate delivery of a result that already settled the step', async () => {
    const store = new InMemoryStateStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({ store, transports: [{ id: 't', transport }] });
    const completed: (number | undefined)[] = [];
    engine.subscribe((e) => {
      if (e.type === 'step.completed') completed.push(e.seq);
    });
    engine.register('wf', '1', async (ctx) => ctx.step<{ n: number }>(PING, {}));

    await startRun(engine, 'wf', {}, 'r1');
    const task = transport.dispatched[0];
    if (!task) throw new Error('expected a dispatched task');
    const deliver = (n: number) =>
      transport.result?.({
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        status: 'completed',
        output: { n },
      });
    await Promise.all([deliver(1), deliver(2)]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(completed).toHaveLength(1);
    expect((await store.getRun('r1'))?.status).toBe('completed');
  });
});
