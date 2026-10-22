import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteTask, StepResult } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { DbTransport } from '../../../src/transports/db.js';
import { makeTransportDb } from '../../../src/transports/db-helpers.js';

// `engine.workerHealth()` (the dashboard /workers + /health, Telescope's worker panel) reads the
// transport's `groupHealth`, which the db transport did not implement: its groups never showed, so
// a backlog with no worker was invisible. A db worker also beat no liveness key of its own.

const POLL = 5;
const NAME = 'ext.work';
const TOKEN = sanitizeQueueToken(NAME);

const task = (seq: number, over: Partial<RemoteTask> = {}): RemoteTask => ({
  runId: 'r1',
  seq,
  stepId: `r1:${seq}`,
  name: NAME,
  group: TOKEN,
  input: { seq },
  attempt: 1,
  ...over,
});

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('DbTransport.groupHealth', () => {
  const cleanups: Array<() => Promise<void>> = [];
  let db: Database;

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    if (db) await db.manager.closeAll();
  });

  function make(opts: Partial<ConstructorParameters<typeof DbTransport>[0]> = {}) {
    const t = new DbTransport({ db, pollIntervalMs: POLL, workerKeysCacheMs: 0, ...opts });
    cleanups.push(() => t.close());
    return t;
  }

  it('reports the backlog with zero live workers — the alert state', async () => {
    db = await makeTransportDb();
    const engine = make();
    for (let i = 1; i <= 3; i += 1) await engine.dispatch(task(i));
    expect(await engine.groupHealth(TOKEN)).toEqual({ group: TOKEN, depth: 3, liveWorkers: [] });
  });

  it('counts claimed rows in depth and lists a live worker with its status', async () => {
    db = await makeTransportDb();
    const engine = make();
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    for (let i = 1; i <= 3; i += 1) await engine.dispatch(task(i));

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let running = 0;
    const worker = make({ instanceId: 'w1', concurrency: 2, workerHeartbeatIntervalMs: 10 });
    worker.handle(NAME, async (input) => {
      running += 1;
      await gate;
      return input;
    });

    // Two rows running (claimed), one pending: depth counts all three.
    await until(async () => {
      const h = await engine.groupHealth(TOKEN);
      return running === 2 && h.liveWorkers[0]?.status?.inFlight === 2;
    });
    const h = await engine.groupHealth(TOKEN);
    expect(h.depth).toBe(3);
    expect(h.liveWorkers).toHaveLength(1);
    expect(h.liveWorkers[0]).toMatchObject({
      group: TOKEN,
      instanceId: 'w1',
      status: { runtime: 'node', concurrency: { mode: 'fixed', limit: 2 }, inFlight: 2 },
    });
    expect(h.liveWorkers[0]?.lastBeatAt).toBeGreaterThan(Date.now() - 5_000);

    release();
    await until(() => results.length === 3);
    expect((await engine.groupHealth(TOKEN)).depth).toBe(0);
    expect((await engine.groupHealth('other')).liveWorkers).toEqual([]);
    // The liveness key is what listWorkerGroups discovers too.
    expect(await engine.listWorkerGroups()).toContain(TOKEN);
  });

  it('a producer-only (deferred) process does not advertise itself as a live worker', async () => {
    db = await makeTransportDb();
    const engine = make();
    const producer = make({ instanceId: 'p1', workerHeartbeatIntervalMs: 10 });
    producer.deferConsumers();
    producer.handle(NAME, async () => 'x');
    await new Promise((r) => setTimeout(r, 40));
    expect((await engine.groupHealth(TOKEN)).liveWorkers).toEqual([]);
    producer.startConsumers();
    await until(async () => (await engine.groupHealth(TOKEN)).liveWorkers.length === 1);
    expect((await engine.groupHealth(TOKEN)).liveWorkers[0]?.instanceId).toBe('p1');
  });

  it('is namespace-scoped: depth and workers of another namespace are not counted', async () => {
    db = await makeTransportDb();
    const other = make({ namespace: 'other' });
    await other.dispatch(task(1));
    const worker = make({ namespace: 'other', instanceId: 'wo' });
    worker.deferConsumers(); // keep the row pending
    worker.handle(NAME, async () => 'x');
    worker.startConsumers();
    const engine = make();
    await until(async () => (await other.groupHealth(TOKEN)).liveWorkers.length === 1);
    expect(await engine.groupHealth(TOKEN)).toEqual({ group: TOKEN, depth: 0, liveWorkers: [] });
  });
});
