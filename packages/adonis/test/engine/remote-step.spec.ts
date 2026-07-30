import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

/**
 * A durable dispatched `ctx.step` SUSPENDS the run, then the worker result resumes it asynchronously (the
 * InMemoryTransport delivers on `setImmediate`). Drive those deferred results + resumes until the
 * run reaches a terminal state.
 */
async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('WorkflowEngine — remote steps', () => {
  it('dispatches a remote step over the transport and checkpoints its result', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('payments.charge-card', async (input) => {
      const { amount } = input as { amount: number };
      return { chargeId: `ch_${amount}` };
    });

    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (ctx) => {
      const charge = await ctx.step<{ chargeId: string }>('payments.charge-card', { amount: 42 });
      return charge.chargeId;
    });

    // The step suspends the run durably; it completes when the worker result lands.
    const started = await startRun(engine, 'checkout', {}, 'run1');
    expect(started.status).toBe('suspended');

    const run = await settle(store, 'run1');
    expect(run.status).toBe('completed');
    expect(run.output).toBe('ch_42');

    const checkpoints = await store.listCheckpoints('run1');
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.kind).toBe('remote');
    expect(checkpoints[0]?.status).toBe('completed');
    expect(checkpoints[0]?.name).toBe('payments.charge-card');
  });

  it('records queue/processing timing and announces a remote step as it starts', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('payments.charge-card', async (input) => {
      const { amount } = input as { amount: number };
      return { chargeId: `ch_${amount}` };
    });

    const engine = new WorkflowEngine({ store, transport });
    const events: string[] = [];
    let observedQueueMs: number | undefined;
    engine.subscribe((e) => {
      if (e.type === 'step.started' || e.type === 'step.completed') events.push(e.type);
      if (e.type === 'step.completed') observedQueueMs = e.queueMs;
    });

    engine.register('checkout', '1', async (ctx) => {
      const charge = await ctx.step<{ chargeId: string }>('payments.charge-card', { amount: 42 });
      return charge.chargeId;
    });

    await startRun(engine, 'checkout', {}, 'run1');
    await settle(store, 'run1');

    // A remote step announces itself as in-flight (on dispatch) before it completes (on result).
    expect(events).toEqual(['step.started', 'step.completed']);
    expect(observedQueueMs).toBeGreaterThanOrEqual(0);

    const [cp] = await store.listCheckpoints('run1');
    expect(cp).toBeDefined();
    if (!cp) throw new Error('no checkpoint was recorded');
    // The three moments are ordered: dispatched ≤ worker pickup ≤ done.
    expect(cp.enqueuedAt.getTime()).toBeLessThanOrEqual(cp.startedAt.getTime());
    expect(cp.startedAt.getTime()).toBeLessThanOrEqual(cp.finishedAt.getTime());
    // The checkpoint records what the step was called with, alongside what it returned.
    expect(cp.input).toEqual({ amount: 42 });
    expect(cp.output).toEqual({ chargeId: 'ch_42' });
  });

  it('replays a completed remote step from its checkpoint instead of re-dispatching', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let dispatches = 0;
    transport.handle('payments.charge-card', async (input) => {
      const { amount } = input as { amount: number };
      dispatches += 1;
      return { chargeId: `ch_${amount}` };
    });

    const engine = new WorkflowEngine({ store, transport });
    let failLocalOnce = true;
    engine.register('checkout', '1', async (ctx) => {
      const charge = await ctx.step<{ chargeId: string }>('payments.charge-card', { amount: 42 });
      await ctx.localStep('after', async () => {
        if (failLocalOnce) {
          failLocalOnce = false;
          throw new Error('boom');
        }
        return 'done';
      });
      return charge.chargeId;
    });

    await startRun(engine, 'checkout', {}, 'run1'); // suspends at the call
    // The result resumes the run; the local `after` step then throws → the run fails.
    const afterFirst = await settle(store, 'run1');
    expect(afterFirst.status).toBe('failed');
    expect(dispatches).toBe(1);

    // Replay from checkpoints: the remote step is already completed, so it must NOT re-dispatch.
    const second = await engine.resume('run1');
    expect(second.status).toBe('completed');
    expect(second.output).toBe('ch_42');
    expect(dispatches).toBe(1);
  });
});
