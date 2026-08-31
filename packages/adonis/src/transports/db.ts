import { randomUUID } from 'node:crypto';
import type { Database } from '@adonisjs/lucid/database';
import type {
  QueryClientContract,
  TransactionClientContract,
} from '@adonisjs/lucid/types/database';
import {
  type ControlMessage,
  type ControlPlane,
  type Heartbeat,
  type RemoteTask,
  type StepResult,
  type Transport,
} from '../interfaces.js';
import { Pollers, type PollLoop } from '../pollers.js';
import { runStepHandler, type StepHandler } from '../protocol.js';
import { sanitizeQueueToken, tenantGroup } from '../tenant-group.js';
import { createDurableTransportTables, TRANSPORT_TABLES } from './db-schema.js';

/**
 * The wire payloads carried in the DB transport's table rows. Everything crossing the DB is plain
 * JSON — JSON columns are stored as TEXT, so these helpers (de)serialize through
 * `JSON.stringify`/`JSON.parse`: only JSON-safe values survive (functions, symbols, `undefined`
 * members are dropped exactly as a real broker would drop them).
 */

/** Serialize a value to a JSON string, or `null` for `undefined` (so a TEXT column round-trips). */
function toJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/** Parse a TEXT column we previously wrote with {@link toJson}. `null`/empty → `undefined`. */
function fromJson<T>(value: string | null | undefined): T | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return JSON.parse(value) as T;
}

type ControlPayload = ControlMessage;

/** Default poll interval (ms) for the result/task/heartbeat/control loops. */
const DEFAULT_POLL_INTERVAL_MS = 200;
/** Default lease window (ms): a claimed-but-not-deleted row is reclaimable after this (crash recovery). */
const DEFAULT_LEASE_MS = 30_000;
/** Default max rows claimed per poll. */
const DEFAULT_BATCH_SIZE = 20;

type Client = QueryClientContract | TransactionClientContract;

/** Raw task-row shape (declared, so it's not `| undefined` under noUncheckedIndexedAccess). */
interface TaskRow {
  step_id: string;
  run_id: string;
  seq: number;
  name: string;
  grp: string;
  input: string | null;
  traceparent: string | null;
  context: string | null;
  transport: string | null;
  attempt: number;
}
interface ResultRow {
  step_id: string;
  run_id: string;
  seq: number;
  status: string;
  output: string | null;
  error: string | null;
  started_at: string | number | null;
  events: string | null;
}
interface HeartbeatRow {
  id: number;
  run_id: string;
  seq: number;
  step_id: string;
  grp: string;
}
interface ControlRow {
  id: number;
  payload: string;
}

const DEFAULT_LOG = (err: unknown): void => console.error('[DbTransport] poll failed', err);

export interface DbTransportOptions {
  /**
   * The Lucid `Database` to read/write. Use the app's own `db` service (no broker, no extra
   * connection) — the database you already have IS the queue.
   */
  db: Database;
  /**
   * @deprecated Steps are now routed BY HANDLER NAME, so this instance serves whatever names it
   * `handle()`s — no group to declare. Accepted for back-compat / parity and otherwise ignored (the
   * task poll loop claims rows for every registered handler name's routing token). Use
   * {@link partition} for isolation.
   */
  group?: string;
  /**
   * Optional isolation partition suffixing every per-handler routing token this worker claims
   * (`<name>@<partition>`), matching the `partition` a dispatch carries. Unset (or `'default'`)
   * claims the bare (sanitized) handler-name tokens.
   */
  partition?: string;
  /**
   * Logical deployment namespace, stamped on every row this instance writes and required on every row
   * it claims, so the same backend tables can host several worker-pool partitions without their
   * tasks/results/heartbeats/control crossing. `"default"` (and absent) stamps/claims `'default'` —
   * every row (incl. legacy rows back-filled by the migration) carries `'default'`, so a default
   * engine's result set is UNCHANGED from the un-namespaced scheme. Passing it here is EXPLICIT and
   * wins over a later {@link DbTransport.useNamespace} (the engine's propagation).
   */
  namespace?: string;
  /** Lucid connection name to use. Defaults to the `Database` default connection. */
  connectionName?: string;
  /** Poll interval (ms) for the result/task/heartbeat/control loops. Default 200ms. */
  pollIntervalMs?: number;
  /** How long a claimed-but-unfinished row is owned before it's reclaimable (crash recovery). Default 30s. */
  leaseMs?: number;
  /** Max rows claimed per poll. Default 20. */
  batchSize?: number;
  /** Create the transport tables on first use if missing. Default true. */
  autoCreate?: boolean;
  /** Stable id for this process (stamped on heartbeats / control `from` / `claimed_by`). Default random. */
  instanceId?: string;
}

/**
 * A poll-based, DB-table-backed {@link Transport} (and best-effort {@link ControlPlane}) over
 * AdonisJS **Lucid** — DBOS-style. Instead of a broker (Redis/SQS), remote steps are **rows** in the
 * same database the durable store already uses: `dispatch` inserts a task row; a worker poller claims
 * unclaimed task rows (atomic conditional `UPDATE … SET claimed_by`), runs the handler via
 * {@link runStepHandler}, and writes a result row the engine polls. Heartbeats and control messages
 * ride their own tables. Zero new infrastructure — often the simplest production transport.
 *
 * Claiming is portable across SQLite / Postgres / MySQL: it uses a compare-and-set UPDATE on
 * `claimed_by`/`claimed_at` (no `FOR UPDATE SKIP LOCKED`), so multiple workers never double-process a
 * row, and a crashed worker's claim is reclaimed once its lease (`leaseMs`) expires.
 *
 * Trade-off vs a real broker: throughput is bounded by polling + row contention — great for
 * workflow/pipeline scale (modest rate, long steps), not for high-fanout firehoses. The
 * {@link ControlPlane} here is single-consumer (one row → one poller), correct for a single engine
 * instance but NOT a true broadcast.
 *
 * Run one instance engine-side (`onResult` + `dispatch`) and one per worker process (`handle()` for
 * its group). Call {@link start} to begin the engine-side pollers; `handle()` auto-starts the task
 * loop. The wire payloads are the documented `RemoteTask`/`StepResult` JSON.
 *
 * Partitions by {@link DbTransportOptions.namespace} like the broker transports do: every row is
 * stamped with the instance's namespace and every claim is scoped to it, so several worker-pool
 * partitions can share ONE table set without cross-processing each other's work. `"default"` (and
 * absent) is byte-compatible with the pre-namespace scheme (all rows carry `'default'`).
 *
 * Usually you don't construct this directly: `config/durable.ts` selects it via
 * `transports.db({ ... })` and the provider builds it for you.
 */
export class DbTransport implements Transport, ControlPlane {
  readonly #db: Database;
  readonly #partition: string | undefined;
  /** Routing tokens this worker serves — `tenantGroup(sanitizeQueueToken(name), partition)` for each
   *  registered handler name; the task loop claims rows whose `grp` is in this set. */
  readonly #servedTokens = new Set<string>();
  // Logical deployment namespace stamped on every write and required on every claim. Mutable so an
  // engine can push its namespace via `useNamespace()` — but only when one wasn't passed explicitly to
  // the constructor (`#explicitNamespace`), which always wins. Resolved to a concrete column value
  // (`'default'` for absent/default) by `#namespaceValue()`.
  #namespace: string | undefined;
  readonly #explicitNamespace: boolean;
  readonly #connectionName: string | undefined;
  readonly #pollIntervalMs: number;
  readonly #leaseMs: number;
  readonly #batchSize: number;
  readonly #autoCreate: boolean;
  readonly #instanceId: string;
  readonly #handlers = new Map<string, StepHandler>();
  readonly #pollers: Pollers;
  #schemaReady: Promise<void> | undefined;
  #taskLoop: PollLoop | undefined;

  constructor(options: DbTransportOptions) {
    this.#db = options.db;
    this.#partition = options.partition;
    this.#namespace = options.namespace;
    this.#explicitNamespace = options.namespace !== undefined;
    this.#connectionName = options.connectionName;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#autoCreate = options.autoCreate ?? true;
    this.#instanceId = options.instanceId ?? randomUUID();
    this.#pollers = new Pollers(this.#pollIntervalMs, DEFAULT_LOG);
  }

  /** Stable id stamped on heartbeats, control `from`, and `claimed_by`. */
  get instanceId(): string {
    return this.#instanceId;
  }

  /**
   * Adopt `namespace` (the engine's, typically), scoping every write/claim to it — but ONLY if a
   * namespace wasn't passed explicitly to the constructor (an explicit one always wins). Idempotent.
   * Satisfies the optional `Transport.useNamespace` hook the engine calls when wiring a transport.
   */
  useNamespace(namespace: string): void {
    if (this.#explicitNamespace) return;
    this.#namespace = namespace;
  }

  /** The concrete `namespace` column value this instance stamps/claims: the set namespace, or
   *  `'default'` when absent — so the un-namespaced and `"default"` schemes claim the same rows. */
  #namespaceValue(): string {
    return this.#namespace ?? 'default';
  }

  #client(): Client {
    return this.#connectionName ? this.#db.connection(this.#connectionName) : this.#db.connection();
  }

  #now(): number {
    return Date.now();
  }

  #ensureSchema(): Promise<void> {
    if (!this.#autoCreate) return Promise.resolve();
    if (!this.#schemaReady) this.#schemaReady = createDurableTransportTables(this.#db);
    return this.#schemaReady;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // engine → worker
  // ───────────────────────────────────────────────────────────────────────────

  async dispatch(task: RemoteTask): Promise<void> {
    await this.#ensureSchema();
    // Idempotent: a redelivered dispatch for the same step_id is ignored (the PK already exists).
    // `onConflict().ignore()` is a Knex feature not surfaced on Lucid's insert contract, so we use
    // the underlying Knex builder (`.knexQuery`).
    await this.#client()
      .insertQuery()
      .table(TRANSPORT_TABLES.tasks)
      .knexQuery.insert({
        step_id: task.stepId,
        run_id: task.runId,
        seq: task.seq,
        name: task.name,
        grp: task.group,
        namespace: this.#namespaceValue(),
        input: toJson(task.input),
        traceparent: task.traceparent ?? null,
        context: toJson(task.context),
        transport: task.transport ?? null,
        attempt: task.attempt,
        claimed_by: null,
        claimed_at: null,
        created_at: this.#now(),
      })
      .onConflict('step_id')
      .ignore();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // worker side — register a handler, claim + run tasks, write results
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Register a step handler (worker side). Records this name's routing token
   * (`tenantGroup(sanitizeQueueToken(name), partition)`) as served and starts the shared task poll
   * loop on the first call — it claims task rows for EVERY served token (matching the token the
   * engine dispatches by), runs each through {@link runStepHandler}, and writes the result.
   */
  handle(name: string, fn: StepHandler): void {
    this.#handlers.set(name, fn);
    this.#servedTokens.add(tenantGroup(sanitizeQueueToken(name), this.#partition));
    if (!this.#taskLoop) {
      this.#taskLoop = this.#pollers.start(async () => (await this.#drainTasks()) > 0);
    }
  }

  /** Worker side: publish a liveness heartbeat for an in-flight long step. */
  async heartbeat(beat: Heartbeat): Promise<void> {
    await this.#ensureSchema();
    await this.#client().table(TRANSPORT_TABLES.heartbeats).insert({
      run_id: beat.runId,
      seq: beat.seq,
      step_id: beat.stepId,
      grp: beat.group,
      namespace: this.#namespaceValue(),
      claimed_by: null,
      claimed_at: null,
      created_at: this.#now(),
    });
  }

  async #drainTasks(): Promise<number> {
    if (this.#servedTokens.size === 0) return 0;
    const rows = await this.#claim<TaskRow>(TRANSPORT_TABLES.tasks, [...this.#servedTokens]);
    for (const row of rows) {
      const task: RemoteTask = {
        runId: row.run_id,
        seq: Number(row.seq),
        stepId: row.step_id,
        name: row.name,
        group: row.grp,
        input: fromJson(row.input),
        attempt: Number(row.attempt),
        ...(row.traceparent != null ? { traceparent: row.traceparent } : {}),
        ...(row.context != null ? { context: fromJson(row.context) } : {}),
        ...(row.transport != null ? { transport: row.transport } : {}),
      };
      const result = await runStepHandler(task, this.#handlers.get(task.name), (beat) =>
        this.heartbeat(beat),
      );
      await this.#insertResult(result);
      await this.#client().from(TRANSPORT_TABLES.tasks).where('step_id', task.stepId).delete();
    }
    return rows.length;
  }

  async #insertResult(result: StepResult): Promise<void> {
    await this.#client()
      .insertQuery()
      .table(TRANSPORT_TABLES.results)
      .knexQuery.insert({
        step_id: result.stepId,
        run_id: result.runId,
        seq: result.seq,
        status: result.status,
        namespace: this.#namespaceValue(),
        output: toJson(result.output),
        error: toJson(result.error),
        started_at: result.startedAt ?? null,
        events: toJson(result.events),
        claimed_by: null,
        claimed_at: null,
        created_at: this.#now(),
      })
      .onConflict('step_id')
      .ignore();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // worker → engine — the engine polls results + heartbeats
  // ───────────────────────────────────────────────────────────────────────────

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.#pollers.start(async () => (await this.#drainResults(handler)) > 0);
  }

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    this.#pollers.start(async () => (await this.#drainHeartbeats(handler)) > 0);
  }

  async #drainResults(handler: (result: StepResult) => Promise<void>): Promise<number> {
    const rows = await this.#claim<ResultRow>(TRANSPORT_TABLES.results);
    for (const row of rows) {
      const result: StepResult = {
        runId: row.run_id,
        seq: Number(row.seq),
        stepId: row.step_id,
        status: row.status as StepResult['status'],
        output: fromJson(row.output),
        error: fromJson(row.error),
        startedAt: row.started_at == null ? undefined : Number(row.started_at),
        events: fromJson(row.events),
      };
      await handler(result);
      await this.#client().from(TRANSPORT_TABLES.results).where('step_id', result.stepId).delete();
    }
    return rows.length;
  }

  async #drainHeartbeats(handler: (beat: Heartbeat) => Promise<void>): Promise<number> {
    const rows = await this.#claim<HeartbeatRow>(TRANSPORT_TABLES.heartbeats, undefined, 'id');
    for (const row of rows) {
      await handler({
        runId: row.run_id,
        seq: Number(row.seq),
        stepId: row.step_id,
        group: row.grp,
      });
      await this.#client().from(TRANSPORT_TABLES.heartbeats).where('id', row.id).delete();
    }
    return rows.length;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // control plane (best-effort, single-consumer)
  // ───────────────────────────────────────────────────────────────────────────

  async publishControl(msg: ControlMessage): Promise<void> {
    await this.#ensureSchema();
    const stamped: ControlMessage = msg.from ? msg : { ...msg, from: this.#instanceId };
    await this.#client()
      .table(TRANSPORT_TABLES.control)
      .insert({
        payload: JSON.stringify(stamped),
        namespace: this.#namespaceValue(),
        claimed_by: null,
        claimed_at: null,
        created_at: this.#now(),
      });
  }

  onControl(handler: (msg: ControlMessage) => void): void {
    this.#pollers.start(async () => (await this.#drainControl(handler)) > 0);
  }

  async #drainControl(handler: (msg: ControlMessage) => void): Promise<number> {
    const rows = await this.#claim<ControlRow>(TRANSPORT_TABLES.control, undefined, 'id');
    for (const row of rows) {
      const msg = fromJson<ControlPayload>(row.payload);
      if (msg) handler(msg);
      await this.#client().from(TRANSPORT_TABLES.control).where('id', row.id).delete();
    }
    return rows.length;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // atomic claim — portable compare-and-set (no FOR UPDATE SKIP LOCKED)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Atomically claim up to `batchSize` un-leased rows (optionally narrowed by `where`) and stamp them
   * with this instance's id + a fresh per-round claim timestamp, then SELECT exactly the rows this
   * round stamped. The single conditional `UPDATE … WHERE claimed_at IS NULL OR claimed_at < stale`
   * is the concurrency guard: two instances racing the same rows can't both stamp them (the loser's
   * UPDATE matches nothing for those rows). A crashed claimer's rows are reclaimed once their lease
   * expires (`claimed_at < now - leaseMs`).
   *
   * `claimed_at` is set to a unique, strictly-increasing-per-round value so the SELECT-back is exact
   * even when the same instance claims several rounds in quick succession.
   */
  async #claim<T>(
    table: string,
    groups?: string[],
    idCol: 'id' | 'step_id' = 'step_id',
  ): Promise<T[]> {
    await this.#ensureSchema();
    // The raw Knex builder — `onConflict`, the `where(cb)` grouping and `whereIn` are cleaner there
    // than through Lucid's stricter query-builder typings, and we only need plain SQL here.
    const knex = this.#client().knexQuery();
    const stale = this.#now() - this.#leaseMs;
    // Every claim is namespace-scoped: this instance only ever sees rows stamped with its own
    // namespace, so two engines/workers on different namespaces sharing one table set never
    // cross-claim each other's tasks/results/heartbeats/control.
    const namespace = this.#namespaceValue();
    // Unique claim token for THIS round: instance id + a nanosecond stamp. Stored in `claimed_by` so
    // the SELECT-back returns only the rows this exact round won (never another round's, even from
    // the same instance).
    const token = `${this.#instanceId}:${process.hrtime.bigint().toString(36)}`;
    const at = this.#now();

    // 1) Pick candidate ids (unclaimed or stale-lease), oldest first, bounded by batchSize.
    const candidates = (await knex
      .from(table)
      .select(idCol)
      .where('namespace', namespace)
      .modify((q) => {
        if (groups !== undefined) q.whereIn('grp', groups);
      })
      .where((q) => q.whereNull('claimed_at').orWhere('claimed_at', '<', stale))
      .orderBy(idCol === 'id' ? 'id' : 'created_at', 'asc')
      .limit(this.#batchSize)) as Array<Record<string, unknown>>;
    if (candidates.length === 0) return [];
    const ids = candidates.map((c) => c[idCol] as string | number);

    // 2) Conditionally claim them — only rows STILL un-leased flip to this round's token. A racing
    //    instance's UPDATE matches nothing for the rows it lost, so no row is claimed twice.
    await this.#client()
      .knexQuery()
      .from(table)
      .where('namespace', namespace)
      .whereIn(idCol, ids)
      .where((q) => q.whereNull('claimed_at').orWhere('claimed_at', '<', stale))
      .update({ claimed_by: token, claimed_at: at });

    // 3) SELECT back exactly the rows this round won.
    const rows = (await this.#client()
      .knexQuery()
      .from(table)
      .select('*')
      .where('claimed_by', token)
      .where('claimed_at', at)) as T[];
    return rows;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // poll loop lifecycle (the recursive-timer / drain-burst / stop-all bookkeeping
  // lives in core's Pollers; here each loop is just a `drain* > 0` tick)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * No-op convenience: the loops auto-start when `onResult`/`onHeartbeat`/`onControl`/`handle` are
   * registered. Exposed for symmetry and to mirror broker transports — call it after wiring handlers
   * if you prefer an explicit start. Returns once the schema is ready.
   */
  async start(): Promise<void> {
    this.#pollers.reopen();
    await this.#ensureSchema();
  }

  /** Stop every poll loop. Does not close the shared `Database`. */
  async stop(): Promise<void> {
    this.#pollers.stopAll();
    this.#taskLoop = undefined;
  }

  /** Stop the pollers (alias of {@link stop} for the `Transport.close` contract). */
  async close(): Promise<void> {
    await this.stop();
  }
}
