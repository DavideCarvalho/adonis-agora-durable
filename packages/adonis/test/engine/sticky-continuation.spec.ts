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
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * Sticky continuations (see `sticky-continuation.ts`): a body parked on dispatched steps continues
 * on its next turn here instead of replaying. These pin that it stays a pure optimization: the
 * outcome, the history and each step's dispatches are those of a replaying engine, under a lease
 * taken over by another instance, a restart, an eviction, a detached body, a cancel, a retry, and
 * results landing together. Every case runs with the store's round-trip methods off and on.
 */

/** Records dispatches; the test delivers the results, to whichever instance it picks. */
class HeldTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  readonly handlers: ((r: StepResult) => Promise<void>)[] = [];
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.handlers.push(handler);
  }
  onHeartbeat(): void {}
  /** Deliver to the `instance`-th engine bound to this transport. */
  deliver(result: StepResult, instance = 0): Promise<void> {
    const handler = this.handlers[instance];
    if (!handler) throw new Error(`no engine #${instance}`);
    return handler(result);
  }
  take(name?: string, runId?: string): RemoteTask[] {
    const out = this.dispatched.filter(
      (t) => (name === undefined || t.name === name) && (runId === undefined || t.runId === runId),
    );
    for (const t of out) this.dispatched.splice(this.dispatched.indexOf(t), 1);
    return out;
  }
}

const ok = (t: RemoteTask, output: unknown): StepResult => ({
  runId: t.runId,
  seq: t.seq,
  stepId: t.stepId,
  status: 'completed',
  output,
});

async function until(check: () => boolean | Promise<boolean>, max = 1_000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

/** Counts history snapshots (full replays). */
class CountingStore extends InMemoryStateStore {
  snapshots = 0;
  override async listCheckpointsForReplay(runId: string): Promise<StepCheckpoint[]> {
    this.snapshots += 1;
    return super.listCheckpointsForReplay(runId);
  }
}

const status = async (store: InMemoryStateStore, id: string): Promise<RunStatus | undefined> =>
  (await store.getRun(id))?.status;

const stickyStats = (engine: WorkflowEngine) =>
  (engine as unknown as { sticky: { hits: number; misses: number; size: number } }).sticky;

describe.each([false, true])('sticky continuations (store round-trip methods: %s)', (fast) => {
  const makeStore = () => new CountingStore({ roundTripMethods: fast });

  /** `n` sequential dispatched steps, each returning its input + 1. */
  const sequential = (engine: WorkflowEngine, n: number, entries: { count: number }) =>
    engine.register('seq', '1', async (ctx) => {
      entries.count += 1;
      const out: number[] = [];
      for (let i = 0; i < n; i += 1) out.push(await ctx.step<number>('s.add', i));
      return out;
    });

  /** Deliver each dispatched `s.add` task's result (input + 1) until the run settles. */
  async function drive(
    store: InMemoryStateStore,
    transport: HeldTransport,
    runId: string,
    pick: (step: number) => number = () => 0,
  ): Promise<void> {
    let step = 0;
    for (;;) {
      const st = await status(store, runId);
      if (st === 'completed' || st === 'failed' || st === 'cancelled') return;
      const [task] = transport.take('s.add', runId);
      if (!task) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        continue;
      }
      // Suspended AND let go of: a result landing while the parking turn still holds the lease is
      // refused there and asks that turn's instance for the next turn, whoever received it.
      await until(async () => {
        const run = await store.getRun(runId);
        return run?.status === 'suspended' && run.lockedBy === undefined;
      });
      await transport.deliver(ok(task, (task.input as number) + 1), pick(step));
      step += 1;
    }
  }

  it('runs the body once and reads the history once, over many sequential steps', async () => {
    const store = makeStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    const entries = { count: 0 };
    sequential(engine, 30, entries);
    await engine.start('seq', {}, 'r1');
    await drive(store, transport, 'r1');
    await until(async () => (await status(store, 'r1')) === 'completed');
    expect((await store.getRun('r1'))?.output).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(entries.count).toBe(1);
    expect(store.snapshots).toBe(1);
    expect(stickyStats(engine).hits).toBe(30);
  });

  it('continues once for parallel step results that arrive together', async () => {
    const store = makeStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    let entries = 0;
    engine.register('pair', '1', async (ctx) => {
      entries += 1;
      const [a, b] = await Promise.all([ctx.step<number>('s.a', 1), ctx.step<number>('s.b', 2)]);
      const c = await ctx.step<number>('s.c', a + b);
      return [a, b, c];
    });
    await engine.start('pair', {}, 'p');
    await until(() => transport.dispatched.length === 2);
    await until(async () => (await status(store, 'p')) === 'suspended');
    const [a, b] = transport.take();
    await Promise.all([
      transport.deliver(ok(a as RemoteTask, 10)),
      transport.deliver(ok(b as RemoteTask, 20)),
    ]);
    await until(() => transport.dispatched.length === 1);
    const [c] = transport.take();
    expect(c?.name).toBe('s.c');
    expect(c?.input).toBe(30);
    await until(async () => (await status(store, 'p')) === 'suspended');
    await transport.deliver(ok(c as RemoteTask, 99));
    await until(async () => (await status(store, 'p')) === 'completed');
    expect((await store.getRun('p'))?.output).toEqual([10, 20, 99]);
    expect(entries).toBe(1);
    expect(transport.dispatched).toHaveLength(0);
  });

  it('continues a body parked on two steps whose results land one at a time', async () => {
    const store = makeStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    let entries = 0;
    engine.register('pair', '1', async (ctx) => {
      entries += 1;
      return Promise.all([ctx.step<number>('s.a', 1), ctx.step<number>('s.b', 2)]);
    });
    await engine.start('pair', {}, 'p');
    await until(() => transport.dispatched.length === 2);
    await until(async () => (await status(store, 'p')) === 'suspended');
    const [a, b] = transport.take();
    await transport.deliver(ok(a as RemoteTask, 10));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await status(store, 'p')).toBe('suspended');
    await transport.deliver(ok(b as RemoteTask, 20));
    await until(async () => (await status(store, 'p')) === 'completed');
    expect((await store.getRun('p'))?.output).toEqual([10, 20]);
    expect(entries).toBe(1);
    expect(transport.dispatched).toHaveLength(0);
  });

  it('replays when another instance ran a turn in between (lease taken elsewhere)', async () => {
    const store = makeStore();
    const transport = new HeldTransport();
    const a = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    const b = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    const entries = { count: 0 };
    sequential(a, 4, entries);
    sequential(b, 4, entries);
    await a.start('seq', {}, 'r1');
    // Step 0 resumes on A (warm), step 1 on B (cold: B never ran it), step 2 back on A, whose
    // parked body is now stale (B moved the run on) and must not be continued.
    await drive(store, transport, 'r1', (step) => [0, 1, 0, 0][step] ?? 0);
    await until(async () => (await status(store, 'r1')) === 'completed');
    expect((await store.getRun('r1'))?.output).toEqual([1, 2, 3, 4]);
    // Every step dispatched exactly once, whoever ran the turn.
    const cps = await store.listCheckpoints('r1');
    expect(cps.map((cp) => [cp.seq, cp.status, cp.attempts])).toEqual([
      [0, 'completed', 1],
      [1, 'completed', 1],
      [2, 'completed', 1],
      [3, 'completed', 1],
    ]);
    // A's first body, B's replay, A's replay after B's turn: A's parked body, stale once B moved
    // the run on, was not continued (that would make it 2). More is a spare turn: B's re-check of
    // the step it parked on finds it settled by A, and replays (as it would without the cache).
    expect(entries.count).toBeGreaterThanOrEqual(3);
  });

  it('a new instance (a restart) replays a run another instance parked', async () => {
    const store = makeStore();
    const transport = new HeldTransport();
    const dead = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    const entries = { count: 0 };
    sequential(dead, 3, entries);
    await dead.start('seq', {}, 'r1');
    await until(async () => (await status(store, 'r1')) === 'suspended');
    // The first instance goes away with the body parked in its memory.
    const fresh = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    sequential(fresh, 3, entries);
    await drive(store, transport, 'r1', () => 1);
    await until(async () => (await status(store, 'r1')) === 'completed');
    expect((await store.getRun('r1'))?.output).toEqual([1, 2, 3]);
    // The parked body died with its instance: the new one replays (and may replay again for a spare
    // turn the old instance's settle-vs-delivery re-check asks for), then continues its own body.
    expect(entries.count).toBeGreaterThanOrEqual(2);
    expect(stickyStats(fresh).hits).toBeGreaterThanOrEqual(1);
  });

  it('an evicted body replays; the cache holds no more than stickyRuns bodies', async () => {
    const store = makeStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0, stickyRuns: 1 });
    const entries = { count: 0 };
    sequential(engine, 2, entries);
    await engine.start('seq', {}, 'x');
    await until(async () => (await status(store, 'x')) === 'suspended');
    await engine.start('seq', {}, 'y');
    await until(async () => (await status(store, 'y')) === 'suspended');
    expect(stickyStats(engine).size).toBe(1);
    // x was evicted by y, so it replays; parking x again then evicts y, which replays in turn.
    await drive(store, transport, 'x');
    await drive(store, transport, 'y');
    await until(async () => (await status(store, 'x')) === 'completed');
    await until(async () => (await status(store, 'y')) === 'completed');
    expect((await store.getRun('x'))?.output).toEqual([1, 2]);
    expect((await store.getRun('y'))?.output).toEqual([1, 2]);
    expect(entries.count).toBe(4);
    expect(stickyStats(engine).size).toBeLessThanOrEqual(1);
  });

  it('an idle body past stickyIdleMs replays', async () => {
    const store = makeStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0, stickyIdleMs: 5 });
    const entries = { count: 0 };
    sequential(engine, 1, entries);
    await engine.start('seq', {}, 'r1');
    await until(async () => (await status(store, 'r1')) === 'suspended');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await drive(store, transport, 'r1');
    await until(async () => (await status(store, 'r1')) === 'completed');
    expect(entries.count).toBe(2);
  });

  it('still detects non-determinism on a warm turn: a parked step renamed in the history', async () => {
    const store = makeStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    sequential(engine, 2, { count: 0 });
    await engine.start('seq', {}, 'r1');
    await until(async () => (await status(store, 'r1')) === 'suspended');
    const [task] = transport.take();
    const cp = (await store.getCheckpoint('r1', 0)) as StepCheckpoint;
    await store.saveCheckpoint({ ...cp, name: 'something.else' });
    await transport.deliver({ ...ok(task as RemoteTask, 1), stepId: cp.stepId ?? '' });
    await until(async () => (await status(store, 'r1')) === 'failed');
    expect((await store.getRun('r1'))?.error?.code).toBe('non_determinism');
  });

  it('still detects non-determinism past the park point: a later position written by another body', async () => {
    const store = makeStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    sequential(engine, 2, { count: 0 });
    await engine.start('seq', {}, 'r1');
    await until(async () => (await status(store, 'r1')) === 'suspended');
    const [task] = transport.take();
    // A turn of another version got further than this body and left its own step at position 1.
    const cp = (await store.getCheckpoint('r1', 0)) as StepCheckpoint;
    await store.saveCheckpoint({ ...cp, seq: 1, name: 'other.step', stepId: 'r1:1' });
    await transport.deliver(ok(task as RemoteTask, 1));
    await until(async () => (await status(store, 'r1')) === 'failed');
    expect((await store.getRun('r1'))?.error?.code).toBe('non_determinism');
  });

  it('refuses a primitive the body calls while detached, and the run replays instead', async () => {
    const store = makeStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    let entries = 0;
    let localRuns = 0;
    engine.register('detached', '1', async (ctx) => {
      entries += 1;
      const pending = ctx.step<number>('s.a', 1);
      // A raw timer, outside the ctx: the body is quiescent (parked on s.a) while it waits, so the
      // turn parks and releases the lease before the timer fires.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const local = await ctx.localStep('local', async () => {
        localRuns += 1;
        return 5;
      });
      return (await pending) + local;
    });
    await engine.start('detached', {}, 'd');
    await until(async () => (await status(store, 'd')) === 'suspended');
    // Let the timer fire while detached: its localStep must not run.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(localRuns).toBe(0);
    expect(await store.getCheckpoint('d', 1)).toBeNull();
    const [task] = transport.take();
    await transport.deliver(ok(task as RemoteTask, 10));
    await until(async () => (await status(store, 'd')) === 'completed', 2_000);
    expect((await store.getRun('d'))?.output).toBe(15);
    expect(localRuns).toBe(1);
    expect(entries).toBe(2);
  });

  it('a run cancelled while its body is parked is not continued', async () => {
    const store = makeStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    const entries = { count: 0 };
    sequential(engine, 2, entries);
    await engine.start('seq', {}, 'r1');
    await until(async () => (await status(store, 'r1')) === 'suspended');
    await engine.cancel('r1');
    const [task] = transport.take();
    await transport.deliver(ok(task as RemoteTask, 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await status(store, 'r1')).toBe('cancelled');
    expect(transport.dispatched).toHaveLength(0);
    expect(entries.count).toBe(1);
  });

  it('a failed step retries from the parked body, on its backoff', async () => {
    let now = 1_000_000;
    const store = makeStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0, clock: () => now });
    let entries = 0;
    engine.register('retry', '1', async (ctx) => {
      entries += 1;
      return ctx.step<number>('s.flaky', 1, { retries: 2, backoffMs: 1_000 });
    });
    await engine.start('retry', {}, 'r1');
    await until(async () => (await status(store, 'r1')) === 'suspended');
    const [first] = transport.take();
    await transport.deliver({
      ...ok(first as RemoteTask, undefined),
      status: 'failed',
      error: { message: 'try again' },
    });
    await until(async () => (await store.getCheckpoint('r1', 0))?.wakeAt !== undefined);
    await until(async () => (await status(store, 'r1')) === 'suspended');
    expect(transport.dispatched).toHaveLength(0);
    now += 1_500;
    await engine.resumeDueTimers(now);
    await until(() => transport.dispatched.length === 1);
    const [second] = transport.take();
    expect(second?.attempt).toBe(2);
    await until(async () => (await status(store, 'r1')) === 'suspended');
    await transport.deliver(ok(second as RemoteTask, 7));
    await until(async () => (await status(store, 'r1')) === 'completed');
    expect((await store.getRun('r1'))?.output).toBe(7);
    expect(entries).toBe(1);
  });

  it('a body that sleeps after a step is not kept: the sleep suspends the classic way', async () => {
    let now = 1_000_000;
    const store = makeStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0, clock: () => now });
    let entries = 0;
    engine.register('nap', '1', async (ctx) => {
      entries += 1;
      const a = await ctx.step<number>('s.a', 1);
      await ctx.sleep(1_000);
      return a + (await ctx.step<number>('s.b', 2));
    });
    await engine.start('nap', {}, 'n');
    await until(async () => (await status(store, 'n')) === 'suspended');
    const [a] = transport.take();
    await transport.deliver(ok(a as RemoteTask, 10));
    await until(async () => (await store.getRun('n'))?.wakeAt === now + 1_000);
    now += 1_500;
    await engine.resumeDueTimers(now);
    await until(() => transport.dispatched.length === 1);
    const [b] = transport.take();
    await until(async () => (await status(store, 'n')) === 'suspended');
    await transport.deliver(ok(b as RemoteTask, 5));
    await until(async () => (await status(store, 'n')) === 'completed');
    expect((await store.getRun('n'))?.output).toBe(15);
    // The first body parked on s.a and continued; the sleep made it single-use, so the timer's turn
    // replayed, and that replay's body parked on s.b and continued.
    expect(entries).toBe(2);
  });

  it('stickyRuns: 0 replays every turn', async () => {
    const store = makeStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0, stickyRuns: 0 });
    const entries = { count: 0 };
    sequential(engine, 3, entries);
    await engine.start('seq', {}, 'r1');
    await drive(store, transport, 'r1');
    await until(async () => (await status(store, 'r1')) === 'completed');
    expect((await store.getRun('r1'))?.output).toEqual([1, 2, 3]);
    expect(entries.count).toBe(4);
  });
});

describe('the first turn of a run', () => {
  it('does not resurrect a run cancelled between its read and its start', async () => {
    // The run is read `pending`, then cancelled before the turn marks it `running`.
    class CancelBeforeStart extends InMemoryStateStore {
      armed = true;
      override async updateRunIf(
        runId: string,
        expected: RunStatus[],
        patch: Partial<WorkflowRun>,
      ): Promise<boolean> {
        if (this.armed && patch.status === 'running') {
          this.armed = false;
          await super.updateRun(runId, { status: 'cancelled' });
        }
        return super.updateRunIf(runId, expected, patch);
      }
    }
    const store = new CancelBeforeStart();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    let entries = 0;
    engine.register('wf', '1', async () => {
      entries += 1;
      return 'ran';
    });
    await engine.start('wf', {}, 'r1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await status(store, 'r1')).toBe('cancelled');
    expect(entries).toBe(0);
  });
});
