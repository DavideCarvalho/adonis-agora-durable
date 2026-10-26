import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  RemoteTask,
  StateStore,
  StepCheckpoint,
  StepResult,
  StepSettlement,
  Transport,
  WorkflowRun,
} from '../../src/interfaces.js';
import { DURABLE_STEP_NAME, type StepRef } from '../../src/step-name-symbol.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * The barrier of a step fan, and the turns it costs. A batch with another of its fan's results
 * queued behind it on the same instance leaves the barrier to that result; a turn while a fan is out
 * reads no row per step; and two instances that see a wave settle at the same moment run one turn
 * for it, not two.
 */

const LINE = 'Lines.process';
const processLine = (() => {}) as unknown as StepRef<{ i: number }, number>;
(processLine as unknown as { [DURABLE_STEP_NAME]: string })[DURABLE_STEP_NAME] = LINE;

const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

async function until(check: () => boolean | Promise<boolean>, max = 2000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

/** Records dispatches; the test delivers the results, as a broker's results consumer would. */
class HeldTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  handler?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.handler = handler;
  }
  onHeartbeat(): void {}
  /** Take every dispatched task not yet taken. */
  take(): RemoteTask[] {
    return this.dispatched.splice(0);
  }
  deliver(result: StepResult): Promise<void> {
    if (!this.handler) throw new Error('no result handler');
    return this.handler(result);
  }
}

const ok = (t: RemoteTask, output: unknown = (t.input as { i: number }).i * 10): StepResult => ({
  runId: t.runId,
  seq: t.seq,
  stepId: t.stepId,
  status: 'completed',
  output,
});

/** Counts every store call by method. */
function counting<T extends StateStore>(inner: T): { store: T; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.set(String(prop), (calls.get(String(prop)) ?? 0) + 1);
        return value.apply(target, args);
      };
    },
  });
  return { store, calls };
}

function setup(store: StateStore = new InMemoryStateStore()) {
  const transport = new HeldTransport();
  const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
  let turns = 0;
  const settled: number[] = [];
  engine.subscribe((e) => {
    if (e.type === 'step.completed' || e.type === 'step.failed') settled.push(e.seq ?? -1);
  });
  const register = (body: Parameters<WorkflowEngine['register']>[2]) =>
    engine.register('fan', '1', async (ctx, input) => {
      turns += 1;
      return body(ctx, input);
    });
  return { store, transport, engine, register, settled, turns: () => turns };
}

describe('a step fan barrier', () => {
  /** A store whose batched write waits for `open()`, so a test can queue results behind a batch. */
  class GatedStore extends InMemoryStateStore {
    open?: () => void;
    gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
    failReads = new Set<number>();
    override async settleCheckpointsIfPending(settlements: StepSettlement[]): Promise<boolean[]> {
      if (settlements.length > 1) await this.gate;
      return super.settleCheckpointsIfPending(settlements);
    }
    override async getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null> {
      if (this.failReads.delete(seq)) throw new Error('connection lost');
      return super.getCheckpoint(runId, seq);
    }
  }

  it('a batch with a result of its fan queued behind it leaves the barrier to that result', async () => {
    const { store, calls } = counting(new GatedStore());
    const { transport, engine, register, turns } = setup(store);
    register(async (ctx) => ctx.all(processLine, lines(20)));
    await engine.start('fan', {}, 'p');
    await until(() => transport.dispatched.length === 20);
    await until(async () => (await store.getRun('p'))?.status === 'suspended');
    // The dispatching turn's own look at its fan once it let go of the lease, done before counting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    calls.clear();
    const tasks = transport.take();
    const first = tasks[0] as RemoteTask;
    const deliveries = tasks.map((t) => transport.deliver(ok(t)));
    // Queued while the batch holding every step is written: a redelivery of a settled step.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const redelivered = transport.deliver(ok(first, 'late copy'));
    store.open?.();
    await Promise.all([...deliveries, redelivered]);
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual(lines(20).map(({ i }) => i * 10));
    expect(calls.get('countCheckpoints')).toBe(1);
    expect(turns()).toBe(2);
  });

  it('a result queued for a seq outside the fan does not hold back its barrier', async () => {
    const store = new GatedStore();
    const { transport, engine, register } = setup(store);
    register(async (ctx) => ctx.all(processLine, lines(10)));
    await engine.start('fan', {}, 'p');
    await until(() => transport.dispatched.length === 10);
    await until(async () => (await store.getRun('p'))?.status === 'suspended');
    const deliveries = transport.take().map((t) => transport.deliver(ok(t)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stray = transport.deliver({ runId: 'p', seq: 999, stepId: 'p:999', status: 'completed' });
    store.open?.();
    await Promise.all([...deliveries, stray]);
    await until(async () => (await store.getRun('p'))?.status === 'completed');
  });

  it('the queued result the barrier was left to fails, and its redelivery opens it', async () => {
    const store = new GatedStore();
    const { transport, engine, register } = setup(store);
    register(async (ctx) => ctx.all(processLine, lines(10)));
    await engine.start('fan', {}, 'p');
    await until(() => transport.dispatched.length === 10);
    await until(async () => (await store.getRun('p'))?.status === 'suspended');
    const tasks = transport.take();
    const first = tasks[0] as RemoteTask;
    const deliveries = tasks.map((t) => transport.deliver(ok(t)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.failReads.add(first.seq);
    const redelivered = transport.deliver(ok(first));
    store.open?.();
    await Promise.all(deliveries);
    await expect(redelivered).rejects.toThrow('connection lost');
    expect((await store.getRun('p'))?.status).toBe('suspended');
    await transport.deliver(ok(first));
    await until(async () => (await store.getRun('p'))?.status === 'completed');
  });

  it('a turn that runs while a fan is out costs a fixed number of store calls, not one per step', async () => {
    const { store, calls } = counting(new InMemoryStateStore());
    const { transport, engine, register, turns } = setup(store);
    register(async (ctx) => ctx.all(processLine, lines(2_000)));
    await engine.start('fan', {}, 'p');
    await until(() => transport.dispatched.length === 2_000);
    await until(async () => (await store.getRun('p'))?.status === 'suspended');
    calls.clear();
    await engine.resume('p');
    expect(turns()).toBe(2);
    expect((await store.getRun('p'))?.status).toBe('suspended');
    expect(calls.get('getCheckpoint') ?? 0).toBe(0);
    const total = [...calls.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(12);
  });

  it('two instances that see a wave settle at once run one turn for it, not two', async () => {
    // Both instances' barrier reads wait for each other, so both see the wave settled and both
    // resume the run. The one that gets the lease parks the run only once the other has kept its
    // wake and looked at the run, as it does when its turn outlasts a couple of store round-trips.
    class RacingStore extends InMemoryStateStore {
      counting = false;
      private counted: (() => void)[] = [];
      private looked?: () => void;
      private holdSuspend?: Promise<void>;
      override async countCheckpoints(
        runId: string,
        from: number,
        to: number,
        statuses: StepCheckpoint['status'][],
      ): Promise<number> {
        if (this.counting) {
          await new Promise<void>((resolve) => {
            this.counted.push(resolve);
            if (this.counted.length === 2) {
              this.counting = false;
              this.holdSuspend = new Promise<void>((looked) => {
                this.looked = looked;
                setTimeout(looked, 1_000);
              });
              for (const release of this.counted.splice(0)) release();
            }
          });
        }
        return super.countCheckpoints(runId, from, to, statuses);
      }
      // Time for the instance that kept the wake to look at the run.
      override async bufferEvent(input: {
        name: string;
        payload: unknown;
        id: string;
        publishedAt: number;
      }): Promise<void> {
        await super.bufferEvent(input);
        if (input.name.startsWith('durable:wake-request:')) setTimeout(() => this.looked?.(), 20);
      }
      override async updateRunIf(
        runId: string,
        statuses: WorkflowRun['status'][],
        patch: Partial<WorkflowRun>,
      ): Promise<boolean> {
        if (patch.status === 'suspended' && this.holdSuspend) {
          const hold = this.holdSuspend;
          delete this.holdSuspend;
          await hold;
        }
        return super.updateRunIf(runId, statuses, patch);
      }
    }
    const store = new RacingStore();
    const onA = new HeldTransport();
    const onB = new HeldTransport();
    let turns = 0;
    const engines = [onA, onB].map((transport) => {
      const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
      engine.register('fan', '1', async (ctx) => {
        turns += 1;
        return ctx.all(processLine, lines(20), { concurrency: 10 });
      });
      return engine;
    });
    await (engines[0] as WorkflowEngine).start('fan', {}, 'p');
    const dispatched = () => onA.dispatched.length + onB.dispatched.length;
    const take = () => [...onA.take(), ...onB.take()];
    await until(() => dispatched() === 10);
    await until(async () => (await store.getRun('p'))?.status === 'suspended');
    // The first wave: half its results to each instance, each in one batch.
    store.counting = true;
    const first = take();
    await Promise.all(first.map((t, i) => (i % 2 ? onA : onB).deliver(ok(t))));
    await until(() => dispatched() === 10);
    await until(async () => (await store.getRun('p'))?.status === 'suspended');
    // Past the re-check of the wake the second instance kept.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(turns).toBe(2);
    await Promise.all(take().map((t) => onA.deliver(ok(t))));
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual(lines(20).map(({ i }) => i * 10));
    // The dispatching turn, then one per settled wave.
    expect(turns).toBe(3);
  }, 15_000);
});
