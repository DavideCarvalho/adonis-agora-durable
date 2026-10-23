import { describe, expect, it } from 'vitest';
import type { RunDispatch } from '../../../../src/interfaces.js';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import {
  type BullMQDeps,
  createBullMQDeps,
  type JobLike,
  type ProcessFn,
  type QueueLike,
  type RedisLike,
  type WorkerLike,
} from '../../../../src/transports/bullmq/deps.js';
import { runStartJobId } from '../../../../src/transports/bullmq/naming.js';
import { backendUrl, deleteRedisKeys, uniqueRedisPrefix } from '../../../support/backends.js';

interface Job {
  name: string;
  data: unknown;
  opts?: unknown;
}

class FakeQueue implements QueueLike {
  adds: Job[] = [];
  bulks: Job[][] = [];
  constructor(readonly withBulk: boolean) {
    if (!withBulk) (this as { addBulk?: unknown }).addBulk = undefined;
  }
  async add(name: string, data: unknown, opts?: unknown): Promise<unknown> {
    this.adds.push({ name, data, opts });
    return {};
  }
  async addBulk(jobs: Job[]): Promise<unknown> {
    this.bulks.push(jobs);
    return [];
  }
  async getJobCounts(): Promise<Record<string, number>> {
    return {};
  }
  async close(): Promise<unknown> {
    return undefined;
  }
}

class FakeWorker implements WorkerLike {
  closed = 0;
  constructor(
    readonly name: string,
    readonly process: ProcessFn,
    public concurrency?: number,
  ) {}
  on(): unknown {
    return this;
  }
  async close(): Promise<unknown> {
    this.closed += 1;
    return undefined;
  }
}

function broker(withBulk = true) {
  const queues = new Map<string, FakeQueue>();
  const workers: FakeWorker[] = [];
  const deps: BullMQDeps = {
    makeQueue: (name) => {
      let q = queues.get(name);
      if (!q) {
        q = new FakeQueue(withBulk);
        queues.set(name, q);
      }
      return q;
    },
    makeWorker: (name, process, opts) => {
      const w = new FakeWorker(name, process, opts?.concurrency);
      workers.push(w);
      return w;
    },
    makeRedis: () => ({}) as RedisLike,
  };
  return { deps, queues, workers };
}

const runs = (n: number, reason: RunDispatch['reason'] = 'start'): RunDispatch[] =>
  Array.from({ length: n }, (_, i) => ({ runId: `r:${i}`, reason }));

describe('BullMQTransport run queue', () => {
  it('enqueues runs on <prefix>-runs with addBulk, 500 jobs per call', async () => {
    const { deps, queues } = broker();
    const transport = new BullMQTransport({ deps, prefix: 'p' });
    await transport.dispatchRuns(runs(1_200));
    const queue = queues.get('p-runs') as FakeQueue;
    expect(queue.bulks.map((b) => b.length)).toEqual([500, 500, 200]);
    expect(queue.adds).toEqual([]);
    expect(queue.bulks[0]?.[0]).toMatchObject({
      name: 'run',
      data: { runId: 'r:0', reason: 'start' },
    });
  });

  it('falls back to one add per job on a queue without addBulk', async () => {
    const { deps, queues } = broker(false);
    const transport = new BullMQTransport({ deps, prefix: 'p' });
    await transport.dispatchRuns(runs(3));
    expect((queues.get('p-runs') as FakeQueue).adds).toHaveLength(3);
  });

  it('gives a start a job id from its run id and pending-state key, and a wake none', async () => {
    const { deps, queues } = broker();
    const transport = new BullMQTransport({ deps, prefix: 'p' });
    await transport.dispatchRuns([
      { runId: 'dlq:a:b', reason: 'start', key: '1' },
      { runId: '42', reason: 'start', key: 'k:2' },
      { runId: 'x', reason: 'start' },
      { runId: 'dlq:a:b', reason: 'wake' },
    ]);
    const jobIds = ((queues.get('p-runs') as FakeQueue).bulks[0] as Job[]).map(
      (job) => (job.opts as { jobId?: string }).jobId,
    );
    expect(jobIds).toEqual(['start-dlq%3Aa%3Ab-1', 'start-42-k%3A2', undefined, undefined]);
    // BullMQ rejects an integer id or one with a `:`.
    expect(runStartJobId('a:b%c', '7')).toBe('start-a%3Ab%25c-7');
  });

  it('consumes with the requested concurrency, hands each job to the handler, and stops', async () => {
    const { deps, workers } = broker();
    const transport = new BullMQTransport({ deps, prefix: 'p' });
    const seen: RunDispatch[] = [];
    const stop = transport.onRun(async (run) => void seen.push(run), { concurrency: 64 });
    expect(transport.onRun(async () => {})).toBe(stop);
    const worker = workers.find((w) => w.name === 'p-runs') as FakeWorker;
    expect(worker.concurrency).toBe(64);
    await worker.process({ data: { runId: 'x', reason: 'wake' } } as JobLike);
    expect(seen).toEqual([{ runId: 'x', reason: 'wake' }]);
    await stop();
    await stop();
    expect(worker.closed).toBe(1);
  });

  it('parks the run consumer while consumers are deferred', async () => {
    const { deps, workers } = broker();
    const transport = new BullMQTransport({ deps, prefix: 'p' });
    transport.deferConsumers();
    transport.onRun(async () => {});
    expect(workers.filter((w) => w.name === 'p-runs')).toHaveLength(0);
    transport.startConsumers();
    expect(workers.filter((w) => w.name === 'p-runs')).toHaveLength(1);
  });
});

const REDIS_URL = backendUrl('DURABLE_REDIS_URL');

describe.skipIf(!REDIS_URL)('BullMQTransport run queue over real Redis', () => {
  it('keeps one waiting job per pending state of a run, and every wake', async () => {
    const prefix = uniqueRedisPrefix('durable-runq');
    const deps = await createBullMQDeps(REDIS_URL as string);
    const transport = new BullMQTransport({ deps, prefix });
    try {
      await transport.dispatchRuns([
        { runId: 'a', reason: 'start', key: '1' },
        { runId: 'a', reason: 'start', key: '1' },
        { runId: 'a:1', reason: 'start', key: '1' },
      ]);
      await transport.dispatchRuns([
        { runId: 'a', reason: 'start', key: '1' },
        { runId: 'a', reason: 'wake' },
        { runId: 'a', reason: 'wake' },
        { runId: 'a', reason: 'start', key: '2' },
      ]);
      const counts = await deps.makeQueue(`${prefix}-runs`).getJobCounts('waiting');
      expect(counts.waiting).toBe(5);
    } finally {
      await transport.close();
      const redis = deps.makeRedis() as unknown as Parameters<typeof deleteRedisKeys>[0] & {
        quit(): Promise<unknown>;
      };
      await deleteRedisKeys(redis, prefix);
      await redis.quit();
    }
  });

  it('runs at most `concurrency` handlers at once', async () => {
    const prefix = uniqueRedisPrefix('durable-runq');
    const deps = await createBullMQDeps(REDIS_URL as string);
    const transport = new BullMQTransport({ deps, prefix });
    let active = 0;
    let peak = 0;
    let done = 0;
    try {
      transport.onRun(
        async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 30));
          active -= 1;
          done += 1;
        },
        { concurrency: 4 },
      );
      await transport.dispatchRuns(runs(24, 'wake'));
      const deadline = Date.now() + 15_000;
      while (done < 24 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(done).toBe(24);
      expect(peak).toBeLessThanOrEqual(4);
      expect(peak).toBeGreaterThan(1);
    } finally {
      await transport.close();
      const redis = deps.makeRedis() as unknown as Parameters<typeof deleteRedisKeys>[0] & {
        quit(): Promise<unknown>;
      };
      await deleteRedisKeys(redis, prefix);
      await redis.quit();
    }
  });
});
