import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const tick = () => new Promise((r) => setImmediate(r));
async function until(pred: () => boolean, n = 100) {
  for (let i = 0; i < n && !pred(); i += 1) await tick();
}

describe('onEvent debounce / batch', () => {
  it('debounce: coalesces a burst into one run with the last payload after the quiet window', async () => {
    const store = new InMemoryStateStore();
    let now = 1000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    const fired: unknown[] = [];
    engine.register('handler', '1', async (_ctx, input) => void fired.push(input), {
      onEvent: ['activity'],
      eventBatch: { mode: 'debounce', windowMs: 5000 },
    });

    await engine.publishEvent('activity', { v: 1 });
    await engine.waitForRun('__evtacc__:handler'); // accumulator parked on the debounce window
    await engine.publishEvent('activity', { v: 2 });
    await engine.publishEvent('activity', { v: 3 });
    await tick();
    expect(fired).toEqual([]); // nothing fired yet — still within the window

    now += 6000; // window elapses with no new event
    await engine.resumeDueTimers(now);
    await until(() => fired.length > 0);
    expect(fired).toEqual([{ v: 3 }]); // exactly one run, with the last payload
  });

  it('batch: fires one run with all payloads once maxSize is reached', async () => {
    const store = new InMemoryStateStore();
    const now = 1000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    const fired: unknown[] = [];
    engine.register('agg', '1', async (_ctx, input) => void fired.push(input), {
      onEvent: ['hit'],
      eventBatch: { mode: 'batch', maxSize: 3, windowMs: 60_000 },
    });

    await engine.publishEvent('hit', { n: 1 });
    await engine.waitForRun('__evtacc__:agg');
    await engine.publishEvent('hit', { n: 2 });
    await engine.publishEvent('hit', { n: 3 }); // hits maxSize → fires
    await until(() => fired.length > 0);
    expect(fired).toEqual([{ events: [{ n: 1 }, { n: 2 }, { n: 3 }] }]);
  });

  it("stamps the built-in accumulator run with durable's origin, not the target's", async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), clock: () => 1000 });
    const fired: unknown[] = [];
    engine.register('app-target', '1', async (_ctx, input) => void fired.push(input), {
      onEvent: ['hit'],
      eventBatch: { mode: 'batch', maxSize: 1, windowMs: 60_000 },
      origin: 'my-app',
    });

    await engine.publishEvent('hit', { n: 1 });
    await until(() => fired.length > 0);
    expect((await engine.getRun('__evtacc__:app-target'))?.origin).toBe('@adonis-agora/durable');
    const [target] = await engine.listRuns({ workflow: 'app-target' });
    expect(target?.origin).toBe('my-app');
  });
});
