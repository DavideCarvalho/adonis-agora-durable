import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * A run whose turn rejects must reject ONCE — to whoever awaits it (here the in-process dispatcher,
 * which reports it) — not also as a process-level unhandled rejection.
 *
 * The engine tracks every in-flight execution for `drain()`, and dropped it from that set with
 * `void p.finally(...)`. `finally` returns a new promise that rejects whenever `p` does, and nothing
 * awaited it: so when the turn's store write failed (in CI, a test dropping its Postgres schema while
 * a background re-drive was still writing `status: 'running'`; in production, a lost connection or a
 * missing table), the caller handled the error AND Node saw an unhandled rejection — fatal under the
 * default `--unhandled-rejections=throw`, and an "Unhandled Rejection" that failed a CI run whose
 * every test had passed.
 */
async function until(cond: () => boolean, budgetMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe('the in-process pickup', () => {
  it('a background pickup whose store write fails is reported, never an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      const store = new InMemoryStateStore();
      const engine = new WorkflowEngine({ store });
      engine.register('wf', '1', async () => 'ok');
      // The table is gone: the turn's first write — flipping the run to `running` — throws.
      const updateRun = store.updateRun.bind(store);
      vi.spyOn(store, 'updateRun').mockImplementation(async (runId, patch) => {
        if (patch.status === 'running') {
          throw new Error('relation "durable_workflow_runs" does not exist');
        }
        return updateRun(runId, patch);
      });

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // `start` enqueues; the in-process dispatcher picks the run up in the background.
      await engine.start('wf', {}, 'r1');
      await until(() => warn.mock.calls.length > 0);
      // Unhandled rejections are reported after the microtask queue drains: give it a macrotask.
      await new Promise((r) => setTimeout(r, 20));

      // Unfixed, this held the store error: the bookkeeping chain re-raised it, unowned.
      expect(unhandled).toEqual([]);
      // The background pickup's failure is reported, not swallowed.
      expect(warn.mock.calls.flat().join(' ')).toMatch(
        /in-process pickup of run r1 failed.*durable_workflow_runs" does not exist/,
      );
      // And the execution left the in-flight set: drain() has nothing to wait for.
      await engine.drain(1_000);
      warn.mockRestore();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('drain() waits for a pickup still leasing its run, so nothing writes after it returns', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async (ctx) => ctx.localStep('a', async () => 'ok'));
    // A slow lease round trip: the pickup is between dispatch and its execution entering `inflight`.
    const tryLockRun = store.tryLockRun.bind(store);
    vi.spyOn(store, 'tryLockRun').mockImplementation(async (...args) => {
      await new Promise((r) => setTimeout(r, 50));
      return tryLockRun(...args);
    });
    let drained = false;
    const late: string[] = [];
    for (const method of [
      'updateRun',
      'updateRunIf',
      'saveCheckpoint',
      'releaseRunLock',
    ] as const) {
      const original = (store[method] as (...a: unknown[]) => Promise<unknown>).bind(store);
      vi.spyOn(store, method).mockImplementation((async (...args: unknown[]) => {
        if (drained) late.push(method);
        return original(...args);
      }) as never);
    }

    await engine.start('wf', {}, 'r1');
    await engine.drain(5_000);
    drained = true;
    // Long enough for an untracked pickup to finish its lease and write the run.
    await new Promise((r) => setTimeout(r, 150));

    // Unfixed, drain() found both registries empty and returned at once: the run then executed and
    // wrote after it — onto what, in a real shutdown, is a closed connection.
    expect(late).toEqual([]);
    expect((await store.getRun('r1'))?.status).toBe('completed');
  });
});
