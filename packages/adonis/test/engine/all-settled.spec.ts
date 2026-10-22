import { describe, expect, it } from 'vitest';
import { isWorkflowControlFlowSignal } from '../../src/control-flow-signal.js';
import { WorkflowEngine } from '../../src/engine.js';
import { FatalError } from '../../src/errors.js';
import { allGroup, stepFanGroup } from '../../src/fan-join.js';
import type { Settled } from '../../src/interfaces.js';
import {
  DURABLE_STEP_CONFIG,
  DURABLE_STEP_NAME,
  type StepConfig,
  type StepRef,
} from '../../src/step-name-symbol.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

async function until(check: () => boolean | Promise<boolean>, max = 2000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

/** Stamp a plain function as a `@Step` reference, as the `@Step` decorator does. */
function stepRef<TInput, TOutput>(name: string, config?: StepConfig): StepRef<TInput, TOutput> {
  const ref = (() => {}) as unknown as StepRef<TInput, TOutput>;
  (ref as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = name;
  if (config) (ref as { [DURABLE_STEP_CONFIG]?: StepConfig })[DURABLE_STEP_CONFIG] = config;
  return ref;
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

/** A child that fails for the given indexes and returns `i * 10` otherwise. */
function childFan(bad: number[]) {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  engine.register('line', '1', async (_ctx, input) => {
    const { i } = input as { i: number };
    if (bad.includes(i)) throw new FatalError(`bad line ${i}`);
    return i * 10;
  });
  return { store, engine };
}

describe('ctx.allSettled', () => {
  it('resolves with every outcome in input order and completes the parent', async () => {
    const { store, engine } = childFan([1, 3]);
    engine.register('file', '1', async (ctx) => ctx.allSettled<number>('line', lines(5)));

    await startRun(engine, 'file', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual([
      { status: 'fulfilled', value: 0 },
      { status: 'rejected', id: 'p.all.0.1', error: expect.stringContaining('bad line 1') },
      { status: 'fulfilled', value: 20 },
      { status: 'rejected', id: 'p.all.0.3', error: expect.stringContaining('bad line 3') },
      { status: 'fulfilled', value: 40 },
    ]);
  });

  it("carries a failed child's code and details, so the parent can tell failures apart", async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('line', '1', async (_ctx, input) => {
      const { i } = input as { i: number };
      if (i === 0) throw new FatalError('bad line', 'invalid_line', { field: 'amount' });
      if (i === 1) throw new Error('DPAS down');
      return i;
    });
    engine.register('file', '1', async (ctx) => ctx.allSettled<number>('line', lines(3)));

    await startRun(engine, 'file', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    const [invalid, down] = ((await store.getRun('p'))?.output ?? []) as Settled<number>[];
    expect(invalid).toMatchObject({
      status: 'rejected',
      code: 'invalid_line',
      details: { field: 'amount' },
    });
    expect(down).toMatchObject({ status: 'rejected', error: expect.stringContaining('DPAS down') });
    expect(down).not.toHaveProperty('code');
  });

  it("hands a failed ctx.child's code to the parent's catch", async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('line', '1', async () => {
      throw new FatalError('bad line', 'invalid_line', { field: 'amount' });
    });
    engine.register('file', '1', async (ctx) => {
      try {
        return await ctx.child('line', {});
      } catch (err) {
        if (isWorkflowControlFlowSignal(err)) throw err;
        const e = err as FatalError;
        return { code: e.code, details: e.details };
      }
    });

    await startRun(engine, 'file', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual({
      code: 'invalid_line',
      details: { field: 'amount' },
    });
  });

  it('runs on past the fan, so the parent can act on the failures', async () => {
    const { store, engine } = childFan([2]);
    engine.register('file', '1', async (ctx) => {
      const results = await ctx.allSettled<number>('line', lines(4));
      const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [i] : []));
      const after = await ctx.child<number>('line', { i: 9 });
      return { failed, after };
    });

    await startRun(engine, 'file', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual({ failed: [2], after: 90 });
  });

  it('settles a concurrency-limited fan wave by wave', async () => {
    const { store, engine } = childFan([0, 7]);
    engine.register('file', '1', async (ctx) =>
      ctx.allSettled<number>('line', lines(10), { concurrency: 4 }),
    );

    await startRun(engine, 'file', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    const out = (await store.getRun('p'))?.output as Settled<number>[];
    expect(out.map((r) => r.status)).toEqual(
      lines(10).map(({ i }) => (i === 0 || i === 7 ? 'rejected' : 'fulfilled')),
    );
    expect(out[4]).toEqual({ status: 'fulfilled', value: 40 });
  });

  it('keeps the outcomes of a fan wide enough to fold its successful waves', async () => {
    const { store, engine } = childFan([150]);
    engine.register('file', '1', async (ctx) =>
      ctx.allSettled<number>('line', lines(200), { concurrency: 100 }),
    );

    await startRun(engine, 'file', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed', 5000);

    const out = (await store.getRun('p'))?.output as Settled<number>[];
    expect(out).toHaveLength(200);
    expect(out.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(out[150]?.status).toBe('rejected');
    expect(out[199]).toEqual({ status: 'fulfilled', value: 1990 });
  });

  it('returns [] for empty inputs without reserving a position', async () => {
    const { store, engine } = childFan([]);
    engine.register('file', '1', async (ctx) => {
      const none = await ctx.allSettled('line', []);
      const id = await ctx.startChild('line', { i: 1 });
      return { none, id };
    });

    await startRun(engine, 'file', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual({ none: [], id: 'p.child.0' });
  });

  it('lays the fan out like ctx.all, so the dashboard groups it the same way', async () => {
    const { store, engine } = childFan([1]);
    engine.register('file', '1', async (ctx) => ctx.allSettled('line', lines(3)));

    await startRun(engine, 'file', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    const groups = new Set(
      (await store.listCheckpoints('p'))
        .filter((c) => c.name.startsWith('signal:child:'))
        .map((c) => c.parallelGroup),
    );
    // A settled fan waits for every child, so it is a waitAll group: no `:failFast` suffix.
    expect(groups).toEqual(new Set([allGroup(0, 3, 'waitAll')]));
  });
});

describe('ctx.allSettled over a @Step', () => {
  const LINE = 'Lines.validate';

  function stepFan(handler: (input: { i: number }) => Promise<number>) {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    const calls: number[] = [];
    transport.handle(LINE, async (input) => {
      const line = input as { i: number };
      calls.push(line.i);
      return handler(line);
    });
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    return { store, engine, calls };
  }

  it('resolves with every outcome in input order', async () => {
    const { store, engine } = stepFan(async ({ i }) => {
      if (i === 2) throw new Error('bad line 2');
      return i;
    });
    const validate = stepRef<{ i: number }, number>(LINE);
    engine.register('file', '1', async (ctx) => ctx.allSettled(validate, lines(4)));

    await startRun(engine, 'file', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual([
      { status: 'fulfilled', value: 0 },
      { status: 'fulfilled', value: 1 },
      { status: 'rejected', id: expect.any(String), error: expect.stringContaining('bad line 2') },
      { status: 'fulfilled', value: 3 },
    ]);
  });

  it('rejects a FatalError item without spending its retries', async () => {
    const { store, engine, calls } = stepFan(async ({ i }) => {
      if (i === 1) throw new FatalError('schema mismatch', 'invalid');
      return i;
    });
    const validate = stepRef<{ i: number }, number>(LINE, { retries: 3 });
    engine.register('file', '1', async (ctx) => ctx.allSettled(validate, lines(3)));

    await startRun(engine, 'file', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    const out = (await store.getRun('p'))?.output as Settled<number>[];
    expect(out[1]).toMatchObject({ status: 'rejected', error: 'schema mismatch' });
    expect(calls.filter((i) => i === 1)).toHaveLength(1);
  });

  it("carries a failed step's code and details", async () => {
    const { store, engine } = stepFan(async ({ i }) => {
      if (i === 1) throw new FatalError('schema mismatch', 'invalid', { path: ['amount'] });
      return i;
    });
    const validate = stepRef<{ i: number }, number>(LINE);
    engine.register('file', '1', async (ctx) => ctx.allSettled(validate, lines(2)));

    await startRun(engine, 'file', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    const [, invalid] = ((await store.getRun('p'))?.output ?? []) as Settled<number>[];
    expect(invalid).toMatchObject({
      status: 'rejected',
      code: 'invalid',
      details: { path: ['amount'] },
    });
  });

  it('settles a concurrency-limited step fan and continues past it', async () => {
    const { store, engine } = stepFan(async ({ i }) => {
      if (i % 5 === 0) throw new Error(`bad line ${i}`);
      return i;
    });
    const validate = stepRef<{ i: number }, number>(LINE);
    engine.register('file', '1', async (ctx) => {
      const results = await ctx.allSettled(validate, lines(12), { concurrency: 3 });
      const after = await ctx.step<number>(LINE, { i: 7 });
      return { rejected: results.filter((r) => r.status === 'rejected').length, after };
    });

    await startRun(engine, 'file', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual({ rejected: 3, after: 7 });
  });

  it('settles even though a mode would ask to fail fast', async () => {
    const { store, engine } = stepFan(async ({ i }) => {
      if (i === 0) throw new FatalError('bad line 0');
      return i;
    });
    const validate = stepRef<{ i: number }, number>(LINE);
    engine.register('file', '1', async (ctx) =>
      // `mode` is not part of the settled options; a caller bypassing the type still gets waitAll.
      ctx.allSettled(validate, lines(3), { mode: 'failFast' } as never),
    );

    await startRun(engine, 'file', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    const out = (await store.getRun('p'))?.output as Settled<number>[];
    expect(out.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    const groups = new Set(
      (await store.listCheckpoints('p')).filter((c) => c.name === LINE).map((c) => c.parallelGroup),
    );
    expect(groups).toEqual(new Set([stepFanGroup(0, 3, 'waitAll')]));
  });
});
