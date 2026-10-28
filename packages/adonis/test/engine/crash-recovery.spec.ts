import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISPATCH_KEY, dispatchKeyOf } from '../../src/dispatch-key.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { RemoteTask, StateStore, StepResult, Transport } from '../../src/interfaces.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { runOutsideWorkflowCtx } from '../../src/workflow-als.js';
import { dbBackends } from '../support/backends.js';

/**
 * A pod SIGKILLed at the wrong moment must not strand the runs it was carrying for the reconcile
 * interval (or forever). Reproduces what a multi-pod harness (3 web pods + 2 workers sharing one
 * Postgres + Redis, 6000 one-step runs, one web pod and one worker SIGKILLed mid-batch) observed:
 *
 *  1. Runs left `suspended` with their step already `completed`: the pod that consumed the step's
 *     result settled the checkpoint, acknowledged the result, and died before its in-memory resume
 *     ran. Nothing durable said a turn was owed, so the run waited out its 5-minute reconcile timer.
 *  2. Runs with a `pending` step no worker ever received: the turn wrote the checkpoint and died
 *     before the job reached the broker. Every reconcile wake replayed straight back to "pending,
 *     keep waiting", so the run never finished.
 *
 * A crash is simulated by freezing an engine: from the kill on, every store call (and the dispatch
 * that triggers it) of that engine hangs forever, exactly like a process that stopped mid-await.
 * The surviving engine shares the store, and only its worker tick (`recoverIncomplete` +
 * `resumeDueTimers`) may bring the run home — at a clock just past one lease, far below
 * `reconcileMs`.
 */

const STEP = 'jobs.test';
const LEASE_MS = 30_000;
const RECONCILE_MS = 300_000;

/** A store that can be frozen: once `kill()`ed, every call (reads included) never settles. */
function killable(store: StateStore): {
  store: StateStore;
  kill: () => void;
  dead: () => boolean;
  /** Run `hook` right before the next call of `method` (which then sees the hook's effect). */
  onCall: (method: string, hook: () => void) => void;
} {
  let dead = false;
  const hooks = new Map<string, () => void>();
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const hook = hooks.get(String(prop));
        if (hook) {
          hooks.delete(String(prop));
          hook();
        }
        if (dead) return new Promise(() => {});
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    store: proxy,
    kill: () => {
      dead = true;
    },
    dead: () => dead,
    onCall: (method, hook) => hooks.set(method, hook),
  };
}

/** Records dispatched tasks; results are delivered by the test. `crashOnDispatch` freezes the pod
 *  inside the dispatch, before the job reaches the broker. */
class CrashableTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  /** Every task handed to `dispatch`, the ones a crash swallowed included. */
  readonly attempted: RemoteTask[] = [];
  result: ((r: StepResult) => Promise<void>) | undefined;
  crashOnDispatch: (() => void) | undefined;
  /** Awaited inside `dispatch`, after the job reached the broker: the turn that dispatched waits on it. */
  onDispatch: ((task: RemoteTask) => Promise<void>) | undefined;
  async dispatch(task: RemoteTask): Promise<void> {
    this.attempted.push(task);
    if (this.crashOnDispatch) {
      this.crashOnDispatch();
      return new Promise(() => {});
    }
    this.dispatched.push(task);
    await this.onDispatch?.(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(): void {}
}

async function until(check: () => boolean | Promise<boolean>, max = 500): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

/** Suspended AND its lease handed back: the turn that parked it is over. */
async function parked(store: StateStore, runId: string): Promise<void> {
  await until(async () => {
    const run = await store.getRun(runId);
    return run?.status === 'suspended' && run.lockedBy === undefined;
  });
  // …and its post-suspend re-check (a deferred look at the seqs it waits on) has run too.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Deliver `result` to `dying`, a pod about to die mid-resume, the way a broker does: the handler
 * resolving is the acknowledgement. A pod that died before acknowledging never did, so the broker
 * redelivers the result to a live consumer (`survivor`).
 */
async function deliverToDying(
  dying: { transport: CrashableTransport; dead: () => boolean },
  survivor: { transport: CrashableTransport },
  result: StepResult,
): Promise<'acked' | 'redelivered'> {
  const delivered = dying.transport.result?.(result).then(() => 'acked' as const);
  await until(() => dying.dead());
  const outcome = await Promise.race([delivered, settle().then(() => 'unacked' as const)]);
  if (outcome === 'acked') return 'acked';
  await survivor.transport.result?.(result);
  return 'redelivered';
}

const completed = (task: RemoteTask, output: unknown = { ok: true }): StepResult => ({
  runId: task.runId,
  seq: task.seq,
  stepId: task.stepId,
  status: 'completed',
  output,
});

interface StoreBackend {
  name: string;
  make(): Promise<{ store: StateStore; close: () => Promise<void> }>;
}

const backends: StoreBackend[] = [
  {
    name: 'in-memory',
    make: async () => ({ store: new InMemoryStateStore(), close: async () => {} }),
  },
  ...dbBackends().map((b) => ({
    name: `lucid/${b.name}`,
    make: async () => {
      const db: Database = await b.makeStoreDb();
      return { store: new LucidStateStore(db), close: () => db.manager.closeAll() };
    },
  })),
];

describe.each(backends)('crash recovery on $name', (backend) => {
  let now = Date.now();
  const clock = () => now;
  let live: WorkflowEngine[] = [];
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    // Only the survivors: a frozen engine's work never settles, by construction.
    await Promise.all(live.map((e) => e.drain()));
    live = [];
    await close?.();
    close = undefined;
  });

  /** One pod: an engine over a killable view of the shared store. */
  const pod = (shared: StateStore, transport: CrashableTransport, instanceId: string) => {
    const view = killable(shared);
    const engine = new WorkflowEngine({
      store: view.store,
      transports: [{ id: 't', transport }],
      instanceId,
      clock,
      leaseMs: LEASE_MS,
      reconcileMs: RECONCILE_MS,
    });
    return { engine, transport, ...view };
  };

  const setup = async () => {
    now = Date.now();
    const made = await backend.make();
    close = made.close;
    const a = pod(made.store, new CrashableTransport(), 'pod-a');
    const b = pod(made.store, new CrashableTransport(), 'pod-b');
    return { store: made.store, a, b };
  };

  /** The survivor's worker tick, `ms` past now. */
  const tickAt = async (engine: WorkflowEngine, ms: number) => {
    now += ms;
    await engine.recoverIncomplete(now);
    await engine.resumeDueTimers(now);
    await settle();
  };

  it('resumes a run whose result was acknowledged by a pod that died before resuming it', async () => {
    const { store, a, b } = await setup();
    live = [a.engine];
    for (const { engine } of [a, b]) {
      engine.register('Test', '1', async (ctx) => ctx.step(STEP, {}));
    }

    await a.engine.start('Test', {}, 'r1');
    await parked(store, 'r1');
    const task = a.transport.dispatched[0];
    if (!task) throw new Error('expected a dispatched task');

    // Pod B consumes the result (the handler resolving IS the broker ack) and dies the moment its
    // resume reaches for the run's lease — after the ack, before any turn ran.
    b.onCall('tryLockRun', () => b.kill());
    const delivered = b.transport.result?.(completed(task)).then(() => 'acked' as const);
    await until(() => b.dead());
    const outcome = await Promise.race([delivered, settle().then(() => 'unacked' as const)]);
    // Not acked (B died first): the broker redelivers the job to a live consumer.
    if (outcome === 'unacked') await a.transport.result?.(completed(task));
    await settle();

    await tickAt(a.engine, LEASE_MS + 1_000);

    await until(async () => (await store.getRun('r1'))?.status === 'completed');
  });

  it('resumes a run whose resuming pod died mid-turn, holding the lease', async () => {
    const { store, a, b } = await setup();
    live = [a.engine];
    let freezeB = false;
    for (const [name, engine] of [
      ['a', a.engine],
      ['b', b.engine],
    ] as const) {
      engine.register('Test', '1', async (ctx) => {
        const out = await ctx.step(STEP, {});
        // The turn that resumes on B dies inside the body, after it took the run's lease.
        if (name === 'b' && freezeB) {
          b.kill();
          await new Promise(() => {});
        }
        return out;
      });
    }

    await a.engine.start('Test', {}, 'r1');
    await parked(store, 'r1');
    const task = a.transport.dispatched[0];
    if (!task) throw new Error('expected a dispatched task');

    freezeB = true;
    await deliverToDying(b, a, completed(task));
    expect((await store.getRun('r1'))?.lockedBy).toBe('pod-b');

    await tickAt(a.engine, LEASE_MS + 1_000);

    await until(async () => (await store.getRun('r1'))?.status === 'completed');
  });

  it('re-dispatches a step whose first turn died between the checkpoint and the broker', async () => {
    const { store, a, b } = await setup();
    live = [b.engine];
    for (const { engine } of [a, b]) {
      engine.register('Test', '1', async (ctx) => ctx.step(STEP, {}));
    }
    a.transport.crashOnDispatch = () => a.kill();

    void a.engine.start('Test', {}, 'r1');
    await until(() => a.dead());
    await until(async () => (await store.listCheckpoints('r1')).length === 1);
    expect((await store.getRun('r1'))?.status).toBe('running');

    // Lease lapsed: B's recovery finds the orphan.
    await tickAt(b.engine, LEASE_MS + 1_000);
    // …and even after several reconcile wakes the step must have reached a worker.
    for (let i = 0; i < 2 && b.transport.dispatched.length === 0; i += 1) {
      await tickAt(b.engine, RECONCILE_MS + 1_000);
    }
    expect(b.transport.dispatched.map((t) => t.stepId)).toEqual(['r1:0']);
    // Re-sent as the SAME dispatch: a broker that still holds the original job adds nothing (BullMQ
    // derives the job id from this key). The key never reaches the wire.
    const original = a.transport.attempted[0] as RemoteTask;
    const resent = b.transport.dispatched[0] as RemoteTask;
    expect(dispatchKeyOf(resent)).toBeDefined();
    expect(dispatchKeyOf(resent)).toBe(dispatchKeyOf(original));
    expect(JSON.parse(JSON.stringify(resent))).toEqual(JSON.parse(JSON.stringify(original)));
    expect(Object.keys(resent)).not.toContain(String(DISPATCH_KEY));

    const task = b.transport.dispatched[0] as RemoteTask;
    await b.transport.result?.(completed(task));
    await until(async () => (await store.getRun('r1'))?.status === 'completed');
  });

  it('re-dispatches a step whose resumed turn died between the checkpoint and the broker', async () => {
    const { store, a, b } = await setup();
    live = [a.engine];
    for (const { engine } of [a, b]) {
      engine.register('Two', '1', async (ctx) => {
        await ctx.step(STEP, { n: 1 });
        return ctx.step(STEP, { n: 2 });
      });
    }

    await a.engine.start('Two', {}, 'r1');
    await parked(store, 'r1');
    const first = a.transport.dispatched[0];
    if (!first) throw new Error('expected the first step');

    // B consumes step 1's result and resumes the run; its turn dies dispatching step 2.
    b.transport.crashOnDispatch = () => b.kill();
    await deliverToDying(b, a, completed(first));
    await until(async () => (await store.listCheckpoints('r1')).length === 2);

    await tickAt(a.engine, LEASE_MS + 1_000);
    for (let i = 0; i < 2 && a.transport.dispatched.length === 1; i += 1) {
      await tickAt(a.engine, RECONCILE_MS + 1_000);
    }
    expect(a.transport.dispatched.map((t) => t.stepId)).toEqual(['r1:0', 'r1:1']);

    await a.transport.result?.(completed(a.transport.dispatched[1] as RemoteTask, 2));
    await until(async () => (await store.getRun('r1'))?.status === 'completed');
    expect((await store.getRun('r1'))?.output).toBe(2);
  });

  it('acknowledges a result whose resume ends first without an owed-resume write', async () => {
    const { store, a, b } = await setup();
    live = [a.engine, b.engine];
    for (const { engine } of [a, b]) {
      engine.register('Test', '1', async (ctx) => ctx.step(STEP, {}));
    }
    await a.engine.start('Test', {}, 'r1');
    await parked(store, 'r1');
    const task = a.transport.dispatched[0] as RemoteTask;

    const updateRunIf = vi.spyOn(store, 'updateRunIf');
    const pulls = store.pullRunWakesIn ? vi.spyOn(store, 'pullRunWakesIn') : undefined;
    await b.transport.result?.(completed(task));
    // Acknowledged once the turn it owed ended: the run is done, and nothing marked it.
    expect((await store.getRun('r1'))?.status).toBe('completed');
    const marks = updateRunIf.mock.calls.filter(
      ([, statuses, patch]) =>
        statuses.length === 1 &&
        statuses[0] === 'suspended' &&
        Object.keys(patch).join() === 'wakeAt',
    );
    expect(marks).toHaveLength(0);
    expect(pulls?.mock.calls ?? []).toHaveLength(0);
  });

  it('marks the run owed before acknowledging a result whose resume outlasts the grace', async () => {
    const { store, a, b } = await setup();
    live = [a.engine, b.engine];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = false;
    for (const { engine } of [a, b]) {
      engine.register('Test', '1', async (ctx) => {
        const out = await ctx.step(STEP, {});
        // A slow resumed turn on a LIVE pod (it awaits something else in memory).
        if (hold) await held;
        return out;
      });
    }
    await a.engine.start('Test', {}, 'r1');
    await parked(store, 'r1');
    const task = a.transport.dispatched[0] as RemoteTask;

    hold = true;
    const acked = b.transport.result?.(completed(task));
    // Not held hostage by the turn: acknowledged after the grace, with the run due within a lease.
    await acked;
    const run = await store.getRun('r1');
    expect(run?.status).toBe('suspended');
    expect(run?.wakeAt).toBeLessThanOrEqual(now + LEASE_MS);

    release();
    await until(async () => (await store.getRun('r1'))?.status === 'completed');
  });

  it('pulls only the timers of suspended runs in, and only in (pullRunWakesIn)', async () => {
    const { store, a } = await setup();
    live = [a.engine];
    a.engine.register('Test', '1', async (ctx) => ctx.step(STEP, {}));
    for (const id of ['far', 'soon', 'done']) {
      await a.engine.start('Test', {}, id);
      await parked(store, id);
    }
    await store.updateRun('soon', { wakeAt: now + 1_000 });
    await store.updateRun('done', { status: 'completed', wakeAt: now + RECONCILE_MS });
    const by = now + LEASE_MS;
    await store.pullRunWakesIn?.(['far', 'soon', 'done', 'missing', 'far'], by);
    if (!store.pullRunWakesIn) return;
    expect((await store.getRun('far'))?.wakeAt).toBe(by);
    expect((await store.getRun('soon'))?.wakeAt).toBe(now + 1_000);
    expect((await store.getRun('done'))?.wakeAt).toBe(now + RECONCILE_MS);
    expect((await store.getRun('done'))?.status).toBe('completed');
  });

  it('resumes a run whose result settled mid-turn on a pod that died after parking it', async () => {
    const { store, a, b } = await setup();
    live = [b.engine];
    for (const { engine } of [a, b]) {
      engine.register('Test', '1', async (ctx) => ctx.step(STEP, {}));
    }
    // The step's result reaches pod A while A's first turn is still in flight (the run `running`,
    // A's own resume queued behind that turn). A acknowledges it, then dies once the turn parked the
    // run — before letting go of the lease or running the queued resume. Nothing about a `running`
    // run's timer survives the park, so only a durable wake request gets the run back before its
    // reconcile wake.
    a.transport.onDispatch = async (task) => {
      a.transport.onDispatch = undefined;
      // Delivered by the transport's consumer, not from inside the turn.
      await runOutsideWorkflowCtx(() => a.transport.result?.(completed(task)));
      a.onCall('releaseRunLockUnlessWakeRequested', () => a.kill());
    };
    void a.engine.start('Test', {}, 'r1');
    await until(() => a.dead(), 2_000);
    const run = await store.getRun('r1');
    expect(run?.status).toBe('suspended');
    expect(run?.lockedBy).toBe('pod-a');

    await tickAt(b.engine, LEASE_MS + 1_000);
    await until(async () => (await store.getRun('r1'))?.status === 'completed');
  });

  it('does not re-dispatch a step a healthy turn already sent', async () => {
    const { store, a, b } = await setup();
    live = [a.engine, b.engine];
    for (const { engine } of [a, b]) {
      engine.register('Test', '1', async (ctx) => ctx.step(STEP, {}));
    }

    await a.engine.start('Test', {}, 'r1');
    await parked(store, 'r1');

    // The step runs long: reconcile wakes and recovery passes come and go on both pods.
    for (let i = 0; i < 3; i += 1) {
      await tickAt(b.engine, RECONCILE_MS + 1_000);
      await tickAt(a.engine, 1_000);
    }
    expect([...a.transport.dispatched, ...b.transport.dispatched]).toHaveLength(1);
    expect((await store.getRun('r1'))?.status).toBe('suspended');
  });
});
