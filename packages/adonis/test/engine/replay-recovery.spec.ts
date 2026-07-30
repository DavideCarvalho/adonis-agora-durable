import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

/**
 * Ported from nestjs-durable `1e02bdd`. LOCKS the stateless-replay-per-turn execution model: the
 * engine re-invokes the WHOLE workflow body on every turn; a completed `ctx.localStep`/`ctx.step`
 * (dispatched) is never re-run — its checkpointed output is returned instead, even under a FRESH
 * engine instance over the same store. A failure here means the execution-model assumption changed.
 */
describe('replay recovery — stateless-replay-per-turn execution model', () => {
  it('re-invokes the body every turn without re-running a completed step, even under a fresh engine over the same store', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();

    let localRuns = 0;
    let remoteDispatches = 0;

    transport.handle('billing.charge-card', async (input) => {
      const { amount } = input as { amount: number };
      remoteDispatches += 1;
      return { chargeId: `ch_${amount}` };
    });

    function registerCheckout(engine: WorkflowEngine) {
      engine.register('checkout', '1', async (ctx) => {
        const a = await ctx.localStep('a', async () => {
          localRuns += 1;
          return 10;
        });
        const charge = await ctx.step<{ chargeId: string }>('billing.charge-card', { amount: a });
        const b = await ctx.localStep('b', async () => {
          localRuns += 1;
          return charge.chargeId;
        });
        return b;
      });
    }

    const engine1 = new WorkflowEngine({
      store,
      transport,
      instanceId: 'engine1',
      runDispatcher: { dispatch: () => {} },
    });
    registerCheckout(engine1);

    await engine1.start('checkout', {}, 'run1');
    const turn1 = await engine1.runOne('run1');

    // Turn 1: 'a' runs once, then the dispatched step suspends the run durably.
    expect(turn1?.status).toBe('suspended');
    expect(localRuns).toBe(1);
    expect(remoteDispatches).toBe(1);

    // A SECOND engine over the SAME store (never executed this run) picks up the resume.
    const engine2 = new WorkflowEngine({
      store,
      transport,
      instanceId: 'engine2',
      runDispatcher: { dispatch: () => {} },
    });
    registerCheckout(engine2);

    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setImmediate(r));
      const run = await store.getRun('run1');
      if (run && run.status !== 'running' && run.status !== 'suspended') break;
    }

    const final = await store.getRun('run1');
    expect(final?.status).toBe('completed');
    expect(final?.output).toBe('ch_10');

    // 'a' was already checkpointed by engine1 → not re-run; only 'b' runs (first time). Exactly 2.
    expect(localRuns).toBe(2);
    // The dispatched step's checkpointed result is replayed, not re-dispatched, by the resuming engine.
    expect(remoteDispatches).toBe(1);

    const checkpoints = await store.listCheckpoints('run1');
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints.map((cp) => cp.name)).toEqual(['a', 'billing.charge-card', 'b']);
    expect(checkpoints.every((cp) => cp.status === 'completed')).toBe(true);

    // A third fresh engine over the now-terminal run must not re-invoke the body at all.
    const engine3 = new WorkflowEngine({
      store,
      instanceId: 'engine3',
      runDispatcher: { dispatch: () => {} },
    });
    registerCheckout(engine3);
    const turn3 = await engine3.resume('run1');
    expect(turn3.status).toBe('completed');
    expect(turn3.output).toBe('ch_10');
    expect(localRuns).toBe(2);
  });
});
