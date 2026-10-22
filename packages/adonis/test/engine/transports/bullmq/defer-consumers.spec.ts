import { describe, expect, it } from 'vitest';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import type {
  BullMQDeps,
  JobLike,
  ProcessFn,
  QueueLike,
  RedisLike,
  WorkerLike,
} from '../../../../src/transports/bullmq/deps.js';

/**
 * A BullMQ `Worker` starts fetching the moment it is constructed, and its queues hand each job to one
 * consumer — so a `node ace` command that booted the transport competed with the worker fleet for
 * step jobs and results. `deferConsumers()` (what `consumers: 'auto'` does in console/repl, and
 * `consumers: 'never'` everywhere) must park every point-to-point worker until `startConsumers()`.
 */

class FakeWorker implements WorkerLike {
  readonly failedListeners: Array<(job: JobLike | undefined, err: Error) => void> = [];
  closed = false;
  constructor(
    readonly name: string,
    readonly process: ProcessFn,
    public concurrency?: number,
  ) {}
  on(_event: 'failed', listener: (job: JobLike | undefined, err: Error) => void): unknown {
    this.failedListeners.push(listener);
    return this;
  }
  async close(): Promise<unknown> {
    this.closed = true;
    return undefined;
  }
}

const noopRedis = (): RedisLike => ({
  publish: async () => 1,
  subscribe: async () => 1,
  on() {
    return this;
  },
  set: async () => 'OK',
  scan: async () => ['0', []],
  get: async () => null,
  disconnect() {},
});

class FakeBroker implements BullMQDeps {
  readonly workers: FakeWorker[] = [];
  makeQueue(): QueueLike {
    return {
      add: async () => undefined,
      getJobCounts: async () => ({}),
      close: async () => undefined,
    };
  }
  makeWorker(name: string, process: ProcessFn, opts?: { concurrency?: number }): WorkerLike {
    const worker = new FakeWorker(name, process, opts?.concurrency);
    this.workers.push(worker);
    return worker;
  }
  makeRedis(): RedisLike {
    return noopRedis();
  }
}

function subscribeEverything(t: BullMQTransport): void {
  t.handle('charge', async () => 'ok');
  t.handleWorkflow('checkout', async () => ({ commands: [] }) as never);
  t.onResult(async () => {});
  t.onDecision(async () => {});
  t.onStepEvent(async () => {});
  t.onStartRun(async () => {});
  t.onRunRequest(async () => {});
}

describe('BullMQTransport deferred consumers', () => {
  it('without deferral, every point-to-point consumer starts at once (unchanged)', async () => {
    const broker = new FakeBroker();
    const t = new BullMQTransport({ deps: broker, instanceId: 'w1' });
    subscribeEverything(t);
    expect(broker.workers.map((w) => w.name).length).toBeGreaterThanOrEqual(6);
    await t.close();
  });

  it('deferConsumers() parks every worker until startConsumers()', async () => {
    const broker = new FakeBroker();
    const t = new BullMQTransport({ deps: broker, instanceId: 'w1' });
    t.deferConsumers();
    subscribeEverything(t);
    // A producer process: nothing consumes, yet it can still dispatch.
    expect(broker.workers).toHaveLength(0);

    t.startConsumers();
    const started = broker.workers.map((w) => w.name);
    expect(started.length).toBeGreaterThanOrEqual(6);
    // The terminal-failure bridges registered while parked are attached to the real workers.
    const taskWorker = broker.workers.find((w) => w.name.includes('tasks'));
    expect(taskWorker?.failedListeners.length).toBeGreaterThan(0);
    const resultsWorker = broker.workers.find((w) => w.name.includes('results'));
    expect(resultsWorker?.failedListeners.length).toBeGreaterThan(0);

    t.startConsumers(); // idempotent
    expect(broker.workers.map((w) => w.name)).toEqual(started);
    await t.close();
  });

  it('a concurrency assigned while parked reaches the real worker', async () => {
    const broker = new FakeBroker();
    const t = new BullMQTransport({ deps: broker, instanceId: 'w1', concurrency: 4 });
    t.deferConsumers();
    t.handle('charge', async () => 'ok');
    t.startConsumers();
    expect(broker.workers.find((w) => w.name.includes('tasks'))?.concurrency).toBe(4);
    await t.close();
  });

  it('closing a producer that never started consumers builds no worker', async () => {
    const broker = new FakeBroker();
    const t = new BullMQTransport({ deps: broker, instanceId: 'w1' });
    t.deferConsumers();
    subscribeEverything(t);
    await t.close();
    t.startConsumers();
    expect(broker.workers).toHaveLength(0);
  });
});
