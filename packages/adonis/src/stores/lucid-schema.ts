import { createHash } from 'node:crypto';
import type { Database } from '@adonisjs/lucid/database';
import type { QueryClientContract } from '@adonisjs/lucid/types/database';

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
  schedules: 'durable_schedules',
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
  /**
   * MySQL/MariaDB only: the collation the durable tables must use (e.g. `'utf8mb4_unicode_ci'`).
   * New tables are created with it, and an existing durable table whose collation differs is
   * `CONVERT`ed to it. Set it to the collation your own tables use: a JOIN between a durable table and
   * an app table with a different collation fails with `Illegal mix of collations`. Defaults to the
   * Knex connection's `collate` setting when it has one; with neither, the server default is left
   * alone. Ignored on Postgres and SQLite.
   */
  collation?: string;
  /**
   * Run the full check even when the stored schema fingerprint says the tables are current (see
   * {@link DURABLE_SCHEMA_META_TABLE}). For a database whose durable tables were changed by hand.
   */
  force?: boolean;
}

/**
 * The table where {@link createDurableTables} records which schema it last applied: one row
 * (`id = 'durable'`) holding a fingerprint of {@link DURABLE_SCHEMA_REVISION} and the options that
 * shape the DDL. When the row matches, a boot reads that row and returns without probing a single
 * table, column or index. A missing or different row runs the full, additive check under a
 * cross-process lock, then rewrites the row. Dropped by {@link dropDurableTables}.
 */
export const DURABLE_SCHEMA_META_TABLE = 'durable_schema_meta';

/**
 * The revision of the DDL in this file. Bump it with every change to what {@link createDurableTables}
 * creates or repairs: the new value changes the fingerprint, so every database runs the full check
 * once on its next boot and then goes back to the one-row read. A test pins the SQLite DDL to this
 * number, so a schema change without a bump fails CI.
 */
export const DURABLE_SCHEMA_REVISION = 3;

const SCHEMA_META_ROW = 'durable';

/** Advisory-lock key for the Postgres heal (`pg_advisory_xact_lock`): "dura" "ble" as a bigint. */
const PG_SCHEMA_LOCK_KEY = 7_310_315_633_779_045;

/** Seconds a MySQL boot waits for a sibling's heal (`GET_LOCK`) before checking without the lock. */
const MYSQL_SCHEMA_LOCK_TIMEOUT_S = 60;

/**
 * The columns that hold free-form JSON payloads. They are `longtext` on MySQL, where `text` stops at
 * 64KB and a longer value is cut off (strict mode rejects the write; non-strict silently truncates
 * it, and the row then fails to parse on read). Postgres and SQLite `text` has no such limit.
 * `notNull` lists the ones declared `NOT NULL`, which a MySQL `MODIFY` must restate.
 */
export const DURABLE_JSON_COLUMNS: Record<string, { columns: string[]; notNull?: string[] }> = {
  [DURABLE_TABLES.runs]: { columns: ['input', 'output', 'error', 'tags', 'search_attributes'] },
  [DURABLE_TABLES.checkpoints]: {
    columns: ['input', 'output', 'error', 'events', 'heartbeat_progress'],
  },
  [DURABLE_TABLES.bufferedSignals]: { columns: ['payload'] },
  [DURABLE_TABLES.bufferedEvents]: { columns: ['payload'] },
  [DURABLE_TABLES.schedules]: { columns: ['tags', 'spec', 'state'], notNull: ['spec', 'state'] },
};

/** A collation name we are willing to put in DDL. */
function safeCollation(value: string | undefined): string | undefined {
  return value !== undefined && /^[A-Za-z0-9_]+$/.test(value) ? value : undefined;
}

/** The collation to align MySQL tables to: the explicit option, else the Knex connection's `collate`. */
function configuredCollation(
  client: QueryClientContract,
  options: CreateDurableTablesOptions,
): string | undefined {
  if (options.collation !== undefined) return safeCollation(options.collation);
  const settings = (
    client.getWriteClient() as unknown as {
      client?: { connectionSettings?: { collate?: unknown } };
    }
  ).client?.connectionSettings;
  return typeof settings?.collate === 'string' ? safeCollation(settings.collate) : undefined;
}

/** What the stored marker must equal for a boot to skip the check. */
function schemaFingerprint(collation: string | undefined): string {
  return createHash('sha256')
    .update(`rev=${DURABLE_SCHEMA_REVISION}|collation=${collation ?? ''}`)
    .digest('hex');
}

async function readSchemaFingerprint(client: QueryClientContract): Promise<string | undefined> {
  if (!(await client.schema.hasTable(DURABLE_SCHEMA_META_TABLE))) return undefined;
  const q = client
    .query()
    .from(DURABLE_SCHEMA_META_TABLE)
    .select('fingerprint')
    .where('id', SCHEMA_META_ROW);
  // A locking read on MySQL: under REPEATABLE READ a plain read could answer from a snapshot older
  // than the sibling heal that just released the lock.
  if (client.dialect.name === 'mysql') q.forUpdate();
  const row = (await q.first()) as { fingerprint?: string | null } | null;
  return row?.fingerprint ?? undefined;
}

async function writeSchemaFingerprint(
  client: QueryClientContract,
  fingerprint: string,
): Promise<void> {
  if (!(await client.schema.hasTable(DURABLE_SCHEMA_META_TABLE))) {
    await client.schema.createTable(DURABLE_SCHEMA_META_TABLE, (table) => {
      table.string('id', 32).primary();
      table.string('fingerprint', 64).notNullable();
      table.bigInteger('applied_at').notNullable();
    });
  }
  await client
    .insertQuery()
    .table(DURABLE_SCHEMA_META_TABLE)
    .knexQuery.insert({ id: SCHEMA_META_ROW, fingerprint, applied_at: Date.now() })
    .onConflict('id')
    .merge();
}

/**
 * Run `work` holding the cross-process schema lock, so pods booting together don't race the same
 * `CREATE TABLE`: Postgres takes `pg_advisory_xact_lock` in a transaction (the DDL runs in it and the
 * lock is released by the commit); MySQL takes `GET_LOCK` on a connection pinned by a transaction
 * (its DDL commits implicitly, the lock is the session's) and releases it after. SQLite, and any
 * other dialect, runs `work` without a lock.
 */
async function withSchemaLock(
  connection: QueryClientContract,
  logger: DurableSchemaLogger,
  work: (client: QueryClientContract) => Promise<void>,
): Promise<void> {
  switch (connection.dialect.name) {
    case 'postgres':
      await connection.transaction(async (trx) => {
        await trx.rawQuery('select pg_advisory_xact_lock(?)', [PG_SCHEMA_LOCK_KEY]);
        await work(trx);
      });
      return;
    case 'mysql':
      await connection.transaction(async (trx) => {
        const result = (await trx.rawQuery(
          "select get_lock(concat('durable_schema:', database()), ?) as got",
          [MYSQL_SCHEMA_LOCK_TIMEOUT_S],
        )) as [Array<{ got: number | string | null }>, unknown];
        const got = Number(result[0]?.[0]?.got) === 1;
        if (!got) {
          logger.warn(
            `@adonis-agora/durable: waited ${MYSQL_SCHEMA_LOCK_TIMEOUT_S}s for the durable schema lock; checking the schema without it.`,
          );
        }
        try {
          await work(trx);
        } finally {
          if (got) {
            await trx
              .rawQuery("select release_lock(concat('durable_schema:', database()))")
              .catch(() => undefined);
          }
        }
      });
      return;
    default:
      await work(connection);
  }
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
    `@adonis-agora/durable: repaired the durable schema in place — added or changed ${repairs.join(', ')}.`,
    'The database was behind the installed library version, so these were added at runtime',
    'and nothing recorded it in your migration history. To record it (and to stop depending on the',
    'runtime repair), add a migration that calls `createDurableTables(db, this.db.connectionName)`',
    "with `db` from '@adonisjs/lucid/services/db' — the same call the generated",
    'create_durable_tables migration makes. This warning appears only when a repair was actually',
    'applied; a schema that is already current logs nothing.',
  ].join(' ');
}

/**
 * Does an index with this name exist in the connection's current schema? Returns `null` for
 * dialects outside the store's three declared targets (SQLite / Postgres / MySQL), which the
 * caller handles by falling back to the legacy best-effort create.
 *
 * The probe is load-bearing, not an optimization: the index-only repair used to `CREATE INDEX`
 * blindly and swallow the `already exists` failure in a `try/catch`. That pattern is safe only
 * in autocommit. INSIDE an open transaction a failed statement aborts the whole transaction
 * (Postgres' 25P02 "current transaction is aborted") — and the swallowed error leaves the caller
 * with a poisoned transaction and zero signal: every later statement on it cascades. A read-only
 * catalog `SELECT` can never fail that way, so the repair never touches the database unless the
 * index is genuinely missing.
 */
async function indexExists(
  connection: QueryClientContract,
  indexName: string,
): Promise<boolean | null> {
  switch (connection.dialect.name) {
    case 'postgres': {
      const rows = await connection
        .query()
        .from('pg_indexes')
        .where('indexname', indexName)
        .andWhereRaw('schemaname = current_schema()')
        .limit(1);
      return rows.length > 0;
    }
    case 'sqlite3':
    case 'better-sqlite3':
    case 'libsql': {
      const rows = await connection
        .query()
        .from('sqlite_master')
        .where('type', 'index')
        .andWhere('name', indexName)
        .limit(1);
      return rows.length > 0;
    }
    case 'mysql': {
      const rows = await connection
        .query()
        .from('information_schema.statistics')
        .where('index_name', indexName)
        .andWhereRaw('table_schema = database()')
        .limit(1);
      return rows.length > 0;
    }
    default:
      return null;
  }
}

/**
 * Idempotent DDL for the durable tables, expressed via Lucid's schema builder (Knex). Works across
 * SQLite / Postgres / MySQL. Timestamps and `wake_at` are stored as epoch-ms `bigInteger` columns so
 * the store never depends on a native date type and replay is exact across engines. JSON payloads
 * (`input`/`output`/`error`/`events`/`tags`/`search_attributes`) are stored as text and (de)serialized
 * by the store, so the schema is portable (SQLite has no JSON column type; Postgres/MySQL accept text).
 * On MySQL those columns are `longtext` (see {@link DURABLE_JSON_COLUMNS}); an existing `text` one is
 * widened in place.
 *
 * Boots are cheap once the schema is current: the call reads one row of
 * {@link DURABLE_SCHEMA_META_TABLE} and returns when its fingerprint matches. Otherwise it checks
 * every table, column and index under a cross-process lock (Postgres advisory lock, MySQL
 * `GET_LOCK`), so pods booting together against a fresh database don't race the same `CREATE TABLE`,
 * and records the fingerprint. A schema changed by hand behind the marker is not re-checked; pass
 * `{ force: true }` for that.
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
  const connection = db.connection(connectionName);
  const logger = options.logger ?? console;
  const collation =
    connection.dialect.name === 'mysql' ? configuredCollation(connection, options) : undefined;
  const expected = schemaFingerprint(collation);
  // The steady-state boot: one catalog probe and one PK read, no per-table checks.
  if (!options.force && (await readSchemaFingerprint(connection)) === expected) return;
  await withSchemaLock(connection, logger, async (client) => {
    // A sibling may have healed while this process waited for the lock.
    if (!options.force && (await readSchemaFingerprint(client)) === expected) return;
    await healDurableTables(client, collation, logger);
    await writeSchemaFingerprint(client, expected);
  });
}

/** The additive check-and-repair behind {@link createDurableTables}, on one client (or transaction). */
async function healDurableTables(
  client: QueryClientContract,
  collation: string | undefined,
  logger: DurableSchemaLogger,
): Promise<void> {
  // Knex's schema builder is stateful — operations chained on one instance run together. Take a FRESH
  // `client.schema` for every hasTable/createTable so each DDL statement executes exactly once, all on
  // the store's own connection (or the lock-holding transaction).
  const conn = () => client.schema;
  const isMysql = client.dialect.name === 'mysql';
  // MySQL: create new tables with the configured collation (CONVERT below aligns existing ones).
  const charset = collation?.split('_')[0];
  const tableCollation = (table: { charset(c: string): void; collate(c: string): void }) => {
    if (!isMysql || !collation || !charset) return;
    table.charset(charset);
    table.collate(collation);
  };

  // `<table>.<column-or-index>` for every ALTER actually issued below. Stays empty on the
  // fresh-install path (a missing table is CREATEd whole and never reaches a `hasColumn` branch),
  // which is what makes the warning at the end mean "your schema was wrong" instead of "boot happened".
  const repairs: string[] = [];

  // Create an index ONLY when the catalog says it is missing (see `indexExists` for why the
  // probe replaced the old create-and-swallow). On dialects the probe doesn't cover, the legacy
  // best-effort path stays — still transaction-unsafe, but only outside the store's declared
  // targets.
  const ensureIndex = async (
    table: string,
    columns: string[],
    indexName: string,
  ): Promise<void> => {
    const known = await indexExists(client, indexName);
    if (known === true) return;
    if (known === null) {
      try {
        await conn().alterTable(table, (indexTable) => indexTable.index(columns, indexName));
      } catch {
        /* the index already exists — expected on every boot after the first */
      }
      return;
    }
    await conn().alterTable(table, (indexTable) => indexTable.index(columns, indexName));
    repairs.push(`${table}.${indexName}`);
  };

  if (!(await conn().hasTable(DURABLE_TABLES.runs))) {
    await conn().createTable(DURABLE_TABLES.runs, (table) => {
      tableCollation(table);
      table.string('id').primary();
      table.string('workflow').notNullable();
      table.string('workflow_version').notNullable();
      table.string('status').notNullable();
      table.string('namespace').notNullable().defaultTo('default');
      table.string('origin');
      table.text('input', 'longtext');
      table.text('output', 'longtext');
      table.text('error', 'longtext');
      table.bigInteger('wake_at');
      table.string('locked_by');
      table.bigInteger('locked_until');
      table.integer('recovery_attempts');
      table.text('tags', 'longtext');
      table.text('search_attributes', 'longtext');
      table.integer('priority');
      table.text('awaiting_decision_task_id');
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
      table.index(['status'], 'durable_runs_status_idx');
      table.index(['status', 'wake_at'], 'durable_runs_due_idx');
      // Worker-pool partition: scopes the poll/recovery queries (namespace + status + createdAt).
      table.index(['namespace', 'status', 'created_at'], 'durable_runs_namespace_idx');
      // The dashboard's default (unfiltered) listing orders by created_at DESC — without this a
      // page load over a large table is a full sort.
      table.index(['created_at'], 'durable_runs_created_idx');
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
    if (!(await conn().hasColumn(DURABLE_TABLES.runs, 'origin'))) {
      // Origin attribution wave: nullable, so an unattributed/legacy run reads back as "unknown".
      await conn().alterTable(DURABLE_TABLES.runs, (table) => {
        table.string('origin');
      });
      repairs.push(`${DURABLE_TABLES.runs}.origin`);
    }
    if (!(await conn().hasColumn(DURABLE_TABLES.runs, 'awaiting_decision_task_id'))) {
      // Remote-turn decision marker (multi-instance decisions): nullable, so an existing run reads back
      // as "not awaiting a dispatched turn". TEXT: it embeds the run id plus a UUID.
      await conn().alterTable(DURABLE_TABLES.runs, (table) => {
        table.text('awaiting_decision_task_id');
      });
      repairs.push(`${DURABLE_TABLES.runs}.awaiting_decision_task_id`);
    }
    // Index-only repair: the dashboard's default (unfiltered) listing orders by created_at DESC —
    // without this a page load over a large table is a full sort.
    await ensureIndex(DURABLE_TABLES.runs, ['created_at'], 'durable_runs_created_idx');
  }

  if (!(await conn().hasTable(DURABLE_TABLES.checkpoints))) {
    await conn().createTable(DURABLE_TABLES.checkpoints, (table) => {
      tableCollation(table);
      table.string('run_id').notNullable();
      table.integer('seq').notNullable();
      table.string('name').notNullable();
      table.string('kind').notNullable();
      table.string('step_id').notNullable();
      table.string('status').notNullable();
      table.text('input', 'longtext');
      table.text('output', 'longtext');
      table.text('error', 'longtext');
      table.text('events', 'longtext');
      table.integer('attempts').notNullable();
      table.string('worker_group');
      table.string('queue');
      table.bigInteger('wake_at');
      table.string('parallel_group');
      table.bigInteger('enqueued_at');
      table.bigInteger('started_at').notNullable();
      table.bigInteger('finished_at').notNullable();
      table.bigInteger('last_heartbeat_at');
      table.text('heartbeat_progress', 'longtext');
      table.primary(['run_id', 'seq']);
      table.index(['run_id', 'name'], 'durable_checkpoints_name_idx');
      // The run detail's per-fan reads (`checkpointStats({ group })`, a fan page in seq order).
      table.index(['run_id', 'parallel_group', 'seq'], 'durable_step_checkpoints_group_idx');
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
        table.text('heartbeat_progress', 'longtext');
      });
      // Both columns land in one ALTER, so both are reported — the operator needs the column list,
      // not the statement count.
      repairs.push(
        `${DURABLE_TABLES.checkpoints}.last_heartbeat_at`,
        `${DURABLE_TABLES.checkpoints}.heartbeat_progress`,
      );
    }
    if (!(await conn().hasColumn(DURABLE_TABLES.checkpoints, 'queue'))) {
      // Durable flow-control release: the admitted queue is persisted on the pending checkpoint so
      // ANY instance receiving the result can free the slot. Nullable — a non-queued step reads back
      // with no slot to release.
      await conn().alterTable(DURABLE_TABLES.checkpoints, (table) => {
        table.string('queue');
      });
      repairs.push(`${DURABLE_TABLES.checkpoints}.queue`);
    }
    await ensureIndex(
      DURABLE_TABLES.checkpoints,
      ['run_id', 'parallel_group', 'seq'],
      'durable_step_checkpoints_group_idx',
    );
  }

  if (!(await conn().hasTable(DURABLE_TABLES.attributes))) {
    await conn().createTable(DURABLE_TABLES.attributes, (table) => {
      tableCollation(table);
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
      tableCollation(table);
      table.string('token').primary();
      table.string('run_id').notNullable();
      table.integer('seq').notNullable();
      table.string('parallel_group');
      // Serves the per-run lookups: the dashboard's waiting-on column, a parent's children
      // resolution, and deleteRun's cascade — all `WHERE run_id` (previously full scans).
      table.index(['run_id'], 'durable_signal_waiters_run_idx');
    });
  } else {
    if (!(await conn().hasColumn(DURABLE_TABLES.signalWaiters, 'parallel_group'))) {
      // Auto-migrate an older signal_waiters table: add the nullable `parallel_group` column in
      // place. Nullable (no default) so a legacy (non-fan) waiter reads back untagged and the await
      // is unchanged.
      await conn().alterTable(DURABLE_TABLES.signalWaiters, (table) => {
        table.string('parallel_group');
      });
      repairs.push(`${DURABLE_TABLES.signalWaiters}.parallel_group`);
    }
    await ensureIndex(DURABLE_TABLES.signalWaiters, ['run_id'], 'durable_signal_waiters_run_idx');
  }

  if (!(await conn().hasTable(DURABLE_TABLES.bufferedSignals))) {
    await conn().createTable(DURABLE_TABLES.bufferedSignals, (table) => {
      tableCollation(table);
      table.increments('id').primary();
      table.string('token').notNullable();
      table.text('payload', 'longtext');
      table.index(['token'], 'durable_buffered_signals_token_idx');
    });
  }

  // Reliable (buffered) events: a publish that matched NO live waiter keeps ONE copy here, consumed
  // by the first future matching `waitForEvent`. Keyed by `name` (not token) since many waiters can
  // share a name with different `match` criteria; the caller-minted `id` is the PK so a claim targets
  // an exact row. `published_at` is epoch-ms (for oldest-first scan + optional TTL pruning).
  if (!(await conn().hasTable(DURABLE_TABLES.bufferedEvents))) {
    await conn().createTable(DURABLE_TABLES.bufferedEvents, (table) => {
      tableCollation(table);
      table.string('id').primary();
      table.string('name').notNullable();
      table.text('payload', 'longtext');
      table.bigInteger('published_at').notNullable();
      table.index(['name', 'published_at'], 'durable_buffered_events_name_idx');
    });
  }

  // Persisted schedules (`engine.schedules`): the store filters on the columns; `spec`/`state` are
  // engine-owned JSON documents it keeps verbatim. `next_fire_at` is epoch ms (NULL = never fires
  // again), exact, so `updateSchedule`'s compare-and-set on it is reliable on every dialect.
  if (!(await conn().hasTable(DURABLE_TABLES.schedules))) {
    await conn().createTable(DURABLE_TABLES.schedules, (table) => {
      tableCollation(table);
      table.string('id').primary();
      table.string('namespace').notNullable().defaultTo('default');
      table.string('workflow').notNullable();
      table.boolean('paused').notNullable().defaultTo(false);
      table.bigInteger('next_fire_at');
      table.text('tags', 'longtext');
      table.text('spec', 'longtext').notNullable();
      table.text('state', 'longtext').notNullable();
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
      // The worker tick's "due by T" scan: `paused = false AND next_fire_at <= T`.
      table.index(['paused', 'next_fire_at'], 'durable_schedules_due_idx');
    });
  }

  // ONE warning for the whole call, listing every column added, or none at all. Not one per ALTER:
  // an operator needs to know their schema was behind and by what, and a burst of lines is easier to
  // lose than a single one.
  if (isMysql) {
    repairs.push(...(await widenMysqlJsonColumns(client)));
    if (collation && charset) {
      repairs.push(...(await alignMysqlCollation(client, charset, collation, logger)));
    }
  }

  if (repairs.length > 0) {
    logger.warn(repairWarning(repairs));
  }
}

/**
 * MySQL: `MODIFY` every JSON column that is not `longtext` yet (a table created before they were
 * `longtext` holds them as `text`, capped at 64KB). One `ALTER` per table with every column it needs,
 * since MySQL rebuilds the table for each; a table already widened is not touched. Returns the
 * columns it changed.
 */
async function widenMysqlJsonColumns(client: QueryClientContract): Promise<string[]> {
  const tables = Object.keys(DURABLE_JSON_COLUMNS);
  const rows = (await client
    .query()
    .from('information_schema.columns')
    .select('table_name as t', 'column_name as c', 'data_type as d')
    .whereRaw('table_schema = database()')
    .whereIn('table_name', tables)) as Array<{ t: string; c: string; d: string }>;
  const widened: string[] = [];
  for (const [table, spec] of Object.entries(DURABLE_JSON_COLUMNS)) {
    const narrow = spec.columns.filter((column) => {
      const row = rows.find((r) => r.t === table && r.c === column);
      return row !== undefined && row.d.toLowerCase() !== 'longtext';
    });
    if (narrow.length === 0) continue;
    const modify = narrow
      .map(
        (column) =>
          `modify \`${column}\` longtext ${spec.notNull?.includes(column) ? 'not null' : 'null'}`,
      )
      .join(', ');
    await client.rawQuery(`alter table \`${table}\` ${modify}`);
    widened.push(...narrow.map((column) => `${table}.${column} (longtext)`));
  }
  return widened;
}

/**
 * MySQL: `CONVERT` each durable table whose collation is not `collation` (tables created by an older
 * version, or before the option was set, carry the server default). A failed `CONVERT` is warned and
 * left for the next forced check rather than failing the boot. Returns the tables it converted.
 */
async function alignMysqlCollation(
  client: QueryClientContract,
  charset: string,
  collation: string,
  logger: DurableSchemaLogger,
): Promise<string[]> {
  const tables = [...Object.values(DURABLE_TABLES), DURABLE_SCHEMA_META_TABLE];
  const rows = (await client
    .query()
    .from('information_schema.tables')
    .select('table_name as t', 'table_collation as c')
    .whereRaw('table_schema = database()')
    .whereIn('table_name', tables)) as Array<{ t: string; c: string | null }>;
  const converted: string[] = [];
  for (const row of rows) {
    if (row.c == null || row.c === collation) continue;
    try {
      await client.rawQuery(
        `alter table \`${row.t}\` convert to character set ${charset} collate ${collation}`,
      );
      converted.push(`${row.t} (collation ${collation})`);
    } catch (err) {
      logger.warn(
        `@adonis-agora/durable: could not convert \`${row.t}\` to collation ${collation} (left as-is): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return converted;
}

/** Drop every durable table (reverse FK order). Used by tests and migration `down`. */
export async function dropDurableTables(db: Database, connectionName?: string): Promise<void> {
  const conn = () => db.connection(connectionName).schema;
  await conn().dropTableIfExists(DURABLE_SCHEMA_META_TABLE);
  await conn().dropTableIfExists(DURABLE_TABLES.schedules);
  await conn().dropTableIfExists(DURABLE_TABLES.bufferedEvents);
  await conn().dropTableIfExists(DURABLE_TABLES.bufferedSignals);
  await conn().dropTableIfExists(DURABLE_TABLES.signalWaiters);
  await conn().dropTableIfExists(DURABLE_TABLES.attributes);
  await conn().dropTableIfExists(DURABLE_TABLES.checkpoints);
  await conn().dropTableIfExists(DURABLE_TABLES.runs);
}
