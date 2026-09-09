import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { QueueTransport } from '../../src/transports/queue.js';
import { MockAdapter } from '../../src/transports/queue-mock-adapter.js';

/**
 * A lease release that fails must not become an unhandled rejection.
 *
 * The turn's `finally` releases the recovery lease — including on the failure path, where the
 * thing that failed the run is frequently the same store the release has to talk to. A step
 * that violates a DB constraint leaves Postgres refusing every further statement on that
 * connection, so the release throws out of the `finally`.
 *
 * That matters because of WHERE the turn runs. Since the ack-first change, a remote result
 * resumes the run in the BACKGROUND (`completeRemoteResult` kicks `resume` and returns so the
 * results loop can ack). The resume's own rejection is captured, but a throw escaping the
 * `finally` lands outside it — a process-level rejection nobody owns. The symptom is a test
 * suite where every assertion passes and the exit code is still 1.
 *
 * Reproduced here with the in-memory store and the mock queue adapter: no database is needed,
 * only a `releaseRunLock` that rejects and a turn driven by the results loop rather than by an
 * awaited `startRun`. Driving it with `startRun` does NOT reproduce it — that path awaits the
 * turn, so the throw has an owner. Getting that wrong is how the first version of this test
 * came out green against the unfixed engine.
 */
describe('lease release is best-effort', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c().catch(() => undefined)));
  });

  it('a failing release does not become an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const adapter = new MockAdapter();
      const store = new InMemoryStateStore();
      // The poisoned-connection case: the store answers everything else, but the lease write
      // is refused — exactly what Postgres does for the rest of an aborted transaction.
      vi.spyOn(store, 'releaseRunLock').mockRejectedValue(
        new Error(
          'current transaction is aborted, commands ignored until end of transaction block',
        ),
      );

      const track = (t: QueueTransport): QueueTransport => {
        cleanups.push(() => t.close());
        return t;
      };
      const engineTransport = track(
        new QueueTransport({ adapter: () => adapter, pollIntervalMs: 5 }),
      );
      const workerTransport = track(
        new QueueTransport({ adapter: () => adapter, pollIntervalMs: 5 }),
      );

      // The step fails, so the turn takes the failure path — the one whose `finally` then has to
      // release a lease the store will refuse.
      workerTransport.handle('persist', async () => {
        throw new Error('null value in column "value" violates not-null constraint');
      });

      const engine = new WorkflowEngine({ store, transport: engineTransport });
      engine.register('poisoned', '1', async (ctx) => {
        // A DURABLE remote step (no `timeoutMs`): its result arrives on the results loop, so the
        // resume that runs the failing turn is the background one.
        await ctx.step('persist', {});
        return 'done';
      });

      await engine.start('poisoned', {}, 'r1');
      await settle(store, 'r1');

      const run = await store.getRun('r1');
      // The run still reaches its real outcome, with its real cause.
      expect(run?.status).toBe('failed');
      expect(run?.error?.message).toContain('not-null constraint');

      // The assertion this test exists for. Unfixed, this is 3.
      expect(unhandled).toEqual([]);

      // And the swallowed release stays visible to an operator rather than silent.
      expect(warn.mock.calls.flat().join(' ')).toMatch(/releasing the lease of run r1 failed/);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      warn.mockRestore();
    }
  });
});

/** Poll until `runId` is terminal — results travel over a poll loop, not a promise. */
async function settle(store: InMemoryStateStore, runId: string, budgetMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const run = await store.getRun(runId);
    if (run && !['pending', 'running', 'suspended'].includes(run.status)) {
      // The release happens in the turn's `finally`, just after the status flip — give the
      // microtask that rejects a chance to be seen as unhandled before asserting it was not.
      await new Promise((r) => setTimeout(r, 100));
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`run ${runId} did not settle`);
}
