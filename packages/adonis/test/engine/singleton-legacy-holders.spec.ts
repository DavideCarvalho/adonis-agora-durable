import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { StateStore, WorkflowRun } from '../../src/interfaces.js';
import { SINGLETON_ADMITTED_TAG, singletonAdmissionTags } from '../../src/singleton-admission.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { dbBackends } from '../support/backends.js';

/**
 * Rolling upgrade from the pre-atomic scheme (0.50 and older): those replicas admit a singleton run by
 * a scan — it may run while it ranks among the `limit` oldest `running`/`suspended` runs of its key —
 * and write NO admission tag. A 0.51 claim must count such an untagged holder, or a mixed fleet runs
 * two runs of one key at once.
 */

const KEY = 'singleton:k';
const noDispatch = { dispatch: () => {} };

/** A run exactly as a pre-0.51 replica leaves it: the key tag only, never the admission marker. */
const legacy = (id: string, createdMs: number, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  workflow: 'job',
  workflowVersion: '1',
  status: 'running',
  input: id,
  tags: [KEY],
  createdAt: new Date(createdMs),
  updatedAt: new Date(createdMs),
  ...over,
});

describe('singletonAdmissionTags counts pre-atomic (untagged) holders', () => {
  const admitted = (runs: WorkflowRun[], id: string, limit = 1) =>
    singletonAdmissionTags(runs, id, KEY, 'job', limit) !== null;

  it('denies a new start while an old replica runs an untagged holder', () => {
    const runs = [legacy('old-holder', 1000), legacy('new', 2000)];
    expect(admitted(runs, 'new')).toBe(false);
  });

  it('counts an untagged holder that sleeps or waits on a signal (suspended) too', () => {
    const runs = [legacy('old-holder', 1000, { status: 'suspended' }), legacy('new', 2000)];
    expect(admitted(runs, 'new')).toBe(false);
  });

  it('keeps the old FIFO: the oldest waiter, not the newest start, gets the freed slot', () => {
    // An old replica's denied waiter (suspended on its retry timer, untagged) queued behind its holder.
    const runs = [
      legacy('old-waiter', 2000, { status: 'suspended', wakeAt: 9000 }),
      legacy('new', 3000),
    ];
    expect(admitted(runs, 'new')).toBe(false);
    expect(admitted(runs, 'old-waiter')).toBe(true);
  });

  it('respects limit > 1 across untagged and tagged holders', () => {
    const runs = [
      legacy('old-holder', 1000),
      legacy('new-holder', 1500, { tags: [KEY, SINGLETON_ADMITTED_TAG] }),
      legacy('c', 2000),
    ];
    expect(admitted(runs, 'c', 2)).toBe(false);
    expect(admitted(runs, 'c', 3)).toBe(true);
  });

  it('counts an untagged holder even when a tagged one ranks after it (e.g. createdAt skew)', () => {
    // Positional FIFO alone hands `c` the second slot (only one tagged holder), putting three runs
    // in two slots: the untagged `old-holder` is one an old replica admitted, and it is counted.
    const runs = [
      legacy('c', 1000),
      legacy('old-holder', 2000),
      legacy('new-holder', 3000, { tags: [KEY, SINGLETON_ADMITTED_TAG] }),
    ];
    expect(admitted(runs, 'c', 2)).toBe(false);
  });

  it('never lets an older still-pending run lose its slot to an untagged holder count', () => {
    // limit 2: `old-holder` runs (old replica), `c` tries, `p` is older but not yet executing. The
    // second slot is `p`'s (FIFO); admitting `c` too would put three runs in two slots once `p` runs.
    const runs = [
      legacy('p', 500, { status: 'pending' }),
      legacy('c', 1000),
      legacy('old-holder', 2000, { status: 'suspended' }),
    ];
    expect(admitted(runs, 'c', 2)).toBe(false);
    expect(
      admitted([{ ...runs[0], status: 'running' } as WorkflowRun, ...runs.slice(1)], 'p', 2),
    ).toBe(true);
  });

  it('a new-only fleet keeps admitting a waiter next to a holder parked blocked', () => {
    // A tagged holder parked `blocked` still takes its seat in the old scan's window, so the two
    // waiters behind it are not mistaken for untagged holders of the second slot.
    const runs = [
      legacy('holder', 1000, { status: 'blocked', tags: [KEY, SINGLETON_ADMITTED_TAG] }),
      legacy('w1', 2000, { status: 'suspended' }),
      legacy('w2', 3000, { status: 'suspended' }),
    ];
    expect(admitted(runs, 'w1', 2)).toBe(true);
    expect(admitted(runs, 'w2', 2)).toBe(false);
  });
});

interface Backend {
  name: string;
  make(): Promise<{ store: StateStore; close: () => Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: 'in-memory',
    make: async () => ({ store: new InMemoryStateStore(), close: async () => {} }),
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

describe.each(backends)('mixed 0.50/0.51 fleet on $name', (backend) => {
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

  function newReplica(entered: string[]): WorkflowEngine {
    const engine = new WorkflowEngine({ store, runDispatcher: noDispatch, instanceId: 'v051' });
    engine.register(
      'job',
      '1',
      async (ctx, input) => {
        await ctx.localStep('enter', async () => void entered.push(input as string));
        await ctx.waitForSignal(`release:${input as string}`);
      },
      { singleton: { key: () => 'k' } },
    );
    engines.push(engine);
    return engine;
  }

  /** What the old replica does when its holder finishes: settle it, no tag to strip. */
  const oldReplicaCompletes = (id: string) =>
    store.updateRun(id, { status: 'completed', output: null, updatedAt: new Date() });

  it('a new start is denied while an old replica runs an untagged holder; the slot is handed over after it ends', async () => {
    await store.createRun(legacy('old-holder', Date.now() - 1000));
    const entered: string[] = [];
    const engine = newReplica(entered);
    await engine.start('job', 'new', 'new');
    await engine.runOne('new');
    expect(entered).toEqual([]);
    const denied = await store.getRun('new');
    expect(denied?.status).toBe('suspended');
    expect(denied?.tags).not.toContain(SINGLETON_ADMITTED_TAG);

    await oldReplicaCompletes('old-holder');
    await engine.runOne('new');
    expect(entered).toEqual(['new']);
    expect((await store.getRun('new'))?.tags).toContain(SINGLETON_ADMITTED_TAG);
  });

  it('keeps the old FIFO across versions: an old denied waiter goes before a newer start', async () => {
    const t0 = Date.now() - 1000;
    await store.createRun(legacy('old-holder', t0));
    // Parked by an old replica's scan denial: suspended on a retry timer, untagged.
    await store.createRun(legacy('old-waiter', t0 + 10, { status: 'suspended', wakeAt: t0 }));
    const entered: string[] = [];
    const engine = newReplica(entered);
    await engine.start('job', 'new', 'new');
    await engine.runOne('new');
    expect(entered).toEqual([]);

    await oldReplicaCompletes('old-holder');
    // The newer start retries first, and still loses to the older waiter.
    await engine.runOne('new');
    expect(entered).toEqual([]);
    await engine.runOne('old-waiter');
    expect(entered).toEqual(['old-waiter']);
    await engine.runOne('new');
    expect(entered).toEqual(['old-waiter']);

    await engine.signal('release:old-waiter', null);
    await engine.waitForRun('old-waiter');
    await engine.runOne('new');
    expect(entered).toEqual(['old-waiter', 'new']);
  });

  it('concurrent older claims never take a slot an untagged holder occupies (limit 2)', async () => {
    if (!store.tryAdmitSingleton) throw new Error('store must implement tryAdmitSingleton');
    // One slot held by an old replica (untagged), one by a 0.51 replica (tagged) that ranks after it,
    // and six claimants ranked before both: a tagged-only count would see a free slot.
    await store.createRun(legacy('old-holder', 2000));
    await store.createRun(legacy('new-holder', 3000, { tags: [KEY, SINGLETON_ADMITTED_TAG] }));
    const ids = Array.from({ length: 6 }, (_, i) => `c${i}`);
    for (const id of ids) await store.createRun(legacy(id, 1000));
    const claim = () =>
      Promise.all(ids.map((id) => store.tryAdmitSingleton?.(id, KEY, 'job', 2, 5000)));
    expect((await claim()).filter(Boolean)).toHaveLength(0);
    await oldReplicaCompletes('old-holder');
    // `c0`/`c1` now fill the old scan's window: an old replica would run either of them, so with the
    // tagged holder still in its slot, admitting one here could put three runs in two slots.
    expect((await claim()).filter(Boolean)).toHaveLength(0);
    await store.updateRun('new-holder', {
      status: 'completed',
      output: null,
      updatedAt: new Date(),
    });
    const verdicts = await claim();
    expect(verdicts.filter(Boolean)).toHaveLength(2);
    // FIFO: the two oldest by (createdAt, id).
    const rows = await Promise.all(ids.map((id) => store.getRun(id)));
    expect(rows.filter((r) => r?.tags?.includes(SINGLETON_ADMITTED_TAG)).map((r) => r?.id)).toEqual(
      ['c0', 'c1'],
    );
  });

  it('concurrent claims never admit past an untagged holder, then admit exactly one', async () => {
    if (!store.tryAdmitSingleton) throw new Error('store must implement tryAdmitSingleton');
    await store.createRun(legacy('old-holder', 1000));
    const ids = Array.from({ length: 6 }, (_, i) => `c${i}`);
    // Same createdAt for all claimants: only the store's serialization orders them.
    for (const id of ids) await store.createRun(legacy(id, 2000));
    const claim = () =>
      Promise.all(ids.map((id) => store.tryAdmitSingleton?.(id, KEY, 'job', 1, 5000)));

    expect((await claim()).filter(Boolean)).toHaveLength(0);
    await oldReplicaCompletes('old-holder');
    // The denied claimants were parked `suspended`; they race again for the freed slot.
    expect((await claim()).filter(Boolean)).toHaveLength(1);
    const rows = await Promise.all(ids.map((id) => store.getRun(id)));
    expect(rows.filter((r) => r?.tags?.includes(SINGLETON_ADMITTED_TAG))).toHaveLength(1);
  });
});
