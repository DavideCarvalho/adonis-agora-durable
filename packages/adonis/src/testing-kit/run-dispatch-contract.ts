import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryStateStore,
  type RunDispatch,
  type StateStore,
  type Transport,
  type WorkflowCtx,
  WorkflowEngine,
} from '../index.js';
import { DURABLE_STEP_NAME } from '../step-name-symbol.js';

/** A transport carrying the run queue ({@link Transport.dispatchRuns} + {@link Transport.onDispatchedRun}). */
export type RunQueueTransport = Transport &
  Required<Pick<Transport, 'dispatchRuns' | 'onDispatchedRun'>> & { close?(): Promise<void> };

/**
 * Builds the transports of one test. Every transport {@link make} returns within a test must share
 * the same broker / tables / queues (two engines on two of them share one run queue), and nothing
 * with another test's.
 */
export interface RunDispatchTransportFactory {
  /** Called before each test: give the test infrastructure of its own (a fresh prefix, tables). */
  setup?(): Promise<void> | void;
  /** A fresh transport over this test's infrastructure. */
  make(): Promise<RunQueueTransport> | RunQueueTransport;
  /** Called after each test, once its engines drained and its transports closed. */
  teardown?(): Promise<void> | void;
  /** How long one case may wait for a run to settle. Default 20s. */
  settleTimeoutMs?: number;
}

/** Every run a transport was asked to enqueue, in order, recorded before it is handed on. */
interface Recorded {
  transport: RunQueueTransport;
  dispatched: RunDispatch[];
  calls: RunDispatch[][];
  /** The namespace each recorded call went to (`undefined`: the transport's own). */
  namespaces: Array<string | undefined>;
  /** Make the next `n` `dispatchRuns` calls reject without enqueueing anything. */
  failNext(n: number): void;
}

function record(transport: RunQueueTransport): Recorded {
  const original = transport.dispatchRuns.bind(transport);
  const out: Recorded = {
    transport,
    dispatched: [],
    calls: [],
    namespaces: [],
    failNext: (n) => {
      failures = n;
    },
  };
  let failures = 0;
  transport.dispatchRuns = async (runs, opts) => {
    if (failures > 0) {
      failures -= 1;
      throw new Error('run queue unavailable');
    }
    out.calls.push([...runs]);
    out.namespaces.push(opts?.namespace);
    out.dispatched.push(...runs);
    await original(runs, opts);
  };
  return out;
}

async function until(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The shapes of an awaited child the mid-turn wake case runs: a fan, a settled fan, one child. */
export type AwaitedChildShape = 'all' | 'allSettled' | 'child';

/**
 * A child finishes while its parent's turn, on another instance, still holds the parent's lease: the
 * parent's settle is held open until the child's completion was written and its wake was refused by
 * the lease, then released. The parent must then finish on its own, long before `reconcileMs`; the
 * engines' clock never moves, so nothing but the wake (or the turn's own re-check) can resume it.
 *
 * Instance `a` executes the parent's turn and, with a run queue, takes nothing from the queue;
 * instance `b` takes everything else, so the child's wake lands on the instance without the lease.
 */
export async function assertMidTurnChildWake(opts: {
  shape: AwaitedChildShape;
  /**
   * The instance holding the lease does not get to look at what its turn waits on after it lets go
   * (it went down right after its settle): only the refused wake, kept by the other instance, can
   * then resume the parent.
   */
  holderLosesItsRecheck?: boolean;
  makeTransport: () => Promise<Transport> | Transport;
  timeoutMs?: number;
  track?: { engines: WorkflowEngine[]; transports: Transport[] };
}): Promise<void> {
  const timeout = opts.timeoutMs ?? 20_000;
  const inner = new InMemoryStateStore();
  let parked = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const refusedLeases: string[] = [];
  // Completions written over by a `running` placeholder: each one erases a finished child.
  const erased: number[] = [];
  let holderBlind = false;
  const storeFor = (label: string) =>
    new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        // What the holder's post-turn re-checks read: refused once its turn let go of the lease.
        if (
          label === 'a' &&
          holderBlind &&
          (prop === 'hasSignalWaiter' ||
            prop === 'listCheckpointsByNamePrefix' ||
            prop === 'getCheckpoint')
        ) {
          return async () => {
            throw new Error('the holder went down');
          };
        }
        // The turn is held at its first write after it sent the children: the settle, or a `running`
        // placeholder written on its own (a placeholder written after the child's start).
        if (prop === 'updateRunIf') {
          return async (runId: string, statuses: never, patch: { status?: string }) => {
            if (runId === 'p' && patch.status === 'suspended' && !parked) {
              parked = true;
              await gate;
              if (opts.holderLosesItsRecheck) holderBlind = true;
            }
            return inner.updateRunIf(runId, statuses, patch as never);
          };
        }
        if (prop === 'saveCheckpoint') {
          return async (cp: { runId: string; name: string; status: string }) => {
            if (
              cp.runId === 'p' &&
              cp.name.startsWith('signal:child:') &&
              cp.status === 'running' &&
              !parked
            ) {
              parked = true;
              await gate;
              if (opts.holderLosesItsRecheck) holderBlind = true;
            }
            if (cp.runId === 'p' && cp.status === 'running') {
              const seq = (cp as unknown as { seq: number }).seq;
              if ((await inner.getCheckpoint('p', seq))?.status === 'completed') erased.push(seq);
            }
            return inner.saveCheckpoint(cp as never);
          };
        }
        // The waiter and placeholder of a child sent together: once the turn is past sending, any
        // placeholder written over a completion this way erases the child too.
        if (prop === 'registerChildWaits') {
          return async (entries: Array<{ checkpoint: { runId: string; seq: number } }>) => {
            for (const { checkpoint } of entries) {
              if (checkpoint.runId !== 'p') continue;
              const current = await inner.getCheckpoint('p', checkpoint.seq);
              if (current?.status === 'completed') erased.push(checkpoint.seq);
            }
            return inner.registerChildWaits(entries as never);
          };
        }
        if (prop === 'tryLockRun') {
          return async (runId: string, owner: string, until: number, now: number) => {
            const got = await inner.tryLockRun(runId, owner, until, now);
            if (runId === 'p' && !got) refusedLeases.push(owner);
            return got;
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as InMemoryStateStore;
  const store = storeFor('b');
  const now = Date.now();
  const clock = () => now;
  const n = opts.shape === 'child' ? 1 : 3;
  const engines: WorkflowEngine[] = [];
  for (const label of ['a', 'b']) {
    const transport = await opts.makeTransport();
    opts.track?.transports.push(transport);
    const engine = new WorkflowEngine({
      store: storeFor(label),
      transport,
      clock,
      reconcileMs: 300_000,
      instanceId: `mid-turn-${label}`,
    });
    opts.track?.engines.push(engine);
    engines.push(engine);
    engine.register('child', '1', async (ctx, input) => {
      await ctx.waitForSignal(`go:${input as number}`);
      return input;
    });
    engine.register('parent', '1', async (ctx) => {
      const inputs = Array.from({ length: n }, (_, i) => i);
      if (opts.shape === 'all') return ctx.all('child', inputs);
      if (opts.shape === 'allSettled') return ctx.allSettled('child', inputs);
      return ctx.child('child', 0);
    });
  }
  const [a, b] = engines as [WorkflowEngine, WorkflowEngine];
  // `a` takes nothing from the run queue: the child wakes land on `b`.
  await a.consumeRuns()?.();
  const at = new Date(now);
  await store.createRun({
    id: 'p',
    workflow: 'parent',
    workflowVersion: '1',
    status: 'pending',
    input: {},
    namespace: 'default',
    createdAt: at,
    updatedAt: at,
  });
  const turn = a.runOne('p');
  await until(() => parked, timeout, "the parent's turn to be held");
  // The children were sent: each waits for its signal. Instance `b` delivers them, so each child
  // finishes there (or on whichever instance takes it from the queue), never on `a`.
  await until(
    async () => (await store.listSignalWaiters('go:')).length === n,
    timeout,
    'the children to wait',
  );
  for (let i = 0; i < n; i += 1) await b.signal(`go:${i}`, undefined);
  // Every child finished and its completion reached the parent...
  await until(
    async () =>
      (await store.listRuns({ workflow: 'child', statuses: ['completed'] })).length === n &&
      (await store.listSignalWaiters('child:p')).length === 0,
    timeout,
    "the children's completions",
  );
  // ...and the parent's wake was refused by the lease the turn still holds.
  await until(() => refusedLeases.length > 0, timeout, 'the wake to find the lease held');
  // Long enough for any re-check of the refused wake to look while the turn still holds the lease.
  await sleep(2_500);
  release();
  await turn;
  await until(
    async () => (await store.getRun('p'))?.status === 'completed',
    timeout,
    'the parent to finish without its reconcile wake',
  );
  expect(erased).toEqual([]);
  const output = (await store.getRun('p'))?.output;
  if (opts.shape === 'child') expect(output).toBe(0);
  else if (opts.shape === 'all') expect(output).toEqual([0, 1, 2]);
  else expect(output).toEqual([0, 1, 2].map((value) => ({ status: 'fulfilled', value })));
}

/**
 * The contract of the run queue a transport offers the engine ({@link Transport.dispatchRuns} /
 * {@link Transport.onDispatchedRun}), run end to end through real engines sharing one in-memory store: every
 * run the engine would execute on itself goes through the queue, the instances consuming it split
 * the work without running anything twice, and nothing is lost when the queue fails or an instance
 * shuts down. Call it from a spec file with a factory for the transport under test.
 */
export function runRunDispatchContract(name: string, factory: RunDispatchTransportFactory): void {
  describe(`run dispatch contract: ${name}`, () => {
    const timeout = factory.settleTimeoutMs ?? 20_000;
    let store: StateStore;
    let engines: WorkflowEngine[] = [];
    let transports: RunQueueTransport[] = [];

    beforeEach(async () => {
      await factory.setup?.();
      store = new InMemoryStateStore();
      engines = [];
      transports = [];
    });

    afterEach(async () => {
      await Promise.all(engines.map((e) => e.drain(5_000).catch(() => undefined)));
      await Promise.all(transports.map((t) => t.close?.().catch(() => undefined)));
      await factory.teardown?.();
    });

    /** An engine on a fresh transport of this test, with its transport's dispatches recorded. */
    const instance = async (opts: { reconcileMs?: number; namespace?: string } = {}) => {
      const transport = await factory.make();
      transports.push(transport);
      const recorded = record(transport);
      const engine = new WorkflowEngine({
        store,
        transport,
        reconcileMs: opts.reconcileMs ?? 0,
        ...(opts.namespace !== undefined ? { namespace: opts.namespace } : {}),
      });
      engines.push(engine);
      return { engine, recorded };
    };

    const settled = async (runId: string) => {
      await until(
        async () => {
          const run = await store.getRun(runId);
          return (
            run !== null &&
            (run.status === 'completed' || run.status === 'failed' || run.status === 'dead')
          );
        },
        timeout,
        `run ${runId} to finish`,
      );
      return store.getRun(runId);
    };

    const startsOf = (r: Recorded) =>
      r.dispatched.filter((d) => d.reason === 'start').map((d) => d.runId);
    const wakesOf = (r: Recorded) =>
      r.dispatched.filter((d) => d.reason === 'wake').map((d) => d.runId);

    it(
      'delivers a start for a new pending state while the previous one is being handled',
      async () => {
        const transport = await factory.make();
        transports.push(transport);
        const seen: RunDispatch[] = [];
        let release!: () => void;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        transport.onDispatchedRun(
          async (run) => {
            seen.push(run);
            if (seen.length === 1) await gate;
          },
          { concurrency: 2 },
        );
        await transport.dispatchRuns([{ runId: 'again', reason: 'start', key: '1' }]);
        await until(() => seen.length === 1, timeout, 'the first delivery');
        // The run went `pending` again (a retry) while the first delivery is still being handled.
        await transport.dispatchRuns([{ runId: 'again', reason: 'start', key: '2' }]);
        await until(() => seen.length === 2, timeout, 'the start of the new pending state');
        release();
        // A marker dispatched last: once it is handled, nothing else is coming.
        await transport.dispatchRuns([{ runId: 'marker', reason: 'wake' }]);
        await until(() => seen.some((r) => r.runId === 'marker'), timeout, 'the marker');
        expect(seen.filter((r) => r.runId === 'again').map((r) => [r.reason, r.key])).toEqual([
          ['start', '1'],
          ['start', '2'],
        ]);
      },
      timeout * 2,
    );

    it(
      'keeps the run queues of different namespaces apart',
      async () => {
        const transport = await factory.make();
        transports.push(transport);
        const byNamespace: Record<string, string[]> = { blue: [], green: [] };
        for (const ns of ['blue', 'green'] as const) {
          transport.onDispatchedRun(
            async (run) => {
              byNamespace[ns]?.push(run.runId);
            },
            { concurrency: 4, namespace: ns },
          );
        }
        await transport.dispatchRuns([{ runId: 'b1' }, { runId: 'b2' }], { namespace: 'blue' });
        await transport.dispatchRuns([{ runId: 'g1' }], { namespace: 'green' });
        await until(
          () => (byNamespace.blue?.length ?? 0) + (byNamespace.green?.length ?? 0) === 3,
          timeout,
          'every run',
        );
        expect(byNamespace.blue?.sort()).toEqual(['b1', 'b2']);
        expect(byNamespace.green).toEqual(['g1']);
      },
      timeout * 2,
    );

    it(
      "keeps a pool's runs on the instances of its namespace",
      async () => {
        const blue1 = await instance({ namespace: 'blue' });
        const blue2 = await instance({ namespace: 'blue' });
        const green = await instance({ namespace: 'green' });
        const by: Record<string, string> = {};
        for (const [label, { engine }] of [
          ['blue1', blue1],
          ['blue2', blue2],
          ['green', green],
        ] as const) {
          engine.register('w', '1', async (ctx) => {
            by[ctx.runId] = label;
            return label;
          });
        }
        await blue1.engine.start('w', {}, 'b');
        await green.engine.start('w', {}, 'g');
        expect(['blue1', 'blue2']).toContain((await settled('b'))?.output);
        expect((await settled('g'))?.output).toBe('green');
        expect(blue1.recorded.namespaces).toEqual(['blue']);
        expect(green.recorded.namespaces).toEqual(['green']);
      },
      timeout * 2,
    );

    it(
      "carries the run's priority",
      async () => {
        const { engine, recorded } = await instance();
        engine.register('w', '1', async () => 'ok');
        await engine.start('w', {}, 'urgent', { priority: 7 });
        await settled('urgent');
        expect(recorded.dispatched.find((d) => d.runId === 'urgent')?.priority).toBe(7);
      },
      timeout * 2,
    );

    /** The fan forms every child-fan case runs: both combinators, with and without waves. */
    const FANS = [
      { mode: 'all', concurrency: undefined },
      { mode: 'allSettled', concurrency: undefined },
      { mode: 'all', concurrency: 40 },
      { mode: 'allSettled', concurrency: 40 },
    ] as const;
    const fanOf = (
      ctx: WorkflowCtx,
      mode: 'all' | 'allSettled',
      inputs: unknown[],
      concurrency: number | undefined,
    ) => {
      const opts = concurrency === undefined ? undefined : { concurrency };
      return mode === 'all'
        ? ctx.all('child', inputs, opts)
        : ctx.allSettled('child', inputs, opts);
    };
    /** What child `i` returns, and whether it fails (an allSettled fan has failures to report). */
    const childResult = (mode: 'all' | 'allSettled', i: number) => {
      if (mode === 'allSettled' && i % 5 === 2) throw new Error(`boom-${i}`);
      return i * 2;
    };
    const expectedFan = (mode: 'all' | 'allSettled', n: number) =>
      Array.from({ length: n }, (_, i) => {
        if (mode === 'all') return i * 2;
        return i % 5 === 2
          ? expect.objectContaining({ status: 'rejected', error: `boom-${i}` })
          : { status: 'fulfilled', value: i * 2 };
      });

    for (const { mode, concurrency } of FANS) {
      it(
        `sends the start and every child start of a ctx.${mode} fan (concurrency ${concurrency}) through the run queue, in batches`,
        async () => {
          const { engine, recorded } = await instance();
          const n = 120;
          engine.register('child', '1', async (_ctx, input) => childResult(mode, input as number));
          engine.register('parent', '1', async (ctx) =>
            fanOf(
              ctx,
              mode,
              Array.from({ length: n }, (_, i) => i),
              concurrency,
            ),
          );
          await engine.start('parent', {}, 'fan');
          const run = await settled('fan');
          expect(run?.status).toBe('completed');
          expect(run?.output).toEqual(expectedFan(mode, n));
          const starts = startsOf(recorded);
          expect(starts).toContain('fan');
          const childStarts = starts.filter((id) => id !== 'fan');
          expect(new Set(childStarts).size).toBe(n);
          // Batched: the children's starts went out in a handful of calls, not one per child.
          const callsWithChildren = recorded.calls.filter((c) =>
            c.some((d) => d.reason === 'start' && d.runId !== 'fan'),
          );
          expect(callsWithChildren.length).toBeLessThanOrEqual(n / 10);
        },
        timeout * 2,
      );

      it(
        `two instances split a ctx.${mode} fan (concurrency ${concurrency}) and run each child once`,
        async () => {
          const a = await instance();
          const b = await instance();
          const runs = new Map<string, string[]>();
          // Every child holds its slot until both instances have run one: an instance takes at most
          // 64 runs from the queue at once, so with more children sent than that the other instance
          // must take some, whatever the timing.
          let release!: () => void;
          const bothRan = new Promise<void>((r) => {
            release = r;
          });
          const n = 160;
          for (const [label, { engine }] of [
            ['a', a],
            ['b', b],
          ] as const) {
            engine.register('child', '1', async (ctx, input) => {
              runs.set(ctx.runId, [...(runs.get(ctx.runId) ?? []), label]);
              const by = new Set([...runs.values()].map((r) => r[0]));
              if (by.has('a') && by.has('b')) release();
              await bothRan;
              return childResult(mode, input as number);
            });
            engine.register('parent', '1', async (ctx) =>
              fanOf(
                ctx,
                mode,
                Array.from({ length: n }, (_, i) => i),
                concurrency === undefined ? undefined : 140,
              ),
            );
          }
          await a.engine.start('parent', {}, 'split');
          const run = await settled('split');
          expect(run?.status).toBe('completed');
          expect(run?.output).toEqual(expectedFan(mode, n));
          expect(runs.size).toBe(n);
          for (const [, by] of runs) expect(by).toHaveLength(1);
          const byA = [...runs.values()].filter((by) => by[0] === 'a').length;
          expect(byA).toBeGreaterThan(0);
          expect(byA).toBeLessThan(n);
        },
        timeout * 3,
      );
    }

    for (const { mode, concurrency } of FANS) {
      it(
        `two instances run a ctx.${mode} step fan (concurrency ${concurrency}) with each step once`,
        async () => {
          const a = await instance();
          const b = await instance();
          const name = `contract.line.${mode}.${concurrency ?? 'all'}`;
          const step = Object.assign(() => undefined, { [DURABLE_STEP_NAME]: name });
          const ran = new Map<number, number>();
          for (const t of transports) {
            const serve = (
              t as { handle?: (n: string, fn: (i: unknown) => Promise<unknown>) => void }
            ).handle;
            if (typeof serve !== 'function') return;
            serve.call(t, name, async (input) => {
              const i = input as number;
              ran.set(i, (ran.get(i) ?? 0) + 1);
              return childResult(mode, i);
            });
          }
          const n = 80;
          const inputs = Array.from({ length: n }, (_, i) => i);
          for (const { engine } of [a, b]) {
            engine.register('stepfan', '1', async (ctx) => {
              const opts = concurrency === undefined ? undefined : { concurrency };
              const ref = step as never;
              return mode === 'all'
                ? ctx.all(ref, inputs, opts)
                : ctx.allSettled(ref, inputs, opts);
            });
          }
          await a.engine.start('stepfan', {}, 'stepfan');
          const run = await settled('stepfan');
          expect(run?.status).toBe('completed');
          expect(run?.output).toEqual(expectedFan(mode, n));
          expect(ran.size).toBe(n);
          for (const [, times] of ran) expect(times).toBe(1);
        },
        timeout * 3,
      );
    }

    it(
      'a failed enqueue leaves the run pending, and the pending-run poll runs it',
      async () => {
        const { engine, recorded } = await instance();
        let executions = 0;
        engine.register('w', '1', async () => {
          executions += 1;
          return 'ok';
        });
        recorded.failNext(1);
        await engine.start('w', {}, 'unsent');
        await sleep(100);
        expect((await store.getRun('unsent'))?.status).toBe('pending');
        expect(executions).toBe(0);
        await engine.runPending();
        const run = await settled('unsent');
        expect(run?.output).toBe('ok');
        expect(executions).toBe(1);
      },
      timeout * 2,
    );

    it(
      'a wake that cannot be enqueued resumes the run on this instance instead',
      async () => {
        const { engine, recorded } = await instance();
        engine.register('waiter', '1', async (ctx: WorkflowCtx) =>
          ctx.waitForSignal<string>('go:unsent-wake'),
        );
        await engine.start('waiter', {}, 'unsent-wake');
        await until(
          async () => (await store.getRun('unsent-wake'))?.status === 'suspended',
          timeout,
          'the run to suspend',
        );
        recorded.failNext(1);
        await engine.signal('go:unsent-wake', 'here');
        expect((await settled('unsent-wake'))?.output).toBe('here');
        expect(wakesOf(recorded)).not.toContain('unsent-wake');
      },
      timeout * 2,
    );

    it(
      'the consumer skips a dispatched run that is no longer pending or already finished',
      async () => {
        const { engine, recorded } = await instance();
        let executions = 0;
        engine.register('w', '1', async () => {
          executions += 1;
          return 'ok';
        });
        await engine.start('w', {}, 'done');
        await settled('done');
        expect(executions).toBe(1);
        await recorded.transport.dispatchRuns([
          { runId: 'done', reason: 'start' },
          { runId: 'done', reason: 'wake' },
          { runId: 'never-created', reason: 'start' },
        ]);
        // A pending run dispatched the same way is taken: the consumer is alive.
        const now = new Date();
        await store.createRun({
          id: 'after',
          workflow: 'w',
          workflowVersion: '1',
          status: 'pending',
          input: {},
          namespace: 'default',
          createdAt: now,
          updatedAt: now,
        });
        await recorded.transport.dispatchRuns([{ runId: 'after', reason: 'start' }]);
        await settled('after');
        await sleep(200);
        expect(executions).toBe(2);
        expect((await store.getRun('done'))?.status).toBe('completed');
      },
      timeout * 2,
    );

    it(
      'an instance that drains takes no more runs; another instance runs them',
      async () => {
        const a = await instance();
        const b = await instance();
        const by: string[] = [];
        a.engine.register('w', '1', async () => {
          by.push('a');
          return 'a';
        });
        b.engine.register('w', '1', async () => {
          by.push('b');
          return 'b';
        });
        await a.engine.drain(5_000);
        // A draining instance still dispatches: the run is enqueued, not dropped.
        await a.engine.start('w', {}, 'handed-over');
        const run = await settled('handed-over');
        expect(run?.output).toBe('b');
        expect(by).toEqual(['b']);
        expect(startsOf(a.recorded)).toContain('handed-over');
      },
      timeout * 2,
    );

    it(
      'drain waits for a run the consumer is executing',
      async () => {
        const { engine } = await instance();
        let entered = false;
        engine.register('slow', '1', async () => {
          entered = true;
          await sleep(300);
          return 'done';
        });
        await engine.start('slow', {}, 'slow');
        await until(() => entered, timeout, 'the run to start');
        await engine.drain(5_000);
        expect((await store.getRun('slow'))?.status).toBe('completed');
      },
      timeout * 2,
    );

    it(
      'a signal wakes its run through the run queue',
      async () => {
        const a = await instance();
        const b = await instance();
        for (const { engine } of [a, b]) {
          engine.register('waiter', '1', async (ctx: WorkflowCtx) =>
            ctx.waitForSignal<string>('go:sig'),
          );
        }
        await a.engine.start('waiter', {}, 'sig');
        await until(
          async () => (await store.getRun('sig'))?.status === 'suspended',
          timeout,
          'the run to suspend',
        );
        await a.engine.signal('go:sig', 'hello');
        const run = await settled('sig');
        expect(run?.output).toBe('hello');
        expect(wakesOf(a.recorded)).toContain('sig');
      },
      timeout * 2,
    );

    it(
      'a finished child wakes its parent through the run queue',
      async () => {
        const { engine, recorded } = await instance();
        engine.register('child', '1', async () => 7);
        engine.register('parent', '1', async (ctx) => (await ctx.child<number>('child', {})) + 1);
        await engine.start('parent', {}, 'parent-of-one');
        const run = await settled('parent-of-one');
        expect(run?.output).toBe(8);
        expect(wakesOf(recorded)).toContain('parent-of-one');
      },
      timeout * 2,
    );

    it(
      'a due timer is handed off through the run queue',
      async () => {
        const { engine, recorded } = await instance();
        engine.register('napper', '1', async (ctx) => {
          await ctx.sleep(50);
          return 'rested';
        });
        await engine.start('napper', {}, 'nap');
        await until(
          async () => (await store.getRun('nap'))?.status === 'suspended',
          timeout,
          'the run to sleep',
        );
        await sleep(80);
        await engine.resumeDueTimers();
        const run = await settled('nap');
        expect(run?.output).toBe('rested');
        expect(wakesOf(recorded)).toContain('nap');
      },
      timeout * 2,
    );

    it(
      'continue-as-new hands the next run to the run queue',
      async () => {
        const { engine, recorded } = await instance();
        engine.register('looper', '1', async (ctx, input) => {
          const n = (input as { n: number }).n;
          if (n < 2) return ctx.continueAsNew({ n: n + 1 });
          return n;
        });
        await engine.start('looper', { n: 0 }, 'loop');
        await until(
          () => startsOf(recorded).filter((id) => id !== 'loop').length >= 2,
          timeout,
          'the continuations to be enqueued',
        );
        const last = startsOf(recorded).at(-1) as string;
        expect((await settled(last))?.output).toBe(2);
      },
      timeout * 2,
    );

    it(
      'a retried run goes back through the run queue',
      async () => {
        const { engine, recorded } = await instance();
        let attempts = 0;
        engine.register('flaky', '1', async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('first attempt fails');
          return 'second';
        });
        await engine.start('flaky', {}, 'flaky');
        expect((await settled('flaky'))?.status).toBe('failed');
        const before = startsOf(recorded).filter((id) => id === 'flaky').length;
        await engine.requeue('flaky');
        expect((await settled('flaky'))?.output).toBe('second');
        expect(startsOf(recorded).filter((id) => id === 'flaky').length).toBe(before + 1);
      },
      timeout * 2,
    );

    it(
      'a run orphaned by a dead instance is recovered through the run queue',
      async () => {
        const { engine, recorded } = await instance();
        engine.register('orphan', '1', async () => 'recovered');
        const now = new Date();
        await store.createRun({
          id: 'orphan',
          workflow: 'orphan',
          workflowVersion: '1',
          status: 'running',
          input: {},
          namespace: 'default',
          lockedBy: 'a-dead-instance',
          lockedUntil: 1,
          createdAt: now,
          updatedAt: now,
        });
        await engine.recoverIncomplete();
        expect((await settled('orphan'))?.output).toBe('recovered');
        expect(startsOf(recorded)).toContain('orphan');
      },
      timeout * 2,
    );

    it(
      'a freed singleton slot wakes the next run through the run queue',
      async () => {
        const { engine, recorded } = await instance();
        engine.register(
          'single',
          '1',
          async (ctx, input) => {
            const { id } = input as { id: string };
            if (id === 'first') await ctx.waitForSignal('release');
            return id;
          },
          { singleton: { key: () => 'k' } },
        );
        await engine.start('single', { id: 'first' }, 'first');
        await until(
          async () => (await store.getRun('first'))?.status === 'suspended',
          timeout,
          'the first run to hold the slot',
        );
        await engine.start('single', { id: 'second' }, 'second');
        await until(
          async () => (await store.getRun('second'))?.status === 'suspended',
          timeout,
          'the second run to queue behind the slot',
        );
        await engine.signal('release', undefined);
        expect((await settled('first'))?.output).toBe('first');
        expect((await settled('second'))?.output).toBe('second');
        expect(wakesOf(recorded)).toContain('second');
      },
      timeout * 2,
    );

    for (const [shape, holderLosesItsRecheck] of [
      ['all', false],
      ['allSettled', false],
      ['child', false],
      ['all', true],
      ['allSettled', true],
      ['child', true],
    ] as const) {
      it(
        `a child finishing while its parent's turn still holds the lease wakes the parent (${shape}${holderLosesItsRecheck ? ', the holder skips its re-check' : ''})`,
        async () => {
          await assertMidTurnChildWake({
            shape,
            holderLosesItsRecheck,
            makeTransport: () => factory.make(),
            timeoutMs: timeout,
            track: { engines, transports: transports as Transport[] },
          });
        },
        timeout * 3,
      );
    }
  });
}
