import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { makeIsolatedPostgresDb } from '../transports/db-helpers.js';
import { createDurableTables } from './lucid-schema.js';

/**
 * Build a standalone Lucid `Database` pointed at an in-memory SQLite (`better-sqlite3`) — the
 * "using Lucid outside an app" pattern. We construct `Database(config, logger, emitter)` directly
 * (the same three args Lucid's provider passes) so the store can be exercised against real SQL with
 * no AdonisJS app boot.
 */
export function makeMemoryDb(): Database {
  const logger = new Logger({ enabled: false });
  // Database needs an Emitter; in standalone use a minimal app stand-in is enough (the emitter only
  // fans out `db:query` events, which we don't subscribe to here).
  const emitter = new Emitter(undefined as never);
  const db = new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: {
          client: 'better-sqlite3',
          connection: { filename: ':memory:' },
          useNullAsDefault: true,
          // A `:memory:` SQLite db is per-connection: a pool of N would give N independent empty
          // databases. Pin the pool to a single connection so every query (and the schema we create)
          // hits the same in-memory db.
          pool: { min: 1, max: 1 },
        },
      },
    },
    logger,
    emitter,
  );
  return db;
}

/** A fresh in-memory db with the durable tables already created. */
export async function makeStoreDb(): Promise<Database> {
  const db = makeMemoryDb();
  await createDurableTables(db);
  return db;
}

/** A fresh isolated Postgres schema (see `makeIsolatedPostgresDb`) with the durable tables created. */
export async function makePostgresStoreDb(url: string): Promise<Database> {
  const db = await makeIsolatedPostgresDb(url);
  await createDurableTables(db);
  return db;
}
