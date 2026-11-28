import { createHash } from 'node:crypto';
import type { Database } from '@adonisjs/lucid/database';
import type { QueryClientContract } from '@adonisjs/lucid/types/database';
import {
  assertSchemaSupported,
  ensureSchemaExists,
  hasColumn,
  mysqlLockName,
  qualify,
  schemaBuilder,
  schemaLockKey,
  validateSchemaName,
  whereSchema,
} from '../sql-schema.js';

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
  /**
   * The database schema the tables live in (a database on MySQL), created when missing. Every
   * statement names it, so the connection's own default schema is left alone. Omit for the
   * connection's current schema. Not supported on SQLite.
   */
  schema?: string | undefined;
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
export const DURABLE_SCHEMA_REVISION = 9;

/**
 * The index behind {@link LucidStateStore.listPendingTransports}, the boot read of which transports
 * built on demand still have a `pending` step: `transport IN (…) AND status = 'pending'`. Only steps
 * pinned to a transport carry a `transport`, so the index stays small, and the read never scans the
 * checkpoints table.
 */
export const CHECKPOINT_TRANSPORT_INDEX = 'durable_step_checkpoints_transport_idx';

/**
 * The index behind the retention sweep (`engine.sweepRetention`, once a minute): every pass asks
 * `status IN (…) AND updated_at <= cutoff` (plus a `workflow IN (…)` scope and a `namespace IN (…)`
 * when the policy has them), then pages newest-first.
 *
 * Without it that pass is a full scan of the runs table. On a 36 k-row / 669 MB install it read
 * ~160 MB per pass and removed every row by hand, 674 times a day — 372 s of database time, 76
 * passes over a second, a maximum of 8.9 s — to find nothing. With it a pass that finds nothing is
 * an index scan over two buffers.
 *
 * `status` leads because **every** shape of the sweep constrains it (a per-status
 * `retention.completed` and a `policies[].statuses` both compile to `status IN (…)`) while
 * `workflow` is only present for a scoped policy. `updated_at` is the range column. `workflow`
 * trails, which keeps a scoped pass index-only: the `workflow IN (…)` becomes a filter over the
 * handful of `(status, updated_at)` entries the range matched.
 *
 * Being non-leading, `workflow` costs nothing on write either: it does not change per run, and
 * `updated_at` — the one column here that a settle rewrites — already moved on every terminal write
 * through `status`, which has been indexed since the first schema (`durable_runs_status_idx`). So
 * this index adds an entry to a write that was already heap-visible, and converts no HOT update into
 * a non-HOT one. Measured on a production-shaped table: `lease CAS` (2296/day, 100% HOT) unchanged,
 * `settle` (703/day) 1.19 → 1.25 ms and +150 B of WAL per row (~110 kB/day total).
 */
export const RUN_RETENTION_INDEX = 'durable_runs_retention_idx';

/** The columns of {@link RUN_RETENTION_INDEX}, in order. */
export const RUN_RETENTION_INDEX_COLUMNS = ['status', 'updated_at', 'workflow'] as const;

/**
 * Postgres: the partial index serving the listing of settled runs that still owe a lifecycle event
 * (`listRuns({ tag: LIFECYCLE_PENDING_TAG })`, every 10 s on every worker). Without it that listing
 * reads the whole runs table. Only the runs carrying the tag are in it, so it stays tiny.
 */
export const LIFECYCLE_PENDING_INDEX = 'durable_runs_lifecycle_pending_idx';

/**
 * The partial index's predicate. The store's owed listing repeats this text verbatim (a literal, not
 * a bound parameter), which is what lets the planner prove the index applies on every plan.
 */
export const LIFECYCLE_PENDING_PREDICATE = `tags like '%"durable:lifecycle:pending"%' escape '!'`;

/** The tag {@link LIFECYCLE_PENDING_PREDICATE} matches (`LIFECYCLE_PENDING_TAG`, kept here so the
 *  schema module imports no engine code; a test pins the two together). */
export const LIFECYCLE_PENDING_INDEXED_TAG = 'durable:lifecycle:pending';

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

async function readSchemaFingerprint(
  client: QueryClientContract,
  schema: string | undefined,
): Promise<string | undefined> {
  if (!(await schemaBuilder(client, schema).hasTable(DURABLE_SCHEMA_META_TABLE))) return undefined;
  const q = client
    .query()
    .from(qualify(schema, DURABLE_SCHEMA_META_TABLE))
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
  schema: string | undefined,
  fingerprint: string,
): Promise<void> {
  if (!(await schemaBuilder(client, schema).hasTable(DURABLE_SCHEMA_META_TABLE))) {
    await schemaBuilder(client, schema).createTable(DURABLE_SCHEMA_META_TABLE, (table) => {
      table.string('id', 32).primary();
      table.string('fingerprint', 64).notNullable();
      table.bigInteger('applied_at').notNullable();
    });
  }
  await client
    .insertQuery()
    .table(qualify(schema, DURABLE_SCHEMA_META_TABLE))
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
  schema: string | undefined,
  logger: DurableSchemaLogger,
  work: (client: QueryClientContract) => Promise<void>,
): Promise<void> {
  // With a schema, the lock is that schema's: two installs in two schemas of one database heal
  // independently. Without one, the keys are unchanged.
  switch (connection.dialect.name) {
    case 'postgres':
      await connection.transaction(async (trx) => {
        await trx.rawQuery('select pg_advisory_xact_lock(?)', [
          schemaLockKey(PG_SCHEMA_LOCK_KEY, schema),
        ]);
        await work(trx);
      });
      return;
    case 'mysql':
      await connection.transaction(async (trx) => {
        // The lock is named after the database the tables are in: the configured one, else the
        // connection's.
        const lockName: { sql: string; bindings: string[] } = schema
          ? { sql: '?', bindings: [mysqlLockName('durable_schema:', schema)] }
          : { sql: "concat('durable_schema:', database())", bindings: [] };
        const result = (await trx.rawQuery(`select get_lock(${lockName.sql}, ?) as got`, [
          ...lockName.bindings,
          MYSQL_SCHEMA_LOCK_TIMEOUT_S,
        ])) as [Array<{ got: number | string | null }>, unknown];
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
              .rawQuery(`select release_lock(${lockName.sql})`, lockName.bindings)
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
 * Does an index with this name exist in `schema` (the connection's current schema when unset)? Returns `null` for
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
  schema: string | undefined,
  indexName: string,
): Promise<boolean | null> {
  switch (connection.dialect.name) {
    case 'postgres': {
      const q = connection.query().from('pg_indexes').where('indexname', indexName);
      const rows = await whereSchema(q, connection, 'schemaname', schema).limit(1);
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
      const q = connection
        .query()
        .from('information_schema.statistics')
        .where('index_name', indexName);
      const rows = await whereSchema(q, connection, 'table_schema', schema).limit(1);
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
 * Pass `options.schema` to put the tables in their own database schema (created when missing): every
 * statement names it, on any connection. It must match the store's `schema`.
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
  const schema = validateSchemaName(options.schema, 'createDurableTables');
  assertSchemaSupported(connection, schema, 'createDurableTables');
  const logger = options.logger ?? console;
  const collation =
    connection.dialect.name === 'mysql' ? configuredCollation(connection, options) : undefined;
  const expected = schemaFingerprint(collation);
  // The steady-state boot: one catalog probe and one PK read, no per-table checks.
  if (!options.force && (await readSchemaFingerprint(connection, schema)) === expected) return;
  // Outside the lock's transaction: a failed CREATE SCHEMA would abort it.
  await ensureSchemaExists(connection, schema);
  const postgres = connection.dialect.name === 'postgres';
  let healed = false;
  await withSchemaLock(connection, schema, logger, async (client) => {
    // A sibling may have healed while this process waited for the lock.
    if (!options.force && (await readSchemaFingerprint(client, schema)) === expected) return;
    await healDurableTables(client, schema, collation, logger);
    healed = true;
    // Postgres records the revision only once the index built outside the lock is in place.
    if (!postgres) await writeSchemaFingerprint(client, schema, expected);
  });
  if (!healed) return;
  // CREATE INDEX CONCURRENTLY cannot run in the lock's transaction, and does not block writes to the
  // runs table while it builds. Until every one is valid the revision stays unrecorded, so the next
  // boot tries again; every query those indexes serve works without them, only slower.
  if (await ensureBootIndexes(connection, schema, logger)) {
    await writeSchemaFingerprint(connection, schema, expected);
  }
}

/**
 * One `CREATE INDEX CONCURRENTLY` of {@link ensureBootIndexes}. `columns` is the raw column list
 * (`created_at`, `status, updated_at, workflow`); `predicate` is the index's partial `WHERE`, if any,
 * and must be the literal the store's query repeats so the planner can prove the index applies.
 */
interface BootIndexBuild {
  name: string;
  columns: string;
  predicate: string | undefined;
  /** What gets slower until the index is valid, quoted in the warning when the build fails. */
  cost: string;
}

/** The lifecycle-pending index's build spec, shared by {@link ensureBootIndexes} and
 *  {@link ensureLifecyclePendingIndex} so columns, predicate and cost can never drift apart. */
const LIFECYCLE_PENDING_BUILD: BootIndexBuild = {
  name: LIFECYCLE_PENDING_INDEX,
  columns: 'created_at',
  predicate: LIFECYCLE_PENDING_PREDICATE,
  cost: 'the owed lifecycle listing reads the whole runs table',
};

/** The retention index's build spec. See {@link RUN_RETENTION_INDEX} for why the columns are in
 *  this order. */
const RUN_RETENTION_BUILD: BootIndexBuild = {
  name: RUN_RETENTION_INDEX,
  columns: RUN_RETENTION_INDEX_COLUMNS.join(', '),
  predicate: undefined,
  cost: 'the retention sweep reads the whole runs table once a minute',
};

/**
 * Postgres: make sure every index that cannot be built inside the schema lock's transaction exists
 * and is valid — {@link LIFECYCLE_PENDING_INDEX} and {@link RUN_RETENTION_INDEX} — each with
 * `CREATE INDEX CONCURRENTLY`, so reads and writes of the runs table go on while it builds. A plain
 * `create index` inside the boot's transaction would hold a write lock on the runs table for the
 * length of the build: seconds on a small install, minutes on a large one, and it would block every
 * step the fleet is running.
 *
 * An index left `INVALID` by a build that died is dropped and built again, unless a build of it is
 * still running (a sibling process) — then this returns `false` and leaves it to that build. A
 * failed build is reported through `logger` and returns `false`, so the revision stays unrecorded
 * and the next boot retries. Every other dialect: `true`, nothing to do — a plain index built by
 * `healDurableTables` covers MySQL, and SQLite deployments are small enough for the plain scan.
 */
export async function ensureBootIndexes(
  connection: QueryClientContract,
  schema: string | undefined,
  logger: DurableSchemaLogger = console,
): Promise<boolean> {
  if (connection.dialect.name !== 'postgres') return true;
  const builds = [LIFECYCLE_PENDING_BUILD, RUN_RETENTION_BUILD];
  let all = true;
  for (const build of builds) {
    if (!(await ensurePgIndex(connection, schema, build, logger))) all = false;
  }
  return all;
}

/** One `CREATE INDEX CONCURRENTLY` of {@link ensureBootIndexes}, healed when it is invalid. */
async function ensurePgIndex(
  connection: QueryClientContract,
  schema: string | undefined,
  build: BootIndexBuild,
  logger: DurableSchemaLogger,
): Promise<boolean> {
  const table = qualify(schema, DURABLE_TABLES.runs);
  try {
    const state = await pgIndexState(connection, schema, build.name);
    if (state?.valid) return true;
    if (state) {
      if (state.building) return false;
      await connection.rawQuery('drop index concurrently if exists ??', [
        qualify(schema, build.name),
      ]);
    }
    await connection.rawQuery(
      `create index concurrently if not exists ?? on ?? (${build.columns})` +
        (build.predicate === undefined ? '' : ` where ${build.predicate}`),
      [build.name, table],
    );
    // IF NOT EXISTS returns at once when a sibling's build created the name first.
    return (await pgIndexState(connection, schema, build.name))?.valid === true;
  } catch (err) {
    logger.warn(
      `@adonis-agora/durable: could not build the index ${build.name} on ${table} (${(err as Error).message}); the next boot tries again. Until then ${build.cost}.`,
    );
    return false;
  }
}

/**
 * Postgres: make sure {@link LIFECYCLE_PENDING_INDEX} exists and is valid. Kept as its own export
 * (public since it shipped) on top of {@link ensureBootIndexes}; prefer the latter.
 */
export async function ensureLifecyclePendingIndex(
  connection: QueryClientContract,
  schema: string | undefined,
  logger: DurableSchemaLogger = console,
): Promise<boolean> {
  if (connection.dialect.name !== 'postgres') return true;
  return ensurePgIndex(connection, schema, LIFECYCLE_PENDING_BUILD, logger);
}

/** A Postgres index's validity, and whether a `CREATE INDEX` of it is running; `undefined` if absent. */
async function pgIndexState(
  connection: QueryClientContract,
  schema: string | undefined,
  indexName: string,
): Promise<{ valid: boolean; building: boolean } | undefined> {
  const result = (await connection.rawQuery(
    `select i.indisvalid as valid,
            exists (select 1 from pg_stat_progress_create_index p where p.index_relid = c.oid) as building
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_index i on i.indexrelid = c.oid
      where c.relname = ? and n.nspname = ${schema ? '?' : 'current_schema()'}`,
    schema ? [indexName, schema] : [indexName],
  )) as { rows: Array<{ valid: boolean; building: boolean }> };
  const row = result.rows[0];
  return row ? { valid: row.valid === true, building: row.building === true } : undefined;
}

/** The additive check-and-repair behind {@link createDurableTables}, on one client (or transaction). */
async function healDurableTables(
  client: QueryClientContract,
  schema: string | undefined,
  collation: string | undefined,
  logger: DurableSchemaLogger,
): Promise<void> {
  // Knex's schema builder is stateful — operations chained on one instance run together. Take a FRESH
  // `client.schema` for every hasTable/createTable so each DDL statement executes exactly once, all on
  // the store's own connection (or the lock-holding transaction), scoped to the configured schema.
  const conn = () => schemaBuilder(client, schema);
  const columnExists = (table: string, column: string) => hasColumn(client, schema, table, column);
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
    const known = await indexExists(client, schema, indexName);
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
      table.bigInteger('wake_requested_at');
      table.string('tenant_id');
      table.string('tenant_kind');
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
      table.index(['status'], 'durable_runs_status_idx');
      // Tenancy: a tenant's runs, newest first.
      table.index(['tenant_id', 'created_at'], 'durable_runs_tenant_idx');
      table.index(['status', 'wake_at'], 'durable_runs_due_idx');
      table.index(['status', 'wake_requested_at'], 'durable_runs_wake_requested_idx');
      // Worker-pool partition: scopes the poll/recovery queries (namespace + status + createdAt).
      table.index(['namespace', 'status', 'created_at'], 'durable_runs_namespace_idx');
      // The dashboard's default (unfiltered) listing orders by created_at DESC — without this a
      // page load over a large table is a full sort.
      table.index(['created_at'], 'durable_runs_created_idx');
      // The retention sweep: `status IN (…) AND updated_at <= cutoff` (+ the policy's workflow
      // scope as a trailing filter). See RUN_RETENTION_INDEX.
      table.index([...RUN_RETENTION_INDEX_COLUMNS], RUN_RETENTION_INDEX);
    });
  } else {
    // Auto-migrate an older runs table by adding any columns introduced after its creation. Each is
    // applied independently so a table missing several catches up. Mirrors the in-place pattern other
    // adapters use; new columns are nullable / carry a DEFAULT so existing rows read back unchanged.
    if (!(await columnExists(DURABLE_TABLES.runs, 'priority'))) {
      // Nullable (no default) so existing rows read back as "unprioritised" and the FIFO path is unchanged.
      await conn().alterTable(DURABLE_TABLES.runs, (table) => {
        table.integer('priority');
      });
      repairs.push(`${DURABLE_TABLES.runs}.priority`);
    }
    if (!(await columnExists(DURABLE_TABLES.runs, 'namespace'))) {
      // DEFAULT 'default' so every pre-namespace row reads back in the reserved 'default' partition —
      // byte-identical behavior for a single-pool deploy that adds the column.
      await conn().alterTable(DURABLE_TABLES.runs, (table) => {
        table.string('namespace').notNullable().defaultTo('default');
        table.index(['namespace', 'status', 'created_at'], 'durable_runs_namespace_idx');
      });
      repairs.push(`${DURABLE_TABLES.runs}.namespace`);
    }
    if (!(await columnExists(DURABLE_TABLES.runs, 'origin'))) {
      // Origin attribution wave: nullable, so an app-own/legacy run reads back with no origin.
      await conn().alterTable(DURABLE_TABLES.runs, (table) => {
        table.string('origin');
      });
      repairs.push(`${DURABLE_TABLES.runs}.origin`);
    }
    if (!(await columnExists(DURABLE_TABLES.runs, 'awaiting_decision_task_id'))) {
      // Remote-turn decision marker (multi-instance decisions): nullable, so an existing run reads back
      // as "not awaiting a dispatched turn". TEXT: it embeds the run id plus a UUID.
      await conn().alterTable(DURABLE_TABLES.runs, (table) => {
        table.text('awaiting_decision_task_id');
      });
      repairs.push(`${DURABLE_TABLES.runs}.awaiting_decision_task_id`);
    }
    if (!(await columnExists(DURABLE_TABLES.runs, 'wake_requested_at'))) {
      // Refused-wake marker (a wake that found another instance's lease): nullable, so an existing
      // run reads back as "no turn requested".
      await conn().alterTable(DURABLE_TABLES.runs, (table) => {
        table.bigInteger('wake_requested_at');
        table.index(['status', 'wake_requested_at'], 'durable_runs_wake_requested_idx');
      });
      repairs.push(`${DURABLE_TABLES.runs}.wake_requested_at`);
    }
    if (!(await columnExists(DURABLE_TABLES.runs, 'tenant_id'))) {
      // Tenancy: nullable, so an existing run reads back with no tenant.
      await conn().alterTable(DURABLE_TABLES.runs, (table) => {
        table.string('tenant_id');
        table.string('tenant_kind');
        table.index(['tenant_id', 'created_at'], 'durable_runs_tenant_idx');
      });
      repairs.push(`${DURABLE_TABLES.runs}.tenant_id`);
    }
    // Index-only repair: the dashboard's default (unfiltered) listing orders by created_at DESC —
    // without this a page load over a large table is a full sort.
    await ensureIndex(DURABLE_TABLES.runs, ['created_at'], 'durable_runs_created_idx');
    // The retention sweep's index. On Postgres it is built CONCURRENTLY AFTER the schema lock
    // (ensureBootIndexes): an index on the runs table built inside this transaction would hold a
    // write lock on it for the length of the build — seconds here, minutes on a big install — and
    // stall every step the fleet is running. Elsewhere a plain in-lock index, which is fine.
    if (client.dialect.name !== 'postgres') {
      await ensureIndex(DURABLE_TABLES.runs, [...RUN_RETENTION_INDEX_COLUMNS], RUN_RETENTION_INDEX);
    }
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
      table.string('transport');
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
      table.index(['transport', 'status'], CHECKPOINT_TRANSPORT_INDEX);
    });
  } else {
    if (!(await columnExists(DURABLE_TABLES.checkpoints, 'parallel_group'))) {
      // Auto-migrate an older checkpoints table: add the nullable `parallel_group` column in place.
      // Nullable (no default) so a legacy (non-parallel) checkpoint reads back untagged.
      await conn().alterTable(DURABLE_TABLES.checkpoints, (table) => {
        table.string('parallel_group');
      });
      repairs.push(`${DURABLE_TABLES.checkpoints}.parallel_group`);
    }
    if (!(await columnExists(DURABLE_TABLES.checkpoints, 'last_heartbeat_at'))) {
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
    if (!(await columnExists(DURABLE_TABLES.checkpoints, 'queue'))) {
      // Durable flow-control release: the admitted queue is persisted on the pending checkpoint so
      // ANY instance receiving the result can free the slot. Nullable — a non-queued step reads back
      // with no slot to release.
      await conn().alterTable(DURABLE_TABLES.checkpoints, (table) => {
        table.string('queue');
      });
      repairs.push(`${DURABLE_TABLES.checkpoints}.queue`);
    }
    if (!(await columnExists(DURABLE_TABLES.checkpoints, 'transport'))) {
      // Transports built on demand: the pinned transport is persisted on the pending checkpoint so a
      // restarted engine builds the transport its result comes back on. Nullable — an unpinned step
      // never writes it.
      await conn().alterTable(DURABLE_TABLES.checkpoints, (table) => {
        table.string('transport');
      });
      repairs.push(`${DURABLE_TABLES.checkpoints}.transport`);
    }
    await ensureIndex(
      DURABLE_TABLES.checkpoints,
      ['run_id', 'parallel_group', 'seq'],
      'durable_step_checkpoints_group_idx',
    );
    await ensureIndex(
      DURABLE_TABLES.checkpoints,
      ['transport', 'status'],
      CHECKPOINT_TRANSPORT_INDEX,
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

  // Tables CREATEd by this call: an index added right after creating one is part of the fresh
  // install, not a repair.
  const created = new Set<string>();

  if (!(await conn().hasTable(DURABLE_TABLES.signalWaiters))) {
    created.add(DURABLE_TABLES.signalWaiters);
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
    if (!(await columnExists(DURABLE_TABLES.signalWaiters, 'parallel_group'))) {
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
    created.add(DURABLE_TABLES.bufferedSignals);
    await conn().createTable(DURABLE_TABLES.bufferedSignals, (table) => {
      tableCollation(table);
      table.increments('id').primary();
      table.string('token').notNullable();
      table.text('payload', 'longtext');
      table.index(['token'], 'durable_buffered_signals_token_idx');
    });
  }

  // Postgres: the token prefix scans (`token LIKE 'prefix%'` — an event publish's waiters, a fan's
  // buffered child completions, the entity sweep) can only use a btree built with the pattern
  // operator class unless the database collation is `C`. The plain token indexes above use the
  // default class, so under the usual `en_US.UTF-8` every such read scanned its whole table.
  if (client.dialect.name === 'postgres') {
    for (const [table, indexName] of [
      [DURABLE_TABLES.signalWaiters, 'durable_signal_waiters_token_prefix_idx'],
      [DURABLE_TABLES.bufferedSignals, 'durable_buffered_signals_token_prefix_idx'],
    ] as const) {
      if (await indexExists(client, schema, indexName)) continue;
      // The index lands in its table's schema: `create index "i" on "s"."t"`.
      await client.rawQuery('create index ?? on ?? (?? varchar_pattern_ops)', [
        indexName,
        qualify(schema, table),
        'token',
      ]);
      if (!created.has(table)) repairs.push(`${table}.${indexName}`);
    }
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
      table.string('tenant_id');
      table.string('tenant_kind');
      table.bigInteger('created_at').notNullable();
      table.bigInteger('updated_at').notNullable();
      // The worker tick's "due by T" scan: `paused = false AND next_fire_at <= T`.
      table.index(['paused', 'next_fire_at'], 'durable_schedules_due_idx');
    });
  } else if (!(await columnExists(DURABLE_TABLES.schedules, 'tenant_id'))) {
    // Tenancy: nullable, so an existing schedule (and every run it fires) has no tenant.
    await conn().alterTable(DURABLE_TABLES.schedules, (table) => {
      table.string('tenant_id');
      table.string('tenant_kind');
    });
    repairs.push(`${DURABLE_TABLES.schedules}.tenant_id`);
  }

  // ONE warning for the whole call, listing every column added, or none at all. Not one per ALTER:
  // an operator needs to know their schema was behind and by what, and a burst of lines is easier to
  // lose than a single one.
  if (isMysql) {
    repairs.push(...(await widenMysqlJsonColumns(client, schema)));
    if (collation && charset) {
      repairs.push(...(await alignMysqlCollation(client, schema, charset, collation, logger)));
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
async function widenMysqlJsonColumns(
  client: QueryClientContract,
  schema: string | undefined,
): Promise<string[]> {
  return widenMysqlLongtextColumns(client, DURABLE_JSON_COLUMNS, schema);
}

/**
 * MySQL: `MODIFY` to `longtext` every column of `spec` that exists and isn't `longtext` yet, one
 * `ALTER` per table. Shared by the store schema and the db transport's (`createDurableTransportTables`).
 * Returns the columns it changed.
 */
export async function widenMysqlLongtextColumns(
  client: QueryClientContract,
  spec: Record<string, { columns: string[]; notNull?: string[] }>,
  schema?: string | undefined,
): Promise<string[]> {
  const tables = Object.keys(spec);
  const q = client
    .query()
    .from('information_schema.columns')
    .select('table_name as t', 'column_name as c', 'data_type as d')
    .whereIn('table_name', tables);
  const rows = (await whereSchema(q, client, 'table_schema', schema)) as Array<{
    t: string;
    c: string;
    d: string;
  }>;
  const widened: string[] = [];
  for (const [table, columns] of Object.entries(spec)) {
    const narrow = columns.columns.filter((column) => {
      const row = rows.find((r) => r.t === table && r.c === column);
      return row !== undefined && row.d.toLowerCase() !== 'longtext';
    });
    if (narrow.length === 0) continue;
    const modify = narrow
      .map(
        (column) =>
          `modify \`${column}\` longtext ${columns.notNull?.includes(column) ? 'not null' : 'null'}`,
      )
      .join(', ');
    await client.rawQuery(`alter table ?? ${modify}`, [qualify(schema, table)]);
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
  schema: string | undefined,
  charset: string,
  collation: string,
  logger: DurableSchemaLogger,
): Promise<string[]> {
  const tables = [...Object.values(DURABLE_TABLES), DURABLE_SCHEMA_META_TABLE];
  const q = client
    .query()
    .from('information_schema.tables')
    .select('table_name as t', 'table_collation as c')
    .whereIn('table_name', tables);
  const rows = (await whereSchema(q, client, 'table_schema', schema)) as Array<{
    t: string;
    c: string | null;
  }>;
  const converted: string[] = [];
  for (const row of rows) {
    if (row.c == null || row.c === collation) continue;
    try {
      await client.rawQuery(
        `alter table ?? convert to character set ${charset} collate ${collation}`,
        [qualify(schema, row.t)],
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

/**
 * The runs board's list index: the status chips page newest first with `(status, created_at, id)`
 * instead of reading every run of that status to sort it. Not part of {@link createDurableTables}
 * (boot): on a runs table that already holds millions of rows the build is long, so it ships as the
 * opt-in `add_durable_run_list_indexes` migration.
 */
export const DURABLE_RUN_LIST_INDEXES: ReadonlyArray<readonly [name: string, columns: string[]]> = [
  ['durable_runs_status_created_id_idx', ['status', 'created_at', 'id']],
];

/**
 * Create the missing {@link DURABLE_RUN_LIST_INDEXES} — what the opt-in migration runs, once, on an
 * existing install. On Postgres each is built `CONCURRENTLY`, so reads and writes of the runs table go
 * on while it builds (run it outside a transaction). An `INVALID` index left by a build that died is
 * dropped and built again, as {@link ensureLifecyclePendingIndex} does; one a sibling is still
 * building, or a build that ends invalid, throws, so the migration is not recorded as done.
 * Elsewhere a plain index, skipped when it is already there.
 */
export async function createDurableRunListIndexes(
  db: Database,
  connectionName?: string,
  options: { schema?: string | undefined } = {},
): Promise<void> {
  const connection = db.connection(connectionName);
  const schema = validateSchemaName(options.schema, 'createDurableRunListIndexes');
  assertSchemaSupported(connection, schema, 'createDurableRunListIndexes');
  for (const [name, columns] of DURABLE_RUN_LIST_INDEXES) {
    if (connection.dialect.name === 'postgres') {
      await buildPgIndexConcurrently(connection, schema, name, columns);
      continue;
    }
    try {
      await schemaBuilder(connection, schema).alterTable(DURABLE_TABLES.runs, (t) => {
        t.index(columns, name);
      });
    } catch (error) {
      // MySQL and SQLite say "already exists" / "Duplicate key name": the index is there.
      if (!/already exists|duplicate key name/i.test((error as Error).message)) throw error;
    }
  }
}

/** Build `name` on the runs table `CONCURRENTLY` unless a valid one is there; heal an invalid one. */
async function buildPgIndexConcurrently(
  connection: QueryClientContract,
  schema: string | undefined,
  name: string,
  columns: string[],
): Promise<void> {
  const state = await pgIndexState(connection, schema, name);
  if (state?.valid) return;
  if (state?.building) {
    throw new Error(
      `@adonis-agora/durable: the index ${name} is still being built by another session; run this again once it finishes.`,
    );
  }
  if (state) {
    await connection.rawQuery('drop index concurrently if exists ??', [qualify(schema, name)]);
  }
  await connection.rawQuery(
    `create index concurrently if not exists ?? on ?? (${columns.map(() => '??').join(', ')})`,
    [name, qualify(schema, DURABLE_TABLES.runs), ...columns],
  );
  // IF NOT EXISTS returns at once when a sibling's build created the name first.
  if ((await pgIndexState(connection, schema, name))?.valid !== true) {
    throw new Error(
      `@adonis-agora/durable: the index ${name} is not valid after its build; run this again to rebuild it.`,
    );
  }
}

/** Drop {@link DURABLE_RUN_LIST_INDEXES} (the opt-in migration's `down()`). */
export async function dropDurableRunListIndexes(
  db: Database,
  connectionName?: string,
  options: { schema?: string | undefined } = {},
): Promise<void> {
  const connection = db.connection(connectionName);
  const schema = validateSchemaName(options.schema, 'dropDurableRunListIndexes');
  assertSchemaSupported(connection, schema, 'dropDurableRunListIndexes');
  for (const [name, columns] of DURABLE_RUN_LIST_INDEXES) {
    if (connection.dialect.name === 'postgres') {
      await connection.rawQuery('drop index concurrently if exists ??', [qualify(schema, name)]);
      continue;
    }
    try {
      await schemaBuilder(connection, schema).alterTable(DURABLE_TABLES.runs, (t) => {
        t.dropIndex(columns, name);
      });
    } catch (error) {
      if (!/no such index|check that .* exists|can't drop/i.test((error as Error).message)) {
        throw error;
      }
    }
  }
}

/**
 * Drop every durable table (reverse FK order), in `options.schema` when set (the schema itself is
 * left). Used by tests and migration `down`.
 */
export async function dropDurableTables(
  db: Database,
  connectionName?: string,
  options: { schema?: string | undefined } = {},
): Promise<void> {
  const schema = validateSchemaName(options.schema, 'dropDurableTables');
  assertSchemaSupported(db.connection(connectionName), schema, 'dropDurableTables');
  const conn = () => schemaBuilder(db.connection(connectionName), schema);
  await conn().dropTableIfExists(DURABLE_SCHEMA_META_TABLE);
  await conn().dropTableIfExists(DURABLE_TABLES.schedules);
  await conn().dropTableIfExists(DURABLE_TABLES.bufferedEvents);
  await conn().dropTableIfExists(DURABLE_TABLES.bufferedSignals);
  await conn().dropTableIfExists(DURABLE_TABLES.signalWaiters);
  await conn().dropTableIfExists(DURABLE_TABLES.attributes);
  await conn().dropTableIfExists(DURABLE_TABLES.checkpoints);
  await conn().dropTableIfExists(DURABLE_TABLES.runs);
}
