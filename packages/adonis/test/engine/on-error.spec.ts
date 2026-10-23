import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { FatalError } from '../../src/errors.js';
import type {
  EngineEvent,
  HistoryEvent,
  WorkflowDecision,
  WorkflowExecutor,
  WorkflowRun,
} from '../../src/interfaces.js';
import { assertRoutes, type OnErrorInput, routeFor } from '../../src/on-error.js';
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

function setup() {
  const store = new InMemoryStateStore();
  const transport = new InMemoryTransport();
  const calls: Record<string, number> = {};
  const handle = (name: string, fn: (input: unknown) => Promise<unknown>) =>
    transport.handle(name, async (input: unknown) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return fn(input);
    });
  const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
  const settled = async (id: string) => {
    await until(async () => {
      const s = (await store.getRun(id))?.status;
      return s === 'completed' || s === 'failed';
    });
    return store.getRun(id);
  };
  return { store, transport, engine, calls, handle, settled };
}

const invalidLine = () => {
  throw new FatalError('line 3: amount is not a number', 'invalid_line');
};

describe('onError routes', () => {
  it('hands a matching failure to the handler workflow and completes with its output', async () => {
    const { engine, handle, settled, store } = setup();
    handle('validate', async () => invalidLine());
    const received: OnErrorInput[] = [];
    engine.register('line.invalid', '1', async (_ctx, input) => {
      received.push(input as OnErrorInput);
      return { failed: 1 };
    });
    engine.register('line', '1', async (ctx) => ctx.step('validate', {}), {
      onError: [{ code: 'invalid_line', workflow: 'line.invalid' }],
    });

    await startRun(engine, 'line', { n: 3 }, 'r');
    const run = await settled('r');

    expect(run?.status).toBe('completed');
    expect(run?.output).toEqual({ failed: 1 });
    expect(received).toEqual([
      {
        runId: 'r',
        workflow: 'line',
        input: { n: 3 },
        error: expect.objectContaining({
          message: 'line 3: amount is not a number',
          code: 'invalid_line',
        }),
      },
    ]);
    expect((await store.getRun('r.onError.0'))?.status).toBe('completed');
    const handoff = (await store.listCheckpoints('r')).find((c) => c.name.endsWith('r.onError.0'));
    expect(handoff).toMatchObject({ kind: 'signal', status: 'completed' });
  });

  it('fails the run as usual when no route matches its code', async () => {
    const { engine, handle, settled, store } = setup();
    handle('validate', async () => {
      throw new FatalError('DPAS timed out', 'upstream');
    });
    engine.register('line.invalid', '1', async () => 'handled');
    engine.register('line', '1', async (ctx) => ctx.step('validate', {}), {
      onError: [{ code: 'invalid_line', workflow: 'line.invalid' }],
    });

    await startRun(engine, 'line', {}, 'r');
    const run = await settled('r');

    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toContain('DPAS timed out');
    expect(await store.getRun('r.onError.0')).toBeNull();
  });

  it('prefers the route for the exact code over the catch-all', async () => {
    const { engine, handle, settled } = setup();
    handle('validate', async () => invalidLine());
    engine.register('by-code', '1', async () => 'by code');
    engine.register('catch-all', '1', async () => 'catch-all');
    engine.register('line', '1', async (ctx) => ctx.step('validate', {}), {
      onError: [{ workflow: 'catch-all' }, { code: 'invalid_line', workflow: 'by-code' }],
    });

    await startRun(engine, 'line', {}, 'r');
    expect((await settled('r'))?.output).toBe('by code');
  });

  it('routes a plain throw in the body to the catch-all', async () => {
    const { engine, settled } = setup();
    engine.register('catch-all', '1', async (_ctx, input) => ({
      caught: (input as OnErrorInput).error.message,
    }));
    engine.register(
      'line',
      '1',
      async () => {
        throw new Error('unexpected shape');
      },
      { onError: [{ workflow: 'catch-all' }] },
    );

    await startRun(engine, 'line', {}, 'r');
    expect((await settled('r'))?.output).toEqual({ caught: 'unexpected shape' });
  });

  it('fails the run with the handler error when the handler fails', async () => {
    const { engine, handle, settled } = setup();
    handle('validate', async () => invalidLine());
    engine.register('line.invalid', '1', async () => {
      throw new Error('dead-letter store is down');
    });
    engine.register('line', '1', async (ctx) => ctx.step('validate', {}), {
      onError: [{ code: 'invalid_line', workflow: 'line.invalid' }],
    });

    await startRun(engine, 'line', {}, 'r');
    const run = await settled('r');

    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toContain('dead-letter store is down');
  });

  it('does not re-dispatch the failed step when the run replays to take the outcome', async () => {
    const { engine, handle, settled, calls } = setup();
    handle('validate', async () => invalidLine());
    handle('deadLetter', async () => 'stored');
    engine.register('line.invalid', '1', async (ctx) => ctx.step('deadLetter', {}));
    engine.register('line', '1', async (ctx) => ctx.step('validate', {}, { retries: 3 }), {
      onError: [{ code: 'invalid_line', workflow: 'line.invalid' }],
    });

    await startRun(engine, 'line', {}, 'r');
    expect((await settled('r'))?.output).toBe('stored');
    expect(calls.validate).toBe(1);
  });

  it('still runs the saga compensations of the failed body before handing off', async () => {
    const { engine, handle, settled } = setup();
    handle('validate', async () => invalidLine());
    const undone: string[] = [];
    engine.register('line.invalid', '1', async () => 'handled');
    engine.register(
      'line',
      '1',
      async (ctx) => {
        await ctx.localStep('reserve', async () => 'ok', {
          compensate: async () => {
            undone.push('reserve');
          },
        });
        return ctx.step('validate', {});
      },
      { onError: [{ code: 'invalid_line', workflow: 'line.invalid' }] },
    );

    await startRun(engine, 'line', {}, 'r');
    expect((await settled('r'))?.output).toBe('handled');
    expect(undone).toEqual(['reserve']);
  });

  it('takes the outcome off the handler run when its wake was lost', async () => {
    const { engine, handle, settled, store } = setup();
    handle('validate', async () => invalidLine());
    engine.register('line.invalid', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      return 'handled late';
    });
    engine.register('line', '1', async (ctx) => ctx.step('validate', {}), {
      onError: [{ code: 'invalid_line', workflow: 'line.invalid' }],
    });

    await startRun(engine, 'line', {}, 'r');
    await until(async () => (await store.getRun('r.onError.0'))?.status === 'suspended');
    // Drop the failed run's waiter, as a crash between the handler settling and the wake would.
    await store.takeSignalWaiter('child:r.onError.0');
    await engine.signal('go', undefined);
    await settled('r.onError.0');
    expect((await store.getRun('r'))?.status).toBe('suspended');

    await engine.resume('r');
    const run = await settled('r');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('handled late');
  });

  it('never runs the body again once the failure is handed off, a resume included', async () => {
    const { engine, settled, store } = setup();
    let parses = 0;
    engine.register('line.invalid', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      return 'handled';
    });
    engine.register(
      'line',
      '1',
      async (ctx) =>
        ctx.localStep('parse', async () => {
          parses += 1;
          // A second run would succeed and complete the run with the body's output.
          if (parses === 1) throw new Error('flaky parse');
          return 'parsed';
        }),
      { onError: [{ workflow: 'line.invalid' }] },
    );

    await startRun(engine, 'line', {}, 'r');
    await until(async () => (await store.getRun('r.onError.0'))?.status === 'suspended');
    // A reconcile wake or a manual resume while the handler still runs.
    await engine.resume('r');
    expect((await store.getRun('r'))?.status).toBe('suspended');

    await engine.signal('go', undefined);
    const run = await settled('r');
    expect(run?.output).toBe('handled');
    expect(parses).toBe(1);
  });

  it('hands the handler the failure details, tags the run and emits run.routed', async () => {
    const { engine, handle, settled, store } = setup();
    handle('validate', async () => {
      throw new FatalError('line 3 is invalid', 'invalid_line', {
        issues: [{ path: ['amount'], message: 'Expected number' }],
      });
    });
    const received: OnErrorInput[] = [];
    engine.register('line.invalid', '1', async (_ctx, input) => {
      received.push(input as OnErrorInput);
      return 'handled';
    });
    engine.register('line', '1', async (ctx) => ctx.step('validate', {}), {
      tags: ['dpas'],
      onError: [{ code: 'invalid_line', workflow: 'line.invalid' }],
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    await startRun(engine, 'line', {}, 'r');
    const run = await settled('r');

    expect(received[0]?.error.details).toEqual({
      issues: [{ path: ['amount'], message: 'Expected number' }],
    });
    expect(run?.tags).toEqual(['dpas', 'onError:invalid_line']);
    expect(events.find((e) => e.type === 'run.routed')).toMatchObject({
      runId: 'r',
      name: 'line.invalid',
      error: expect.objectContaining({ code: 'invalid_line' }),
    });
    expect((await store.listCheckpoints('r')).find((c) => c.seq >= 1_000_000_000)?.name).toBe(
      'signal:child:r.onError.0',
    );
  });

  it('a retry runs the body again and retires the failed handoff', async () => {
    const { engine, settled, store } = setup();
    let bodies = 0;
    let handlers = 0;
    engine.register('line.invalid', '1', async () => {
      handlers += 1;
      if (handlers === 1) throw new Error('dead-letter store is down');
      return 'handled';
    });
    engine.register(
      'line',
      '1',
      async () => {
        bodies += 1;
        if (bodies < 3) throw new FatalError('bad line', 'invalid_line');
        return 'ingested';
      },
      { onError: [{ code: 'invalid_line', workflow: 'line.invalid' }] },
    );

    await startRun(engine, 'line', {}, 'r');
    expect((await settled('r'))?.status).toBe('failed');

    // The body fails again: a fresh handoff, to a fresh handler run.
    await engine.requeue('r');
    await until(async () => (await store.getRun('r'))?.status === 'completed');
    expect((await store.getRun('r'))?.output).toBe('handled');
    expect(bodies).toBe(2);
    expect((await store.getRun('r.onError.0'))?.status).toBe('failed');
    expect((await store.getRun('r.onError.1'))?.status).toBe('completed');
    expect(
      (await store.listCheckpoints('r')).filter((c) => c.seq >= 1_000_000_000).map((c) => c.name),
    ).toEqual(['onError:retried:r.onError.0', 'signal:child:r.onError.1']);
  });

  it('a retry whose body now succeeds completes with the body output', async () => {
    const { engine, settled, store } = setup();
    let bodies = 0;
    engine.register('line.invalid', '1', async () => {
      throw new Error('dead-letter store is down');
    });
    engine.register(
      'line',
      '1',
      async () => {
        bodies += 1;
        if (bodies === 1) throw new FatalError('bad line', 'invalid_line');
        return 'ingested';
      },
      { onError: [{ code: 'invalid_line', workflow: 'line.invalid' }] },
    );

    await startRun(engine, 'line', {}, 'r');
    expect((await settled('r'))?.status).toBe('failed');
    await engine.requeue('r');
    await until(async () => (await store.getRun('r'))?.status === 'completed');

    expect((await store.getRun('r'))?.output).toBe('ingested');
    // The run no longer ended through a handler, so it no longer carries the handoff's tag.
    expect((await store.getRun('r'))?.tags ?? []).not.toContain('onError:invalid_line');
  });

  it('keeps ctx.all over the workflow from failing the parent', async () => {
    const { engine, handle, settled } = setup();
    handle('validate', async (input) => {
      if ((input as { i: number }).i === 1) invalidLine();
      return { ok: 1, failed: 0 };
    });
    engine.register('line.invalid', '1', async () => ({ ok: 0, failed: 1 }));
    engine.register('line', '1', async (ctx, input) => ctx.step('validate', input), {
      onError: [{ code: 'invalid_line', workflow: 'line.invalid' }],
    });
    engine.register('file', '1', async (ctx) => ctx.all('line', [{ i: 0 }, { i: 1 }, { i: 2 }]));

    await startRun(engine, 'file', {}, 'f');
    const run = await settled('f');

    expect(run?.status).toBe('completed');
    expect(run?.output).toEqual([
      { ok: 1, failed: 0 },
      { ok: 0, failed: 1 },
      { ok: 1, failed: 0 },
    ]);
  });

  it('routes the failure of a remote workflow, whose body the engine never sees', async () => {
    const { engine, settled } = setup();
    const turns: number[][] = [];
    // Stand-in for a Python body: it records a failed step, then fails the turn with its error.
    const executor: WorkflowExecutor = {
      async advance(run: WorkflowRun, history: HistoryEvent[]): Promise<WorkflowDecision> {
        turns.push(history.map((e) => e.seq));
        const error = { message: 'bad line', code: 'invalid_line', retryable: false };
        return {
          taskId: 't',
          runId: run.id,
          status: 'failed',
          commands: [{ kind: 'recordStep' as const, seq: 0, name: 'validate', error }],
          error,
        };
      },
    };
    engine.register('line.invalid', '1', async (_ctx, input) => ({
      deadLettered: (input as OnErrorInput).error.code,
    }));
    engine.registerRemote('py-line', '1', {
      group: 'py',
      executor,
      onError: [{ code: 'invalid_line', workflow: 'line.invalid' }],
    });

    await startRun(engine, 'py-line', {}, 'r');
    const run = await settled('r');

    expect(run?.status).toBe('completed');
    expect(run?.output).toEqual({ deadLettered: 'invalid_line' });
    // One turn: once the failure is handed off, the body is never dispatched again.
    expect(turns).toEqual([[]]);
  });
});

describe('unservedOnErrorRoutes', () => {
  it('lists the routes whose handler nothing here or in the fleet can run', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    engine.register('line.invalid', '1', async () => 'handled');
    engine.register('line', '1', async () => 'ok', {
      onError: [{ code: 'invalid_line', workflow: 'line.invalid' }, { workflow: 'line.typo' }],
    });

    expect(await engine.unservedOnErrorRoutes()).toEqual([
      { workflow: 'line', route: { workflow: 'line.typo' } },
    ]);
  });
});

describe('routeFor', () => {
  it('never routes a broken deploy or a ctx misuse, even to a catch-all', () => {
    const routes = [{ workflow: 'catch-all' }];
    expect(routeFor(routes, { message: 'x', code: 'non_determinism' })).toBeUndefined();
    expect(routeFor(routes, { message: 'x', code: 'nested_workflow_call' })).toBeUndefined();
    expect(routeFor(routes, { message: 'x' })).toEqual({ workflow: 'catch-all' });
  });
  it('sends invalid_input and invalid_output to a schema_validation route, after their own', () => {
    const family = [{ code: 'schema_validation', workflow: 'schema' }, { workflow: 'catch-all' }];
    expect(routeFor(family, { message: 'x', code: 'invalid_input' })).toEqual(family[0]);
    expect(routeFor(family, { message: 'x', code: 'invalid_output' })).toEqual(family[0]);
    expect(routeFor(family, { message: 'x', code: 'boom' })).toEqual(family[1]);

    const exact = [
      { code: 'schema_validation', workflow: 'schema' },
      { code: 'invalid_input', workflow: 'input' },
    ];
    expect(routeFor(exact, { message: 'x', code: 'invalid_input' })).toEqual(exact[1]);
    expect(routeFor(exact, { message: 'x', code: 'invalid_output' })).toEqual(exact[0]);
  });
});

describe('assertRoutes', () => {
  it('rejects two routes for one code, or two catch-alls', () => {
    expect(() =>
      assertRoutes('line', [
        { code: 'a', workflow: 'x' },
        { code: 'a', workflow: 'y' },
      ]),
    ).toThrow('code "a"');
    expect(() => assertRoutes('line', [{ workflow: 'x' }, { workflow: 'y' }])).toThrow(
      'without a code',
    );
  });
});
