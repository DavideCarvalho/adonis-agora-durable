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
  RUN_RETENTION_INDEX,
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

    it('creates the retention index and a scoped sweep reads it instead of scanning the runs table (Postgres)', async () => {
      const db = await fresh();
      await createDurableTables(db);
      if (!isPostgres(db)) {
        // Elsewhere the index is built inside the schema lock by the routine repair path.
        expect(await hasIndex(db, RUN_RETENTION_INDEX)).toBe(true);
        return;
      }
      const { rows } = (await db.rawQuery(
        `select i.indisvalid as valid, pg_get_indexdef(c.oid) as def
           from pg_class c join pg_index i on i.indexrelid = c.oid
           join pg_namespace n on n.oid = c.relnamespace
          where c.relname = ? and n.nspname = current_schema()`,
        [RUN_RETENTION_INDEX],
      )) as { rows: Array<{ valid: boolean; def: string }> };
      expect(rows[0]?.valid).toBe(true);
      expect(rows[0]?.def).toMatch(/\(status, updated_at, workflow\)/);

      // A table shaped like a real install: thousands of settled runs, a handful of them past the
      // cutoff inside one workflow's scope — the steady state the sweep runs in 674 times a day.
      const now = Date.now();
      const cutoff = now - 7 * 86_400_000;
      await db.rawQuery(
        `insert into ${DURABLE_TABLES.runs}
           (id, workflow, workflow_version, status, namespace, created_at, updated_at)
         select 'r' || i,
                case when i % 5 = 0 then 'swept' else 'busy' end,
                '1',
                case when i % 7 = 0 then 'failed' else 'completed' end,
                'default', ?::bigint - i, ?::bigint - i
           from generate_series(1, 5000) i`,
        [now, now],
      );
      // 4 expired runs of the swept workflow, and 40 expired ones of the busy workflow (which the
      // policy's scope excludes): the index must pick the 4 without reading the 40.
      const sweptIds = ['r5', 'r10', 'r15', 'r20'];
      const busyIds: string[] = [];
      for (let i = 1; busyIds.length < 40; i += 1) {
        if (i % 5 !== 0 && i % 7 !== 0) busyIds.push(`r${i}`);
      }
      await db.rawQuery(`update ${DURABLE_TABLES.runs} set updated_at = ? where id = any(?)`, [
        cutoff - 1_000,
        sweptIds,
      ]);
      await db.rawQuery(`update ${DURABLE_TABLES.runs} set updated_at = ? where id = any(?)`, [
        cutoff - 1_000,
        busyIds,
      ]);
      await db.rawQuery(`analyze ${DURABLE_TABLES.runs}`);

      // The statement `engine.sweepRetention` sends for a scoped policy, planned as Lucid sends it.
      const store = new LucidStateStore(db);
      const knex = db.connection().getWriteClient();
      const sql: Array<{ sql: string; bindings: unknown[] }> = [];
      const listener = (q: { sql: string; bindings: unknown[] }) => sql.push(q);
      knex.on('query', listener);
      const expired = await store.listRuns({
        workflows: ['swept'],
        statuses: ['completed'],
        namespace: 'default',
        updatedBefore: cutoff,
        page: 1,
        size: 100,
      });
      knex.off('query', listener);
      expect(expired.map((r) => r.id).sort()).toEqual([...sweptIds].sort());
      const sent = sql.find((q) => q.sql.includes('durable_workflow_runs'));
      expect(sent).toBeDefined();
      const text = (sent?.sql ?? '').replace(/\$\d+/g, '?');
      const plan = (await db.rawQuery(`explain ${text}`, sent?.bindings as never)) as {
        rows: Array<{ 'QUERY PLAN': string }>;
      };
      const planText = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(planText).toContain(RUN_RETENTION_INDEX);
      expect(planText).not.toContain('Seq Scan');
    });

    it('rebuilds a missing retention index, and records the revision once it is valid (Postgres)', async () => {
      const db = await fresh();
      await createDurableTables(db);
      if (!isPostgres(db)) return;
      await db.rawQuery(`drop index ${RUN_RETENTION_INDEX}`);
      await db.from(DURABLE_SCHEMA_META_TABLE).delete();
      // Missing (not invalid): `pgIndexState` returns `undefined`, so the boot creates it.
      const warnings: string[] = [];
      await createDurableTables(db, undefined, { logger: { warn: (m) => warnings.push(m) } });
      expect(warnings).toEqual([]);
      expect(await hasIndex(db, RUN_RETENTION_INDEX)).toBe(true);
      expect(await db.from(DURABLE_SCHEMA_META_TABLE).select('id')).toEqual([{ id: 'durable' }]);
    });

    it('drops and rebuilds an INVALID retention index left by a build that died (Postgres)', async () => {
      const db = await fresh();
      await createDurableTables(db);
      if (!isPostgres(db)) return;
      // A failed `CREATE INDEX CONCURRENTLY` is how a real install gets an invalid index: Postgres
      // leaves the name behind with `indisvalid = false` instead of rolling it back. A unique build
      // over duplicate values fails that way (a few thousand rows, over two statuses), and leaves
      // exactly the state `ensureBootIndexes` has to heal.
      await db.rawQuery(
        `insert into ${DURABLE_TABLES.runs}
           (id, workflow, workflow_version, status, namespace, created_at, updated_at)
         values ('dup1', 'w', '1', 'completed', 'default', 1, 1),
                ('dup2', 'w', '1', 'completed', 'default', 2, 2)`,
      );
      await db.rawQuery(`drop index ${RUN_RETENTION_INDEX}`);
      await expect(
        db.rawQuery(
          `create unique index concurrently ${RUN_RETENTION_INDEX} on ${DURABLE_TABLES.runs} (status)`,
        ),
      ).rejects.toThrow();
      const { rows } = (await db.rawQuery(
        `select i.indisvalid as valid from pg_class c join pg_index i on i.indexrelid = c.oid
          where c.relname = ? and c.relnamespace = current_schema()::regnamespace`,
        [RUN_RETENTION_INDEX],
      )) as { rows: Array<{ valid: boolean }> };
      expect(rows[0]?.valid).toBe(false);

      await db.rawQuery(`delete from ${DURABLE_TABLES.runs}`);
      await db.from(DURABLE_SCHEMA_META_TABLE).delete();
      const warnings: string[] = [];
      await createDurableTables(db, undefined, { logger: { warn: (m) => warnings.push(m) } });
      expect(warnings).toEqual([]);
      const healed = (await db.rawQuery(
        `select i.indisvalid as valid, pg_get_indexdef(c.oid) as def
           from pg_class c join pg_index i on i.indexrelid = c.oid
          where c.relname = ? and c.relnamespace = current_schema()::regnamespace`,
        [RUN_RETENTION_INDEX],
      )) as { rows: Array<{ valid: boolean; def: string }> };
      expect(healed.rows[0]?.valid).toBe(true);
      expect(healed.rows[0]?.def).toMatch(/\(status, updated_at, workflow\)/);
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
        revision: 9,
        digest:
          backend === 'postgres'
            ? '205e1a6f4ce891618c14e58cd6a561bdc62e4b13b244db3918af9f1c34b3ac58'
            : '75b285d7d64e56cf0021505236daa651ec8500e0e083974b7e26f80cf2b45720',
      });
    });
  });
});
