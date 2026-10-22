import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { StateStore } from '../../src/interfaces.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { dbBackends } from '../support/backends.js';

/**
 * A workflow-side send stores the op in the entity's buffer, THEN wakes the entity. A process that
 * dies between the two leaves the op buffered while the entity sleeps on its wait. The worker tick's
 * entity reconcile (`engine.reconcileEntityWakes`) finds entity buffers with unconsumed ops and
 * wakes their entity, so the op is applied without waiting for some unrelated next send.
 */

const opened: Database[] = [];
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
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

async function until(check: () => Promise<boolean>, max = 400): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never held');
}

describe.each(stores)('entity lost-wake reconcile (%s)', (_label, makeStore) => {
  function counterEngine(store: StateStore) {
    const engine = new WorkflowEngine({ store });
    engine.registerEntity<{ n: number }>('counter', {
      initialState: () => ({ n: 0 }),
      handlers: {
        add: (state, by) => {
          state.n += by as number;
          return state.n;
        },
      },
    });
    return engine;
  }

  it('wakes an entity whose op was buffered but never kicked; idempotent and bounded', async () => {
    const store = await makeStore();
    const engine = counterEngine(store);
    // A first op starts the entity and parks it on its wait.
    await engine.signalEntity('counter', 'k1', 'add', 1);
    await until(async () => (await engine.getEntityState<{ n: number }>('counter', 'k1'))?.n === 1);
    // Parked for real: the turn settled `suspended` (after its waiter's late buffer re-check), so a
    // write to the buffer from here on is one nothing else will pick up.
    await until(
      async () =>
        (await store.listSignalWaiters('entity:counter:k1')).length === 1 &&
        (await store.getRun('entity:counter:k1'))?.status === 'suspended' &&
        (await store.getRun('entity:counter:k1'))?.lockedBy === undefined,
    );

    // The crash window: the op is in the buffer, the wake never happened.
    await store.bufferSignal('entity:counter:k1', { op: 'add', arg: 41, id: 'caller:7' });
    await new Promise((r) => setTimeout(r, 30));
    expect((await engine.getEntityState<{ n: number }>('counter', 'k1'))?.n).toBe(1);

    expect(await engine.reconcileEntityWakes()).toBe(1);
    await until(
      async () => (await engine.getEntityState<{ n: number }>('counter', 'k1'))?.n === 42,
    );

    // Nothing left buffered: a second pass wakes nobody.
    await until(async () => (await store.listSignalWaiters('entity:counter:k1')).length === 1);
    expect(await engine.reconcileEntityWakes()).toBe(0);
    expect((await engine.getEntityState<{ n: number }>('counter', 'k1'))?.n).toBe(42);
  });

  it('starts an entity whose very first op was buffered before its run existed', async () => {
    const store = await makeStore();
    const engine = counterEngine(store);
    await store.bufferSignal('entity:counter:fresh', { op: 'add', arg: 5, id: 'caller:1' });
    expect(await engine.reconcileEntityWakes()).toBe(1);
    await until(
      async () => (await engine.getEntityState<{ n: number }>('counter', 'fresh'))?.n === 5,
    );
  });
});
