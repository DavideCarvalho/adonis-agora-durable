import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { StepCheckpoint, WorkflowRun } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * A run awaiting an IN-FLIGHT remote step must not be dead-lettered by orphan recovery. The free run
 * lease says nothing about it — the work sits on the transport, executed by a worker that holds no
 * RUN lease — and by contract such a run is durably `suspended`. Counting each pass as a crash
 * burned `maxRecoveryAttempts` and dead-lettered a healthy run while its worker was still busy.
 */
describe('recoverIncomplete with an in-flight pending remote step', () => {
  const at = new Date();
  const noDispatch = { dispatch: () => {} };

  // The anomalous-but-real state: left `running` with the lease released, so recovery lists it.
  const runningRun = (id: string): WorkflowRun => ({
    id,
    workflow: 'ingest',
    workflowVersion: '1',
    status: 'running',
    input: {},
    createdAt: at,
    updatedAt: at,
  });

  const remoteStep = (runId: string, over: Partial<StepCheckpoint> = {}): StepCheckpoint => ({
    runId,
    seq: 0,
    name: 'ingest.read',
    kind: 'remote',
    stepId: `${runId}:0`,
    status: 'pending', // dispatched; a live worker is executing it
    attempts: 1,
    workerGroup: 'ingest.read',
    enqueuedAt: at,
    startedAt: at,
    finishedAt: at,
    ...over,
  });

  it('does not burn the poison-pill budget on a run whose step is on the transport', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, runDispatcher: noDispatch, maxRecoveryAttempts: 3 });
    await store.createRun(runningRun('r1'));
    await store.saveCheckpoint(remoteStep('r1'));

    for (let i = 0; i < 6; i++) {
      await engine.recoverIncomplete();
      // Whatever re-enters `running` with a free lease, recovery keeps finding it.
      await store.updateRun('r1', { status: 'running', updatedAt: new Date() });
    }

    const run = await store.getRun('r1');
    expect(run?.status).not.toBe('dead');
    expect(run?.recoveryAttempts ?? 0).toBe(0);
  });

  it('parks it suspended on the reconcile timer and hands the lease back', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      runDispatcher: noDispatch,
      maxRecoveryAttempts: 10,
      reconcileMs: 300_000,
    });
    await store.createRun(runningRun('r1'));
    await store.saveCheckpoint(remoteStep('r1'));

    const before = Date.now();
    const results = await engine.recoverIncomplete();

    expect(results).toEqual([{ runId: 'r1', status: 'suspended' }]);
    const run = await store.getRun('r1');
    expect(run?.status).toBe('suspended');
    expect(run?.wakeAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(run?.lockedBy).toBeUndefined();
    expect(run?.lockedUntil).toBeUndefined();
    // …and it is no longer a candidate for the orphan sweep at all.
    expect(await store.listOrphanedRuns(Date.now(), 100)).toEqual([]);
  });

  it('two replicas sweeping the same orphan park it once and count nothing', async () => {
    const store = new InMemoryStateStore();
    const a = new WorkflowEngine({ store, runDispatcher: noDispatch, maxRecoveryAttempts: 1 });
    const b = new WorkflowEngine({ store, runDispatcher: noDispatch, maxRecoveryAttempts: 1 });
    await store.createRun(runningRun('r1'));
    await store.saveCheckpoint(remoteStep('r1'));

    const [ra, rb] = await Promise.all([a.recoverIncomplete(), b.recoverIncomplete()]);

    expect([...ra, ...rb]).toEqual([{ runId: 'r1', status: 'suspended' }]);
    expect((await store.getRun('r1'))?.recoveryAttempts ?? 0).toBe(0);
  });

  it('still dead-letters a genuine poison pill — no dispatched step in flight', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, runDispatcher: noDispatch, maxRecoveryAttempts: 2 });
    // Registered: recovery leaves a run of a workflow it does not have to the pod that has it.
    engine.register('ingest', '1', async () => undefined);
    await store.createRun(runningRun('r2'));
    // A remote step that already SETTLED is no excuse.
    await store.saveCheckpoint(remoteStep('r2', { status: 'completed', output: {} }));

    for (let i = 0; i < 4; i++) {
      await engine.recoverIncomplete();
      if ((await store.getRun('r2'))?.status === 'pending') {
        await store.updateRun('r2', { status: 'running', updatedAt: new Date() });
      }
    }

    const run = await store.getRun('r2');
    expect(run?.status).toBe('dead');
    expect(run?.error?.code).toBe('max_recovery_attempts');
  });
});
