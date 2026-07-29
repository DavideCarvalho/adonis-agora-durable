import type { Database } from '@adonisjs/lucid/database';

/**
 * The canonical durable table names. They match the cross-adapter snake_case contract the other
 * Agora/aviary stores use (Drizzle is the reference), so a dashboard or migration can be pointed at
 * any adapter and see the same physical schema.
 */
export const DURABLE_TABLES = {
  runs: 'durable_workflow_runs',
  checkpoints: 'durable_step_checkpoints',
  attributes: 'durable_run_attributes',
  signalWaiters: 'durable_signal_waiters',
  bufferedSignals: 'durable_buffered_signals',
  bufferedEvents: 'durable_buffered_events',
} as const;

/**
 * Where {@link createDurableTables} reports an APPLIED repair. Structurally satisfied by `console`
 * (the default) and by AdonisJS's `Logger`, so an app can route the warning into its own log stream
 * without this module depending on either.
 */
export interface DurableSchemaLogger {
  warn(message: string): void;
}

export interface CreateDurableTablesOptions {
  /** Sink for the applied-repair warning. Defaults to `console`. */
  logger?: DurableSchemaLogger;
}

/**
 * The warning {@link createDurableTables} emits when it actually `ALTER`ed something.
 *
 * Only on an APPLIED repair — never when every column was already there. Two defensive behaviours
 * combined to make a wrong migration-managed schema completely undetectable: the heartbeat write is
 * fire-and-forget (`.catch(() => undefined)` in the engine, which is correct — a lost liveness
 * update never harms the run) and this function silently added the missing column at every boot. A
 * warning that fired on every boot regardless would be filtered as noise and would restore exactly
 * that vacuum, so the discriminator matters more than the wording.
 */
function repairWarning(repairs: string[]): string {
  return [
    `@adonis-agora/durable: repaired the durable schema in place — added ${repairs.join(', ')}.`,
    'The database was behind the installed library version, so these columns were added at runtime',
    'and nothing recorded it in your migration history. To record it (and to stop depending on the',
    'runtime repair), add a migration that calls `createDurableTables(db, this.db.connectionName)`',
    "with `db` from '@adonisjs/lucid/services/db' — the same call the generated",
    'create_durable_tables migration makes. This warning appears only when a repair was actually',
    'applied; a schema that is already current logs nothing.',
  ].join(' ');
}

/**
 * Idempotent DDL for the durable tables, expressed via Lucid's schema builder (Knex). Works across
 * SQLite / Postgres / MySQL. Timestamps and `wake_at` are stored as epoch-ms `bigInteger` columns so
 * the store never depends on a native date type and replay is exact across engines. JSON payloads
 * (`input`/`output`/`error`/`events`/`tags`/`search_attributes`) are stored as `text` and (de)serialized
 * by the store, so the schema is portable (SQLite has no JSON column type; Postgres/MySQL accept text).
 *
 * Call this on boot (e.g. from a `StateStore.ensureSchema`) or once at deploy time. For an AdonisJS app
 * prefer the published migration (`node ace configure @adonis-agora/durable`); this helper is for standalone
 * use, tests, and `ensureSchema`.
 *
 * Pass `connectionName` to provision the tables on a dedicated Lucid connection — it must match the
 * connection the store reads/writes on, or `ensureSchema` would create the tables where the store
 * never looks. Omit it to use the `Database` default connection.
 *
 * Creating tables from scratch is silent. REPAIRING an existing table — adding a column a previous
 * version of this schema did not have — emits one `warn` naming every column it added, because that
 * means the caller's migration-managed schema is behind the library and only works thanks to this
 * repair. Pass `options.logger` to route it; it defaults to `console`.
 */
export async function createDurableTables(
  db: Database,
  connectionName?: string,
  options: CreateDurableTablesOptions = {},
): Promise<void> {
  // Knex's schema builder is stateful — operations chained on one instance run together. Take a FRESH
  // `db.connection(connectionName).schema` for every hasTable/createTable so each DDL statement executes
  // exactly once, all on the store's own connection.
  const conn = () => db.connection(connectionName).schema;

  // `<table>.<column>` for every ALTER actually issued below. Stays empty on the fresh-install path
  // (a missing table is CREATEd whole and never reaches a `hasColumn` branch), which is what makes
  // the warning at the end mean "your schema was wrong" instead of "boot happened".
  const repairs: string[] = [];

  if (!(await conn().hasTable(DURABLE_TABLES.runs))) {
    await conn().createTable(DURABLE_TABLES.runs, (table) => {
      table.string('id').primary();
      table.string('workflow').notNullable();
      table.string('workflow_version').notNullable();
      table.string('status').notNullable();
      table.string('namespace').notNullable().defaultTo('default');
      table.text('input');
      table.text('output');
      table.text('error');
      table.bigInteger('wake_at');
      table.string('locked_by');
      table.bigInteger('locked_until');
      table.integer('recovery_attempts');
      table.text('tags');
      table.text('search_attributes');
      table.integer('priority');
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
      table.index(['status'], 'durable_runs_status_idx');
      table.index(['status', 'wake_at'], 'durable_runs_due_idx');
      // Worker-pool partition: scopes the poll/recovery queries (namespace + status + createdAt).
      table.index(['namespace', 'status', 'created_at'], 'durable_runs_namespace_idx');
    });
  } else {
    // Auto-migrate an older runs table by adding any columns introduced after its creation. Each is
    // applied independently so a table missing several catches up. Mirrors the in-place pattern other
    // adapters use; new columns are nullable / carry a DEFAULT so existing rows read back unchanged.
    if (!(await conn().hasColumn(DURABLE_TABLES.runs, 'priority'))) {
      // Nullable (no default) so existing rows read back as "unprioritised" and the FIFO path is unchanged.
      await conn().alterTable(DURABLE_TABLES.runs, (table) => {
        table.integer('priority');
      });
      repairs.push(`${DURABLE_TABLES.runs}.priority`);
    }
    if (!(await conn().hasColumn(DURABLE_TABLES.runs, 'namespace'))) {
      // DEFAULT 'default' so every pre-namespace row reads back in the reserved 'default' partition —
      // byte-identical behavior for a single-pool deploy that adds the column.
      await conn().alterTable(DURABLE_TABLES.runs, (table) => {
        table.string('namespace').notNullable().defaultTo('default');
        table.index(['namespace', 'status', 'created_at'], 'durable_runs_namespace_idx');
      });
      repairs.push(`${DURABLE_TABLES.runs}.namespace`);
    }
  }

  if (!(await conn().hasTable(DURABLE_TABLES.checkpoints))) {
    await conn().createTable(DURABLE_TABLES.checkpoints, (table) => {
      table.string('run_id').notNullable();
      table.integer('seq').notNullable();
      table.string('name').notNullable();
      table.string('kind').notNullable();
      table.string('step_id').notNullable();
      table.string('status').notNullable();
      table.text('input');
      table.text('output');
      table.text('error');
      table.text('events');
      table.integer('attempts').notNullable();
      table.string('worker_group');
      table.bigInteger('wake_at');
      table.string('parallel_group');
      table.bigInteger('enqueued_at');
      table.bigInteger('started_at').notNullable();
      table.bigInteger('finished_at').notNullable();
      table.bigInteger('last_heartbeat_at');
      table.text('heartbeat_progress');
      table.primary(['run_id', 'seq']);
      table.index(['run_id', 'name'], 'durable_checkpoints_name_idx');
    });
  } else {
    if (!(await conn().hasColumn(DURABLE_TABLES.checkpoints, 'parallel_group'))) {
      // Auto-migrate an older checkpoints table: add the nullable `parallel_group` column in place.
      // Nullable (no default) so a legacy (non-parallel) checkpoint reads back untagged.
      await conn().alterTable(DURABLE_TABLES.checkpoints, (table) => {
        table.string('parallel_group');
      });
      repairs.push(`${DURABLE_TABLES.checkpoints}.parallel_group`);
    }
    if (!(await conn().hasColumn(DURABLE_TABLES.checkpoints, 'last_heartbeat_at'))) {
      // Heartbeat-persistence wave: nullable, so a step whose handler never beats reads back with
      // no liveness claim (absent ≠ silent-since-epoch).
      await conn().alterTable(DURABLE_TABLES.checkpoints, (table) => {
        table.bigInteger('last_heartbeat_at');
        table.text('heartbeat_progress');
      });
      // Both columns land in one ALTER, so both are reported — the operator needs the column list,
      // not the statement count.
      repairs.push(
        `${DURABLE_TABLES.checkpoints}.last_heartbeat_at`,
        `${DURABLE_TABLES.checkpoints}.heartbeat_progress`,
      );
    }
  }

  if (!(await conn().hasTable(DURABLE_TABLES.attributes))) {
    await conn().createTable(DURABLE_TABLES.attributes, (table) => {
      table.string('run_id').notNullable();
      table.string('key').notNullable();
      table.string('str_value');
      table.double('num_value');
      table.primary(['run_id', 'key']);
      table.index(['key', 'num_value'], 'durable_run_attributes_num_idx');
      table.index(['key', 'str_value'], 'durable_run_attributes_str_idx');
    });
  }

  if (!(await conn().hasTable(DURABLE_TABLES.signalWaiters))) {
    await conn().createTable(DURABLE_TABLES.signalWaiters, (table) => {
      table.string('token').primary();
      table.string('run_id').notNullable();
      table.integer('seq').notNullable();
      table.string('parallel_group');
    });
  } else if (!(await conn().hasColumn(DURABLE_TABLES.signalWaiters, 'parallel_group'))) {
    // Auto-migrate an older signal_waiters table: add the nullable `parallel_group` column in place.
    // Nullable (no default) so a legacy (non-fan) waiter reads back untagged and the await is unchanged.
    await conn().alterTable(DURABLE_TABLES.signalWaiters, (table) => {
      table.string('parallel_group');
    });
    repairs.push(`${DURABLE_TABLES.signalWaiters}.parallel_group`);
  }

  if (!(await conn().hasTable(DURABLE_TABLES.bufferedSignals))) {
    await conn().createTable(DURABLE_TABLES.bufferedSignals, (table) => {
      table.increments('id').primary();
      table.string('token').notNullable();
      table.text('payload');
      table.index(['token'], 'durable_buffered_signals_token_idx');
    });
  }

  // Reliable (buffered) events: a publish that matched NO live waiter keeps ONE copy here, consumed
  // by the first future matching `waitForEvent`. Keyed by `name` (not token) since many waiters can
  // share a name with different `match` criteria; the caller-minted `id` is the PK so a claim targets
  // an exact row. `published_at` is epoch-ms (for oldest-first scan + optional TTL pruning).
  if (!(await conn().hasTable(DURABLE_TABLES.bufferedEvents))) {
    await conn().createTable(DURABLE_TABLES.bufferedEvents, (table) => {
      table.string('id').primary();
      table.string('name').notNullable();
      table.text('payload');
      table.bigInteger('published_at').notNullable();
      table.index(['name', 'published_at'], 'durable_buffered_events_name_idx');
    });
  }

  // ONE warning for the whole call, listing every column added, or none at all. Not one per ALTER:
  // an operator needs to know their schema was behind and by what, and a burst of lines is easier to
  // lose than a single one.
  if (repairs.length > 0) {
    (options.logger ?? console).warn(repairWarning(repairs));
  }
}

/** Drop every durable table (reverse FK order). Used by tests and migration `down`. */
export async function dropDurableTables(db: Database, connectionName?: string): Promise<void> {
  const conn = () => db.connection(connectionName).schema;
  await conn().dropTableIfExists(DURABLE_TABLES.bufferedEvents);
  await conn().dropTableIfExists(DURABLE_TABLES.bufferedSignals);
  await conn().dropTableIfExists(DURABLE_TABLES.signalWaiters);
  await conn().dropTableIfExists(DURABLE_TABLES.attributes);
  await conn().dropTableIfExists(DURABLE_TABLES.checkpoints);
  await conn().dropTableIfExists(DURABLE_TABLES.runs);
}
