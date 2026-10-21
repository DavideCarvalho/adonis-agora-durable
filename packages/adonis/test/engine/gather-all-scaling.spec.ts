import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { GatherError } from '../../src/errors.js';
import { parentRunIdOf } from '../../src/fan-join.js';
import type { StateStore, WorkflowRun } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

async function poll(fn: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

/** Counts every store call, so a test can assert how the work grows with the fan size. */
function countingStore(): { store: StateStore; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const inner = new InMemoryStateStore();
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.set(String(prop), (calls.get(String(prop)) ?? 0) + 1);
        return value.apply(target, args);
      };
    },
  });
  return { store, calls };
}

const total = (calls: Map<string, number>, ...names: string[]): number =>
  names.reduce((sum, n) => sum + (calls.get(n) ?? 0), 0);

/**
 * A store whose `getRun(staleId)` call, once armed, reads the run, lets `hook` run, and then hands
 * back the value it read before the hook. Lets a test land a child's settle between the parent
 * checking that child and the parent suspending, which is exactly when the child's wake is dropped
 * on the parent's held lease.
 */
function staleReadStore(staleId: string): {
  store: StateStore;
  arm: (hook: () => Promise<void>) => void;
} {
  const inner = new InMemoryStateStore();
  let armed: (() => Promise<void>) | undefined;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'getRun') return value;
      return async (runId: string): Promise<WorkflowRun | null> => {
        const read = await inner.getRun(runId);
        const hook = runId === staleId ? armed : undefined;
        if (hook) {
          armed = undefined;
          await hook();
        }
        return read;
      };
    },
  });
  return { store, arm: (hook) => (armed = hook) };
}

/** Runs a `ctx.all` over `n` children that each wait for a signal, then releases them one at a time
 *  — the worst case for a parent that replays the whole fan on every child completion. */
async function runFan(n: number) {
  const { store, calls } = countingStore();
  const engine = new WorkflowEngine({ store });
  engine.register('child', '1', async (ctx, input) => {
    await ctx.waitForSignal(`go:${(input as { i: number }).i}`);
    return (input as { i: number }).i;
  });
  engine.register('parent', '1', async (ctx) =>
    ctx.all<number>(
      'child',
      Array.from({ length: n }, (_, i) => ({ i })),
    ),
  );
  await startRun(engine, 'parent', {}, 'p');
  await poll(async () => (await store.listSignalWaiters('go:')).length === n);
  // Each child's own post-suspend recheck is a macrotask; let them run so only the release phase
  // is counted.
  await new Promise((r) => setTimeout(r, 50));
  calls.clear();
  let parentExecutions = 0;
  engine.subscribe((e) => {
    if (e.type === 'run.suspended' && e.runId === 'p') parentExecutions += 1;
    if (e.type === 'run.completed' && e.runId === 'p') parentExecutions += 1;
  });
  for (let i = 0; i < n; i += 1) {
    await engine.signal(`go:${i}`, undefined);
    await poll(async () => (await store.getRun(`p.all.0.${i}`))?.status === 'completed');
  }
  await poll(async () => (await store.getRun('p'))?.status === 'completed');
  return { store, calls, parentExecutions };
}

describe('ctx.all scaling', () => {
  it('replays the parent once for the whole fan, not once per child', async () => {
    const { store, parentExecutions } = await runFan(50);
    expect((await store.getRun('p'))?.output).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(parentExecutions).toBeLessThanOrEqual(2);
  });

  it('store calls grow linearly with the fan size', async () => {
    const small = await runFan(50);
    const large = await runFan(200);
    const perChild = (c: Map<string, number>, n: number) =>
      total(c, 'putSignalWaiter', 'getRun', 'getCheckpoint', 'listCheckpoints') / n;
    // Quadratic growth would make the 4x fan cost ~4x more PER CHILD; linear keeps it flat.
    expect(perChild(large.calls, 200)).toBeLessThan(perChild(small.calls, 50) * 1.5);
    expect(large.calls.get('putSignalWaiter') ?? 0).toBeLessThanOrEqual(200 * 2);
  });

  it('settles when children finish while the parent is still dispatching the fan', async () => {
    // Instant children settle mid-dispatch, so wakes land while the parent holds its lease. With the
    // reconcile sweep off, only the barrier and the post-suspend re-drive can complete the parent.
    for (const instances of [1, 3]) {
      const store = new InMemoryStateStore();
      const engines = Array.from(
        { length: instances },
        () => new WorkflowEngine({ store, reconcileMs: 0 }),
      );
      for (const engine of engines) {
        engine.register('child', '1', async (_ctx, input) => (input as { i: number }).i);
        engine.register('parent', '1', async (ctx) =>
          ctx.all<number>(
            'child',
            Array.from({ length: 40 }, (_, i) => ({ i })),
          ),
        );
      }
      await startRun(engines[0] as WorkflowEngine, 'parent', {}, 'p');
      await poll(async () => (await store.getRun('p'))?.status === 'completed', 3000);
      expect((await store.getRun('p'))?.output).toEqual(Array.from({ length: 40 }, (_, i) => i));
      expect(await store.listSignalWaiters('child:p.')).toEqual([]);
    }
  });

  it('re-drives a parent whose last child settled while another instance held its lease', async () => {
    const { store, arm } = staleReadStore('p.all.0.1');
    const [a, b] = [0, 1].map(() => new WorkflowEngine({ store, reconcileMs: 0 })) as [
      WorkflowEngine,
      WorkflowEngine,
    ];
    for (const engine of [a, b]) {
      engine.register('child', '1', async (ctx, input) => {
        await ctx.waitForSignal(`go:${(input as { i: number }).i}`);
        return (input as { i: number }).i;
      });
      engine.register('parent', '1', async (ctx) => ctx.all<number>('child', [{ i: 0 }, { i: 1 }]));
    }
    await startRun(a, 'parent', {}, 'p');
    await poll(async () => (await store.listSignalWaiters('go:')).length === 2);
    await a.signal('go:0', undefined);
    await poll(async () => (await store.getCheckpoint('p', 0))?.status === 'completed');
    // The barrier held the wake: child 1 is still out.
    expect((await store.getRun('p'))?.status).toBe('suspended');

    // Instance A starts a turn of the parent. Right after it checks child 1, child 1 settles on
    // instance B, whose wake finds A's lease held and is dropped.
    arm(async () => {
      await b.signal('go:1', undefined);
      await poll(async () => (await store.getCheckpoint('p', 1))?.status === 'completed');
      await new Promise((r) => setTimeout(r, 20));
    });
    await a.runOne('p');
    await poll(async () => (await store.getRun('p'))?.status === 'completed', 2000);
    expect((await store.getRun('p'))?.output).toEqual([0, 1]);
  });

  it('waitAll still reports every failure after the whole fan settles', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('child', '1', async (_ctx, input) => {
      const i = (input as { i: number }).i;
      if (i % 2 === 1) throw new Error(`boom-${i}`);
      return i;
    });
    engine.register('parent', '1', async (ctx) => {
      try {
        return await ctx.all('child', [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }]);
      } catch (err) {
        if (err instanceof GatherError) return err.failures.map((f) => f.index);
        throw err;
      }
    });
    await startRun(engine, 'parent', {}, 'p');
    await poll(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual([1, 3]);
  });

  it('failFast wakes the parent on the first failure while siblings are still running', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('child', '1', async (ctx, input) => {
      const i = (input as { i: number }).i;
      if (i === 0) throw new Error('boom');
      await ctx.waitForSignal(`never:${i}`);
      return i;
    });
    engine.register('parent', '1', async (ctx) => {
      try {
        return await ctx.all('child', [{ i: 0 }, { i: 1 }, { i: 2 }], { mode: 'failFast' });
      } catch (err) {
        if (err instanceof GatherError) return 'failed-fast';
        throw err;
      }
    });
    await startRun(engine, 'parent', {}, 'p');
    await poll(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toBe('failed-fast');
    expect((await store.getCheckpoint('p', 0))?.parallelGroup).toBe('all:0:failFast');
  });
});

describe('ctx.all dispatch', () => {
  it('registers a wide fan in chunks, without per-child waiter, checkpoint or run lookups', async () => {
    // Counts only the parent's calls: its children start running while it is still dispatching.
    const calls = new Map<string, number>();
    const inner = new InMemoryStateStore();
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const first = args[0];
          const forParent =
            first === 'p' ||
            (typeof first === 'object' && (first as { runId?: string })?.runId === 'p') ||
            prop === 'registerChildWaits';
          if (forParent) calls.set(String(prop), (calls.get(String(prop)) ?? 0) + 1);
          return value.apply(target, args);
        };
      },
    });
    const engine = new WorkflowEngine({ store });
    engine.register('child', '1', async (ctx) => {
      await ctx.waitForSignal('never');
      return 0;
    });
    engine.register('parent', '1', async (ctx) =>
      ctx.all(
        'child',
        Array.from({ length: 1200 }, (_, i) => ({ i })),
      ),
    );
    let dispatchCalls: Record<string, number> = {};
    engine.subscribe((e) => {
      if (e.type === 'run.suspended' && e.runId === 'p') dispatchCalls = Object.fromEntries(calls);
    });
    await startRun(engine, 'parent', {}, 'p');
    await poll(async () => (await store.getRun('p'))?.status === 'suspended');

    expect(dispatchCalls.registerChildWaits).toBe(3);
    expect(dispatchCalls.putSignalWaiter ?? 0).toBe(0);
    expect(dispatchCalls.getCheckpoint ?? 0).toBe(0);
    expect(dispatchCalls.takeBufferedSignal ?? 0).toBe(0);
    expect(dispatchCalls.listCheckpointsByNamePrefix).toBe(1);
  });

  it('a child that already settled before the fan was sent is delivered to its waiter', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('child', '1', async (_ctx, input) => (input as { i: number }).i * 10);
    engine.register('parent', '1', async (ctx) => ctx.all<number>('child', [{ i: 0 }, { i: 1 }]));
    // Child 0 ran to completion under its fan id before the parent ever sent the fan, and its
    // completion was buffered with no waiter to take it.
    await startRun(engine, 'child', { i: 0 }, 'p.all.0.0');
    await startRun(engine, 'parent', {}, 'p');
    await poll(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual([0, 10]);
    expect(await store.takeBufferedSignal('child:p.all.0.0')).toBeNull();
  });
});

describe('ctx.all concurrency', () => {
  /** A fan whose children each wait for their own signal, so the test controls when each settles. */
  function gatedFan(size: number, opts: { concurrency: number; mode?: 'waitAll' | 'failFast' }) {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    // A set, not a counter: a child's body re-runs on every replay.
    const running = new Set<number>();
    let peak = 0;
    engine.register('child', '1', async (ctx, input) => {
      const i = (input as { i: number }).i;
      running.add(i);
      peak = Math.max(peak, running.size);
      const fail = await ctx.waitForSignal<boolean>(`go:${i}`);
      running.delete(i);
      if (fail) throw new Error(`boom-${i}`);
      return i;
    });
    engine.register('parent', '1', async (ctx) => {
      try {
        return await ctx.all(
          'child',
          Array.from({ length: size }, (_, i) => ({ i })),
          opts,
        );
      } catch (err) {
        if (err instanceof GatherError) return { failed: err.failures.map((f) => f.index) };
        throw err;
      }
    });
    const waiting = async () =>
      (await store.listSignalWaiters('go:'))
        .map((w) => Number(w.token.slice(3)))
        .sort((a, b) => a - b);
    return { store, engine, peak: () => peak, waiting };
  }

  it('never runs more than `concurrency` children and returns outputs in input order', async () => {
    const { store, engine, peak, waiting } = gatedFan(10, { concurrency: 4 });
    await startRun(engine, 'parent', {}, 'p');
    // Waves of 2, two of them in flight.
    await poll(async () => (await waiting()).length === 4);
    expect(await waiting()).toEqual([0, 1, 2, 3]);

    // Settle the SECOND wave first: the parent sends the third while the first is still running.
    await engine.signal('go:2', false);
    await engine.signal('go:3', false);
    await poll(async () => (await waiting()).join() === '0,1,4,5');

    // Release every child as it starts waiting, until the fan is done.
    await poll(async () => {
      for (const i of await waiting()) await engine.signal(`go:${i}`, false);
      return (await store.getRun('p'))?.status === 'completed';
    });
    expect((await store.getRun('p'))?.output).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect(peak()).toBeLessThanOrEqual(4);
  });

  it('wave children carry the wave in their id', async () => {
    const { store, engine, waiting } = gatedFan(5, { concurrency: 2 });
    await startRun(engine, 'parent', {}, 'p');
    await poll(async () => (await waiting()).length === 2);
    expect(await store.getRun('p.all.0.w0.0')).not.toBeNull();
    expect(await store.getRun('p.all.0.w1.1')).not.toBeNull();
    expect(await store.getRun('p.all.0.w2.2')).toBeNull();
  });

  it('a limit at or above the fan size keeps the unbounded ids', async () => {
    const { store, engine, waiting } = gatedFan(3, { concurrency: 3 });
    await startRun(engine, 'parent', {}, 'p');
    await poll(async () => (await waiting()).length === 3);
    expect(await store.getRun('p.all.0.2')).not.toBeNull();
  });

  it('failFast stops sending waves after the first failure', async () => {
    const { store, engine, waiting } = gatedFan(8, { concurrency: 2, mode: 'failFast' });
    await startRun(engine, 'parent', {}, 'p');
    await poll(async () => (await waiting()).length === 2);
    await engine.signal('go:0', true);
    await poll(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual({ failed: [0] });
    expect(await store.getRun('p.all.0.w2.2')).toBeNull();
  });

  it('rejects a non-positive or fractional limit', async () => {
    for (const concurrency of [0, -1, 1.5]) {
      const store = new InMemoryStateStore();
      const engine = new WorkflowEngine({ store });
      engine.register('child', '1', async () => 0);
      engine.register('parent', '1', async (ctx) => ctx.all('child', [{}, {}], { concurrency }));
      await startRun(engine, 'parent', {}, 'p');
      await poll(async () => (await store.getRun('p'))?.status === 'failed');
      expect((await store.getRun('p'))?.error?.message).toMatch(
        /concurrency must be a positive integer/,
      );
    }
  });
});

describe('ctx.child lost wake', () => {
  it('re-drives a parent whose child settled while another instance held its lease', async () => {
    const { store, arm } = staleReadStore('p.child.0');
    const [a, b] = [0, 1].map(() => new WorkflowEngine({ store, reconcileMs: 0 })) as [
      WorkflowEngine,
      WorkflowEngine,
    ];
    for (const engine of [a, b]) {
      engine.register('child', '1', async (ctx) => {
        await ctx.waitForSignal('go');
        return 'done';
      });
      engine.register('parent', '1', async (ctx) => ctx.child('child', {}));
    }
    await startRun(a, 'parent', {}, 'p');
    await poll(async () => (await store.listSignalWaiters('go')).length === 1);

    arm(async () => {
      await b.signal('go', undefined);
      await poll(async () => (await store.getCheckpoint('p', 0))?.status === 'completed');
      await new Promise((r) => setTimeout(r, 20));
    });
    await a.runOne('p');
    await poll(async () => (await store.getRun('p'))?.status === 'completed', 2000);
    expect((await store.getRun('p'))?.output).toBe('done');
  });
});

describe('ctx.all folding', () => {
  const values = (n: number) => Array.from({ length: n }, (_, i) => i);
  const fanCheckpoints = async (store: StateStore, runId: string) =>
    (await store.listCheckpoints(runId)).filter(
      (cp) => cp.name.startsWith('signal:child:') || cp.name.startsWith('fan:'),
    );

  it('folds a settled fan into one checkpoint, and later turns replay from it', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('child', '1', async (_ctx, input) => (input as { i: number }).i);
    engine.register('echo', '1', async (_ctx, input) => input);
    engine.register('parent', '1', async (ctx) => {
      const outs = await ctx.all<number>(
        'child',
        values(150).map((i) => ({ i })),
      );
      // Each awaited child is another turn of the parent, replaying the fan from the folded
      // checkpoint.
      const a = await ctx.child<number>('echo', outs.length);
      const b = await ctx.child<number>('echo', outs[149]);
      return { sum: outs.reduce((x, y) => x + y, 0), a, b };
    });
    await startRun(engine, 'parent', {}, 'p');
    await poll(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual({ sum: (149 * 150) / 2, a: 150, b: 149 });
    const fan = await fanCheckpoints(store, 'p');
    expect(fan.map((cp) => cp.name)).toEqual([
      'fan:p.all.0.',
      'signal:child:p.child.150',
      'signal:child:p.child.151',
    ]);
    expect((await engine.getRunChildren('p')).sort()).toEqual(
      [...values(150).map((i) => `p.all.0.${i}`), 'p.child.150', 'p.child.151'].sort(),
    );
  });

  it('a turn after the fan loads one checkpoint for it, not one per child', async () => {
    const inner = new InMemoryStateStore();
    const rowsPerTurn: number[] = [];
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'listCheckpoints') return value;
        return async (runId: string) => {
          const rows = await inner.listCheckpoints(runId);
          if (runId === 'p') rowsPerTurn.push(rows.length);
          return rows;
        };
      },
    });
    const engine = new WorkflowEngine({ store });
    engine.register('child', '1', async (_ctx, input) => (input as { i: number }).i);
    engine.register('echo', '1', async (_ctx, input) => input);
    engine.register('parent', '1', async (ctx) => {
      const outs = await ctx.all<number>(
        'child',
        values(1000).map((i) => ({ i })),
      );
      return ctx.child<number>('echo', outs.length);
    });
    await startRun(engine, 'parent', {}, 'p');
    await poll(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toBe(1000);
    // The fold happens in the turn that sees the fan settle; the turn after it reads 2 rows.
    expect(rowsPerTurn.at(-1)).toBe(2);
  });

  it('folds each settled wave of a fan with a concurrency limit', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('child', '1', async (_ctx, input) => (input as { i: number }).i);
    engine.register('parent', '1', async (ctx) =>
      ctx.all<number>(
        'child',
        values(120).map((i) => ({ i })),
        { concurrency: 20 },
      ),
    );
    await startRun(engine, 'parent', {}, 'p');
    await poll(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual(values(120));
    const fan = await fanCheckpoints(store, 'p');
    expect(fan.map((cp) => cp.name)).toEqual(
      Array.from({ length: 12 }, (_, k) => `fan:p.all.0.w${k}.`),
    );
    expect(await engine.getRunChildren('p')).toHaveLength(120);
  });

  it('keeps a failed child unfolded so requeue can retry it, then folds once it succeeds', async () => {
    const store = new InMemoryStateStore();
    let healthy = false;
    const engine = new WorkflowEngine({ store });
    engine.register('child', '1', async (_ctx, input) => {
      const i = (input as { i: number }).i;
      if (i === 42 && !healthy) throw new Error('boom');
      return i;
    });
    engine.register('parent', '1', async (ctx) =>
      ctx.all<number>(
        'child',
        values(100).map((i) => ({ i })),
      ),
    );
    await startRun(engine, 'parent', {}, 'p');
    await poll(async () => (await store.getRun('p'))?.status === 'failed');
    expect(await fanCheckpoints(store, 'p')).toHaveLength(100);

    healthy = true;
    await engine.requeue('p');
    await poll(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual(values(100));
    expect((await fanCheckpoints(store, 'p')).map((cp) => cp.name)).toEqual(['fan:p.all.0.']);
  });

  it('deleting or purging the parent still removes every child of a folded fan', async () => {
    for (const how of ['delete', 'purge'] as const) {
      const store = new InMemoryStateStore();
      const engine = new WorkflowEngine({ store });
      engine.register('child', '1', async (_ctx, input) => (input as { i: number }).i);
      engine.register('parent', '1', async (ctx) =>
        ctx.all<number>(
          'child',
          values(100).map((i) => ({ i })),
        ),
      );
      await startRun(engine, 'parent', {}, 'p');
      await poll(async () => (await store.getRun('p'))?.status === 'completed');
      expect((await fanCheckpoints(store, 'p')).map((cp) => cp.name)).toEqual(['fan:p.all.0.']);

      if (how === 'delete') expect(await engine.deleteRun('p')).toBe(101);
      else expect(await engine.purgeRuns({ workflow: 'parent' })).toBe(101);
      expect(await store.getRun('p.all.0.0')).toBeNull();
      expect(await store.getRun('p.all.0.99')).toBeNull();
    }
  });

  it('leaves a small fan unfolded, for per-child detail in the dashboard', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('child', '1', async (_ctx, input) => (input as { i: number }).i);
    engine.register('parent', '1', async (ctx) =>
      ctx.all<number>(
        'child',
        values(99).map((i) => ({ i })),
      ),
    );
    await startRun(engine, 'parent', {}, 'p');
    await poll(async () => (await store.getRun('p'))?.status === 'completed');
    expect(await fanCheckpoints(store, 'p')).toHaveLength(99);
  });
});

describe('reads scoped to a run, not every waiter', () => {
  it('getRunChildren and the timer poller read only the runs they need', async () => {
    const inner = new InMemoryStateStore();
    const scans: string[] = [];
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'listSignalWaiters') return value;
        return async (prefix: string) => {
          scans.push(prefix);
          return inner.listSignalWaiters(prefix);
        };
      },
    });
    const engine = new WorkflowEngine({ store });
    engine.register('child', '1', async (ctx) => {
      await ctx.waitForSignal('never');
      return 0;
    });
    engine.register('parent', '1', async (ctx) =>
      ctx.all(
        'child',
        Array.from({ length: 300 }, (_, i) => ({ i })),
      ),
    );
    engine.register('sleeper', '1', async (ctx) => {
      await ctx.sleep(1);
      return 'woke';
    });
    await startRun(engine, 'parent', {}, 'p');
    await poll(async () => (await engine.getRunChildren('p')).length === 300);
    await startRun(engine, 'sleeper', {}, 's');

    scans.length = 0;
    expect(await engine.getRunChildren('p')).toHaveLength(300);
    expect(await engine.listSignalWaitersByRunIds(['p', 's'])).toHaveLength(300);
    await engine.resumeDueTimers(Date.now() + 60_000);
    await poll(async () => (await store.getRun('s'))?.status === 'completed');
    // No unscoped scan: neither every waiter ('') nor every awaited child ('child:').
    expect(scans.filter((prefix) => prefix === '' || prefix === 'child:')).toEqual([]);
  });
});

describe('parentRunIdOf', () => {
  it('reads the parent off every child id the engine mints', () => {
    expect(parentRunIdOf('p.all.3.17')).toBe('p');
    expect(parentRunIdOf('p.all.3.w2.17')).toBe('p');
    expect(parentRunIdOf('p.child.4')).toBe('p');
    expect(parentRunIdOf('p.onError')).toBe('p');
    expect(parentRunIdOf('p.all.0.1.onError')).toBe('p.all.0.1');
    expect(parentRunIdOf('p.all.0.1.all.2.3')).toBe('p.all.0.1');
    expect(parentRunIdOf('order-42')).toBeUndefined();
    expect(parentRunIdOf('p.all.x.1')).toBeUndefined();
  });
});

describe('ctx.all review fixes', () => {
  it('an odd concurrency limit runs one child under it, not half of it', async () => {
    const { allWaves } = await import('../../src/fan-join.js');
    expect(allWaves(1000, 101)).toEqual({ waveSize: 50, maxWaves: 2 });
    expect(allWaves(1000, 3)).toEqual({ waveSize: 1, maxWaves: 2 });
    expect(allWaves(1000, 1)).toEqual({ waveSize: 1, maxWaves: 1 });
    expect(allWaves(1000, 4)).toEqual({ waveSize: 2, maxWaves: 2 });
  });

  it('a malformed folded checkpoint stops the replay with a clear error', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('child', '1', async (_ctx, input) => (input as { i: number }).i);
    engine.register('echo', '1', async (_ctx, input) => input);
    engine.register('parent', '1', async (ctx) => {
      const outs = await ctx.all<number>(
        'child',
        Array.from({ length: 100 }, (_, i) => ({ i })),
      );
      return ctx.child<number>('echo', outs.length);
    });
    await startRun(engine, 'parent', {}, 'p');
    await poll(async () => (await store.getRun('p'))?.status === 'completed');
    const folded = await store.getCheckpoint('p', 0);
    expect(folded?.name).toBe('fan:p.all.0.');
    await store.saveCheckpoint({
      ...(folded as NonNullable<typeof folded>),
      output: { broken: true },
    });
    await store.updateRun('p', { status: 'failed' });
    await engine.requeue('p');
    await poll(async () => (await store.getRun('p'))?.status === 'failed');
    expect((await store.getRun('p'))?.error?.message).toMatch(
      /folded checkpoint "fan:p\.all\.0\." at seq 0 is malformed/,
    );
  });

  it('the in-memory store writes a fold under the run whose range it replaced', async () => {
    const store = new InMemoryStateStore();
    await store.compactCheckpoints('right', 0, 0, {
      runId: 'wrong',
      seq: 0,
      name: 'fan:right.all.0.',
      kind: 'signal',
      stepId: 'right:0',
      status: 'completed',
      output: { from: 0, values: [1] },
      attempts: 1,
      enqueuedAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    expect((await store.getCheckpoint('right', 0))?.runId).toBe('right');
    expect(await store.getCheckpoint('wrong', 0)).toBeNull();
  });
});
