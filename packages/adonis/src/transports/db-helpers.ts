import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { createDurableTransportTables } from './db-schema.js';

/**
 * Build a standalone Lucid `Database` over an in-memory SQLite (`better-sqlite3`) — the "using Lucid
 * outside an app" pattern. We construct `Database(config, logger, emitter)` directly (the three args
 * Lucid's provider passes) so the transport runs against real SQL with no AdonisJS app boot.
 */
export function makeMemoryDb(): Database {
  const logger = new Logger({ enabled: false });
  const emitter = new Emitter(undefined as never);
  return new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: {
          client: 'better-sqlite3',
          connection: { filename: ':memory:' },
          useNullAsDefault: true,
          // A `:memory:` SQLite db is per-connection: pin the pool to ONE connection so every query
          // (and the schema) hits the same in-memory database.
          pool: { min: 1, max: 1 },
        },
      },
    },
    logger,
    emitter,
  );
}

/** A fresh in-memory db with the transport tables already created. */
export async function makeTransportDb(): Promise<Database> {
  const db = makeMemoryDb();
  await createDurableTransportTables(db);
  return db;
}

/**
 * Prefix of the throwaway schemas {@link makeIsolatedPostgresDb} creates. The test suite's global
 * teardown drops every schema carrying it, so a run that crashed mid-file leaves nothing behind.
 */
export const POSTGRES_TEST_SCHEMA_PREFIX = 'durable_t_';

/**
 * Connections per Postgres test pool. Small on purpose: test files run in parallel (and the
 * multi-process scenarios fork workers, each with its own pool), and a slow machine makes every pool
 * grow to its max, so a pool of 10 per database exhausted the server's `max_connections` in CI.
 */
export const POSTGRES_TEST_POOL_MAX = 3;

/**
 * A standalone Lucid `Database` over Postgres (`pg`), every query scoped to `schema` through the
 * connection's `search_path` — the Postgres twin of {@link makeMemoryDb}. The schema must exist (see
 * {@link makeIsolatedPostgresDb}); this only connects. Used by tests and by the child processes the
 * multi-process transport tests spawn against a schema their parent created.
 */
export function makePostgresDb(
  url: string,
  schema: string,
  poolMax: number = POSTGRES_TEST_POOL_MAX,
): Database {
  const logger = new Logger({ enabled: false });
  const emitter = new Emitter(undefined as never);
  return new Database(
    {
      connection: 'pg',
      connections: {
        pg: {
          client: 'pg',
          connection: { connectionString: url },
          searchPath: [schema],
          pool: { min: 0, max: poolMax },
        },
      },
    },
    logger,
    emitter,
  );
}

/**
 * A fresh, EMPTY Postgres database for one test: a new schema (unique per call, so test files running
 * in parallel never see each other's tables) and a `Database` scoped to it. `db.manager.closeAll()`
 * drops the schema before closing — the same "gone when closed" lifetime a `:memory:` SQLite db has.
 * `keepSchema` leaves it (the caller drops it), and `schema` reports its name, for tests that hand it
 * to child processes.
 */
export async function makeIsolatedPostgresDb(
  url: string,
  opts: { keepSchema?: boolean } = {},
): Promise<Database & { schemaName: string }> {
  const schema = `${POSTGRES_TEST_SCHEMA_PREFIX}${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  const db = makePostgresDb(url, schema) as Database & { schemaName: string };
  db.schemaName = schema;
  await db.rawQuery(`create schema "${schema}"`);
  if (!opts.keepSchema) {
    const closeAll = db.manager.closeAll.bind(db.manager);
    let dropped = false;
    db.manager.closeAll = async (...args: Parameters<typeof closeAll>) => {
      if (!dropped) {
        dropped = true;
        await db.rawQuery(`drop schema if exists "${schema}" cascade`).catch(() => {});
      }
      return closeAll(...args);
    };
  }
  return db;
}

/** A fresh isolated Postgres schema with the transport tables already created. */
export async function makePostgresTransportDb(url: string): Promise<Database> {
  const db = await makeIsolatedPostgresDb(url);
  await createDurableTransportTables(db);
  return db;
}
