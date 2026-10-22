import { randomUUID } from 'node:crypto';
import type { Database } from '@adonisjs/lucid/database';
import type {
  QueryClientContract,
  TransactionClientContract,
} from '@adonisjs/lucid/types/database';
import type { WorkerDescriptor } from '../handshake/descriptor.js';
import {
  type ControlMessage,
  type ControlPlane,
  type GroupHealth,
  type Heartbeat,
  type RemoteTask,
  type StepResult,
  type Transport,
  type WorkerHeartbeat,
  type WorkerStatus,
} from '../interfaces.js';
import { atLeastOne, Pollers, type PollLoop } from '../pollers.js';
import { runStepHandler, type StepHandler } from '../protocol.js';
import { sanitizeQueueToken, tenantGroup } from '../tenant-group.js';
import type { DescriptorRedis } from '../worker-runtime/registry.js';
import { AdaptiveController, type ConcurrencyOption } from './adaptive-concurrency.js';
import { effectivePrefix, workerHeartbeatKey } from './bullmq/naming.js';
import {
  heartbeatKeyValue,
  parseHeartbeatValue,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from './bullmq/serialization.js';
import { createDurableTransportTables, TRANSPORT_TABLES } from './db-schema.js';
import { infrastructureFailure } from './task-failure.js';
import {
  cachedLiveKeys,
  descriptorsOn,
  liveGroupsOf,
  type WorkerKeyStore,
  workerKeyWriter,
} from './worker-keys.js';
import { lucidWorkerKeys } from './worker-keys-db.js';

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
/** Default max rows claimed per poll (results / heartbeats / control; the task loop claims only as
 *  many rows as it has free slots, never more than this). */
const DEFAULT_BATCH_SIZE = 20;
/** Idle backoff for the task, heartbeat and control loops (the results loop is exempt): after
 *  consecutive empty polls the sleep doubles up to this many poll intervals. Same default as the
 *  queue transport. */
const DEFAULT_IDLE_BACKOFF_MAX = 4;
/** How many times a task row's lapsed claim may be taken over before the row is treated as poison
 *  (its workers keep dying on it) and failed instead of re-run. Same default as the queue transport. */
const DEFAULT_MAX_STALLED_COUNT = 3;
/** Key prefix of the worker liveness keys — the one a `WorkerRuntime` uses by default, so both kinds of
 *  beat land in the same keyspace and `groupHealth` reads them alike. */
const WORKER_KEY_PREFIX = 'durable';

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
  /** Absent on a legacy table without the column (and `autoCreate: false`). */
  reclaims?: number | string | null;
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
  /**
   * Max rows claimed per poll by the results, heartbeat and control loops. Default 20. The task loop
   * claims only as many rows as it has free {@link concurrency} slots (capped by this), so a worker
   * never hoards tasks an idle sibling could run.
   */
  batchSize?: number;
  /**
   * How many task rows this worker runs at once. Default 1. One poll loop serves every handler name and
   * keeps up to this many rows in flight — more slots add no polling — claiming only as many rows per
   * poll as there are free slots, and renewing every held claim.
   *
   * `'adaptive'`, or `{ mode: 'adaptive', min, max, start, tickMs, ramCeilingPct, cpuCeilingPct }`,
   * lets the {@link AdaptiveController} the BullMQ and queue transports use move the limit at runtime
   * (from step latency, errors/stalls, RSS and optionally CPU). Either way the limit, in-flight count,
   * RSS, CPU, throughput and p95 ride this worker's liveness key (see {@link DbTransport.groupHealth}).
   */
  concurrency?: ConcurrencyOption;
  /** How many step results the engine side settles at once. Default 1. */
  resultConcurrency?: number;
  /**
   * Idle backoff for the task, heartbeat and control loops, as a multiple of {@link pollIntervalMs}:
   * after consecutive empty polls the sleep doubles up to `idleBackoffMax × pollIntervalMs`, and any
   * poll that finds a row resets it. Default 4 (an idle loop polls every 800ms instead of 200ms); `1`
   * disables it. The results loop never backs off: a result is on the critical path of every step.
   */
  idleBackoffMax?: number;
  /**
   * How many times a task row's lapsed claim may be taken over (its worker stopped renewing — crashed,
   * or blocked its event loop past {@link leaseMs}) before the row is treated as poison: deleted, and a
   * RETRYABLE failed result published for its step so the engine's durable retry decides (re-dispatch
   * while attempts remain, then fail the step). Default 3, like the queue transport. Needs the tasks
   * table's `reclaims` column (added by `autoCreate`); without it reclaims are not counted.
   */
  maxStalledCount?: number;
  /**
   * How often (ms) a worker refreshes the liveness key of each step name it serves. Default 10000;
   * each key lives at least 35s (three intervals when longer), so a worker that dies drops out of
   * {@link DbTransport.groupHealth} within that.
   */
  workerHeartbeatIntervalMs?: number;
  /**
   * Where a transport failure is reported — a throwing poll, a lost claim, a failed liveness write.
   * Default `console.error`.
   */
  onError?: (err: unknown) => void;
  /** Create the transport tables on first use if missing. Default true. */
  autoCreate?: boolean;
  /**
   * How long a read of the worker advertisement table is reused (ms). The engine asks for a token's
   * descriptors before every dispatch; the fleet changes on the advertisement cadence (seconds), so
   * one read serves a burst. Default 5000; `0` reads every time.
   */
  workerKeysCacheMs?: number;
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
  readonly #workerKeysCacheMs: number;
  #workerKeyStore: WorkerKeyStore | undefined;
  #readWorkerKeys: (() => Promise<{ key: string; value: string }[]>) | undefined;
  readonly #handlers = new Map<string, StepHandler>();
  readonly #pollers: Pollers;
  /** When set (see {@link deferConsumers}), {@link #startLoop} parks its loop until
   *  {@link startConsumers}. Dispatching is never deferred; only consumption is. */
  #consumersDeferred = false;
  readonly #deferredStarts: Array<() => void> = [];
  #schemaReady: Promise<void> | undefined;
  #taskLoop: PollLoop | undefined;
  /** Fixed or adaptive task concurrency, plus the in-flight/latency/RSS/CPU telemetry the liveness
   *  key carries. One controller for the task loop of this instance, as on the queue transport. */
  readonly #controller: AdaptiveController;
  /** A task loop parked on "every slot busy", woken when an adaptive move raises the limit. */
  readonly #limitWaiters = new Set<() => void>();
  /** Every task row still in a handler — the slots in use, and what `stop()` waits for (bounded). */
  readonly #runningTasks = new Set<Promise<void>>();
  readonly #resultConcurrency: number;
  readonly #idleBackoffMax: number;
  readonly #maxStalledCount: number;
  readonly #onError: (err: unknown) => void;
  /** Claims this instance holds, per table: claim token → the row ids still held under it. Every one
   *  is renewed on {@link #renewTimer}, so no held row ages into another instance's reclaim. */
  readonly #held = new Map<string, Map<string, Set<string | number>>>();
  #renewTimer: ReturnType<typeof setInterval> | undefined;
  /** The renewal round in flight, so a slow database never stacks rounds. */
  #renewal: Promise<void> | undefined;
  /** Whether the tasks table has the `reclaims` column (resolved once). */
  #reclaimsColumn: Promise<boolean> | undefined;
  /** Routing tokens this instance beats a liveness key for (one per handled step name). */
  readonly #heartbeatTokens = new Set<string>();
  readonly #workerHeartbeatIntervalMs: number;
  #workerHeartbeatTimer: ReturnType<typeof setInterval> | undefined;

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
    this.#workerKeysCacheMs = options.workerKeysCacheMs ?? 5_000;
    this.#onError = options.onError ?? DEFAULT_LOG;
    this.#pollers = new Pollers(this.#pollIntervalMs, this.#onError);
    this.#controller = new AdaptiveController({
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
      apply: () => {
        for (const wake of this.#limitWaiters) wake();
      },
    });
    this.#resultConcurrency = atLeastOne(options.resultConcurrency, 1);
    this.#idleBackoffMax = atLeastOne(options.idleBackoffMax, DEFAULT_IDLE_BACKOFF_MAX);
    const maxStalled = options.maxStalledCount;
    this.#maxStalledCount =
      maxStalled !== undefined && !Number.isNaN(maxStalled) && maxStalled >= 0
        ? Math.floor(maxStalled)
        : DEFAULT_MAX_STALLED_COUNT;
    this.#workerHeartbeatIntervalMs = atLeastOne(
      options.workerHeartbeatIntervalMs,
      WORKER_HEARTBEAT_INTERVAL_MS,
    );
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
   * Park every consumer loop registered from now on ({@link handle}, {@link onResult},
   * {@link onHeartbeat}, {@link onControl}) until {@link startConsumers}. Task, result, heartbeat and
   * control rows are claimed by ONE consumer each, so a process not built to be a worker — a
   * `node ace` command, a REPL — would otherwise claim rows it then dies holding (re-delivered only
   * after the lease expires) and steal results addressed to the long-lived engine. The same gate as
   * the `queue` and `bullmq` transports; the provider calls it per the `consumers` config.
   */
  deferConsumers(): void {
    this.#consumersDeferred = true;
  }

  /** Start every loop parked by {@link deferConsumers} and stop deferring (`durable:work` calls it via
   *  `engine.startConsumers()`). Idempotent; a no-op when consumption was never deferred. */
  startConsumers(): void {
    if (!this.#consumersDeferred) return;
    this.#consumersDeferred = false;
    for (const start of this.#deferredStarts.splice(0)) start();
  }

  /** `#pollers.start`, unless consumption is deferred: then park it, returning a handle that still
   *  stops the loop whether it is started later or never. */
  #startLoop(tick: () => Promise<boolean>, idleBackoffMax: number): PollLoop {
    if (!this.#consumersDeferred) return this.#pollers.start(tick, { idleBackoffMax });
    let cancelled = false;
    let live: PollLoop | undefined;
    this.#deferredStarts.push(() => {
      if (!cancelled) live = this.#pollers.start(tick, { idleBackoffMax });
    });
    return {
      stop: () => {
        cancelled = true;
        live?.stop();
      },
    };
  }

  /** Run `start` once this instance really consumes: now, or at {@link startConsumers} when deferred. */
  #whenConsuming(start: () => void): void {
    if (this.#consumersDeferred) this.#deferredStarts.push(start);
    else start();
  }

  /**
   * Register a step handler (worker side). Records this name's routing token
   * (`tenantGroup(sanitizeQueueToken(name), partition)`) as served and starts the shared task poll
   * loop on the first call — it claims task rows for EVERY served token (matching the token the
   * engine dispatches by), runs each through {@link runStepHandler}, and writes the result. The loop
   * keeps up to {@link DbTransportOptions.concurrency} rows in flight, and each served token gets a
   * liveness key once the loop consumes (a deferred, producer-only process advertises nothing).
   */
  handle(name: string, fn: StepHandler): void {
    this.#handlers.set(name, fn);
    const token = tenantGroup(sanitizeQueueToken(name), this.#partition);
    const isNew = !this.#servedTokens.has(token);
    this.#servedTokens.add(token);
    if (!this.#taskLoop) {
      this.#taskLoop = this.#startLoop(() => this.#taskTick(), this.#idleBackoffMax);
      this.#whenConsuming(() => {
        for (const served of this.#servedTokens) this.#beginServing(served);
      });
    } else if (isNew) {
      this.#whenConsuming(() => this.#beginServing(token));
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

  /**
   * One task-loop round: claim as many rows as there are free slots (never more — a row claimed but
   * not running is a row an idle sibling can't run, and one whose lease nobody is using), hand each
   * to {@link #runTask}, and report work so the loop re-ticks at once. With every slot busy it waits
   * for one to free (or the adaptive limit to move) instead of polling.
   */
  async #taskTick(): Promise<boolean> {
    if (this.#servedTokens.size === 0) return false;
    const free = this.#controller.limit - this.#runningTasks.size;
    if (free <= 0) {
      await this.#slotFreed();
      return true;
    }
    const { rows, token } = await this.#claim<TaskRow>(
      TRANSPORT_TABLES.tasks,
      Math.min(free, this.#batchSize),
      [...this.#servedTokens],
      'step_id',
      await this.#countsReclaims(),
    );
    if (rows.length === 0) return false;
    this.#hold(
      TRANSPORT_TABLES.tasks,
      token,
      rows.map((row) => row.step_id),
    );
    for (const row of rows) {
      const run = this.#runTask(row, token);
      this.#runningTasks.add(run);
      void run.finally(() => this.#runningTasks.delete(run));
    }
    return true;
  }

  /** Resolve when a running task settles or the adaptive controller moves the limit. */
  async #slotFreed(): Promise<void> {
    let wake: () => void = () => {};
    const moved = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.#limitWaiters.add(wake);
    try {
      await Promise.race([...this.#runningTasks, moved]);
    } finally {
      this.#limitWaiters.delete(wake);
    }
  }

  /**
   * Run one claimed task row and settle it. A row whose claim lapsed more than
   * {@link DbTransportOptions.maxStalledCount} times is bridged to a failed result instead of run.
   * Otherwise the claim is re-checked first (a row is run only while this instance holds it), and the
   * result is published only by the instance still holding the claim (see {@link #settleTask}).
   * The claim is renewed for the whole run with every other held claim (see {@link #renewHeld}).
   */
  async #runTask(row: TaskRow, token: string): Promise<void> {
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
    try {
      if (row.reclaims != null && Number(row.reclaims) > this.#maxStalledCount) {
        // Its workers keep dying on it (or blocking past the lease): running it again would just
        // stall the next one. Fail it RETRYABLE so the engine's durable retry decides.
        this.#release(TRANSPORT_TABLES.tasks, token, task.stepId);
        await this.#settleTask(
          task.stepId,
          token,
          infrastructureFailure(task, `claim lapsed more than ${this.#maxStalledCount} times`),
        );
        return;
      }
      if (!(await this.#stillHolds(task.stepId, token))) {
        this.#release(TRANSPORT_TABLES.tasks, token, task.stepId);
        this.#onError(
          new Error(
            `[DbTransport] lost the claim on task ${task.stepId} before running it — another worker took it over; not running it here`,
          ),
        );
        return;
      }
      const startedAt = Date.now();
      this.#controller.onStart();
      let ok = false;
      try {
        const result = await runStepHandler(task, this.#handlers.get(task.name), (beat) =>
          this.heartbeat(beat),
        );
        ok = result.status === 'completed';
        // Stop renewing before settling: the settle deletes the row, and a renewal racing it would
        // count the row as lost.
        this.#release(TRANSPORT_TABLES.tasks, token, task.stepId);
        if (!(await this.#settleTask(task.stepId, token, result))) {
          this.#onError(
            new Error(
              `[DbTransport] lost the claim on task ${task.stepId} while running it (this worker went silent past leaseMs) — another worker took it over and may run it too; this run's result was dropped. Raise leaseMs if steps block the event loop`,
            ),
          );
        }
      } finally {
        this.#controller.onSettle(Date.now() - startedAt, ok, 'step');
      }
    } catch (err) {
      // A database error settling the row: it stays claimed, unrenewed, and is reclaimed after the
      // lease — at-least-once, like a crash.
      this.#onError(err);
    } finally {
      this.#release(TRANSPORT_TABLES.tasks, token, task.stepId);
    }
  }

  /** Re-stamp the row's claim if this round still holds it; `false` once another instance took it. */
  async #stillHolds(stepId: string, token: string): Promise<boolean> {
    const updated = await this.#client()
      .knexQuery()
      .from(TRANSPORT_TABLES.tasks)
      .where('step_id', stepId)
      .where('claimed_by', token)
      .update({ claimed_at: this.#now() });
    return Number(updated) > 0;
  }

  /**
   * Delete the task row and publish its result in ONE transaction, and only while `token` still holds
   * the claim: an instance whose claim was taken over neither deletes the new holder's row nor writes
   * a second result. Resolves whether this instance settled it.
   */
  async #settleTask(stepId: string, token: string, result: StepResult): Promise<boolean> {
    return this.#client().transaction(async (trx) => {
      const deleted = await trx
        .knexQuery()
        .from(TRANSPORT_TABLES.tasks)
        .where('step_id', stepId)
        .where('claimed_by', token)
        .delete();
      if (Number(deleted) === 0) return false;
      await this.#insertResult(result, trx);
      return true;
    });
  }

  async #insertResult(result: StepResult, client: Client = this.#client()): Promise<void> {
    await client
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

  /** Engine side: settle step results, up to {@link DbTransportOptions.resultConcurrency} at once. The
   *  results loop never backs off when idle — a result is on the critical path of every step. */
  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.#startLoop(
      async () =>
        (await this.#drain<ResultRow>(
          TRANSPORT_TABLES.results,
          'step_id',
          this.#resultConcurrency,
          async (row) => {
            await handler({
              runId: row.run_id,
              seq: Number(row.seq),
              stepId: row.step_id,
              status: row.status as StepResult['status'],
              output: fromJson(row.output),
              error: fromJson(row.error),
              startedAt: row.started_at == null ? undefined : Number(row.started_at),
              events: fromJson(row.events),
            });
          },
        )) > 0,
      1,
    );
  }

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    this.#startLoop(
      async () =>
        (await this.#drain<HeartbeatRow>(TRANSPORT_TABLES.heartbeats, 'id', 1, async (row) => {
          await handler({
            runId: row.run_id,
            seq: Number(row.seq),
            stepId: row.step_id,
            group: row.grp,
          });
        })) > 0,
      this.#idleBackoffMax,
    );
  }

  /**
   * Claim a batch of `table` rows, hand each to `each` (up to `concurrency` at once), then delete the
   * handled rows in one `WHERE IN` — only AFTER their handler ran (at-least-once), and only while this
   * round still holds their claim. The batch's claims are renewed until it is done, so a slow handler
   * never lets the rows behind it age into another instance's reclaim. A throwing `each` stops the
   * batch: the rows not handled stay claimed, unrenewed, and are re-delivered after the lease.
   */
  async #drain<T extends Record<string, unknown> | object>(
    table: string,
    idCol: 'id' | 'step_id',
    concurrency: number,
    each: (row: T) => Promise<void>,
  ): Promise<number> {
    const { rows, token } = await this.#claim<T>(table, this.#batchSize, undefined, idCol);
    if (rows.length === 0) return 0;
    const idOf = (row: T): string | number =>
      (row as Record<string, string | number>)[idCol] as string | number;
    this.#hold(table, token, rows.map(idOf));
    const done: Array<string | number> = [];
    try {
      await eachLimited(rows, concurrency, async (row) => {
        await each(row);
        done.push(idOf(row));
      });
    } finally {
      this.#releaseToken(table, token);
      if (done.length) {
        await this.#client()
          .knexQuery()
          .from(table)
          .whereIn(idCol, done)
          .where('claimed_by', token)
          .delete();
      }
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
    this.#startLoop(
      async () =>
        (await this.#drain<ControlRow>(TRANSPORT_TABLES.control, 'id', 1, async (row) => {
          const msg = fromJson<ControlPayload>(row.payload);
          if (msg) handler(msg);
        })) > 0,
      this.#idleBackoffMax,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // atomic claim — portable compare-and-set (no FOR UPDATE SKIP LOCKED)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Atomically claim up to `limit` un-leased rows (optionally narrowed to the routing tokens `groups`)
   * and stamp them with this instance's id + a fresh per-round claim timestamp, then SELECT exactly the
   * rows this round stamped. The conditional `UPDATE … WHERE claimed_at IS NULL` /
   * `… WHERE claimed_at < stale` is the concurrency guard: two instances racing the same rows can't
   * both stamp them (the loser's UPDATE matches nothing for those rows). A crashed claimer's rows are
   * reclaimed once their lease expires (`claimed_at < now - leaseMs`) — and with `countReclaims`, each
   * such takeover bumps the row's `reclaims` count (the poison-task bound).
   *
   * Fresh and stale candidates are stamped by separate UPDATEs so the increment never depends on how a
   * dialect orders the `SET` list (MySQL evaluates it left to right against the NEW values).
   */
  async #claim<T>(
    table: string,
    limit: number,
    groups?: string[],
    idCol: 'id' | 'step_id' = 'step_id',
    countReclaims = false,
  ): Promise<{ rows: T[]; token: string }> {
    await this.#ensureSchema();
    // The raw Knex builder — `onConflict`, the `where(cb)` grouping and `whereIn` are cleaner there
    // than through Lucid's stricter query-builder typings, and we only need plain SQL here.
    const client = this.#client();
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

    // 1) Pick candidate ids (unclaimed or stale-lease), oldest first, bounded by `limit`.
    const candidates = (await client
      .knexQuery()
      .from(table)
      .select(idCol, 'claimed_at')
      .where('namespace', namespace)
      .modify((q) => {
        if (groups !== undefined) q.whereIn('grp', groups);
      })
      .where((q) => q.whereNull('claimed_at').orWhere('claimed_at', '<', stale))
      .orderBy(idCol === 'id' ? 'id' : 'created_at', 'asc')
      .limit(limit)) as Array<Record<string, unknown>>;
    if (candidates.length === 0) return { rows: [], token };
    const fresh: Array<string | number> = [];
    const lapsed: Array<string | number> = [];
    for (const c of candidates) {
      (c.claimed_at == null ? fresh : lapsed).push(c[idCol] as string | number);
    }

    // 2) Conditionally claim them — only rows STILL un-leased flip to this round's token. A racing
    //    instance's UPDATE matches nothing for the rows it lost, so no row is claimed twice.
    if (fresh.length) {
      await client
        .knexQuery()
        .from(table)
        .where('namespace', namespace)
        .whereIn(idCol, fresh)
        .whereNull('claimed_at')
        .update({ claimed_by: token, claimed_at: at });
    }
    if (lapsed.length) {
      await client
        .knexQuery()
        .from(table)
        .where('namespace', namespace)
        .whereIn(idCol, lapsed)
        .where('claimed_at', '<', stale)
        .update({
          claimed_by: token,
          claimed_at: at,
          ...(countReclaims
            ? { reclaims: client.getWriteClient().raw('?? + 1', ['reclaims']) }
            : {}),
        });
    }

    // 3) SELECT back exactly the rows this round won.
    const rows = (await client
      .knexQuery()
      .from(table)
      .select('*')
      .where('claimed_by', token)
      .where('claimed_at', at)) as T[];
    return { rows, token };
  }

  /**
   * Whether task reclaims are counted: the tasks table has the `reclaims` column (`autoCreate` adds
   * it; a table from an older migration with `autoCreate: false` may not). Without it the poison
   * bound is off — said once through `onError` — and claims behave as before.
   */
  #countsReclaims(): Promise<boolean> {
    this.#reclaimsColumn ??= this.#ensureSchema()
      .then(() => this.#client().schema.hasColumn(TRANSPORT_TABLES.tasks, 'reclaims'))
      .then((has) => {
        if (!has) {
          this.#onError(
            new Error(
              `[DbTransport] ${TRANSPORT_TABLES.tasks} has no "reclaims" column, so poison tasks are not bounded (maxStalledCount is off). Add it — integer, not null, default 0 — or enable autoCreate`,
            ),
          );
        }
        return has;
      })
      .catch((err) => {
        // Unknown yet (a transient error): don't count this round, ask again next round.
        this.#reclaimsColumn = undefined;
        this.#onError(err);
        return false;
      });
    return this.#reclaimsColumn;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // claim renewal — every claim held, not only the row being run
  // ───────────────────────────────────────────────────────────────────────────

  /** Start renewing `ids` of `table`, claimed under `token`. */
  #hold(table: string, token: string, ids: Array<string | number>): void {
    let byToken = this.#held.get(table);
    if (!byToken) {
      byToken = new Map();
      this.#held.set(table, byToken);
    }
    byToken.set(token, new Set(ids));
    if (this.#renewTimer) return;
    const intervalMs = Math.max(10, Math.floor(this.#leaseMs / 3));
    this.#renewTimer = setInterval(() => {
      if (this.#renewal) return;
      const round = this.#renewHeld()
        .catch((err) => this.#onError(err))
        .finally(() => {
          if (this.#renewal === round) this.#renewal = undefined;
        });
      this.#renewal = round;
    }, intervalMs);
    this.#renewTimer.unref?.();
  }

  /** Stop renewing one row (settled, or no longer ours). Idempotent. */
  #release(table: string, token: string, id: string | number): void {
    const ids = this.#held.get(table)?.get(token);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) this.#releaseToken(table, token);
  }

  /** Stop renewing every row of a claim round. Stops the renewal timer once nothing is held. */
  #releaseToken(table: string, token: string): void {
    const byToken = this.#held.get(table);
    byToken?.delete(token);
    if (byToken?.size === 0) this.#held.delete(table);
    if (this.#held.size === 0 && this.#renewTimer) {
      clearInterval(this.#renewTimer);
      this.#renewTimer = undefined;
    }
  }

  /**
   * Re-stamp `claimed_at` on every row this instance holds — one UPDATE per table, matched on the
   * rounds' claim tokens, every `leaseMs / 3`. A slow but alive instance therefore keeps every row it
   * claimed (running or queued behind a slow one); only one that stopped renewing (crashed, lost the
   * database, or blocked its event loop past the lease) has its rows reclaimed. Fewer rows renewed
   * than still held means exactly that happened — reported, since the step may now run twice.
   */
  async #renewHeld(): Promise<void> {
    for (const [table, byToken] of [...this.#held]) {
      const tokens = [...byToken.keys()];
      if (tokens.length === 0) continue;
      const renewed = await this.#client()
        .knexQuery()
        .from(table)
        .whereIn('claimed_by', tokens)
        .update({ claimed_at: this.#now() });
      // Rows settled during the round-trip were released, not lost: count only what is still held.
      let stillHeld = 0;
      for (const token of tokens) stillHeld += this.#held.get(table)?.get(token)?.size ?? 0;
      if (Number(renewed) < stillHeld) {
        this.#onError(
          new Error(
            `[DbTransport] lost ${stillHeld - Number(renewed)} of ${stillHeld} claim(s) on ${table} before renewing them — another instance reclaimed them and may process them too; raise leaseMs if this process blocks its event loop`,
          ),
        );
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // worker liveness + health — `${P}-worker-heartbeat:<token>:<instanceId>` in the worker-key table
  // ───────────────────────────────────────────────────────────────────────────

  /** The prefix the liveness keys are built from (`durable`, `durable-<namespace>`). */
  #keyPrefix(): string {
    return effectivePrefix(WORKER_KEY_PREFIX, this.#namespace);
  }

  /** The task loop serves `token`: run the concurrency controller and beat its liveness key. */
  #beginServing(token: string): void {
    this.#controller.start();
    this.#startWorkerHeartbeat(token);
  }

  /**
   * Refresh every served routing token's liveness key on one shared interval (default 10s, live 35s),
   * stamped with the controller's {@link WorkerStatus} snapshot — the same `{ ts, status }` value and
   * key the BullMQ and queue transports write, so the dashboard's worker cards read all three alike.
   * A new token beats at once. Best-effort: a failed write goes to `onError` and the key expires.
   */
  #startWorkerHeartbeat(token: string): void {
    const ttlMs = Math.max(
      WORKER_HEARTBEAT_TTL_SECONDS * 1000,
      this.#workerHeartbeatIntervalMs * 3,
    );
    const beatOne = (t: string): void => {
      const now = this.#now();
      const key = workerHeartbeatKey(this.#keyPrefix(), t, this.#instanceId);
      const value = heartbeatKeyValue(now, this.#controller.snapshot());
      void Promise.resolve()
        .then(() => this.#workerKeys().put(key, value, now + ttlMs))
        .catch((err) => this.#onError(err));
    };
    if (!this.#heartbeatTokens.has(token)) {
      this.#heartbeatTokens.add(token);
      beatOne(token);
    }
    if (this.#workerHeartbeatTimer) return;
    this.#workerHeartbeatTimer = setInterval(() => {
      for (const t of this.#heartbeatTokens) beatOne(t);
    }, this.#workerHeartbeatIntervalMs);
    this.#workerHeartbeatTimer.unref?.();
  }

  /**
   * Per-group worker health, for `engine.workerHealth()` and the dashboard/Telescope worker panels.
   *
   * - `depth` is every task row of `group` in this namespace — pending AND claimed (running, or held
   *   by a worker that died and not yet reclaimed): the DB can count both, so it is closer to BullMQ's
   *   waiting+active than the queue transport's pending-only count.
   * - `liveWorkers` are the unexpired `${P}-worker-heartbeat:<group>:<instance>` keys in the
   *   worker-key table, each with the worker's {@link WorkerStatus} when it carries one (this
   *   transport's own beats do; a `WorkerRuntime`'s compact beat reads as liveness only).
   */
  async groupHealth(group: string): Promise<GroupHealth> {
    await this.#ensureSchema();
    const [counted, entries] = await Promise.all([
      this.#client()
        .knexQuery()
        .from(TRANSPORT_TABLES.tasks)
        .where('namespace', this.#namespaceValue())
        .where('grp', group)
        .count({ n: '*' })
        .first() as Promise<{ n?: number | string } | undefined>,
      this.#liveWorkerKeys(),
    ]);
    const marker = workerHeartbeatKey(this.#keyPrefix(), group, '');
    const liveWorkers: WorkerHeartbeat[] = [];
    for (const { key, value } of entries) {
      if (!key.startsWith(marker)) continue;
      const parsed = parseHeartbeatValue(value);
      liveWorkers.push({
        group,
        instanceId: key.slice(marker.length),
        lastBeatAt: parsed.lastBeatAt,
        ...(parsed.status !== undefined
          ? { status: parsed.status as unknown as WorkerStatus }
          : {}),
      });
    }
    return { group, depth: Number(counted?.n) || 0, liveWorkers };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // worker advertisement (design §7.2) — a key/value table with an expiry per key
  // ───────────────────────────────────────────────────────────────────────────

  #workerKeys(): WorkerKeyStore {
    this.#workerKeyStore ??= lucidWorkerKeys(this.#db, {
      connectionName: this.#connectionName,
      autoCreate: this.#autoCreate,
      now: () => this.#now(),
    });
    return this.#workerKeyStore;
  }

  /** The writer a worker runtime's registry advertises its descriptor and heartbeat through. */
  createDescriptorRedis(): DescriptorRedis {
    return workerKeyWriter(this.#workerKeys(), () => this.#now());
  }

  /** The live advertisement keys, reused for {@link DbTransportOptions.workerKeysCacheMs}. */
  #liveWorkerKeys(): Promise<{ key: string; value: string }[]> {
    this.#readWorkerKeys ??= cachedLiveKeys(this.#workerKeys(), this.#workerKeysCacheMs, () =>
      this.#now(),
    );
    return this.#readWorkerKeys();
  }

  /** The live worker descriptors advertised on `token`. */
  async listWorkerDescriptors(token: string): Promise<WorkerDescriptor[]> {
    return descriptorsOn(await this.#liveWorkerKeys(), token);
  }

  /** The routing tokens a live worker beats on. */
  async listWorkerGroups(): Promise<string[]> {
    return liveGroupsOf(await this.#liveWorkerKeys());
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

  /** Stop every poll loop and wait (bounded, 5s in all) for in-flight work — the tasks in a handler
   *  get to finish + write their result instead of being abandoned to the lease expiry; their claims
   *  keep being renewed until they settle. Does not close the shared `Database`. */
  async stop(): Promise<void> {
    this.#pollers.stopAll();
    this.#taskLoop = undefined;
    this.#controller.stop();
    if (this.#workerHeartbeatTimer) clearInterval(this.#workerHeartbeatTimer);
    this.#workerHeartbeatTimer = undefined;
    this.#heartbeatTokens.clear();
    const deadline = Date.now() + 5_000;
    await this.#pollers.drain(5_000);
    if (this.#runningTasks.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.#runningTasks]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, Math.max(deadline - Date.now(), 0));
        }),
      ]);
      clearTimeout(timer);
    }
  }

  /** Stop the pollers (alias of {@link stop} for the `Transport.close` contract). */
  async close(): Promise<void> {
    await this.stop();
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight, in order of start. The first failure stops
 * starting new items; the ones already running settle, then it rethrows.
 */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { err: unknown } | undefined;
  const lane = async (): Promise<void> => {
    while (!failure && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (err) {
        failure ??= { err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure) throw failure.err;
}
