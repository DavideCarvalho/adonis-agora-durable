import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Adapter } from '@adonisjs/queue/types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  EngineEvent,
  RemoteTask,
  RunReply,
  StepResult,
  TenantEvent,
  WorkflowDecision,
} from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { postgresTestSchemaPrefix } from '../../../src/transports/db-helpers.js';
import { QueueTransport, type QueueTransportOptions } from '../../../src/transports/queue.js';
import {
  inboxKey,
  runRepliesQueue,
  tenantEventsQueue,
  tenantSubscriberKey,
} from '../../../src/transports/queue-remote.js';
import { MemoryWorkerKeys } from '../../../src/transports/worker-keys.js';
import { backendUrl } from '../../support/backends.js';

/**
 * The QueueTransport against the REAL adapters of whichever `@adonisjs/queue` is installed (0.6 or
 * 0.7 — the peer range accepts both, and `scripts/test-queue-compat.sh` runs this file on each). The
 * mock adapter can only model a contract; these prove the transport finalizes real claims: after a
 * round-trip NOTHING may stay `active` — on 0.7 a job finalized with the wrong handle stays active and
 * the stalled sweep re-runs it (a double-executed step on every dispatch).
 *
 * - Knex on SQLite (better-sqlite3): always runs, no infrastructure.
 * - Knex on Postgres (pg): runs when DURABLE_PG_URL is set, in a schema of its own.
 * - Redis: runs when REDIS_URL is set (e.g. `redis://127.0.0.1:6379`).
 *
 * Without the URL a backend self-skips locally; in CI a missing one fails the file (see
 * `test/support/backends.ts`). One spec file per backend (`queue-real-adapters.<backend>.spec.ts`).
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
const PG_URL = process.env.DURABLE_PG_URL;

const task = (name: string): RemoteTask => ({
  runId: 'r1',
  seq: 1,
  name,
  stepId: 'r1:1',
  group: sanitizeQueueToken(name),
  input: { hello: 'world', at: '2026-10-18T00:00:00.000Z' },
  attempt: 1,
});

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 20_000): Promise<void> {
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

/** The installed Knex driver over `k`, with its jobs table created. */
async function knexAdapter(k: unknown): Promise<AnyAdapterFactory> {
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
  await new Schema(k).createJobsTable('queue_jobs');
  return driver.knex(k, 'queue_jobs');
}

interface Backend {
  name: string;
  enabled: boolean;
  setup(): Promise<AnyAdapterFactory>;
  teardown(): Promise<void>;
}

let dir: string | undefined;
let knexInstance: KnexLike | undefined;
let pgKnex: (KnexLike & { raw(sql: string): Promise<unknown> }) | undefined;
let pgAdmin: (KnexLike & { raw(sql: string): Promise<unknown> }) | undefined;
const pgSchema = `${postgresTestSchemaPrefix()}queue_${process.pid}_${randomUUID().slice(0, 8)}`;
let redisClient:
  | {
      quit(): Promise<unknown>;
      keys(p: string): Promise<string[]>;
      del(...k: string[]): Promise<unknown>;
    }
  | undefined;
/** The file's key prefix; each test runs under its own extension of it (see `describeBackend`). */
const basePrefix = `durable-it-${randomUUID().slice(0, 8)}`;

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
      return knexAdapter(knexInstance);
    },
    async teardown() {
      await knexInstance?.destroy();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: 'knex (postgres)',
    enabled: Boolean(PG_URL),
    async setup() {
      type PgKnex = NonNullable<typeof pgKnex>;
      const knexMod = requireFromBoringnode('knex') as (config: unknown) => PgKnex;
      // A schema of its own, so parallel files (and the db transport's schemas) never share a table.
      pgAdmin = knexMod({ client: 'pg', connection: PG_URL, pool: { min: 0, max: 1 } });
      await pgAdmin.raw(`create schema "${pgSchema}"`);
      pgKnex = knexMod({
        client: 'pg',
        connection: PG_URL,
        searchPath: [pgSchema],
        pool: { min: 0, max: 3 },
      });
      return knexAdapter(pgKnex);
    },
    async teardown() {
      await pgKnex?.destroy();
      await pgAdmin?.raw(`drop schema if exists "${pgSchema}" cascade`);
      await pgAdmin?.destroy();
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
      const keys = await redisClient.keys(`*${basePrefix}*`);
      if (keys.length > 0) await redisClient.del(...keys);
      await redisClient.quit();
    },
  },
];

/**
 * The suite on one backend. Each backend has its own spec file (`queue-real-adapters.<backend>.spec.ts`)
 * so vitest runs the three in parallel processes instead of one after the other.
 */
export function queueRealAdapterSuite(name: Backend['name']): void {
  const backend = backends.find((b) => b.name === name);
  if (!backend) throw new Error(`unknown backend ${name}`);
  // Without its URL a backend skips locally, and fails the file in CI.
  if (name === 'redis') backendUrl('REDIS_URL');
  if (name === 'knex (postgres)') backendUrl('DURABLE_PG_URL');
  describeBackend(backend);
}

function describeBackend(backend: Backend): void {
  describe(`QueueTransport on the real ${backend.name} adapter (@boringnode/queue ${boringnodeVersion})`, () => {
    let factory: AnyAdapterFactory;
    const transports: QueueTransport[] = [];
    let probe: Adapter;
    // A prefix — so a results queue, decisions queue, inboxes — of each test's own. Shared across the
    // file, a result published late by one test (a re-run it just failed on) was consumed by the
    // next test's engine as one of its own.
    let prefix = basePrefix;
    beforeEach(() => {
      prefix = `${basePrefix}-${randomUUID().slice(0, 6)}`;
    });

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

    /**
     * Close every transport of the test before probing its claims: close() waits for a job still in a
     * handler or finalizing, so the probe reads settled claims rather than a `completeJob` in flight.
     * (A fixed beat was not enough on a loaded machine — and the probe RECOVERS what it finds active,
     * so a probe that raced a finalize also re-delivered the job.)
     */
    const closeAll = async (): Promise<void> => {
      await Promise.all(transports.splice(0).map((t) => t.close()));
    };

    const make = (opts: Partial<QueueTransportOptions> = {}): QueueTransport => {
      const t = new QueueTransport({
        adapter: factory,
        prefix,
        pollIntervalMs: 10,
        stalledCheckIntervalMs: 0,
        ...opts,
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
        await closeAll();
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
        await closeAll();
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
            // Renewal runs every half threshold; 3s tolerates the event-loop stalls of a loaded CI
            // runner (1.5s was seen to lapse), while the 9s step still outlives the threshold 3× —
            // without renewal it is re-run.
            stalledThresholdMs: 3_000,
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
          await new Promise((r) => setTimeout(r, 9_000));
          return 'done';
        });

        await engine.dispatch(task(name));
        await until(() => results.length === 1, 30_000);
        expect(runs).toBe(1);
        expect(results[0]).toMatchObject({ status: 'completed', output: 'done' });
        await closeAll();
        expect(await activeJobs(probe, `${prefix}:tasks:${sanitizeQueueToken(name)}`)).toBe(0);
      },
      45_000,
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
        // The backlog first, and each step holds its slot until three run together (bounded): the
        // peak then depends on the slot loop, not on dispatches overlapping 150ms sleeps.
        for (let seq = 1; seq <= 6; seq += 1) {
          await engine.dispatch({ ...task(name), seq, stepId: `r1:${seq}` });
        }
        let running = 0;
        let peak = 0;
        let done = 0;
        worker.handle(name, async () => {
          running += 1;
          peak = Math.max(peak, running);
          await until(() => running >= Math.min(3, 6 - done), 3000).catch(() => undefined);
          await new Promise((r) => setTimeout(r, 150));
          running -= 1;
          done += 1;
          return 'ok';
        });

        await until(() => results.length === 6, 30_000);
        expect(peak).toBe(3);
        await closeAll();
        expect(await activeJobs(probe, `${prefix}:tasks:${sanitizeQueueToken(name)}`)).toBe(0);
      },
    );

    it.skipIf(!backend.enabled)(
      'two workers × 4 slots share 40 jobs and never run one twice',
      async () => {
        const name = `fleet-${randomUUID().slice(0, 6)}`;
        const engine = make();
        const results: StepResult[] = [];
        engine.onResult(async (r) => void results.push(r));
        const runs = new Map<number, number>();
        const ranOn = new Set<string>();
        for (const id of ['w1', 'w2']) {
          const worker = new QueueTransport({
            adapter: factory,
            prefix,
            instanceId: `${id}-${name}`,
            pollIntervalMs: 20,
            // Sweeping often: a job handed to two workers would show up as a second run. The
            // threshold leaves headroom over the one-connection SQLite pool, which every poll of
            // three transports shares — on a loaded machine a finalize can queue behind them for
            // longer than a short threshold (3s was seen to), and the sweep then re-delivers a job
            // that DID finish (claim renewal under a short threshold is pinned by the long-step
            // test above).
            stalledCheckIntervalMs: 50,
            stalledThresholdMs: 10_000,
            concurrency: 4,
          });
          transports.push(worker);
          worker.handle(name, async (input) => {
            const { seq } = input as { seq: number };
            runs.set(seq, (runs.get(seq) ?? 0) + 1);
            ranOn.add(id);
            await new Promise((r) => setTimeout(r, 60));
            return seq;
          });
        }
        for (let seq = 1; seq <= 40; seq += 1) {
          await engine.dispatch({ ...task(name), seq, stepId: `r1:${seq}`, input: { seq } });
        }
        await until(() => results.length >= 40, 20_000);
        // A would-be duplicate gets time to land.
        await new Promise((r) => setTimeout(r, 300));
        expect(results).toHaveLength(40);
        expect(runs.size).toBe(40);
        expect([...runs.values()].every((n) => n === 1)).toBe(true);
        expect(ranOn).toEqual(new Set(['w1', 'w2']));
        await closeAll();
        expect(await activeJobs(probe, `${prefix}:tasks:${sanitizeQueueToken(name)}`)).toBe(0);
        expect(await activeJobs(probe, `${prefix}:results`)).toBe(0);
      },
      30_000,
    );

    it.skipIf(!backend.enabled)(
      "recovers a dead worker's claim: the task runs once elsewhere and nothing stays active",
      async () => {
        const name = `dead-${randomUUID().slice(0, 6)}`;
        const tasksQueue = `${prefix}:tasks:${sanitizeQueueToken(name)}`;
        const engine = make();
        const results: StepResult[] = [];
        engine.onResult(async (r) => void results.push(r));
        await engine.dispatch(task(name));
        // A worker claims the task and dies on it: never finalizes, never renews.
        expect(await probe.popFrom(tasksQueue)).not.toBeNull();

        const survivor = new QueueTransport({
          adapter: factory,
          prefix,
          pollIntervalMs: 10,
          stalledCheckIntervalMs: 50,
          stalledThresholdMs: 200,
          maxStalledCount: 3,
        });
        transports.push(survivor);
        let runs = 0;
        survivor.handle(name, async () => {
          runs += 1;
          return 'recovered';
        });

        await until(() => results.length === 1, 10_000);
        expect(results[0]).toMatchObject({ status: 'completed', output: 'recovered' });
        await new Promise((r) => setTimeout(r, 100));
        expect(runs).toBe(1);
        await closeAll();
        expect(await activeJobs(probe, tasksQueue)).toBe(0);
        expect(await activeJobs(probe, `${prefix}:results`)).toBe(0);
      },
      20_000,
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
          // Shaped so a loaded machine cannot starve the growth signal: steps long next to event-loop
          // jitter (steady latency), and a tick that outlasts a step (never two ticks without a
          // completion, which reads as a stall — backpressure, which only ever sheds).
          concurrency: { mode: 'adaptive', min: 1, max: 4, start: 1, tickMs: 300 },
        });
        transports.push(worker);
        const results: StepResult[] = [];
        engine.onResult(async (r) => void results.push(r));
        let running = 0;
        let peak = 0;
        worker.handle(name, async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 200));
          running -= 1;
          return 'ok';
        });
        for (let seq = 1; seq <= 20; seq += 1) {
          await engine.dispatch({ ...task(name), seq, stepId: `r1:${seq}` });
        }
        await until(() => results.length === 20, 60_000);
        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThanOrEqual(4);
        await closeAll();
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
        await closeAll();
        expect(await activeJobs(probe, tasksQueue)).toBe(0);
      },
    );
    it.skipIf(!backend.enabled)(
      'routes run replies to each requester only, and finalizes every claim',
      async () => {
        const tag = randomUUID().slice(0, 6);
        const cp = make({ instanceId: `cp-${tag}` });
        const a = make({ instanceId: `a-${tag}` });
        const b = make({ instanceId: `b-${tag}` });
        cp.onRunRequest(async (msg) => {
          await cp.publishRunReply({
            requestId: msg.requestId,
            result: { ok: true, data: msg.requestId },
          });
        });
        const gotA: RunReply[] = [];
        const gotB: RunReply[] = [];
        a.onRunReply((r) => gotA.push(r));
        b.onRunReply((r) => gotB.push(r));
        for (let i = 0; i < 3; i += 1) {
          await a.dispatchRunRequest({
            requestId: `a${i}-${tag}`,
            tenant: 'acme',
            body: { kind: 'workerHealth' },
          });
          await b.dispatchRunRequest({
            requestId: `b${i}-${tag}`,
            tenant: 'acme',
            body: { kind: 'workerHealth' },
          });
        }
        await until(() => gotA.length === 3 && gotB.length === 3);
        expect(gotA.map((r) => r.requestId).sort()).toEqual([0, 1, 2].map((i) => `a${i}-${tag}`));
        expect(gotB.map((r) => r.requestId).sort()).toEqual([0, 1, 2].map((i) => `b${i}-${tag}`));
        await closeAll();
        expect(await activeJobs(probe, `${prefix}:run-request`)).toBe(0);
        expect(await activeJobs(probe, runRepliesQueue(prefix, `a-${tag}`))).toBe(0);
        expect(await activeJobs(probe, runRepliesQueue(prefix, `b-${tag}`))).toBe(0);
      },
    );

    it.skipIf(!backend.enabled)(
      'fans a tenant event out to every subscriber of that tenant; a dead one is drained',
      async () => {
        const tag = randomUUID().slice(0, 6);
        const keys = new MemoryWorkerKeys();
        // Only the control plane has a key store; the subscribers are store-less.
        const cp = make({
          workerKeys: keys,
          tenantSubscribersCacheMs: 0,
          inboxTtlMs: 200,
          inboxSweepIntervalMs: 50,
        });
        cp.onRunRequest(async () => {}); // the responder's consumers start the subscription recorder
        const s1 = make({ instanceId: `s1-${tag}` });
        const s2 = make({ instanceId: `s2-${tag}` });
        const other = make({ instanceId: `o-${tag}` });
        const got1: TenantEvent[] = [];
        const got2: TenantEvent[] = [];
        const gotOther: TenantEvent[] = [];
        s1.onTenantEvent(`acme-${tag}`, (e) => got1.push(e));
        s2.onTenantEvent(`acme-${tag}`, (e) => got2.push(e));
        other.onTenantEvent(`globex-${tag}`, (e) => gotOther.push(e));
        const recorded = async (tenant: string, instanceId: string) =>
          (await keys.live(Date.now())).some(
            (k) => k.key === tenantSubscriberKey(prefix, tenant, instanceId),
          );
        await until(
          async () =>
            (await recorded(`acme-${tag}`, `s1-${tag}`)) &&
            (await recorded(`acme-${tag}`, `s2-${tag}`)) &&
            (await recorded(`globex-${tag}`, `o-${tag}`)),
        );

        // A subscriber that crashed: advertised, never consuming. Kept live until the publish is seen
        // in its inbox, then killed — its keys removed — so the janitor sees it dead and drains the
        // inbox. (Keys that merely expired on their own raced the check: on a loaded machine the
        // janitor could drain the inbox before the test looked at it.)
        const ghost = `ghost-${tag}`;
        const value = JSON.stringify({ instanceId: ghost });
        const ghostKeys = [
          tenantSubscriberKey(prefix, `acme-${tag}`, ghost),
          inboxKey(prefix, ghost),
        ];
        for (const key of ghostKeys) await keys.put(key, value, Date.now() + 60_000);
        const evt = {
          type: 'run.completed',
          runId: 'r1',
          at: new Date(0),
        } as unknown as EngineEvent;
        await cp.publishTenantEvent({ tenant: `acme-${tag}`, event: evt });
        await until(() => got1.length === 1 && got2.length === 1);
        expect(gotOther).toEqual([]);
        expect(got1[0]?.event.runId).toBe('r1');
        expect(await probe.sizeOf(tenantEventsQueue(prefix, ghost))).toBe(1);
        // The ghost dies; the janitor drains what it was sent.
        await keys.remove(ghostKeys);
        await until(async () => (await probe.sizeOf(tenantEventsQueue(prefix, ghost))) === 0);
        await closeAll();
        expect(await activeJobs(probe, tenantEventsQueue(prefix, ghost))).toBe(0);
      },
    );

    it.skipIf(!backend.enabled)(
      'round-trips a workflow turn (task → decision) and finalizes every claim',
      async () => {
        const name = `wf-${randomUUID().slice(0, 6)}`;
        const engine = make();
        const worker = make();
        const decisions: WorkflowDecision[] = [];
        engine.onDecision(async (d) => void decisions.push(d));
        worker.handleWorkflow(name, async (t) => ({
          taskId: t.taskId,
          runId: t.runId,
          status: 'completed',
          commands: [],
          output: t.input,
        }));
        await engine.dispatchWorkflowTask({
          taskId: 't1',
          runId: 'r1',
          workflow: name,
          workflowVersion: '1',
          input: { n: 1 },
          history: [],
          group: sanitizeQueueToken(name),
          attempt: 1,
        });
        await until(() => decisions.length === 1);
        expect(decisions[0]).toMatchObject({ taskId: 't1', status: 'completed', output: { n: 1 } });
        await closeAll();
        expect(await activeJobs(probe, `${prefix}:tasks:${sanitizeQueueToken(name)}`)).toBe(0);
        expect(await activeJobs(probe, `${prefix}:decisions`)).toBe(0);
      },
    );
  });
}
