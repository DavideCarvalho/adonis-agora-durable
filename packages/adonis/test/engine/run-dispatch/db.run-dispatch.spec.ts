import type { Database } from '@adonisjs/lucid/database';
import { describe } from 'vitest';
import { runRunDispatchContract } from '../../../src/testing-kit/conformance.js';
import { DbTransport } from '../../../src/transports/db.js';
import { dbBackends } from '../../support/backends.js';

// The run queue of the db transport (`run` rows in the messages table), on SQLite and, when
// DURABLE_PG_URL is set, on Postgres. Two transports over one database are two instances.
describe.each(dbBackends({ mysql: true }))('db transport on $name', ({ makeMemoryDb }) => {
  let db: Database | undefined;
  runRunDispatchContract('DbTransport', {
    setup: async () => {
      db = await makeMemoryDb();
    },
    make: () => new DbTransport({ db: db as Database, pollIntervalMs: 5 }),
    teardown: async () => {
      await db?.manager.closeAll();
      db = undefined;
    },
  });
});
