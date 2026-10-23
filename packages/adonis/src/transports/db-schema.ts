import type { Database } from '@adonisjs/lucid/database';
import { widenMysqlLongtextColumns } from '../stores/lucid-schema.js';

type AlterTableBuilder = Parameters<
  Parameters<ReturnType<Database['connection']>['schema']['alterTable']>[1]
>[0];
type CreateTableBuilder = Parameters<
  Parameters<ReturnType<Database['connection']>['schema']['createTable']>[1]
>[0];

/**
 * Create `name` unless it exists. Every instance runs this on first use, so two of them starting
 * together race the same CREATE: the loser's statement fails although the table is there — which is
 * success. Only an error that leaves the table missing is rethrown.
 */
async function createTableIfMissing(
  db: Database,
  name: string,
  build: (table: CreateTableBuilder) => void,
): Promise<void> {
  const schema = () => db.connection().schema;
  if (await schema().hasTable(name)) return;
  try {
    await schema().createTable(name, build);
  } catch (err) {
    if (!(await schema().hasTable(name))) throw err;
  }
}

/**
 * The DB transport's table names. Distinct from the durable *store* tables (`durable_workflow_runs`
 * etc.) — these carry the point-to-point work channels (tasks / results / heartbeats / control), so
 * the transport can share one database with the store without colliding.
 */
export const TRANSPORT_TABLES = {
  tasks: 'durable_transport_tasks',
  results: 'durable_transport_results',
  heartbeats: 'durable_transport_heartbeats',
  control: 'durable_transport_control',
  /** Remote-workflow decisions and step events, and the store-less (tenant pod) protocol's start-run,
   *  run-request, run-reply and tenant-event rows — one table told apart by `kind`. */
  messages: 'durable_transport_messages',
} as const;

/**
 * The `kind`s of a {@link TRANSPORT_TABLES.messages} row. `recipient` is `''` for a row any consumer
 * of the kind may claim, or the instance id of the one consumer it is addressed to.
 */
export const MESSAGE_KINDS = {
  decision: 'decision',
  stepEvent: 'stepEvent',
  startRun: 'startRun',
  runRequest: 'runRequest',
  runReply: 'runReply',
  tenantEvent: 'tenantEvent',
  /** A {@link import('../interfaces.js').RunDispatch} for any engine consuming the run queue. */
  run: 'run',
} as const;
export type MessageKind = (typeof MESSAGE_KINDS)[keyof typeof MESSAGE_KINDS];

/**
 * The worker advertisement keys (design §7.2) — the descriptor and heartbeat keys a worker runtime
 * writes, each with an expiry. Kept out of {@link TRANSPORT_TABLES}: it is a key/value board, not a
 * one-shot message channel, and carries no namespace column (the keys embed the namespace).
 */
export const WORKER_KEYS_TABLE = 'durable_transport_worker_keys';

/**
 * Idempotent DDL for the worker-key table alone (`key` PK, `value`, `expires_at`): the descriptor and
 * heartbeat keys a worker runtime advertises. The queue transport keeps its advertisement here without
 * the db transport's other tables.
 */
export async function createWorkerKeysTable(db: Database): Promise<void> {
  await createTableIfMissing(db, WORKER_KEYS_TABLE, buildWorkerKeysTable);
  await widenPayloadColumns(db, [WORKER_KEYS_TABLE]);
}

/**
 * The columns that hold free-form JSON payloads (a step's input/output/error/events, the control and
 * message payloads, a worker key's value). They are `longtext` on MySQL, where `text` stops at 64KB
 * and a bigger step input or output fails to write (strict mode) or is cut off; an existing `text`
 * one is widened in place on boot. Postgres and SQLite `text` has no limit and is unchanged.
 * `notNull` lists the `NOT NULL` ones, which a MySQL `MODIFY` must restate.
 */
export const TRANSPORT_JSON_COLUMNS: Record<string, { columns: string[]; notNull?: string[] }> = {
  durable_transport_tasks: { columns: ['input', 'context'] },
  durable_transport_results: { columns: ['output', 'error', 'events'] },
  durable_transport_control: { columns: ['payload'], notNull: ['payload'] },
  durable_transport_messages: { columns: ['payload'], notNull: ['payload'] },
  durable_transport_worker_keys: { columns: ['value'], notNull: ['value'] },
};

/** MySQL only: widen the {@link TRANSPORT_JSON_COLUMNS} of `tables` that are still `text`. */
async function widenPayloadColumns(db: Database, tables: string[]): Promise<void> {
  const client = db.connection();
  if (client.dialect.name !== 'mysql') return;
  const spec = Object.fromEntries(
    tables.flatMap((t) => (TRANSPORT_JSON_COLUMNS[t] ? [[t, TRANSPORT_JSON_COLUMNS[t]]] : [])),
  );
  await widenMysqlLongtextColumns(client, spec);
}

function buildWorkerKeysTable(table: CreateTableBuilder): void {
  table.string('key', 512).primary();
  table.text('value', 'longtext').notNullable();
  table.bigInteger('expires_at').notNullable();
  table.index(['expires_at'], 'durable_transport_worker_keys_expires_idx');
}

/**
 * Idempotent DDL for the transport tables, via Lucid's schema builder (Knex). Portable across
 * SQLite / Postgres / MySQL: JSON payloads (`input`/`output`/`error`/`payload`) are stored as TEXT
 * and (de)serialized by the transport, and every timestamp is an epoch-ms `bigInteger`, so there's
 * no dependency on a dialect's native JSON/date type.
 *
 * Each row is a one-shot message claimed by exactly one consumer (atomic conditional UPDATE on
 * `claimed_by`) and then deleted once handled — the DB is the queue.
 *
 * Call this on boot or once at deploy time. For an AdonisJS app prefer the published migration
 * (`node ace configure @adonis-agora/durable`); this helper is for standalone use and tests.
 */
export async function createDurableTransportTables(db: Database): Promise<void> {
  // Knex's schema builder is stateful — createTableIfMissing takes a FRESH `db.connection().schema`
  // per hasTable/createTable so each DDL statement executes exactly once.

  for (const table of [
    TRANSPORT_TABLES.tasks,
    TRANSPORT_TABLES.results,
    TRANSPORT_TABLES.heartbeats,
    TRANSPORT_TABLES.control,
  ]) {
    await createTableIfMissing(db, table, TRANSPORT_TABLE_DEFS[table] as TableBuild);
  }

  await createMessagesTable(db);
  await createWorkerKeysTable(db);

  // Upgrade path: a deployment created by an older version already has these tables (so the guards
  // above skipped them) but lacks the columns added since. Back-fill them — idempotent via
  // `hasColumn`, and every added column is `notNullable` with a default, so legacy in-flight rows
  // read exactly as they did before.
  await ensureAddedColumns(db);
  // MySQL: a table created while the payload columns were `text` gets them widened to `longtext`.
  await widenPayloadColumns(db, Object.keys(TRANSPORT_JSON_COLUMNS));
}

/**
 * Idempotent DDL for the messages table: one-shot rows like the other channels (claimed by one
 * consumer, deleted once handled), told apart by `kind` and addressed by `recipient` — `''` for any
 * consumer of the kind, else the instance id of the one it is for (a run reply, a tenant event, a
 * decision for the engine that dispatched the turn). `reply_to` carries a request's requester.
 */
export async function createMessagesTable(db: Database): Promise<void> {
  await createTableIfMissing(db, TRANSPORT_TABLES.messages, buildMessagesTable);
}

function buildMessagesTable(table: CreateTableBuilder): void {
  table.increments('id').primary();
  table.string('kind', 32).notNullable();
  table.string('namespace').notNullable().defaultTo('default');
  table.string('recipient').notNullable().defaultTo('');
  table.string('reply_to');
  table.text('payload', 'longtext').notNullable();
  table.string('claimed_by');
  table.bigInteger('claimed_at');
  table.bigInteger('created_at').notNullable();
  table.index(
    ['namespace', 'kind', 'recipient', 'claimed_at', 'id'],
    'durable_transport_messages_idx',
  );
}

/**
 * Columns added to the transport tables after their first release, with the default that makes a
 * legacy row behave as before:
 *
 * - `namespace` on every channel table, `'default'` — a default engine's `WHERE namespace='default'`
 *   claims exactly the rows it did before namespaces existed.
 * - `reclaims` on the tasks table, `0` — the count of lapsed claims taken over (the poison-task
 *   bound, see `DbTransportOptions.maxStalledCount`); a legacy row starts uncounted.
 * - `priority` on the tasks table, `0` — the dispatch priority rows are claimed by (higher first);
 *   a legacy row is "normal", like a dispatch without a priority.
 * - `kind` on the tasks table, `'step'` — what a row carries: a step, or a remote workflow turn; a
 *   legacy row is a step, the only kind there was.
 */
async function ensureAddedColumns(db: Database): Promise<void> {
  const added: Array<{ table: string; column: string; add: (t: AlterTableBuilder) => void }> = [
    ...Object.values(TRANSPORT_TABLES).map((table) => ({
      table,
      column: 'namespace',
      add: (t: AlterTableBuilder) => {
        t.string('namespace').notNullable().defaultTo('default');
      },
    })),
    {
      table: TRANSPORT_TABLES.tasks,
      column: 'reclaims',
      add: (t: AlterTableBuilder) => {
        t.integer('reclaims').notNullable().defaultTo(0);
      },
    },
    {
      table: TRANSPORT_TABLES.tasks,
      column: 'priority',
      add: (t: AlterTableBuilder) => {
        t.integer('priority').notNullable().defaultTo(0);
      },
    },
    {
      table: TRANSPORT_TABLES.tasks,
      column: 'kind',
      add: (t: AlterTableBuilder) => {
        t.string('kind', 16).notNullable().defaultTo('step');
      },
    },
  ];
  for (const { table, column, add } of added) {
    if (await db.connection().schema.hasColumn(table, column)) continue;
    try {
      await db.connection().schema.alterTable(table, add);
    } catch (err) {
      // Another instance added it first (the same race as createTableIfMissing).
      if (!(await db.connection().schema.hasColumn(table, column))) throw err;
    }
  }
}

type TableBuild = (table: CreateTableBuilder) => void;

/**
 * The CREATE TABLE body of every transport table (Knex schema builder), shared by
 * {@link createDurableTransportTables} and the dialect tests. Payload columns are `longtext`, which
 * Knex emits on MySQL only (Postgres and SQLite get `text`). See {@link TRANSPORT_JSON_COLUMNS}.
 */
export const TRANSPORT_TABLE_DEFS: Record<string, TableBuild> = {
  // ── tasks: engine → worker (a RemoteTask) ──────────────────────────────────
  [TRANSPORT_TABLES.tasks]: (table) => {
    table.string('step_id').primary();
    table.string('run_id').notNullable();
    table.integer('seq').notNullable();
    table.string('name').notNullable();
    table.string('grp').notNullable();
    table.string('namespace').notNullable().defaultTo('default');
    table.text('input', 'longtext');
    table.string('traceparent');
    table.text('context', 'longtext');
    table.string('transport');
    table.integer('attempt').notNullable();
    // How many times a lapsed claim on this row was taken over — the poison-task bound.
    table.integer('reclaims').notNullable().defaultTo(0);
    // Dispatch priority, higher first (the engine's convention); absent = 0, "normal".
    table.integer('priority').notNullable().defaultTo(0);
    // `step` (a RemoteTask) or `workflow` (a remote workflow turn: a WorkflowTask in `input`).
    table.string('kind', 16).notNullable().defaultTo('step');
    table.string('claimed_by');
    table.bigInteger('claimed_at');
    table.bigInteger('created_at').notNullable();
    table.index(
      ['namespace', 'grp', 'claimed_at', 'created_at'],
      'durable_transport_tasks_grp_idx',
    );
  },

  // ── results: worker → engine (a StepResult) ────────────────────────────────
  [TRANSPORT_TABLES.results]: (table) => {
    table.string('step_id').primary();
    table.string('run_id').notNullable();
    table.integer('seq').notNullable();
    table.string('status').notNullable();
    table.string('namespace').notNullable().defaultTo('default');
    table.text('output', 'longtext');
    table.text('error', 'longtext');
    table.bigInteger('started_at');
    table.text('events', 'longtext');
    table.string('claimed_by');
    table.bigInteger('claimed_at');
    table.bigInteger('created_at').notNullable();
    table.index(['namespace', 'claimed_at', 'created_at'], 'durable_transport_results_idx');
  },

  // ── heartbeats: worker → engine (liveness for a long step) ─────────────────
  [TRANSPORT_TABLES.heartbeats]: (table) => {
    table.increments('id').primary();
    table.string('run_id').notNullable();
    table.integer('seq').notNullable();
    table.string('step_id').notNullable();
    table.string('grp').notNullable();
    table.string('namespace').notNullable().defaultTo('default');
    table.string('claimed_by');
    table.bigInteger('claimed_at');
    table.bigInteger('created_at').notNullable();
    table.index(['namespace', 'claimed_at', 'created_at'], 'durable_transport_heartbeats_idx');
  },

  // ── control: best-effort control-plane messages (single-consumer) ──────────
  [TRANSPORT_TABLES.control]: (table) => {
    table.increments('id').primary();
    table.text('payload', 'longtext').notNullable();
    table.string('namespace').notNullable().defaultTo('default');
    table.string('claimed_by');
    table.bigInteger('claimed_at');
    table.bigInteger('created_at').notNullable();
    table.index(['namespace', 'claimed_at', 'created_at'], 'durable_transport_control_idx');
  },
  [TRANSPORT_TABLES.messages]: buildMessagesTable,
  [WORKER_KEYS_TABLE]: buildWorkerKeysTable,
};

/** Drop every transport table. Used by tests and the migration `down`. */
export async function dropDurableTransportTables(db: Database): Promise<void> {
  const conn = () => db.connection().schema;
  await conn().dropTableIfExists(WORKER_KEYS_TABLE);
  await conn().dropTableIfExists(TRANSPORT_TABLES.messages);
  await conn().dropTableIfExists(TRANSPORT_TABLES.control);
  await conn().dropTableIfExists(TRANSPORT_TABLES.heartbeats);
  await conn().dropTableIfExists(TRANSPORT_TABLES.results);
  await conn().dropTableIfExists(TRANSPORT_TABLES.tasks);
}
