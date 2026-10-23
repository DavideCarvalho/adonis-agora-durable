import { randomUUID } from 'node:crypto';
import { makeMysqlDb, mysqlTestDatabasePrefix } from '../support/mysql.js';

/**
 * Global teardown for the MySQL-backed suites, the twin of `postgres-cleanup.ts`: every test database
 * is dropped by its test on close, but a file that crashed before closing would leave one behind.
 * After the run, drop every database carrying THIS run's prefix. No-op without `DURABLE_MYSQL_URL`.
 */
export default function globalSetup(): (() => Promise<void>) | undefined {
  const url = process.env.DURABLE_MYSQL_URL;
  if (!url) return undefined;
  process.env.DURABLE_MYSQL_TEST_RUN ??= randomUUID().replaceAll('-', '').slice(0, 8);
  const prefix = mysqlTestDatabasePrefix();
  return async () => {
    const db = makeMysqlDb(url, undefined);
    try {
      const [rows] = (await db.rawQuery(
        'select schema_name as name from information_schema.schemata where left(schema_name, ?) = ?',
        [prefix.length, prefix],
      )) as [Array<{ name: string }>];
      for (const { name } of rows) {
        await db.rawQuery(`drop database if exists \`${name.replaceAll('`', '``')}\``);
      }
    } finally {
      await db.manager.closeAll();
    }
  };
}
