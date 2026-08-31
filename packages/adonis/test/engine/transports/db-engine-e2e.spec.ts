import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../../src/engine.js';
import { InMemoryStateStore } from '../../../src/testing/in-memory-state-store.js';
import { DbTransport } from '../../../src/transports/db.js';
import { makeTransportDb } from '../../../src/transports/db-helpers.js';

/**
 * The proof the transport satisfies the contract: a real `WorkflowEngine` runs a workflow whose only
 * step is a REMOTE one (dispatched `ctx.step`). The engine dispatches over an engine-side `DbTransport`; a
 * separate worker-side `DbTransport` (sharing one in-memory SQLite db, as two processes would share
 * one Postgres) claims the task row, runs the handler, and writes the result row back. No broker.
 *
 * A durable dispatched `ctx.step` SUSPENDS the run; the worker result resumes it asynchronously over a polling
 * loop. So we poll the store until the run reaches a terminal state.
 */
async function settle(store: InMemoryStateStore, runId: string, budgetMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const run = await store.getRun(runId);
    if (run && run.status !== 'pending' && run.status !== 'running' && run.status !== 'suspended') {
      return run;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('DbTransport + WorkflowEngine (end to end)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
  });

  it('runs a workflow whose remote step executes on a DB worker', async () => {
    const db = await makeTransportDb();
    const store = new InMemoryStateStore();
    const engineTransport = new DbTransport({ db, pollIntervalMs: 5 });
    const workerTransport = new DbTransport({ db, group: 'math', pollIntervalMs: 5 });
    cleanups.push(
      () => engineTransport.close(),
      () => workerTransport.close(),
      async () => {
        await db.manager.closeAll();
      },
    );

    workerTransport.handle('math.double', async (input) => {
      const { n } = input as { n: number };
      return { result: n * 2 };
    });

    const engine = new WorkflowEngine({ store, transport: engineTransport });
    engine.register('wf', '1', async (ctx) => {
      const a = await ctx.step<{ result: number }>('math.double', { n: 21 });
      return a.result;
    });

    await engine.start('wf', {}, 'run-1');
    const run = await settle(store, 'run-1');

    expect(run.status).toBe('completed');
    expect(run.output).toBe(42);
  });

  it('a failing remote step surfaces as a failed run', async () => {
    const db = await makeTransportDb();
    const store = new InMemoryStateStore();
    const engineTransport = new DbTransport({ db, pollIntervalMs: 5 });
    const workerTransport = new DbTransport({ db, group: 'math', pollIntervalMs: 5 });
    cleanups.push(
      () => engineTransport.close(),
      () => workerTransport.close(),
      async () => {
        await db.manager.closeAll();
      },
    );

    workerTransport.handle('math.boom', async () => {
      throw Object.assign(new Error('declined'), { retryable: false });
    });
    const engine = new WorkflowEngine({ store, transport: engineTransport });
    engine.register('wf', '1', async (ctx) => ctx.step('math.boom', {}));

    await engine.start('wf', {}, 'run-2');
    const run = await settle(store, 'run-2');
    expect(run.status).toBe('failed');
  });
});
