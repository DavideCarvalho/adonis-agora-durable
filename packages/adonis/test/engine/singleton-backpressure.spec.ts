import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { SingletonQueueFullError } from '../../src/errors.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/** Poll until `pred()` is true (notify-on-release dispatches the next waiter asynchronously). */
async function until(pred: () => boolean | Promise<boolean>, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('singleton notify-on-release', () => {
  it('wakes the next gated waiter immediately when the slot frees (no timer tick needed)', async () => {
    const store = new InMemoryStateStore();
    const now = 1000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    const ran: string[] = [];

    engine.register(
      'job',
      '1',
      async (ctx, input) => {
        const { id } = input as { id: string };
        await ctx.localStep('enter', async () => void ran.push(id));
        await ctx.waitForSignal(`go:${id}`);
        return 'done';
      },
      { singleton: { key: (input) => (input as { key: string }).key } },
    );

    await startRun(engine, 'job', { id: 'A', key: 'k' }, 'a');
    await startRun(engine, 'job', { id: 'B', key: 'k' }, 'b');
    await startRun(engine, 'job', { id: 'C', key: 'k' }, 'c');
    expect(ran).toEqual(['A']); // A holds the slot; B,C gated
    expect((await store.getRun('b'))?.status).toBe('suspended');
    expect((await store.getRun('c'))?.status).toBe('suspended');

    // A completes → the slot frees. WITHOUT advancing any timer, B (the oldest gated waiter) must
    // wake and run immediately via notify-on-release.
    await engine.signal('go:A', undefined);
    expect((await store.getRun('a'))?.status).toBe('completed');
    // Wait for the notify-driven wake of B to run (no resumeDueTimers / timer advance).
    await until(() => ran.includes('B'));
    expect(ran).toEqual(['A', 'B']); // B woke without resumeDueTimers
    expect((await store.getRun('c'))?.status).toBe('suspended'); // C still gated (slot taken by B)

    // B completes → C wakes next. FIFO preserved.
    await engine.signal('go:B', undefined);
    await until(() => ran.includes('C'));
    expect(ran).toEqual(['A', 'B', 'C']);
    void now;
  });

  it('preserves FIFO order across many gated waiters on release', async () => {
    const store = new InMemoryStateStore();
    let now = 1000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    const ran: string[] = [];
    engine.register(
      'job',
      '1',
      async (ctx, input) => {
        const { id } = input as { id: string };
        await ctx.localStep('enter', async () => void ran.push(id));
        await ctx.waitForSignal(`go:${id}`);
        return 'done';
      },
      { singleton: { key: () => 'k' } },
    );

    const ids = ['a', 'b', 'c', 'd', 'e'];
    for (const id of ids) {
      now += 1; // distinct createdAt → deterministic FIFO
      await startRun(engine, 'job', { id }, id);
    }
    expect(ran).toEqual(['a']);

    // Release each in turn; each release wakes the next in creation order. Poll until the next
    // waiter has actually run (notify dispatches it asynchronously) before releasing the one after.
    for (let i = 0; i < ids.length - 1; i++) {
      await engine.signal(`go:${ids[i]}`, undefined);
      const nextId = ids[i + 1]!;
      for (let tries = 0; tries < 50 && !ran.includes(nextId); tries++) {
        await new Promise((r) => setTimeout(r, 2));
      }
    }
    expect(ran).toEqual(ids);
  });
});

describe('singleton maxQueueDepth back-pressure', () => {
  it('rejects a start that would exceed limit + maxQueueDepth', async () => {
    const store = new InMemoryStateStore();
    let now = 1000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    engine.register(
      'job',
      '1',
      async (ctx, input) => {
        await ctx.waitForSignal(`go:${(input as { id: string }).id}`);
        return 'done';
      },
      { singleton: { key: () => 'k', limit: 1, maxQueueDepth: 2 } },
    );

    // limit 1 (running) + maxQueueDepth 2 (gated) = 3 admitted into the system.
    now += 1;
    await startRun(engine, 'job', { id: 'A' }, 'a'); // runs
    now += 1;
    await startRun(engine, 'job', { id: 'B' }, 'b'); // gated 1
    now += 1;
    await startRun(engine, 'job', { id: 'C' }, 'c'); // gated 2
    now += 1;
    // The 4th would push the queue past the cap → rejected.
    await expect(startRun(engine, 'job', { id: 'D' }, 'd')).rejects.toBeInstanceOf(
      SingletonQueueFullError,
    );
    expect(await store.getRun('d')).toBeNull(); // no run created
  });

  it('allows a new start once a slot frees below the cap', async () => {
    const store = new InMemoryStateStore();
    let now = 1000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    engine.register(
      'job',
      '1',
      async (ctx, input) => {
        await ctx.waitForSignal(`go:${(input as { id: string }).id}`);
        return 'done';
      },
      { singleton: { key: () => 'k', limit: 1, maxQueueDepth: 1 } },
    );
    now += 1;
    await startRun(engine, 'job', { id: 'A' }, 'a');
    now += 1;
    await startRun(engine, 'job', { id: 'B' }, 'b'); // gated (queue full now)
    now += 1;
    await expect(startRun(engine, 'job', { id: 'C' }, 'c')).rejects.toBeInstanceOf(
      SingletonQueueFullError,
    );
    // A completes → B promotes to running (notify-on-release), queue depth drops → a new start fits.
    await engine.signal('go:A', undefined);
    await until(async () => (await store.getRun('a'))?.status === 'completed');
    await until(async () => (await store.getRun('b'))?.status === 'running');
    now += 1;
    // Raw start (not startRun): assert it's admitted (not rejected) — it enqueues as `pending`.
    await expect(engine.start('job', { id: 'C2' }, 'c2')).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('does not cap when maxQueueDepth is unset (backward compatible)', async () => {
    const store = new InMemoryStateStore();
    let now = 1000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    engine.register(
      'job',
      '1',
      async (ctx, input) => {
        await ctx.waitForSignal(`go:${(input as { id: string }).id}`);
        return 'done';
      },
      { singleton: { key: () => 'k' } },
    );
    for (let i = 0; i < 10; i++) {
      now += 1;
      await startRun(engine, 'job', { id: `r${i}` }, `r${i}`);
    }
    // All 10 admitted into the system (1 running, 9 gated) — no rejection without a cap.
    expect((await store.listRuns({ workflow: 'job' })).length).toBe(10);
  });
});
