import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { StateStore, WorkflowRun } from '../../src/interfaces.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { makeStoreDb } from '../../src/stores/lucid-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

const run = (over: Partial<WorkflowRun> & { id: string }): WorkflowRun => ({
  workflow: 'wf',
  workflowVersion: '1',
  status: 'completed',
  input: {},
  createdAt: new Date(1_000),
  updatedAt: new Date(1_000),
  ...over,
});

/** Count `deleteRuns` / `deleteRun` calls on a store. */
function counting(store: StateStore, withBatch = true) {
  const calls = { batches: [] as string[][], single: 0 };
  const view = Object.create(store, {
    deleteRuns: {
      value: withBatch
        ? async (ids: string[]) => {
            calls.batches.push([...ids]);
            await store.deleteRuns?.(ids);
          }
        : undefined,
    },
    deleteRun: {
      value: async (id: string) => {
        calls.single += 1;
        await store.deleteRun(id);
      },
    },
  }) as StateStore;
  return { store: view, calls };
}

/** A parent with one spawned child (its edge is a `spawn:` checkpoint). */
async function parentWithChild(store: StateStore, id: string, extra: Partial<WorkflowRun> = {}) {
  await store.createRun(run({ id, ...extra }));
  await store.createRun(run({ id: `${id}-child`, ...extra }));
  await store.saveCheckpoint({
    runId: id,
    seq: 0,
    name: `spawn:${id}-child`,
    kind: 'local',
    stepId: `${id}:0`,
    status: 'completed',
    output: `${id}-child`,
    attempts: 1,
    enqueuedAt: new Date(1_000),
    startedAt: new Date(1_000),
    finishedAt: new Date(1_000),
  });
}

describe.each([
  ['in-memory', async () => new InMemoryStateStore() as StateStore],
  ['lucid (sqlite)', async () => new LucidStateStore(await makeStoreDb()) as StateStore],
])('bulk deletes through StateStore.deleteRuns (%s)', (_label, makeStore) => {
  it('purgeRuns deletes a page of runs, children first, with one deleteRuns call', async () => {
    const { store, calls } = counting(await makeStore());
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    for (const id of ['a', 'b']) await parentWithChild(store, id, { namespace: 'acme' });
    await store.createRun(run({ id: 'other', namespace: 'globex' }));

    expect(await engine.purgeRuns({ namespace: 'acme' })).toBe(4);
    expect(calls.single).toBe(0);
    expect(calls.batches).toHaveLength(1);
    const [batch] = calls.batches as [string[]];
    expect([...batch].sort()).toEqual(['a', 'a-child', 'b', 'b-child']);
    expect(batch.indexOf('a-child')).toBeLessThan(batch.indexOf('a'));
    expect((await store.listRuns({})).map((r) => r.id)).toEqual(['other']);
  });

  it('the retention sweep deletes its pass in one batch, subtrees included', async () => {
    const { store, calls } = counting(await makeStore());
    const engine = new WorkflowEngine({
      store,
      transport: new InMemoryTransport(),
      clock: () => 100_000,
      retention: { completed: 10_000 },
    });
    await parentWithChild(store, 'old');
    await store.createRun(run({ id: 'fresh', updatedAt: new Date(99_000) }));
    // The child is younger than the cutoff, but goes with its parent (the cascade deleteRun had).
    await store.updateRun('old-child', { updatedAt: new Date(99_500) });

    expect(await engine.sweepRetention()).toBe(2);
    expect(calls.single).toBe(0);
    expect(calls.batches.map((b) => [...b].sort())).toEqual([['old', 'old-child']]);
    expect((await store.listRuns({})).map((r) => r.id)).toEqual(['fresh']);
  });

  it('a store without deleteRuns gets one deleteRun per run', async () => {
    const { store, calls } = counting(await makeStore(), false);
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    await parentWithChild(store, 'a', { namespace: 'acme' });
    expect(await engine.purgeRuns({ namespace: 'acme' })).toBe(2);
    expect(calls.single).toBe(2);
    expect(await store.listRuns({})).toEqual([]);
  });
});

describe('eventBufferTtlMs', () => {
  it('an expired buffered event is never delivered, and the retention pass prunes it', async () => {
    let now = 1_000_000;
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      transport: new InMemoryTransport(),
      clock: () => now,
      eventBufferTtlMs: 60_000,
      reconcileMs: 0,
    });
    engine.register('waiter', '1', async (ctx) =>
      ctx.waitForEvent<{ n: number }>('order.paid', { timeoutMs: 1_000 }),
    );
    // Nobody waits yet: both are buffered.
    await engine.publishEvent('order.paid', { n: 1 });
    now += 30_000;
    await engine.publishEvent('order.paid', { n: 2 });
    now += 45_000; // the first is 75s old (expired), the second 45s (live)

    await engine.start('waiter', {}, 'w1');
    for (let i = 0; i < 200 && (await store.getRun('w1'))?.status !== 'completed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    // The live one is consumed; the expired one was skipped and removed on the way.
    expect((await store.getRun('w1'))?.output).toEqual({ n: 2 });
    expect(await store.listBufferedEvents('order.paid', 10)).toEqual([]);

    // One that is never waited for is pruned by the worker tick's retention phase.
    await store.bufferEvent({ id: 'stale', name: 'nobody', payload: {}, publishedAt: now });
    now += 61_000;
    await engine.sweepRetention(now);
    expect(await store.listBufferedEvents('nobody', 10)).toEqual([]);
  });

  it('without a TTL a buffered event waits forever', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      transport: new InMemoryTransport(),
      clock: () => 10_000_000_000,
    });
    await store.bufferEvent({ id: 'old', name: 'x', payload: {}, publishedAt: 0 });
    expect(await engine.sweepRetention()).toBe(0);
    expect(await store.listBufferedEvents('x', 10)).toHaveLength(1);
  });
});
