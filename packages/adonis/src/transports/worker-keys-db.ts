import type { Database } from '@adonisjs/lucid/database';
import { createWorkerKeysTable, WORKER_KEYS_TABLE } from './db-schema.js';
import type { WorkerKeyStore } from './worker-keys.js';

export interface LucidWorkerKeysOptions {
  /** Lucid connection name to use. Defaults to the `Database` default connection. */
  connectionName?: string | undefined;
  /** Create the worker-key table on first use if missing. Default true. */
  autoCreate?: boolean | undefined;
  /** Clock (epoch ms) used to sweep expired keys on write. Default `Date.now`. */
  now?: (() => number) | undefined;
}

/**
 * A {@link WorkerKeyStore} over the app's database: the `durable_transport_worker_keys` table (`key`
 * PK, `value`, `expires_at`). A write upserts its key and sweeps the expired ones. Shared by the db
 * transport and the queue transport, whose queues hold no key a control plane could read back.
 */
export function lucidWorkerKeys(db: Database, opts: LucidWorkerKeysOptions = {}): WorkerKeyStore {
  const client = () => (opts.connectionName ? db.connection(opts.connectionName) : db.connection());
  const now = opts.now ?? Date.now;
  let schemaReady: Promise<void> | undefined;
  const ensureSchema = (): Promise<void> => {
    if (opts.autoCreate === false) return Promise.resolve();
    schemaReady ??= createWorkerKeysTable(db);
    return schemaReady;
  };
  return {
    put: async (key, value, expiresAt) => {
      await ensureSchema();
      await client().from(WORKER_KEYS_TABLE).where('expires_at', '<=', now()).delete();
      await client()
        .insertQuery()
        .table(WORKER_KEYS_TABLE)
        .knexQuery.insert({ key, value, expires_at: expiresAt })
        .onConflict('key')
        .merge();
    },
    remove: async (keys) => {
      if (keys.length === 0) return;
      await ensureSchema();
      await client().from(WORKER_KEYS_TABLE).whereIn('key', keys).delete();
    },
    live: async (at) => {
      await ensureSchema();
      return (await client()
        .from(WORKER_KEYS_TABLE)
        .where('expires_at', '>', at)
        .select('key', 'value')) as { key: string; value: string }[];
    },
  };
}
