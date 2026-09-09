import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * A lease release that fails must not become the run's error.
 *
 * The turn's `finally` releases the recovery lease — including on the failure path, where the
 * thing that failed the run is very often the same store the release has to talk to. A step
 * that violates a DB constraint leaves Postgres refusing every further statement on that
 * connection, so the release throws out of the `finally`.
 *
 * WHAT THESE TESTS PIN, precisely: that the failed release is swallowed and warned instead of
 * escaping the `finally`. They do NOT reproduce the unhandled rejection that led here — that
 * needs the run driven as a background resume against a real aborted transaction, which the
 * in-memory harness has no way to be. The application-level proof is that
 * `exam_ingest.spec.ts` in meuprontoo went from exit 1 (every assertion passing, one
 * unhandled rejection carrying a lease UPDATE) to exit 0 with only this warning in the log.
 */
describe('lease release is best-effort', () => {
  it('keeps the workflow error when releasing the lease throws', async () => {
    const store = new InMemoryStateStore();
    // Mirrors the poisoned-connection case: the store answers everything else, but any further
    // write on this run's lease is refused.
    vi.spyOn(store, 'releaseRunLock').mockRejectedValue(
      new Error('current transaction is aborted, commands ignored until end of transaction block'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const engine = new WorkflowEngine({ store });
    engine.register('poisoned', '1', async (ctx) => {
      await ctx.localStep('persist', async () => {
        throw new Error('null value in column "value" violates not-null constraint');
      });
      return 'done';
    });

    const result = await startRun(engine, 'poisoned', {}, 'r1');

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('not-null constraint');
    // The assertion that actually distinguishes fixed from unfixed: the release failure is
    // reported, not propagated. Without the fix this warning never happens.
    expect(warn.mock.calls.flat().join(' ')).toMatch(/releasing the lease of run r1 failed/);

    warn.mockRestore();
  });

  it('does not reject when the release fails on a successful run', async () => {
    const store = new InMemoryStateStore();
    vi.spyOn(store, 'releaseRunLock').mockRejectedValue(new Error('connection lost'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const engine = new WorkflowEngine({ store });
    engine.register('happy', '1', async (ctx) => {
      await ctx.localStep('work', async () => 'ok');
      return 'done';
    });

    // A run that DID everything asked of it must not be reported as failed because the
    // bookkeeping write after it could not land.
    const result = await startRun(engine, 'happy', {}, 'r2');
    expect(result.status).toBe('completed');
    expect(result.output).toBe('done');

    warn.mockRestore();
  });
});
