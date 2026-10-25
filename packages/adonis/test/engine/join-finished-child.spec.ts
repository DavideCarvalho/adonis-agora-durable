import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { GatherError } from '../../src/errors.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * A parent that joins a child which already finished settles it from the child's row in the same
 * turn. The child's notification found no waiter, and no buffered completion is kept for a parent
 * that can read the row instead, so nothing else would ever wake the parent: these engines run with
 * reconcile off (`reconcileMs: 0`) to prove it.
 */

/** Poll the store until `runId` is terminal (`waitForRun` also returns on a suspension). */
async function terminal(store: InMemoryStateStore, runId: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const run = await store.getRun(runId);
    if (run && ['completed', 'failed', 'cancelled', 'dead'].includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`${runId} never finished (${run?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function engineWithoutReconcile(store: InMemoryStateStore): WorkflowEngine {
  return new WorkflowEngine({ store, reconcileMs: 0 });
}

describe('joining a child that already finished', () => {
  it('ctx.child with a caller-chosen id settles at once with the child output', async () => {
    const store = new InMemoryStateStore();
    const engine = engineWithoutReconcile(store);
    engine.register('quick', '1', async () => ({ rows: 7 }));
    engine.register('parent', '1', async (ctx) => ctx.child('quick', {}, 'my-child'));

    await engine.start('quick', {}, 'my-child');
    expect((await engine.waitForRun('my-child', { timeoutMs: 5_000 })).status).toBe('completed');
    await engine.start('parent', {}, 'p');

    const parent = await engine.waitForRun('p', { timeoutMs: 5_000 });
    expect(parent.status).toBe('completed');
    expect(parent.output).toEqual({ rows: 7 });
    expect(await store.listSignalWaiters('child:')).toEqual([]);
  });

  it('ctx.child surfaces an already-failed child as a failure', async () => {
    const store = new InMemoryStateStore();
    const engine = engineWithoutReconcile(store);
    engine.register('broken', '1', async () => {
      throw new Error('boom');
    });
    engine.register('parent', '1', async (ctx) => {
      try {
        await ctx.child('broken', {}, 'bad-child');
        return 'no error';
      } catch (err) {
        return (err as Error).message;
      }
    });

    await engine.start('broken', {}, 'bad-child');
    expect((await engine.waitForRun('bad-child', { timeoutMs: 5_000 })).status).toBe('failed');
    await engine.start('parent', {}, 'p');

    const parent = await engine.waitForRun('p', { timeoutMs: 5_000 });
    expect(parent.status).toBe('completed');
    expect(parent.output).toMatch(/boom/);
  });

  it('a spawn joined after it finished, with a caller-chosen id', async () => {
    const store = new InMemoryStateStore();
    const engine = engineWithoutReconcile(store);
    engine.register('quick', '1', async () => 'done');
    engine.register('parent', '1', async (ctx) => {
      const id = await ctx.startChild('quick', {}, 'spawned');
      await ctx.sleep(50); // the child finishes while the parent sleeps
      return ctx.child('quick', {}, id);
    });

    await engine.start('parent', {}, 'p');
    expect((await engine.waitForRun('spawned', { timeoutMs: 5_000 })).status).toBe('completed');
    // The sleep's wake is a due timer: drive it the way the timer poller does.
    const deadline = Date.now() + 5_000;
    while ((await store.getRun('p'))?.status !== 'completed' && Date.now() < deadline) {
      await engine.resumeDueTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await store.getRun('p'))?.output).toBe('done');
  });

  describe.each([
    { form: 'ctx.all', settle: false },
    { form: 'ctx.allSettled', settle: true },
  ])('$form with some children finished before the join', ({ settle }) => {
    it('settles the finished ones at once and waits only for the rest', async () => {
      const store = new InMemoryStateStore();
      const engine = engineWithoutReconcile(store);
      engine.register('line', '1', async (_ctx, input) => (input as { i: number }).i * 10);
      engine.register('parent', '1', async (ctx) => {
        const inputs = [{ i: 0 }, { i: 1 }, { i: 2 }];
        return settle ? ctx.allSettled('line', inputs) : ctx.all('line', inputs);
      });
      // Children 0 and 2 ran before the parent's fan registered its waiters (their ids are the
      // fan's deterministic ones); child 1 is started by the fan itself.
      for (const i of [0, 2]) {
        await engine.start('line', { i }, `p.all.0.${i}`);
        expect((await engine.waitForRun(`p.all.0.${i}`, { timeoutMs: 5_000 })).status).toBe(
          'completed',
        );
      }
      await engine.start('parent', {}, 'p');

      const parent = await terminal(store, 'p');
      expect(parent.status).toBe('completed');
      expect(parent.output).toEqual(
        settle ? [0, 10, 20].map((value) => ({ status: 'fulfilled', value })) : [0, 10, 20],
      );
    });

    it('settles a fan whose children ALL finished before the join', async () => {
      const store = new InMemoryStateStore();
      const engine = engineWithoutReconcile(store);
      engine.register('line', '1', async (_ctx, input) => (input as { i: number }).i);
      engine.register('parent', '1', async (ctx) => {
        const inputs = [{ i: 0 }, { i: 1 }];
        return settle ? ctx.allSettled('line', inputs) : ctx.all('line', inputs);
      });
      for (const i of [0, 1]) {
        await engine.start('line', { i }, `p.all.0.${i}`);
        await engine.waitForRun(`p.all.0.${i}`, { timeoutMs: 5_000 });
      }
      await engine.start('parent', {}, 'p');
      const parent = await terminal(store, 'p');
      expect(parent.status).toBe('completed');
      expect(parent.output).toEqual(
        settle ? [0, 1].map((value) => ({ status: 'fulfilled', value })) : [0, 1],
      );
    });
  });

  it('ctx.allSettled reports a child that failed before the join as rejected', async () => {
    const store = new InMemoryStateStore();
    const engine = engineWithoutReconcile(store);
    engine.register('line', '1', async (_ctx, input) => {
      if ((input as { i: number }).i === 1) throw new Error('line 1 broke');
      return 'ok';
    });
    engine.register('parent', '1', async (ctx) => ctx.allSettled('line', [{ i: 0 }, { i: 1 }]));
    await engine.start('line', { i: 1 }, 'p.all.0.1');
    expect((await engine.waitForRun('p.all.0.1', { timeoutMs: 5_000 })).status).toBe('failed');
    await engine.start('parent', {}, 'p');

    const parent = await terminal(store, 'p');
    expect(parent.status).toBe('completed');
    const [first, second] = parent.output as Array<{ status: string; error?: string }>;
    expect(first?.status).toBe('fulfilled');
    expect(second?.status).toBe('rejected');
    expect(second?.error).toMatch(/line 1 broke/);
  });

  it('ctx.all failFast fails at once on a child that failed before the join', async () => {
    const store = new InMemoryStateStore();
    const engine = engineWithoutReconcile(store);
    engine.register('line', '1', async (ctx, input) => {
      if ((input as { i: number }).i === 1) throw new Error('line 1 broke');
      return ctx.waitForSignal('never');
    });
    engine.register('parent', '1', async (ctx) => {
      try {
        await ctx.all('line', [{ i: 0 }, { i: 1 }], { mode: 'failFast' });
        return 'no error';
      } catch (err) {
        if (!(err instanceof GatherError)) throw err; // a suspension must propagate
        return err.failures.map((f) => f.index);
      }
    });
    await engine.start('line', { i: 1 }, 'p.all.0.1');
    expect((await engine.waitForRun('p.all.0.1', { timeoutMs: 5_000 })).status).toBe('failed');
    await engine.start('parent', {}, 'p');

    const parent = await terminal(store, 'p');
    expect(parent.status).toBe('completed');
    expect(parent.output).toEqual([1]);
  });
});
