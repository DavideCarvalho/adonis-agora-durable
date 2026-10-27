import type { Database } from '@adonisjs/lucid/database';
import { afterEach } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  RemoteTask,
  StateStore,
  StepCheckpoint,
  StepResult,
  StepSettlement,
  Transport,
} from '../../src/interfaces.js';
import { DURABLE_STEP_NAME, type StepRef } from '../../src/step-name-symbol.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { dbBackends } from '../support/backends.js';

/**
 * A run's step results that land together (a results consumer with `resultConcurrency > 1`, a wide
 * fan) are settled in batches: one `settleCheckpointsIfPending` per batch, the fan's barrier asked once,
 * and one resume — instead of a conditional UPDATE, a barrier count and a replay per result. What
 * must not change: each step settles once, a duplicate is dropped, a failure still wakes the run, and
 * a result resolves only after its own write committed.
 */

const LINE = 'lines.process';
const processLine = (() => {}) as unknown as StepRef<{ i: number }, number>;
(processLine as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = LINE;

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

async function until(check: () => boolean | Promise<boolean>, max = 1000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

/** Wraps a store, counting the settle calls the engine makes (and optionally sabotaging one). */
function instrument(store: StateStore) {
  const calls = { batch: [] as number[], single: 0 };
  const batch = store.saveCheckpointsIfPending?.bind(store);
  const single = store.saveCheckpointIfPending?.bind(store);
  const settle = store.settleCheckpointsIfPending?.bind(store);
  const wrapped = Object.create(store) as StateStore;
  if (settle) {
    wrapped.settleCheckpointsIfPending = async (settlements: StepSettlement[]) => {
      if (settlements.length === 1) calls.single += 1;
      else calls.batch.push(settlements.length);
      return settle(settlements);
    };
  }
  if (batch) {
    wrapped.saveCheckpointsIfPending = async (cps: StepCheckpoint[]) => {
      calls.batch.push(cps.length);
      return batch(cps);
    };
  }
  if (single) {
    wrapped.saveCheckpointIfPending = async (cp: StepCheckpoint) => {
      calls.single += 1;
      return single(cp);
    };
  }
  return { store: wrapped, calls };
}

const result = (task: RemoteTask, over: Partial<StepResult> = {}): StepResult => ({
  runId: task.runId,
  seq: task.seq,
  stepId: task.stepId,
  status: 'completed',
  output: (task.input as { i: number }).i * 10,
  ...over,
});

async function fanRun(store: StateStore, n: number) {
  const transport = new CapturingTransport();
  const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
  let turns = 0;
  engine.register('fan', '1', async (ctx) => {
    turns += 1;
    return ctx.all(
      processLine,
      Array.from({ length: n }, (_, i) => ({ i })),
    );
  });
  await engine.start('fan', {}, 'p');
  await until(() => transport.dispatched.length === n);
  await until(async () => (await store.getRun('p'))?.status === 'suspended');
  return { engine, transport, turns: () => turns };
}

/** Lucid databases opened by a test, closed after it (a Postgres one drops its schema on close). */
const opened: Database[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()?.manager.closeAll();
});

const stores: Array<[string, () => Promise<StateStore>]> = [
  ['in-memory', async () => new InMemoryStateStore()],
  ...dbBackends().map((backend): [string, () => Promise<StateStore>] => [
    `lucid (${backend.name})`,
    async () => {
      const db = await backend.makeStoreDb();
      opened.push(db);
      return new LucidStateStore(db);
    },
  ]),
];

describe.each(stores)('batched step results (%s)', (_label, makeStore) => {
  it('settles results that land together in one batched write and resumes once', async () => {
    const { store, calls } = instrument(await makeStore());
    const { transport, turns } = await fanRun(store, 20);
    const before = turns();

    // Delivered concurrently, like a results consumer with resultConcurrency: 20.
    await Promise.all(transport.dispatched.map((task) => transport.result?.(result(task))));
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual(Array.from({ length: 20 }, (_, i) => i * 10));
    // The first result starts a batch of one; everything that landed meanwhile is the next batch.
    expect(calls.batch.length).toBeGreaterThanOrEqual(1);
    expect(calls.batch.reduce((a, b) => a + b, 0) + calls.single).toBe(20);
    expect(Math.max(...calls.batch)).toBeGreaterThan(1);
    // One replay for the settled fan, not one per result.
    expect(turns() - before).toBeLessThanOrEqual(2);
  });

  it('drops a duplicate in the same batch and settles each step once', async () => {
    const { store, calls } = instrument(await makeStore());
    const { transport } = await fanRun(store, 4);
    const tasks = transport.dispatched;
    const first = tasks[0] as RemoteTask;
    await Promise.all([
      ...tasks.map((task) => transport.result?.(result(task))),
      transport.result?.(result(first, { output: 'duplicate' })),
    ]);
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual([0, 10, 20, 30]);
    expect(calls.batch.reduce((a, b) => a + b, 0) + calls.single).toBe(4);
  });

  it('wakes the run on a failure inside a batch', async () => {
    const { store } = instrument(await makeStore());
    const { transport } = await fanRun(store, 6);
    await Promise.all(
      transport.dispatched.map((task, i) =>
        transport.result?.(
          i === 3
            ? result(task, { status: 'failed', error: { message: 'bad line' } })
            : result(task),
        ),
      ),
    );
    await until(async () => (await store.getRun('p'))?.status === 'failed');
    expect((await store.getRun('p'))?.error?.message).toContain('1 of 6');
  });
});

describe('batched step results — fallbacks', () => {
  it('a store without saveCheckpointsIfPending settles each result with its own write', async () => {
    const inner = new InMemoryStateStore();
    // Shadow the methods with `undefined`, as a store that never implemented them.
    const store = Object.create(inner, {
      saveCheckpointsIfPending: { value: undefined },
      settleCheckpointsIfPending: { value: undefined },
    }) as StateStore;
    const { store: counted, calls } = instrument(store);
    const { transport } = await fanRun(counted, 8);
    await Promise.all(transport.dispatched.map((task) => transport.result?.(result(task))));
    await until(async () => (await inner.getRun('p'))?.status === 'completed');
    expect(calls.batch).toEqual([]);
    expect((await inner.getRun('p'))?.output).toEqual(Array.from({ length: 8 }, (_, i) => i * 10));
  });

  it('a rejected settle of a batch is retried row by row, and one bad row fails only its own result', async () => {
    const inner = new InMemoryStateStore();
    const store = Object.create(inner) as StateStore;
    const settle = inner.settleCheckpointsIfPending.bind(inner);
    let poisoned = true;
    store.settleCheckpointsIfPending = async (settlements) => {
      if (settlements.length > 1) throw new Error('batch settle rejected');
      if (settlements[0]?.seq === 2 && poisoned) {
        poisoned = false;
        throw new Error('row 2 rejected');
      }
      return settle(settlements);
    };
    const { transport } = await fanRun(store, 5);
    const outcomes = await Promise.allSettled(
      transport.dispatched.map((task) => transport.result?.(result(task))),
    );
    const rejected = outcomes.flatMap((o, i) => (o.status === 'rejected' ? [i] : []));
    expect(rejected).toEqual([2]);
    expect((await inner.getCheckpoint('p', 2))?.status).toBe('pending');
    await transport.result?.(result(transport.dispatched[2] as RemoteTask));
    await until(async () => (await inner.getRun('p'))?.status === 'completed');
    expect((await inner.getRun('p'))?.output).toEqual([0, 10, 20, 30, 40]);
  });

  it('a rejected batch write is retried row by row, and one bad row fails only its own result', async () => {
    const inner = new InMemoryStateStore();
    const store = Object.create(inner, {
      settleCheckpointsIfPending: { value: undefined },
    }) as StateStore;
    store.saveCheckpointsIfPending = async () => {
      throw new Error('batch write rejected');
    };
    const single = inner.saveCheckpointIfPending.bind(inner);
    let poisoned = true;
    store.saveCheckpointIfPending = async (cp) => {
      if (cp.seq === 2 && poisoned) {
        poisoned = false;
        throw new Error('row 2 rejected');
      }
      return single(cp);
    };
    const { transport } = await fanRun(store, 5);
    const outcomes = await Promise.allSettled(
      transport.dispatched.map((task) => transport.result?.(result(task))),
    );
    const rejected = outcomes.flatMap((o, i) => (o.status === 'rejected' ? [i] : []));
    // Only the bad row's delivery fails (the transport would redeliver it).
    expect(rejected).toEqual([2]);
    expect((await inner.getCheckpoint('p', 2))?.status).toBe('pending');
    // The redelivery settles it and the fan completes.
    await transport.result?.(result(transport.dispatched[2] as RemoteTask));
    await until(async () => (await inner.getRun('p'))?.status === 'completed');
    expect((await inner.getRun('p'))?.output).toEqual([0, 10, 20, 30, 40]);
  });
});
