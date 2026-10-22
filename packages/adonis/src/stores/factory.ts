import type { Database } from '@adonisjs/lucid/database';
import type { StateStore } from '../interfaces.js';
import { resolveLucidDatabase } from '../resolve-lucid-db.js';
import type { TransportContext } from '../transports/factory.js';

/**
 * The runtime context a {@link StoreFactory} thunk receives when the durable provider builds the
 * configured state store at boot. Shares {@link TransportContext} so a driver can resolve a peer's
 * service (the Lucid `db`) from the booted application if it needs to.
 */
export type StoreContext = TransportContext;

/**
 * A configured state store: a thunk the durable provider calls at boot to build the {@link StateStore}.
 * Each factory lazily imports its peer dependency (`@adonisjs/lucid`) inside the thunk, so the driver
 * is only loaded when it is actually selected — keeping that package optional.
 */
export type StoreFactory = (ctx: StoreContext) => Promise<StateStore>;

/** Options for the Lucid-backed persistent store. */
export interface LucidStoreConfig {
  /** Lucid connection name to use. Defaults to the `Database` default connection. */
  connection?: string;
  /**
   * MySQL/MariaDB only: the collation the durable tables use — new tables are created with it and
   * existing ones are converted to it at boot. Set it to your own tables' collation (e.g.
   * `'utf8mb4_unicode_ci'`) so a JOIN against them doesn't fail with `Illegal mix of collations`.
   */
  collation?: string;
}

/**
 * The store factory namespace used in `config/durable.ts`:
 *
 * ```ts
 * import { defineConfig, stores } from '@adonis-agora/durable'
 *
 * export default defineConfig({
 *   store: 'lucid',
 *   stores: {
 *     lucid: stores.lucid({ connection: 'pg' }),
 *   },
 * })
 * ```
 *
 * Each factory returns a {@link StoreFactory} — a lazy thunk. Calling it in the config file costs
 * nothing; the peer dependency is only imported when the provider builds the selected store at boot.
 * Omit `store` entirely to use the in-process `InMemoryStateStore` (single-process, no extra infra).
 */
export const stores = {
  /** Persist runs/checkpoints/timers/signals in SQL via `@adonisjs/lucid`. */
  lucid(config: LucidStoreConfig = {}): StoreFactory {
    return async (ctx) => {
      const db = (await resolveLucidDatabase(ctx)) as Database;
      const { LucidStateStore } = await import('./lucid.js');
      return new LucidStateStore(db, {
        ...(config.connection !== undefined ? { connectionName: config.connection } : {}),
        ...(config.collation !== undefined ? { collation: config.collation } : {}),
      });
    };
  },
};
