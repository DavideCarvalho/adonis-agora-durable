import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbTransport } from '../../../src/transports/db.js';
import { WORKER_KEYS_TABLE } from '../../../src/transports/db-schema.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';
import { MemoryWorkerKeys } from '../../../src/transports/worker-keys.js';
import { dbBackends } from '../../support/backends.js';

/**
 * A worker's liveness heartbeat must not queue writes behind a slow key store.
 *
 * The heartbeat interval started a key write for every served token on every tick, whether or not
 * the previous write had landed. A store slower than the interval (a loaded database, a lock, a
 * saturated pool) piled the writes up without bound — each one waiting on a pool connection that the
 * claim loop and `groupHealth` then waited behind, which is how a 5ms heartbeat starved a CI run's
 * `groupHealth` reads for 20s. A beat due while the last one is in flight is now skipped.
 */

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Every key write the db transport starts, counted at the store call — before any pool connection
// is acquired, so writes queued behind a saturated pool count too.
const keyPuts = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../../src/transports/worker-keys-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/transports/worker-keys-db.js')>();
  return {
    ...actual,
    lucidWorkerKeys: (...args: Parameters<typeof actual.lucidWorkerKeys>) => {
      const store = actual.lucidWorkerKeys(...args);
      return {
        ...store,
        put: (key: string, value: string, expiresAt: number) => {
          keyPuts.n += 1;
          return store.put(key, value, expiresAt);
        },
      };
    },
  };
});

describe('worker heartbeat backpressure', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('queue: one key write in flight per token, however many intervals pass', async () => {
    let release: () => void = () => {};
    const released = new Promise<void>((r) => {
      release = r;
    });
    const keys = new MemoryWorkerKeys();
    let puts = 0;
    const slow = {
      put: async (key: string, value: string, expiresAt: number) => {
        puts += 1;
        await released;
        await keys.put(key, value, expiresAt);
      },
      remove: (k: string[]) => keys.remove(k),
      live: (now: number) => keys.live(now),
    };
    const adapter = new MockAdapter();
    const worker = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: 5,
      stalledCheckIntervalMs: 0,
      workerKeys: slow,
      workerHeartbeatIntervalMs: 5,
    });
    closers.push(async () => {
      release();
      await worker.close();
    });
    worker.handle('ext.work', async () => 'x');
    await until(() => puts > 0);
    // Forty intervals with the first write stuck.
    await sleep(200);
    // Unfixed: ~40.
    expect(puts).toBe(1);
    release();
    // The beat resumes once the write lands.
    await until(() => puts > 1);
  });

  describe.each(dbBackends().filter((b) => b.name === 'postgres'))('db on $name', (backend) => {
    it('db: one key write in flight per token while the keys table is locked', async () => {
      const db: Database = await backend.makeTransportDb();
      closers.push(() => db.manager.closeAll());
      const worker = new DbTransport({ db, pollIntervalMs: 5, workerHeartbeatIntervalMs: 5 });
      closers.unshift(() => worker.close());
      const writes = (): number => keyPuts.n;
      worker.handle('ext.work', async () => 'x');
      await until(() => writes() > 0);

      let release: () => void = () => {};
      const released = new Promise<void>((r) => {
        release = r;
      });
      let locked: () => void = () => {};
      const isLocked = new Promise<void>((r) => {
        locked = r;
      });
      const lock = db.connection().transaction(async (trx) => {
        await trx.rawQuery(`lock table "${WORKER_KEYS_TABLE}" in access exclusive mode`);
        locked();
        await released;
      });
      try {
        await isLocked;
        // A beat's write lands in the lock (or is already there).
        await sleep(20);
        const before = writes();
        // Forty intervals against a table that blocks every write. Unfixed, each interval started
        // another write behind the blocked one. Now no new one starts while it waits.
        await sleep(200);
        expect(writes() - before).toBeLessThanOrEqual(1);
        release();
        await lock;
        // The beat resumes once the blocked write lands.
        const resumed = writes();
        await until(() => writes() > resumed);
      } finally {
        release();
        await lock.catch(() => undefined);
      }
    });
  });
});
