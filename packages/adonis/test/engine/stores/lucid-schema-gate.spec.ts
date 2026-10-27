import { createHash } from 'node:crypto';
import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDurableTables,
  DURABLE_SCHEMA_META_TABLE,
  DURABLE_SCHEMA_REVISION,
  DURABLE_TABLES,
  dropDurableTables,
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
        revision: 5,
        digest:
          backend === 'postgres'
            ? '6a86713912e5cd80f9a42d2dab4a1f7f0262e3de50a8669d98cf868e77cd4ad4'
            : '4aae89959954329e70c1c6b03444d0c266c850fab7d7bf9f9926c66887439284',
      });
    });
  });
});
