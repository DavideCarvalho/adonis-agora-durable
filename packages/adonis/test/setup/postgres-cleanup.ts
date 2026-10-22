import { makePostgresDb, POSTGRES_TEST_SCHEMA_PREFIX } from '../../src/transports/db-helpers.js';

/**
 * Global teardown for the Postgres-backed suites: every test database is a throwaway schema that its
 * test drops on close, but a file that crashed (or timed out) before closing would leave one behind.
 * After the run, drop every schema carrying the test prefix. No-op without `DURABLE_PG_URL`.
 */
export default function globalSetup(): (() => Promise<void>) | undefined {
  const url = process.env.DURABLE_PG_URL;
  if (!url) return undefined;
  return async () => {
    const db = makePostgresDb(url, 'public');
    try {
      const { rows } = (await db.rawQuery('select nspname from pg_namespace where nspname like ?', [
        `${POSTGRES_TEST_SCHEMA_PREFIX}%`,
      ])) as { rows: Array<{ nspname: string }> };
      for (const { nspname } of rows) {
        await db.rawQuery(`drop schema if exists "${nspname}" cascade`);
      }
    } finally {
      await db.manager.closeAll();
    }
  };
}
