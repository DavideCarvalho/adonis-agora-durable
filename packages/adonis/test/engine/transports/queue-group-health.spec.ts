import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../../src/engine.js';
import type { GroupHealth, RemoteTask, StepResult } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { InMemoryStateStore } from '../../../src/testing/in-memory-state-store.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';
import { MemoryWorkerKeys } from '../../../src/transports/worker-keys.js';

// `engine.workerHealth()` (the dashboard /workers + /health, Telescope's worker panel) read the
// transport's `groupHealth`, which only BullMQ implemented: on the queue transport the panels were
// empty, so a group with a backlog and no consumer never showed. And a queue worker beat no liveness
// key of its own (only a tenant WorkerRuntime did), so there was nothing to report anyway.

const POLL = 5;
const TOKEN = sanitizeQueueToken('ext.work');

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const task = (seq: number): RemoteTask => ({
  runId: 'r1',
  seq,
  name: 'ext.work',
  stepId: `r1:${seq}`,
  group: TOKEN,
  input: { seq },
  attempt: 1,
});

describe('QueueTransport.groupHealth', () => {
  const transports: QueueTransport[] = [];
  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.close()));
  });

  const make = (
    adapter: MockAdapter,
    extra: Partial<ConstructorParameters<typeof QueueTransport>[0]> = {},
  ) => {
    const t = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: POLL,
      stalledCheckIntervalMs: 0,
      workerKeysCacheMs: 0,
      ...extra,
    });
    transports.push(t);
    return t;
  };

  const health = (t: QueueTransport, group = TOKEN): Promise<GroupHealth> => {
    if (!t.groupHealth) throw new Error('groupHealth is not available');
    return t.groupHealth(group);
  };

  it('is absent without a worker-key store (no liveness to report, so no false alarm)', () => {
    const t = make(new MockAdapter());
    expect(t.groupHealth).toBeUndefined();
  });

  it('reports the pending backlog with zero live workers — the alert state', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter, { workerKeys: new MemoryWorkerKeys() });
    for (let i = 1; i <= 3; i += 1) await engine.dispatch(task(i));
    expect(await health(engine)).toEqual({ group: TOKEN, depth: 3, liveWorkers: [] });
  });

  it("lists a live worker with its heartbeat status, and depth follows the queue as it's drained", async () => {
    const adapter = new MockAdapter();
    const keys = new MemoryWorkerKeys();
    const engine = make(adapter, { workerKeys: keys });
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    for (let i = 1; i <= 3; i += 1) await engine.dispatch(task(i));

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const worker = make(adapter, {
      workerKeys: keys,
      instanceId: 'w1',
      concurrency: 2,
      workerHeartbeatIntervalMs: 10,
    });
    worker.handle('ext.work', async (input) => {
      await gate;
      return input;
    });

    // Two slots claimed, one job still pending; the worker's beat carries its live status.
    await until(async () => {
      const h = await health(engine);
      return h.depth === 1 && h.liveWorkers[0]?.status?.inFlight === 2;
    });
    const h = await health(engine);
    expect(h.liveWorkers).toHaveLength(1);
    expect(h.liveWorkers[0]).toMatchObject({
      group: TOKEN,
      instanceId: 'w1',
      status: { runtime: 'node', concurrency: { mode: 'fixed', limit: 2 }, inFlight: 2 },
    });
    expect(h.liveWorkers[0]?.lastBeatAt).toBeGreaterThan(Date.now() - 5_000);
    expect(h.liveWorkers[0]?.status?.rssBytes).toBeGreaterThan(0);

    release();
    await until(() => results.length === 3);
    await until(async () => (await health(engine)).depth === 0);
    // Another group is not this worker's.
    expect((await health(engine, 'other')).liveWorkers).toEqual([]);
  });

  it('a producer-only (deferred) process does not advertise itself as a live worker', async () => {
    const adapter = new MockAdapter();
    const keys = new MemoryWorkerKeys();
    const engine = make(adapter, { workerKeys: keys });
    const producer = make(adapter, { workerKeys: keys, instanceId: 'cli' });
    producer.deferConsumers();
    producer.handle('ext.work', async () => 'ok');
    await new Promise((r) => setTimeout(r, 20));
    expect((await health(engine)).liveWorkers).toEqual([]);

    producer.startConsumers();
    await until(async () => (await health(engine)).liveWorkers.length === 1);
    expect((await health(engine)).liveWorkers[0]?.instanceId).toBe('cli');
  });

  it('feeds engine.workerHealth(), groups discovered from the heartbeats', async () => {
    const adapter = new MockAdapter();
    const keys = new MemoryWorkerKeys();
    const engineTransport = make(adapter, { workerKeys: keys });
    const worker = make(adapter, { workerKeys: keys, instanceId: 'w1' });
    worker.handle('ext.work', async () => 'ok');
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: engineTransport,
    });

    await until(async () => (await engine.workerHealth()).length > 0);
    const [group] = await engine.workerHealth();
    expect(group).toMatchObject({ group: TOKEN, depth: 0 });
    expect(group?.liveWorkers.map((w) => w.instanceId)).toEqual(['w1']);
  });
});
