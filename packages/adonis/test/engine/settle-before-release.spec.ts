import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  RemoteTask,
  RunStatus,
  StepCheckpoint,
  StepResult,
  Transport,
  WorkflowRun,
} from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * A turn must not give up its run lease before the state it settled on is durable, and the orphan
 * sweep must not act on a run state it read before it held that lease.
 *
 * Ported from the same race in the NestJS core (seen as hung/failed durable chat turns in flip's e2e
 * suite, where an in-process worker answers a dispatched step in ~2 ms). `runExecution` did
 * `return this.settleRun(...)` inside `try … finally { releaseRunLock }` — the `finally` runs as soon
 * as the `return` expression is evaluated, not once the settle's write has landed. In that window the
 * run reads `running` with a free lease, which is exactly what `listOrphanedRuns` returns: the ~1 s
 * `recoverIncomplete` sweep took it for a crashed turn, counted a recovery attempt (or dead-lettered
 * it) and re-enqueued it for a SECOND execution.
 */

const PING = 'ext.ping';

/** Records dispatches; results are delivered explicitly by the test. */
class ManualTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  private result?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(): void {}
  async complete(task: RemoteTask, output: unknown = { pong: true }): Promise<void> {
    await this.result?.({
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output,
    });
  }
}

/**
 * Remembers the run's persisted status at every lease release. Its run writes land a tick later,
 * like a real database round-trip — the in-memory store otherwise applies a write synchronously on
 * the call, which hides an un-awaited settle behind the `finally` that follows it.
 */
class ReleaseAuditStore extends InMemoryStateStore {
  readonly statusAtRelease: RunStatus[] = [];
  override async updateRunIf(
    runId: string,
    expectedStatuses: RunStatus[],
    patch: Partial<WorkflowRun>,
  ): Promise<boolean> {
    await new Promise((r) => setImmediate(r));
    return super.updateRunIf(runId, expectedStatuses, patch);
  }
  override async releaseRunLock(runId: string, owner?: string): Promise<void> {
    const run = await this.getRun(runId);
    if (run) this.statusAtRelease.push(run.status);
    return super.releaseRunLock(runId, owner);
  }
}

describe('a turn settles its run before it releases the lease', () => {
  it('never releases the lease while the run still reads `running` (suspend, then complete)', async () => {
    const store = new ReleaseAuditStore();
    const transport = new ManualTransport();
    const engine = new WorkflowEngine({ store, transports: [{ id: 't', transport }] });
    engine.register('wf', '1', async (ctx) => {
      const r = await ctx.step<{ pong: boolean }>(PING, {});
      return r.pong;
    });

    // First turn: pending -> running -> dispatches the step -> suspends.
    await startRun(engine, 'wf', {}, 'r1');
    expect((await store.getRun('r1'))?.status).toBe('suspended');
    expect(store.statusAtRelease).not.toContain('running');

    // Second turn (resumed by the result) runs to completion — same rule on the terminal settle.
    const task = transport.dispatched[0];
    if (!task) throw new Error('expected a dispatched task');
    await transport.complete(task);
    await engine.waitForRun('r1', { terminal: true, timeoutMs: 2_000 });
    expect((await store.getRun('r1'))?.status).toBe('completed');
    expect(store.statusAtRelease).not.toContain('running');
  });

  // A turn only reads `running` when it started from `pending` (a first execution, or a recovered
  // one): a resumed run keeps reading `suspended` through its turn. So the terminal settles below
  // are exercised on a single-turn run, the shape of an agent turn made only of `localStep`s.
  it('never releases the lease while the run still reads `running` (a local-only turn that completes)', async () => {
    const store = new ReleaseAuditStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async (ctx) => ctx.localStep('answer', async () => 42));

    await startRun(engine, 'wf', {}, 'r1');
    await engine.waitForRun('r1', { terminal: true, timeoutMs: 2_000 });
    expect((await store.getRun('r1'))?.status).toBe('completed');
    expect(store.statusAtRelease).not.toContain('running');
  });

  it('never releases the lease while the run still reads `running` (a local-only turn that fails)', async () => {
    const store = new ReleaseAuditStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('boom', async () => {
        throw Object.assign(new Error('boom'), { retryable: false });
      });
    });

    await startRun(engine, 'wf', {}, 'r1').catch(() => undefined);
    await engine.waitForRun('r1').catch(() => undefined);
    expect((await store.getRun('r1'))?.status).toBe('failed');
    expect(store.statusAtRelease).not.toContain('running');
  });
});

describe('recoverIncomplete acts on the run it LOCKED, not the one it listed', () => {
  /** A store whose orphan listing answers from a snapshot taken earlier — what a sweep holds between
   *  its SELECT and the `tryLockRun` of each row, while the run moves on underneath it. */
  class StaleListingStore extends InMemoryStateStore {
    staleListing: WorkflowRun[] | undefined;
    override async listOrphanedRuns(
      nowMs: number,
      limit: number,
      namespace?: string,
    ): Promise<WorkflowRun[]> {
      return this.staleListing ?? super.listOrphanedRuns(nowMs, limit, namespace);
    }
    override async listIncompleteRuns(namespace?: string): Promise<WorkflowRun[]> {
      return this.staleListing ?? super.listIncompleteRuns(namespace);
    }
  }

  async function settledBehindAStaleListing(opts: { maxRecoveryAttempts?: number } = {}) {
    const store = new StaleListingStore();
    const transport = new ManualTransport();
    const dispatchedRuns: string[] = [];
    let executions = 0;
    const engine = new WorkflowEngine({
      store,
      transports: [{ id: 't', transport }],
      runDispatcher: { dispatch: (runId: string) => void dispatchedRuns.push(runId) },
      ...opts,
    });
    engine.register('wf', '1', async (ctx) => {
      executions += 1;
      const r = await ctx.step<{ pong: boolean }>(PING, {});
      return r.pong;
    });

    // The sweep lists the run while its first turn is executing it (`running`, lease free)…
    await store.createRun({
      id: 'r1',
      workflow: 'wf',
      workflowVersion: '1',
      status: 'running',
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const listed = await store.listOrphanedRuns(Date.now(), 100);
    expect(listed.map((r) => r.status)).toEqual(['running']);
    store.staleListing = listed;

    // …and by the time it takes the lease, that turn suspended on its step and the (fast) result
    // resumed the run to completion.
    await engine.runOne('r1');
    const task = transport.dispatched[0];
    if (!task) throw new Error('expected a dispatched task');
    await transport.complete(task);
    await engine.waitForRun('r1', { terminal: true, timeoutMs: 2_000 });
    expect((await store.getRun('r1'))?.status).toBe('completed');
    return {
      store,
      engine,
      dispatchedRuns,
      executionsBeforeSweep: executions,
      executions: () => executions,
    };
  }

  it('does not count, re-enqueue or keep the lease on a run that settled in between', async () => {
    const { store, engine, dispatchedRuns, executionsBeforeSweep, executions } =
      await settledBehindAStaleListing();

    await engine.recoverIncomplete();

    const after = await store.getRun('r1');
    expect(after?.status).toBe('completed');
    expect(after?.recoveryAttempts ?? 0).toBe(0);
    expect(dispatchedRuns).toEqual([]);
    expect(executions()).toBe(executionsBeforeSweep);
    // …and it does not keep the lease it took just to look.
    expect(after?.lockedBy).toBeUndefined();
  });

  it('does not dead-letter a run that settled in between (maxRecoveryAttempts)', async () => {
    const { store, engine } = await settledBehindAStaleListing({ maxRecoveryAttempts: 0 });

    await engine.recoverIncomplete();

    // Before the fix, the dead-letter branch wrote `dead` unconditionally over the COMPLETED run.
    const after = await store.getRun('r1');
    expect(after?.status).toBe('completed');
    expect(after?.error).toBeUndefined();
  });

  it('still recovers a genuinely orphaned run (a turn that died holding `running`)', async () => {
    const store = new StaleListingStore();
    const dispatchedRuns: string[] = [];
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: (runId: string) => void dispatchedRuns.push(runId) },
    });
    engine.register('wf', '1', async () => 'done');
    await store.createRun({
      id: 'r1',
      workflow: 'wf',
      workflowVersion: '1',
      status: 'running',
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await engine.recoverIncomplete();

    const after = await store.getRun('r1');
    expect(after?.status).toBe('pending');
    expect(after?.recoveryAttempts).toBe(1);
    expect(after?.lockedBy).toBeUndefined();
    expect(dispatchedRuns).toEqual(['r1']);
  });
});

describe("a replay's stale view of a remote step never overwrites its landed result", () => {
  /**
   * The lost-dispatch lease (`remoteRedispatchMs`) is stamped by a replay that finds its step still
   * `pending`. That replay reads the step from the snapshot it took when it STARTED — so a result
   * landing after the snapshot is invisible to it, and stamping `{ ...snapshot, wakeAt }` wrote the
   * stale `pending` row back over the `completed` one: the result was gone, and the run parked on a
   * lease an hour out.
   */
  class SnapshotRaceStore extends InMemoryStateStore {
    /** Called right after a `listCheckpoints` snapshot is taken, once. */
    afterSnapshot?: (() => Promise<void>) | undefined;
    override async listCheckpoints(runId: string): Promise<StepCheckpoint[]> {
      const snapshot = await super.listCheckpoints(runId);
      const hook = this.afterSnapshot;
      if (hook) {
        this.afterSnapshot = undefined;
        await hook();
      }
      return snapshot;
    }
  }

  it('re-reads the step before stamping its lease, and replays the result instead', async () => {
    let now = 1_000_000;
    const store = new SnapshotRaceStore();
    const transport = new ManualTransport();
    const engine = new WorkflowEngine({
      store,
      transports: [{ id: 't', transport }],
      clock: () => now,
      reconcileMs: 0,
      remoteRedispatchMs: 60 * 60_000,
    });
    engine.register('wf', '1', async (ctx) => {
      const r = await ctx.step<{ pong: boolean }>(PING, {});
      return r.pong;
    });

    await startRun(engine, 'wf', {}, 'r1');
    const task = transport.dispatched[0];
    if (!task) throw new Error('expected a dispatched task');
    const seq = task.seq;
    expect((await store.getCheckpoint('r1', seq))?.status).toBe('pending');

    // A replay takes its snapshot (step still `pending`); the result lands in the store right after.
    // Written straight to the store, so its own resume never runs — the replay is the only turn.
    store.afterSnapshot = async () => {
      await store.saveCheckpoint({
        ...((await store.getCheckpoint('r1', seq)) as StepCheckpoint),
        status: 'completed',
        output: { pong: true },
      });
    };
    now += 1_000;
    await engine.runOne('r1');

    const cp = await store.getCheckpoint('r1', seq);
    expect(cp?.status).toBe('completed');
    expect(cp?.output).toEqual({ pong: true });
    const run = await store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe(true);
    expect(transport.dispatched).toHaveLength(1);
  });
});
