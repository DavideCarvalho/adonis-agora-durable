import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteTask } from '../../../../src/interfaces.js';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import type {
  BullMQDeps,
  ProcessFn,
  QueueLike,
  RedisLike,
} from '../../../../src/transports/bullmq/deps.js';

/**
 * `stepTimeoutMs`, the wedged-handler ceiling. A handler await that never settles otherwise holds
 * its BullMQ job forever: the lock renews on a timer, so the job is never reclaimed and the run waits
 * until someone kills the process. With the ceiling set, a RETRYABLE failed StepResult is published
 * at the deadline and the orphaned promise is abandoned.
 */

interface Add {
  queue: string;
  name: string;
  data: unknown;
}

function broker() {
  const adds: Add[] = [];
  const processors = new Map<string, ProcessFn>();
  const redis: RedisLike = {
    publish: async () => 1,
    subscribe: async () => 1,
    on: () => undefined,
    set: async () => 'OK',
    scan: async () => ['0', []],
    get: async () => null,
    disconnect: () => undefined,
  };
  const deps: BullMQDeps = {
    makeQueue: (queue): QueueLike => ({
      add: async (name, data) => {
        adds.push({ queue, name, data });
        return undefined;
      },
      getJobCounts: async () => ({}),
      close: async () => undefined,
    }),
    makeWorker: (name, process) => {
      processors.set(name, process);
      return { on: () => undefined, close: async () => undefined };
    },
    makeRedis: () => redis,
  };
  return { deps, adds, processors };
}

const task = (runId: string, name: string): RemoteTask => ({
  runId,
  seq: 0,
  stepId: `${runId}:0`,
  name,
  group: name,
  input: {},
  attempt: 0,
});

describe('BullMQTransport stepTimeoutMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a handler that never settles fails RETRYABLE at the deadline instead of holding its job', async () => {
    const { deps, adds, processors } = broker();
    const transport = new BullMQTransport({ deps, stepTimeoutMs: 5_000 });
    transport.handle('etl.ingest', () => new Promise(() => {}));
    const results = () => adds.filter((a) => a.queue === 'durable-results');

    const running = processors.get('durable-tasks-etl.ingest')?.({
      data: task('r1', 'etl.ingest'),
    });
    expect(running).toBeDefined();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(results()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2);
    await running;
    expect(results()).toHaveLength(1);
    expect(results()[0]?.data).toMatchObject({
      runId: 'r1',
      seq: 0,
      stepId: 'r1:0',
      status: 'failed',
      error: { message: expect.stringContaining('exceeded stepTimeoutMs'), retryable: true },
    });
    await transport.close();
  });

  it('a handler finishing inside the ceiling publishes its own result, once', async () => {
    const { deps, adds, processors } = broker();
    const transport = new BullMQTransport({ deps, stepTimeoutMs: 5_000 });
    transport.handle('etl.quick', async () => ({ rows: 7 }));

    await processors.get('durable-tasks-etl.quick')?.({ data: task('r2', 'etl.quick') });
    await vi.advanceTimersByTimeAsync(10_000);

    const results = adds.filter((a) => a.queue === 'durable-results');
    expect(results).toHaveLength(1);
    expect(results[0]?.data).toMatchObject({
      runId: 'r2',
      status: 'completed',
      output: { rows: 7 },
    });
    await transport.close();
  });

  it('a handler that throws inside the ceiling still publishes its own failure', async () => {
    const { deps, adds, processors } = broker();
    const transport = new BullMQTransport({ deps, stepTimeoutMs: 5_000 });
    transport.handle('etl.bad', async () => {
      throw new Error('boom');
    });

    await processors.get('durable-tasks-etl.bad')?.({ data: task('r4', 'etl.bad') });
    const results = adds.filter((a) => a.queue === 'durable-results');
    expect(results).toHaveLength(1);
    expect(results[0]?.data).toMatchObject({ status: 'failed', error: { message: 'boom' } });
    await transport.close();
  });

  it('no ceiling (the default) leaves a wedged handler pending, as before', async () => {
    const { deps, adds, processors } = broker();
    const transport = new BullMQTransport({ deps });
    transport.handle('etl.legacy', () => new Promise(() => {}));

    void processors.get('durable-tasks-etl.legacy')?.({ data: task('r3', 'etl.legacy') });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(adds.filter((a) => a.queue === 'durable-results')).toHaveLength(0);
    await transport.close();
  });
});
