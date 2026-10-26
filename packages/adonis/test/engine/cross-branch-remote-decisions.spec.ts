import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  RemoteTask,
  StateStore,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowRun,
  WorkflowTask,
} from '../../src/interfaces.js';
import { RemoteWorkflowExecutor } from '../../src/remote-workflow-executor.js';
import { SINGLETON_ADMITTED_TAG } from '../../src/singleton-admission.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { dbBackends } from '../support/backends.js';

/**
 * Interactions that only exist once the recovery/admission, remote-decision and batched-result work
 * are combined: a remote workflow run SUSPENDED awaiting a dispatched turn's decision
 * (`awaitingDecisionTaskId`) meets orphan recovery, batched step-result settling, requeue and a
 * compensating cancel. Run on the in-memory store and on the Lucid store (SQLite, plus Postgres with
 * `DURABLE_PG_URL`), where the CAS writes and the orphan listing are real SQL.
 */

/** Lucid databases opened by a test, closed after it (a Postgres one drops its schema on close). */
const opened: Database[] = [];
afterEach(async () => {
  // Let background effects (a resume, a lease release) land before the database goes away.
  await new Promise((r) => setTimeout(r, 20));
  while (opened.length) await opened.pop()?.manager.closeAll();
});

const stores: Array<[string, () => Promise<StateStore>]> = [
  ['in-memory', async () => new InMemoryStateStore()],
  ...dbBackends().map((backend): [string, () => Promise<StateStore>] => [
    `lucid (${backend.name})`,
    async () => {
      const db = await backend.makeStoreDb();
      opened.push(db);
      return new LucidStateStore(db);
    },
  ]),
];

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
  store: StateStore,
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

async function settled(store: StateStore, runId: string): Promise<WorkflowRun> {
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

describe.each(stores)('%s', (_label, makeStore) => {
  describe('remote decisions x orphan recovery', () => {
    it('a run awaiting a decision survives repeated orphan recovery: not dead-lettered, not re-dispatched', async () => {
      const store = await makeStore();
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
      const store = await makeStore();
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
      // Its turn was lost, so it is re-driven soon, not after the whole reconcile window.
      expect(parked.wakeAt).toBeDefined();
      expect((parked.wakeAt as number) - Date.now()).toBeLessThanOrEqual(1_000);
      expect(t.turns).toHaveLength(1);

      // The call's result resumes it into a fresh turn, which completes it.
      await t.result(resultOf(t.steps[0] as RemoteTask, 1));
      await until(() => t.turns.length === 2);
      await t.decide(completed(t.turns[1] as WorkflowTask));
      expect((await settled(store, 'run1')).status).toBe('completed');
    });
  });

  describe('remote decisions x inline advance timeout', () => {
    it('a turn that timed out with a call in flight is re-driven promptly, without re-dispatching the call', async () => {
      const store = await makeStore();
      const t = manualTransport();
      const engine = new WorkflowEngine({
        store,
        transport: t.transport,
        instanceId: 'A',
        remoteAdvanceSilenceMs: 40,
        reconcileMs: 3_600_000,
        maxRecoveryAttempts: 1,
      });
      let advances = 0;
      engine.registerRemote('proc', '1', {
        group: GROUP,
        executor: {
          // Turn 1 dispatches a call; turn 2's worker goes silent (the advance never answers); turn 3
          // completes. A replay must not re-dispatch the call turn 1 already sent.
          advance: async (run, history): Promise<WorkflowDecision> => {
            advances += 1;
            const taskId = `${run.id}:inline:${advances}`;
            if (advances === 1) {
              return {
                taskId,
                runId: run.id,
                status: 'continue',
                commands: [{ kind: 'call', seq: 0, name: 'leaf', group: 'steps', input: {} }],
              };
            }
            if (advances === 2) return new Promise<WorkflowDecision>(() => {});
            return {
              taskId,
              runId: run.id,
              status: 'completed',
              commands: [],
              output: { seen: history.map((e) => e.seq) },
            };
          },
        },
      });

      await engine.start('proc', {}, 'run1');
      await until(() => t.steps.length === 1);
      // A wake (a signal, a recheck) drives turn 2, which times out: left `running`, lease released.
      await engine.resume('run1');
      expect(advances).toBe(2);
      expect((await store.getRun('run1'))?.status).toBe('running');

      // Orphan recovery parks it on a near wake, counting no recovery attempt.
      await engine.recoverIncomplete(Date.now() + 3_600_000);
      const parked = (await store.getRun('run1')) as WorkflowRun;
      expect(parked.status).toBe('suspended');
      expect(parked.recoveryAttempts ?? 0).toBe(0);
      expect((parked.wakeAt as number) - Date.now()).toBeLessThanOrEqual(1_000);

      // The timer pass re-drives the turn as soon as that wake is due — not after reconcileMs.
      await engine.resumeDueTimers(Date.now() + 1_100);
      const done = await settled(store, 'run1');
      expect(done.status).toBe('completed');
      expect(advances).toBe(3);
      expect(t.steps).toHaveLength(1);
    });
  });

  describe('remote decisions x batched result settling', () => {
    it('a batch of results landing while a turn is in flight settles in one write and dispatches no second turn', async () => {
      const N = 4;
      const store = await makeStore();
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
      const batched = vi.spyOn(store, 'settleCheckpointsIfPending');
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
      const store = await makeStore();
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
      const store = await makeStore();
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
      const store = await makeStore();
      const t = manualTransport();
      const a = engineOn(store, t, 'A');

      await a.start('proc', {}, 'run1');
      await until(() => t.turns.length === 1);
      const turn = t.turns[0] as WorkflowTask;

      await a.cancel('run1', { compensate: true });
      const cancelled = await settled(store, 'run1');
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.awaitingDecisionTaskId).toBeUndefined();
      // The durable cancel intent is drained right AFTER `cancelled` is recorded (it must survive a
      // crash mid-unwind), so wait for the drain — peeking (take + re-buffer) without consuming it.
      await until(async () => {
        const marker = await store.takeBufferedSignal('cancel:run1');
        if (!marker) return true;
        await store.bufferSignal('cancel:run1', marker.payload);
        return false;
      });

      await t.decide(completed(turn));
      await new Promise((r) => setTimeout(r, 20));
      expect((await store.getRun('run1'))?.status).toBe('cancelled');
      expect(t.turns).toHaveLength(1);
    });
  });
});
