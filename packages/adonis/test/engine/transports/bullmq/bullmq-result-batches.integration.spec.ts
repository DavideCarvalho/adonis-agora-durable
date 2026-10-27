import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../../../src/engine.js';
import { DURABLE_STEP_NAME, type StepRef } from '../../../../src/step-name-symbol.js';
import { InMemoryStateStore } from '../../../../src/testing/in-memory-state-store.js';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import { type BullMQDeps, createBullMQDeps } from '../../../../src/transports/bullmq/deps.js';
import { backendUrl, uniqueRedisPrefix } from '../../../support/backends.js';

/**
 * Step results go out in batches while an engine reads them: one job of the results-batch queue
 * carries the results that finished while the previous batch was being published. A worker that finds
 * no engine reading batches keeps publishing one result per job, which every engine reads. Gated on
 * `DURABLE_REDIS_URL`, like the other real-Redis specs.
 */
const REDIS_URL = backendUrl('DURABLE_REDIS_URL');
const STEP = 'lines.process';
const processLine = (() => {}) as unknown as StepRef<{ i: number }, number>;
(processLine as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = STEP;

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length)
    await closers
      .pop()?.()
      .catch(() => {});
});

/** Real deps whose queues count their `add` calls by queue name, and refuse the first `refuse` adds
 *  to queues whose name ends with `refuseOn`. */
async function countingDeps(
  adds: Map<string, number>,
  refuse?: { suffix: string; times: number },
): Promise<BullMQDeps> {
  const deps = await createBullMQDeps({ url: REDIS_URL } as unknown, 32);
  return {
    ...deps,
    makeQueue(name) {
      const queue = deps.makeQueue(name);
      const add = queue.add.bind(queue);
      queue.add = async (job, data, opts) => {
        if (refuse && name.endsWith(refuse.suffix) && refuse.times > 0) {
          refuse.times -= 1;
          throw new Error('broker blip');
        }
        adds.set(name, (adds.get(name) ?? 0) + 1);
        return add(job, data, opts);
      };
      return queue;
    },
  };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition was never met');
}

function fanEngine(transport: BullMQTransport) {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
  engine.register('fan', '1', async (ctx, input) =>
    ctx.all(
      processLine,
      Array.from({ length: (input as { n: number }).n }, (_, i) => ({ i })),
    ),
  );
  closers.push(() => engine.drain(5_000));
  return { store, engine };
}

describe.skipIf(!REDIS_URL)('BullMQ step results in batches', () => {
  it('a busy worker publishes its results in batches, and every step settles once', async () => {
    const prefix = uniqueRedisPrefix('rb-busy');
    const adds = new Map<string, number>();
    const transport = new BullMQTransport({
      deps: await countingDeps(adds),
      prefix,
      concurrency: 32,
    });
    closers.push(() => transport.close());
    let ran = 0;
    transport.handle(STEP, async (input) => {
      ran += 1;
      return (input as { i: number }).i * 10;
    });
    const { store, engine } = fanEngine(transport);

    await engine.start('fan', { n: 2_000 }, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual(
      Array.from({ length: 2_000 }, (_, i) => i * 10),
    );
    expect(ran).toBe(2_000);
    expect(adds.get(`${prefix}-results`) ?? 0).toBe(0);
    const batches = adds.get(`${prefix}-results-batch`) ?? 0;
    expect(batches).toBeGreaterThan(0);
    expect(batches).toBeLessThan(2_000 / 2);
  }, 60_000);

  it('a worker with no engine reading batches publishes one result per job', async () => {
    const prefix = uniqueRedisPrefix('rb-legacy');
    const adds = new Map<string, number>();
    const worker = new BullMQTransport({ deps: await countingDeps(adds), prefix, concurrency: 8 });
    closers.push(() => worker.close());
    worker.handle(STEP, async (input) => (input as { i: number }).i);
    // A consumer of the results queue only, as an engine that reads one result per job is.
    const deps = await createBullMQDeps({ url: REDIS_URL } as unknown);
    const seen: number[] = [];
    const legacy = deps.makeWorker(`${prefix}-results`, async (job) => {
      seen.push((job.data as { seq: number }).seq);
    });
    closers.push(() => legacy.close());

    for (let seq = 0; seq < 50; seq++) {
      await worker.dispatch({
        runId: 'r',
        seq,
        name: STEP,
        stepId: `r:${seq}`,
        group: STEP,
        input: { i: seq },
        attempt: 1,
      });
    }
    await until(() => seen.length === 50);
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(adds.get(`${prefix}-results-batch`) ?? 0).toBe(0);
  }, 60_000);

  it('a batch that fails to publish goes out one result per job, and no step runs twice', async () => {
    const prefix = uniqueRedisPrefix('rb-fail');
    const adds = new Map<string, number>();
    const refuse = { suffix: '-results-batch', times: 3 };
    const transport = new BullMQTransport({
      deps: await countingDeps(adds, refuse),
      prefix,
      concurrency: 8,
    });
    closers.push(() => transport.close());
    const runs = new Map<number, number>();
    transport.handle(STEP, async (input) => {
      const { i } = input as { i: number };
      runs.set(i, (runs.get(i) ?? 0) + 1);
      return i * 10;
    });
    const { store, engine } = fanEngine(transport);

    await engine.start('fan', { n: 200 }, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect(refuse.times).toBe(0);
    expect((await store.getRun('p'))?.output).toEqual(
      Array.from({ length: 200 }, (_, i) => i * 10),
    );
    expect(runs.size).toBe(200);
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
  }, 60_000);

  it('an engine reading batches still settles results published one per job', async () => {
    const prefix = uniqueRedisPrefix('rb-single');
    const engineSide = new BullMQTransport({
      deps: await createBullMQDeps({ url: REDIS_URL } as unknown),
      prefix,
    });
    closers.push(() => engineSide.close());
    const { store, engine } = fanEngine(engineSide);
    // A worker that answers each task straight onto the results queue, as an older one does.
    const deps = await createBullMQDeps({ url: REDIS_URL } as unknown, 16);
    const results = deps.makeQueue(`${prefix}-results`);
    closers.push(() => results.close());
    const legacy = deps.makeWorker(`${prefix}-tasks-${STEP}`, async (job) => {
      const t = job.data as { runId: string; seq: number; stepId: string; input: { i: number } };
      await results.add('result', {
        runId: t.runId,
        seq: t.seq,
        stepId: t.stepId,
        status: 'completed',
        output: t.input.i + 1,
      });
    });
    closers.push(() => legacy.close());

    await engine.start('fan', { n: 300 }, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
  }, 60_000);
});
