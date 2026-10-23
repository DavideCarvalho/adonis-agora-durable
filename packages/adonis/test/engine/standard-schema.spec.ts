import { type } from 'arktype';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BaseWorkflow } from '../../src/base-workflow.js';
import { WorkflowEngine } from '../../src/engine.js';
import { SchemaValidationError } from '../../src/errors.js';
import type { InferSearchAttributes, SearchAttributes, WorkflowCtx } from '../../src/interfaces.js';
import { attributesOf, readSearchAttributes } from '../../src/search-attributes-schema.js';
import type { StandardSchemaV1 } from '../../src/standard-schema.js';
import { validateStandard } from '../../src/standard-schema.js';
import { collectSteps, registerStep } from '../../src/step-discovery.js';
import { defineStep } from '../../src/step-ref.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';
import { registerWorkflowClass } from '../../src/workflow-discovery.js';

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended' && run.status !== 'pending') {
      return run;
    }
  }
  throw new Error(`run ${runId} did not settle`);
}

/** A hand-rolled Standard Schema whose `validate` is ASYNC — the spec allows it. */
function asyncPositive(): StandardSchemaV1<unknown, number> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test-async',
      validate: async (value) => {
        await new Promise((r) => setImmediate(r));
        return typeof value === 'number' && value > 0
          ? { value }
          : { issues: [{ message: 'must be a positive number', path: [{ key: 'n' }] }] };
      },
    },
  };
}

/** Serve one `defineStep` on a fresh transport and run a one-step workflow calling it by name. */
async function runStep(step: unknown, input: unknown, opts?: { retries?: number }) {
  const store = new InMemoryStateStore();
  const transport = new InMemoryTransport();
  const [discovered] = collectSteps(step);
  registerStep(transport, discovered!);
  const engine = new WorkflowEngine({ store, transport });
  engine.register('wf', '1', async (ctx) =>
    ctx.step(discovered!.meta.name, input, opts?.retries ? { retries: opts.retries } : {}),
  );
  await engine.start('wf', {}, 'run1');
  const run = await settle(store, 'run1');
  const checkpoints = await store.listCheckpoints('run1');
  return { run, step: checkpoints.find((c) => c.name === discovered!.meta.name) };
}

describe('validateStandard', () => {
  it('returns the OUTPUT value of a sync schema (valibot transform)', async () => {
    const schema = v.pipe(v.string(), v.transform(Number));
    await expect(validateStandard(schema, '42', 'x')).resolves.toBe(42);
  });

  it('awaits an async `validate` and throws SchemaValidationError with JSON-safe issues', async () => {
    await expect(validateStandard(asyncPositive(), 3, 'x')).resolves.toBe(3);
    const err = await validateStandard(asyncPositive(), -1, 'thing').catch((e) => e);
    expect(err).toBeInstanceOf(SchemaValidationError);
    expect(err.code).toBe('schema_validation');
    expect(err.retryable).toBe(false);
    expect(err.issues).toEqual([{ message: 'must be a positive number', path: ['n'] }]);
    expect(err.details).toEqual({ issues: err.issues });
    expect(err.message).toBe('invalid thing: n: must be a positive number');
  });
});

describe('step schemas — any Standard Schema', () => {
  it('valibot: the handler receives the input schema OUTPUT (coerced)', async () => {
    let seen: unknown;
    const step = defineStep(
      'v:double',
      async (input) => {
        seen = input;
        return input.n * 2;
      },
      { input: v.object({ n: v.pipe(v.string(), v.transform(Number)) }) },
    );
    const { run } = await runStep(step, { n: '21' });
    expect(run.status).toBe('completed');
    expect(seen).toEqual({ n: 21 });
    expect(run.output).toBe(42);
  });

  it('valibot: a bad input fails the step NON-retryably with the issues in details', async () => {
    let calls = 0;
    const step = defineStep(
      'v:strict',
      async (input) => {
        calls += 1;
        return input.n;
      },
      { input: v.object({ n: v.number() }) },
    );
    const { run, step: cp } = await runStep(step, { n: 'nope' }, { retries: 5 });
    expect(run.status).toBe('failed');
    expect(calls).toBe(0); // body never ran
    expect(cp?.attempts).toBe(1); // not retried despite retries: 5
    expect(cp?.error?.code).toBe('invalid_input');
    expect(cp?.error?.retryable).toBe(false);
    expect(cp?.error?.details).toMatchObject({ issues: [{ path: ['n'] }] });
    expect(run.error?.code).toBe('invalid_input');
  });

  it('valibot: the output schema validates (and transforms) the result', async () => {
    const ok = defineStep('v:out', async (_input: unknown) => '7', {
      output: v.pipe(v.string(), v.transform(Number)),
    });
    expect((await runStep(ok, {})).run.output).toBe(7);

    const bad = defineStep('v:out-bad', async (_input: unknown) => 'x' as unknown as number, {
      output: v.number(),
    });
    const { run, step: cp } = await runStep(bad, {}, { retries: 3 });
    expect(run.status).toBe('failed');
    expect(cp?.attempts).toBe(1);
    expect(cp?.error?.code).toBe('invalid_output');
    expect(cp?.error?.message).toMatch(/^invalid step "v:out-bad" output: /);
  });

  it('arktype: input + output schemas', async () => {
    const step = defineStep('a:greet', async (input) => `hi ${input.name}`, {
      input: type({ name: 'string' }),
      output: type('string'),
    });
    expect((await runStep(step, { name: 'ana' })).run.output).toBe('hi ana');
    const { run, step: cp } = await runStep(step, { name: 1 }, { retries: 3 });
    expect(run.status).toBe('failed');
    expect(cp?.attempts).toBe(1);
    expect(cp?.error?.code).toBe('invalid_input');
  });

  it('async validate: awaited at the serve boundary', async () => {
    const step = defineStep('async:n', async (input) => input + 1, { input: asyncPositive() });
    expect((await runStep(step, 1)).run.output).toBe(2);
    const { run, step: cp } = await runStep(step, -5, { retries: 3 });
    expect(run.status).toBe('failed');
    expect(cp?.attempts).toBe(1);
    expect(cp?.error?.details).toEqual({
      issues: [{ message: 'must be a positive number', path: ['n'] }],
    });
  });

  it('zod 4 keeps working unchanged (native ~standard)', async () => {
    const step = defineStep('z:n', async (input) => input.n.toUpperCase(), {
      input: z.object({ n: z.string() }),
    });
    expect((await runStep(step, { n: 'a' })).run.output).toBe('A');
    const { run } = await runStep(step, { n: 1 });
    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('invalid_input');
  });
});

describe('workflow inputSchema', () => {
  it('valibot: rejects before a run is created; stores the input as sent; then validateInput', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const order: string[] = [];
    let received: unknown;
    engine.register(
      'checkout',
      '1',
      async (_ctx, input) => {
        received = input;
        return 'ok';
      },
      {
        inputSchema: v.object({ qty: v.pipe(v.string(), v.transform(Number)) }),
        validateInput: (input) => {
          order.push(`validateInput:${JSON.stringify(input)}`);
        },
      },
    );

    const err = await engine.start('checkout', { qty: 3 }, 'bad').catch((e) => e);
    expect(err).toBeInstanceOf(SchemaValidationError);
    expect(err.message).toMatch(/^invalid workflow "checkout" input: qty: /);
    expect(err.code).toBe('invalid_input');
    expect(await store.getRun('bad')).toBeNull();
    expect(order).toEqual([]); // the schema runs first; validateInput never saw the bad payload

    const ok = await startRun(engine, 'checkout', { qty: '3' }, 'good');
    expect(ok.status).toBe('completed');
    expect(received).toEqual({ qty: 3 }); // the body gets the schema's OUTPUT…
    expect((await store.getRun('good'))?.input).toEqual({ qty: '3' }); // …the run keeps what was sent
    expect(order).toEqual(['validateInput:{"qty":3}']); // sees the parsed value
  });

  it('arktype + async schema on register', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('a', '1', async () => 'ok', { inputSchema: type({ id: 'string' }) });
    engine.register('b', '1', async () => 'ok', { inputSchema: asyncPositive() });
    await expect(engine.start('a', { id: 1 }, 'a1')).rejects.toBeInstanceOf(SchemaValidationError);
    await expect(engine.start('b', -1, 'b1')).rejects.toBeInstanceOf(SchemaValidationError);
    expect((await startRun(engine, 'a', { id: 'x' }, 'a2')).status).toBe('completed');
    expect((await startRun(engine, 'b', 2, 'b2')).status).toBe('completed');
  });

  it('registerRemote: rejects before anything is dispatched', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let dispatched = 0;
    engine.registerRemote('py', '1', {
      group: 'py',
      executor: {
        dispatch: async () => {
          dispatched += 1;
        },
      } as never,
      inputSchema: v.object({ id: v.string() }),
    });
    await expect(engine.start('py', { id: 1 }, 'p1')).rejects.toBeInstanceOf(SchemaValidationError);
    expect(await store.getRun('p1')).toBeNull();
    expect(dispatched).toBe(0);
  });

  it('BaseWorkflow static workflow = { inputSchema } via discovery', async () => {
    class Ship extends BaseWorkflow {
      static override workflow = {
        name: 'ship',
        inputSchema: v.object({ to: v.pipe(v.string(), v.trim()) }),
      };
      async run(_ctx: WorkflowCtx, input: { to: string }) {
        return input.to;
      }
    }
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    await registerWorkflowClass(engine, Ship);
    await expect(engine.start('ship', { to: 5 }, 's1')).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
    const ok = await startRun(engine, 'ship', { to: '  lisbon ' }, 's2');
    expect(ok.output).toBe('lisbon');
  });

  it('an onEvent subscriber whose schema rejects the payload just does not start', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('strict', '1', async () => 'ok', {
      onEvent: ['order.placed'],
      inputSchema: v.object({ id: v.string() }),
    });
    engine.register('loose', '1', async () => 'ok', { onEvent: ['order.placed'] });
    const touched = await engine.publishEvent('order.placed', { id: 1 }, { id: 'e1' });
    expect(touched).toBe(1); // only `loose`
    expect(await store.getRun('evt:e1:strict')).toBeNull();
    expect(await store.getRun('evt:e1:loose')).not.toBeNull();
  });
});

describe('typed search attributes', () => {
  const orderAttrs = v.object({
    tier: v.picklist(['free', 'pro']),
    amount: v.optional(v.number()),
  });
  type OrderAttrs = InferSearchAttributes<typeof orderAttrs>;

  it('accepts a conforming write, validating the MERGED attributes', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register(
      'checkout',
      '1',
      async (ctx) => {
        const typed = ctx as unknown as WorkflowCtx<OrderAttrs>;
        await typed.upsertSearchAttributes({ tier: 'pro' });
        await typed.upsertSearchAttributes({ amount: 10 }); // `tier` already on the run → merged OK
        return 'ok';
      },
      { searchAttributesSchema: orderAttrs },
    );
    const run = await startRun(engine, 'checkout', {}, 'r1');
    expect(run.status).toBe('completed');
    expect((await store.getRun('r1'))?.searchAttributes).toEqual({ tier: 'pro', amount: 10 });
  });

  it('rejects a non-conforming write: nothing written, run fails with SchemaValidationError', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register(
      'checkout',
      '1',
      async (ctx) => {
        await ctx.upsertSearchAttributes({ amount: 5 }); // merged result lacks the required `tier`
        return 'ok';
      },
      { searchAttributesSchema: orderAttrs },
    );
    await engine.start('checkout', {}, 'r1');
    const run = await settle(store, 'r1');
    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('schema_validation');
    expect(run.error?.message).toMatch(/upsertSearchAttributes.*tier/);
    expect(run.searchAttributes ?? {}).toEqual({});
    const recorded = (await store.listCheckpoints('r1')).filter(
      (c) => c.name === 'searchAttributes',
    );
    expect(recorded).toHaveLength(0);
  });

  it('requires a synchronous schema (replay determinism)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const asyncAttrs: StandardSchemaV1<unknown, SearchAttributes> = {
      '~standard': {
        version: 1,
        vendor: 't',
        validate: async (value) => ({ value: value as never }),
      },
    };
    engine.register(
      'w',
      '1',
      async (ctx) => {
        await ctx.upsertSearchAttributes({ a: 1 });
      },
      { searchAttributesSchema: asyncAttrs },
    );
    await engine.start('w', {}, 'r1');
    const run = await settle(store, 'r1');
    expect(run.status).toBe('failed');
    expect(run.error?.message).toMatch(/must be synchronous/);
  });

  it('BaseWorkflow static searchAttributes (arktype) + attributesOf typed read', async () => {
    const attrs = type({ region: "'eu' | 'us'", 'priority?': 'number' });
    class Fulfil extends BaseWorkflow {
      static override workflow = { name: 'fulfil', searchAttributes: attrs };
      async run(ctx: WorkflowCtx<InferSearchAttributes<typeof attrs>>, input: { bad: boolean }) {
        await ctx.upsertSearchAttributes(
          input.bad ? ({ region: 'mars' } as never) : { region: 'eu', priority: 2 },
        );
        return 'ok';
      }
    }
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    await registerWorkflowClass(engine, Fulfil);

    expect((await startRun(engine, 'fulfil', { bad: false }, 'ok')).status).toBe('completed');
    const read = attributesOf(Fulfil, (await store.getRun('ok')) ?? {});
    expect(read).toEqual({ region: 'eu', priority: 2 });

    await engine.start('fulfil', { bad: true }, 'bad');
    expect((await settle(store, 'bad')).error?.code).toBe('schema_validation');

    // Lenient read of history that predates/violates the schema.
    expect(readSearchAttributes(attrs, { searchAttributes: { region: 'mars' } })).toEqual({});
    expect(readSearchAttributes(attrs, { searchAttributes: null })).toEqual({});
  });

  it('attributesOf throws for a workflow without a schema', () => {
    class Plain extends BaseWorkflow {
      static override workflow = { name: 'plain' };
      async run() {}
    }
    expect(() => attributesOf(Plain, {})).toThrow(/declares no searchAttributes schema/);
  });
});
