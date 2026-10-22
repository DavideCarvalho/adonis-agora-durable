import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
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

/** Give a class a registered name via a `static workflow` config (read by `workflowMeta`). */
function named<
  T extends abstract new (
    ...args: never[]
  ) => { run(ctx: never, input: never): unknown },
>(cls: T, name: string): T {
  Object.defineProperty(cls, 'workflow', { value: { name }, configurable: true });
  return cls;
}

describe('class-ref forms of child / startChild / start', () => {
  it('engine.start(Class) resolves the class to its registered name', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    class Greet {
      async run(_ctx: unknown, input: { name: string }) {
        return `hi ${input.name}`;
      }
    }
    named(Greet, 'greet');
    engine.register('greet', '1', async (_ctx, input) => `hi ${(input as { name: string }).name}`);

    const res = await startRun(engine, Greet, { name: 'davi' }, 'g1');
    expect(res.output).toBe('hi davi');
  });

  it('ctx.child(Class) resolves the class and resumes the parent with its output', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    class ChildWf {
      async run(): Promise<{ doubled: number }> {
        return { doubled: 42 };
      }
    }
    named(ChildWf, 'childwf');
    engine.register('childwf', '1', async () => ({ doubled: 42 }));
    engine.register('parent', '1', async (ctx) => {
      const r = await ctx.child(ChildWf, {});
      return r.doubled;
    });

    const first = await startRun(engine, 'parent', {}, 'p1');
    expect(first.status).toBe('suspended');
    await poll(async () => (await store.getRun('p1'))?.status === 'completed');
    expect((await store.getRun('p1'))?.output).toBe(42);
  });

  it('ctx.startChild(Class) is fire-and-forget: returns the child id and keeps running', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    class Audit {
      async run(): Promise<string> {
        return 'logged';
      }
    }
    named(Audit, 'audit');
    let childIdSeen: string | undefined;
    engine.register('audit', '1', async () => 'logged');
    engine.register('parent', '1', async (ctx) => {
      childIdSeen = await ctx.startChild(Audit, {}); // does NOT suspend
      return 'parent-done';
    });

    const res = await startRun(engine, 'parent', {}, 'p1');
    expect(res.status).toBe('completed'); // parent finished without waiting on the child
    expect(res.output).toBe('parent-done');
    expect(childIdSeen).toBe('p1.child.0'); // deterministic default child id

    await poll(async () => (await store.getRun('p1.child.0'))?.status === 'completed');
    expect((await store.getRun('p1.child.0'))?.output).toBe('logged');
  });

  it('startChild + child compose for scatter-gather (same id attaches, child runs once)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let runs = 0;
    engine.register('worker', '1', async () => {
      runs += 1;
      return 'work-result';
    });
    engine.register('parent', '1', async (ctx) => {
      const id = await ctx.startChild('worker', {}, 'shared-child'); // dispatch, don't wait
      const out = await ctx.child<string>('worker', {}, id); // later: join by the same id
      return out;
    });

    await startRun(engine, 'parent', {}, 'p1');
    await poll(async () => (await store.getRun('p1'))?.status === 'completed');
    expect((await store.getRun('p1'))?.output).toBe('work-result');
    expect(runs).toBe(1); // started once, not double-dispatched
  });

  it('shows the awaited child as a running placeholder while it runs (live in the parent)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    // A child that parks on a signal — stays running until we let it finish.
    engine.register('slowchild', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      return { done: true };
    });
    engine.register('par', '1', async (ctx) => {
      await ctx.child('slowchild', {}, 'par.child.0');
      return 'ok';
    });

    await startRun(engine, 'par', {}, 'par');
    // While the child runs, the parent carries a `running` signal:child placeholder (a live child node).
    await poll(async () =>
      (await store.listCheckpoints('par')).some(
        (c) => c.name === 'signal:child:par.child.0' && c.status === 'running',
      ),
    );
    const placeholder = (await store.listCheckpoints('par')).find(
      (c) => c.name === 'signal:child:par.child.0',
    );
    expect(placeholder?.status).toBe('running');
    expect(placeholder?.kind).toBe('signal');

    // Let the child finish — the placeholder is overwritten as completed and the parent resumes.
    await engine.signal('go', undefined);
    await poll(async () => (await store.getRun('par'))?.status === 'completed');
    const resolved = (await store.listCheckpoints('par')).find(
      (c) => c.name === 'signal:child:par.child.0',
    );
    expect(resolved?.status).toBe('completed');
  });

  it('keeps an awaited child in getRunChildren after it (and the parent) completes', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('slowchild', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      return { done: true };
    });
    engine.register('par', '1', async (ctx) => {
      await ctx.child('slowchild', {}, 'par.child.0');
      return 'ok';
    });

    await startRun(engine, 'par', {}, 'par');
    // While suspended on the live `child:` waiter, the edge is present.
    await poll(async () => (await engine.getRunChildren('par')).includes('par.child.0'));

    // Let the child finish — the live waiter is consumed, but the persisted `signal:child:`
    // checkpoint keeps the edge, so a completed parent still lists its child (regression: the
    // processing child used to vanish from the run view the moment it finished).
    await engine.signal('go', undefined);
    await poll(async () => (await store.getRun('par'))?.status === 'completed');
    expect(await engine.getRunChildren('par')).toContain('par.child.0');
  });
});
