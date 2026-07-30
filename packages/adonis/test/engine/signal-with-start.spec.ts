import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('signal buffering + signalWithStart', () => {
  it('buffers a signal sent before the run waits, delivering it on the next waitForSignal', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
    engine.register('w', '1', async (ctx) => ctx.waitForSignal<number>('go'));

    await engine.start('w', {}, 'r1');
    // Signal BEFORE the run has executed/waited — must be buffered, not lost.
    expect(await engine.signal('go', 42)).toBeNull();

    const [res] = await engine.runPending(); // worker runs it → waitForSignal consumes the buffer
    expect(res!.status).toBe('completed');
    expect(res!.output).toBe(42);
  });

  it('signalWithStart drives a long-lived entity run, race-free across many events', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const seen: number[] = [];
    engine.register('counter', '1', async (ctx) => {
      for (let i = 0; i < 3; i += 1) {
        const n = await ctx.waitForSignal<number>('add:k1');
        await ctx.localStep(`record-${i}`, async () => void seen.push(n));
      }
      return seen.reduce((a, b) => a + b, 0);
    });

    // Three events; the first starts the entity, the rest are buffered or delivered — all land.
    await engine.signalWithStart('counter', {}, 'k1', { token: 'add:k1', payload: 10 });
    await engine.signalWithStart('counter', {}, 'k1', { token: 'add:k1', payload: 20 });
    await engine.signalWithStart('counter', {}, 'k1', { token: 'add:k1', payload: 30 });

    const result = await engine.waitForRun('k1');
    expect(result.status).toBe('completed');
    expect(result.output).toBe(60);
    expect(seen).toEqual([10, 20, 30]);
  });
});
