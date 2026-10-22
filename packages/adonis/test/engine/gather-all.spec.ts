import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { GatherError } from '../../src/errors.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

async function poll(fn: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

describe('ctx.all (parallel child workflows, wait-all)', () => {
  it('first turn dispatches all N children then suspends', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const started: unknown[] = [];
    // A child that parks on a signal so it stays running while we inspect the first turn.
    engine.register('handle', '1', async (ctx) => {
      started.push((ctx as { runId: string }).runId);
      await ctx.waitForSignal('go');
      return 'done';
    });
    engine.register('parent', '1', async (ctx) => {
      return ctx.all('handle', [{ p: 'A' }, { p: 'B' }, { p: 'C' }]);
    });

    const first = await startRun(engine, 'parent', {}, 'p1');
    expect(first.status).toBe('suspended');

    // All three children were dispatched and are running (their ids are group-scoped + stable).
    await poll(async () =>
      ['p1.all.0.0', 'p1.all.0.1', 'p1.all.0.2'].every(
        async (id) => (await store.getRun(id)) != null,
      ),
    );
    await poll(async () => started.length === 3);
    expect((await store.getRun('p1.all.0.0')) != null).toBe(true);
    expect((await store.getRun('p1.all.0.1')) != null).toBe(true);
    expect((await store.getRun('p1.all.0.2')) != null).toBe(true);
  });

  it('the running placeholder checkpoints share one parallelGroup', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('handle', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      return 'done';
    });
    engine.register('parent', '1', async (ctx) => {
      return ctx.all('handle', [{ p: 'A' }, { p: 'B' }]);
    });

    await startRun(engine, 'parent', {}, 'p1');
    await poll(
      async () =>
        (await store.listCheckpoints('p1')).filter((c) => c.name.startsWith('signal:child:'))
          .length >= 2,
    );
    const placeholders = (await store.listCheckpoints('p1')).filter((c) =>
      c.name.startsWith('signal:child:'),
    );
    expect(placeholders.length).toBe(2);
    for (const p of placeholders) {
      expect(p.status).toBe('running');
      expect(p.kind).toBe('signal');
    }
    const groups = new Set(placeholders.map((p) => p.parallelGroup));
    expect(groups.size).toBe(1);
    expect([...groups][0]).toBe('all:0:n2');
  });

  it('returns all outputs in input order when all children complete (out of order)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    // Each child returns a value derived from its input, so we can assert input-order.
    engine.register('handle', '1', async (_ctx, input) => `out-${(input as { p: string }).p}`);
    engine.register('parent', '1', async (ctx) => {
      return ctx.all<string>('handle', [{ p: 'A' }, { p: 'B' }, { p: 'C' }]);
    });

    await startRun(engine, 'parent', {}, 'p1');
    await poll(async () => (await store.getRun('p1'))?.status === 'completed');
    expect((await store.getRun('p1'))?.output).toEqual(['out-A', 'out-B', 'out-C']);
  });

  it('a one-item all behaves like a single child', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('handle', '1', async (_ctx, input) => `out-${(input as { p: string }).p}`);
    engine.register('parent', '1', async (ctx) => {
      return ctx.all<string>('handle', [{ p: 'solo' }]);
    });

    await startRun(engine, 'parent', {}, 'p1');
    await poll(async () => (await store.getRun('p1'))?.status === 'completed');
    expect((await store.getRun('p1'))?.output).toEqual(['out-solo']);
  });

  it('empty inputs returns [] immediately, with no side effects', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let childRuns = 0;
    engine.register('handle', '1', async () => {
      childRuns += 1;
      return 'x';
    });
    engine.register('parent', '1', async (ctx) => {
      const before = await ctx.all<string>('handle', []);
      // A later child must keep its default id (no position consumed by the empty `all`).
      const id = await ctx.startChild('handle', {});
      return { before, id };
    });

    const res = await startRun(engine, 'parent', {}, 'p1');
    expect((res.output as { before: string[] }).before).toEqual([]);
    // The empty all reserved no positions: the later startChild gets position 0.
    expect((res.output as { id: string }).id).toBe('p1.child.0');
    // The empty all dispatched nothing: the only `handle` run is the explicit startChild one.
    expect(childRuns).toBeLessThanOrEqual(1);
    expect((await store.listRuns({ workflow: 'handle' })).map((r) => r.id)).toEqual(['p1.child.0']);
  });

  it('waitAll aggregates child failures into a GatherError', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('handle', '1', async (_ctx, input) => {
      const p = (input as { p: string }).p;
      if (p === 'bad') throw new Error('child boom');
      return `out-${p}`;
    });
    engine.register('parent', '1', async (ctx) => {
      return ctx.all('handle', [{ p: 'A' }, { p: 'bad' }, { p: 'C' }]);
    });

    await startRun(engine, 'parent', {}, 'p1');
    await poll(async () => (await store.getRun('p1'))?.status === 'failed');
    const err = (await store.getRun('p1'))?.error;
    expect(err?.message).toContain('1 of 3');
    expect(err?.message).toContain('p1.all.0.1');
  });

  it('failFast fails as soon as a failed child is seen', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('handle', '1', async (_ctx, input) => {
      const p = (input as { p: string }).p;
      if (p === 'bad') throw new Error('boom-fast');
      // A sibling that never resolves on its own — proves failFast didn't wait for it.
      await ctx_wait();
      return `out-${p}`;
      async function ctx_wait() {
        await (_ctx as { waitForSignal: (t: string) => Promise<unknown> }).waitForSignal('never');
      }
    });
    engine.register('parent', '1', async (ctx) => {
      return ctx.all('handle', [{ p: 'bad' }, { p: 'slow' }], { mode: 'failFast' });
    });

    await startRun(engine, 'parent', {}, 'p1');
    await poll(async () => (await store.getRun('p1'))?.status === 'failed');
    // failFast threw the aggregate GatherError naming the failed child, WITHOUT waiting on the
    // slow sibling (which parks forever on the 'never' signal).
    const err = (await store.getRun('p1'))?.error;
    expect(err?.message).toContain('p1.all.0.0'); // the bad child
    expect(err?.message).toContain('1 of 2');
  });

  it('failFast cancels the surviving unfinished siblings', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('handle', '1', async (_ctx, input) => {
      const p = (input as { p: string }).p;
      if (p === 'bad') throw new Error('boom-fast');
      // Parks forever on its own — if it ends up 'cancelled' rather than stuck 'running'/'suspended',
      // that's the parent's cancellation landing, not the child resolving on its own.
      await (_ctx as { waitForSignal: (t: string) => Promise<unknown> }).waitForSignal('never');
      return `out-${p}`;
    });
    engine.register('parent', '1', async (ctx) => {
      return ctx.all('handle', [{ p: 'bad' }, { p: 'slow' }], { mode: 'failFast' });
    });

    await startRun(engine, 'parent', {}, 'p1');
    await poll(async () => (await store.getRun('p1'))?.status === 'failed');
    // The still-suspended sibling gets cancelled shortly after (host.cancelChild is deferred via
    // queueMicrotask, so it lands on a later tick than the parent's own failure).
    await poll(async () => (await store.getRun('p1.all.0.1'))?.status === 'cancelled');
    expect((await store.getRun('p1.all.0.1'))?.status).toBe('cancelled');
  });

  it('waitAll does NOT cancel siblings — they run to completion', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('handle', '1', async (_ctx, input) => {
      const p = (input as { p: string }).p;
      if (p === 'bad') throw new Error('child boom');
      return `out-${p}`;
    });
    engine.register('parent', '1', async (ctx) => {
      return ctx.all('handle', [{ p: 'A' }, { p: 'bad' }, { p: 'C' }]);
    });

    await startRun(engine, 'parent', {}, 'p1');
    await poll(async () => (await store.getRun('p1'))?.status === 'failed');
    // Both non-failing siblings ran to completion, untouched — waitAll never cancels.
    expect((await store.getRun('p1.all.0.0'))?.status).toBe('completed');
    expect((await store.getRun('p1.all.0.2'))?.status).toBe('completed');
  });

  it('replaying after a failFast failure re-issues cancels safely (no throw)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('handle', '1', async (_ctx, input) => {
      const p = (input as { p: string }).p;
      if (p === 'bad') throw new Error('boom-fast');
      await (_ctx as { waitForSignal: (t: string) => Promise<unknown> }).waitForSignal('never');
      return `out-${p}`;
    });
    engine.register('parent', '1', async (ctx) => {
      return ctx.all('handle', [{ p: 'bad' }, { p: 'slow' }], { mode: 'failFast' });
    });

    await startRun(engine, 'parent', {}, 'p1');
    await poll(async () => (await store.getRun('p1'))?.status === 'failed');
    await poll(async () => (await store.getRun('p1.all.0.1'))?.status === 'cancelled');

    // `engine.resume` treats `failed` as non-terminal (a retry resumes it), so this replays the
    // workflow body from scratch: the failFast branch re-executes and re-issues `cancelChild` for
    // the ALREADY-cancelled sibling. That must be a safe no-op — `engine.cancel` is idempotent on a
    // terminal/cancelled run — not a throw.
    const replayed = await engine.resume('p1');
    expect(replayed.status).toBe('failed');
  });

  it('GatherError carries per-item failures', () => {
    const err = new GatherError([
      { index: 1, id: 'r.all.0.1', error: 'child boom' },
      { index: 2, id: 'r.all.0.2', error: 'other boom' },
    ]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GatherError');
    expect(err.failures).toHaveLength(2);
    expect(err.failures[0]).toEqual({ index: 1, id: 'r.all.0.1', error: 'child boom' });
    expect(err.message).toContain('2 of');
    expect(err.message).toContain('r.all.0.1');
    expect(err.message).toContain('r.all.0.2');
  });
});
