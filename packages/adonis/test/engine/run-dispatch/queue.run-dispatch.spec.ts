import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Adapter } from '@adonisjs/queue/types';
import { afterAll, beforeAll, describe } from 'vitest';
import { runRunDispatchContract } from '../../../src/testing-kit/conformance.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { backendUrl } from '../../support/backends.js';

// The run queue of the `@adonisjs/queue` transport (`${P}:runs`) on the REAL adapters of the installed
// `@adonisjs/queue`: Knex on SQLite always, Redis when REDIS_URL is set (required in CI).
const requireFromHere = createRequire(import.meta.url);
const requireFromQueue = createRequire(requireFromHere.resolve('@adonisjs/queue'));
const knexDriverPath = requireFromQueue.resolve('@boringnode/queue/drivers/knex_adapter');
const requireFromBoringnode = createRequire(knexDriverPath);
const importFromQueue = async <T>(specifier: string): Promise<T> =>
  (await import(pathToFileURL(requireFromQueue.resolve(specifier)).href)) as T;

type AdapterFactory = () => Adapter;
const REDIS_URL = backendUrl('REDIS_URL');

interface Backend {
  name: string;
  enabled: boolean;
  setup(): Promise<AdapterFactory>;
  teardown(): Promise<void>;
}

let dir: string | undefined;
let knex: { destroy(): Promise<void> } | undefined;
let redis:
  | {
      quit(): Promise<unknown>;
      keys(p: string): Promise<string[]>;
      del(...k: string[]): Promise<unknown>;
    }
  | undefined;
const basePrefix = `durable-runs-${randomUUID().slice(0, 8)}`;

const backends: Backend[] = [
  {
    name: 'knex (sqlite)',
    enabled: true,
    async setup() {
      dir = mkdtempSync(join(tmpdir(), 'durable-queue-runs-'));
      const knexMod = requireFromBoringnode('knex') as (config: unknown) => typeof knex;
      knex = knexMod({
        client: 'better-sqlite3',
        connection: { filename: join(dir, 'queue.sqlite') },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 },
      });
      const driver = await importFromQueue<{
        knex: (k: unknown, table?: string) => AdapterFactory;
        KnexQueueSchemaService?: new (k: unknown) => { createJobsTable(t?: string): Promise<void> };
      }>('@boringnode/queue/drivers/knex_adapter');
      const Schema =
        driver.KnexQueueSchemaService ??
        (
          await importFromQueue<{
            QueueSchemaService: new (k: unknown) => { createJobsTable(t?: string): Promise<void> };
          }>('@boringnode/queue')
        ).QueueSchemaService;
      await new Schema(knex).createJobsTable('queue_jobs');
      return driver.knex(knex, 'queue_jobs');
    },
    async teardown() {
      await knex?.destroy();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: 'redis',
    enabled: Boolean(REDIS_URL),
    async setup() {
      const IORedis = requireFromBoringnode('ioredis') as {
        Redis: new (url: string) => NonNullable<typeof redis>;
      };
      redis = new IORedis.Redis(REDIS_URL as string);
      const driver = await importFromQueue<{ redis: (c: unknown) => AdapterFactory }>(
        '@boringnode/queue/drivers/redis_adapter',
      );
      return driver.redis(redis);
    },
    async teardown() {
      if (!redis) return;
      const keys = await redis.keys(`*${basePrefix}*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
    },
  },
];

for (const backend of backends) {
  describe.skipIf(!backend.enabled)(`queue transport on the real ${backend.name} adapter`, () => {
    let factory: AdapterFactory;
    let prefix = basePrefix;
    beforeAll(async () => {
      factory = await backend.setup();
    });
    afterAll(async () => {
      await backend.teardown();
    });
    runRunDispatchContract(`QueueTransport (${backend.name})`, {
      setup: () => {
        prefix = `${basePrefix}-${randomUUID().slice(0, 6)}`;
      },
      make: () =>
        new QueueTransport({
          adapter: factory,
          prefix,
          pollIntervalMs: 5,
          stalledCheckIntervalMs: 0,
        }),
    });
  });
}
