import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noDispatch = { dispatch: () => {} };

describe('non-blocking control actions (retry / compensate-cancel)', () => {
  it('retry (requeue) re-enqueues a failed run instead of running it inline', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, runDispatcher: noDispatch });
    let fail = true;
    engine.register('w', '1', async (ctx) =>
      ctx.localStep('s', async () => {
        if (fail) {
          fail = false;
          throw new Error('boom');
        }
        return 'ok';
      }),
    );
    await engine.start('w', {}, 'r1');
    await engine.runPending(); // a worker runs it → fails (no retries)
    expect((await store.getRun('r1'))?.status).toBe('failed');

    const r = await engine.requeue('r1');
    expect(r).toEqual({ runId: 'r1', status: 'pending' });
    expect((await store.getRun('r1'))?.status).toBe('pending'); // NOT executed inline

    const [res] = await engine.runPending(); // a worker picks it up and re-runs the now-passing step
    expect(res!.status).toBe('completed');
  });

  it('compensate-cancel returns immediately and runs the undo in the background', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store }); // default in-process dispatcher
    const undone: string[] = [];
    engine.register('w', '1', async (ctx) => {
      await ctx.localStep('reserve', async () => 1, {
        compensate: async () => void undone.push('reserve'),
      });
      await ctx.waitForSignal('go');
      return 'done';
    });
    const suspended = await startRun(engine, 'w', {}, 'r1');
    expect(suspended.status).toBe('suspended');

    // Returns without awaiting the replay+undo (caller never blocks); status is still in-flight.
    const c = await engine.cancel('r1', { compensate: true });
    expect(c?.status).toBe('suspended');
    expect(undone).toEqual([]); // not done synchronously

    // The background resume runs the compensation and settles the run cancelled.
    for (let i = 0; i < 100 && (await store.getRun('r1'))?.status !== 'cancelled'; i += 1) {
      await sleep(5);
    }
    expect((await store.getRun('r1'))?.status).toBe('cancelled');
    expect(undone).toEqual(['reserve']);
  });
});
