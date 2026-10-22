import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Adapter } from '@adonisjs/queue/types';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RemoteTask, StepResult } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MemoryWorkerKeys } from '../../../src/transports/worker-keys.js';

/**
 * The QueueTransport against the REAL adapters of whichever `@adonisjs/queue` is installed (0.6 or
 * 0.7 — the peer range accepts both, and `scripts/test-queue-compat.sh` runs this file on each). The
 * mock adapter can only model a contract; these prove the transport finalizes real claims: after a
 * round-trip NOTHING may stay `active` — on 0.7 a job finalized with the wrong handle stays active and
 * the stalled sweep re-runs it (a double-executed step on every dispatch).
 *
 * - Knex on SQLite (better-sqlite3): always runs, no infrastructure.
 * - Redis: runs when REDIS_URL is set (e.g. `redis://127.0.0.1:6379`), self-skips otherwise.
 */

// Resolve `@boringnode/queue` (and its knex/ioredis) THROUGH the installed `@adonisjs/queue`, so the
// drivers are exactly the ones an app on that version gets.
const requireFromHere = createRequire(import.meta.url);
const requireFromQueue = createRequire(requireFromHere.resolve('@adonisjs/queue'));
const knexDriverPath = requireFromQueue.resolve('@boringnode/queue/drivers/knex_adapter');
const requireFromBoringnode = createRequire(knexDriverPath);
// `package.json` is not in the package's `exports`: read it next to the resolved build.
const boringnodeVersion = (
  JSON.parse(
    readFileSync(join(knexDriverPath.split('/build/')[0] as string, 'package.json'), 'utf8'),
  ) as { version: string }
).version;

// `@boringnode/queue` >= 0.8 hands a job that stalled too often back to the caller to fail; 0.6 deletes
// it inside `recoverStalledJobs`, so there is nothing to bridge there.
const handsBackExceeded = Number(boringnodeVersion.split('.')[1]) >= 8;

type AnyAdapterFactory = () => Adapter;
interface KnexLike {
  destroy(): Promise<void>;
}
interface SchemaServiceLike {
  createJobsTable(table?: string): Promise<void>;
}

async function importFromQueue<T>(specifier: string): Promise<T> {
  return (await import(pathToFileURL(requireFromQueue.resolve(specifier)).href)) as T;
}

const REDIS_URL = process.env.REDIS_URL;

const task = (name: string): RemoteTask => ({
  runId: 'r1',
  seq: 1,
  name,
  stepId: 'r1:1',
  group: sanitizeQueueToken(name),
  input: { hello: 'world', at: '2026-10-18T00:00:00.000Z' },
  attempt: 1,
});

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Nothing claimed and unfinalized: a sweep with a 0ms threshold reclaims every `active` job. */
async function activeJobs(adapter: Adapter, queue: string): Promise<number> {
  const outcome = (await (adapter.recoverStalledJobs as (...args: unknown[]) => Promise<unknown>)(
    queue,
    0,
    100,
    100,
  )) as number | { recovered: number; exceeded: unknown[] };
  return typeof outcome === 'number' ? outcome : outcome.recovered + outcome.exceeded.length;
}

interface Backend {
  name: string;
  enabled: boolean;
  setup(): Promise<AnyAdapterFactory>;
  teardown(): Promise<void>;
}

let dir: string | undefined;
let knexInstance: KnexLike | undefined;
let redisClient:
  | {
      quit(): Promise<unknown>;
      keys(p: string): Promise<string[]>;
      del(...k: string[]): Promise<unknown>;
    }
  | undefined;
const prefix = `durable-it-${randomUUID().slice(0, 8)}`;

const backends: Backend[] = [
  {
    name: 'knex (sqlite)',
    enabled: true,
    async setup() {
      dir = mkdtempSync(join(tmpdir(), 'durable-queue-it-'));
      const knexMod = requireFromBoringnode('knex') as (config: unknown) => KnexLike;
      knexInstance = knexMod({
        client: 'better-sqlite3',
        connection: { filename: join(dir, 'queue.sqlite') },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 },
      });
      const driver = await importFromQueue<{
        knex: (k: unknown, table?: string) => AnyAdapterFactory;
        KnexQueueSchemaService?: new (k: unknown) => SchemaServiceLike;
      }>('@boringnode/queue/drivers/knex_adapter');
      // 0.9 ships the schema service with the driver; 0.6 exports `QueueSchemaService` from the root.
      const Schema =
        driver.KnexQueueSchemaService ??
        (
          await importFromQueue<{ QueueSchemaService: new (k: unknown) => SchemaServiceLike }>(
            '@boringnode/queue',
          )
        ).QueueSchemaService;
      await new Schema(knexInstance).createJobsTable('queue_jobs');
      return driver.knex(knexInstance, 'queue_jobs');
    },
    async teardown() {
      await knexInstance?.destroy();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: 'redis',
    enabled: Boolean(REDIS_URL),
    async setup() {
      const IORedis = requireFromBoringnode('ioredis') as {
        Redis: new (url: string) => NonNullable<typeof redisClient>;
      };
      redisClient = new IORedis.Redis(REDIS_URL as string);
      const driver = await importFromQueue<{ redis: (c: unknown) => AnyAdapterFactory }>(
        '@boringnode/queue/drivers/redis_adapter',
      );
      return driver.redis(redisClient);
    },
    async teardown() {
      if (!redisClient) return;
      const keys = await redisClient.keys(`*${prefix}*`);
      if (keys.length > 0) await redisClient.del(...keys);
      await redisClient.quit();
    },
  },
];

describe.each(backends)(
  `QueueTransport on the real $name adapter (@boringnode/queue ${boringnodeVersion})`,
  (backend) => {
    let factory: AnyAdapterFactory;
    const transports: QueueTransport[] = [];
    let probe: Adapter;

    beforeAll(async () => {
      if (!backend.enabled) return;
      factory = await backend.setup();
      probe = factory();
      probe.setWorkerId('probe');
    });
    afterEach(async () => {
      await Promise.all(transports.splice(0).map((t) => t.close()));
    });
    afterAll(async () => {
      if (!backend.enabled) return;
      await backend.teardown();
    });

    const make = (): QueueTransport => {
      const t = new QueueTransport({
        adapter: factory,
        prefix,
        pollIntervalMs: 10,
        stalledCheckIntervalMs: 0,
      });
      transports.push(t);
      return t;
    };

    it.skipIf(!backend.enabled)(
      'round-trips a step and finalizes every claim (nothing left active)',
      async () => {
        const name = `echo-${randomUUID().slice(0, 6)}`;
        const engine = make();
        const worker = make();
        const results: StepResult[] = [];
        engine.onResult(async (r) => void results.push(r));
        worker.handle(name, async (input) => ({ echoed: input }));

        await engine.dispatch(task(name));
        await until(() => results.length === 1);
        expect(results[0]).toMatchObject({
          status: 'completed',
          output: { echoed: { hello: 'world', at: '2026-10-18T00:00:00.000Z' } },
        });
        // Give the result loop's completeJob a beat, then: no claim left behind on either queue.
        await new Promise((r) => setTimeout(r, 50));
        expect(await activeJobs(probe, `${prefix}:tasks:${sanitizeQueueToken(name)}`)).toBe(0);
        expect(await activeJobs(probe, `${prefix}:results`)).toBe(0);
      },
    );

    it.skipIf(!backend.enabled)(
      'a throwing result handler hands the job back; it is redelivered and then finalized',
      async () => {
        const name = `retry-${randomUUID().slice(0, 6)}`;
        const engine = make();
        const worker = make();
        worker.handle(name, async () => 'ok');
        let calls = 0;
        const settled: StepResult[] = [];
        engine.onResult(async (r) => {
          calls += 1;
          if (calls === 1) throw new Error('store down');
          settled.push(r);
        });
        await engine.dispatch(task(name));
        await until(() => settled.length === 1);
        expect(calls).toBe(2);
        await new Promise((r) => setTimeout(r, 50));
        expect(await activeJobs(probe, `${prefix}:results`)).toBe(0);
      },
    );

    it.skipIf(!backend.enabled)(
      'renews the claim of a step longer than the stalled threshold, so it runs exactly once',
      async () => {
        const name = `slow-${randomUUID().slice(0, 6)}`;
        const reclaiming = (): QueueTransport => {
          const t = new QueueTransport({
            adapter: factory,
            prefix,
            pollIntervalMs: 10,
            stalledCheckIntervalMs: 50,
            stalledThresholdMs: 300,
          });
          transports.push(t);
          return t;
        };
        const engine = reclaiming();
        const worker = reclaiming();
        const results: StepResult[] = [];
        engine.onResult(async (r) => void results.push(r));
        let runs = 0;
        worker.handle(name, async () => {
          runs += 1;
          await new Promise((r) => setTimeout(r, 1_200));
          return 'done';
        });

        await engine.dispatch(task(name));
        await until(() => results.length === 1, 10_000);
        expect(runs).toBe(1);
        expect(results[0]).toMatchObject({ status: 'completed', output: 'done' });
        await new Promise((r) => setTimeout(r, 50));
        expect(await activeJobs(probe, `${prefix}:tasks:${sanitizeQueueToken(name)}`)).toBe(0);
      },
    );

    it.skipIf(!backend.enabled)(
      'runs `concurrency` jobs of one step at once and finalizes every claim',
      async () => {
        const name = `par-${randomUUID().slice(0, 6)}`;
        const engine = make();
        const worker = new QueueTransport({
          adapter: factory,
          prefix,
          pollIntervalMs: 10,
          stalledCheckIntervalMs: 0,
          concurrency: 3,
        });
        transports.push(worker);
        const results: StepResult[] = [];
        engine.onResult(async (r) => void results.push(r));
        let running = 0;
        let peak = 0;
        worker.handle(name, async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 150));
          running -= 1;
          return 'ok';
        });

        for (let seq = 1; seq <= 6; seq += 1) {
          await engine.dispatch({ ...task(name), seq, stepId: `r1:${seq}` });
        }
        await until(() => results.length === 6, 10_000);
        expect(peak).toBe(3);
        await new Promise((r) => setTimeout(r, 50));
        expect(await activeJobs(probe, `${prefix}:tasks:${sanitizeQueueToken(name)}`)).toBe(0);
      },
    );

    it.skipIf(!backend.enabled)(
      'groupHealth reports the pending backlog and the live worker with its status',
      async () => {
        const name = `health-${randomUUID().slice(0, 6)}`;
        const token = sanitizeQueueToken(name);
        const keys = new MemoryWorkerKeys();
        const withKeys = (extra: Partial<ConstructorParameters<typeof QueueTransport>[0]> = {}) => {
          const t = new QueueTransport({
            adapter: factory,
            prefix,
            pollIntervalMs: 10,
            stalledCheckIntervalMs: 0,
            workerKeys: keys,
            workerKeysCacheMs: 0,
            ...extra,
          });
          transports.push(t);
          return t;
        };
        const engine = withKeys();
        const results: StepResult[] = [];
        engine.onResult(async (r) => void results.push(r));
        for (let seq = 1; seq <= 3; seq += 1) {
          await engine.dispatch({ ...task(name), seq, stepId: `r1:${seq}` });
        }
        expect(await engine.groupHealth?.(token)).toEqual({
          group: token,
          depth: 3,
          liveWorkers: [],
        });

        let release: () => void = () => {};
        const gate = new Promise<void>((r) => {
          release = r;
        });
        const worker = withKeys({ instanceId: 'w1', workerHeartbeatIntervalMs: 20 });
        worker.handle(name, async () => {
          await gate;
          return 'ok';
        });
        await until(async () => {
          const h = await engine.groupHealth?.(token);
          return h?.depth === 2 && h.liveWorkers[0]?.status?.inFlight === 1;
        });
        expect((await engine.groupHealth?.(token))?.liveWorkers[0]).toMatchObject({
          instanceId: 'w1',
          status: { concurrency: { mode: 'fixed', limit: 1 } },
        });
        release();
        await until(() => results.length === 3, 10_000);
        expect((await engine.groupHealth?.(token))?.depth).toBe(0);
      },
    );

    it.skipIf(!backend.enabled)(
      'adaptive concurrency raises the slot count on a saturated backlog',
      async () => {
        const name = `adapt-${randomUUID().slice(0, 6)}`;
        const engine = make();
        const worker = new QueueTransport({
          adapter: factory,
          prefix,
          pollIntervalMs: 5,
          stalledCheckIntervalMs: 0,
          concurrency: { mode: 'adaptive', min: 1, max: 4, start: 1, tickMs: 20 },
        });
        transports.push(worker);
        const results: StepResult[] = [];
        engine.onResult(async (r) => void results.push(r));
        let running = 0;
        let peak = 0;
        worker.handle(name, async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 40));
          running -= 1;
          return 'ok';
        });
        for (let seq = 1; seq <= 30; seq += 1) {
          await engine.dispatch({ ...task(name), seq, stepId: `r1:${seq}` });
        }
        await until(() => results.length === 30, 15_000);
        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThanOrEqual(4);
        await new Promise((r) => setTimeout(r, 50));
        expect(await activeJobs(probe, `${prefix}:tasks:${sanitizeQueueToken(name)}`)).toBe(0);
      },
    );

    it.skipIf(!backend.enabled || !handsBackExceeded)(
      'a task that stalled past maxStalledCount is failed and bridged into a failed StepResult',
      async () => {
        const name = `poison-${randomUUID().slice(0, 6)}`;
        const tasksQueue = `${prefix}:tasks:${sanitizeQueueToken(name)}`;
        const engine = make();
        const results: StepResult[] = [];
        engine.onResult(async (r) => void results.push(r));
        await engine.dispatch(task(name));
        // A worker claims the task and dies on it (never finalizes, never renews).
        expect(await probe.popFrom(tasksQueue)).not.toBeNull();

        const worker = new QueueTransport({
          adapter: factory,
          prefix,
          pollIntervalMs: 10,
          stalledCheckIntervalMs: 50,
          stalledThresholdMs: 50,
          maxStalledCount: 0,
        });
        transports.push(worker);
        let runs = 0;
        worker.handle(name, async () => {
          runs += 1;
          return 'ok';
        });

        await until(() => results.length === 1, 10_000);
        expect(results[0]).toEqual({
          runId: 'r1',
          seq: 1,
          stepId: 'r1:1',
          status: 'failed',
          error: {
            message: 'remote step worker failed: stalled more than 0 times',
            retryable: true,
          },
        });
        expect(runs).toBe(0);
        expect(await activeJobs(probe, tasksQueue)).toBe(0);
      },
    );
  },
);
