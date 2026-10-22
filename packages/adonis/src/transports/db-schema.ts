import type { Database } from '@adonisjs/lucid/database';

type AlterTableBuilder = Parameters<
  Parameters<ReturnType<Database['connection']>['schema']['alterTable']>[1]
>[0];

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
} as const;

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
  const conn = () => db.connection().schema;
  if (await conn().hasTable(WORKER_KEYS_TABLE)) return;
  await conn().createTable(WORKER_KEYS_TABLE, (table) => {
    table.string('key', 512).primary();
    table.text('value').notNullable();
    table.bigInteger('expires_at').notNullable();
    table.index(['expires_at'], 'durable_transport_worker_keys_expires_idx');
  });
}

/**
 * Idempotent DDL for the four transport tables, via Lucid's schema builder (Knex). Portable across
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
  // Knex's schema builder is stateful — take a FRESH `db.connection().schema` per hasTable/createTable
  // so each DDL statement executes exactly once.
  const conn = () => db.connection().schema;

  // ── tasks: engine → worker (a RemoteTask) ──────────────────────────────────
  if (!(await conn().hasTable(TRANSPORT_TABLES.tasks))) {
    await conn().createTable(TRANSPORT_TABLES.tasks, (table) => {
      table.string('step_id').primary();
      table.string('run_id').notNullable();
      table.integer('seq').notNullable();
      table.string('name').notNullable();
      table.string('grp').notNullable();
      table.string('namespace').notNullable().defaultTo('default');
      table.text('input');
      table.string('traceparent');
      table.text('context');
      table.string('transport');
      table.integer('attempt').notNullable();
      // How many times a lapsed claim on this row was taken over — the poison-task bound.
      table.integer('reclaims').notNullable().defaultTo(0);
      // Dispatch priority, higher first (the engine's convention); absent = 0, "normal".
      table.integer('priority').notNullable().defaultTo(0);
      table.string('claimed_by');
      table.bigInteger('claimed_at');
      table.bigInteger('created_at').notNullable();
      table.index(
        ['namespace', 'grp', 'claimed_at', 'created_at'],
        'durable_transport_tasks_grp_idx',
      );
    });
  }

  // ── results: worker → engine (a StepResult) ────────────────────────────────
  if (!(await conn().hasTable(TRANSPORT_TABLES.results))) {
    await conn().createTable(TRANSPORT_TABLES.results, (table) => {
      table.string('step_id').primary();
      table.string('run_id').notNullable();
      table.integer('seq').notNullable();
      table.string('status').notNullable();
      table.string('namespace').notNullable().defaultTo('default');
      table.text('output');
      table.text('error');
      table.bigInteger('started_at');
      table.text('events');
      table.string('claimed_by');
      table.bigInteger('claimed_at');
      table.bigInteger('created_at').notNullable();
      table.index(['namespace', 'claimed_at', 'created_at'], 'durable_transport_results_idx');
    });
  }

  // ── heartbeats: worker → engine (liveness for a long step) ─────────────────
  if (!(await conn().hasTable(TRANSPORT_TABLES.heartbeats))) {
    await conn().createTable(TRANSPORT_TABLES.heartbeats, (table) => {
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
    });
  }

  // ── control: best-effort control-plane messages (single-consumer) ──────────
  if (!(await conn().hasTable(TRANSPORT_TABLES.control))) {
    await conn().createTable(TRANSPORT_TABLES.control, (table) => {
      table.increments('id').primary();
      table.text('payload').notNullable();
      table.string('namespace').notNullable().defaultTo('default');
      table.string('claimed_by');
      table.bigInteger('claimed_at');
      table.bigInteger('created_at').notNullable();
      table.index(['namespace', 'claimed_at', 'created_at'], 'durable_transport_control_idx');
    });
  }

  await createWorkerKeysTable(db);

  // Upgrade path: a deployment created by an older version already has these tables (so the guards
  // above skipped them) but lacks the columns added since. Back-fill them — idempotent via
  // `hasColumn`, and every added column is `notNullable` with a default, so legacy in-flight rows
  // read exactly as they did before.
  await ensureAddedColumns(db);
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
  ];
  for (const { table, column, add } of added) {
    if (!(await db.connection().schema.hasColumn(table, column))) {
      await db.connection().schema.alterTable(table, add);
    }
  }
}

/** Drop every transport table. Used by tests and the migration `down`. */
export async function dropDurableTransportTables(db: Database): Promise<void> {
  const conn = () => db.connection().schema;
  await conn().dropTableIfExists(WORKER_KEYS_TABLE);
  await conn().dropTableIfExists(TRANSPORT_TABLES.control);
  await conn().dropTableIfExists(TRANSPORT_TABLES.heartbeats);
  await conn().dropTableIfExists(TRANSPORT_TABLES.results);
  await conn().dropTableIfExists(TRANSPORT_TABLES.tasks);
}
