import { describe, expect, it } from 'vitest';
import { instantCheckpoint } from '../../src/checkpoints.js';
import { CHILD_DELIVERED_TAG } from '../../src/child-delivery.js';
import { allChildId, allGroup } from '../../src/fan-join.js';
import {
  GatherError,
  type RemoteTask,
  type RunStatus,
  type Settled,
  type StateStore,
  type StepResult,
  type Transport,
  type WorkflowCtx,
  WorkflowEngine,
  type WorkflowEngineDeps,
} from '../../src/index.js';
import { DURABLE_STEP_NAME, type StepRef } from '../../src/step-name-symbol.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';
import { EventEmitterTransport } from '../../src/transports/event-emitter.js';

/**
 * Wide `ctx.all` / `ctx.allSettled` fans that lose child completions (a crash, a scale-down or a store
 * error between a child's terminal write and its notification), suspended runs whose step already
 * finished, and the per-instance bound on in-process runs. Every wait is a condition polled until it
 * holds; nothing depends on how long a step of the engine takes.
 */

async function until(cond: () => boolean | Promise<boolean>, ms = 20_000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const status = async (store: StateStore, id: string) => (await store.getRun(id))?.status;
const finished = async (store: StateStore, id: string) => {
  const s = await status(store, id);
  return s === 'completed' || s === 'failed';
};

type Mode = 'all' | 'allSettled';
const MODES: Mode[] = ['all', 'allSettled'];
const fan = (ctx: WorkflowCtx, mode: Mode, inputs: unknown[], concurrency?: number) =>
  mode === 'all'
    ? ctx.all('child', inputs, concurrency === undefined ? undefined : { concurrency })
    : ctx.allSettled('child', inputs, concurrency === undefined ? undefined : { concurrency });

/**
 * An in-memory store whose child-completion deliveries can be lost, failed or held back, with its
 * run reads counted.
 */
function lossyStore(opts: { withoutGetRuns?: boolean } = {}) {
  const inner = new InMemoryStateStore();
  const counts = { getRun: 0, getRuns: 0, takeBufferedSignal: 0, getRunIds: [] as string[] };
  let releaseHeld!: () => void;
  const held = new Promise<void>((r) => {
    releaseHeld = r;
  });
  const control = {
    loseChildCompletions: false,
    failChildDeliveries: 0,
    holdChildDeliveries: false,
    heldDeliveries: 0,
    releaseHeld,
  };
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'getRuns' && opts.withoutGetRuns) return undefined;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === 'getRun') {
        return (id: string) => {
          counts.getRun += 1;
          counts.getRunIds.push(id);
          return inner.getRun(id);
        };
      }
      if (prop === 'getRuns') {
        return (ids: string[]) => {
          counts.getRuns += 1;
          return inner.getRuns(ids);
        };
      }
      if (prop === 'takeBufferedSignal') {
        return (token: string) => {
          counts.takeBufferedSignal += 1;
          return inner.takeBufferedSignal(token);
        };
      }
      if (prop === 'takeSignalWaiter') {
        return async (token: string) => {
          if (token.startsWith('child:')) {
            if (control.holdChildDeliveries) {
              control.heldDeliveries += 1;
              await held;
            }
            if (control.failChildDeliveries > 0) {
              control.failChildDeliveries -= 1;
              throw new Error('store briefly unreachable');
            }
            if (control.loseChildCompletions) return null;
          }
          return inner.takeSignalWaiter(token);
        };
      }
      if (prop === 'bufferSignal') {
        return async (token: string, payload: unknown) => {
          if (token.startsWith('child:') && control.loseChildCompletions) return;
          return inner.bufferSignal(token, payload);
        };
      }
      return value.bind(target);
    },
  }) as InMemoryStateStore;
  return { store, inner, counts, control };
}

/** What a finished child of the 40,000-child fan below ended as, by index. */
function childOutcome(mode: Mode, i: number): { status: RunStatus; error?: string } {
  if (mode === 'all') return { status: 'completed' };
  const kind = i % 4;
  if (kind === 1) return { status: 'failed', error: `boom-${i}` };
  if (kind === 2) return { status: 'cancelled', error: 'cancelled' };
  if (kind === 3) return { status: 'dead', error: 'max recovery attempts' };
  return { status: 'completed' };
}

describe.each(MODES)('ctx.%s: lost child completions', (mode) => {
  it('a 40,000-child fan whose completions were all lost finishes on the parent next turn, reading the children in batches', async () => {
    const n = 40_000;
    const { store, inner, counts } = lossyStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('child', '1', async (_ctx, input) => input);
    engine.register('parent', '1', async (ctx) =>
      fan(
        ctx,
        mode,
        Array.from({ length: n }, (_, i) => i),
      ),
    );
    // The state a crash leaves: the parent suspended on the fan (a `running` placeholder and a
    // `child:` waiter per child, exactly as ctx.all writes them), every child finished, and no
    // completion delivered.
    const at = new Date();
    const group = allGroup(0, n, 'waitAll');
    await inner.createRun({
      id: 'p',
      workflow: 'parent',
      workflowVersion: '1',
      status: 'suspended',
      input: {},
      namespace: 'default',
      createdAt: at,
      updatedAt: at,
    });
    for (let i = 0; i < n; i += 1) {
      const id = allChildId('p', 0, i);
      await inner.putSignalWaiter({
        token: `child:${id}`,
        runId: 'p',
        seq: i,
        parallelGroup: group,
      });
      await inner.saveCheckpoint(
        instantCheckpoint({
          runId: 'p',
          seq: i,
          name: `signal:child:${id}`,
          kind: 'signal',
          status: 'running',
          parallelGroup: group,
        }),
      );
      const outcome = childOutcome(mode, i);
      await inner.createRun({
        id,
        workflow: 'child',
        workflowVersion: '1',
        status: outcome.status,
        input: i,
        ...(outcome.status === 'completed' ? { output: i } : {}),
        ...(outcome.error ? { error: { message: outcome.error } } : {}),
        namespace: 'default',
        createdAt: at,
        updatedAt: at,
      });
    }

    await engine.runOne('p');
    await until(() => finished(store, 'p'), 120_000, 'the parent');
    const parent = await store.getRun('p');
    expect(parent?.status).toBe('completed');
    if (mode === 'all') {
      expect(parent?.output).toEqual(Array.from({ length: n }, (_, i) => i));
    } else {
      const out = parent?.output as Settled<number>[];
      expect(out).toHaveLength(n);
      for (const i of [0, 1, 2, 3, 39_998, 39_999]) {
        const outcome = childOutcome(mode, i);
        if (outcome.status === 'completed')
          expect(out[i]).toEqual({ status: 'fulfilled', value: i });
        else expect(out[i]).toMatchObject({ status: 'rejected', error: outcome.error });
      }
      expect(out.filter((s) => s.status === 'rejected')).toHaveLength((n / 4) * 3);
    }
    // One batched read per 500 children, and the buffered completions listed once: never a read
    // per child.
    expect(counts.getRuns).toBeLessThanOrEqual(Math.ceil(n / 500) + 2);
    expect(counts.getRun).toBeLessThan(50);
    expect(counts.takeBufferedSignal).toBeLessThan(50);
    expect(await store.listSignalWaiters('child:p.')).toEqual([]);
  }, 240_000);

  it.each([undefined, 100])(
    'a running fan (concurrency %s) whose completions are lost advances on every parent turn',
    async (concurrency) => {
      const n = 300;
      const { store, counts, control } = lossyStore();
      control.loseChildCompletions = true;
      const engine = new WorkflowEngine({ store, reconcileMs: 0 });
      let settledChildren = 0;
      engine.subscribe((e) => {
        if ((e.type === 'run.completed' || e.type === 'run.failed') && e.workflow === 'child') {
          settledChildren += 1;
        }
      });
      engine.register('child', '1', async (_ctx, input) => {
        const i = input as number;
        if (mode === 'allSettled' && i % 7 === 3) throw new Error(`boom-${i}`);
        return i;
      });
      engine.register('parent', '1', async (ctx) =>
        fan(
          ctx,
          mode,
          Array.from({ length: n }, (_, i) => i),
          concurrency,
        ),
      );
      await engine.start('parent', {}, 'p');
      // Each parent turn reconciles what finished and sends the next waves; nothing else wakes it.
      for (let turn = 0; turn < 20 && !(await finished(store, 'p')); turn += 1) {
        const sent = settledChildren;
        await until(
          async () =>
            (await finished(store, 'p')) ||
            ((await status(store, 'p')) === 'suspended' &&
              (
                await store.listRuns({
                  workflow: 'child',
                  statuses: ['pending', 'running', 'suspended'],
                })
              ).length === 0),
          20_000,
          'the sent children to finish',
        );
        if (await finished(store, 'p')) break;
        expect(settledChildren).toBeGreaterThanOrEqual(sent);
        const done = new Set(
          (await store.listRuns({ workflow: 'child', statuses: ['completed', 'failed'] })).map(
            (r) => r.id,
          ),
        );
        counts.getRunIds = [];
        counts.getRuns = 0;
        await engine.runOne('p');
        await until(
          async () => (await finished(store, 'p')) || (await status(store, 'p')) === 'suspended',
          20_000,
          'the parent turn',
        );
        expect(counts.getRuns).toBeLessThanOrEqual(3);
        // Batched: the finished children are not read one by one.
        expect(counts.getRunIds.filter((id) => done.has(id)).length).toBeLessThan(5);
      }
      const parent = await store.getRun('p');
      expect(parent?.status).toBe('completed');
      if (mode === 'all') {
        expect(parent?.output).toEqual(Array.from({ length: n }, (_, i) => i));
      } else {
        const out = parent?.output as Settled<number>[];
        expect(out.filter((s) => s.status === 'rejected')).toHaveLength(
          Array.from({ length: n }, (_, i) => i).filter((i) => i % 7 === 3).length,
        );
        expect(out[3]).toMatchObject({ status: 'rejected', error: 'boom-3' });
        expect(out[4]).toEqual({ status: 'fulfilled', value: 4 });
      }
    },
    120_000,
  );

  it('a store without getRuns reconciles the same way, one getRun per child', async () => {
    const n = 30;
    const { store, counts, control } = lossyStore({ withoutGetRuns: true });
    control.loseChildCompletions = true;
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('child', '1', async (_ctx, input) => input);
    engine.register('parent', '1', async (ctx) =>
      fan(
        ctx,
        mode,
        Array.from({ length: n }, (_, i) => i),
      ),
    );
    await engine.start('parent', {}, 'p');
    await until(async () => (await store.listRuns({ statuses: ['completed'] })).length === n);
    control.loseChildCompletions = false;
    counts.getRun = 0;
    await engine.runOne('p');
    await until(() => finished(store, 'p'));
    const expected =
      mode === 'all'
        ? Array.from({ length: n }, (_, i) => i)
        : Array.from({ length: n }, (_, i) => ({ status: 'fulfilled', value: i }));
    expect((await store.getRun('p'))?.output).toEqual(expected);
    expect(counts.getRun).toBeGreaterThanOrEqual(n);
  });

  it('a completion that arrives after the parent reconciled it leaves no buffered signal behind', async () => {
    const n = 5;
    const { store, inner, control } = lossyStore();
    control.holdChildDeliveries = true;
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('child', '1', async (_ctx, input) => input);
    engine.register('parent', '1', async (ctx) =>
      fan(
        ctx,
        mode,
        Array.from({ length: n }, (_, i) => i),
      ),
    );
    await engine.start('parent', {}, 'p');
    // Every child finished; its notification is stuck on the way.
    await until(() => control.heldDeliveries === n, 20_000, 'the held notifications');
    await engine.runOne('p');
    await until(() => finished(store, 'p'));
    control.holdChildDeliveries = false;
    control.releaseHeld();
    await engine.drain(10_000);
    for (let i = 0; i < n; i += 1) {
      const id = allChildId('p', 0, i);
      expect(await inner.takeBufferedSignal(`child:${id}`)).toBeNull();
      expect((await inner.getRun(id))?.tags).toContain(CHILD_DELIVERED_TAG);
    }
    expect((await store.getRun('p'))?.status).toBe('completed');
  });

  it('a cancelled child notifies its parent at once', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('child', '1', async (ctx, input) => {
      await ctx.waitForSignal(`go:${input as number}`);
      return input;
    });
    engine.register('parent', '1', async (ctx) => {
      try {
        return await fan(ctx, mode, [0, 1, 2]);
      } catch (err) {
        if (err instanceof GatherError) return { failed: err.failures.map((f) => f.error) };
        throw err;
      }
    });
    await engine.start('parent', {}, 'p');
    await until(async () => (await store.listSignalWaiters('go:')).length === 3);
    await engine.cancel(allChildId('p', 0, 1));
    await engine.signal('go:0', undefined);
    await engine.signal('go:2', undefined);
    await until(() => finished(store, 'p'), 10_000, 'the parent');
    const output = (await store.getRun('p'))?.output;
    if (mode === 'all') {
      expect(output).toEqual({ failed: ['cancelled'] });
    } else {
      expect(output).toEqual([
        { status: 'fulfilled', value: 0 },
        expect.objectContaining({ status: 'rejected', error: 'cancelled' }),
        { status: 'fulfilled', value: 2 },
      ]);
    }
  });

  it('a child completion that hits store errors is retried until it reaches the parent', async () => {
    const { store, control } = lossyStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('child', '1', async (_ctx, input) => input);
    engine.register('parent', '1', async (ctx) => fan(ctx, mode, [7]));
    // Two failures: more than one immediate retry, fewer than the backoff retries.
    control.failChildDeliveries = 2;
    await engine.start('parent', {}, 'p');
    await until(() => finished(store, 'p'), 20_000, 'the parent');
    expect((await store.getRun('p'))?.output).toEqual(
      mode === 'all' ? [7] : [{ status: 'fulfilled', value: 7 }],
    );
    expect(control.failChildDeliveries).toBe(0);
  });

  it('drain waits for a child completion that is being retried', async () => {
    const { store, control } = lossyStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('child', '1', async () => 'done');
    engine.register('parent', '1', async (ctx) => fan(ctx, mode, [0]));
    control.failChildDeliveries = 2;
    await engine.start('parent', {}, 'p');
    await until(async () => (await status(store, allChildId('p', 0, 0))) === 'completed');
    await engine.drain(20_000);
    expect(control.failChildDeliveries).toBe(0);
    expect((await store.getCheckpoint('p', 0))?.status).toBe('completed');
  });

  it('a wake dropped on another instance lease is retried once the lease is free', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('child', '1', async (ctx, input) => {
      await ctx.waitForSignal(`go:${input as number}`);
      return input;
    });
    engine.register('parent', '1', async (ctx) => fan(ctx, mode, [0, 1]));
    await engine.start('parent', {}, 'p');
    await until(async () => (await store.listSignalWaiters('go:')).length === 2);
    await engine.signal('go:0', undefined);
    await until(async () => (await store.getCheckpoint('p', 0))?.status === 'completed');
    // Another instance leases the parent (mid-turn) and goes down without resuming it.
    const now = Date.now();
    expect(await store.tryLockRun('p', 'another-instance', now + 300, now)).toBe(true);
    await engine.signal('go:1', undefined);
    await until(async () => (await store.getCheckpoint('p', 1))?.status === 'completed');
    expect(await status(store, 'p')).toBe('suspended');
    await until(() => finished(store, 'p'), 10_000, 'the parent');
    expect((await store.getRun('p'))?.status).toBe('completed');
  });
});

describe('the in-process bound', () => {
  it.each([
    ['all', undefined],
    ['allSettled', undefined],
    ['all', 600],
    ['allSettled', 600],
  ] as const)(
    'ctx.%s (concurrency %s) runs at most 256 children in-process at once',
    async (mode, concurrency) => {
      const store = new InMemoryStateStore();
      const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
      let active = 0;
      let peak = 0;
      let entered = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      engine.register('child', '1', async () => {
        active += 1;
        entered += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
        return 1;
      });
      const n = 1_200;
      engine.register(
        'parent',
        '1',
        async (ctx) =>
          (
            await fan(
              ctx,
              mode,
              Array.from({ length: n }, () => ({})),
              concurrency,
            )
          ).length,
      );
      await engine.start('parent', {}, 'p');
      await until(() => entered >= 256, 20_000, 'the first children');
      // Every other child waits for a slot: give them a chance to (wrongly) enter.
      for (let k = 0; k < 20; k += 1) await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 50));
      expect(entered).toBe(256);
      expect(peak).toBe(256);
      release();
      await until(() => finished(store, 'p'), 60_000, 'the parent');
      expect((await store.getRun('p'))?.output).toBe(n);
      expect(peak).toBe(256);
    },
    120_000,
  );

  it('has no option to change it', () => {
    const deps: Record<string, unknown> = {} satisfies Partial<WorkflowEngineDeps>;
    // @ts-expect-error -- not an engine option
    const withOption: Partial<WorkflowEngineDeps> = { localRunConcurrency: 1 };
    expect('localRunConcurrency' in deps).toBe(false);
    expect(withOption).toBeDefined();
  });
});

/** A transport whose worker never answers: a dispatched step stays `pending`. */
class SilentTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  handler?: (result: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.handler = handler;
  }
  onHeartbeat(): void {}
}

const LINE = 'lines.process';
const processLine = (() => {}) as unknown as StepRef<number, number>;
(processLine as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = LINE;

describe('suspended runs whose step already finished', () => {
  it('a redelivered result for a settled step resumes the suspended run', async () => {
    const store = new InMemoryStateStore();
    const transport = new SilentTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    engine.register('w', '1', async (ctx) => ctx.step<string>('remote.op', {}));
    await engine.start('w', {}, 'w');
    await until(async () => (await status(store, 'w')) === 'suspended');
    const task = transport.dispatched[0] as RemoteTask;
    // The instance that settled the step went down before resuming the run.
    const cp = await store.getCheckpoint('w', task.seq);
    await store.saveCheckpoint({ ...cp!, status: 'completed', output: 'late' });
    await transport.handler?.({
      runId: 'w',
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output: 'late',
    });
    await until(async () => (await status(store, 'w')) === 'completed');
    expect((await store.getRun('w'))?.output).toBe('late');
  });

  it.each([
    ['all', undefined],
    ['allSettled', undefined],
    ['all', 4],
    ['allSettled', 4],
  ] as const)(
    'a redelivered result resumes a ctx.%s step fan (concurrency %s) whose results all settled',
    async (mode, concurrency) => {
      const store = new InMemoryStateStore();
      const transport = new SilentTransport();
      const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
      const inputs = [1, 2, 3, 4, 5, 6, 7, 8];
      engine.register('w', '1', async (ctx) =>
        mode === 'all'
          ? ctx.all(processLine, inputs, concurrency === undefined ? undefined : { concurrency })
          : ctx.allSettled(
              processLine,
              inputs,
              concurrency === undefined ? undefined : { concurrency },
            ),
      );
      await engine.start('w', {}, 'w');
      for (let round = 0; round < 10 && (await status(store, 'w')) !== 'completed'; round += 1) {
        await until(
          async () =>
            (await status(store, 'w')) === 'suspended' ||
            (await status(store, 'w')) === 'completed',
        );
        if ((await status(store, 'w')) === 'completed') break;
        const open = [];
        for (const task of transport.dispatched) {
          const cp = await store.getCheckpoint('w', task.seq);
          if (cp?.status === 'pending') open.push({ task, cp });
        }
        // Every result of the wave settled on an instance that went down before resuming the run.
        for (const { task, cp } of open) {
          await store.saveCheckpoint({
            ...cp,
            status: 'completed',
            output: (task.input as number) * 10,
          });
        }
        const last = open.at(-1)?.task as RemoteTask;
        await transport.handler?.({
          runId: 'w',
          seq: last.seq,
          stepId: last.stepId,
          status: 'completed',
          output: (last.input as number) * 10,
        });
        await until(async () => {
          const s = await status(store, 'w');
          if (s === 'completed') return true;
          const pending = await Promise.all(
            transport.dispatched.map(async (t) => (await store.getCheckpoint('w', t.seq))?.status),
          );
          return pending.includes('pending');
        });
      }
      const out = (await store.getRun('w'))?.output;
      expect(out).toEqual(
        mode === 'all'
          ? inputs.map((i) => i * 10)
          : inputs.map((i) => ({ status: 'fulfilled', value: i * 10 })),
      );
    },
  );

  it('with remoteRedispatchMs, a run waiting on a dispatched step parks no later than reconcileMs', async () => {
    const store = new InMemoryStateStore();
    const transport = new SilentTransport();
    const engine = new WorkflowEngine({
      store,
      transport,
      reconcileMs: 1_000,
      remoteRedispatchMs: 3_600_000,
    });
    engine.register('w', '1', async (ctx) => ctx.step<string>('remote.op', {}));
    await engine.start('w', {}, 'w');
    await until(async () => (await status(store, 'w')) === 'suspended');
    await engine.runOne('w');
    await until(async () => (await store.getCheckpoint('w', 0))?.wakeAt !== undefined);
    const run = await store.getRun('w');
    const deadline = (await store.getCheckpoint('w', 0))?.wakeAt as number;
    expect(run?.wakeAt).toBeDefined();
    // The step's redispatch deadline is an hour away; the run parks on reconcileMs instead.
    expect(deadline - (run?.wakeAt as number)).toBeGreaterThan(3_000_000);
  });

  it('a wake dropped on another instance lease is retried once the lease is free', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('w', '1', async (ctx) => ctx.waitForSignal<string>('go'));
    await engine.start('w', {}, 'w');
    await until(async () => (await status(store, 'w')) === 'suspended');
    const now = Date.now();
    expect(await store.tryLockRun('w', 'another-instance', now + 300, now)).toBe(true);
    await engine.signal('go', 'payload');
    expect(await status(store, 'w')).toBe('suspended');
    await until(async () => (await status(store, 'w')) === 'completed', 10_000, 'the run');
    expect((await store.getRun('w'))?.output).toBe('payload');
  });
});

describe('one more turn, not one per wake', () => {
  it.each([
    ['all', undefined],
    ['allSettled', undefined],
    ['all', 100],
    ['allSettled', 100],
  ] as const)(
    'children of ctx.%s (concurrency %s) finishing together share a parent turn',
    async (mode, concurrency) => {
      const store = new InMemoryStateStore();
      const engine = new WorkflowEngine({ store, reconcileMs: 0 });
      let parentTurns = 0;
      engine.register('child', '1', async (_ctx, input) => input);
      engine.register('parent', '1', async (ctx) => {
        parentTurns += 1;
        return fan(
          ctx,
          mode,
          Array.from({ length: 300 }, (_, i) => i),
          concurrency,
        );
      });
      await engine.start('parent', {}, 'p');
      await until(() => finished(store, 'p'), 30_000, 'the parent');
      // One turn to send the fan, one per settled wave (300 / 50 with concurrency 100), plus one spare.
      const waves = concurrency === undefined ? 1 : 300 / (concurrency / 2);
      expect(parentTurns).toBeLessThanOrEqual(waves + 2);
    },
  );

  it.each([
    ['all', undefined],
    ['allSettled', undefined],
    ['all', 50],
    ['allSettled', 50],
  ] as const)(
    'step results of ctx.%s (concurrency %s) settling together share a parent turn',
    async (mode, concurrency) => {
      const store = new InMemoryStateStore();
      const transport = new InMemoryTransport();
      transport.handle(LINE, async (input) => (input as number) * 2);
      const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
      let turns = 0;
      const inputs = Array.from({ length: 200 }, (_, i) => i);
      engine.register('w', '1', async (ctx) => {
        turns += 1;
        return mode === 'all'
          ? ctx.all(processLine, inputs, concurrency === undefined ? undefined : { concurrency })
          : ctx.allSettled(
              processLine,
              inputs,
              concurrency === undefined ? undefined : { concurrency },
            );
      });
      await engine.start('w', {}, 'w');
      await until(() => finished(store, 'w'), 30_000, 'the run');
      const waves = concurrency === undefined ? 1 : 200 / concurrency;
      expect(turns).toBeLessThanOrEqual(waves + 2);
    },
  );
});

describe('in-process transports keep running the fan on the instance', () => {
  it.each([
    ['InMemoryTransport', 'all', () => new InMemoryTransport()],
    ['InMemoryTransport', 'allSettled', () => new InMemoryTransport()],
    ['EventEmitterTransport', 'all', () => new EventEmitterTransport()],
    ['EventEmitterTransport', 'allSettled', () => new EventEmitterTransport()],
  ] as const)('%s, ctx.%s', async (_name, mode, make) => {
    const store = new InMemoryStateStore();
    const transport = make();
    expect('dispatchRuns' in transport).toBe(false);
    expect('onRun' in transport).toBe(false);
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    engine.register('child', '1', async (_ctx, input) => {
      if (input === 2) throw new Error('two');
      return input;
    });
    engine.register('parent', '1', async (ctx) => {
      try {
        return await fan(ctx, mode, [1, 2, 3]);
      } catch (err) {
        if (err instanceof GatherError) return err.failures.map((f) => f.error);
        throw err;
      }
    });
    await engine.start('parent', {}, 'p');
    await until(() => finished(store, 'p'));
    const out = (await store.getRun('p'))?.output;
    if (mode === 'all') expect(out).toEqual(['two']);
    else {
      expect(out).toEqual([
        { status: 'fulfilled', value: 1 },
        expect.objectContaining({ status: 'rejected', error: 'two' }),
        { status: 'fulfilled', value: 3 },
      ]);
    }
  });
});
