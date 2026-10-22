import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkflowRun } from '../../src/interfaces.js';
import { SINGLETON_ADMITTED_TAG } from '../../src/singleton-admission.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * `requeue` resurrecting a `dead`/`failed` run restores its recovery budget. Without it a run
 * dead-lettered AT `maxRecoveryAttempts` came back `pending`, and the next recovery pass that found it
 * orphaned computed `cap + 1` and killed it again — an accepted retry with zero progress.
 */
describe('requeue resets recoveryAttempts for a resurrected run', () => {
  const at = new Date();
  const noDispatch = { dispatch: () => {} };
  const row = (over: Partial<WorkflowRun>): WorkflowRun => ({
    id: 'r1',
    workflow: 'job',
    workflowVersion: '1',
    status: 'running',
    input: {},
    createdAt: at,
    updatedAt: at,
    ...over,
  });

  it('a dead-lettered run gets a fresh budget instead of dying on the next recovery pass', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, runDispatcher: noDispatch, maxRecoveryAttempts: 2 });
    engine.register('job', '1', async () => 'done');
    await store.createRun(
      row({
        status: 'dead',
        recoveryAttempts: 2,
        error: { message: 'x', code: 'max_recovery_attempts' },
      }),
    );

    expect(await engine.requeue('r1')).toEqual({ runId: 'r1', status: 'pending' });
    expect((await store.getRun('r1'))?.recoveryAttempts).toBe(0);

    // The retried turn crashes once (left `running`, lease free): recovery counts ONE attempt.
    await store.updateRun('r1', { status: 'running' });
    await engine.recoverIncomplete();
    const after = await store.getRun('r1');
    expect(after?.status).toBe('pending');
    expect(after?.recoveryAttempts).toBe(1);
  });

  it('a failed run is reset too; its stale singleton marker is dropped', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, runDispatcher: noDispatch, maxRecoveryAttempts: 5 });
    engine.register('job', '1', async () => 'done');
    await store.createRun(
      row({
        status: 'failed',
        recoveryAttempts: 4,
        tags: ['singleton:k', SINGLETON_ADMITTED_TAG],
        error: { message: 'boom' },
      }),
    );
    await engine.requeue('r1');
    const after = await store.getRun('r1');
    expect(after?.recoveryAttempts).toBe(0);
    expect(after?.tags).toEqual(['singleton:k']);
    expect(after?.error).toBeUndefined();
  });

  it('requeueing a run that never came to rest keeps its count (poison pills still die)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, runDispatcher: noDispatch, maxRecoveryAttempts: 5 });
    engine.register('job', '1', async () => 'done');
    await store.createRun(row({ status: 'suspended', recoveryAttempts: 3 }));
    await engine.requeue('r1');
    expect((await store.getRun('r1'))?.recoveryAttempts).toBe(3);
  });
});
