import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../../src/engine.js';
import { InMemoryStateStore } from '../../../src/testing/in-memory-state-store.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';

/**
 * The results queue is POINT-TO-POINT: every engine instance on the backend polls it, so a result
 * can be popped by ANY pod — including one that cannot resume the run (a pod mid-rolling-deploy that
 * doesn't have the workflow registered yet, or a stale process left over from an earlier build).
 *
 * Before the fix that pod destroyed the result: `completeRemoteResult` wrote the `completed`
 * checkpoint, `resume()` then threw "workflow … is not registered", and the poll loop swallowed the
 * throw into `failJob` — removing the job. The run stayed `suspended` with NO `wakeAt`, so no timer
 * poller, recovery sweep or redelivery could ever advance it: stuck forever, silently.
 */

/** Poll the store until `runId` reaches a terminal state (the result travels over a poll loop). */
async function settle(store: InMemoryStateStore, runId: string, budgetMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const run = await store.getRun(runId);
    if (run && run.status !== 'pending' && run.status !== 'running' && run.status !== 'suspended') {
      return run;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  const run = await store.getRun(runId);
  const cps = await store.listCheckpoints(runId);
  throw new Error(
    `run ${runId} did not settle: status=${run?.status} checkpoints=${JSON.stringify(
      cps.map((c) => `${c.seq}:${c.name}=${c.status}`),
    )}`,
  );
}

/** Poll the store until `predicate` holds, so a test can wait on an intermediate state. */
async function waitFor(check: () => Promise<boolean>, what: string, budgetMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('QueueTransport — a result popped by an instance that cannot resume the run', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c().catch(() => undefined)));
  });

  it('is not lost: another instance picks it up and the run finishes', async () => {
    const adapter = new MockAdapter();
    const store = new InMemoryStateStore();
    const track = (t: QueueTransport): QueueTransport => {
      cleanups.push(() => t.close());
      return t;
    };

    // The worker pod: serves the two step handlers. It has no engine, so it never consumes results.
    // Its handlers are registered further down, once the dispatching pod is gone — so the result is
    // produced with exactly one engine listening and the test is not a race.
    const worker = track(new QueueTransport({ adapter: () => adapter, pollIntervalMs: 5 }));
    const serveSteps = (): void => {
      worker.handle('exam:extract-text', async () => ({ text: 'hello' }));
      worker.handle('exam:extract-metrics', async (input) => ({
        metrics: (input as { text: string }).text.length,
      }));
    };

    const body = async (ctx: {
      step: <T>(name: string, input: unknown) => Promise<T>;
    }): Promise<{ metrics: number }> => {
      const { text } = await ctx.step<{ text: string }>('exam:extract-text', { examId: 'e1' });
      return ctx.step<{ metrics: number }>('exam:extract-metrics', { text });
    };

    // The web pod dispatches the run, then goes away (scaled down / request finished) — so it is not
    // in the race for the result. Its remaining state is entirely in the store.
    const webTransport = track(new QueueTransport({ adapter: () => adapter, pollIntervalMs: 5 }));
    const web = new WorkflowEngine({ store, transport: webTransport, instanceId: 'web' });
    web.register('exam-ingest', '1', body as never);
    await web.start('exam-ingest', { examId: 'e1' }, 'run-1');
    await waitFor(
      async () => (await store.getRun('run-1'))?.status === 'suspended',
      'the run to suspend on its first remote step',
    );
    await webTransport.close();

    // The stale pod: an engine WITHOUT this workflow registered (an older build). It is now the only
    // consumer of the results queue, so it is guaranteed to pop the worker's result.
    const staleTransport = track(new QueueTransport({ adapter: () => adapter, pollIntervalMs: 5 }));
    const stale = new WorkflowEngine({ store, transport: staleTransport, instanceId: 'stale' });
    expect(stale).toBeDefined();

    // Only now does the worker run the step, so the stale pod is the sole consumer of its result.
    serveSteps();

    // It completes the checkpoint (that half needs no workflow registry) but cannot resume the run.
    await waitFor(async () => {
      const cp = await store.getCheckpoint('run-1', 0);
      return cp?.status === 'completed';
    }, 'the stale pod to complete the first step checkpoint');
    expect((await store.getRun('run-1'))?.status).toBe('suspended');

    // The stale pod is replaced by a healthy one that DOES have the workflow. The result must still
    // be on the queue for it to pick up — that is the whole contract of a durable remote step.
    await staleTransport.close();
    const appTransport = track(new QueueTransport({ adapter: () => adapter, pollIntervalMs: 5 }));
    const app = new WorkflowEngine({ store, transport: appTransport, instanceId: 'app' });
    app.register('exam-ingest', '1', body as never);

    const run = await settle(store, 'run-1');
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ metrics: 5 });
  });
});
