import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const tick = () => new Promise((r) => setImmediate(r));
async function until(pred: () => Promise<boolean>, n = 300) {
  for (let i = 0; i < n; i += 1) {
    if (await pred()) return;
    await tick();
  }
  throw new Error('condition not met');
}

/**
 * A child dead-lettered by recovery (maxRecoveryAttempts exceeded) is terminal like a failure: the
 * parent awaiting it must hear about it right away, not on its next reconcile wake.
 */
describe('a child moved to dead by recovery notifies its parent', () => {
  it('ctx.child throws in the parent as soon as recovery dead-letters the child', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, maxRecoveryAttempts: 1 });
    engine.register('poison', '1', async (ctx) => ctx.waitForSignal('never'));
    engine.register('parent', '1', async (ctx) => {
      try {
        await ctx.child('poison', {}, 'kid');
        return 'child-ok';
      } catch (error) {
        // Only the child's failure: anything else (the suspension itself) must propagate.
        if (!/maxRecoveryAttempts/.test((error as Error).message)) throw error;
        return `child-failed: ${(error as Error).message}`;
      }
    });

    const first = await startRun(engine, 'parent', {}, 'p1');
    expect(first.status).toBe('suspended');
    await until(async () => (await store.getRun('kid'))?.status === 'suspended');

    // The child's process crashed mid-turn, again and again: it is `running` with its recovery
    // budget spent, so the next recovery pass dead-letters it.
    await store.updateRun('kid', { status: 'running', recoveryAttempts: 1 });
    await engine.recoverIncomplete();
    expect((await store.getRun('kid'))?.status).toBe('dead');

    await until(async () => (await store.getRun('p1'))?.status === 'completed');
    expect((await store.getRun('p1'))?.output).toMatch(/^child-failed: .*maxRecoveryAttempts/);
  });

  it('ctx.allSettled records the dead child promptly', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, maxRecoveryAttempts: 1 });
    engine.register('maybe', '1', async (ctx, input) =>
      (input as { ok: boolean }).ok ? 'fine' : ctx.waitForSignal('never'),
    );
    engine.register('parent', '1', async (ctx) => {
      const settled = await ctx.allSettled('maybe', [{ ok: true }, { ok: false }]);
      return settled.map((s) => s.status);
    });

    await startRun(engine, 'parent', {}, 'p2');
    const children = async () => store.listRuns({ workflow: 'maybe' });
    await until(async () => {
      const kids = await children();
      return (
        kids.length === 2 &&
        kids.some((k) => k.status === 'completed') &&
        kids.some((k) => k.status === 'suspended')
      );
    });
    const stuck = (await children()).find((k) => k.status === 'suspended');
    await store.updateRun(stuck?.id as string, { status: 'running', recoveryAttempts: 1 });
    await engine.recoverIncomplete();
    expect((await store.getRun(stuck?.id as string))?.status).toBe('dead');

    await until(async () => (await store.getRun('p2'))?.status === 'completed');
    expect((await store.getRun('p2'))?.output).toEqual(['fulfilled', 'rejected']);
  });
});
