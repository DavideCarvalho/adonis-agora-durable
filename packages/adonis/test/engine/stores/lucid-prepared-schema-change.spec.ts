import { describe, expect, it } from 'vitest';
import type { StepCheckpoint, WorkflowRun } from '../../../src/interfaces.js';
import { LucidStateStore } from '../../../src/stores/lucid.js';
import { DURABLE_SCHEMA_META_TABLE, DURABLE_TABLES } from '../../../src/stores/lucid-schema.js';
import { dbBackends } from '../../support/backends.js';

/**
 * With `preparedStatements: true`, each hot statement is parsed once per connection and its result
 * type is fixed then. A `select *` / `returning *` statement prepared before a column is added (the
 * schema path adds columns at boot — another pod's `ensureSchema` during a rolling upgrade) then
 * fails with "cached plan must not change result type". The hot statements name their columns, so
 * they keep working.
 */

const at = new Date('2026-11-10T00:00:00.000Z');
const run = (id: string): WorkflowRun => ({
  id,
  workflow: 'wf',
  workflowVersion: '1',
  status: 'suspended',
  input: { n: 1 },
  createdAt: at,
  updatedAt: at,
});
const checkpoint = (runId: string): StepCheckpoint => ({
  runId,
  seq: 0,
  name: 'charge',
  kind: 'remote',
  stepId: `${runId}:0`,
  status: 'pending',
  attempts: 0,
  enqueuedAt: at,
  startedAt: at,
  finishedAt: at,
});

const postgres = dbBackends().filter((b) => b.name === 'postgres');

describe.skipIf(postgres.length === 0).each(postgres)(
  'prepared hot statements across a schema change on $name',
  (b) => {
    it('keep working after the schema path adds columns under them', async () => {
      const db = await b.makeStoreDb();
      try {
        // An older schema: later-wave columns are missing, as before an upgrade.
        await db.connection().schema.alterTable(DURABLE_TABLES.runs, (t) => {
          t.dropColumn('wake_requested_at');
        });
        await db.connection().schema.alterTable(DURABLE_TABLES.checkpoints, (t) => {
          t.dropColumn('last_heartbeat_at');
          t.dropColumn('heartbeat_progress');
        });
        // Recorded as an older schema, so the next ensureSchema heals it.
        await db.from(DURABLE_SCHEMA_META_TABLE).delete();
        const store = new LucidStateStore(db, { preparedStatements: true });
        await store.createRun(run('r1'));
        await store.saveCheckpoint(checkpoint('r1'));
        await store.bufferSignal('tok', { a: 1 });
        await store.bufferEvent({ name: 'evt', payload: 1, id: 'e1', publishedAt: 1 });

        // Prepare every hot read on every pooled connection: several of each in flight at once, more
        // than the pool holds, so each connection runs (and prepares) them.
        const reads = async (round: number) => {
          await Promise.all(
            Array.from({ length: 6 }, async (_, i) => {
              expect((await store.getRun('r1'))?.id).toBe('r1');
              expect(
                await store.tryLockRunAndGet('r1', `owner-${round}-${i}`, 0, 0),
              ).not.toBeNull();
              expect((await store.getCheckpoint('r1', 0))?.name).toBe('charge');
              expect(await store.listBufferedEvents('evt', 10)).toHaveLength(1);
            }),
          );
        };
        await reads(0);

        // The schema path puts the missing columns back, and a future wave adds new ones.
        await store.ensureSchema();
        for (const table of [
          DURABLE_TABLES.runs,
          DURABLE_TABLES.checkpoints,
          DURABLE_TABLES.bufferedSignals,
          DURABLE_TABLES.bufferedEvents,
        ]) {
          await db.connection().schema.alterTable(table, (t) => {
            t.string('added_later').nullable();
          });
        }

        await reads(1);
        expect(await store.takeBufferedSignal('tok')).toEqual({ payload: { a: 1 } });

        // The store's own ensureSchema makes it read the columns it added from then on.
        const seen: string[] = [];
        const knex = db.connection().getWriteClient();
        const listen = (q: { sql: string }) => seen.push(q.sql);
        knex.on('query', listen);
        await store.getRun('r1');
        await store.getCheckpoint('r1', 0);
        knex.off('query', listen);
        expect(
          seen.some((sql) => sql.startsWith('select') && sql.includes('"wake_requested_at"')),
        ).toBe(true);
        expect(seen.some((sql) => sql.includes('"heartbeat_progress" from'))).toBe(true);
      } finally {
        await db.manager.closeAll();
      }
    });
  },
);
