import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  WorkflowDecision,
  WorkflowExecutor,
  WorkflowRun,
  WorkflowTask,
} from '../../src/interfaces.js';
import { RemoteWorkflowExecutor } from '../../src/remote-workflow-executor.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { PointToPointBroker } from './point-to-point-broker.js';

/**
 * Liveness of a remote workflow TURN. A turn whose worker died never sends a decision; the engine
 * must not wait forever (the old unbounded in-memory await) nor fail the run (the old `timeoutMs`),
 * since the work may have completed and only the decision was lost. A lapsed window re-drives the
 * turn instead, and run-scoped heartbeats keep a live worker's turn from being re-driven.
 */

const GROUP = 'proc';

function completed(task: WorkflowTask): WorkflowDecision {
  return {
    taskId: task.taskId,
    runId: task.runId,
    status: 'completed',
    commands: [],
    output: { turn: task.taskId },
  };
}

async function until(predicate: () => boolean | Promise<boolean>, max = 400): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never held');
}

async function settle(store: InMemoryStateStore, runId: string): Promise<WorkflowRun> {
  let run: WorkflowRun | null = null;
  await until(async () => {
    run = await store.getRun(runId);
    return run !== null && ['completed', 'failed', 'cancelled', 'dead'].includes(run.status);
  });
  return run as unknown as WorkflowRun;
}

function setup(opts: { silenceMs?: number; executorTimeoutMs?: number } = {}) {
  const store = new InMemoryStateStore();
  const broker = new PointToPointBroker();
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  const transport = broker.pod('A');
  const engine = new WorkflowEngine({
    store,
    transport,
    instanceId: 'A',
    clock: clock.now,
    ...(opts.silenceMs !== undefined ? { remoteAdvanceSilenceMs: opts.silenceMs } : {}),
  });
  engine.registerRemote('proc', '1', {
    group: GROUP,
    executor: new RemoteWorkflowExecutor(
      transport,
      GROUP,
      opts.executorTimeoutMs !== undefined ? { timeoutMs: opts.executorTimeoutMs } : {},
    ),
  });
  return { store, broker, engine, clock };
}

describe('remote workflow turn liveness', () => {
  it('remoteAdvanceSilenceMs: a lapsed turn is re-driven, not failed, and the late decision is dropped', async () => {
    const { store, broker, engine, clock } = setup({ silenceMs: 100 });
    const held: WorkflowTask[] = [];
    broker.worker = (task) => {
      held.push(task);
      return held.length === 1 ? null : completed(task); // the first worker dies mid-turn
    };

    await engine.start('proc', {}, 'run1');
    await until(() => held.length === 1);
    const awaiting = await store.getRun('run1');
    expect(awaiting?.status).toBe('suspended');
    expect(awaiting?.awaitingDecisionTaskId).toBe(held[0]?.taskId);
    expect(awaiting?.wakeAt).toBe(clock.now() + 100);
    // Lease released while the turn is out: any replica can apply the decision or re-drive.
    expect(awaiting?.lockedBy).toBeUndefined();

    // Not due yet: the timer poller leaves the in-flight turn alone.
    clock.advance(50);
    await engine.resumeDueTimers();
    expect(held).toHaveLength(1);

    clock.advance(60);
    await engine.resumeDueTimers();
    const run = await settle(store, 'run1');
    expect(held).toHaveLength(2);
    expect(held[1]?.taskId).not.toBe(held[0]?.taskId);
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ turn: held[1]?.taskId });

    // The first worker was only slow after all: its decision lands late and is ignored.
    await broker.deliverDecision('A', { ...completed(held[0] as WorkflowTask), output: 'stale' });
    expect((await store.getRun('run1'))?.output).toEqual({ turn: held[1]?.taskId });
  });

  it("a RemoteWorkflowExecutor's timeoutMs re-drives the turn instead of failing the run", async () => {
    const { store, broker, engine, clock } = setup({ executorTimeoutMs: 100 });
    let turns = 0;
    broker.worker = (task) => (++turns === 1 ? null : completed(task));

    await engine.start('proc', {}, 'run1');
    await until(() => turns === 1);
    clock.advance(150);
    await engine.resumeDueTimers();
    const run = await settle(store, 'run1');
    expect(run.status).toBe('completed');
    expect(run.error).toBeUndefined();
    expect(turns).toBe(2);
  });

  it('run-scoped heartbeats keep a live turn from being re-driven, with throttled writes; silence then re-drives', async () => {
    const { store, broker, engine, clock } = setup({ silenceMs: 100 });
    const held: WorkflowTask[] = [];
    broker.worker = (task) => {
      held.push(task);
      return held.length === 1 ? null : completed(task);
    };
    await engine.start('proc', {}, 'run1');
    await until(() => held.length === 1);

    let wakeWrites = 0;
    const updateRun = store.updateRun.bind(store);
    const updateRunIf = store.updateRunIf.bind(store);
    store.updateRun = async (id, patch) => {
      if ('wakeAt' in patch) wakeWrites += 1;
      return updateRun(id, patch);
    };
    store.updateRunIf = async (id, expected, patch) => {
      if ('wakeAt' in patch) wakeWrites += 1;
      return updateRunIf(id, expected, patch);
    };

    // 60 beats over 300ms (three windows): a live worker replaying a long turn.
    for (let i = 0; i < 60; i += 1) {
      clock.advance(5);
      await broker.beat({ runId: 'run1', seq: 0, group: GROUP });
      await engine.resumeDueTimers();
    }
    expect(held).toHaveLength(1);
    const run = await store.getRun('run1');
    expect(run?.wakeAt).toBeGreaterThan(clock.now());
    // One write per half window (~6 over 300ms), not one per beat (60).
    expect(wakeWrites).toBeGreaterThan(0);
    expect(wakeWrites).toBeLessThanOrEqual(8);

    // The worker goes silent: the window lapses and the turn is re-driven.
    clock.advance(150);
    await engine.resumeDueTimers();
    expect((await settle(store, 'run1')).status).toBe('completed');
    expect(held).toHaveLength(2);
  });

  it('without any window a turn waits for its decision (no re-drive)', async () => {
    const { store, broker, engine, clock } = setup();
    const held: WorkflowTask[] = [];
    broker.worker = (task) => {
      held.push(task);
      return null;
    };
    await engine.start('proc', {}, 'run1');
    await until(() => held.length === 1);
    expect((await store.getRun('run1'))?.wakeAt).toBeUndefined();
    clock.advance(24 * 3_600_000);
    await engine.resumeDueTimers();
    expect(held).toHaveLength(1);
    await broker.deliverDecision('A', completed(held[0] as WorkflowTask));
    expect((await settle(store, 'run1')).status).toBe('completed');
  });

  it('an INLINE advance that goes silent is released to crash recovery instead of failing', async () => {
    const store = new InMemoryStateStore();
    let calls = 0;
    const executor: WorkflowExecutor = {
      advance: (run) => {
        calls += 1;
        // The first advance's worker never answers; the recovered one does.
        if (calls === 1) return new Promise<WorkflowDecision>(() => {});
        return Promise.resolve({
          taskId: 't',
          runId: run.id,
          status: 'completed',
          commands: [],
          output: 'recovered',
        });
      },
    };
    const engine = new WorkflowEngine({ store, remoteAdvanceSilenceMs: 30 });
    engine.registerRemote('inline', '1', { group: 'g', executor });

    await engine.start('inline', {}, 'run1');
    await until(async () => {
      const run = await store.getRun('run1');
      return run?.status === 'running' && run.lockedBy === undefined;
    });
    expect(calls).toBe(1);
    expect((await store.getRun('run1'))?.error).toBeUndefined();

    await engine.recoverIncomplete();
    const run = await settle(store, 'run1');
    expect(run.status).toBe('completed');
    expect(run.output).toBe('recovered');
    expect(calls).toBe(2);
  });
});
