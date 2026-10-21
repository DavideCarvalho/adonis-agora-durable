import { WorkflowEngine } from '../../src/engine.js';
import { GatherError } from '../../src/errors.js';
import type { RemoteTask, StepResult, Transport, WorkflowRun } from '../../src/interfaces.js';
import {
  DURABLE_STEP_CONFIG,
  DURABLE_STEP_NAME,
  type StepConfig,
  type StepRef,
} from '../../src/step-name-symbol.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

/** Stamp a plain function as a `@Step` reference, as the `@Step` decorator does. */
function stepRef<TInput, TOutput>(name: string, config?: StepConfig): StepRef<TInput, TOutput> {
  const ref = (() => {}) as unknown as StepRef<TInput, TOutput>;
  (ref as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = name;
  if (config) (ref as { [DURABLE_STEP_CONFIG]?: StepConfig })[DURABLE_STEP_CONFIG] = config;
  return ref;
}

const LINE = 'lines.process';
const processLine = stepRef<{ i: number }, number>(LINE);

async function until(check: () => boolean | Promise<boolean>, max = 1000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

function setup(handler: (input: { i: number }) => Promise<number> = async ({ i }) => i * 10) {
  const store = new InMemoryStateStore();
  const transport = new InMemoryTransport();
  let inFlight = 0;
  let maxInFlight = 0;
  const runs: number[] = [];
  transport.handle(LINE, async (input) => {
    const line = input as { i: number };
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    runs.push(line.i);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await handler(line);
    } finally {
      inFlight -= 1;
    }
  });
  const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
  return { store, engine, runs, maxInFlight: () => maxInFlight };
}

describe('ctx.all over a @Step', () => {
  it('runs one step per input and returns their outputs in input order', async () => {
    const { store, engine, runs } = setup();
    let parentTurns = 0;
    engine.register('fan', '1', async (ctx) => {
      parentTurns += 1;
      return ctx.all(processLine, lines(60));
    });

    await startRun(engine, 'fan', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual(lines(60).map(({ i }) => i * 10));
    expect([...runs].sort((a, b) => a - b)).toEqual(lines(60).map(({ i }) => i));
    // Dispatch, then one replay once the fan settles — not one per result.
    expect(parentTurns).toBeLessThanOrEqual(3);
  });

  it('tags every step of the fan with one parallelGroup naming its position block', async () => {
    const { store, engine } = setup();
    engine.register('fan', '1', async (ctx) => {
      await ctx.step<number>(LINE, { i: 99 });
      return ctx.all(processLine, lines(5));
    });

    await startRun(engine, 'fan', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    const cps = await store.listCheckpoints('p');
    const fan = cps.filter((c) => c.seq >= 1);
    expect(fan).toHaveLength(5);
    expect(new Set(fan.map((c) => c.parallelGroup))).toEqual(new Set(['steps:1:5']));
    expect(cps.find((c) => c.seq === 0)?.parallelGroup).toBeUndefined();
  });

  it('keeps at most `concurrency` steps in flight', async () => {
    const { store, engine, maxInFlight } = setup();
    engine.register('fan', '1', async (ctx) => ctx.all(processLine, lines(30), { concurrency: 4 }));

    await startRun(engine, 'fan', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual(lines(30).map(({ i }) => i * 10));
    expect(maxInFlight()).toBeLessThanOrEqual(4);
  });

  it('waitAll lets every step finish, then fails with the failed indexes', async () => {
    const { store, engine, runs } = setup(async ({ i }) => {
      if (i === 2 || i === 5) throw new Error(`bad line ${i}`);
      return i;
    });
    engine.register('fan', '1', async (ctx) => {
      try {
        return await ctx.all(processLine, lines(8));
      } catch (err) {
        if (err instanceof GatherError) return { failed: err.failures.map((f) => f.index) };
        throw err;
      }
    });

    await startRun(engine, 'fan', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual({ failed: [2, 5] });
    expect(runs).toHaveLength(8);
  });

  it('failFast throws on the first failed step', async () => {
    // Only the first step ever settles: waitAll would wait on the other three forever.
    const store = new InMemoryStateStore();
    const transport = new CapturingTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    engine.register('fan', '1', async (ctx) => {
      try {
        return await ctx.all(processLine, lines(4), { mode: 'failFast' });
      } catch (err) {
        if (err instanceof GatherError) return { failed: err.failures.map((f) => f.index) };
        throw err;
      }
    });

    await startRun(engine, 'fan', {}, 'p');
    await until(() => transport.dispatched.length === 4);
    const task = transport.dispatched[0] as RemoteTask;
    await transport.result?.({
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'failed',
      error: { message: 'bad first line' },
    });
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual({ failed: [0] });
  });

  it('retries a failed step per its policy, inside the fan', async () => {
    let attempts = 0;
    const { store, engine } = setup(async ({ i }) => {
      if (i === 1 && attempts++ === 0) throw new Error('transient');
      return i;
    });
    const retried = stepRef<{ i: number }, number>(LINE, { retries: 2 });
    engine.register('fan', '1', async (ctx) => ctx.all(retried, lines(3)));

    await startRun(engine, 'fan', {}, 'p');
    // The retry is scheduled on a durable timer; drive it the way the timer poller would.
    await until(async () => {
      await engine.resumeDueTimers();
      return (await store.getRun('p'))?.status === 'completed';
    });

    expect((await store.getRun('p'))?.output).toEqual([0, 1, 2]);
    const second = (await store.listCheckpoints('p')).find((c) => c.seq === 1);
    expect(second?.attempts).toBe(2);
    expect(second?.parallelGroup).toBe('steps:0:3');
  });

  it('continues past the fan on replay, with the steps after it in order', async () => {
    const { store, engine } = setup();
    engine.register('fan', '1', async (ctx) => {
      const out = await ctx.all(processLine, lines(3));
      const after = await ctx.step<number>(LINE, { i: 7 });
      return [...out, after];
    });

    await startRun(engine, 'fan', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual([0, 10, 20, 70]);
  });

  it('rejects a flow-control queue and a liveness timeoutMs', async () => {
    const { store, engine } = setup();
    const timed = stepRef<{ i: number }, number>(LINE, { timeoutMs: 1_000 });
    engine.register('queued', '1', async (ctx) =>
      ctx.all(processLine, lines(2), { queue: 'q' } as never),
    );
    engine.register('timed', '1', async (ctx) => ctx.all(timed, lines(2)));

    await startRun(engine, 'queued', {}, 'q1');
    await startRun(engine, 'timed', {}, 't1');
    await until(async () => (await store.getRun('t1'))?.status === 'failed');

    expect((await store.getRun('q1'))?.error?.message).toMatch(/flow-control queue/);
    expect((await store.getRun('t1'))?.error?.message).toMatch(/liveness timeoutMs/);
  });
});

/** Holds the first `suspended` write until the test lets it through. */
class HeldSuspendStore extends InMemoryStateStore {
  release: (() => void) | undefined;
  held = false;

  override async updateRunIf(
    runId: string,
    expected: Parameters<InMemoryStateStore['updateRunIf']>[1],
    patch: Partial<WorkflowRun>,
  ): Promise<boolean> {
    if (patch.status === 'suspended' && !this.held) {
      this.held = true;
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return super.updateRunIf(runId, expected, patch);
  }
}

class CapturingTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  result: ((r: StepResult) => Promise<void>) | undefined;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(): void {}
}

describe('ctx.all over a @Step across instances', () => {
  it('runs each step exactly once when the results land on other instances mid-dispatch', async () => {
    for (const instances of [1, 3]) {
      const store = new InMemoryStateStore();
      // One shared transport: the last engine bound receives every result.
      const transport = new InMemoryTransport();
      const runs = new Map<number, number>();
      transport.handle(LINE, async (input) => {
        const { i } = input as { i: number };
        runs.set(i, (runs.get(i) ?? 0) + 1);
        return i;
      });
      const engines = Array.from(
        { length: instances },
        () => new WorkflowEngine({ store, transport, reconcileMs: 0 }),
      );
      for (const engine of engines) {
        engine.register('fan', '1', async (ctx) => ctx.all(processLine, lines(40)));
      }

      await startRun(engines[0] as WorkflowEngine, 'fan', {}, 'p');
      await until(async () => (await store.getRun('p'))?.status === 'completed');

      expect((await store.getRun('p'))?.output).toEqual(lines(40).map(({ i }) => i));
      expect([...runs.values()].every((n) => n === 1)).toBe(true);
      expect(runs.size).toBe(40);
    }
  });

  it('completes when another instance settles the whole fan while the parent holds its lease', async () => {
    const store = new HeldSuspendStore();
    const onA = new CapturingTransport();
    const onB = new CapturingTransport();
    const a = new WorkflowEngine({ store, transport: onA, reconcileMs: 0 });
    const b = new WorkflowEngine({ store, transport: onB, reconcileMs: 0 });
    for (const engine of [a, b]) {
      engine.register('fan', '1', async (ctx) => ctx.all(processLine, lines(3)));
    }

    const started = startRun(a, 'fan', {}, 'p');
    await until(() => onA.dispatched.length === 3 && store.release !== undefined);
    // B settles every step; the last result opens the barrier, and its resume finds A's lease.
    for (const task of onA.dispatched) {
      await onB.result?.({
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        status: 'completed',
        output: task.seq * 10,
      });
    }
    expect((await store.getRun('p'))?.lockedBy).toBeDefined();

    store.release?.();
    await started;
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual([0, 10, 20]);
  });

  it('does not re-drive the parent for a step settled while the fan is still running', async () => {
    const store = new HeldSuspendStore();
    const onA = new CapturingTransport();
    const onB = new CapturingTransport();
    const a = new WorkflowEngine({ store, transport: onA, reconcileMs: 0 });
    const b = new WorkflowEngine({ store, transport: onB, reconcileMs: 0 });
    let parentTurns = 0;
    for (const engine of [a, b]) {
      engine.register('fan', '1', async (ctx) => {
        parentTurns += 1;
        return ctx.all(processLine, lines(3));
      });
    }

    const started = startRun(a, 'fan', {}, 'p');
    await until(() => onA.dispatched.length === 3 && store.release !== undefined);
    const deliver = (task: RemoteTask) =>
      onB.result?.({
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        status: 'completed',
        output: task.seq * 10,
      });
    const [first, ...rest] = onA.dispatched as [RemoteTask, ...RemoteTask[]];
    await deliver(first);

    store.release?.();
    await started;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(parentTurns).toBe(1);

    for (const task of rest) await deliver(task);
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect(parentTurns).toBe(2);
  });
});
