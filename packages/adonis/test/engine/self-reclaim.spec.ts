import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodecStateStore } from '../../src/codec-state-store.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { StateStore, WorkflowRun } from '../../src/interfaces.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { dbBackends } from '../support/backends.js';

/**
 * Immediate self-reclaim: an instance restarted under the SAME stable `instanceId` (a pod name) after a
 * SIGKILL/OOM kill reclaims the `running` runs its previous incarnation still holds leases on at once,
 * instead of waiting up to `leaseMs` for them to expire — while a live instance never reclaims a run it
 * is executing, and every other instance still waits for the expiry.
 */

const LEASE_MS = 60_000;
const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => Promise<boolean> | boolean, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await check()) return;
    await settle(2);
  }
  throw new Error('condition never held');
}

const running = (id: string): WorkflowRun => ({
  id,
  workflow: 'job',
  workflowVersion: '1',
  status: 'running',
  input: {},
  createdAt: new Date(),
  updatedAt: new Date(),
});

/** The leftovers of a process SIGKILLed mid-turn: a `running` run whose live lease names `owner`. */
async function crashedLeftover(store: StateStore, id: string, owner: string): Promise<void> {
  await store.createRun(running(id));
  const now = Date.now();
  expect(await store.tryLockRun(id, owner, now + LEASE_MS, now)).toBe(true);
  // The next incarnation boots strictly later than the dead one's last lease write.
  await settle();
}

interface Backend {
  name: string;
  make(): Promise<{ store: StateStore; close: () => Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: 'in-memory',
    make: async () => ({ store: new InMemoryStateStore(), close: async () => {} }),
  },
  {
    name: 'codec over in-memory',
    make: async () => ({
      store: new CodecStateStore(new InMemoryStateStore(), {
        encode: async (v) => v,
        decode: async (v) => v,
      }),
      close: async () => {},
    }),
  },
  ...dbBackends().map(
    (b): Backend => ({
      name: `lucid on ${b.name}`,
      make: async () => {
        const db: Database = await b.makeStoreDb();
        return { store: new LucidStateStore(db), close: () => db.manager.closeAll() };
      },
    }),
  ),
];

describe.each(backends)('self-reclaim on $name', (backend) => {
  let store: StateStore;
  let close: () => Promise<void>;
  const engines: WorkflowEngine[] = [];

  beforeEach(async () => {
    ({ store, close } = await backend.make());
  });

  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.drain();
    await close();
  });

  function engineFor(
    instanceId: string,
    body: () => Promise<unknown> = async () => 'ok',
    clock: () => number = Date.now,
  ) {
    const engine = new WorkflowEngine({ store, instanceId, leaseMs: LEASE_MS, clock });
    engine.register('job', '1', async (ctx) => ctx.localStep('s', body));
    engines.push(engine);
    return engine;
  }

  it('the store lists runs still leased to the given owner, and only then', async () => {
    if (!store.listOrphanedRuns) return;
    await crashedLeftover(store, 'mine', 'pod-0');
    await crashedLeftover(store, 'theirs', 'pod-1');
    await store.createRun(running('free'));
    const now = Date.now();
    expect(
      (await store.listOrphanedRuns(now, 10, undefined, 'pod-0')).map((r) => r.id).sort(),
    ).toEqual(['free', 'mine']);
    expect((await store.listOrphanedRuns(now, 10)).map((r) => r.id)).toEqual(['free']);
  });

  it('a rebooted instance under the same id reclaims its own crashed run at once', async () => {
    await crashedLeftover(store, 'r1', 'pod-0');
    let bodyRuns = 0;
    const rebooted = engineFor('pod-0', async () => {
      bodyRuns += 1;
      return 'ok';
    });
    const recovered = await rebooted.recoverIncomplete();
    expect(recovered.map((r) => r.runId)).toEqual(['r1']);
    await rebooted.waitForRun('r1');
    expect((await store.getRun('r1'))?.status).toBe('completed');
    expect((await store.getRun('r1'))?.recoveryAttempts).toBe(1);
    expect(bodyRuns).toBe(1);
  });

  it('another instance still waits for the lease to expire', async () => {
    await crashedLeftover(store, 'r1', 'pod-0');
    let skewMs = 0;
    const other = engineFor('pod-1', undefined, () => Date.now() + skewMs);
    expect(await other.recoverIncomplete()).toEqual([]);
    const row = await store.getRun('r1');
    expect(row?.status).toBe('running');
    expect(row?.lockedBy).toBe('pod-0');
    // Once the lease has expired, it is a plain orphan for anyone.
    skewMs = LEASE_MS + 1;
    expect(await other.recoverIncomplete()).toHaveLength(1);
  });

  it('a live instance never reclaims a run it is executing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bodyRuns = 0;
    const live = engineFor('pod-0', async () => {
      bodyRuns += 1;
      await gate;
      return 'ok';
    });
    await live.start('job', {}, 'r1');
    await until(() => bodyRuns === 1);
    const row = await store.getRun('r1');
    expect(row?.status).toBe('running');
    expect(row?.lockedBy).toBe('pod-0');
    for (let i = 0; i < 3; i += 1) expect(await live.recoverIncomplete()).toEqual([]);
    expect((await store.getRun('r1'))?.recoveryAttempts ?? 0).toBe(0);
    release();
    await live.waitForRun('r1');
    expect(bodyRuns).toBe(1);
    expect((await store.getRun('r1'))?.status).toBe('completed');
  });

  it('never reclaims a stale self-lease while this process is executing the run on it', async () => {
    // A resume adopts the stale lease (it reads as held by this instance) and executes the run here:
    // the in-process run gate must keep the recovery sweep from releasing it under that execution.
    await crashedLeftover(store, 'r1', 'pod-0');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bodyRuns = 0;
    const rebooted = engineFor('pod-0', async () => {
      bodyRuns += 1;
      await gate;
      return 'ok';
    });
    const resumed = rebooted.resume('r1');
    await until(() => bodyRuns === 1);
    expect(await rebooted.recoverIncomplete()).toEqual([]);
    expect((await store.getRun('r1'))?.lockedBy).toBe('pod-0');
    release();
    await resumed;
    expect((await store.getRun('r1'))?.status).toBe('completed');
    expect(bodyRuns).toBe(1);
  });
});
