import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../../src/engine.js';
import { InMemoryStateStore } from '../../../src/testing/in-memory-state-store.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';

/**
 * The proof the transport actually satisfies the contract: a real `WorkflowEngine` runs a workflow
 * whose only step is a REMOTE one (dispatched `ctx.step`). The engine dispatches over an engine-side
 * `QueueTransport`; a separate worker-side `QueueTransport` (sharing one mock adapter, as two
 * processes would share Redis) runs the handler and pushes the result back. No Redis involved.
 *
 * A durable dispatched `ctx.step` SUSPENDS the run; the worker result resumes it asynchronously, and here the
 * result travels over a polling queue loop. So we poll the store until the run reaches a terminal
 * state rather than relying on `waitForRun` (which also resolves on `suspended`).
 */
async function settle(store: InMemoryStateStore, runId: string, budgetMs = 2000) {
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

describe('QueueTransport + WorkflowEngine (end to end)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
  });

  it('runs a workflow whose remote step executes on a queue worker', async () => {
    const adapter = new MockAdapter();
    const store = new InMemoryStateStore();
    const engineTransport = new QueueTransport({ adapter: () => adapter, pollIntervalMs: 5 });
    const workerTransport = new QueueTransport({
      adapter: () => adapter,
      group: 'math',
      pollIntervalMs: 5,
    });
    cleanups.push(
      () => engineTransport.close(),
      () => workerTransport.close(),
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
    const adapter = new MockAdapter();
    const store = new InMemoryStateStore();
    const engineTransport = new QueueTransport({ adapter: () => adapter, pollIntervalMs: 5 });
    const workerTransport = new QueueTransport({
      adapter: () => adapter,
      group: 'math',
      pollIntervalMs: 5,
    });
    cleanups.push(
      () => engineTransport.close(),
      () => workerTransport.close(),
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
