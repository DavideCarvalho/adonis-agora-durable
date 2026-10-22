import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  RemoteTask,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowRun,
  WorkflowTask,
} from '../../src/interfaces.js';
import { RemoteWorkflowExecutor } from '../../src/remote-workflow-executor.js';
import { SINGLETON_ADMITTED_TAG } from '../../src/singleton-admission.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * Interactions that only exist once the recovery/admission, remote-decision and batched-result work
 * are combined: a remote workflow run SUSPENDED awaiting a dispatched turn's decision
 * (`awaitingDecisionTaskId`) meets orphan recovery, batched step-result settling, requeue and a
 * compensating cancel.
 */

const GROUP = 'proc';

/** A hand-driven broker: every step task, turn, result consumer and decision consumer is captured. */
function manualTransport() {
  const steps: RemoteTask[] = [];
  const turns: WorkflowTask[] = [];
  let onResult: ((r: StepResult) => Promise<void>) | undefined;
  let onDecision: ((d: WorkflowDecision) => Promise<void>) | undefined;
  const transport: Transport = {
    dispatch: async (task: RemoteTask) => {
      steps.push(task);
    },
    onResult: (fn) => {
      onResult = fn;
    },
    onHeartbeat: () => {},
    dispatchWorkflowTask: async (task: WorkflowTask) => {
      turns.push(task);
    },
    onDecision: (fn) => {
      onDecision = fn;
    },
    dispatchStepEvent: async () => {},
  };
  return {
    transport,
    steps,
    turns,
    result: (r: StepResult) => {
      if (!onResult) throw new Error('no result consumer');
      return onResult(r);
    },
    decide: (d: WorkflowDecision) => {
      if (!onDecision) throw new Error('no decision consumer');
      return onDecision(d);
    },
  };
}

function engineOn(
  store: InMemoryStateStore,
  t: ReturnType<typeof manualTransport>,
  name: string,
  deps: Partial<ConstructorParameters<typeof WorkflowEngine>[0]> = {},
): WorkflowEngine {
  const engine = new WorkflowEngine({ store, transport: t.transport, instanceId: name, ...deps });
  engine.registerRemote('proc', '1', {
    group: GROUP,
    executor: new RemoteWorkflowExecutor(t.transport, GROUP),
  });
  return engine;
}

async function until(predicate: () => boolean | Promise<boolean>, max = 400): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never held');
}

async function settled(store: InMemoryStateStore, runId: string): Promise<WorkflowRun> {
  await until(async () => {
    const run = await store.getRun(runId);
    return !!run && ['completed', 'failed', 'cancelled', 'dead'].includes(run.status);
  });
  return (await store.getRun(runId)) as WorkflowRun;
}

const completed = (task: WorkflowTask, output: unknown = { ok: true }): WorkflowDecision => ({
  taskId: task.taskId,
  runId: task.runId,
  status: 'completed',
  commands: [],
  output,
});

const resultOf = (task: RemoteTask, output: unknown): StepResult => ({
  runId: task.runId,
  seq: task.seq,
  stepId: task.stepId,
  status: 'completed',
  output,
});

describe('remote decisions x orphan recovery', () => {
  it('a run awaiting a decision survives repeated orphan recovery: not dead-lettered, not re-dispatched', async () => {
    const store = new InMemoryStateStore();
    const t = manualTransport();
    const a = engineOn(store, t, 'A', { maxRecoveryAttempts: 1 });
    const b = engineOn(store, t, 'B', { maxRecoveryAttempts: 1 });

    await a.start('proc', {}, 'run1');
    await until(() => t.turns.length === 1);
    const turn = t.turns[0] as WorkflowTask;
    expect((await store.getRun('run1'))?.awaitingDecisionTaskId).toBe(turn.taskId);

    // Every replica's recovery tick, well past any lease, many times over.
    for (let i = 0; i < 5; i += 1) {
      await a.recoverIncomplete(Date.now() + 3_600_000);
      await b.recoverIncomplete(Date.now() + 3_600_000);
      await b.resumeDueTimers();
    }

    const run = (await store.getRun('run1')) as WorkflowRun;
    expect(run.status).toBe('suspended');
    expect(run.awaitingDecisionTaskId).toBe(turn.taskId);
    expect(run.recoveryAttempts ?? 0).toBe(0);
    expect(t.turns).toHaveLength(1);

    // The awaited decision still applies.
    await t.decide(completed(turn));
    expect((await settled(store, 'run1')).status).toBe('completed');
  });

  it('a crash while applying a decision leaves a running orphan with a call in flight: parked, not dead', async () => {
    const store = new InMemoryStateStore();
    const t = manualTransport();
    const a = engineOn(store, t, 'A', { maxRecoveryAttempts: 1 });

    await a.start('proc', {}, 'run1');
    await until(() => t.turns.length === 1);
    const turn1 = t.turns[0] as WorkflowTask;
    // Turn 1 dispatches one remote call and suspends on it.
    await t.decide({
      taskId: turn1.taskId,
      runId: 'run1',
      status: 'continue',
      commands: [{ kind: 'call', seq: 0, name: 'leaf', group: 'steps', input: {} }],
    });
    await until(() => t.steps.length === 1);
    // The anomalous state a crash mid-apply leaves: `running`, marker cleared, lease free.
    await store.updateRun('run1', {
      status: 'running',
      awaitingDecisionTaskId: undefined,
      lockedBy: undefined,
      lockedUntil: undefined,
      updatedAt: new Date(),
    });

    for (let i = 0; i < 3; i += 1) await a.recoverIncomplete(Date.now() + 3_600_000);
    const parked = (await store.getRun('run1')) as WorkflowRun;
    expect(parked.status).toBe('suspended');
    expect(parked.recoveryAttempts ?? 0).toBe(0);
    expect(t.turns).toHaveLength(1);

    // The call's result resumes it into a fresh turn, which completes it.
    await t.result(resultOf(t.steps[0] as RemoteTask, 1));
    await until(() => t.turns.length === 2);
    await t.decide(completed(t.turns[1] as WorkflowTask));
    expect((await settled(store, 'run1')).status).toBe('completed');
  });
});

describe('remote decisions x batched result settling', () => {
  it('a batch of results landing while a turn is in flight settles in one write and dispatches no second turn', async () => {
    const N = 4;
    const store = new InMemoryStateStore();
    const t = manualTransport();
    const a = engineOn(store, t, 'A');

    await a.start('proc', {}, 'run1');
    await until(() => t.turns.length === 1);
    const turn1 = t.turns[0] as WorkflowTask;
    await t.decide({
      taskId: turn1.taskId,
      runId: 'run1',
      status: 'continue',
      commands: Array.from({ length: N }, (_, seq) => ({
        kind: 'call' as const,
        seq,
        name: `leaf_${seq}`,
        group: 'steps',
        input: { seq },
      })),
    });
    await until(() => t.steps.length === N);

    // The first result resumes the run into turn 2, which is now awaited.
    await t.result(resultOf(t.steps[0] as RemoteTask, 0));
    await until(() => t.turns.length === 2);
    const turn2 = t.turns[1] as WorkflowTask;
    expect((await store.getRun('run1'))?.awaitingDecisionTaskId).toBe(turn2.taskId);

    // The rest land together, while turn 2 is still out.
    const batched = vi.spyOn(store, 'saveCheckpointsIfPending');
    await Promise.all(t.steps.slice(1).map((s) => t.result(resultOf(s, s.seq))));
    expect(batched).toHaveBeenCalledTimes(1);
    expect(batched.mock.calls[0]?.[0]).toHaveLength(N - 1);
    for (let seq = 0; seq < N; seq += 1) {
      expect((await store.getCheckpoint('run1', seq))?.status).toBe('completed');
    }
    // Let the batch's background resume run: it must hold, not supersede turn 2.
    await new Promise((r) => setTimeout(r, 30));
    expect(t.turns).toHaveLength(2);
    const run = (await store.getRun('run1')) as WorkflowRun;
    expect(run.status).toBe('suspended');
    expect(run.awaitingDecisionTaskId).toBe(turn2.taskId);

    await t.decide(completed(turn2, { n: N }));
    const done = await settled(store, 'run1');
    expect(done.status).toBe('completed');
    expect(done.output).toEqual({ n: N });
  });
});

describe('remote decisions x requeue', () => {
  it('requeue of a dead remote workflow run clears the decision marker and the admission tag', async () => {
    const store = new InMemoryStateStore();
    const t = manualTransport();
    const a = engineOn(store, t, 'A');

    await a.start('proc', {}, 'run1');
    await until(() => t.turns.length === 1);
    const stale = t.turns[0] as WorkflowTask;
    // Dead-lettered (an operator, or a row written by an older release) with its marker still set and
    // a singleton admission tag left behind.
    await store.updateRun('run1', {
      status: 'dead',
      tags: ['keep', SINGLETON_ADMITTED_TAG],
      error: { message: 'boom' },
      updatedAt: new Date(),
    });
    expect((await store.getRun('run1'))?.awaitingDecisionTaskId).toBe(stale.taskId);

    await a.requeue('run1');
    await until(() => t.turns.length === 2);
    const fresh = t.turns[1] as WorkflowTask;
    expect(fresh.taskId).not.toBe(stale.taskId);
    const requeued = (await store.getRun('run1')) as WorkflowRun;
    expect(requeued.awaitingDecisionTaskId).toBe(fresh.taskId);
    expect(requeued.tags).toEqual(['keep']);
    expect(requeued.recoveryAttempts).toBe(0);

    // The old turn's late decision matches nothing; the fresh one applies.
    await t.decide(completed(stale, { from: 'stale' }));
    expect((await store.getRun('run1'))?.status).toBe('suspended');
    await t.decide(completed(fresh, { from: 'fresh' }));
    const done = await settled(store, 'run1');
    expect(done.status).toBe('completed');
    expect(done.output).toEqual({ from: 'fresh' });
  });

  it('the marker is gone the moment requeue returns (no fresh turn dispatched yet)', async () => {
    const store = new InMemoryStateStore();
    const t = manualTransport();
    const a = engineOn(store, t, 'A');
    await a.start('proc', {}, 'run1');
    await until(() => t.turns.length === 1);
    await store.updateRun('run1', { status: 'dead', updatedAt: new Date() });

    const noop = new WorkflowEngine({
      store,
      transport: t.transport,
      instanceId: 'cp',
      runDispatcher: { dispatch: () => {} },
    });
    await noop.requeue('run1');
    const run = (await store.getRun('run1')) as WorkflowRun;
    expect(run.status).toBe('pending');
    expect(run.awaitingDecisionTaskId).toBeUndefined();
  });
});

describe('remote decisions x compensating cancel', () => {
  it('a compensating cancel of a run awaiting a decision settles it cancelled; the late decision is dropped', async () => {
    const store = new InMemoryStateStore();
    const t = manualTransport();
    const a = engineOn(store, t, 'A');

    await a.start('proc', {}, 'run1');
    await until(() => t.turns.length === 1);
    const turn = t.turns[0] as WorkflowTask;

    await a.cancel('run1', { compensate: true });
    const cancelled = await settled(store, 'run1');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.awaitingDecisionTaskId).toBeUndefined();
    // The durable cancel intent was consumed once `cancelled` was recorded.
    expect(await store.takeBufferedSignal('cancel:run1')).toBeFalsy();

    await t.decide(completed(turn));
    await new Promise((r) => setTimeout(r, 20));
    expect((await store.getRun('run1'))?.status).toBe('cancelled');
    expect(t.turns).toHaveLength(1);
  });
});
