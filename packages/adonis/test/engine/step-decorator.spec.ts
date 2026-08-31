import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WorkflowEngine } from '../../src/engine.js';
import { collectSteps, registerStep, registerSteps } from '../../src/step-discovery.js';
import { stepConfigOf, stepNameOf } from '../../src/step-name-symbol.js';
import { defineStep, Step, stepMetaOf } from '../../src/step-ref.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('@Step decorator', () => {
  it('derives the routing name as Class.method for a bare @Step()', () => {
    class Billing {
      @Step()
      charge(input: { amount: number }) {
        return { chargeId: `ch_${input.amount}` };
      }
    }
    const ref = Billing.prototype.charge;
    expect(stepNameOf(ref)).toBe('Billing.charge');
    expect(stepMetaOf(ref)?.name).toBe('Billing.charge');
    // A bare @Step() stamps no dispatch policy.
    expect(stepConfigOf(ref)).toBeUndefined();
  });

  it('takes an explicit string name override', () => {
    class Svc {
      @Step('payments:capture')
      capture() {
        return 1;
      }
    }
    expect(stepNameOf(Svc.prototype.capture)).toBe('payments:capture');
  });

  it('stamps the def-level dispatch policy and zod schemas from the object form', () => {
    class Svc {
      @Step({
        name: 'x:y',
        input: z.object({ n: z.number() }),
        output: z.number(),
        retries: 4,
        backoff: 'exp',
        timeoutMs: 250,
      })
      run() {
        return 1;
      }
    }
    const ref = Svc.prototype.run;
    expect(stepNameOf(ref)).toBe('x:y');
    expect(stepConfigOf(ref)).toEqual({ retries: 4, backoff: 'exp', timeoutMs: 250 });
    const meta = stepMetaOf(ref);
    expect(meta?.input).toBeDefined();
    expect(meta?.output).toBeDefined();
  });
});

describe('defineStep', () => {
  it('stamps name + config and returns a usable typed ref', () => {
    const charge = defineStep('billing:charge', async (input: { amount: number }) => input.amount, {
      retries: 2,
    });
    expect(stepNameOf(charge)).toBe('billing:charge');
    expect(stepConfigOf(charge)).toEqual({ retries: 2 });
  });
});

describe('step discovery', () => {
  it('collects a @Step class into bound handlers and a defineStep into one handler', () => {
    class Svc {
      base = 10;
      @Step('svc:add')
      add(input: { n: number }) {
        return this.base + input.n;
      }
    }
    const fromClass = collectSteps(Svc);
    expect(fromClass).toHaveLength(1);
    expect(fromClass[0]?.meta.name).toBe('svc:add');

    const ref = defineStep('fn:one', async () => 1);
    const fromFn = collectSteps(ref);
    expect(fromFn).toHaveLength(1);
    expect(fromFn[0]?.meta.name).toBe('fn:one');
  });

  it('serves a discovered @Step handler by name so ctx.step routes to it end-to-end', async () => {
    class Billing {
      @Step('payments:charge')
      charge(input: { amount: number }) {
        return { chargeId: `ch_${input.amount}` };
      }
    }
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    registerSteps(transport, [Billing]);

    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (ctx) => {
      const c = await ctx.step(Billing.prototype.charge, { amount: 42 });
      return c.chargeId;
    });

    await startRun(engine, 'checkout', {}, 'run1');
    const run = await settle(store, 'run1');
    expect(run.status).toBe('completed');
    expect(run.output).toBe('ch_42');
  });

  it('validates input/output at the serve boundary from the stamped zod schemas', async () => {
    const bad = defineStep(
      'svc:strict',
      // returns a string, but the output schema says number → should fail at the serve boundary
      async (_input: { n: number }) => 'not-a-number' as unknown as number,
      { input: z.object({ n: z.number() }), output: z.number() },
    );
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    registerStep(transport, collectSteps(bad)[0]!);

    const engine = new WorkflowEngine({ store, transport });
    engine.register('wf', '1', async (ctx) => ctx.step('svc:strict', { n: 1 }));
    await startRun(engine, 'wf', {}, 'run1');
    const run = await settle(store, 'run1');
    expect(run.status).toBe('failed');
  });
});
