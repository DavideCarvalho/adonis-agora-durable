import { describe, expect, it } from 'vitest';
import type { RemoteTask, StepLogger } from '../../../../src/interfaces.js';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import type {
  BullMQDeps,
  JobLike,
  ProcessFn,
  QueueLike,
  RedisLike,
} from '../../../../src/transports/bullmq/deps.js';

/**
 * Shutdown with a step still running. `close()` used to wait `closeTimeoutMs` and abandon the job:
 * it stayed `active` under the dead process's lock until BullMQ's stalled check found it, and a job
 * that stalled past `maxStalledCount` failed for good ("job stalled more than allowable limit"). Now
 * the step's `log.signal` aborts when `close()` starts, and a step still running when the budget ends
 * is handed back to the broker, as the queue and db transports already did.
 */

interface Add {
  queue: string;
  name: string;
  data: unknown;
}

/** A fake broker whose `Worker.close()` waits for the jobs in its processor, as BullMQ's does. */
function broker() {
  const adds: Add[] = [];
  const processors = new Map<string, ProcessFn>();
  const inFlight = new Set<Promise<unknown>>();
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
      return {
        on: () => undefined,
        close: async () => {
          await Promise.allSettled([...inFlight]);
        },
      };
    },
    makeRedis: () => redis,
  };
  /** Deliver `job` to the worker of `queue`, the way BullMQ calls a processor (job + lock token). */
  const deliver = (queue: string, job: JobLike, token = 'lock-1'): Promise<unknown> => {
    const processor = processors.get(queue);
    if (!processor) throw new Error(`no worker for ${queue}`);
    const run = processor(job, token);
    inFlight.add(run);
    void run.then(
      () => inFlight.delete(run),
      () => inFlight.delete(run),
    );
    return run;
  };
  const results = () => adds.filter((a) => a.queue === 'durable-results');
  return { deps, deliver, results };
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

const tick = () => new Promise((r) => setTimeout(r, 2));

describe('BullMQTransport close() with a step still running', () => {
  it('aborts log.signal when close() starts, so a step that checks it finishes inside the budget', async () => {
    const { deps, deliver, results } = broker();
    const transport = new BullMQTransport({ deps, closeTimeoutMs: 2_000 });
    let seen: AbortSignal | undefined;
    let done = 0;
    transport.handle('crawl.batch', async (_input: unknown, log: StepLogger) => {
      seen = log.signal;
      while (!log.signal.aborted) {
        done += 1;
        await tick();
      }
      return { done };
    });

    const job: JobLike = { id: 'j1', data: task('r1', 'crawl.batch') };
    const run = deliver('durable-tasks-crawl.batch', job);
    while (done === 0) await tick();
    expect(seen?.aborted).toBe(false);

    const t0 = Date.now();
    await transport.close();
    expect(Date.now() - t0).toBeLessThan(1_000);
    await run;
    expect(seen?.aborted).toBe(true);
    expect(results()).toHaveLength(1);
    expect(results()[0]?.data).toMatchObject({ runId: 'r1', status: 'completed' });
  });

  it('hands a step that outlives the budget back to the broker, and publishes nothing for it', async () => {
    const { deps, deliver, results } = broker();
    const transport = new BullMQTransport({ deps, closeTimeoutMs: 50 });
    let finish!: () => void;
    let started = false;
    transport.handle('crawl.stubborn', async () => {
      started = true;
      await new Promise<void>((r) => {
        finish = r;
      });
      return 'late';
    });
    const moved: Array<{ timestamp: number; token: string | undefined }> = [];
    const job: JobLike = {
      id: 'j2',
      data: task('r2', 'crawl.stubborn'),
      moveToDelayed: async (timestamp, token) => {
        moved.push({ timestamp, token });
      },
    };
    const run = deliver('durable-tasks-crawl.stubborn', job, 'lock-2');
    while (!started) await tick();

    const t0 = Date.now();
    await transport.close();
    // The hand-back happens inside the budget, not after it.
    expect(Date.now() - t0).toBeLessThan(250);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.token).toBe('lock-2');
    expect(moved[0]?.timestamp).toBeLessThanOrEqual(Date.now());
    // BullMQ reads a DelayedError as "already moved": it neither completes nor fails the job.
    await expect(run).rejects.toMatchObject({ name: 'DelayedError' });

    // The abandoned handler finishing later must not publish: the redelivery owns the step now.
    finish();
    await tick();
    expect(results()).toHaveLength(0);
  });

  it('leaves the job to the stalled check when the hand-back fails', async () => {
    const { deps, deliver, results } = broker();
    const errors: unknown[] = [];
    const transport = new BullMQTransport({
      deps,
      closeTimeoutMs: 50,
      onError: (err) => errors.push(err),
    });
    let finish!: () => void;
    let started = false;
    transport.handle('crawl.lost', async () => {
      started = true;
      await new Promise<void>((r) => {
        finish = r;
      });
      return 'late';
    });
    const job: JobLike = {
      id: 'j3',
      data: task('r3', 'crawl.lost'),
      moveToDelayed: async () => {
        throw new Error('Missing lock for job j3');
      },
    };
    const run = deliver('durable-tasks-crawl.lost', job);
    while (!started) await tick();

    await transport.close();
    expect(errors).toEqual([expect.objectContaining({ message: 'Missing lock for job j3' })]);

    // Not handed back: the handler still owns the job and publishes when it ends.
    finish();
    await run;
    expect(results()).toHaveLength(1);
  });
});
