import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * Reproduces the exact race plan 006 closes: an operator cancels a run WHILE its in-flight turn is
 * still executing, computed from a run snapshot that predates the cancel. `settleRun`'s `completed`
 * branch used to write `status: 'completed'` unconditionally, silently undoing the cancel and telling
 * a waiting parent the child succeeded.
 *
 * The race is made deterministic (no timers, no `setTimeout` guessing) by controlling the child
 * workflow's own body with a pair of manually-resolved promises: `reached` proves the turn is
 * genuinely in flight (past the pending→running flip, blocked mid-body) before `cancel()` runs;
 * `release` then lets the body finish, so `settleRun` computes its "completed" outcome AFTER the
 * cancel has already landed — exactly the stale-snapshot ordering the bug depends on.
 */
describe('settleRun — a cancel landing mid-turn is not clobbered by a stale "completed" outcome', () => {
  it('ends the run cancelled (not completed) and does not tell the waiting parent it succeeded', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    let reachedResolve!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve;
    });
    let releaseResolve!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });

    engine.register('child', '1', async () => {
      reachedResolve(); // signal: this turn is now running, about to block
      await release; // held open until the test explicitly lets it finish
      return 'child-done';
    });
    // The parent awaits the child via ctx.child — it suspends on the child's `child:<id>` signal and
    // is resumed ONLY by notifyParent (on the child's actual settle) or nothing at all.
    engine.register('parent', '1', async (ctx) => ctx.child('child', {}, 'child1'));

    await engine.start('parent', {}, 'p1');
    await reached; // child's turn is genuinely in flight, blocked on `release`

    // Confirm we're mid-turn, not racing the pending→running flip itself.
    expect((await store.getRun('child1'))?.status).toBe('running');

    const cancelResult = await engine.cancel('child1');
    expect(cancelResult?.status).toBe('cancelled');
    expect((await store.getRun('child1'))?.status).toBe('cancelled');

    // Release the body: it resolves 'child-done', and settleRun computes a 'completed' outcome from
    // the STALE run object captured before the cancel — the exact shape of the bug. `drain()` (not
    // `waitForRun`, which could read the pre-release 'cancelled' status and return before the settle
    // attempt even runs) deterministically waits for this turn AND any cascading post-settle effect
    // (a parent notify) to fully finish.
    releaseResolve();
    await engine.drain();

    // The persisted status must still be 'cancelled' — not resurrected to 'completed'.
    expect((await store.getRun('child1'))?.status).toBe('cancelled');

    // The parent must NOT have been told the child succeeded: nothing else resumes a run suspended on
    // ctx.child, so if it's still 'suspended' the parent was never notified of a (fake) success. Under
    // the bug this assertion fails too — the parent runs to completion with the child's stale output.
    const parent = await store.getRun('p1');
    expect(parent?.status).toBe('suspended');
  });
});
