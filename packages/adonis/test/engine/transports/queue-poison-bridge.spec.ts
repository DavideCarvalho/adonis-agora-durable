import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../../src/engine.js';
import type { RemoteTask, StepResult } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { InMemoryStateStore } from '../../../src/testing/in-memory-state-store.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';

// The reclaim sweep failed a job that stalled more than `maxStalledCount` times, but published
// nothing: no handler ever produced a result for that step, so its run waited on the `pending`
// checkpoint forever. BullMQ bridges a terminally failed task job into a failed StepResult
// (`worker.on('failed')`); these cover the queue transport doing the same.

const POLL = 5;
const TASKS_QUEUE = `durable:tasks:${sanitizeQueueToken('ext.poison')}`;
const RESULTS_QUEUE = 'durable:results';

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const task = (): RemoteTask => ({
  runId: 'r1',
  seq: 3,
  name: 'ext.poison',
  stepId: 'r1:3',
  group: sanitizeQueueToken('ext.poison'),
  input: {},
  attempt: 1,
});

/** A job that already stalled `stalledCount` times, now claimed by a worker that died. */
async function deadClaim(adapter: MockAdapter, queue: string, payload: unknown, stalledCount = 3) {
  await adapter.pushOn(queue, { id: 'poison', name: 'job', payload, attempts: 0, stalledCount });
  const claimed = await adapter.popFrom(queue);
  expect(claimed?.id).toBe('poison');
}

describe('QueueTransport poison-job bridge', () => {
  const transports: QueueTransport[] = [];
  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.close()));
  });

  const make = (adapter: MockAdapter, sweeping = false) => {
    const t = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: POLL,
      ...(sweeping
        ? { stalledCheckIntervalMs: POLL, stalledThresholdMs: 1 }
        : { stalledCheckIntervalMs: 0 }),
    });
    transports.push(t);
    return t;
  };

  it('publishes a retryable failed StepResult for a task that stalled past maxStalledCount', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    await deadClaim(adapter, TASKS_QUEUE, task());

    const worker = make(adapter, true);
    let runs = 0;
    worker.handle('ext.poison', async () => {
      runs += 1;
      return 'ok';
    });

    await until(() => results.length === 1);
    expect(results[0]).toEqual({
      runId: 'r1',
      seq: 3,
      stepId: 'r1:3',
      status: 'failed',
      error: { message: 'remote step worker failed: stalled more than 3 times', retryable: true },
    });
    expect(adapter.failed.map((j) => j.id)).toEqual(['poison']);
    expect(adapter.active.size).toBe(0);
    expect(runs).toBe(0);
  });

  it('only bridges task queues: a stalled result job is failed, with nothing published', async () => {
    const adapter = new MockAdapter();
    // A StepResult payload has a runId/seq/stepId too — it must still not be bridged.
    const stuck: StepResult = { runId: 'r1', seq: 3, stepId: 'r1:3', status: 'completed' };
    await deadClaim(adapter, RESULTS_QUEUE, stuck);
    const engine = make(adapter, true);
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));

    await until(() => adapter.failed.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(results).toEqual([]);
    expect(await adapter.sizeOf(RESULTS_QUEUE)).toBe(0);
  });

  it('a payload without a step identity (e.g. a workflow turn) is failed, not bridged', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    await deadClaim(adapter, TASKS_QUEUE, { taskId: 't1', runId: 'r1', workflow: 'wf' });
    const worker = make(adapter, true);
    worker.handle('ext.poison', async () => 'ok');

    await until(() => adapter.failed.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(results).toEqual([]);
  });

  it('the bridged failure fails the step into the workflow instead of leaving it pending', async () => {
    const adapter = new MockAdapter();
    const store = new InMemoryStateStore();
    const engineTransport = make(adapter);
    const engine = new WorkflowEngine({ store, transport: engineTransport });
    engine.register('wf', '1', async (ctx) => ctx.step('ext.poison', {}));

    await engine.start('wf', {}, 'run-poison');
    // The dispatched task is claimed by a worker that dies on it, past the stalled bound.
    await until(async () => (await adapter.sizeOf(TASKS_QUEUE)) === 1);
    const [job] = adapter.pending.get(TASKS_QUEUE) ?? [];
    if (job) job.stalledCount = 3;
    expect(await adapter.popFrom(TASKS_QUEUE)).not.toBeNull();

    const worker = make(adapter, true);
    worker.handle('ext.poison', async () => 'never runs');

    await until(async () => (await store.getRun('run-poison'))?.status === 'failed');
    expect((await store.getRun('run-poison'))?.error?.message).toContain(
      'stalled more than 3 times',
    );
    expect(await store.getCheckpoint('run-poison', 0)).toMatchObject({
      status: 'failed',
      error: { message: 'remote step worker failed: stalled more than 3 times', retryable: true },
    });
  });
});
