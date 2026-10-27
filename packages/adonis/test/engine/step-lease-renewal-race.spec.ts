import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  Heartbeat,
  RemoteTask,
  StateStore,
  StepCheckpoint,
  StepResult,
  Transport,
} from '../../src/interfaces.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { dbBackends } from '../support/backends.js';

/**
 * REGRESSION: a heartbeat renewing a durably-suspended step's lease must not write over a checkpoint
 * that moved on between the renewal's read and its write.
 *
 * `renewStepLease` reads the step's checkpoint, and — the lease being half spent — writes it back with
 * a pushed-out `wakeAt`. Apps run several web pods and queue workers on one database, so the step's
 * result (or a lost-dispatch redispatch on another pod) can land in between. A blind write of the row
 * read a moment earlier then puts a `completed` step back to `pending` with no result (the run parks
 * until the lease lapses, and the step runs a second time), or rolls a redispatch's `attempts` and
 * deadline back. Each test lands the other writer exactly between the renewal's read and its write.
 */

const PING = 'ext.ping';
const LEASE = 60_000;

class HeldTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  heartbeat?: (beat: Heartbeat) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(_handler: (r: StepResult) => Promise<void>): void {}
  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    this.heartbeat = handler;
  }
}

/** Arms `store` so its next read of `(runId, seq)` returns the row as read, but only after `land` ran. */
function landAfterNextRead(store: StateStore, land: () => Promise<void>): void {
  const read = store.getCheckpoint.bind(store);
  let armed = true;
  store.getCheckpoint = async (runId, seq) => {
    const row = await read(runId, seq);
    if (armed) {
      armed = false;
      await land();
    }
    return row;
  };
}

type Backend = {
  name: string;
  make: () => Promise<{ store: StateStore; close: () => Promise<void> }>;
};

const backends: Backend[] = [
  {
    name: 'in-memory',
    make: async () => ({ store: new InMemoryStateStore(), close: async () => {} }),
  },
  ...dbBackends({ mysql: true }).map(
    (b): Backend => ({
      name: `lucid ${b.name}`,
      make: async () => {
        const db = await b.makeStoreDb();
        return { store: new LucidStateStore(db), close: () => db.manager.closeAll() };
      },
    }),
  ),
];

describe.each(backends)(
  'REGRESSION: a step lease renewal racing the checkpoint on $name',
  (backend) => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
      await close?.();
      close = undefined;
    });

    async function setup() {
      let now = 1_000_000;
      const made = await backend.make();
      close = made.close;
      const store = made.store;
      const transport = new HeldTransport();
      const engine = new WorkflowEngine({
        store,
        transports: [{ id: 't', transport }],
        clock: () => now,
        reconcileMs: 0,
        remoteRedispatchMs: LEASE,
      });
      engine.register('wf', '1', async (ctx) => ctx.step<{ pong: boolean }>(PING, {}));
      await startRun(engine, 'wf', {}, 'r1');
      const task = transport.dispatched[0];
      if (!task) throw new Error('expected a dispatched task');
      const pending = (await store.getCheckpoint('r1', task.seq)) as StepCheckpoint;
      expect(pending.status).toBe('pending');
      // Past the half-spent mark of any lease the dispatch stamped: the next beat renews.
      now += LEASE;
      const beat = () =>
        transport.heartbeat?.({ runId: 'r1', seq: task.seq, stepId: task.stepId, group: PING });
      return { store, task, pending, beat, now: () => now };
    }

    it('keeps a result that settled the step between the renewal read and its write', async () => {
      const { store, task, pending, beat } = await setup();
      landAfterNextRead(store, async () => {
        await store.saveCheckpoint({ ...pending, status: 'completed', output: { pong: true } });
      });

      await beat();

      const cp = await store.getCheckpoint('r1', task.seq);
      expect(cp?.status).toBe('completed');
      expect(cp?.output).toEqual({ pong: true });
    });

    it('keeps a redispatch that re-armed the step between the renewal read and its write', async () => {
      const { store, task, pending, beat, now } = await setup();
      const redispatchedWakeAt = now() + LEASE + 5;
      landAfterNextRead(store, async () => {
        await store.saveCheckpoint({ ...pending, attempts: 2, wakeAt: redispatchedWakeAt });
      });

      await beat();

      const cp = await store.getCheckpoint('r1', task.seq);
      expect(cp?.status).toBe('pending');
      expect(cp?.attempts).toBe(2);
      expect(cp?.wakeAt).toBe(redispatchedWakeAt);
    });

    it('still renews the lease when nothing raced it', async () => {
      const { store, task, pending, beat, now } = await setup();

      await beat();

      const cp = await store.getCheckpoint('r1', task.seq);
      expect(cp?.status).toBe('pending');
      expect(cp?.attempts).toBe(pending.attempts);
      expect(cp?.wakeAt).toBe(now() + LEASE);
    });
  },
);

describe('REGRESSION: a step lease renewal racing a result on a store without renewCheckpointLease', () => {
  it('falls back to the pending-only compare-and-set and keeps the settled result', async () => {
    let now = 1_000_000;
    const store = new InMemoryStateStore();
    // A store that predates `renewCheckpointLease` (the method is optional).
    (store as { renewCheckpointLease?: unknown }).renewCheckpointLease = undefined;
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({
      store,
      transports: [{ id: 't', transport }],
      clock: () => now,
      reconcileMs: 0,
      remoteRedispatchMs: LEASE,
    });
    engine.register('wf', '1', async (ctx) => ctx.step<{ pong: boolean }>(PING, {}));
    await startRun(engine, 'wf', {}, 'r1');
    const task = transport.dispatched[0];
    if (!task) throw new Error('expected a dispatched task');
    const pending = (await store.getCheckpoint('r1', task.seq)) as StepCheckpoint;
    now += LEASE;
    landAfterNextRead(store, async () => {
      await store.saveCheckpoint({ ...pending, status: 'completed', output: { pong: true } });
    });

    await transport.heartbeat?.({ runId: 'r1', seq: task.seq, stepId: task.stepId, group: PING });

    const cp = await store.getCheckpoint('r1', task.seq);
    expect(cp?.status).toBe('completed');
    expect(cp?.output).toEqual({ pong: true });
  });
});
