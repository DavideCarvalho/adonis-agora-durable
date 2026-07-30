import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkflowRun } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const runningRun = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'r1',
  workflow: 'poison',
  workflowVersion: '1',
  status: 'running',
  input: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe('DLQ — maxRecoveryAttempts', () => {
  it('counts each recovery attempt on the run', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, maxRecoveryAttempts: 5 });
    let ran = 0;
    engine.register('poison', '1', async (ctx) => {
      ran += 1;
      await ctx.waitForSignal('never');
    });
    await store.createRun(runningRun());

    await engine.recoverIncomplete();
    await engine.waitForRun('r1'); // re-enqueued → a worker runs it, then suspends on the signal

    expect(ran).toBe(1); // under the cap → it ran
    expect((await store.getRun('r1'))?.recoveryAttempts).toBe(1);
  });

  it('moves a run to the dead-letter state once it exceeds the cap, without re-running it', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, maxRecoveryAttempts: 2 });
    let ran = 0;
    engine.register('poison', '1', async () => {
      ran += 1;
      throw new Error('always crashes');
    });
    // Already recovered twice (a poison pill the process kept crashing on).
    await store.createRun(runningRun({ recoveryAttempts: 2 }));

    await engine.recoverIncomplete();

    expect(ran).toBe(0); // NOT executed again
    const run = await store.getRun('r1');
    expect(run?.status).toBe('dead');
    expect(run?.error?.code).toBe('max_recovery_attempts');
  });

  it('never moves runs to dead when maxRecoveryAttempts is unset (default: retry forever)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store }); // no cap
    engine.register('wf', '1', async (ctx) => ctx.waitForSignal('go'));
    await store.createRun(runningRun({ workflow: 'wf', recoveryAttempts: 999 }));

    await engine.recoverIncomplete();
    await engine.waitForRun('r1'); // re-enqueued → ran + suspended, not dead
    expect((await store.getRun('r1'))?.status).toBe('suspended');
  });

  it('fires onDead listeners with the dead run (for a DLQ handler)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, maxRecoveryAttempts: 1 });
    engine.register('poison', '1', async () => {
      throw new Error('x');
    });
    const dead: Array<{ id: string; status: string; code: string | undefined }> = [];
    engine.onDead((run) => dead.push({ id: run.id, status: run.status, code: run.error?.code }));

    await store.createRun(runningRun({ recoveryAttempts: 1 })); // already at the cap
    await engine.recoverIncomplete();

    expect(dead).toEqual([{ id: 'r1', status: 'dead', code: 'max_recovery_attempts' }]);
  });
});
