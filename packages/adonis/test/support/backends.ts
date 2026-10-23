import { randomUUID } from 'node:crypto';
import type { Database } from '@adonisjs/lucid/database';
import { makePostgresStoreDb, makeStoreDb } from '../../src/stores/lucid-helpers.js';
import {
  makeIsolatedPostgresDb,
  makeMemoryDb,
  makePostgresTransportDb,
  makeTransportDb,
} from '../../src/transports/db-helpers.js';
import { makeIsolatedMysqlDb, makeMysqlStoreDb, makeMysqlTransportDb } from './mysql.js';

/**
 * The real backends the suite runs against, and the guard that keeps CI from silently skipping them.
 *
 * Locally, a suite whose backend env var is unset skips (no infrastructure needed to run the suite).
 * In CI (`CI` set) the same miss is an ERROR thrown while the file is collected: a renamed variable or
 * a dropped service must turn the run red, not quietly shrink it back to SQLite and in-memory fakes.
 */

/** The env vars naming a real backend. */
export type BackendEnv = 'REDIS_URL' | 'DURABLE_REDIS_URL' | 'DURABLE_PG_URL' | 'DURABLE_MYSQL_URL';

/**
 * The URL of a real backend, or `undefined` to skip — except in CI, where a missing one throws.
 * Call it at the top level of a spec file so the throw fails that file at collection.
 */
export function backendUrl(name: BackendEnv): string | undefined {
  const value = process.env[name];
  if (value) return value;
  if (process.env.CI) {
    throw new Error(
      `${name} is not set, and CI is: the suites gated on it must run against the real backend in CI ` +
        `instead of skipping. Set ${name} (see the services in .github/workflows/ci.yml).`,
    );
  }
  return undefined;
}

/** A Lucid database backend the db transport and the Lucid store are exercised on. */
export interface DbBackend {
  name: 'sqlite' | 'postgres' | 'mysql';
  /** An empty database (no tables). */
  makeMemoryDb(): Promise<Database>;
  /** A database with the transport tables created. */
  makeTransportDb(): Promise<Database>;
  /** A database with the durable store tables created. */
  makeStoreDb(): Promise<Database>;
}

const sqlite: DbBackend = {
  name: 'sqlite',
  makeMemoryDb: async () => makeMemoryDb(),
  makeTransportDb,
  makeStoreDb,
};

function postgres(url: string): DbBackend {
  return {
    name: 'postgres',
    makeMemoryDb: () => makeIsolatedPostgresDb(url),
    makeTransportDb: () => makePostgresTransportDb(url),
    makeStoreDb: () => makePostgresStoreDb(url),
  };
}

/**
 * SQLite always, plus Postgres when `DURABLE_PG_URL` is set (required in CI), plus — for a spec that
 * passes `{ mysql: true }` — MySQL when `DURABLE_MYSQL_URL` is set (required in CI then). Each Postgres database
 * is a fresh schema dropped when the database is closed, so parallel files never share tables.
 * Use with `describe.each(dbBackends())('... on $name', (backend) => ...)`.
 */
export function dbBackends(opts: { mysql?: boolean } = {}): DbBackend[] {
  const url = backendUrl('DURABLE_PG_URL');
  const backends = url ? [sqlite, postgres(url)] : [sqlite];
  if (opts.mysql) {
    const mysqlUrl = backendUrl('DURABLE_MYSQL_URL');
    if (mysqlUrl) backends.push(mysql(mysqlUrl));
  }
  return backends;
}

/** MySQL (`DURABLE_MYSQL_URL`, `mysql://user:password@host:port`), one database per test. */
function mysql(url: string): DbBackend {
  return {
    name: 'mysql',
    makeMemoryDb: () => makeIsolatedMysqlDb(url),
    makeTransportDb: () => makeMysqlTransportDb(url),
    makeStoreDb: () => makeMysqlStoreDb(url),
  };
}

/** A key prefix unique to this test file's process, for suites that share one Redis. */
export function uniqueRedisPrefix(label: string): string {
  return `${label}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

/** Delete every key starting with `prefix` (instead of FLUSHALL, which would wipe parallel files). */
export async function deleteRedisKeys(
  redis: {
    scan(
      cursor: string,
      match: 'MATCH',
      pattern: string,
      count: 'COUNT',
      n: number,
    ): Promise<[string, string[]]>;
    del(...keys: string[]): Promise<unknown>;
  },
  prefix: string,
): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}
