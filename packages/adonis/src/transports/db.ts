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
  type RunReply,
  type RunRequest,
  type StartRunMessage,
  type StepResult,
  type TenantEvent,
  type Transport,
  type WorkerHeartbeat,
  type WorkerStatus,
  type WorkflowDecision,
  type WorkflowStepEvent,
  type WorkflowTask,
} from '../interfaces.js';
import { atLeastOne, Pollers, type PollLoop } from '../pollers.js';
import { runStepHandler, type StepHandler, withTurnHeartbeat } from '../protocol.js';
import { sanitizeQueueToken, tenantGroup } from '../tenant-group.js';
import type { DescriptorRedis } from '../worker-runtime/registry.js';
import type { WorkflowTurnHandler } from '../workflow-turn.js';
import { AdaptiveController, type ConcurrencyOption } from './adaptive-concurrency.js';
import { effectivePrefix, workerHeartbeatKey } from './bullmq/naming.js';
import {
  heartbeatKeyValue,
  parseHeartbeatValue,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from './bullmq/serialization.js';
import {
  DbInboxRegistry,
  DEFAULT_DB_INBOX_SWEEP_INTERVAL_MS,
  DEFAULT_DB_INBOX_TTL_MS,
  DEFAULT_DB_TENANT_SUBSCRIBERS_CACHE_MS,
} from './db-remote.js';
import {
  createDurableTransportTables,
  MESSAGE_KINDS,
  type MessageKind,
  TRANSPORT_TABLES,
} from './db-schema.js';
import { fanOutDecision, infrastructureFailure } from './task-failure.js';
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
/** Default budget (ms) `close()` waits for in-flight work before handing the rest back. */
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
/** The `priority` column is a 32-bit integer on every dialect. */
const PRIORITY_MIN = -2_147_483_648;
const PRIORITY_MAX = 2_147_483_647;

/**
 * The `priority` column value for the engine's dispatch `priority` (higher = more urgent): rounded and
 * clamped to the column's range, and `0` — "normal" — when absent, which is where the queue
 * transport's broker mapping puts an unprioritised job too.
 */
export function toDbPriority(priority?: number): number {
  if (priority == null || Number.isNaN(priority)) return 0;
  return Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, Math.round(priority)));
}

/** The task-table columns added after the first release that the transport adapts to. */
type TaskColumn = 'reclaims' | 'priority' | 'kind';
const MISSING_COLUMN: Record<TaskColumn, { effect: string; ddl: string }> = {
  reclaims: {
    effect: 'poison tasks are not bounded (maxStalledCount is off)',
    ddl: 'integer, not null, default 0',
  },
  priority: {
    effect: 'dispatch priority is ignored and tasks are claimed oldest first',
    ddl: 'integer, not null, default 0',
  },
  kind: {
    effect: 'remote workflow turns cannot be dispatched on it',
    ddl: "string, not null, default 'step'",
  },
};

/** A workflow turn as stored in a task row's `input`: the {@link WorkflowTask} plus the instance its
 *  decision is addressed to (stripped before the turn runs). */
type WorkflowTaskPayload = WorkflowTask & { replyTo?: string };

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
  /** `step` or `workflow`; absent on a legacy table (every row is a step there). */
  kind?: string | null;
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
interface MessageRow {
  id: number;
  kind: string;
  recipient: string;
  reply_to: string | null;
  payload: string;
}
/** Narrows a messages-table claim to one `kind`, addressed to any of `recipients` (`''` = anyone). */
interface MessageScope {
  kind: MessageKind;
  recipients: string[];
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
  /**
   * How long (ms) `close()`/`stop()` waits for in-flight work — running tasks, a result batch being
   * settled — before handing every claim still held back to the table, uncounted, so another worker
   * picks it up at once. Default 5000.
   */
  closeTimeoutMs?: number;
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
  /**
   * Store-less protocol and remote workflows: TTL (ms) of the keys an instance writes to say it is
   * consuming its addressed rows (run replies, tenant events, decisions) and which tenants' events it
   * wants, re-written every third of it. A publisher addresses rows only to live subscribers, and the
   * janitor deletes rows addressed to an instance whose key expired. Default 30000.
   */
  inboxTtlMs?: number;
  /** How long a publisher reuses its read of a tenant's live event subscribers (ms). A subscription
   *  made within this window of an event may miss it. Default 1000; `0` reads on every event. */
  tenantSubscribersCacheMs?: number;
  /** How often (ms) an instance that addressed rows deletes those whose recipient is gone (a dead pod,
   *  an engine that crashed awaiting a decision). Default 30000; `0` disables the janitor. */
  inboxSweepIntervalMs?: number;
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
 * It also carries remote workflow turns (`dispatchWorkflowTask` / `handleWorkflow` / `onDecision`,
 * streamed step events) and the store-less tenant-pod protocol (start-run, run-request, run replies,
 * tenant events), so a `tenant` pod can reach a `control-plane` over the database alone. Those ride the
 * `durable_transport_messages` table: run replies go to the requester only, tenant events to every
 * live subscriber of the tenant, decisions to the engine that dispatched the turn — see `db-remote.ts`.
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
  /** Whether the tasks table has each adaptive column (resolved once per column). */
  readonly #taskColumns = new Map<TaskColumn, Promise<boolean>>();
  /** Claim tokens `close()` handed back — a handler still running under one learns why it lost it. */
  readonly #handedBack = new Set<string>();
  readonly #closeTimeoutMs: number;
  /** Routing tokens this instance beats a liveness key for (one per handled step name). */
  readonly #heartbeatTokens = new Set<string>();
  readonly #workerHeartbeatIntervalMs: number;
  #workerHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** Liveness-key writes still in flight — `close()` lets them land before withdrawing the keys. */
  readonly #livenessWrites = new Set<Promise<void>>();
  /** Workflow turn consumers by workflow name — a `workflow` task row routes here. */
  readonly #workflowTurns = new Map<string, WorkflowTurnHandler>();
  /** Every `onDecision` handler (an engine subscribes one; it applies a decision by run id). */
  readonly #decisionHandlers = new Set<(decision: WorkflowDecision) => Promise<void>>();
  /** Which message loops run (each starts once). */
  readonly #messageLoops = new Set<MessageKind>();
  #runReplyHandler: ((reply: RunReply) => void) | undefined;
  /** Control-plane side: correlation id (requestId, or a start-run's runId) → the requester's instance
   *  id, held while the request's handler runs so {@link publishRunReply} knows whom to address. */
  readonly #replyRoutes = new Map<string, string>();
  readonly #tenantEventHandlers = new Map<string, Set<(evt: TenantEvent) => void>>();
  /** Serializes {@link publishTenantEvent} so each subscriber gets one publisher's events in order. */
  #tenantPublishChain: Promise<void> = Promise.resolve();
  readonly #inboxes: DbInboxRegistry;
  readonly #inboxTtlMs: number;
  readonly #inboxSweepIntervalMs: number;
  #sweepTimer: ReturnType<typeof setInterval> | undefined;
  #sweeping: Promise<void> | undefined;
  /** Whether the messages table exists (resolved once), and whether its absence was reported. */
  #messagesTable: Promise<boolean> | undefined;
  #messagesTableReported = false;

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
    this.#closeTimeoutMs =
      options.closeTimeoutMs !== undefined && options.closeTimeoutMs >= 0
        ? options.closeTimeoutMs
        : DEFAULT_CLOSE_TIMEOUT_MS;
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
    this.#inboxTtlMs = atLeastOne(options.inboxTtlMs, DEFAULT_DB_INBOX_TTL_MS);
    this.#inboxSweepIntervalMs =
      options.inboxSweepIntervalMs !== undefined && Number.isFinite(options.inboxSweepIntervalMs)
        ? Math.max(0, options.inboxSweepIntervalMs)
        : DEFAULT_DB_INBOX_SWEEP_INTERVAL_MS;
    this.#inboxes = new DbInboxRegistry({
      store: () => this.#workerKeys(),
      prefix: () => this.#keyPrefix(),
      instanceId: this.#instanceId,
      ttlMs: this.#inboxTtlMs,
      subscribersCacheMs:
        options.tenantSubscribersCacheMs ?? DEFAULT_DB_TENANT_SUBSCRIBERS_CACHE_MS,
      onError: this.#onError,
      now: () => this.#now(),
    });
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
    const withPriority = await this.#hasTaskColumn('priority');
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
        ...(withPriority ? { priority: toDbPriority(task.priority) } : {}),
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
    this.#serve(name);
  }

  /**
   * Register a WORKFLOW turn consumer (worker side). Shares the task loop — and the routing token —
   * of a step of the same name: {@link dispatchWorkflowTask} writes a task row of kind `workflow`, which
   * runs `turn(task)` in a slot like any step, and its {@link WorkflowDecision} is written to the
   * messages table, addressed to the engine instance that dispatched the turn. Re-registering swaps
   * the turn fn.
   */
  handleWorkflow(name: string, turn: WorkflowTurnHandler): void {
    this.#workflowTurns.set(name, turn);
    this.#serve(name);
  }

  /** Serve `name`'s routing token on the shared task loop (started on the first call). */
  #serve(name: string): void {
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
    await this.#client()
      .table(TRANSPORT_TABLES.heartbeats)
      .insert({
        run_id: beat.runId,
        seq: beat.seq,
        // '' for a run-scoped (workflow-turn) beat: the column is NOT NULL.
        step_id: beat.stepId ?? '',
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
    const [countReclaims, byPriority] = await Promise.all([
      this.#hasTaskColumn('reclaims'),
      this.#hasTaskColumn('priority'),
    ]);
    const { rows, token } = await this.#claim<TaskRow>(
      TRANSPORT_TABLES.tasks,
      Math.min(free, this.#batchSize),
      [...this.#servedTokens],
      'step_id',
      { countReclaims, byPriority },
    );
    if (rows.length === 0) return false;
    if (this.#pollers.closed) {
      // close() began while this round was claiming: don't start work it would only abandon.
      await this.#handBack(TRANSPORT_TABLES.tasks, [token]);
      return false;
    }
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
    if (row.kind === 'workflow') return this.#runWorkflowRow(row, token);
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
          if (this.#handedBack.has(token)) {
            this.#onError(
              new Error(
                `[DbTransport] task ${task.stepId} outlived close()'s ${this.#closeTimeoutMs}ms drain and was handed back, so another worker may have run it too; this run's result was dropped`,
              ),
            );
            return;
          }
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

  /**
   * Run one claimed `workflow` task row: replay the turn and settle it — delete the row and write its
   * {@link WorkflowDecision}, addressed to the engine that dispatched it, in ONE transaction and only
   * while this round still holds the claim (as a step's result). An unknown workflow or a throwing turn
   * still yields a `failed` decision so the run settles. A row past the poison bound is deleted without
   * a decision, as on the other transports: a turn carries no step to fail, and the turn's liveness
   * window (`remoteAdvanceSilenceMs` / the executor's `timeoutMs`) re-drives it.
   */
  async #runWorkflowRow(row: TaskRow, token: string): Promise<void> {
    const id = row.step_id;
    try {
      let task: WorkflowTask;
      let replyTo: string | undefined;
      try {
        const payload = fromJson<WorkflowTaskPayload>(row.input);
        if (!payload) throw new Error('empty payload');
        ({ replyTo, ...task } = payload);
      } catch (err) {
        this.#release(TRANSPORT_TABLES.tasks, token, id);
        await this.#deleteClaimed(TRANSPORT_TABLES.tasks, 'step_id', id, token);
        this.#onError(
          new Error(
            `[DbTransport] dropped workflow task ${id}: unreadable payload (${String(err)})`,
          ),
        );
        return;
      }
      if (row.reclaims != null && Number(row.reclaims) > this.#maxStalledCount) {
        this.#release(TRANSPORT_TABLES.tasks, token, id);
        await this.#deleteClaimed(TRANSPORT_TABLES.tasks, 'step_id', id, token);
        this.#onError(
          new Error(
            `[DbTransport] dropped workflow task ${id} (run ${task.runId}): its claim lapsed more than ${this.#maxStalledCount} times. No decision is written: as on bullmq and queue, the turn is re-driven by the executor's timeoutMs or by recovery`,
          ),
        );
        return;
      }
      if (!(await this.#stillHolds(id, token))) {
        this.#release(TRANSPORT_TABLES.tasks, token, id);
        this.#onError(
          new Error(
            `[DbTransport] lost the claim on workflow task ${id} before running it — another worker took it over; not running it here`,
          ),
        );
        return;
      }
      const startedAt = Date.now();
      this.#controller.onStart();
      try {
        const decision = await this.#replayTurn(task);
        this.#release(TRANSPORT_TABLES.tasks, token, id);
        if (!(await this.#settleWorkflow(id, token, decision, replyTo))) {
          this.#onError(
            new Error(
              this.#handedBack.has(token)
                ? `[DbTransport] workflow task ${id} outlived close()'s ${this.#closeTimeoutMs}ms drain and was handed back; this turn's decision was dropped`
                : `[DbTransport] lost the claim on workflow task ${id} while running it — another worker took it over; this turn's decision was dropped`,
            ),
          );
        }
      } finally {
        // Only step durations feed the latency gradient; a turn still counts as in-flight work.
        this.#controller.onSettle(Date.now() - startedAt, true, 'workflow');
      }
    } catch (err) {
      this.#onError(err);
    } finally {
      this.#release(TRANSPORT_TABLES.tasks, token, id);
    }
  }

  /** Replay one turn. Never throws: an unknown workflow or a throwing turn is a `failed` decision. */
  async #replayTurn(task: WorkflowTask): Promise<WorkflowDecision> {
    const turn = this.#workflowTurns.get(task.workflow);
    if (!turn) {
      return {
        taskId: task.taskId,
        runId: task.runId,
        status: 'failed',
        commands: [],
        error: { message: `no workflow registered for '${task.workflow}'`, code: 'no_workflow' },
      };
    }
    try {
      return await withTurnHeartbeat(
        task,
        (beat) => this.heartbeat(beat),
        () => turn(task),
      );
    } catch (err) {
      this.#onError(err);
      return {
        taskId: task.taskId,
        runId: task.runId,
        status: 'failed',
        commands: [],
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  /** Delete the workflow row and write its decision in ONE transaction, only while `token` holds it. */
  async #settleWorkflow(
    id: string,
    token: string,
    decision: WorkflowDecision,
    replyTo: string | undefined,
  ): Promise<boolean> {
    const settled = await this.#client().transaction(async (trx) => {
      const deleted = await trx
        .knexQuery()
        .from(TRANSPORT_TABLES.tasks)
        .where('step_id', id)
        .where('claimed_by', token)
        .delete();
      if (Number(deleted) === 0) return false;
      await this.#insertMessages(
        MESSAGE_KINDS.decision,
        [{ recipient: replyTo ?? '', payload: decision }],
        trx,
      );
      return true;
    });
    if (settled && replyTo) this.#noteAddressed();
    return settled;
  }

  /** Delete one row of `table` while `token` still holds its claim. */
  async #deleteClaimed(
    table: string,
    idCol: 'id' | 'step_id',
    id: string | number,
    token: string,
  ): Promise<void> {
    await this.#client()
      .knexQuery()
      .from(table)
      .where(idCol, id)
      .where('claimed_by', token)
      .delete();
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
            ...(row.step_id ? { stepId: row.step_id } : {}),
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
    scope?: MessageScope,
  ): Promise<number> {
    const { rows, token } = await this.#claim<T>(table, this.#batchSize, undefined, idCol, {
      scope,
    });
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
  // remote workflows + the store-less (tenant pod) protocol — the messages table
  //
  // Workflow turns ride the task table (kind `workflow`, next to the steps of the same token). Every
  // other message is a row of `durable_transport_messages`, claimed and deleted like the other
  // channels and told apart by `kind`. A row is either for ANY consumer of its kind (`recipient = ''`:
  // step events, start-run, run-request) or addressed to ONE instance (`recipient = <instanceId>`: the
  // reply to the requester, a tenant event to each live subscriber, a decision to the engine that
  // dispatched the turn). See `db-remote.ts` for the subscriber registry and the janitor.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Whether the messages table exists — `autoCreate` creates it; a deployment that runs its own
   * migrations needs `create_durable_transport_messages`. Resolved once. With `report`, its absence is
   * said ONCE through `onError` (the consumer loops ask silently, so a deployment that never uses the
   * protocol hears nothing).
   */
  async #messagesReady(report: boolean): Promise<boolean> {
    let known = this.#messagesTable;
    if (!known) {
      known = this.#ensureSchema()
        .then(() => this.#client().schema.hasTable(TRANSPORT_TABLES.messages))
        .catch((err) => {
          this.#messagesTable = undefined; // unknown yet (a transient error): ask again next time
          this.#onError(err);
          return false;
        });
      this.#messagesTable = known;
    }
    const has = await known;
    if (!has && report && !this.#messagesTableReported) {
      this.#messagesTableReported = true;
      this.#onError(new Error(this.#messagesMissing()));
    }
    return has;
  }

  #messagesMissing(): string {
    return `[DbTransport] the ${TRANSPORT_TABLES.messages} table does not exist, so remote workflows and store-less tenant pods do not work on this transport. Run the create_durable_transport_messages migration (node ace configure @adonis-agora/durable publishes it), or enable autoCreate`;
  }

  /** Insert `rows` of `kind` in one statement. */
  async #insertMessages(
    kind: MessageKind,
    rows: Array<{ recipient?: string; replyTo?: string; payload: unknown }>,
    client: Client = this.#client(),
  ): Promise<void> {
    if (rows.length === 0) return;
    const at = this.#now();
    await client
      .insertQuery()
      .table(TRANSPORT_TABLES.messages)
      .knexQuery.insert(
        rows.map((row) => ({
          kind,
          namespace: this.#namespaceValue(),
          recipient: row.recipient ?? '',
          reply_to: row.replyTo ?? null,
          payload: JSON.stringify(row.payload),
          claimed_by: null,
          claimed_at: null,
          created_at: at,
        })),
      );
  }

  /**
   * Start the consumer loop of `kind` (once). `recipients` is re-read every poll. A loop over rows
   * anyone may take is `shared`: parked while consumers are deferred, like every other consumer. One
   * over rows addressed to this instance is not — nobody else could take them. A payload that does not
   * parse is reported and dropped (never re-delivered forever).
   */
  #startMessageLoop<T>(
    kind: MessageKind,
    {
      shared,
      recipients,
      idleBackoffMax,
      each,
    }: {
      shared: boolean;
      recipients: () => string[];
      idleBackoffMax: number;
      each: (payload: T, row: MessageRow) => Promise<void>;
    },
  ): void {
    if (this.#messageLoops.has(kind)) return;
    this.#messageLoops.add(kind);
    const tick = async (): Promise<boolean> => {
      if (!(await this.#messagesReady(false))) return false;
      const handled = await this.#drain<MessageRow>(
        TRANSPORT_TABLES.messages,
        'id',
        1,
        async (row) => {
          let payload: T;
          try {
            payload = JSON.parse(row.payload) as T;
          } catch (err) {
            this.#onError(
              new Error(`[DbTransport] dropped ${kind} message ${row.id}: ${String(err)}`),
            );
            return;
          }
          await each(payload, row);
        },
        { kind, recipients: recipients() },
      );
      return handled > 0;
    };
    if (shared) this.#startLoop(tick, idleBackoffMax);
    else this.#pollers.start(tick, { idleBackoffMax });
  }

  /** This instance consumes rows addressed to it: keep its inbox key live (and delete what is left
   *  addressed to it on close). */
  #consumeInbox(): void {
    void this.#inboxes.activateInbox();
  }

  /** This instance addressed a row to another one: run the janitor (once). */
  #noteAddressed(): void {
    if (this.#inboxSweepIntervalMs <= 0 || this.#sweepTimer) return;
    this.#sweepTimer = setInterval(() => {
      if (this.#sweeping) return;
      const round = this.sweepInboxes()
        .catch((err) => this.#onError(err))
        .finally(() => {
          if (this.#sweeping === round) this.#sweeping = undefined;
        });
      this.#sweeping = round;
    }, this.#inboxSweepIntervalMs);
    this.#sweepTimer.unref?.();
  }

  /**
   * One janitor round: delete the addressed rows older than the inbox TTL whose recipient has no live
   * inbox key — a requester or subscriber that died, an engine that crashed awaiting a decision. Rows
   * younger than the TTL are never touched, so an instance that is just starting (or whose key write is
   * a refresh late) keeps its rows. Reads everything from the database, so it needs no memory of what
   * was addressed — any instance that addressed a row runs it, and a restart forgets nothing.
   */
  async sweepInboxes(): Promise<void> {
    if (!(await this.#messagesReady(false))) return;
    const cutoff = this.#now() - this.#inboxTtlMs;
    const namespace = this.#namespaceValue();
    const recipients = (
      (await this.#client()
        .knexQuery()
        .from(TRANSPORT_TABLES.messages)
        .distinct('recipient')
        .where('namespace', namespace)
        .whereNot('recipient', '')
        .where('created_at', '<', cutoff)) as Array<{ recipient: string }>
    ).map((r) => r.recipient);
    if (recipients.length === 0) return;
    const alive = await this.#inboxes.liveInboxOwners();
    const dead = recipients.filter((r) => !alive.has(r));
    if (dead.length === 0) return;
    await this.#client()
      .knexQuery()
      .from(TRANSPORT_TABLES.messages)
      .where('namespace', namespace)
      .whereIn('recipient', dead)
      .where('created_at', '<', cutoff)
      .delete();
  }

  /**
   * engine → workflow worker: a {@link WorkflowTask} as a task row of kind `workflow` on the workflow's
   * routing token, where a {@link handleWorkflow} consumer claims it (with the token's steps, by
   * priority). Stamped with this instance as the decision's recipient when it consumes decisions, so
   * the decision comes back to the engine that dispatched the turn (any replica could apply it — the
   * engine applies decisions durably by run id — but the dispatcher is the one known to be live).
   * Idempotent per `taskId`. Throws when the schema lacks the tasks `kind` column or the messages table.
   */
  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    await this.#ensureSchema();
    const [hasKind, hasMessages, withPriority] = await Promise.all([
      this.#hasTaskColumn('kind'),
      this.#messagesReady(true),
      this.#hasTaskColumn('priority'),
    ]);
    if (!hasMessages) throw new Error(this.#messagesMissing());
    if (!hasKind) {
      throw new Error(
        `[DbTransport] ${TRANSPORT_TABLES.tasks} has no "kind" column, so remote workflow turns cannot be dispatched on it. Run the create_durable_transport_messages migration, or enable autoCreate`,
      );
    }
    const payload: WorkflowTaskPayload = {
      ...task,
      ...(this.#decisionHandlers.size > 0 ? { replyTo: this.#instanceId } : {}),
    };
    await this.#client()
      .insertQuery()
      .table(TRANSPORT_TABLES.tasks)
      .knexQuery.insert({
        step_id: task.taskId,
        run_id: task.runId,
        seq: 0,
        name: task.workflow,
        grp: task.group,
        namespace: this.#namespaceValue(),
        input: toJson(payload),
        traceparent: task.traceparent ?? null,
        context: null,
        transport: task.transport ?? null,
        attempt: task.attempt,
        kind: 'workflow',
        ...(withPriority ? { priority: toDbPriority(task.priority) } : {}),
        claimed_by: null,
        claimed_at: null,
        created_at: this.#now(),
      })
      .onConflict('step_id')
      .ignore();
  }

  /**
   * engine ← workflow worker: consume {@link WorkflowDecision}s. ONE loop per transport; every handler
   * sees every decision (the engine applies one by run id, dropping any its run no longer awaits). It claims the
   * decisions addressed to this instance — consumed even while consumers are deferred, as nobody else
   * may take them — and, once consuming, the unaddressed ones (a worker that did not know whom to
   * reply to). Never backs off: a decision is on the critical path of every remote workflow turn.
   */
  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.#decisionHandlers.add(handler);
    if (this.#messageLoops.has(MESSAGE_KINDS.decision)) return;
    this.#consumeInbox();
    this.#startMessageLoop<WorkflowDecision>(MESSAGE_KINDS.decision, {
      shared: false,
      recipients: () => (this.#consumersDeferred ? [this.#instanceId] : [this.#instanceId, '']),
      idleBackoffMax: 1,
      each: async (decision) => {
        // Every handler, concurrently; all settle before a failure redelivers the decision.
        await fanOutDecision(this.#decisionHandlers, decision, this.#onError);
      },
    });
  }

  /** workflow worker → engine: a local step's lifecycle, for ONE engine instance to checkpoint. A
   *  deployment without the messages table drops it (reported once): it is observability only. */
  async dispatchStepEvent(event: WorkflowStepEvent): Promise<void> {
    if (!(await this.#messagesReady(true))) return;
    await this.#insertMessages(MESSAGE_KINDS.stepEvent, [{ payload: event }]);
  }

  /** engine ← workflow worker: consume streamed step events. Idempotent — a second call is a no-op. */
  onStepEvent(handler: (event: WorkflowStepEvent) => Promise<void>): void {
    this.#startMessageLoop<WorkflowStepEvent>(MESSAGE_KINDS.stepEvent, {
      shared: true,
      recipients: () => [''],
      idleBackoffMax: this.#idleBackoffMax,
      each: (event) => handler(event),
    });
  }

  /** tenant → control plane: a {@link StartRunMessage} for any control plane, with this instance as
   *  the reply's recipient. Throws when the messages table is missing. */
  async dispatchStartRun(msg: StartRunMessage): Promise<void> {
    this.#ensureRunRepliesLoop();
    if (!(await this.#messagesReady(true))) throw new Error(this.#messagesMissing());
    await this.#insertMessages(MESSAGE_KINDS.startRun, [
      { replyTo: this.#instanceId, payload: msg },
    ]);
  }

  /** control plane ← tenant: consume {@link StartRunMessage}s. Idempotent — a second call is a no-op. */
  onStartRun(handler: (msg: StartRunMessage) => Promise<void>): void {
    this.#startMessageLoop<StartRunMessage>(MESSAGE_KINDS.startRun, {
      shared: true,
      recipients: () => [''],
      idleBackoffMax: this.#idleBackoffMax,
      each: (msg, row) => this.#withReplyRoute(msg.runId, row.reply_to, () => handler(msg)),
    });
  }

  /** tenant → control plane: a {@link RunRequest} for any control plane, with this instance as the
   *  reply's recipient. Throws when the messages table is missing. */
  async dispatchRunRequest(msg: RunRequest): Promise<void> {
    this.#ensureRunRepliesLoop();
    if (!(await this.#messagesReady(true))) throw new Error(this.#messagesMissing());
    await this.#insertMessages(MESSAGE_KINDS.runRequest, [
      { replyTo: this.#instanceId, payload: msg },
    ]);
  }

  /** control plane ← tenant: consume {@link RunRequest}s. Idempotent — a second call is a no-op. */
  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void {
    this.#startMessageLoop<RunRequest>(MESSAGE_KINDS.runRequest, {
      shared: true,
      recipients: () => [''],
      idleBackoffMax: this.#idleBackoffMax,
      each: (msg, row) => this.#withReplyRoute(msg.requestId, row.reply_to, () => handler(msg)),
    });
  }

  /** Remember who asked for `correlationId` while `work` (the responder, which replies inside it) runs. */
  async #withReplyRoute(
    correlationId: string | undefined,
    replyTo: string | null,
    work: () => Promise<void>,
  ): Promise<void> {
    if (correlationId === undefined || !replyTo) return work();
    this.#replyRoutes.set(correlationId, replyTo);
    try {
      await work();
    } finally {
      if (this.#replyRoutes.get(correlationId) === replyTo) this.#replyRoutes.delete(correlationId);
    }
  }

  /**
   * control plane → tenant: a correlated {@link RunReply}, addressed to the instance that sent the
   * request. Only the instance handling that request knows the requester, so this must run while it
   * is handled — which is what the responder does. A reply with no known requester is dropped and
   * reported, never broadcast.
   */
  async publishRunReply(reply: RunReply): Promise<void> {
    const owner = this.#replyRoutes.get(reply.requestId);
    if (owner === undefined) {
      this.#onError(
        new Error(
          `[DbTransport] dropped the run reply for "${reply.requestId}": no requester is known for it on this instance`,
        ),
      );
      return;
    }
    if (!(await this.#messagesReady(true))) return;
    await this.#insertMessages(MESSAGE_KINDS.runReply, [{ recipient: owner, payload: reply }]);
    this.#noteAddressed();
  }

  /**
   * tenant ← control plane: consume the replies addressed to this instance. Idempotent — a second call
   * is a no-op (one gateway per transport matches every reply by id). Consumed even while consumers are
   * deferred: nobody else may take them.
   */
  onRunReply(handler: (reply: RunReply) => void): void {
    if (this.#runReplyHandler) return;
    this.#runReplyHandler = handler;
    this.#ensureRunRepliesLoop();
  }

  /** Start consuming this instance's replies (once) — also on the first request, so a reply is never
   *  left behind because the gateway subscribed late. Never backs off: a reply is on the critical path
   *  of every proxied call. */
  #ensureRunRepliesLoop(): void {
    if (this.#messageLoops.has(MESSAGE_KINDS.runReply)) return;
    this.#consumeInbox();
    this.#startMessageLoop<RunReply>(MESSAGE_KINDS.runReply, {
      shared: false,
      recipients: () => [this.#instanceId],
      idleBackoffMax: 1,
      each: async (reply) => {
        try {
          this.#runReplyHandler?.(reply);
        } catch (err) {
          this.#onError(err); // a throwing listener must not re-deliver the reply
        }
      },
    });
  }

  /**
   * control plane → tenant: one row of the {@link TenantEvent} per instance with a live subscription to
   * `evt.tenant` (none: nothing is written), in one INSERT. Publishes are serialized, so each subscriber
   * receives one publisher's events in publish order.
   */
  publishTenantEvent(evt: TenantEvent): Promise<void> {
    const run = this.#tenantPublishChain.then(async () => {
      const owners = await this.#inboxes.subscribersOf(evt.tenant);
      if (owners.length === 0) return;
      if (!(await this.#messagesReady(true))) return;
      await this.#insertMessages(
        MESSAGE_KINDS.tenantEvent,
        owners.map((recipient) => ({ recipient, payload: evt })),
      );
      this.#noteAddressed();
    });
    this.#tenantPublishChain = run.catch(() => undefined);
    return run;
  }

  /**
   * tenant ← control plane: subscribe to `tenant`'s events. Writes this instance's subscriber key
   * (kept live every third of {@link DbTransportOptions.inboxTtlMs}) and consumes the events addressed
   * to it — never deferred, nobody else may take them. Returns an unsubscribe fn that detaches only
   * this handler; the last one removes the subscription.
   */
  onTenantEvent(tenant: string, handler: (evt: TenantEvent) => void): () => void {
    let handlers = this.#tenantEventHandlers.get(tenant);
    if (!handlers) {
      handlers = new Set();
      this.#tenantEventHandlers.set(tenant, handlers);
    }
    handlers.add(handler);
    void this.#inboxes.subscribe(tenant);
    // Keeps running after the last unsubscribe, so events written before the key went away are
    // consumed rather than left behind.
    this.#startMessageLoop<TenantEvent>(MESSAGE_KINDS.tenantEvent, {
      shared: false,
      recipients: () => [this.#instanceId],
      idleBackoffMax: this.#idleBackoffMax,
      each: async (evt) => {
        for (const h of this.#tenantEventHandlers.get(evt.tenant) ?? []) {
          try {
            h(evt);
          } catch (err) {
            this.#onError(err); // a throwing listener must not re-deliver (and reorder) the event
          }
        }
      },
    });
    return () => {
      const set = this.#tenantEventHandlers.get(tenant);
      if (!set?.delete(handler) || set.size > 0) return;
      this.#tenantEventHandlers.delete(tenant);
      this.#inboxes.unsubscribe(tenant);
    };
  }

  /** On close: remove this instance's inbox and subscriber keys, then delete what is still addressed
   *  to it — replies, events and decisions for a process going away have no one else to go to. */
  async #closeInboxes(): Promise<void> {
    await this.#inboxes.close();
    const own = [MESSAGE_KINDS.decision, MESSAGE_KINDS.runReply, MESSAGE_KINDS.tenantEvent].filter(
      (kind) => this.#messageLoops.has(kind),
    );
    if (own.length === 0) return;
    await this.#client()
      .knexQuery()
      .from(TRANSPORT_TABLES.messages)
      .where('namespace', this.#namespaceValue())
      .where('recipient', this.#instanceId)
      .whereIn('kind', own)
      .delete()
      .catch((err) => this.#onError(err));
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
    {
      countReclaims = false,
      byPriority = false,
      scope,
    }: { countReclaims?: boolean; byPriority?: boolean; scope?: MessageScope | undefined } = {},
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

    // 1) Pick candidate ids (unclaimed or stale-lease) — highest priority first when the table has
    //    one, then oldest — bounded by `limit`.
    const candidates = (await client
      .knexQuery()
      .from(table)
      .select(idCol, 'claimed_at')
      .where('namespace', namespace)
      .modify((q) => {
        if (groups !== undefined) q.whereIn('grp', groups);
        if (scope !== undefined) q.where('kind', scope.kind).whereIn('recipient', scope.recipients);
      })
      .where((q) => q.whereNull('claimed_at').orWhere('claimed_at', '<', stale))
      .modify((q) => {
        if (byPriority) q.orderBy('priority', 'desc');
      })
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
   * Whether the tasks table has `column` — `autoCreate` adds both, but a table from an older migration
   * run with `autoCreate: false` may lack them. Without `reclaims` the poison bound is off; without
   * `priority` dispatch priority is ignored and rows are claimed oldest first. Either is said once
   * through `onError`, and everything else behaves as before.
   */
  #hasTaskColumn(column: TaskColumn): Promise<boolean> {
    let known = this.#taskColumns.get(column);
    if (!known) {
      known = this.#ensureSchema()
        .then(() => this.#client().schema.hasColumn(TRANSPORT_TABLES.tasks, column))
        .then((has) => {
          if (!has) {
            this.#onError(
              new Error(
                `[DbTransport] ${TRANSPORT_TABLES.tasks} has no "${column}" column, so ${MISSING_COLUMN[column].effect}. Add it — ${MISSING_COLUMN[column].ddl} — or enable autoCreate`,
              ),
            );
          }
          return has;
        })
        .catch((err) => {
          // Unknown yet (a transient error): go without it this time, ask again next time.
          this.#taskColumns.delete(column);
          this.#onError(err);
          return false;
        });
      this.#taskColumns.set(column, known);
    }
    return known;
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
   * Hand `tokens`' rows of `table` back: clear `claimed_by`/`claimed_at` where the claim is still ours,
   * so the next poll anywhere claims them as fresh rows — NOT as lapsed claims, so a hand-back never
   * counts toward the poison bound — and stop renewing them.
   */
  async #handBack(table: string, tokens: string[]): Promise<void> {
    for (const token of tokens) {
      this.#handedBack.add(token);
      this.#releaseToken(table, token);
    }
    await this.#client()
      .knexQuery()
      .from(table)
      .whereIn('claimed_by', tokens)
      .update({ claimed_by: null, claimed_at: null });
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
      const write = Promise.resolve()
        .then(() => this.#workerKeys().put(key, value, now + ttlMs))
        .catch((err) => this.#onError(err));
      this.#livenessWrites.add(write);
      void write.finally(() => this.#livenessWrites.delete(write));
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
    if (!this.#workerKeyStore) {
      // The table is created with the others by #ensureSchema — waited for first, so a key written
      // while the schema is still being created never races its CREATE.
      const keys = lucidWorkerKeys(this.#db, {
        connectionName: this.#connectionName,
        autoCreate: false,
        now: () => this.#now(),
      });
      this.#workerKeyStore = {
        put: async (key, value, expiresAt) => {
          await this.#ensureSchema();
          await keys.put(key, value, expiresAt);
        },
        remove: async (removed) => {
          await this.#ensureSchema();
          await keys.remove(removed);
        },
        live: async (at) => {
          await this.#ensureSchema();
          return keys.live(at);
        },
      };
    }
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

  /**
   * Stop every poll loop and wait — bounded by {@link DbTransportOptions.closeTimeoutMs}, 5s by
   * default — for in-flight work: the tasks in a handler get to finish and write their result, and a
   * result batch being settled gets to finish. Whatever is still unfinished then is HANDED BACK: its
   * claims are cleared (only where still ours) so another worker picks the rows up at once, instead of
   * after the lease — and uncounted, so a deploy never pushes a long step toward the poison bound. A
   * handler still running here may finish after another worker re-ran its step; its result is
   * dropped. Does not close the shared `Database`.
   */
  async stop(): Promise<void> {
    this.#pollers.stopAll();
    this.#taskLoop = undefined;
    this.#controller.stop();
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
    if (this.#workerHeartbeatTimer) clearInterval(this.#workerHeartbeatTimer);
    // A clean stop withdraws this instance's liveness keys at once, so the dashboard and
    // `listWorkerGroups` drop it now instead of after the 35s TTL. In-flight beats land first, or one
    // could re-create a key after its removal.
    if (this.#heartbeatTokens.size > 0) {
      await Promise.allSettled([...this.#livenessWrites]);
      const keys = [...this.#heartbeatTokens].map((t) =>
        workerHeartbeatKey(this.#keyPrefix(), t, this.#instanceId),
      );
      this.#heartbeatTokens.clear();
      await Promise.resolve()
        .then(() => this.#workerKeys().remove(keys))
        .catch((err) => this.#onError(err));
    }
    this.#workerHeartbeatTimer = undefined;
    this.#heartbeatTokens.clear();
    const deadline = Date.now() + this.#closeTimeoutMs;
    await this.#pollers.drain(this.#closeTimeoutMs);
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
    // A renewal round in flight would re-stamp what we are about to hand back.
    await this.#renewal;
    for (const [table, byToken] of [...this.#held]) {
      const tokens = [...byToken.keys()];
      if (tokens.length === 0) continue;
      await this.#handBack(table, tokens).catch((err) => this.#onError(err));
    }
    await this.#sweeping;
    await this.#closeInboxes();
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
