import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteTask, WorkerStatus, WorkflowTask } from '../../../../src/interfaces.js';
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
 * The adaptive controller wired into the transport: task workers start at its limit, every move
 * reaches every task worker's `concurrency`, workflow turns stay out of the measurement window, and
 * the heartbeat carries the controller's status. Offline: an in-memory broker and fake timers.
 */

class FakeQueue implements QueueLike {
  async add(): Promise<unknown> {
    return undefined;
  }
  async getJobCounts(): Promise<Record<string, number>> {
    return {};
  }
  async close(): Promise<unknown> {
    return undefined;
  }
}

class FakeWorker implements WorkerLike {
  constructor(
    readonly process: ProcessFn,
    public concurrency?: number,
  ) {}
  on(): unknown {
    return this;
  }
  async close(): Promise<unknown> {
    return undefined;
  }
}

class FakeRedis implements RedisLike {
  readonly store = new Map<string, string>();
  async publish(): Promise<unknown> {
    return 1;
  }
  async subscribe(): Promise<unknown> {
    return 1;
  }
  on(): unknown {
    return this;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return 'OK';
  }
  async scan(): Promise<[string, string[]]> {
    return ['0', []];
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  disconnect(): void {}
}

class FakeBroker implements BullMQDeps {
  readonly workers = new Map<string, FakeWorker>();
  readonly redis = new FakeRedis();
  makeQueue(): QueueLike {
    return new FakeQueue();
  }
  makeWorker(name: string, process: ProcessFn, opts?: { concurrency?: number }): WorkerLike {
    const worker = new FakeWorker(process, opts?.concurrency);
    this.workers.set(name, worker);
    return worker;
  }
  makeRedis(): RedisLike {
    return this.redis;
  }
}

const stepJob = (name: string, seq: number): JobLike => ({
  data: {
    runId: 'r1',
    seq,
    name,
    stepId: `r1:${seq}`,
    group: name,
    input: null,
    attempt: 0,
  } satisfies RemoteTask,
});

const turnJob = (seq: number): JobLike => ({
  data: {
    taskId: `wf${seq}`,
    runId: 'r2',
    workflow: 'checkout',
    workflowVersion: '1',
    input: null,
    history: [],
    group: 'checkout',
    attempt: 0,
  } satisfies WorkflowTask,
});

function heartbeatStatus(broker: FakeBroker, token: string): WorkerStatus {
  const raw = broker.redis.store.get(`durable-worker-heartbeat:${token}:ts-box-1`);
  if (!raw) throw new Error(`no heartbeat for ${token}`);
  return (JSON.parse(raw) as { status: WorkerStatus }).status;
}

describe('BullMQTransport adaptive concurrency', () => {
  let broker: FakeBroker;
  let transports: BullMQTransport[];

  const make = (concurrency?: ConstructorParameters<typeof BullMQTransport>[0]['concurrency']) => {
    const transport = new BullMQTransport({
      deps: broker,
      instanceId: 'ts-box-1',
      closeTimeoutMs: 0,
      ...(concurrency !== undefined ? { concurrency } : {}),
    });
    transports.push(transport);
    return transport;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    broker = new FakeBroker();
    transports = [];
  });

  afterEach(async () => {
    for (const t of transports) await t.close();
    vi.useRealTimers();
  });

  it('starts task workers at `start`, and a grow reaches every task worker and the heartbeat', async () => {
    const transport = make({ mode: 'adaptive', min: 1, max: 10, start: 4, tickMs: 100 });
    const release: Array<() => void> = [];
    transport.handle('fast', async () => 'ok');
    transport.handle('slow', () => new Promise((resolve) => release.push(() => resolve('ok'))));
    const fast = broker.workers.get('durable-tasks-fast')!;
    const slow = broker.workers.get('durable-tasks-slow')!;
    expect([fast.concurrency, slow.concurrency]).toEqual([4, 4]);

    // A steady latency (every step settles in 0ms of fake time), then 4 in flight at a limit of 4.
    for (let seq = 0; seq < 20; seq++) await fast.process(stepJob('fast', seq));
    const pending = [0, 1, 2, 3].map((seq) => slow.process(stepJob('slow', seq)));

    vi.advanceTimersByTime(100);
    expect([fast.concurrency, slow.concurrency]).toEqual([8, 8]);

    // A token registered after the move joins at the live limit, and its first beat carries it.
    transport.handle('late', async () => 'ok');
    expect(broker.workers.get('durable-tasks-late')?.concurrency).toBe(8);
    const status = heartbeatStatus(broker, 'late');
    expect(status.concurrency).toEqual({ mode: 'adaptive', limit: 8, min: 1, max: 10 });
    expect(status.inFlight).toBe(4);
    expect(status.lastAdjust).toMatchObject({ from: 4, to: 8, reason: 'grow' });

    for (const r of release) r();
    await Promise.all(pending);
  });

  it('sheds on a high step error rate', async () => {
    const transport = make({ mode: 'adaptive', min: 1, max: 10, start: 5, tickMs: 100 });
    transport.handle('flaky', async (input) => {
      if ((input as { fail: boolean }).fail) throw new Error('nope');
      return 'ok';
    });
    const worker = broker.workers.get('durable-tasks-flaky')!;
    for (let seq = 0; seq < 20; seq++) {
      const job = stepJob('flaky', seq);
      (job.data as RemoteTask).input = { fail: seq % 2 === 0 };
      await worker.process(job);
    }
    vi.advanceTimersByTime(100);
    expect(worker.concurrency).toBe(4);
  });

  it('keeps workflow turns out of the measurement window', async () => {
    const transport = make({ mode: 'adaptive', min: 1, max: 10, start: 4, tickMs: 100 });
    transport.handleWorkflow('checkout', async (t) => ({
      taskId: t.taskId,
      runId: t.runId,
      status: 'completed',
      commands: [],
    }));
    const worker = broker.workers.get('durable-tasks-checkout')!;
    for (let seq = 0; seq < 10; seq++) await worker.process(turnJob(seq));

    transport.handle('probe', async () => 'ok');
    const status = heartbeatStatus(broker, 'probe');
    expect(status.inFlight).toBe(0);
    expect(status.p95Ms).toBeUndefined();
    expect(status.throughputPerMin).toBeUndefined();
  });

  it('a fixed number pins every task worker and never moves', async () => {
    const transport = make(6);
    transport.handle('fast', async () => 'ok');
    const worker = broker.workers.get('durable-tasks-fast')!;
    expect(worker.concurrency).toBe(6);
    for (let seq = 0; seq < 20; seq++) await worker.process(stepJob('fast', seq));
    vi.advanceTimersByTime(10_000);
    expect(worker.concurrency).toBe(6);
    expect(heartbeatStatus(broker, 'fast').concurrency).toEqual({ mode: 'fixed', limit: 6 });
  });

  it('unset leaves task workers at the deps default', () => {
    const transport = make();
    transport.handle('fast', async () => 'ok');
    expect(broker.workers.get('durable-tasks-fast')?.concurrency).toBeUndefined();
  });

  it('close() stops the control loop', async () => {
    const transport = make({ mode: 'adaptive', min: 1, max: 10, start: 4, tickMs: 100 });
    transport.handle('slow', () => new Promise(() => {}));
    const worker = broker.workers.get('durable-tasks-slow')!;
    for (let seq = 0; seq < 4; seq++) void worker.process(stepJob('slow', seq));
    await transport.close();
    vi.advanceTimersByTime(1_000);
    expect(worker.concurrency).toBe(4);
  });
});
