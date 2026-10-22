import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkflowDecision, WorkflowRun, WorkflowTask } from '../../src/interfaces.js';
import { RemoteWorkflowExecutor } from '../../src/remote-workflow-executor.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { PointToPointBroker } from './point-to-point-broker.js';

/**
 * Remote workflow-turn DECISIONS across engine replicas.
 *
 * `${P}-decisions` is a shared point-to-point queue on bullmq and queue: a turn's decision is taken by
 * whichever replica polls first, often NOT the one that dispatched the turn. A dispatcher that waits
 * for the decision in memory never sees it, and the run hangs with its lease renewed forever. These
 * specs run two engines ("pods") on one store and one {@link PointToPointBroker}.
 */

const GROUP = 'processing';

function completeAtOnce(task: WorkflowTask): WorkflowDecision {
  return {
    taskId: task.taskId,
    runId: task.runId,
    status: 'completed',
    commands: [],
    output: { ok: true },
  };
}

/** Poll the store until the run is terminal (or give up and return it as is, to assert on). */
async function settle(store: InMemoryStateStore, runId: string, max = 400): Promise<WorkflowRun> {
  for (let i = 0; i < max; i += 1) {
    const run = await store.getRun(runId);
    if (run && ['completed', 'failed', 'cancelled', 'dead'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 5));
  }
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run ${runId} missing`);
  return run;
}

/** Wait until `predicate` holds (or fail loudly). */
async function until(predicate: () => boolean | Promise<boolean>, max = 400): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never held');
}

function pod(
  broker: PointToPointBroker,
  store: InMemoryStateStore,
  name: string,
  deps: Partial<ConstructorParameters<typeof WorkflowEngine>[0]> = {},
  executorOpts: { timeoutMs?: number } = {},
): WorkflowEngine {
  const transport = broker.pod(name);
  const engine = new WorkflowEngine({ store, transport, instanceId: name, ...deps });
  engine.registerRemote('proc', '1', {
    group: GROUP,
    executor: new RemoteWorkflowExecutor(transport, GROUP, executorOpts),
  });
  return engine;
}

describe('remote workflow decisions across replicas', () => {
  it('a decision consumed by the replica that did NOT dispatch the turn still completes the run', async () => {
    const store = new InMemoryStateStore();
    const broker = new PointToPointBroker();
    broker.worker = completeAtOnce;
    const a = pod(broker, store, 'A');
    const b = pod(broker, store, 'B');

    // Warm-up on B, so B is a live decision consumer the way every replica that ever drove a turn is.
    await b.start('proc', {}, 'warm');
    expect((await settle(store, 'warm')).status).toBe('completed');

    // A dispatches; the broker hands the decision to B.
    await a.start('proc', {}, 'run1');
    const run = await settle(store, 'run1');

    expect(broker.turns.find((t) => t.task.runId === 'run1')?.pod).toBe('A');
    expect(broker.decisionPods()).toEqual(expect.arrayContaining(['A', 'B']));
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ ok: true });
    expect(run.awaitingDecisionTaskId).toBeUndefined();
    expect(run.lockedBy).toBeUndefined();
  });

  it('in-process parent -> remote gather_calls child: both complete with decisions landing anywhere', async () => {
    const N = 5;
    const store = new InMemoryStateStore();
    const broker = new PointToPointBroker();
    for (let i = 0; i < N; i += 1) {
      broker.steps.set(`leaf_${i}`, async (input) => {
        const { i: n } = input as { i: number };
        for (let t = 0; t <= n; t += 1) await new Promise((r) => setImmediate(r));
        return { r: n };
      });
    }
    // The Python `gather_calls` stand-in: re-emit every call still absent, complete once all are in.
    broker.worker = (task) => {
      const seen = new Map(task.history.map((e) => [e.seq, e]));
      const base = { taskId: task.taskId, runId: task.runId };
      const commands = Array.from({ length: N }, (_, seq) => seq)
        .filter((seq) => !seen.has(seq))
        .map((seq) => ({
          kind: 'call' as const,
          seq,
          name: `leaf_${seq}`,
          group: 'steps',
          input: { i: seq },
          parallelGroup: 'gather:0',
        }));
      if (commands.length > 0) return { ...base, status: 'continue', commands };
      const outputs = Array.from({ length: N }, (_, seq) => seen.get(seq)?.output);
      return { ...base, status: 'completed', commands: [], output: { outputs } };
    };
    const engines = ['A', 'B'].map((name) => {
      const engine = pod(broker, store, name);
      engine.register('pipeline', '1', async (ctx) => ({
        fromChild: await ctx.child<{ outputs: unknown[] }>('proc', { n: N }),
      }));
      return engine;
    });
    // Both pods consume decisions from the start (their results also land round-robin).
    await engines[1]?.start('proc', {}, 'warm');
    await settle(store, 'warm');

    await engines[0]?.start('pipeline', {}, 'run1');
    const parent = await settle(store, 'run1', 1000);

    expect(parent.status).toBe('completed');
    expect(parent.output).toEqual({
      fromChild: { outputs: [{ r: 0 }, { r: 1 }, { r: 2 }, { r: 3 }, { r: 4 }] },
    });
  });

  it('two replicas never mint the same turn taskId for one run', async () => {
    // Two module graphs = two processes: a per-process counter restarts at 1 in each.
    vi.resetModules();
    const one = await import('../../src/engine.js');
    const oneExec = await import('../../src/remote-workflow-executor.js');
    vi.resetModules();
    const two = await import('../../src/engine.js');
    const twoExec = await import('../../src/remote-workflow-executor.js');
    expect(one.WorkflowEngine).not.toBe(two.WorkflowEngine);

    const store = new InMemoryStateStore();
    const broker = new PointToPointBroker();
    let replies = 0;
    // The first turn's worker dies; the re-driven turn answers.
    broker.worker = (task) => (replies++ === 0 ? null : completeAtOnce(task));
    let now = 1_000_000;
    const clock = () => now;
    const make = (
      Engine: typeof WorkflowEngine,
      Exec: typeof RemoteWorkflowExecutor,
      name: string,
    ) => {
      const transport = broker.pod(name);
      const engine = new Engine({ store, transport, instanceId: name, clock });
      engine.registerRemote('proc', '1', {
        group: GROUP,
        executor: new Exec(transport, GROUP, { timeoutMs: 100 }),
      });
      return engine;
    };
    const a = make(one.WorkflowEngine, oneExec.RemoteWorkflowExecutor, 'A');
    const b = make(two.WorkflowEngine, twoExec.RemoteWorkflowExecutor, 'B');

    await a.start('proc', {}, 'run1');
    await until(() => broker.turns.length === 1);
    // The turn's window lapses; replica B's timer poller re-drives it.
    now += 1_000;
    await until(async () => {
      await b.resumeDueTimers();
      return broker.turns.length === 2;
    });
    const [first, second] = broker.turns;
    expect(first?.pod).toBe('A');
    expect(second?.pod).toBe('B');
    expect(second?.task.taskId).not.toBe(first?.task.taskId);
    expect((await settle(store, 'run1')).status).toBe('completed');
  });

  it('a decision delivered before dispatch even returns (and to another replica) still applies', async () => {
    const store = new InMemoryStateStore();
    const broker = new PointToPointBroker();
    broker.worker = completeAtOnce;
    const a = pod(broker, store, 'A');
    const b = pod(broker, store, 'B');
    await b.start('proc', {}, 'warm');
    await settle(store, 'warm');

    // The fastest possible worker: the decision is consumed INSIDE `dispatchWorkflowTask`. The awaited
    // marker must already be on the run and its lease free, or the decision is dropped.
    broker.sync = true;
    await a.start('proc', {}, 'run1');
    const run = await settle(store, 'run1');
    expect(run.status).toBe('completed');
    expect(run.awaitingDecisionTaskId).toBeUndefined();

    // Same, delivered back to the dispatcher itself (a single replica).
    const solo = new PointToPointBroker();
    solo.worker = completeAtOnce;
    solo.sync = true;
    const soloStore = new InMemoryStateStore();
    const only = pod(solo, soloStore, 'S');
    await only.start('proc', {}, 'run2');
    expect((await settle(soloStore, 'run2')).status).toBe('completed');
  });

  it('applies the awaited decision exactly once and drops stale, duplicate and foreign ones', async () => {
    const store = new InMemoryStateStore();
    const broker = new PointToPointBroker();
    const held: WorkflowTask[] = [];
    broker.worker = (task) => {
      held.push(task);
      return null; // replied to by hand below
    };
    const a = pod(broker, store, 'A');
    const completed: string[] = [];
    a.subscribe((ev) => {
      if (ev.type === 'run.completed') completed.push(ev.runId);
    });

    await a.start('proc', {}, 'run1');
    await until(() => held.length === 1);
    const task = held[0] as WorkflowTask;
    expect((await store.getRun('run1'))?.awaitingDecisionTaskId).toBe(task.taskId);

    // A decision for a turn the run is not awaiting: ignored.
    await broker.deliverDecision('A', { ...completeAtOnce(task), taskId: 'run1:wf:stale' });
    expect((await store.getRun('run1'))?.status).toBe('suspended');

    // The awaited one, delivered twice (an at-least-once redelivery): applied once.
    await Promise.all([
      broker.deliverDecision('A', completeAtOnce(task)),
      broker.deliverDecision('A', completeAtOnce(task)),
    ]);
    const run = await settle(store, 'run1');
    expect(run.status).toBe('completed');
    expect(completed).toEqual(['run1']);
  });

  it('a wake while a turn is in flight does not dispatch a second turn over it', async () => {
    const store = new InMemoryStateStore();
    const broker = new PointToPointBroker();
    const held: WorkflowTask[] = [];
    broker.worker = (task) => {
      held.push(task);
      return null;
    };
    const a = pod(broker, store, 'A');

    await a.start('proc', {}, 'run1');
    await until(() => held.length === 1);
    // Any wake-up (a late step result, a signal, a recheck) — `resume` stands in for all of them.
    await a.resume('run1');
    await a.resume('run1');
    expect(broker.turns).toHaveLength(1);
    expect((await store.getRun('run1'))?.lockedBy).toBeUndefined();

    await broker.deliverDecision('A', completeAtOnce(held[0] as WorkflowTask));
    expect((await settle(store, 'run1')).status).toBe('completed');
  });

  it('waitForRun does not resolve on the awaiting-a-turn suspend', async () => {
    const store = new InMemoryStateStore();
    const broker = new PointToPointBroker();
    const held: WorkflowTask[] = [];
    broker.worker = (task) => {
      held.push(task);
      return null;
    };
    const a = pod(broker, store, 'A');
    await a.start('proc', {}, 'run1');
    const waited = a.waitForRun('run1');
    await until(() => held.length === 1);
    let resolved = false;
    void waited.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false);
    await broker.deliverDecision('A', completeAtOnce(held[0] as WorkflowTask));
    expect((await waited).status).toBe('completed');
  });
});
