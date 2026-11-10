import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../../src/engine.js';
import { RunAlreadyExistsError } from '../../../src/errors.js';
import type { WorkflowRun } from '../../../src/interfaces.js';
import { LucidStateStore } from '../../../src/stores/lucid.js';
import { DURABLE_TABLES } from '../../../src/stores/lucid-schema.js';
import { dbBackends } from '../../support/backends.js';

/**
 * The Lucid store bound to an app's transaction — AdonisJS `wrapInGlobalTransaction()` in tests, where
 * `db.connection()` IS the transaction. Two things must hold there:
 *
 * - a start that finds its run id taken reports the existing run WITHOUT a failing statement: on
 *   Postgres one failed INSERT aborts the whole transaction, and every later query of the test fails;
 * - the store never has two queries in flight on the transaction's single connection (pg deprecates
 *   it, pg 9 removes it, and a statement could land inside a savepoint another call is rolling back).
 */

const at = new Date('2026-11-10T00:00:00.000Z');
const run = (id: string, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  workflow: 'parked',
  workflowVersion: '1',
  status: 'pending',
  input: {},
  createdAt: at,
  updatedAt: at,
  ...over,
});

describe.each(dbBackends({ mysql: true }))(
  'the Lucid store inside an outer transaction on $name',
  (b) => {
    it('a duplicate run id reports the existing run, and the transaction stays usable', async () => {
      const db = await b.makeStoreDb();
      try {
        const store = new LucidStateStore(db);
        await db.beginGlobalTransaction();
        try {
          const engine = new WorkflowEngine({ store });
          engine.register('parked', '1', async (ctx) => ctx.waitForSignal('never-sent'));

          const first = await engine.start('parked', { n: 1 }, 'dup-1');
          const second = await engine.start('parked', { n: 2 }, 'dup-1');
          expect(first.runId).toBe('dup-1');
          expect(second.runId).toBe('dup-1');

          // The store's own answer to the duplicate, without a statement that fails.
          await expect(store.createRun(run('dup-1'))).rejects.toBeInstanceOf(RunAlreadyExistsError);
          await expect(
            store.createRun(run('dup-1', { searchAttributes: { tier: 'pro' } })),
          ).rejects.toBeInstanceOf(RunAlreadyExistsError);

          // The outer transaction still runs queries (an aborted Postgres one rejects every query).
          const rows = await db.from(DURABLE_TABLES.runs).where('id', 'dup-1').select('id');
          expect(rows).toHaveLength(1);
          expect((await store.getRun('dup-1'))?.input).toEqual({ n: 1 });
          await store.createRun(run('after-dup'));
          expect((await store.getRun('after-dup'))?.status).toBe('pending');
          await engine.drain(5_000);
        } finally {
          await db.rollbackGlobalTransaction();
        }
        expect(await store.getRun('dup-1')).toBeNull();
      } finally {
        await db.manager.closeAll();
      }
    });

    it('a duplicate checkpoint position writes nothing, without a failing statement', async () => {
      const db = await b.makeStoreDb();
      try {
        const store = new LucidStateStore(db);
        await db.beginGlobalTransaction();
        try {
          await store.createRun(run('cp-1'));
          const checkpoint = {
            runId: 'cp-1',
            seq: 0,
            name: 'charge',
            kind: 'remote' as const,
            stepId: 'cp-1:0',
            status: 'pending' as const,
            attempts: 0,
            enqueuedAt: at,
            startedAt: at,
            finishedAt: at,
          };
          expect(await store.insertCheckpointIfAbsent(checkpoint)).toBe(true);
          expect(await store.insertCheckpointIfAbsent(checkpoint)).toBe(false);
          expect(await store.listCheckpoints('cp-1')).toHaveLength(1);
        } finally {
          await db.rollbackGlobalTransaction();
        }
      } finally {
        await db.manager.closeAll();
      }
    });
  },
);

/** The `pg` driver Knex uses (untyped here): its Client's `query`, to see what overlaps. */
const pg = createRequire(import.meta.url)('pg') as {
  Client: { prototype: { query: (...args: unknown[]) => unknown } };
};

const postgres = dbBackends().filter((b) => b.name === 'postgres');

describe.skipIf(postgres.length === 0).each(postgres)(
  'the Lucid store on a transaction connection on $name',
  (b) => {
    it('never issues concurrent queries on the transaction', async () => {
      const db = await b.makeStoreDb();
      const query = pg.Client.prototype.query;
      let overlapping = 0;
      let total = 0;
      try {
        const store = new LucidStateStore(db);
        await db.beginGlobalTransaction();
        try {
          // pg's own condition for "already executing a query": a query is queued behind another.
          pg.Client.prototype.query = function (this: { _queryQueue?: unknown[] }, ...args) {
            total += 1;
            if ((this._queryQueue?.length ?? 0) > 0) overlapping += 1;
            return query.apply(this, args);
          };
          const ids = Array.from({ length: 8 }, (_, i) => `c-${i}`);
          // Many store calls at once, as an engine's background pickup does next to a request.
          await Promise.all(ids.map((id) => store.createRun(run(id))));
          await Promise.all([
            ...ids.map((id) => store.getRun(id)),
            ...ids.map((id) =>
              store.updateRunIf(id, ['pending'], { status: 'running', updatedAt: new Date() }),
            ),
            store.listRuns({ status: 'running' }),
            ...ids.map((id) => store.createRun(run(id)).catch(() => undefined)),
          ]);
          expect((await store.getRun('c-0'))?.status).toBe('running');
        } finally {
          pg.Client.prototype.query = query;
          await db.rollbackGlobalTransaction();
        }
        expect(total).toBeGreaterThan(20);
        expect(overlapping).toBe(0);
      } finally {
        pg.Client.prototype.query = query;
        await db.manager.closeAll();
      }
    });
  },
);
