import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { StateStore, WorkflowRun } from '../../src/interfaces.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { makeStoreDb } from '../../src/stores/lucid-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const run = (over: Partial<WorkflowRun> & { id: string }): WorkflowRun => ({
  workflow: 'wf',
  workflowVersion: '1',
  status: 'completed',
  input: {},
  createdAt: new Date(1_000),
  updatedAt: new Date(1_000),
  ...over,
});

const ids = async (store: StateStore) => (await store.listRuns({})).map((r) => r.id).sort();

describe('scoped retention policies', () => {
  it('prunes only the runs a policy scope matches, next to the per-status ages', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      clock: () => 100_000,
      retention: { failed: 50_000 },
      retentionPolicies: [
        { statuses: ['completed'], maxAgeMs: 10_000, scope: { tags: ['chat'] } },
        { statuses: ['completed', 'cancelled'], maxAgeMs: 10_000, scope: { namespace: 'acme' } },
      ],
    });
    await store.createRun(run({ id: 'chat-old', tags: ['chat'], updatedAt: new Date(50_000) }));
    await store.createRun(run({ id: 'chat-new', tags: ['chat'], updatedAt: new Date(95_000) }));
    await store.createRun(run({ id: 'other-old', updatedAt: new Date(50_000) }));
    await store.createRun(
      run({ id: 'acme-old', status: 'cancelled', namespace: 'acme', updatedAt: new Date(1) }),
    );
    await store.createRun(run({ id: 'failed-old', status: 'failed', updatedAt: new Date(1) }));
    await store.createRun(
      run({ id: 'acme-live', status: 'running', namespace: 'acme', updatedAt: new Date(1) }),
    );

    expect(await engine.sweepRetention()).toBe(3);
    expect(await ids(store)).toEqual(['acme-live', 'chat-new', 'other-old']);
  });

  it('a namespaced worker never sweeps another partition’s scope', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      namespace: 'a',
      clock: () => 100_000,
      retentionPolicies: [
        { statuses: ['completed'], maxAgeMs: 1, scope: { namespace: 'b' } },
        { statuses: ['completed'], maxAgeMs: 1, scope: { tags: ['t'] } },
      ],
    });
    await store.createRun(run({ id: 'b1', namespace: 'b' }));
    await store.createRun(run({ id: 'a1', namespace: 'a', tags: ['t'] }));
    await store.createRun(run({ id: 'b2', namespace: 'b', tags: ['t'] }));
    expect(await engine.sweepRetention()).toBe(1);
    expect(await ids(store)).toEqual(['b1', 'b2']);
  });
});

for (const [label, make] of [
  ['InMemoryStateStore', async () => ({ store: new InMemoryStateStore(), close: async () => {} })],
  [
    'LucidStateStore',
    async () => {
      const db = await makeStoreDb();
      return { store: new LucidStateStore(db), close: () => db.manager.closeAll() };
    },
  ],
] as const) {
  describe(`engine.purgeRuns (${label})`, () => {
    async function setup() {
      const { store, close } = await make();
      const engine = new WorkflowEngine({ store });
      engine.register('child', '1', async (ctx) => ctx.waitForSignal('never'));
      engine.register('done', '1', async () => 'ok');
      engine.register('parent', '1', async (ctx) => {
        await ctx.startChild('child', {}, `${ctx.runId}.c`);
        return 'spawned';
      });
      return { store, engine, close };
    }

    it('purges a tag scope with its untagged children and cancels live runs', async () => {
      const { store, engine, close } = await setup();
      await engine.start('parent', {}, 'a1', { tags: ['tenant:a'] });
      await engine.start('done', {}, 'a2', { tags: ['tenant:a'] });
      await engine.start('done', {}, 'b1', { tags: ['tenant:b'] });
      for (const id of ['a1', 'a1.c', 'a2', 'b1']) await engine.waitForRun(id);

      await expect(engine.purgeRuns({})).rejects.toThrow(/empty scope/);
      expect(await engine.purgeRuns({ tag: 'tenant:a' })).toBe(3);
      expect(await ids(store)).toEqual(['b1']);
      await engine.drain();
      await close();
    });

    it('cancelLive:false keeps live runs; purgeNamespace drains in batches', async () => {
      const { store, engine, close } = await setup();
      await engine.start('parent', {}, 'p', { namespace: 'gone' });
      for (let i = 0; i < 5; i++) await engine.start('done', {}, `x${i}`, { namespace: 'gone' });
      await engine.start('done', {}, 'stay', { namespace: 'kept' });
      for (const id of ['p', 'p.c', 'x0', 'x1', 'x2', 'x3', 'x4', 'stay'])
        await engine.waitForRun(id);

      expect(await engine.purgeRuns({ namespace: 'gone' }, { cancelLive: false })).toBe(6);
      expect(await ids(store)).toEqual(['p.c', 'stay']);
      expect(await engine.purgeNamespace('gone', { batchSize: 2 })).toBe(1);
      expect(await ids(store)).toEqual(['stay']);
      await engine.drain();
      await close();
    });
  });
}
