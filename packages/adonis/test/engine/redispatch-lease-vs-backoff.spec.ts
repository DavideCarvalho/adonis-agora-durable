import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { RemoteTask, StateStore, StepResult, Transport } from '../../src/interfaces.js';
import {
  DURABLE_STEP_CONFIG,
  DURABLE_STEP_NAME,
  type StepRef,
} from '../../src/step-name-symbol.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { dbBackends } from '../support/backends.js';

/**
 * Issue #599: with `remoteRedispatchMs` set, the lost-dispatch lease a `pending` remote step carries
 * in `wakeAt` survived the settle of a failed result, and the failed-retry branch (which stamps the
 * backoff only when `wakeAt` is absent) took the lease as the retry deadline. A transient failure
 * then delayed the run by the whole lease instead of the step's `backoffMs`.
 */

const STEP = 'ext.flaky';

/** Poll until `check` holds or `timeoutMs` passes (a real database settles asynchronously). */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The run is parked: suspended, and its turn has let go of it. */
const parked = async (store: StateStore, runId: string) => {
  const run = await store.getRun(runId);
  return run?.status === 'suspended' && run.lockedBy == null;
};

const stepAt = async (store: StateStore, runId: string, seq: number) =>
  store.getCheckpoint(runId, seq);

/** Holds every dispatch; the test delivers each result after the run has suspended,
 *  as a queue worker does (BullMQ). */
class HeldTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  private handler?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.handler = handler;
  }
  onHeartbeat(): void {}
  async deliver(task: RemoteTask, result: Pick<StepResult, 'status' | 'output' | 'error'>) {
    await this.handler?.({ runId: task.runId, seq: task.seq, stepId: task.stepId, ...result });
  }
}

/** A `@Step` reference, as the decorator stamps it. */
function stepRef<TInput, TOutput>(name: string, config: object): StepRef<TInput, TOutput> {
  const ref = (() => {}) as unknown as StepRef<TInput, TOutput>;
  (ref as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = name;
  (ref as { [DURABLE_STEP_CONFIG]?: object })[DURABLE_STEP_CONFIG] = config;
  return ref;
}

/** A store for one scenario, and how to release it once the engine has drained. */
type StoreFactory = () => Promise<{ store: StateStore; close: () => Promise<void> }>;

/** Run `scenario` on a fresh store, draining the engine before the store is released. */
async function onStore<T>(
  makeStore: StoreFactory,
  scenario: (store: StateStore, track: (e: WorkflowEngine) => WorkflowEngine) => Promise<T>,
): Promise<T> {
  const { store, close } = await makeStore();
  const engines: WorkflowEngine[] = [];
  try {
    return await scenario(store, (e) => {
      engines.push(e);
      return e;
    });
  } finally {
    await Promise.all(engines.map((e) => e.drain()));
    await close();
  }
}

const failOnceThenSucceed = (makeStore: StoreFactory, remoteRedispatchMs?: number) =>
  onStore(makeStore, async (store, track) => {
    const transport = new HeldTransport();
    let nowMs = 1000;
    const engine = track(
      new WorkflowEngine({
        store,
        transports: [{ id: 't', transport }],
        clock: () => nowMs,
        reconcileMs: 50,
        remoteRedispatchMs,
      }),
    );
    engine.register('wf', '1', async (ctx) => ctx.step(STEP, {}, { retries: 2, backoffMs: 100 }));

    await startRun(engine, 'wf', {}, 'run1');
    await waitFor(async () => transport.dispatched.length === 1 && (await parked(store, 'run1')));
    // The reconcile re-drive replays the run while the step is still pending; with
    // remoteRedispatchMs set, that replay stamps the lease (1050 + 60_000) on it.
    nowMs = 1050;
    await engine.resumeDueTimers(nowMs);
    await waitFor(
      async () =>
        (await parked(store, 'run1')) &&
        (remoteRedispatchMs == null || (await stepAt(store, 'run1', 0))?.wakeAt != null),
    );
    const pendingWakeAt = (await store.listCheckpoints('run1')).find(
      (c) => c.name === STEP,
    )?.wakeAt;
    const first = transport.dispatched[0];
    if (!first) throw new Error('expected a dispatch');
    await transport.deliver(first, { status: 'failed', error: { message: 'transient' } });
    // The resume the failure owes stamps the retry deadline on the failed step.
    await waitFor(async () => {
      const cp = await stepAt(store, 'run1', first.seq);
      return cp?.status === 'failed' && cp.wakeAt != null && (await parked(store, 'run1'));
    });
    const failed = await stepAt(store, 'run1', first.seq);

    // The backoff (1050 + 100) is due; the redispatch lease (1050 + 60_000) is not.
    nowMs = 1300;
    await engine.resumeDueTimers(nowMs);
    await waitFor(async () => transport.dispatched.length === 2 && (await parked(store, 'run1')));
    const retry = transport.dispatched[1];
    if (retry) await transport.deliver(retry, { status: 'completed', output: 'ok' });
    await waitFor(async () => (await store.getRun('run1'))?.status === 'completed');

    return {
      pendingWakeAt,
      failedWakeAt: failed?.wakeAt,
      dispatches: transport.dispatched.length,
      status: (await store.getRun('run1'))?.status,
    };
  });

/** The same over a `ctx.all` fan, whose steps carry the lease from the moment they are sent. */
const fanFailOnceThenSucceed = (makeStore: StoreFactory, remoteRedispatchMs?: number) =>
  onStore(makeStore, async (store, track) => {
    const transport = new HeldTransport();
    let nowMs = 1000;
    const engine = track(
      new WorkflowEngine({
        store,
        transports: [{ id: 't', transport }],
        clock: () => nowMs,
        reconcileMs: 50,
        remoteRedispatchMs,
      }),
    );
    const flaky = stepRef<{ i: number }, string>(STEP, { retries: 2, backoffMs: 100 });
    engine.register('wf', '1', async (ctx) => ctx.all(flaky, [{ i: 0 }, { i: 1 }]));

    await startRun(engine, 'wf', {}, 'run1');
    await waitFor(async () => transport.dispatched.length === 2 && (await parked(store, 'run1')));
    const [a, b] = transport.dispatched;
    if (!a || !b) throw new Error('expected two dispatches');
    await transport.deliver(b, { status: 'completed', output: 'b' });
    await waitFor(async () => (await stepAt(store, 'run1', b.seq))?.status === 'completed');
    nowMs = 1050;
    await transport.deliver(a, { status: 'failed', error: { message: 'transient' } });
    await waitFor(async () => {
      const cp = await stepAt(store, 'run1', a.seq);
      return cp?.status === 'failed' && cp.wakeAt != null && (await parked(store, 'run1'));
    });
    const failed = await stepAt(store, 'run1', a.seq);

    // The backoff (1050 + 100) is due; the lease stamped at send (1000 + 60_000) is not.
    nowMs = 1300;
    await engine.resumeDueTimers(nowMs);
    await waitFor(async () => transport.dispatched.length === 3 && (await parked(store, 'run1')));
    const retry = transport.dispatched[2];
    if (retry) await transport.deliver(retry, { status: 'completed', output: 'a' });
    await waitFor(async () => (await store.getRun('run1'))?.status === 'completed');
    return {
      failedWakeAt: failed?.wakeAt,
      dispatches: transport.dispatched.length,
      status: (await store.getRun('run1'))?.status,
    };
  });

const inMemory =
  (roundTripMethods: boolean): StoreFactory =>
  async () => ({ store: new InMemoryStateStore({ roundTripMethods }), close: async () => {} });

const stores: Array<{ name: string; makeStore: StoreFactory }> = [
  { name: 'InMemoryStateStore', makeStore: inMemory(false) },
  { name: 'InMemoryStateStore (roundTripMethods)', makeStore: inMemory(true) },
  // The real store on every backend: Postgres settles a result with one UPDATE … RETURNING, MySQL and
  // SQLite through the conditional settle; each must clear the lease the pending row carried.
  ...dbBackends({ mysql: true }).map(({ name, makeStoreDb }) => ({
    name: `LucidStateStore on ${name}`,
    makeStore: async () => {
      const db = await makeStoreDb();
      return { store: new LucidStateStore(db), close: () => db.manager.closeAll() };
    },
  })),
];

describe('remoteRedispatchMs and the retry backoff of a failed remote step', () => {
  for (const { name, makeStore } of stores) {
    describe(name, () => {
      it('retries after the backoff without remoteRedispatchMs', async () => {
        const result = await failOnceThenSucceed(makeStore, undefined);
        expect(result).toMatchObject({ dispatches: 2, status: 'completed' });
      });

      it('retries after the backoff with remoteRedispatchMs set', async () => {
        const result = await failOnceThenSucceed(makeStore, 60_000);
        // The lease was stamped while pending, so the scenario is the one under test.
        expect(result.pendingWakeAt).toBe(61_050);
        // Expected: the failed checkpoint waits for the backoff (1050 + 100), not the lease.
        expect(result).toMatchObject({ failedWakeAt: 1150, dispatches: 2, status: 'completed' });
      });

      it('retries a failed ctx.all step after the backoff with remoteRedispatchMs set', async () => {
        const result = await fanFailOnceThenSucceed(makeStore, 60_000);
        expect(result).toMatchObject({ failedWakeAt: 1150, dispatches: 3, status: 'completed' });
      });

      it('retries a failed ctx.all step after the backoff without remoteRedispatchMs', async () => {
        const result = await fanFailOnceThenSucceed(makeStore, undefined);
        expect(result).toMatchObject({ failedWakeAt: 1150, dispatches: 3, status: 'completed' });
      });
    });
  }
});
