import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { StateStore, StepCheckpoint, StepSettlement } from '../../src/interfaces.js';
import { DURABLE_STEP_NAME, type StepRef } from '../../src/step-name-symbol.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { createDurableTables } from '../../src/stores/lucid-schema.js';
import { BullMQTransport } from '../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps } from '../../src/transports/bullmq/deps.js';
import { deleteRedisKeys, uniqueRedisPrefix } from '../support/backends.js';
import { makeIsolatedMysqlDb, makeMysqlDb } from '../support/mysql.js';

/**
 * Opt-in throughput harness: a wide `ctx.all` over a step on the Lucid store over real MySQL and the
 * BullMQ transport over real Redis, with several engine instances (each its own connection pool, as
 * pods) and several workers. Prints what a wide fan costs: the dispatching turn, the time from the
 * last step to the run finishing, the settle batches and their size, the barrier COUNTs, the parent's
 * turns. Not part of the suite:
 *
 *   DURABLE_HARNESS=1 DURABLE_MYSQL_URL=mysql://root:root@127.0.0.1:3306 \
 *   DURABLE_REDIS_URL=redis://127.0.0.1:6379 npx vitest run test/harness/fan-throughput
 *
 * Knobs: H_FAN (20000), H_PODS (6), H_WORKERS (6), H_WORKER_CONCURRENCY (8), H_RESULT_CONCURRENCY (4),
 * H_POOL (10).
 */
const ON = process.env.DURABLE_HARNESS === '1';
const MYSQL = process.env.DURABLE_MYSQL_URL;
const REDIS = process.env.DURABLE_REDIS_URL ?? process.env.REDIS_URL;
const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const LINE = 'harness.line';
const line = (() => {}) as unknown as StepRef<number, number>;
(line as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = LINE;

interface Counts {
  barrier: number;
  batches: number[];
  getCheckpoint: number;
  getCheckpoints: number;
  saveCheckpoint: number;
}

function counted(store: StateStore, counts: Counts): StateStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === 'countCheckpoints') {
        return (...args: unknown[]) => {
          counts.barrier += 1;
          return value.apply(target, args);
        };
      }
      if (prop === 'saveCheckpointsIfPending') {
        return (cps: StepCheckpoint[]) => {
          counts.batches.push(cps.length);
          return value.call(target, cps);
        };
      }
      if (prop === 'settleCheckpointsIfPending') {
        return (settlements: StepSettlement[]) => {
          counts.batches.push(settlements.length);
          return value.call(target, settlements);
        };
      }
      if (prop === 'saveCheckpointIfPending') {
        return (cp: StepCheckpoint) => {
          counts.batches.push(1);
          return value.call(target, cp);
        };
      }
      if (prop === 'getCheckpoint' || prop === 'getCheckpoints' || prop === 'saveCheckpoint') {
        return (...args: unknown[]) => {
          counts[prop] += 1;
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  }) as StateStore;
}

describe.skipIf(!ON || !MYSQL || !REDIS)('step fan throughput harness (MySQL + BullMQ)', () => {
  it(
    'runs a wide step fan across several instances and reports what it cost',
    async () => {
      const fan = num('H_FAN', 20_000);
      const pods = num('H_PODS', 6);
      const workers = num('H_WORKERS', 6);
      const workerConcurrency = num('H_WORKER_CONCURRENCY', 8);
      const resultConcurrency = num('H_RESULT_CONCURRENCY', 4);
      const pool = num('H_POOL', 10);
      const prefix = uniqueRedisPrefix('durable-harness');
      const schemaDb = await makeIsolatedMysqlDb(MYSQL as string);
      await createDurableTables(schemaDb);
      const database = schemaDb.databaseName;
      const counts: Counts = {
        barrier: 0,
        batches: [],
        getCheckpoint: 0,
        getCheckpoints: 0,
        saveCheckpoint: 0,
      };
      const closers: Array<() => Promise<unknown>> = [];
      let turns = 0;
      let lastStepAt = 0;
      let dispatchedAt = 0;
      const engines: WorkflowEngine[] = [];
      try {
        for (let w = 0; w < workers; w += 1) {
          const worker = new BullMQTransport({
            deps: await createBullMQDeps(REDIS as string, workerConcurrency),
            prefix,
            concurrency: workerConcurrency,
          });
          closers.push(() => worker.close());
          worker.handle(LINE, async (input) => {
            lastStepAt = Date.now();
            return (input as number) * 2;
          });
        }
        for (let p = 0; p < pods; p += 1) {
          const db = makeMysqlDb(MYSQL as string, database, pool);
          closers.push(() => db.manager.closeAll());
          const transport = new BullMQTransport({
            deps: await createBullMQDeps(REDIS as string),
            prefix,
            resultConcurrency,
          });
          closers.push(() => transport.close());
          const engine = new WorkflowEngine({
            store: counted(new LucidStateStore(db), counts),
            transport,
            instanceId: `pod-${p}`,
          });
          engine.register('fan', '1', async (ctx) => {
            turns += 1;
            const out = await ctx.all(
              line,
              Array.from({ length: fan }, (_, i) => i),
            );
            return out.length;
          });
          engine.subscribe((e) => {
            if (e.type === 'run.suspended' && e.runId === 'fan' && dispatchedAt === 0) {
              dispatchedAt = Date.now();
            }
          });
          engines.push(engine);
        }
        const startedAt = Date.now();
        await engines[0]?.start('fan', {}, 'fan');
        // The run finishes on whichever instance takes its last wake: poll the store.
        const reader = new LucidStateStore(schemaDb);
        const deadline = Date.now() + 30 * 60_000;
        let done = await reader.getRun('fan');
        while (done?.status !== 'completed' && done?.status !== 'failed' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25));
          done = await reader.getRun('fan');
        }
        const finishedAt = Date.now();
        expect(done?.output).toBe(fan);
        const sizes = counts.batches;
        const report = {
          fan,
          pods,
          totalMs: finishedAt - startedAt,
          dispatchingTurnMs: dispatchedAt - startedAt,
          appliedAfterLastStepMs: finishedAt - lastStepAt,
          batches: sizes.length,
          meanBatch: Math.round(sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length)),
          barrierCounts: counts.barrier,
          getCheckpoint: counts.getCheckpoint,
          getCheckpoints: counts.getCheckpoints,
          saveCheckpoint: counts.saveCheckpoint,
          parentTurns: turns,
        };
        console.log(`[fan-throughput] ${JSON.stringify(report)}`);
        process.stdout.write(`[fan-throughput] ${JSON.stringify(report)}\n`);
      } finally {
        await Promise.all(engines.map((e) => e.drain(10_000).catch(() => undefined)));
        for (const close of closers.reverse()) await close().catch(() => undefined);
        const deps = await createBullMQDeps(REDIS as string);
        const redis = deps.makeRedis() as unknown as Parameters<typeof deleteRedisKeys>[0] & {
          quit(): Promise<unknown>;
        };
        await deleteRedisKeys(redis, prefix);
        await redis.quit();
        await schemaDb.manager.closeAll();
      }
    },
    40 * 60_000,
  );
});
