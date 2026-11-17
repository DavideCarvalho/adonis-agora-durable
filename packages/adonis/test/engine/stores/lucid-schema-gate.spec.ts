import { createHash } from 'node:crypto';
import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { LIFECYCLE_PENDING_TAG } from '../../../src/lifecycle-events.js';
import { LucidStateStore } from '../../../src/stores/lucid.js';
import {
  createDurableTables,
  DURABLE_SCHEMA_META_TABLE,
  DURABLE_SCHEMA_REVISION,
  DURABLE_TABLES,
  dropDurableTables,
  LIFECYCLE_PENDING_INDEX,
  LIFECYCLE_PENDING_INDEXED_TAG,
} from '../../../src/stores/lucid-schema.js';
import { dbBackends } from '../../support/backends.js';

/**
 * `createDurableTables` runs at every boot of every pod (`autoSchema`). Once the schema is current it
 * must cost a marker read, not a probe per table, column and index — and when it does have work to
 * do, it is serialized across processes (the lock itself is exercised against real Postgres/MySQL
 * in the PR's manual check; SQLite runs it without one). Runs on SQLite and, with `DURABLE_PG_URL`,
 * on Postgres (each database an isolated schema).
 */

const isPostgres = (db: Database) => db.connection().dialect.name === 'postgres';

/** Count the SQL statements `fn` sends on the default connection. */
async function countQueries(db: Database, fn: () => Promise<void>): Promise<string[]> {
  const sql: string[] = [];
  const knex = db.connection().getWriteClient();
  const listener = (q: { sql: string }) => sql.push(q.sql);
  knex.on('query', listener);
  try {
    await fn();
  } finally {
    knex.off('query', listener);
  }
  return sql;
}

/** Whether the index named `name` exists in the database's (current) schema. */
async function hasIndex(db: Database, name: string): Promise<boolean> {
  if (isPostgres(db)) {
    const { rows } = (await db.rawQuery(
      'select 1 from pg_indexes where schemaname = current_schema() and indexname = ?',
      [name],
    )) as { rows: unknown[] };
    return rows.length > 0;
  }
  const rows = await db.from('sqlite_master').where('type', 'index').where('name', name);
  return rows.length > 0;
}

/**
 * The DDL the database holds for the durable tables and indexes, in a stable order. SQLite keeps the
 * statements themselves; on Postgres it is rebuilt from the catalog (columns with their types,
 * nullability and defaults, then each index definition with the per-test schema name stripped).
 */
async function durableDdl(db: Database): Promise<string> {
  if (isPostgres(db)) {
    const tables = Object.values(DURABLE_TABLES);
    const columns = (await db
      .connection()
      .query()
      .from('information_schema.columns')
      .select('table_name', 'column_name', 'data_type', 'is_nullable', 'column_default')
      .whereRaw('table_schema = current_schema()')
      .whereIn('table_name', tables)
      .orderBy([{ column: 'table_name' }, { column: 'column_name' }])) as Array<
      Record<string, string | null>
    >;
    const { rows: indexes } = (await db.rawQuery(
      `select indexname, indexdef from pg_indexes
        where schemaname = current_schema() and tablename = any(?) order by indexname`,
      [tables],
    )) as { rows: Array<{ indexname: string; indexdef: string }> };
    const schema = (db as Database & { schemaName?: string }).schemaName;
    const strip = (sql: string) =>
      schema ? sql.split(`"${schema}".`).join('').split(`${schema}.`).join('') : sql;
    return [
      ...columns.map(
        (c) =>
          `column ${c.table_name}.${c.column_name}: ${c.data_type} ${c.is_nullable} ${c.column_default ?? ''}`,
      ),
      ...indexes.map((i) => `index ${i.indexname}: ${strip(i.indexdef)}`),
    ].join('\n');
  }
  const rows = (await db
    .connection()
    .query()
    .from('sqlite_master')
    .select('type', 'name', 'sql')
    .whereIn('tbl_name', Object.values(DURABLE_TABLES))
    .orderBy('name')) as Array<{ type: string; name: string; sql: string | null }>;
  return rows.map((r) => `${r.type} ${r.name}: ${r.sql ?? ''}`).join('\n');
}

describe.each(dbBackends())('on $name', ({ name: backend, makeMemoryDb }) => {
  describe('createDurableTables fingerprint gate', () => {
    const open: Database[] = [];
    afterEach(async () => {
      while (open.length) await open.pop()?.manager.closeAll();
    });
    const fresh = async () => {
      const db = await makeMemoryDb();
      open.push(db);
      return db;
    };

    it('records the fingerprint, then answers a current schema with the marker read alone', async () => {
      const db = await fresh();
      const first = await countQueries(db, () => createDurableTables(db));
      expect(first.length).toBeGreaterThan(10);
      const marker = await db.from(DURABLE_SCHEMA_META_TABLE).select('id', 'fingerprint');
      expect(marker).toEqual([
        { id: 'durable', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ]);

      const steady = await countQueries(db, () => createDurableTables(db));
      // One catalog probe for the marker table and one PK read — no table/column/index probes.
      expect(steady).toHaveLength(2);
      expect(steady.join('\n')).not.toMatch(/pragma|create|alter/i);
    });

    it('re-checks when the marker is stale, and when forced', async () => {
      const db = await fresh();
      await createDurableTables(db);
      await db.from(DURABLE_SCHEMA_META_TABLE).update({ fingerprint: 'stale' });
      await db.rawQuery('drop index "durable_runs_created_idx"');
      const warnings: string[] = [];
      await createDurableTables(db, undefined, { logger: { warn: (m) => warnings.push(m) } });
      expect(warnings.join('\n')).toContain('durable_runs_created_idx');
      // Back to current: the stale row was rewritten.
      expect(await countQueries(db, () => createDurableTables(db))).toHaveLength(2);

      // A hand change behind a current marker is only seen with `force`.
      await db.rawQuery('drop index "durable_runs_created_idx"');
      await createDurableTables(db, undefined, { logger: { warn: () => {} } });
      expect(await hasIndex(db, 'durable_runs_created_idx')).toBe(false);
      await createDurableTables(db, undefined, { force: true, logger: { warn: () => {} } });
      expect(await hasIndex(db, 'durable_runs_created_idx')).toBe(true);
    });

    it('dropDurableTables drops the marker too, so the next call re-creates everything', async () => {
      const db = await fresh();
      await createDurableTables(db);
      await dropDurableTables(db);
      expect(await db.connection().schema.hasTable(DURABLE_SCHEMA_META_TABLE)).toBe(false);
      await createDurableTables(db);
      expect(await db.connection().schema.hasTable(DURABLE_TABLES.runs)).toBe(true);
    });

    it('creates the run-detail index on (run_id, parallel_group, seq), and repairs it', async () => {
      const db = await fresh();
      await createDurableTables(db);
      const ddl = await durableDdl(db);
      expect(ddl).toContain('durable_step_checkpoints_group_idx');
      expect(ddl).toMatch(
        backend === 'postgres'
          ? /durable_step_checkpoints_group_idx.*\(run_id, parallel_group, seq\)/
          : /durable_step_checkpoints_group_idx.*\(`run_id`, `parallel_group`, `seq`\)/,
      );
      await db.rawQuery('drop index "durable_step_checkpoints_group_idx"');
      const warnings: string[] = [];
      await createDurableTables(db, undefined, {
        force: true,
        logger: { warn: (m) => warnings.push(m) },
      });
      expect(warnings.join('\n')).toContain('durable_step_checkpoints_group_idx');
    });

    it('on Postgres, indexes the signal tokens for prefix scans silently on create, and repairs them', async () => {
      const db = await fresh();
      const warnings: string[] = [];
      const logger = { warn: (m: string) => warnings.push(m) };
      await createDurableTables(db, undefined, { logger });
      const names = [
        'durable_signal_waiters_token_prefix_idx',
        'durable_buffered_signals_token_prefix_idx',
      ];
      if (!isPostgres(db)) {
        for (const name of names) expect(await hasIndex(db, name)).toBe(false);
        return;
      }
      for (const name of names) expect(await hasIndex(db, name)).toBe(true);
      expect(await durableDdl(db)).toMatch(
        /durable_buffered_signals_token_prefix_idx.*varchar_pattern_ops/,
      );
      expect(warnings).toEqual([]);
      for (const name of names) await db.rawQuery(`drop index "${name}"`);
      await createDurableTables(db, undefined, { force: true, logger });
      for (const name of names) expect(await hasIndex(db, name)).toBe(true);
      expect(warnings.join('\n')).toContain('durable_signal_waiters_token_prefix_idx');
      expect(warnings.join('\n')).toContain('durable_buffered_signals_token_prefix_idx');
    });

    it('indexes the runs that owe a lifecycle event (Postgres), and the owed listing reads it', async () => {
      expect(LIFECYCLE_PENDING_INDEXED_TAG).toBe(LIFECYCLE_PENDING_TAG);
      const db = await fresh();
      const warnings: string[] = [];
      await createDurableTables(db, undefined, { logger: { warn: (m) => warnings.push(m) } });
      if (!isPostgres(db)) {
        expect(await hasIndex(db, LIFECYCLE_PENDING_INDEX)).toBe(false);
        return;
      }
      expect(warnings).toEqual([]);
      const { rows } = (await db.rawQuery(
        `select i.indisvalid as valid, pg_get_indexdef(c.oid) as def
           from pg_class c join pg_index i on i.indexrelid = c.oid
           join pg_namespace n on n.oid = c.relnamespace
          where c.relname = ? and n.nspname = current_schema()`,
        [LIFECYCLE_PENDING_INDEX],
      )) as { rows: Array<{ valid: boolean; def: string }> };
      expect(rows[0]?.valid).toBe(true);
      expect(rows[0]?.def).toMatch(/\(created_at\) WHERE .*%"durable:lifecycle:pending"%/);

      // 3,000 settled runs, 3 of which still owe their event.
      const now = Date.now();
      await db.rawQuery(
        `insert into ${DURABLE_TABLES.runs} (id, workflow, workflow_version, status, namespace, tags, created_at, updated_at)
         select 'r' || i, 'wf', '1', 'completed', 'default',
                case when i % 1000 = 0 then '["${LIFECYCLE_PENDING_TAG}"]' else '["other"]' end,
                ?::bigint - i, ?::bigint - i
           from generate_series(1, 3000) i`,
        [now, now],
      );
      await db.rawQuery(`analyze ${DURABLE_TABLES.runs}`);
      const store = new LucidStateStore(db);
      const knex = db.connection().getWriteClient();
      const sql: Array<{ sql: string; bindings: unknown[] }> = [];
      const listener = (q: { sql: string; bindings: unknown[] }) => sql.push(q);
      knex.on('query', listener);
      const owed = await store.listRuns({
        tag: LIFECYCLE_PENDING_TAG,
        statuses: ['completed', 'failed', 'cancelled', 'dead'],
        updatedBefore: now,
        page: 1,
        size: 100,
      });
      knex.off('query', listener);
      expect(owed.map((r) => r.id).sort()).toEqual(['r1000', 'r2000', 'r3000']);
      // The statement the store sent, planned as sent: it reads the partial index.
      const sent = sql.find((q) => q.sql.includes('lifecycle:pending'));
      expect(sent).toBeDefined();
      const text = (sent?.sql ?? '').replace(/\$\d+/g, '?');
      const plan = (await db.rawQuery(`explain ${text}`, sent?.bindings as never)) as {
        rows: Array<{ 'QUERY PLAN': string }>;
      };
      expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(LIFECYCLE_PENDING_INDEX);
      // Any other tag keeps the bound LIKE.
      expect((await store.listRuns({ tag: 'other', page: 1, size: 1 })).map((r) => r.tags)).toEqual(
        [['other']],
      );
    });

    it('rebuilds a missing lifecycle index, and leaves the revision unrecorded until it is valid (Postgres)', async () => {
      const db = await fresh();
      await createDurableTables(db);
      if (!isPostgres(db)) return;
      await db.rawQuery(`drop index ${LIFECYCLE_PENDING_INDEX}`);
      // The build fails (the table is locked out from under it): the boot goes on, reports it, and
      // records nothing, so the next boot tries again.
      await db.from(DURABLE_SCHEMA_META_TABLE).delete();
      await db.rawQuery('alter table durable_workflow_runs rename column tags to tags_gone');
      const warnings: string[] = [];
      await createDurableTables(db, undefined, { logger: { warn: (m) => warnings.push(m) } });
      expect(warnings.join('\n')).toContain(LIFECYCLE_PENDING_INDEX);
      expect(await db.from(DURABLE_SCHEMA_META_TABLE).select('id')).toEqual([]);
      await db.rawQuery('alter table durable_workflow_runs rename column tags_gone to tags');
      await createDurableTables(db);
      expect(await hasIndex(db, LIFECYCLE_PENDING_INDEX)).toBe(true);
      expect(await db.from(DURABLE_SCHEMA_META_TABLE).select('id')).toEqual([{ id: 'durable' }]);
    });

    it('pins the DDL to DURABLE_SCHEMA_REVISION', async () => {
      const db = await fresh();
      await createDurableTables(db);
      const digest = createHash('sha256')
        .update(await durableDdl(db))
        .digest('hex');
      // A failure here means the DDL changed. Bump DURABLE_SCHEMA_REVISION in lucid-schema.ts (so
      // every existing database runs the full check once) and update both values below. (If only a
      // Knex upgrade changed how SQLite spells the same DDL, update the digest alone.)
      // One digest per backend: the same DDL, spelled by each dialect.
      expect({ revision: DURABLE_SCHEMA_REVISION, digest }).toEqual({
        revision: 7,
        digest:
          backend === 'postgres'
            ? 'f428e7768fdaee50ac36d2ac33e2f8c9779a80c0d90ae7bfb9f1365db1e86b83'
            : '08cda87e6d7fead504cf9a9cd0fcc84414d6d94ceb03c87fec4a613a1d9242cd',
      });
    });
  });
});
