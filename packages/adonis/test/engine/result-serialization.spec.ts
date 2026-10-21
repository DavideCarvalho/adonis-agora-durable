import { WorkflowEngine } from '../../src/engine.js';
import type { RemoteTask, StepResult, Transport } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * Two results of one run handled at once on an instance must not run two turns of it at once. A
 * result resumes its run, and `execute` lets an instance into a lease it already holds, so a results
 * consumer with concurrency > 1 (`resultConcurrency`) would otherwise overlap the run's turns.
 */

class CapturingTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  result: ((r: StepResult) => Promise<void>) | undefined;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(): void {}
}

async function until(check: () => boolean | Promise<boolean>, max = 500): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

describe('step results of one run on one instance', () => {
  it('resume the run one at a time, so it never has two concurrent turns', async () => {
    const store = new InMemoryStateStore();
    const transport = new CapturingTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    let active = 0;
    let maxActive = 0;
    engine.register('pair', '1', async (ctx) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return await Promise.all([ctx.step<number>('ext.a', {}), ctx.step<number>('ext.b', {})]);
      } finally {
        active -= 1;
      }
    });

    await engine.start('pair', {}, 'r1');
    await until(() => transport.dispatched.length === 2);
    await until(async () => (await store.getRun('r1'))?.status === 'suspended');
    maxActive = 0;

    const deliver = (task: RemoteTask) =>
      transport.result?.({
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        status: 'completed',
        output: task.seq,
      });
    const [a, b] = transport.dispatched as [RemoteTask, RemoteTask];
    // The second result lands while the first one's turn holds the lease, mid-body.
    await deliver(a);
    await until(() => active === 1);
    await deliver(b);
    await until(async () => (await store.getRun('r1'))?.status === 'completed');

    expect((await store.getRun('r1'))?.output).toEqual([0, 1]);
    expect(maxActive).toBe(1);
  });
});

describe('timerBatchSize', () => {
  const batchOf = (timerBatchSize?: number): number =>
    (
      new WorkflowEngine({
        store: new InMemoryStateStore(),
        ...(timerBatchSize !== undefined ? { timerBatchSize } : {}),
      }) as unknown as { timerBatchSize: number }
    ).timerBatchSize;

  it('defaults to 500, the same as aviary, and floors a usable value', () => {
    expect(batchOf()).toBe(500);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 0.5]) {
      expect(batchOf(bad), String(bad)).toBe(500);
    }
    expect(batchOf(120.9)).toBe(120);
  });

  it('falls back to the default for a non-finite value, so due timers still resume', async () => {
    const store = new InMemoryStateStore();
    let now = 1_000;
    const engine = new WorkflowEngine({
      store,
      timerBatchSize: Number.NaN,
      reconcileMs: 0,
      clock: () => now,
    });
    engine.register('nap', '1', async (ctx) => {
      await ctx.sleep('1s');
      return 'awake';
    });

    await engine.start('nap', {}, 'r1');
    await until(async () => (await store.getRun('r1'))?.status === 'suspended');
    now += 2_000;
    await engine.resumeDueTimers();
    await until(async () => (await store.getRun('r1'))?.status === 'completed');
  });

  it('caps one pass at the batch size, most overdue first', async () => {
    const store = new InMemoryStateStore();
    let now = 1_000;
    const engine = new WorkflowEngine({
      store,
      timerBatchSize: 2,
      reconcileMs: 0,
      clock: () => now,
    });
    engine.register('nap', '1', async (ctx) => {
      await ctx.sleep('1s');
      return 'awake';
    });

    for (const id of ['r1', 'r2', 'r3']) {
      await engine.start('nap', {}, id);
      now += 10;
    }
    await until(async () => (await store.listDueTimers(Number.MAX_SAFE_INTEGER)).length === 3);
    now += 5_000;
    await engine.resumeDueTimers();
    await until(async () => (await store.getRun('r2'))?.status === 'completed');

    expect((await store.getRun('r1'))?.status).toBe('completed');
    expect((await store.getRun('r3'))?.status).toBe('suspended');
  });
});
