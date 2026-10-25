import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { createDurableTables } from '../../src/stores/lucid-schema.js';
import { POSTGRES_TEST_SCHEMA_PREFIX } from '../../src/transports/db-helpers.js';
import { createDurableTransportTables } from '../../src/transports/db-schema.js';

/**
 * The prefix of THIS test run's throwaway MySQL databases: `durable_t_` plus the run id the global
 * setup puts in `DURABLE_MYSQL_TEST_RUN`, so the teardown (test/setup/mysql-cleanup.ts) drops only
 * this run's databases.
 */
export function mysqlTestDatabasePrefix(): string {
  const run = process.env.DURABLE_MYSQL_TEST_RUN;
  return run ? `${POSTGRES_TEST_SCHEMA_PREFIX}${run}_` : POSTGRES_TEST_SCHEMA_PREFIX;
}

/** Connections per MySQL test pool: small, for the same reason as the Postgres pools. */
const MYSQL_TEST_POOL_MAX = 3;

/** A standalone Lucid `Database` over MySQL (`mysql2`) on `database` of the server at `url`. */
export function makeMysqlDb(
  url: string,
  database: string | undefined,
  poolMax: number = MYSQL_TEST_POOL_MAX,
): Database {
  const parsed = new URL(url);
  return new Database(
    {
      connection: 'mysql',
      connections: {
        mysql: {
          client: 'mysql2',
          connection: {
            host: parsed.hostname,
            port: parsed.port ? Number(parsed.port) : 3306,
            user: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password),
            ...(database ? { database } : {}),
          },
          pool: { min: 0, max: poolMax },
        },
      },
    },
    new Logger({ enabled: false }),
    new Emitter(undefined as never),
  );
}

/**
 * A fresh, EMPTY MySQL database for one test (MySQL has no schemas inside a database, so each test
 * gets a database of its own), dropped by `db.manager.closeAll()` — the MySQL twin of
 * `makeIsolatedPostgresDb`. `url` is `mysql://user:password@host:port`; a database in its path is
 * ignored.
 */
export async function makeIsolatedMysqlDb(
  url: string,
): Promise<Database & { databaseName: string }> {
  const name = `${mysqlTestDatabasePrefix()}${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  const admin = makeMysqlDb(url, undefined);
  try {
    await admin.rawQuery(`create database \`${name}\``);
  } finally {
    await admin.manager.closeAll();
  }
  const db = makeMysqlDb(url, name) as Database & { databaseName: string };
  db.databaseName = name;
  const closeAll = db.manager.closeAll.bind(db.manager);
  let dropped = false;
  db.manager.closeAll = async (...args: Parameters<typeof closeAll>) => {
    if (!dropped) {
      dropped = true;
      await db.rawQuery(`drop database if exists \`${name}\``).catch(() => {});
    }
    return closeAll(...args);
  };
  return db;
}

export async function makeMysqlStoreDb(url: string): Promise<Database> {
  const db = await makeIsolatedMysqlDb(url);
  await createDurableTables(db);
  return db;
}

export async function makeMysqlTransportDb(url: string): Promise<Database> {
  const db = await makeIsolatedMysqlDb(url);
  await createDurableTransportTables(db);
  return db;
}
