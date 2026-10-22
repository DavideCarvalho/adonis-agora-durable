import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteTask, StepResult, WorkerStatus } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';
import { MemoryWorkerKeys } from '../../../src/transports/worker-keys.js';

// `concurrency: 'adaptive'` was BullMQ-only: on the queue transport it fell back to a fixed 1. These
// cover the queue's slot loop following the shared adaptive controller's live limit, both ways.

const POLL = 2;
const TOKEN = sanitizeQueueToken('ext.work');

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const task = (seq: number): RemoteTask => ({
  runId: 'r1',
  seq,
  name: 'ext.work',
  stepId: `r1:${seq}`,
  group: TOKEN,
  input: { seq },
  attempt: 1,
});

describe('QueueTransport adaptive concurrency', () => {
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

  /** A worker on `concurrency` running slow steps; tracks how many run at once. */
  function workerWith(adapter: MockAdapter, extra: Parameters<typeof make>[1], stepMs: number) {
    const worker = make(adapter, extra);
    const stats = { running: 0, peak: 0 };
    worker.handle('ext.work', async (input) => {
      stats.running += 1;
      stats.peak = Math.max(stats.peak, stats.running);
      await sleep(stepMs);
      stats.running -= 1;
      return input;
    });
    return { worker, stats };
  }

  async function statusOf(engine: QueueTransport): Promise<WorkerStatus | undefined> {
    return (await engine.groupHealth?.(TOKEN))?.liveWorkers[0]?.status;
  }

  it('grows the slot count while steps saturate the limit at a steady latency', async () => {
    const adapter = new MockAdapter();
    const keys = new MemoryWorkerKeys();
    const engine = make(adapter, { workerKeys: keys });
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    // The backlog is queued before the worker starts, so every tick sees the limit saturated. The
    // tick is slow next to the step: the controller calls a step outliving two ticks a stall
    // (backpressure), and a 25ms sleep often outlives a 15ms × 2 window on a loaded machine.
    const jobs = 40;
    for (let i = 1; i <= jobs; i += 1) await engine.dispatch(task(i));
    const { stats } = workerWith(
      adapter,
      {
        workerKeys: keys,
        workerHeartbeatIntervalMs: 10,
        concurrency: { mode: 'adaptive', min: 1, max: 4, start: 1, tickMs: 60 },
      },
      25,
    );
    await until(() => results.length === jobs, 60_000);

    // It grew, and the slot loop followed: only a `grow` raises the limit above its start of 1.
    expect(stats.peak).toBeGreaterThan(1);
    expect(stats.peak).toBeLessThanOrEqual(4);
    // The heartbeat carries the adaptive limit and its last move — which move depends on the step
    // latency measured as it grew (a step back is as legitimate on a loaded machine), so only its
    // presence is pinned; the decision rules are unit-tested on the controller with a fake clock.
    await until(async () => (await statusOf(engine))?.lastAdjust !== undefined);
    const status = await statusOf(engine);
    expect(status?.concurrency).toMatchObject({ mode: 'adaptive', min: 1, max: 4 });
    expect(status?.lastAdjust?.reason).toBeDefined();
  });

  it('shrinks the live limit under the RAM brake, and the slot loop obeys it', async () => {
    const adapter = new MockAdapter();
    const keys = new MemoryWorkerKeys();
    const engine = make(adapter, { workerKeys: keys });
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    // Any RSS is over a 0.0001% ceiling: every tick cuts the limit by 20%, 4 → 3 → 2 → 1.
    const { stats } = workerWith(
      adapter,
      {
        workerKeys: keys,
        workerHeartbeatIntervalMs: 5,
        concurrency: {
          mode: 'adaptive',
          min: 1,
          max: 4,
          start: 4,
          tickMs: 10,
          ramCeilingPct: 1e-4,
        },
      },
      20,
    );
    await until(async () => (await statusOf(engine))?.concurrency.limit === 1);
    expect((await statusOf(engine))?.lastAdjust).toMatchObject({ to: 1, reason: 'ram_ceiling' });

    for (let i = 1; i <= 6; i += 1) await engine.dispatch(task(i));
    await until(() => results.length === 6);
    expect(stats.peak).toBe(1);
  });

  it('a fixed limit still reports its telemetry, without a control loop', async () => {
    const adapter = new MockAdapter();
    const keys = new MemoryWorkerKeys();
    const engine = make(adapter, { workerKeys: keys });
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    const { stats } = workerWith(
      adapter,
      { workerKeys: keys, workerHeartbeatIntervalMs: 5, concurrency: 3 },
      15,
    );
    for (let i = 1; i <= 6; i += 1) await engine.dispatch(task(i));
    await until(() => results.length === 6);
    expect(stats.peak).toBe(3);
    await until(async () => (await statusOf(engine))?.p95Ms !== undefined);
    const status = await statusOf(engine);
    expect(status?.concurrency).toEqual({ mode: 'fixed', limit: 3 });
    expect(status?.lastAdjust).toBeUndefined();
  });
});
