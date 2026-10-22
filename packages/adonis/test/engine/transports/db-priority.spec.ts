import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteTask } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { DbTransport } from '../../../src/transports/db.js';
import {
  createDurableTransportTables,
  TRANSPORT_TABLES,
} from '../../../src/transports/db-schema.js';
import { dbBackends } from '../../support/backends.js';

// The engine carries a dispatch `priority` (higher = more urgent, absent = unprioritised) that the
// queue and BullMQ transports hand to their broker; the db transport dropped it and always claimed
// oldest first. Rows now carry a `priority` column (absent = 0, "normal", as on the queue
// transport) and are claimed highest first, then oldest.

const NAME = 'ext.prio';
const TOKEN = sanitizeQueueToken(NAME);
const task = (seq: number, priority?: number): RemoteTask => ({
  runId: 'r1',
  seq,
  stepId: `r1:${seq}`,
  name: NAME,
  group: TOKEN,
  input: { seq },
  attempt: 1,
  ...(priority !== undefined ? { priority } : {}),
});

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe.each(dbBackends())('on $name', ({ makeMemoryDb, makeTransportDb }) => {
  describe('DbTransport dispatch priority', () => {
    const cleanups: Array<() => Promise<void>> = [];
    let db: Database;
    afterEach(async () => {
      await Promise.all(cleanups.splice(0).map((c) => c()));
      if (db) await db.manager.closeAll();
    });
    const make = (o: Partial<ConstructorParameters<typeof DbTransport>[0]> = {}) => {
      const t = new DbTransport({ db, pollIntervalMs: 5, ...o });
      cleanups.push(() => t.close());
      return t;
    };

    /** Dispatch `priorities` in order (1ms apart, so "oldest" is well defined), then run one at a time. */
    async function runOrder(priorities: Array<number | undefined>, o = {}): Promise<number[]> {
      const producer = make(o);
      for (const [i, p] of priorities.entries()) {
        await producer.dispatch(task(i + 1, p));
        await new Promise((r) => setTimeout(r, 2));
      }
      const order: number[] = [];
      make(o).handle(NAME, async (input) => {
        order.push((input as { seq: number }).seq);
        return 'ok';
      });
      await until(() => order.length === priorities.length);
      return order;
    }

    it('claims higher priority first, then oldest; absent is normal (0)', async () => {
      db = await makeTransportDb();
      //                       seq: 1          2   3   4  5   6
      const order = await runOrder([undefined, 5, -2, 5, 10, 0]);
      expect(order).toEqual([5, 2, 4, 1, 6, 3]);
    });

    it('stores the engine priority rounded, absent as 0', async () => {
      db = await makeTransportDb();
      const t = make();
      await t.dispatch(task(1));
      await t.dispatch(task(2, 2.6));
      await t.dispatch(task(3, -1e12));
      const rows = await db.connection().from(TRANSPORT_TABLES.tasks).orderBy('seq');
      expect(rows.map((r) => Number(r.priority))).toEqual([0, 3, -2_147_483_648]);
    });

    it('back-fills `priority` on an existing tasks table as 0', async () => {
      db = await makeMemoryDb();
      await createDurableTransportTables(db);
      await db.connection().schema.alterTable(TRANSPORT_TABLES.tasks, (t) => {
        t.dropColumn('priority');
      });
      await createDurableTransportTables(db);
      expect(await db.connection().schema.hasColumn(TRANSPORT_TABLES.tasks, 'priority')).toBe(true);
    });

    it('without the column (autoCreate off) dispatch still works and claims oldest first, said once', async () => {
      db = await makeMemoryDb();
      await createDurableTransportTables(db);
      await db.connection().schema.alterTable(TRANSPORT_TABLES.tasks, (t) => {
        t.dropColumn('priority');
      });
      const errors: unknown[] = [];
      const o = { autoCreate: false, onError: (e: unknown) => errors.push(e) };
      const order = await runOrder([undefined, 5, 10], o);
      expect(order).toEqual([1, 2, 3]);
      const warnings = errors.filter((e) => String(e).includes('"priority" column'));
      expect(warnings).toHaveLength(2); // once per instance (producer and worker)
    });
  });
});
