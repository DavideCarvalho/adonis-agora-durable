import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { defineStep } from '../../src/step-ref.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

/**
 * A `ctx.step(..., { compensate })` registers a DISPATCHED saga undo: the undo is itself an ordinary
 * step (a `@Step`/`defineStep` handler or a name) that the engine dispatches to a worker at unwind
 * time, called with the {@link StepUndo} envelope (the compensated step's `input`/`output`).
 */
describe('ctx.step — dispatched saga compensation', () => {
  it('dispatches the undo step with the StepUndo envelope when the run later fails', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();

    const undoCalls: unknown[] = [];
    transport.handle('billing:charge', async (input) => {
      const { amount } = input as { amount: number };
      return { chargeId: `ch_${amount}` };
    });
    transport.handle('billing:refund', async (undo) => {
      undoCalls.push(undo);
      return { refunded: true };
    });

    const refund = defineStep('billing:refund', async () => ({ refunded: true }));

    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (ctx) => {
      await ctx.step<{ chargeId: string }>(
        'billing:charge',
        { amount: 42 },
        { compensate: refund },
      );
      await ctx.localStep('boom', async () => {
        throw new Error('downstream failure');
      });
    });

    await engine.start('checkout', {}, 'run1');
    // Drive the dispatched charge result → resume → local step throws → saga unwinds → dispatched undo.
    for (let i = 0; i < 50; i += 1) {
      await flush();
      const run = await store.getRun('run1');
      if (run && run.status !== 'running' && run.status !== 'suspended') break;
    }

    const run = await store.getRun('run1');
    expect(run?.status).toBe('failed');
    // The undo handler ran once, with the compensated step's original input + its result.
    expect(undoCalls).toEqual([{ input: { amount: 42 }, output: { chargeId: 'ch_42' } }]);
  });

  it('does not dispatch the undo when the run succeeds', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let undoRan = 0;
    transport.handle('billing:charge', async () => ({ chargeId: 'ch' }));
    transport.handle('billing:refund', async () => {
      undoRan += 1;
      return {};
    });

    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (ctx) => {
      await ctx.step('billing:charge', { amount: 1 }, { compensate: 'billing:refund' });
      return 'ok';
    });

    await engine.start('checkout', {}, 'run1');
    for (let i = 0; i < 50; i += 1) {
      await flush();
      const run = await store.getRun('run1');
      if (run && run.status !== 'running' && run.status !== 'suspended') break;
    }
    const run = await store.getRun('run1');
    expect(run?.status).toBe('completed');
    expect(undoRan).toBe(0);
  });
});
