import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { RunDispatcher } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('engine.start dispatches (does not run inline)', () => {
  it('returns a pending run and executes it via the default in-process dispatcher', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('greet', '1', async (_ctx, input) => `hi ${(input as { n: string }).n}`);

    const started = await engine.start('greet', { n: 'ada' }, 'r1');
    expect(started).toEqual({ runId: 'r1', status: 'pending' });
    // Not executed inline: the body runs on a later microtask, so it's still pending right now.
    expect((await store.getRun('r1'))?.status).toBe('pending');

    const settled = await engine.waitForRun('r1');
    expect(settled.status).toBe('completed');
    expect(settled.output).toBe('hi ada');
  });

  it('a no-op dispatcher leaves the run pending until a worker runs it', async () => {
    const store = new InMemoryStateStore();
    const dispatcher: RunDispatcher = { dispatch: vi.fn() };
    const engine = new WorkflowEngine({ store, runDispatcher: dispatcher });
    engine.register('w', '1', async () => 'done');

    await engine.start('w', {}, 'r1');
    expect(dispatcher.dispatch).toHaveBeenCalledWith('r1');
    expect((await store.getRun('r1'))?.status).toBe('pending'); // nobody ran it

    const [result] = await engine.runPending();
    expect(result!.status).toBe('completed');
    expect((await store.getRun('r1'))?.output).toBe('done');
  });

  it('runOne leases the run so two workers never double-run it', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
    let runs = 0;
    engine.register('w', '1', async (ctx) => {
      await ctx.localStep('enter', async () => {
        runs += 1;
      });
      return runs;
    });
    await engine.start('w', {}, 'r1');

    const [a, b] = await Promise.all([engine.runOne('r1'), engine.runOne('r1')]);
    expect(runs).toBe(1); // one leased + ran; the other was locked out
    const winner = a ?? b;
    expect(winner?.status).toBe('completed');
  });

  it('emits run.started only when the body begins, not at enqueue', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
    const events: string[] = [];
    engine.subscribe((e) => events.push(e.type));
    engine.register('w', '1', async () => 'ok');

    await engine.start('w', {}, 'r1');
    expect(events).not.toContain('run.started'); // enqueued, not started

    await engine.runPending();
    expect(events).toContain('run.started');
    expect(events).toContain('run.completed');
  });
});
