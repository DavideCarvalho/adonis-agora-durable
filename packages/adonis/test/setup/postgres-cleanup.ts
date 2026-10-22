import { randomUUID } from 'node:crypto';
import { makePostgresDb, postgresTestSchemaPrefix } from '../../src/transports/db-helpers.js';

/**
 * Global teardown for the Postgres-backed suites: every test database is a throwaway schema that its
 * test drops on close, but a file that crashed (or timed out) before closing would leave one behind.
 * After the run, drop every schema carrying THIS run's prefix. No-op without `DURABLE_PG_URL`.
 *
 * The run id is set here, before any worker forks, so every worker names its schemas under it (see
 * `postgresTestSchemaPrefix`). Dropping by the bare prefix instead let the first of two runs sharing a
 * server finish and drop every schema the other was still using: a burst of "relation ... does not
 * exist" failures across unrelated files.
 */
export default function globalSetup(): (() => Promise<void>) | undefined {
  const url = process.env.DURABLE_PG_URL;
  if (!url) return undefined;
  process.env.DURABLE_PG_TEST_RUN ??= randomUUID().replaceAll('-', '').slice(0, 8);
  const prefix = postgresTestSchemaPrefix();
  return async () => {
    const db = makePostgresDb(url, 'public', 1);
    try {
      // `starts_with`, not LIKE: the prefix's `_` would be a single-character wildcard there.
      const { rows } = (await db.rawQuery(
        'select nspname from pg_namespace where starts_with(nspname, ?)',
        [prefix],
      )) as { rows: Array<{ nspname: string }> };
      for (const { nspname } of rows) {
        await db.rawQuery(`drop schema if exists "${nspname.replaceAll('"', '""')}" cascade`);
      }
    } finally {
      await db.manager.closeAll();
    }
  };
}
