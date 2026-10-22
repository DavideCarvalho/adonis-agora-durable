import type { AcquiredJob, Adapter, JobData } from '@adonisjs/queue/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteTask, StepResult } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { jobHandle, QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';

/**
 * `@adonisjs/queue` 0.7 (`@boringnode/queue` 0.9) changed the adapter contract the transport drives:
 * every claim carries a `leaseToken`; `completeJob` / `retryJob` / `failJob` take the `{ id, leaseToken }`
 * lease instead of the job id; `recoverStalledJobs` takes a `maxExceeded` and hands the jobs that stalled
 * too often back to the caller to fail. A bare id passed to a lease-based adapter finalizes NOTHING: the
 * job stays `active`, and the stalled sweep re-delivers it later — every step would run twice. These
 * specs run the same lifecycle against both contracts, since the peer range accepts both.
 */

/**
 * An adapter on the `@adonisjs/queue` 0.6 contract (`@boringnode/queue` 0.6): claims carry no lease,
 * the finalize methods take the job id, and `recoverStalledJobs(queue, threshold, maxStalled)` fails the
 * jobs that stalled too often itself and returns a count. Built over {@link MockAdapter} so both
 * contracts share the exact same queue semantics.
 */
class LegacyContractAdapter {
  readonly inner = new MockAdapter();
  readonly #leases = new Map<string, string>();

  setWorkerId(id: string): void {
    this.inner.setWorkerId(id);
  }
  pushOn(queue: string, job: JobData): Promise<void> {
    return this.inner.pushOn(queue, job);
  }
  async popFrom(queue: string): Promise<Omit<AcquiredJob, 'leaseToken'> | null> {
    const job = await this.inner.popFrom(queue);
    if (!job) return null;
    const { leaseToken, ...claim } = job;
    this.#leases.set(job.id, leaseToken);
    return claim;
  }
  #lease(jobId: unknown) {
    if (typeof jobId !== 'string') throw new TypeError('a 0.6 adapter finalizes by job id');
    return { id: jobId, leaseToken: this.#leases.get(jobId) ?? '' };
  }
  async completeJob(jobId: string): Promise<void> {
    await this.inner.completeJob(this.#lease(jobId));
  }
  async failJob(jobId: string): Promise<void> {
    await this.inner.failJob(this.#lease(jobId));
  }
  async retryJob(jobId: string, queue: string, retryAt?: Date): Promise<void> {
    await this.inner.retryJob(this.#lease(jobId), queue, retryAt);
  }
  async recoverStalledJobs(queue: string, threshold: number, maxStalled: number): Promise<number> {
    const { recovered, exceeded } = await this.inner.recoverStalledJobs(
      queue,
      threshold,
      maxStalled,
      Number.POSITIVE_INFINITY,
    );
    for (const job of exceeded) await this.inner.failJob(job);
    return recovered;
  }
  sizeOf(queue: string): Promise<number> {
    return this.inner.sizeOf(queue);
  }
  destroy(): Promise<void> {
    return this.inner.destroy();
  }
}

const POLL = 5;
const TASKS_QUEUE = `durable:tasks:${sanitizeQueueToken('ext.echo')}`;
const RESULTS_QUEUE = 'durable:results';

async function until(cond: () => boolean, budgetMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const task = (over: Partial<RemoteTask> = {}): RemoteTask => ({
  runId: 'r1',
  seq: 1,
  name: 'ext.echo',
  stepId: 'r1:1',
  group: sanitizeQueueToken('ext.echo'),
  input: { hello: 'world' },
  attempt: 1,
  ...over,
});

const contracts = [
  {
    name: '@adonisjs/queue 0.7 (lease tokens)',
    make: () => {
      const adapter = new MockAdapter();
      return { adapter: adapter as Adapter, mock: adapter };
    },
  },
  {
    name: '@adonisjs/queue 0.6 (job ids)',
    make: () => {
      const adapter = new LegacyContractAdapter();
      return { adapter: adapter as unknown as Adapter, mock: adapter.inner };
    },
  },
];

describe.each(contracts)('QueueTransport on the $name adapter contract', ({ make }) => {
  const transports: QueueTransport[] = [];
  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.close()));
  });

  const transport = (adapter: Adapter, over: Partial<{ stalledCheckIntervalMs: number }> = {}) => {
    const t = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: POLL,
      stalledCheckIntervalMs: 0,
      ...over,
    });
    transports.push(t);
    return t;
  };

  it('a round-trip finalizes every job it claimed — nothing is left active to be re-delivered', async () => {
    const { adapter, mock } = make();
    const engine = transport(adapter);
    const worker = transport(adapter);
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    worker.handle('ext.echo', async (input) => ({ echoed: input }));

    await engine.dispatch(task());
    await until(() => results.length === 1);
    expect(results[0]).toMatchObject({
      status: 'completed',
      output: { echoed: { hello: 'world' } },
    });
    await until(() => mock.active.size === 0);
    expect(await mock.sizeOf(TASKS_QUEUE)).toBe(0);
    expect(await mock.sizeOf(RESULTS_QUEUE)).toBe(0);
  });

  it('a throwing handler hands the job back (retryJob) — redelivered, then completed', async () => {
    const { adapter, mock } = make();
    const engine = transport(adapter);
    const worker = transport(adapter);
    worker.handle('ext.echo', async () => 'ok');
    let calls = 0;
    const settled: StepResult[] = [];
    engine.onResult(async (r) => {
      calls += 1;
      if (calls === 1) throw new Error('store down');
      settled.push(r);
    });

    await engine.dispatch(task());
    await until(() => settled.length === 1);
    expect(calls).toBe(2);
    await until(() => mock.active.size === 0);
  });

  it('a job that stalled past maxStalledCount is failed for good, not left active', async () => {
    const { adapter, mock } = make();
    // A claim that stalled 3 times already (the default bound), held by a worker that died.
    await mock.pushOn(TASKS_QUEUE, {
      id: 'poison',
      name: 'task',
      payload: task(),
      attempts: 0,
      stalledCount: 3,
    });
    const dead = await mock.popFrom(TASKS_QUEUE);
    expect(dead?.id).toBe('poison');

    const worker = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: POLL,
      stalledCheckIntervalMs: POLL,
      stalledThresholdMs: 1,
    });
    transports.push(worker);
    let runs = 0;
    worker.handle('ext.echo', async () => {
      runs += 1;
      return 'ok';
    });

    await until(() => mock.failed.some((j) => j.id === 'poison'));
    expect(mock.active.size).toBe(0);
    expect(runs).toBe(0);
  });

  it('close() hands a job still in a handler back to the broker for another worker', async () => {
    const { adapter, mock } = make();
    const engine = transport(adapter);
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));

    const leaving = new QueueTransport({ adapter: () => adapter, pollIntervalMs: POLL });
    let started = false;
    leaving.handle('ext.echo', async () => {
      started = true;
      await new Promise(() => {}); // a step longer than the shutdown drain
    });
    await engine.dispatch(task());
    await until(() => started);
    await leaving.close();
    // Handed back (not left `active` until the stalled threshold): it is pending again right away.
    expect(await mock.sizeOf(TASKS_QUEUE)).toBe(1);

    const next = transport(adapter);
    next.handle('ext.echo', async () => 'done');
    await until(() => results.length === 1);
    expect(results[0]).toMatchObject({ status: 'completed', output: 'done' });
  }, 15_000);
});

describe('jobHandle', () => {
  it('finalizes with the lease when the claim carries one, else with the id', () => {
    const claim = { id: 'j1', name: 'task', payload: {}, attempts: 0, acquiredAt: 1 };
    expect(jobHandle({ ...claim, leaseToken: 'w:abc' })).toEqual({ id: 'j1', leaseToken: 'w:abc' });
    expect(jobHandle(claim as AcquiredJob)).toBe('j1');
  });
});
