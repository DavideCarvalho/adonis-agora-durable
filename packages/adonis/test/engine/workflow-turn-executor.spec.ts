import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { LocalWorkflowTurnExecutor } from '../../src/remote-workflow-executor.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';
import type { WorkflowBody } from '../../src/workflow-turn.js';

/**
 * The engine drives a TS workflow turn through the SAME shared {@link runWorkflowTurn} body a store-less
 * worker uses — via {@link LocalWorkflowTurnExecutor}. Proves the "both engine and worker call it"
 * property (design §4): here the whole polyglot-protocol path (dispatch → checkpoint → resume → replay)
 * runs against a REAL turn body instead of a hand-scripted decision, with the engine owning durability.
 */

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

function register(
  engine: WorkflowEngine,
  name: string,
  body: WorkflowBody,
  group = 'ts-workflows',
) {
  engine.registerRemote(name, '1', {
    group,
    executor: new LocalWorkflowTurnExecutor(new Map([[name, body]]), { group }),
  });
}

describe('WorkflowEngine + LocalWorkflowTurnExecutor — a TS turn body driven by the engine', () => {
  it('dispatches a step then completes — the run advances across turns to `completed`', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('charge', async (input) => {
      const { amount } = input as { amount: number };
      return { ref: `ch_${amount}` };
    });

    const engine = new WorkflowEngine({ store, transport });
    const checkout: WorkflowBody = (ctx, input) => {
      const paid = ctx.step('charge', { amount: (input as { amount: number }).amount });
      return { ok: true, paid };
    };
    register(engine, 'checkout', checkout);

    const started = await startRun(engine, 'checkout', { amount: 200 }, 'run1');
    expect(started.status).toBe('suspended'); // parked on the dispatched `charge`

    const run = await settle(store, 'run1');
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ ok: true, paid: { ref: 'ch_200' } });

    // The dispatched step is a durable REMOTE checkpoint routed by name.
    const cps = await store.listCheckpoints('run1');
    const call = cps.find((c) => c.seq === 0);
    expect(call?.kind).toBe('remote');
    expect(call?.status).toBe('completed');
    expect(call?.workerGroup).toBe('charge');

    // MUTATION ANCHOR: replay determinism. If the second turn didn't replay the resolved `charge` from
    // history, the run would re-dispatch it forever and never reach `completed` — this assertion + the
    // 100-iteration `settle` cap would fail.
  });

  it('suspends on ctx.waitSignal and resumes when the signal arrives', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    register(engine, 'approval', (ctx) => ({ approved: ctx.waitSignal('approve') }));

    const started = await startRun(engine, 'approval', {}, 'sig1');
    expect(started.status).toBe('suspended');

    await engine.signal('approve', { by: 'davi' });
    const run = await settle(store, 'sig1');
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ approved: { by: 'davi' } });
  });

  it('starts a child run and resumes the parent with its output', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    register(engine, 'double', (_ctx, input) => ({ doubled: (input as number) * 2 }));
    register(engine, 'parent', (ctx) => ({ child: ctx.startChild('double', 21) }));

    await startRun(engine, 'parent', {}, 'par1');
    const run = await settle(store, 'par1');
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ child: { doubled: 42 } });
  });

  it('fails the run when an awaited step is a recorded failure and the body does not catch it', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('charge', async () => {
      throw Object.assign(new Error('declined'), { retryable: false });
    });
    const engine = new WorkflowEngine({ store, transport });
    register(engine, 'checkout', (ctx) => ctx.step('charge'));

    await startRun(engine, 'checkout', {}, 'fail1');
    const run = await settle(store, 'fail1');
    expect(run.status).toBe('failed');
    expect(run.error?.message).toBe('declined');
  });
});
