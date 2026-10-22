import { EventEmitter } from 'node:events';
import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkerDescriptor } from '../../../src/handshake/descriptor.js';
import { DbTransport } from '../../../src/transports/db.js';
import { EventEmitterTransport } from '../../../src/transports/event-emitter.js';
import { transports } from '../../../src/transports/factory.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';
import { MemoryWorkerKeys } from '../../../src/transports/worker-keys.js';
import { lucidWorkerKeys } from '../../../src/transports/worker-keys-db.js';
import { RedisWorkerRegistry, WorkerRuntime } from '../../../src/worker-runtime/index.js';
import { dbBackends } from '../../support/backends.js';

interface Advertising {
  createDescriptorRedis(): ConstructorParameters<typeof RedisWorkerRegistry>[0];
  listWorkerDescriptors(token: string): Promise<WorkerDescriptor[]>;
  listWorkerGroups(): Promise<string[]>;
  handle: EventEmitterTransport['handle'];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A worker runtime serving `line` with onError routes, advertising through `worker`'s keys. */
function workerOn(worker: Advertising, opts: { ttlSeconds?: number } = {}): WorkerRuntime {
  const runtime = new WorkerRuntime({
    transport: worker as never,
    partition: 'acme',
    registry: new RedisWorkerRegistry(worker.createDescriptorRedis()),
    heartbeatIntervalMs: 60_000,
    ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
  });
  runtime.registerWorkflow('line', () => 'ok', {
    version: '1',
    onError: [{ code: 'invalid_line', workflow: 'line-dead-letter' }],
  });
  return runtime;
}

/** The advertisement contract each transport has to meet, read from an engine-side instance. */
function advertisementContract(
  label: string,
  make: () => Promise<{ engine: Advertising; worker: Advertising; cleanup?: () => Promise<void> }>,
) {
  describe(`${label}: worker advertisement`, () => {
    let cleanup: (() => Promise<void>) | undefined;
    afterEach(async () => {
      await cleanup?.();
      cleanup = undefined;
    });

    it("lists a live worker's descriptor and its routing token", async () => {
      const t = await make();
      cleanup = t.cleanup;
      const runtime = workerOn(t.worker);
      await runtime.start();

      const [descriptor] = await t.engine.listWorkerDescriptors('line@acme');
      expect(descriptor?.registrations).toEqual([
        {
          name: 'line',
          version: '1',
          onError: [{ code: 'invalid_line', workflow: 'line-dead-letter' }],
          group: 'line@acme',
        },
      ]);
      expect(await t.engine.listWorkerGroups()).toContain('line@acme');
      expect(await t.engine.listWorkerDescriptors('other@acme')).toEqual([]);
    });

    it('drops the worker on a clean stop', async () => {
      const t = await make();
      cleanup = t.cleanup;
      const runtime = workerOn(t.worker);
      await runtime.start();
      await runtime.stop();

      expect(await t.engine.listWorkerDescriptors('line@acme')).toEqual([]);
      expect(await t.engine.listWorkerGroups()).toEqual([]);
    });

    it('drops a worker that dies without stopping once its keys expire', async () => {
      const t = await make();
      cleanup = t.cleanup;
      // Long enough to read the keys back over a real database on a loaded machine.
      await workerOn(t.worker, { ttlSeconds: 0.4 }).start();
      expect(await t.engine.listWorkerDescriptors('line@acme')).toHaveLength(1);

      await sleep(600);

      // The runtime's advertisement expired. (A transport that beats its own liveness per consumed
      // queue — bullmq, queue, db — still lists the loop it keeps consuming: that process is alive.)
      expect(await t.engine.listWorkerDescriptors('line@acme')).toEqual([]);
      expect(await t.engine.listWorkerGroups()).not.toContain('line@acme');
    });
  });
}

advertisementContract('event-emitter', async () => {
  const emitter = new EventEmitter();
  return {
    engine: new EventEmitterTransport({ emitter }),
    worker: new EventEmitterTransport({ emitter }),
  };
});

advertisementContract('queue (in-memory keys)', async () => {
  const adapter = new MockAdapter();
  const workerKeys = new MemoryWorkerKeys();
  const engine = new QueueTransport({ adapter: () => adapter, workerKeys, workerKeysCacheMs: 0 });
  const worker = new QueueTransport({ adapter: () => adapter, workerKeys, workerKeysCacheMs: 0 });
  return {
    engine,
    worker,
    cleanup: async () => {
      await engine.close();
      await worker.close();
    },
  };
});

describe('queue: with nowhere to keep the keys', () => {
  it('advertises nothing and reads empty, without throwing', async () => {
    const adapter = new MockAdapter();
    const worker = new QueueTransport({ adapter: () => adapter });
    const engine = new QueueTransport({ adapter: () => adapter });
    try {
      await workerOn(worker).start();
      expect(await engine.listWorkerDescriptors('line@acme')).toEqual([]);
      expect(await engine.listWorkerGroups()).toEqual([]);
    } finally {
      await engine.close();
      await worker.close();
    }
  });

  it('transports.queue() builds without a key store when the app has no database', async () => {
    const adapter = new MockAdapter();
    const app = {
      config: { get: <T>(_key: string, fallback: T) => fallback },
      container: {
        make: async () => {
          throw new Error('no lucid.db binding');
        },
      },
    };
    const transport = (await transports.queue({ adapter: () => adapter })({
      app,
    } as never)) as QueueTransport;
    try {
      expect(await transport.listWorkerDescriptors('line@acme')).toEqual([]);
    } finally {
      await transport.close();
    }
  });
});

describe('event-emitter: separate emitters do not share workers', () => {
  it('keeps one bus’s advertisement off another', async () => {
    const worker = new EventEmitterTransport({ emitter: new EventEmitter() });
    const engine = new EventEmitterTransport({ emitter: new EventEmitter() });
    await workerOn(worker).start();

    expect(await engine.listWorkerDescriptors('line@acme')).toEqual([]);
  });
});

// The database-backed advertisement (the worker-key table, `lucidWorkerKeys`) on every Lucid backend.
for (const { name, makeTransportDb } of dbBackends()) {
  advertisementContract(`db (${name})`, async () => {
    const db: Database = await makeTransportDb();
    const engine = new DbTransport({ db, workerKeysCacheMs: 0, pollIntervalMs: 10 });
    const worker = new DbTransport({ db, workerKeysCacheMs: 0, pollIntervalMs: 10 });
    return {
      engine,
      worker,
      cleanup: async () => {
        await engine.close();
        await worker.close();
        await db.manager.closeAll();
      },
    };
  });

  advertisementContract(`queue (database keys on ${name})`, async () => {
    const db: Database = await makeTransportDb();
    const adapter = new MockAdapter();
    const engine = new QueueTransport({
      adapter: () => adapter,
      workerKeys: lucidWorkerKeys(db),
      workerKeysCacheMs: 0,
    });
    const worker = new QueueTransport({ adapter: () => adapter, workerKeys: lucidWorkerKeys(db) });
    return {
      engine,
      worker,
      cleanup: async () => {
        await engine.close();
        await worker.close();
        await db.manager.closeAll();
      },
    };
  });

  describe(`queue: transports.queue() with the app database (${name})`, () => {
    it('advertises through the database worker-key table by default', async () => {
      const db: Database = await makeTransportDb();
      const adapter = new MockAdapter();
      const app = {
        config: { get: <T>(_key: string, fallback: T) => fallback },
        container: { make: async () => db },
      };
      const build = () =>
        transports.queue({ adapter: () => adapter, workerKeysCacheMs: 0 })({
          app,
        } as never) as Promise<QueueTransport>;
      const engine = await build();
      const worker = await build();
      try {
        await workerOn(worker).start();
        expect(await engine.listWorkerGroups()).toContain('line@acme');
      } finally {
        await engine.close();
        await worker.close();
        await db.manager.closeAll();
      }
    });
  });

  describe(`db: the advertisement read is reused for a burst (${name})`, () => {
    it('serves descriptors from one read inside the cache window', async () => {
      const db = await makeTransportDb();
      const engine = new DbTransport({ db, workerKeysCacheMs: 60_000 });
      const worker = new DbTransport({ db });
      try {
        expect(await engine.listWorkerDescriptors('line@acme')).toEqual([]);
        await workerOn(worker).start();
        // Still the empty read from before the worker started.
        expect(await engine.listWorkerDescriptors('line@acme')).toEqual([]);
      } finally {
        await engine.close();
        await worker.close();
        await db.manager.closeAll();
      }
    });
  });
}
