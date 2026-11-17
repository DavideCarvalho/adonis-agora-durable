import { afterAll, describe, expect, it } from 'vitest';
import type { RemoteTask, StepResult } from '../../../../src/interfaces.js';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps } from '../../../../src/transports/bullmq/deps.js';
import { backendUrl, uniqueRedisPrefix } from '../../../support/backends.js';

/**
 * `taskQueues: 'grouped'` and `taskQueueDrain` against real BullMQ: one shared queue serves several
 * handlers, each at its own limit (the overflow hand-back uses BullMQ's real `moveToDelayed`), and a
 * grouped worker drains the per-handler queues an older process left jobs on (waiting and delayed),
 * then stops its drain worker. The unit spec (`grouped-task-queues.spec.ts`) covers the same on fakes.
 *
 *   DURABLE_REDIS_URL=redis://localhost:6379 node_modules/.bin/vitest run bullmq-grouped-task-queues
 */
const REDIS_URL = backendUrl('DURABLE_REDIS_URL');

const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of closers.reverse()) await c().catch(() => {});
});

const task = (name: string, runId: string, seq: number): RemoteTask => ({
  runId,
  seq,
  name,
  stepId: `${runId}:${seq}`,
  group: name,
  input: { seq },
  attempt: 0,
});

async function until(cond: () => boolean, ms: number): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!REDIS_URL)("BullMQTransport taskQueues: 'grouped' over real Redis", () => {
  const connection = { url: REDIS_URL } as unknown;

  async function transport(
    prefix: string,
    instanceId: string,
    extra: Partial<ConstructorParameters<typeof BullMQTransport>[0]> = {},
  ): Promise<BullMQTransport> {
    const t = new BullMQTransport({
      deps: await createBullMQDeps(connection),
      prefix,
      instanceId,
      closeTimeoutMs: 2_000,
      ...extra,
    });
    closers.push(() => t.close());
    return t;
  }

  it('runs every handler off one queue, each at its own limit', async () => {
    const prefix = uniqueRedisPrefix('durable-grouped');
    const engine = await transport(prefix, 'engine', { taskQueues: 'grouped' });
    const results: StepResult[] = [];
    engine.onResult(async (r) => {
      results.push(r);
    });

    const worker = await transport(prefix, 'w1', { taskQueues: 'grouped' });
    let slowRunning = 0;
    let slowMax = 0;
    let fastDuringSlow = 0;
    worker.handle('slow', async () => {
      slowRunning += 1;
      slowMax = Math.max(slowMax, slowRunning);
      await new Promise((r) => setTimeout(r, 150));
      slowRunning -= 1;
      return 'slow';
    });
    worker.handle('fast', async () => {
      if (slowRunning > 0) fastDuringSlow += 1;
      return 'fast';
    });

    const tasks = [
      ...Array.from({ length: 5 }, (_, i) => task('slow', 'run-slow', i + 1)),
      ...Array.from({ length: 5 }, (_, i) => task('fast', 'run-fast', i + 1)),
    ];
    await engine.dispatchMany(tasks);
    await until(() => results.length === 10, 30_000);

    expect(results.every((r) => r.status === 'completed')).toBe(true);
    // Default concurrency 1 per handler: `slow` never ran two at once, and `fast` was not stuck
    // behind `slow`'s backlog.
    expect(slowMax).toBe(1);
    expect(fastDuringSlow).toBeGreaterThan(0);
    const health = await engine.groupHealth('slow');
    expect(health.queue).toBe(`${prefix}-taskgroup`);
  });

  it('drains waiting and delayed jobs from per-handler queues, then stops draining', async () => {
    const prefix = uniqueRedisPrefix('durable-grouped-drain');
    // An old (per-handler) engine dispatches while no per-handler worker runs any more.
    const oldEngine = await transport(prefix, 'old-engine');
    const results: StepResult[] = [];
    oldEngine.onResult(async (r) => {
      results.push(r);
    });
    await oldEngine.dispatch(task('legacy.a', 'run-old', 1));
    await oldEngine.dispatch(task('legacy.b', 'run-old', 2));
    // A delayed job (a retry backoff on the old layout) must be picked up once due.
    const deps = await createBullMQDeps(connection);
    const legacyQueue = deps.makeQueue(`${prefix}-tasks-legacy.a`);
    await legacyQueue.add('task', task('legacy.a', 'run-old', 3), {
      delay: 400,
      removeOnComplete: true,
    });
    await legacyQueue.close();

    const worker = await transport(prefix, 'new', {
      taskQueues: 'grouped',
      taskQueueDrain: { intervalMs: 200 },
    });
    worker.handle('legacy.a', async (input) => `a${(input as { seq: number }).seq}`);
    worker.handle('legacy.b', async () => 'b');
    worker.handle('never.used', async () => 'x');

    await until(() => results.length === 3, 30_000);
    expect(results.map((r) => r.seq).sort()).toEqual([1, 2, 3]);
    // Both legacy queues emptied, so their drain workers stop; the unused one never got one.
    await until(() => worker.drainingQueues.length === 0, 10_000);
  });

  it('rolls back: a per-handler worker with taskQueueDrain drains the grouped queue', async () => {
    const prefix = uniqueRedisPrefix('durable-grouped-rollback');
    const groupedEngine = await transport(prefix, 'g-engine', { taskQueues: 'grouped' });
    const results: StepResult[] = [];
    groupedEngine.onResult(async (r) => {
      results.push(r);
    });
    await groupedEngine.dispatch(task('rb.step', 'run-rb', 1));

    const worker = await transport(prefix, 'ph', { taskQueueDrain: { intervalMs: 200 } });
    worker.handle('rb.step', async () => 'ok');
    await until(() => results.length === 1, 30_000);
    expect(results[0]?.status).toBe('completed');
  });
});
