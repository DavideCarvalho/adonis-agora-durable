import { createHash } from 'node:crypto';
import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { makeMemoryDb } from '../../../src/stores/lucid-helpers.js';
import {
  createDurableTables,
  DURABLE_SCHEMA_META_TABLE,
  DURABLE_SCHEMA_REVISION,
  DURABLE_TABLES,
  dropDurableTables,
} from '../../../src/stores/lucid-schema.js';

/**
 * `createDurableTables` runs at every boot of every pod (`autoSchema`). Once the schema is current it
 * must cost a marker read, not a probe per table, column and index — and when it does have work to
 * do, it is serialized across processes (the lock itself is exercised against real Postgres/MySQL
 * in the PR's manual check; SQLite runs it without one).
 */

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

/** The DDL SQLite holds for the durable tables and indexes, in a stable order. */
async function durableDdl(db: Database): Promise<string> {
  const rows = (await db
    .connection()
    .query()
    .from('sqlite_master')
    .select('type', 'name', 'sql')
    .whereIn('tbl_name', Object.values(DURABLE_TABLES))
    .orderBy('name')) as Array<{ type: string; name: string; sql: string | null }>;
  return rows.map((r) => `${r.type} ${r.name}: ${r.sql ?? ''}`).join('\n');
}

describe('createDurableTables fingerprint gate', () => {
  const open: Database[] = [];
  afterEach(async () => {
    while (open.length) await open.pop()?.manager.closeAll();
  });
  const fresh = () => {
    const db = makeMemoryDb();
    open.push(db);
    return db;
  };

  it('records the fingerprint, then answers a current schema with the marker read alone', async () => {
    const db = fresh();
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
    const db = fresh();
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
    const index = () =>
      db.from('sqlite_master').where('type', 'index').where('name', 'durable_runs_created_idx');
    expect(await index()).toHaveLength(0);
    await createDurableTables(db, undefined, { force: true, logger: { warn: () => {} } });
    expect(await index()).toHaveLength(1);
  });

  it('dropDurableTables drops the marker too, so the next call re-creates everything', async () => {
    const db = fresh();
    await createDurableTables(db);
    await dropDurableTables(db);
    expect(await db.connection().schema.hasTable(DURABLE_SCHEMA_META_TABLE)).toBe(false);
    await createDurableTables(db);
    expect(await db.connection().schema.hasTable(DURABLE_TABLES.runs)).toBe(true);
  });

  it('creates the run-detail index on (run_id, parallel_group, seq), and repairs it', async () => {
    const db = fresh();
    await createDurableTables(db);
    const ddl = await durableDdl(db);
    expect(ddl).toContain('durable_step_checkpoints_group_idx');
    expect(ddl).toMatch(
      /durable_step_checkpoints_group_idx.*\(`run_id`, `parallel_group`, `seq`\)/,
    );
    await db.rawQuery('drop index "durable_step_checkpoints_group_idx"');
    const warnings: string[] = [];
    await createDurableTables(db, undefined, {
      force: true,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(warnings.join('\n')).toContain('durable_step_checkpoints_group_idx');
  });

  it('pins the DDL to DURABLE_SCHEMA_REVISION', async () => {
    const db = fresh();
    await createDurableTables(db);
    const digest = createHash('sha256')
      .update(await durableDdl(db))
      .digest('hex');
    // A failure here means the DDL changed. Bump DURABLE_SCHEMA_REVISION in lucid-schema.ts (so
    // every existing database runs the full check once) and update both values below. (If only a
    // Knex upgrade changed how SQLite spells the same DDL, update the digest alone.)
    expect({ revision: DURABLE_SCHEMA_REVISION, digest }).toEqual({
      revision: 3,
      digest: '004771001d3413ab12ae14444d47fc020402c902050282b14c0e955726943cd0',
    });
  });
});
