import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const tick = () => new Promise((r) => setImmediate(r));
async function until(pred: () => Promise<boolean>, n = 300) {
  for (let i = 0; i < n; i += 1) {
    if (await pred()) return;
    await tick();
  }
  throw new Error('condition not met');
}

function counterEngine(store = new InMemoryStateStore()) {
  const engine = new WorkflowEngine({ store });
  engine.registerEntity<{ count: number }>('counter', {
    initialState: () => ({ count: 0 }),
    handlers: {
      increment: (s, by) => {
        s.count += by as number;
      },
      get: (s) => s.count,
    },
  });
  return engine;
}

describe('durable entities', () => {
  it('serializes ops per key over durable state, readable via getEntityState', async () => {
    const engine = counterEngine();
    await engine.signalEntity('counter', 'k1', 'increment', 5);
    await engine.signalEntity('counter', 'k1', 'increment', 3);
    await engine.signalEntity('counter', 'other', 'increment', 100); // a different key is independent

    await until(
      async () => (await engine.getEntityState<{ count: number }>('counter', 'k1'))?.count === 8,
    );
    await until(
      async () =>
        (await engine.getEntityState<{ count: number }>('counter', 'other'))?.count === 100,
    );
    expect(await engine.getEntityState('counter', 'k1')).toEqual({ count: 8 });
    expect(await engine.getEntityState('counter', 'other')).toEqual({ count: 100 });
  });

  it("stamps the built-in entity runner with durable's origin", async () => {
    const engine = counterEngine();
    await engine.signalEntity('counter', 'k1', 'increment', 1);
    await until(
      async () => (await engine.getEntityState<{ count: number }>('counter', 'k1'))?.count === 1,
    );
    expect((await engine.getRun('entity:counter:k1'))?.origin).toBe('@adonis-agora/durable');
  });

  it('ctx.callEntity awaits a handler result from inside a workflow', async () => {
    const store = new InMemoryStateStore();
    const engine = counterEngine(store);
    engine.register('reader', '1', async (ctx) => {
      await ctx.signalEntity('counter', 'k2', 'increment', 7);
      await ctx.signalEntity('counter', 'k2', 'increment', 2);
      return ctx.callEntity<number>('counter', 'k2', 'get');
    });
    await engine.start('reader', {}, 'r1');
    // The reader suspends on callEntity until the entity replies; poll until it completes.
    await until(async () => (await store.getRun('r1'))?.status === 'completed');
    expect((await store.getRun('r1'))?.output).toBe(9); // ops applied in order, then read back
  });
});
