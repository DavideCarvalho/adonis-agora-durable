import { randomUUID } from 'node:crypto';
import type { AcquiredJob, AdapterFactory, JobData } from '@adonisjs/queue/types';
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
import { isWorkflowTask, type WorkflowTurnHandler } from '../workflow-turn.js';
import { AdaptiveController, type ConcurrencyOption } from './adaptive-concurrency.js';
import { workerHeartbeatKey } from './bullmq/naming.js';
import {
  heartbeatKeyValue,
  parseHeartbeatValue,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from './bullmq/serialization.js';
import {
  DEFAULT_INBOX_SWEEP_INTERVAL_MS,
  DEFAULT_INBOX_TTL_MS,
  DEFAULT_TENANT_SUBSCRIBERS_CACHE_MS,
  InboxRegistry,
  inboxRegistrationsQueue,
  runRepliesQueue,
  tenantEventsQueue,
} from './queue-remote.js';
import { failedTaskIdentity, infrastructureFailure } from './task-failure.js';
import {
  cachedLiveKeys,
  descriptorsOn,
  liveGroupsOf,
  NO_WORKER_KEYS,
  type WorkerKeyStore,
  workerKeyWriter,
} from './worker-keys.js';

/**
 * The wire payloads carried as a queue job's `payload`. Everything that crosses the queue is plain
 * JSON — a `RemoteTask` (engine → worker), a `StepResult` / `Heartbeat` (worker → engine) and a
 * `ControlMessage` (best-effort). The adapter stores `payload: any`, so these helpers round-trip
 * through `JSON.stringify`/`JSON.parse` to guarantee that only JSON-safe values survive (functions,
 * symbols, `undefined` members are dropped exactly as a real broker would drop them).
 */

/** Serialize a value to a JSON-safe clone. Throws on a non-serializable value (e.g. a cycle). */
export function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Parse a job payload that we previously wrote with {@link toJson}. */
export function fromJson<T>(value: unknown): T {
  // The adapter already gives us a structured value; if a driver hands back a raw string
  // (some persist `payload` as text), decode it. Otherwise pass it straight through.
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return value as T;
}

export type TaskPayload = RemoteTask;
export type ResultPayload = StepResult;
export type HeartbeatPayload = Heartbeat;
export type ControlPayload = ControlMessage;
/** A run-request / start-run as it crosses the queue: the DTO plus the requester's instance id, so the
 *  control plane can route the reply to that requester's inbox (see `queue-remote.ts`). Private to this
 *  transport's wire — the shared {@link RunRequest} / {@link StartRunMessage} DTOs are unchanged. */
export type RunRequestPayload = RunRequest & { replyTo?: string };
export type StartRunPayload = StartRunMessage & { replyTo?: string };

/** How often the engine-side / worker-side poll loops ask the adapter for the next job. */
const DEFAULT_POLL_INTERVAL_MS = 200;
/** Idle backoff for the task, heartbeat and control loops: after consecutive empty polls the sleep
 *  doubles up to this many poll intervals (800ms at the default interval), and the first job found
 *  resets it. Each handler name has its own task loop, so an idle worker serving many step names
 *  would otherwise hit the backend `names × 5` times a second. The results loop is exempt — see
 *  {@link QueueTransportOptions.idleBackoffMax}. */
const DEFAULT_IDLE_BACKOFF_MAX = 4;

/** How often (ms) the stalled-job reclaim sweep runs — a coarse, low-frequency check, NOT per poll
 *  tick. Mirrors `DbTransport`'s crash-recovery cadence (its stale-lease default is also 30s). */
const DEFAULT_STALLED_CHECK_INTERVAL_MS = 30_000;
/** How old (ms) a claim must be before the sweep presumes its worker dead and re-delivers the job, on
 *  an adapter that CANNOT renew claims (one without `renewJobs` — every `@adonisjs/queue` driver has it,
 *  so in practice a custom adapter). There the claim's `acquiredAt` is never
 *  refreshed while the worker processes — a long step holds one claim for its whole duration — so the
 *  threshold must comfortably exceed the longest legitimate step: re-delivery double-runs a step whose
 *  worker is merely slow (safe under the durable idempotency contract, see the reclaim doc block, but
 *  not free). A step routinely longer than this should raise it. */
const DEFAULT_STALLED_THRESHOLD_MS = 1_800_000;
/** The threshold on an adapter that renews claims (`adapter.renewJobs`, on both `@adonisjs/queue` 0.6
 *  and 0.7). Every
 *  in-flight claim is renewed every half threshold (see {@link QueueTransport.#renewOpenClaims}), so a
 *  claim's age measures how long its worker has been SILENT, not how long the step has run: a dead
 *  worker's job is re-delivered within about this long, and a healthy long step never is. Larger than
 *  `@boringnode/queue`'s own 30s worker default so a step that blocks the event loop for a while (a
 *  CPU-heavy body starves the renewal timer) is not mistaken for a dead worker. */
const DEFAULT_RENEWING_STALLED_THRESHOLD_MS = 120_000;
/** How many times a single job may be reclaimed before the adapter fails it permanently instead of
 *  re-delivering — bounds a poison job that stalls every worker it touches. */
const DEFAULT_MAX_STALLED_COUNT = 3;
/** How many poison jobs (stalled past {@link DEFAULT_MAX_STALLED_COUNT}) one sweep of one queue hands
 *  back to this instance to fail. Only the `@boringnode/queue` >= 0.8 contract (`@adonisjs/queue` 0.7)
 *  has this argument: it keeps such jobs `active` and reassigns them to the caller, which must fail
 *  them itself. Older adapters ignore the extra argument and fail them internally. */
const MAX_EXCEEDED_PER_SWEEP = 100;

/**
 * The lease a `@boringnode/queue` >= 0.8 adapter (`@adonisjs/queue` 0.7) hands out with every claim:
 * `completeJob` / `retryJob` / `failJob` take `{ id, leaseToken }` instead of a bare job id, so only the
 * execution holding the claim can finalize it. Declared locally (not imported) so this module still
 * compiles and runs against `@adonisjs/queue` 0.6, whose adapters take the job id.
 */
interface JobLeaseLike {
  id: string;
  leaseToken: string;
}

/** Per-loop knobs: how many jobs it keeps in flight, and its idle backoff (instance default if unset).
 *  A function `concurrency` is a LIVE limit (the adaptive controller's), read on every tick. */
interface LoopOptions {
  concurrency?: number | (() => number);
  idleBackoffMax?: number;
}

/** What we pass an adapter's finalize methods: the lease on the new contract, the job id on the old. */
type JobHandle = JobLeaseLike | string;

/**
 * The slice of the adapter contract this transport drives, typed so it accepts BOTH `@adonisjs/queue`
 * contracts: 0.6 (`@boringnode/queue` 0.6 — job ids, `void` returns, `recoverStalledJobs` returning a
 * count) and 0.7 (`@boringnode/queue` 0.9 — leases, `boolean` returns, `recoverStalledJobs` taking a
 * `maxExceeded` and returning `{ recovered, exceeded }`). Which one we talk to is decided per job by
 * {@link jobHandle}: a claim that carries a `leaseToken` came from a lease-based adapter.
 */
interface CompatAdapter {
  setWorkerId(workerId: string): void;
  pushOn(queue: string, jobData: JobData): Promise<unknown>;
  popFrom(queue: string): Promise<AcquiredJob | null>;
  completeJob(job: JobHandle, queue: string): Promise<unknown>;
  failJob(job: JobHandle, queue: string, error?: Error): Promise<unknown>;
  retryJob(job: JobHandle, queue: string, retryAt?: Date): Promise<unknown>;
  /** Refresh the `acquiredAt` of in-flight claims — the heartbeat `@boringnode/queue`'s own `Worker`
   *  runs so long-running jobs are not mistaken for stalled ones. Takes the same handles as the finalize
   *  methods: leases on 0.9 (`@adonisjs/queue` 0.7), job ids on 0.6 (ownership checked against the
   *  adapter's worker id). Resolves to how many were renewed; a claim lost meanwhile is skipped. */
  renewJobs?(queue: string, jobs: JobHandle[]): Promise<number>;
  recoverStalledJobs?(
    queue: string,
    stalledThreshold: number,
    maxStalledCount: number,
    maxExceeded: number,
  ): Promise<number | { recovered: number; exceeded: AcquiredJob[] }>;
  /** How many jobs of `queue` are `pending` (ready to pop). Same on both contracts; excludes jobs in
   *  flight and delayed retries. */
  sizeOf?(queue: string): Promise<number>;
  destroy(): Promise<void>;
}

/**
 * The value to finalize a claimed job with: its lease (`{ id, leaseToken }`) when the adapter issued
 * one (`@adonisjs/queue` 0.7+), else its id (`@adonisjs/queue` 0.6). Passing a bare id to a lease-based
 * adapter finalizes nothing — the job stays `active` until the stalled sweep re-delivers it, so every
 * step would run twice — which is why this is decided from the claim itself, never assumed.
 */
export function jobHandle(job: AcquiredJob): JobHandle {
  const leaseToken = (job as { leaseToken?: unknown }).leaseToken;
  return typeof leaseToken === 'string' ? { id: job.id, leaseToken } : job.id;
}

/** Where a poll-loop failure goes when the caller doesn't supply an `onError`. Mirrors `DbTransport`:
 *  a transport error must never vanish — an invisible one is how a stalled run stays invisible. */
const DEFAULT_LOG = (err: unknown): void => console.error('[QueueTransport] poll failed', err);

// `@adonisjs/queue` job priority is the INVERSE of the durable engine's: a queue job runs the LOWEST
// number first (1..10, default 5), while the engine's admission `priority` is "higher wins". We map
// so one convention ("higher = more urgent") holds end-to-end. `BASELINE - p` keeps relative order (a
// higher `p` yields a lower — more urgent — broker number), clamped into the adapter's valid range.
// Centred on the default so callers have headroom both above and below it.
const BROKER_PRIORITY_MIN = 1;
const BROKER_PRIORITY_MAX = 10;
const BROKER_PRIORITY_BASELINE = 5;

/**
 * Map the engine's per-call `priority` (higher = more urgent, default/absent = unprioritised) onto an
 * `@adonisjs/queue` job `priority` (lower = more urgent). Returns `undefined` for an absent priority so
 * the default FIFO path is untouched.
 */
export function toBrokerPriority(priority?: number): number | undefined {
  if (priority == null) return undefined;
  const mapped = Math.round(BROKER_PRIORITY_BASELINE - priority);
  return Math.min(BROKER_PRIORITY_MAX, Math.max(BROKER_PRIORITY_MIN, mapped));
}

export interface QueueTransportOptions {
  /**
   * Factory for the `@adonisjs/queue` adapter this transport reads/writes. The same kind of factory
   * you hand `@adonisjs/queue`'s `defineConfig` (e.g. `redis(...)`, `knex(...)`, or `FakeAdapter`).
   * One adapter instance is created per transport and reused for every queue.
   */
  adapter: AdapterFactory;
  /**
   * @deprecated Steps are now routed BY HANDLER NAME, so this instance serves whatever names it
   * `handle()`s — no group to declare. Accepted for back-compat / parity with the pre-redesign API
   * and otherwise ignored (a worker subscribes to one task queue PER registered handler name). Use
   * {@link partition} for isolation.
   */
  group?: string;
  /**
   * Optional isolation partition suffixing every per-handler tasks queue this worker subscribes to
   * (`<name>@<partition>`), matching the `partition` a dispatch carries — so the same backend can
   * host several worker pools serving the same handler name without their tasks crossing. Unset (or
   * `'default'`) subscribes to the bare (sanitized) handler-name queue.
   */
  partition?: string;
  /** Queue-name prefix so several apps can share one backend without colliding. Default `durable`. */
  prefix?: string;
  /**
   * Logical deployment namespace, folded into every queue name so the same backend can host several
   * worker-pool partitions without their tasks/results crossing. `"default"` (and absent) keeps queue
   * names BYTE-IDENTICAL to the un-namespaced scheme (production is unchanged); any other value
   * inserts a `-<namespace>` segment after the prefix. Passing it here is EXPLICIT and wins over a
   * later {@link QueueTransport.useNamespace} (the engine's propagation).
   */
  namespace?: string;
  /** Poll interval (ms) for the result/task/heartbeat/control loops. Default 200ms. */
  pollIntervalMs?: number;
  /**
   * How many jobs of ONE step name this worker runs at once. Default 1 (one at a time, the historical
   * behavior). Each handler name's task loop keeps up to this many jobs in flight from a single poll
   * loop — more slots do not add polling — and every in-flight claim is renewed and drained on
   * `close()` like a single one.
   *
   * `'adaptive'`, or `{ mode: 'adaptive', min, max, start, tickMs, ramCeilingPct, cpuCeilingPct }`,
   * lets the same {@link AdaptiveController} the BullMQ transport uses move the limit at runtime (from
   * step latency, errors/stalls, RSS and optionally CPU); every task loop reads the live limit on each
   * tick. Either way the limit, in-flight count, RSS, CPU, throughput and p95 ride this worker's
   * liveness heartbeat (see {@link QueueTransport.groupHealth}).
   */
  concurrency?: ConcurrencyOption;
  /** How many step results the engine side settles at once. Default 1. */
  resultConcurrency?: number;
  /**
   * Idle backoff for the task, heartbeat and control loops, as a multiple of {@link pollIntervalMs}:
   * after consecutive empty polls the sleep doubles up to `idleBackoffMax × pollIntervalMs`, and any
   * poll that finds a job resets it. Default 4 (an idle loop polls every 800ms instead of 200ms),
   * which bounds the backend load of an idle worker serving many step names at the cost of up to that
   * much pickup latency for the first job after a quiet spell. `1` disables it. The results loop never
   * backs off: a result is on the critical path of every step.
   */
  idleBackoffMax?: number;
  /**
   * How often (ms) the stalled-job reclaim sweep runs. Reclaim is ON by default (default 30s); set to
   * `0` to disable it entirely. This is a coarse background check, NOT run on every poll tick — see
   * the reclaim doc block on {@link QueueTransport} for what it recovers and why default-on is safe.
   */
  stalledCheckIntervalMs?: number;
  /**
   * How old (ms) a claim must be before the reclaim sweep presumes its worker dead and re-delivers the
   * job. Only used when the adapter implements `recoverStalledJobs` and the sweep is enabled.
   *
   * - On an adapter that renews claims (`adapter.renewJobs` — every `@adonisjs/queue` 0.6/0.7 driver):
   *   default 2min. This transport renews every in-flight claim each half threshold, so the threshold
   *   bounds how long a worker may go SILENT (crashed, or its event loop blocked), not how long a step
   *   may run.
   * - On an adapter that cannot (a custom one without `renewJobs`): default 30min — intentionally
   *   generous, because the claim is never renewed and a legitimately long step holds it for its entire
   *   duration; re-delivery double-runs a step whose worker is merely slow. Raise it above your longest
   *   step.
   */
  stalledThresholdMs?: number;
  /**
   * How many times one job may be reclaimed before the adapter fails it permanently rather than
   * re-delivering (bounds a poison job). Default 3. Passed straight through to
   * `adapter.recoverStalledJobs`.
   */
  maxStalledCount?: number;
  /** Stable id for this process (stamped on heartbeats / control `from`). Default a random id. */
  instanceId?: string;
  /**
   * Where a poll-loop failure is reported — a job whose handler threw, or a throwing tick. Default
   * `console.error`. Point it at your app's logger to route transport failures into your logs.
   */
  onError?: (err: unknown) => void;
  /**
   * Where the worker advertisement (design §7.2: each worker's descriptor and heartbeat keys) lives.
   * A queue delivers each job to one consumer, so the keys cannot travel over it: they go to a key
   * store every engine and worker can read — `transports.queue()` defaults to the app database's
   * `durable_transport_worker_keys` table, the one the db transport uses. Absent: nothing is
   * advertised, and the engine routes without descriptors.
   */
  workerKeys?: WorkerKeyStore;
  /**
   * How long `close()` waits (ms) for jobs already in a handler before handing the rest back to the
   * broker. Default 5000 — the same option, and default, as the `bullmq` and `db` transports.
   */
  closeTimeoutMs?: number;
  /** How long a read of {@link workerKeys} is reused (ms). Default 5000; `0` reads every time. */
  workerKeysCacheMs?: number;
  /**
   * How often (ms) a worker refreshes the liveness key of each step name it serves. Default 10000;
   * each key lives at least 35s (three intervals when longer), so a worker that dies drops out of
   * {@link QueueTransport.groupHealth} within that.
   */
  workerHeartbeatIntervalMs?: number;
  /**
   * TTL (ms) of what an instance announces to the control plane for the store-less protocol: each
   * tenant it subscribes to (`onTenantEvent`) and that its inboxes are being consumed. The control plane
   * records both as keys in its {@link workerKeys} store; the instance re-announces every third of the
   * TTL. A subscriber that dies stops receiving pushes within about this long. Default 30000.
   */
  inboxTtlMs?: number;
  /**
   * How long a publisher reuses its read of a tenant's live subscribers (ms). A subscription made
   * within this window of an event may miss it. Default 1000; `0` reads the store on every event.
   */
  tenantSubscribersCacheMs?: number;
  /**
   * How often (ms) a publisher drains the inboxes it pushed run replies / tenant events to whose owner
   * no longer advertises itself (a dead tenant pod). Default 30000; `0` disables the janitor.
   */
  inboxSweepIntervalMs?: number;
}

/**
 * A `@adonisjs/queue`-backed {@link Transport}. Remote steps are dispatched to a per-group task
 * queue; the worker side runs the registered handler via {@link runStepHandler} and pushes the
 * {@link StepResult} onto a results queue the engine consumes. Heartbeats ride their own queue.
 *
 * `@adonisjs/queue` (0.6 and 0.7) is a one-directional job queue (dispatch → a separate `Worker` process
 * runs `job.execute()`), with no built-in way to await a job's result. This transport instead
 * drives the underlying queue **adapter** directly (`pushOn` / `popFrom` / `completeJob`), so both
 * directions are plain point-to-point queues we fully control. Notably the {@link ControlPlane} here
 * is single-consumer (point-to-point), so it is correct for a single engine instance but does NOT
 * fan out to every pod the way a real pub/sub does.
 *
 * It also carries remote workflow turns (`dispatchWorkflowTask` / `handleWorkflow` / `onDecision`,
 * streamed step events) and the store-less tenant-pod protocol (start-run, run-request, run replies,
 * tenant events), so a `tenant` pod can reach a `control-plane` over `@adonisjs/queue` alone. Run
 * replies and tenant events, which BullMQ broadcasts on Redis PUB/SUB, ride per-instance inbox queues
 * here — see `queue-remote.ts`.
 *
 * Run one instance engine-side (`onResult` + `dispatch`) and one per worker process (`handle()`).
 * The wire payloads are the documented `RemoteTask`/`StepResult` JSON, so non-Node workers on the
 * same queues interoperate.
 *
 * Usually you don't construct this directly: `config/durable.ts` selects it via
 * `transports.queue({ ... })` and the provider builds it for you.
 */
export class QueueTransport implements Transport, ControlPlane {
  readonly #adapter: CompatAdapter;
  readonly #partition: string | undefined;
  readonly #prefix: string;
  // Logical deployment namespace folded into every queue name via `#effectivePrefix()`. Mutable so an
  // engine can push its namespace onto a transport via `useNamespace()` — but only when one wasn't
  // passed explicitly to the constructor (`#explicitNamespace`), which always wins.
  #namespace: string | undefined;
  readonly #explicitNamespace: boolean;
  readonly #pollIntervalMs: number;
  readonly #closeTimeoutMs: number;
  /** Fixed or adaptive task concurrency, plus the in-flight/latency/RSS/CPU telemetry the liveness
   *  heartbeat carries. One controller for every task loop of this instance, as on BullMQ. */
  readonly #controller: AdaptiveController;
  /** Task loops parked on "every slot busy", woken when an adaptive move raises the limit. */
  readonly #limitWaiters = new Set<() => void>();
  /** The task queues this instance consumes — the reclaim sweep bridges a poison job only on these. */
  readonly #taskQueues = new Set<string>();
  /** Routing tokens this instance beats a liveness key for (one per handled step name). */
  readonly #heartbeatTokens = new Set<string>();
  readonly #workerHeartbeatIntervalMs: number;
  #workerHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** Liveness-key writes still in flight — `close()` lets them land before withdrawing the keys. */
  readonly #livenessWrites = new Set<Promise<void>>();
  readonly #resultConcurrency: number;
  readonly #idleBackoffMax: number;
  /** Every job handler still running (any queue) — `close()` waits for these, bounded. */
  readonly #runningJobs = new Set<Promise<void>>();
  readonly #stalledThresholdMs: number;
  readonly #maxStalledCount: number;
  readonly #instanceId: string;
  readonly #onError: (err: unknown) => void;
  readonly #handlers = new Map<string, StepHandler>();
  readonly #pollers: Pollers;
  /** One task poll loop per subscribed routing token (`tenantGroup(sanitizeQueueToken(name), partition)`)
   *  — a dedicated queue per handler name, never a single shared group queue. */
  readonly #taskLoops = new Map<string, PollLoop>();
  /** Every queue this instance POPS from (task queues on the worker, results/heartbeats/control on the
   *  engine). Populated by {@link QueueTransport.#startLoop} — the reclaim sweep walks exactly this set,
   *  so it covers whatever loops the instance actually started, worker- or engine-side. */
  readonly #poppedQueues = new Set<string>();
  /** Jobs popped and still in a handler (`jobId → { queue, handle }`) — re-delivered by close() if
   *  unfinished. The handle is the claim's lease on a lease-based adapter, needed to finalize it. */
  readonly #openJobs = new Map<string, { queue: string; handle: JobHandle }>();
  /** Drives the stalled-job reclaim sweep on its own (coarse) interval. Absent when reclaim is disabled
   *  (`stalledCheckIntervalMs <= 0`) or the adapter can't `recoverStalledJobs`. Separate from
   *  {@link #pollers} because the sweep cadence is unrelated to the fast job-poll cadence. */
  readonly #reclaimPollers: Pollers | undefined;
  /** Renews the claims in {@link #openJobs} every half threshold. Absent when the adapter can't
   *  `renewJobs`. */
  #renewTimer: ReturnType<typeof setInterval> | undefined;
  /** The renewal round in flight, so a slow adapter never stacks rounds and close() can await it. */
  #renewal: Promise<void> | undefined;
  /** When set (see {@link deferConsumers}), {@link QueueTransport.#startLoop} parks its loop here
   *  instead of polling — {@link startConsumers} flushes the parked starts. Dispatching (`pushOn`)
   *  is never deferred; only consumption is. */
  #consumersDeferred = false;
  readonly #deferredStarts: Array<() => void> = [];
  readonly #workerKeys: WorkerKeyStore;
  /** Whether a real key store was configured — without one there is no liveness to report. */
  readonly #hasWorkerKeys: boolean;
  readonly #liveWorkerKeys: () => Promise<{ key: string; value: string }[]>;
  /** Workflow turn consumers by workflow name — a `workflow`-shaped task job routes here. */
  readonly #workflowTurns = new Map<string, WorkflowTurnHandler>();
  /** Every `onDecision` handler (an engine subscribes one; it applies a decision by run id). */
  readonly #decisionHandlers = new Set<(decision: WorkflowDecision) => Promise<void>>();
  #decisionsLoop = false;
  #stepEventsLoop = false;
  #startRunLoop = false;
  #runRequestLoop = false;
  #runRepliesLoop = false;
  #runReplyHandler: ((reply: RunReply) => void) | undefined;
  #tenantEventsLoop = false;
  #registrationsLoop = false;
  #tenantRole = false;
  /** Control-plane side: correlation id (requestId, or a start-run's runId) → the requester's instance
   *  id, held while the request's handler runs so {@link publishRunReply} knows whose inbox to target. */
  readonly #replyRoutes = new Map<string, string>();
  readonly #tenantEventHandlers = new Map<string, Set<(evt: TenantEvent) => void>>();
  /** Serializes {@link publishTenantEvent} so events reach every inbox in the order they were published. */
  #tenantPublishChain: Promise<void> = Promise.resolve();
  readonly #inboxes: InboxRegistry;

  /**
   * Per-group worker health, for `engine.workerHealth()` and the dashboard/Telescope worker panels.
   * Present only when a {@link QueueTransportOptions.workerKeys} store is configured (the
   * `transports.queue()` default) — without one no worker can advertise liveness, and reporting
   * "backlog, zero workers" for every group would be a false alarm.
   *
   * - `depth` is the task queue's PENDING count (`adapter.sizeOf`), the jobs waiting for a worker.
   *   Unlike BullMQ's waiting+active+delayed+prioritized it leaves out jobs in flight and delayed
   *   retries: the `@adonisjs/queue` adapter contract has no count for those. Priorities are included
   *   (they are pending jobs). An adapter without `sizeOf` reports `0`.
   * - `liveWorkers` are the unexpired `${P}-worker-heartbeat:<group>:<instance>` keys, each with the
   *   worker's {@link WorkerStatus} when it carries one (this transport's own beats do).
   */
  readonly groupHealth?: (group: string) => Promise<GroupHealth>;

  constructor(options: QueueTransportOptions) {
    // Typed through CompatAdapter so the same code drives the 0.6 (job-id) and 0.7 (lease) contracts.
    this.#adapter = options.adapter() as unknown as CompatAdapter;
    this.#partition = options.partition;
    this.#prefix = options.prefix ?? 'durable';
    this.#namespace = options.namespace;
    this.#explicitNamespace = options.namespace !== undefined;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#closeTimeoutMs =
      options.closeTimeoutMs !== undefined &&
      Number.isFinite(options.closeTimeoutMs) &&
      options.closeTimeoutMs >= 0
        ? options.closeTimeoutMs
        : 5_000;
    this.#controller = new AdaptiveController({
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
      apply: () => {
        for (const wake of this.#limitWaiters) wake();
      },
    });
    this.#resultConcurrency = atLeastOne(options.resultConcurrency, 1);
    this.#idleBackoffMax = atLeastOne(options.idleBackoffMax, DEFAULT_IDLE_BACKOFF_MAX);
    const canRenew = typeof this.#adapter.renewJobs === 'function';
    this.#stalledThresholdMs =
      options.stalledThresholdMs ??
      (canRenew ? DEFAULT_RENEWING_STALLED_THRESHOLD_MS : DEFAULT_STALLED_THRESHOLD_MS);
    this.#maxStalledCount = options.maxStalledCount ?? DEFAULT_MAX_STALLED_COUNT;
    this.#instanceId = options.instanceId ?? randomUUID();
    this.#onError = options.onError ?? DEFAULT_LOG;
    // pop()/popFrom() require a worker id be set on the adapter before consuming.
    this.#adapter.setWorkerId(this.#instanceId);
    this.#pollers = new Pollers(this.#pollIntervalMs, this.#onError);
    this.#reclaimPollers = this.#startReclaimSweep(
      options.stalledCheckIntervalMs ?? DEFAULT_STALLED_CHECK_INTERVAL_MS,
    );
    if (canRenew) this.#startClaimRenewal();
    this.#hasWorkerKeys = options.workerKeys !== undefined;
    if (this.#hasWorkerKeys) this.groupHealth = (group) => this.#groupHealth(group);
    this.#workerHeartbeatIntervalMs = atLeastOne(
      options.workerHeartbeatIntervalMs,
      WORKER_HEARTBEAT_INTERVAL_MS,
    );
    this.#workerKeys = options.workerKeys ?? NO_WORKER_KEYS;
    this.#liveWorkerKeys = cachedLiveKeys(
      this.#workerKeys,
      options.workerKeysCacheMs ?? 5_000,
      Date.now,
    );
    this.#inboxes = new InboxRegistry({
      store: this.#workerKeys,
      prefix: () => this.#effectivePrefix(),
      instanceId: this.#instanceId,
      ttlMs: atLeastOne(options.inboxTtlMs, DEFAULT_INBOX_TTL_MS),
      subscribersCacheMs: options.tenantSubscribersCacheMs ?? DEFAULT_TENANT_SUBSCRIBERS_CACHE_MS,
      sweepIntervalMs: options.inboxSweepIntervalMs ?? DEFAULT_INBOX_SWEEP_INTERVAL_MS,
      announce: (registration) =>
        this.#adapter
          .pushOn(
            inboxRegistrationsQueue(this.#effectivePrefix()),
            this.#job('inboxRegistration', registration),
          )
          .then(() => undefined),
      drain: (queue, max) => this.#drainQueue(queue, max),
      onError: this.#onError,
    });
  }

  /** The writer a worker runtime's registry advertises its descriptor and heartbeat through: the key
   *  store when this instance has one. A store-less tenant pod (see {@link useTenantRole}) with no key
   *  store forwards it to the control plane instead, which records it in its own — so the control plane
   *  still sees the pod's workers. Otherwise, with no store, nothing is advertised. */
  createDescriptorRedis(): DescriptorRedis {
    if (this.#workerKeys === NO_WORKER_KEYS && this.#tenantRole) {
      return this.#inboxes.remoteKeyWriter();
    }
    return workerKeyWriter(this.#workerKeys, Date.now);
  }

  /** Declare that this transport backs a store-less `tenant` pod (the provider calls it): worker
   *  advertisement is then forwarded to the control plane when this instance has no key store. Only a
   *  tenant pod is guaranteed a control plane that records the forwarded keys. */
  useTenantRole(): void {
    this.#tenantRole = true;
  }

  /** The live worker descriptors advertised on `token`. */
  async listWorkerDescriptors(token: string): Promise<WorkerDescriptor[]> {
    return descriptorsOn(await this.#liveWorkerKeys(), token);
  }

  /** The routing tokens a live worker beats on. */
  async listWorkerGroups(): Promise<string[]> {
    return liveGroupsOf(await this.#liveWorkerKeys());
  }

  /** Stable id stamped on heartbeats and control `from`. */
  get instanceId(): string {
    return this.#instanceId;
  }

  /**
   * Park every consumer loop registered from now on ({@link handle}, {@link onResult},
   * {@link onHeartbeat}, {@link onControl}) instead of starting it, until {@link startConsumers}.
   *
   * WHY this exists: these queues are point-to-point — whoever pops a job owns it. Any process that
   * subscribes therefore competes with the real worker fleet for production jobs, and a process not
   * built to be a worker (an ace command, a REPL, a boot script) claims jobs it will die with:
   * observed in production as step jobs stuck in `active` stamped with the worker ids of long-gone
   * one-off commands, and as a boot-time command that never exited because the burst-drain loop kept
   * feeding it queued jobs. Deferring consumption makes such a process a pure *producer* — it can
   * still dispatch, publish and read the store — while the jobs stay on the queue for a real worker.
   *
   * Call it before any subscriptions are made (the provider does, right after building the
   * transport); loops already started are not retroactively stopped. The stalled-job reclaim sweep
   * needs no gating: it only walks queues this instance actually consumes, so it is a no-op until
   * {@link startConsumers} runs.
   */
  deferConsumers(): void {
    this.#consumersDeferred = true;
  }

  /** Start every consumer loop parked by {@link deferConsumers} and stop deferring — the explicit
   *  "this process IS a worker" declaration (`durable:work` makes it via `engine.startConsumers()`).
   *  Idempotent; a no-op when consumption was never deferred. */
  startConsumers(): void {
    if (!this.#consumersDeferred) return;
    this.#consumersDeferred = false;
    for (const start of this.#deferredStarts.splice(0)) start();
  }

  /**
   * Adopt `namespace` (the engine's, typically), folding it into every queue name — but ONLY if a
   * namespace wasn't passed explicitly to the constructor (an explicit one always wins). Idempotent.
   * Satisfies the optional `Transport.useNamespace` hook the engine calls when wiring a transport.
   */
  useNamespace(namespace: string): void {
    if (this.#explicitNamespace) return;
    this.#namespace = namespace;
  }

  /**
   * The prefix every queue name is built from, folding in the namespace: a set, non-`"default"`
   * namespace appends `-<namespace>`; otherwise the bare prefix (so the un-namespaced and `"default"`
   * schemes are byte-identical — production names never change). Keep ALL name builders routed through
   * this; a single direct `this.#prefix` would split an engine from its workers.
   */
  #effectivePrefix(): string {
    return this.#namespace && this.#namespace !== 'default'
      ? `${this.#prefix}-${this.#namespace}`
      : this.#prefix;
  }

  #tasksQueue(group: string): string {
    return `${this.#effectivePrefix()}:tasks:${group}`;
  }
  #resultsQueue(): string {
    return `${this.#effectivePrefix()}:results`;
  }
  #heartbeatsQueue(): string {
    return `${this.#effectivePrefix()}:heartbeats`;
  }
  #controlQueue(): string {
    return `${this.#effectivePrefix()}:control`;
  }
  #decisionsQueue(): string {
    return `${this.#effectivePrefix()}:decisions`;
  }
  #stepEventsQueue(): string {
    return `${this.#effectivePrefix()}:step-events`;
  }
  #startRunQueue(): string {
    return `${this.#effectivePrefix()}:start-run`;
  }
  #runRequestQueue(): string {
    return `${this.#effectivePrefix()}:run-request`;
  }

  /**
   * Build the adapter `JobData` envelope for a JSON-safe payload. A translated `priority` is added
   * only when set, so the default FIFO path is untouched for unprioritised dispatches.
   */
  #job(name: string, payload: unknown, priority?: number): JobData {
    const brokerPriority = toBrokerPriority(priority);
    return {
      id: randomUUID(),
      name,
      payload: toJson(payload),
      attempts: 0,
      createdAt: Date.now(),
      ...(brokerPriority != null ? { priority: brokerPriority } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // engine → worker
  // ---------------------------------------------------------------------------

  async dispatch(task: RemoteTask): Promise<void> {
    await this.#adapter.pushOn(
      this.#tasksQueue(task.group),
      this.#job('task', task, task.priority),
    );
  }

  // ---------------------------------------------------------------------------
  // worker side — register a step handler, run it, push the result back
  // ---------------------------------------------------------------------------

  /**
   * Register a step handler (worker side). Starts a DEDICATED task poll loop for `name` on its own
   * routing-token queue (`tenantGroup(sanitizeQueueToken(name), partition)`) on first registration —
   * one queue per handler name, never a single group queue — so it matches the token the engine
   * dispatches by (see `engine.callRemote`). Re-registering a name just swaps the handler fn.
   */
  handle(name: string, fn: StepHandler): void {
    this.#handlers.set(name, fn);
    this.#ensureTaskLoop(tenantGroup(sanitizeQueueToken(name), this.#partition));
  }

  /**
   * Register a WORKFLOW turn consumer (worker side). Shares the step task loop of the workflow name's
   * routing token — the same queue {@link dispatchWorkflowTask} targets — and tells the two job kinds
   * apart BY SHAPE: a `workflow`-shaped job runs `turn(task)` and its {@link WorkflowDecision} is pushed
   * onto `${P}:decisions`. Re-registering swaps the turn fn.
   */
  handleWorkflow(name: string, turn: WorkflowTurnHandler): void {
    this.#workflowTurns.set(name, turn);
    this.#ensureTaskLoop(tenantGroup(sanitizeQueueToken(name), this.#partition));
  }

  /** Start (once per routing token) the task loop shared by {@link handle} and {@link handleWorkflow}. */
  #ensureTaskLoop(token: string): void {
    if (this.#taskLoops.has(token)) return;
    const queue = this.#tasksQueue(token);
    this.#taskQueues.add(queue);
    const controller = this.#controller;
    this.#taskLoops.set(
      token,
      this.#startLoop(
        queue,
        async (job) => {
          const payload = fromJson<unknown>(job.payload);
          const startedAt = Date.now();
          controller.onStart();
          // Only step durations feed the latency gradient; a workflow turn still counts as in-flight
          // work and as forward progress for stall detection (as on bullmq).
          if (isWorkflowTask(payload)) {
            try {
              await this.#runWorkflowTask(payload);
            } finally {
              controller.onSettle(Date.now() - startedAt, true, 'workflow');
            }
            return;
          }
          const task = payload as TaskPayload;
          let ok = false;
          try {
            const result = await runStepHandler(task, this.#handlers.get(task.name), (beat) =>
              this.heartbeat(beat),
            );
            await this.#adapter.pushOn(this.#resultsQueue(), this.#job('result', result));
            ok = result.status === 'completed';
          } finally {
            controller.onSettle(Date.now() - startedAt, ok, 'step');
          }
        },
        {
          // Adaptive: every tick reads the controller's live limit. Fixed: the plain number, so the
          // one-slot loop keeps its historical inline shape.
          concurrency: controller.isAdaptive ? () => controller.limit : controller.limit,
          idleBackoffMax: this.#idleBackoffMax,
        },
      ),
    );
    // Advertise liveness only once the loop really consumes: a deferred (producer-only) process must
    // not look like a live worker.
    if (this.#consumersDeferred) this.#deferredStarts.push(() => this.#beginServing(token));
    else this.#beginServing(token);
  }

  /** A task loop for `token` is consuming: run the concurrency controller and beat its liveness key. */
  #beginServing(token: string): void {
    this.#controller.start();
    this.#startWorkerHeartbeat(token);
  }

  // ---------------------------------------------------------------------------
  // worker liveness + health — `${P}-worker-heartbeat:<token>:<instanceId>` in the worker-key store
  // ---------------------------------------------------------------------------

  /**
   * Refresh every served routing token's liveness key on one shared interval (default 10s, live 35s),
   * stamped with the controller's {@link WorkerStatus} snapshot (concurrency mode and live limit,
   * in-flight, RSS/CPU, throughput, p95, last adjustment) — the same `{ ts, status }` value and key
   * the BullMQ transport writes, so the dashboard's worker cards read both alike. A new token beats
   * at once. Best-effort: a failed write goes to `onError` and the key simply expires. A no-op without
   * a configured {@link QueueTransportOptions.workerKeys} store.
   */
  #startWorkerHeartbeat(token: string): void {
    if (!this.#hasWorkerKeys) return;
    const ttlMs = Math.max(
      WORKER_HEARTBEAT_TTL_SECONDS * 1000,
      this.#workerHeartbeatIntervalMs * 3,
    );
    const beatOne = (t: string): void => {
      const now = Date.now();
      const key = workerHeartbeatKey(this.#effectivePrefix(), t, this.#instanceId);
      const value = heartbeatKeyValue(now, this.#controller.snapshot());
      const write = Promise.resolve()
        .then(() => this.#workerKeys.put(key, value, now + ttlMs))
        .catch((err) => this.#onError(err));
      this.#livenessWrites.add(write);
      void write.finally(() => this.#livenessWrites.delete(write));
    };
    const isNew = !this.#heartbeatTokens.has(token);
    this.#heartbeatTokens.add(token);
    if (isNew) beatOne(token);
    if (this.#workerHeartbeatTimer) return;
    this.#workerHeartbeatTimer = setInterval(() => {
      for (const t of this.#heartbeatTokens) beatOne(t);
    }, this.#workerHeartbeatIntervalMs);
    this.#workerHeartbeatTimer.unref?.();
  }

  async #groupHealth(group: string): Promise<GroupHealth> {
    const [depth, entries] = await Promise.all([
      this.#adapter.sizeOf ? this.#adapter.sizeOf(this.#tasksQueue(group)) : Promise.resolve(0),
      this.#liveWorkerKeys(),
    ]);
    const marker = workerHeartbeatKey(this.#effectivePrefix(), group, '');
    const liveWorkers: WorkerHeartbeat[] = [];
    for (const { key, value } of entries) {
      if (!key.startsWith(marker)) continue;
      const parsed = parseHeartbeatValue(value);
      liveWorkers.push({
        group,
        instanceId: key.slice(marker.length),
        lastBeatAt: parsed.lastBeatAt,
        // Passed through as-is (worker-authored); a worker runtime's compact `{ ts, status: 'up' }`
        // beat carries no status object and reads as liveness only.
        ...(parsed.status !== undefined
          ? { status: parsed.status as unknown as WorkerStatus }
          : {}),
      });
    }
    return { group, depth: Number(depth) || 0, liveWorkers };
  }

  /** Replay one workflow turn and push its decision. An unknown workflow or a throwing turn still
   *  yields a `failed` decision so the run settles; a failed push throws, so the job is redelivered. */
  async #runWorkflowTask(task: WorkflowTask): Promise<void> {
    let decision: WorkflowDecision;
    const turn = this.#workflowTurns.get(task.workflow);
    try {
      decision = turn
        ? await withTurnHeartbeat(
            task,
            (beat) => this.heartbeat(beat),
            () => turn(task),
          )
        : {
            taskId: task.taskId,
            runId: task.runId,
            status: 'failed',
            commands: [],
            error: {
              message: `no workflow registered for '${task.workflow}'`,
              code: 'no_workflow',
            },
          };
    } catch (err) {
      this.#onError(err);
      decision = {
        taskId: task.taskId,
        runId: task.runId,
        status: 'failed',
        commands: [],
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    }
    await this.#adapter.pushOn(this.#decisionsQueue(), this.#job('decision', decision));
  }

  /** Worker side: publish a liveness heartbeat for an in-flight long step. */
  async heartbeat(beat: Heartbeat): Promise<void> {
    await this.#adapter.pushOn(this.#heartbeatsQueue(), this.#job('heartbeat', beat));
  }

  // ---------------------------------------------------------------------------
  // worker → engine — the engine consumes results + heartbeats
  // ---------------------------------------------------------------------------

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.#startLoop(
      this.#resultsQueue(),
      async (job) => {
        await handler(fromJson<ResultPayload>(job.payload));
      },
      { concurrency: this.#resultConcurrency, idleBackoffMax: 1 },
    );
  }

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    this.#startLoop(
      this.#heartbeatsQueue(),
      async (job) => {
        await handler(fromJson<HeartbeatPayload>(job.payload));
      },
      { idleBackoffMax: this.#idleBackoffMax },
    );
  }

  // ---------------------------------------------------------------------------
  // control plane (best-effort, point-to-point)
  // ---------------------------------------------------------------------------

  async publishControl(msg: ControlMessage): Promise<void> {
    const stamped: ControlMessage = msg.from ? msg : { ...msg, from: this.#instanceId };
    await this.#adapter.pushOn(this.#controlQueue(), this.#job('control', stamped));
  }

  onControl(handler: (msg: ControlMessage) => void): void {
    this.#startLoop(
      this.#controlQueue(),
      async (job) => {
        handler(fromJson<ControlPayload>(job.payload));
      },
      { idleBackoffMax: this.#idleBackoffMax },
    );
  }

  // ---------------------------------------------------------------------------
  // remote workflows — engine ⇄ workflow worker (point-to-point, like the step queues)
  // ---------------------------------------------------------------------------

  /** engine → workflow worker: a {@link WorkflowTask} on the workflow's routing-token task queue (job
   *  `workflow`), the queue a {@link handleWorkflow} consumer polls. */
  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    await this.#adapter.pushOn(
      this.#tasksQueue(task.group),
      this.#job('workflow', task, task.priority),
    );
  }

  /**
   * engine ← workflow worker: consume {@link WorkflowDecision}s from `${P}:decisions`. ONE loop per
   * transport; every registered handler sees every decision (the engine applies one by run id and drops
   * any its run no longer awaits), so several remote workflows can share the transport.
   */
  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.#decisionHandlers.add(handler);
    if (this.#decisionsLoop) return;
    this.#decisionsLoop = true;
    this.#startLoop(
      this.#decisionsQueue(),
      async (job) => {
        const decision = fromJson<WorkflowDecision>(job.payload);
        // Every handler, concurrently, as on bullmq: one that throws must not starve the rest.
        await Promise.all([...this.#decisionHandlers].map((h) => h(decision)));
      },
      { idleBackoffMax: 1 },
    );
  }

  /** workflow worker → engine: a local step's lifecycle on `${P}:step-events` (job `stepEvent`),
   *  point-to-point so ONE engine instance checkpoints each event once. */
  async dispatchStepEvent(event: WorkflowStepEvent): Promise<void> {
    await this.#adapter.pushOn(this.#stepEventsQueue(), this.#job('stepEvent', event));
  }

  /** engine ← workflow worker: consume streamed step events. Idempotent — a second call is a no-op. */
  onStepEvent(handler: (event: WorkflowStepEvent) => Promise<void>): void {
    if (this.#stepEventsLoop) return;
    this.#stepEventsLoop = true;
    this.#startLoop(
      this.#stepEventsQueue(),
      async (job) => {
        await handler(fromJson<WorkflowStepEvent>(job.payload));
      },
      { idleBackoffMax: this.#idleBackoffMax },
    );
  }

  // ---------------------------------------------------------------------------
  // store-less protocol (P4) — tenant pod ⇄ control plane
  //
  // start-run and run-request are point-to-point queues consumed by the control plane, exactly as on
  // BullMQ. Run replies and tenant events — Redis PUB/SUB on BullMQ — go to per-instance inbox queues
  // instead, since a queue job has one consumer: a reply to the requester's inbox (its id rides the
  // request as `replyTo`), a tenant event to the inbox of each live subscriber of that tenant (read from
  // the worker-key store). See `queue-remote.ts` for the design and its limits.
  // ---------------------------------------------------------------------------

  /** tenant → control plane: enqueue a {@link StartRunMessage} on `${P}:start-run` (job `startRun`),
   *  stamped with this instance as the reply target. */
  async dispatchStartRun(msg: StartRunMessage): Promise<void> {
    this.#ensureRunRepliesLoop();
    const payload: StartRunPayload = { ...msg, replyTo: this.#instanceId };
    await this.#adapter.pushOn(this.#startRunQueue(), this.#job('startRun', payload));
  }

  /** control plane ← tenant: consume {@link StartRunMessage}s. Idempotent — a second call is a no-op. */
  onStartRun(handler: (msg: StartRunMessage) => Promise<void>): void {
    this.#ensureRegistrationsLoop();
    if (this.#startRunLoop) return;
    this.#startRunLoop = true;
    this.#startLoop(
      this.#startRunQueue(),
      async (job) => {
        const { replyTo, ...msg } = fromJson<StartRunPayload>(job.payload);
        await this.#withReplyRoute(msg.runId, replyTo, () => handler(msg));
      },
      { idleBackoffMax: this.#idleBackoffMax },
    );
  }

  /** tenant → control plane: enqueue a {@link RunRequest} on `${P}:run-request` (job `runRequest`),
   *  stamped with this instance as the reply target. */
  async dispatchRunRequest(msg: RunRequest): Promise<void> {
    this.#ensureRunRepliesLoop();
    const payload: RunRequestPayload = { ...msg, replyTo: this.#instanceId };
    await this.#adapter.pushOn(this.#runRequestQueue(), this.#job('runRequest', payload));
  }

  /** control plane ← tenant: consume {@link RunRequest}s. Idempotent — a second call is a no-op. */
  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void {
    this.#ensureRegistrationsLoop();
    if (this.#runRequestLoop) return;
    this.#runRequestLoop = true;
    this.#startLoop(
      this.#runRequestQueue(),
      async (job) => {
        const { replyTo, ...msg } = fromJson<RunRequestPayload>(job.payload);
        await this.#withReplyRoute(msg.requestId, replyTo, () => handler(msg));
      },
      { idleBackoffMax: this.#idleBackoffMax },
    );
  }

  /** Remember who asked for `correlationId` while `work` (the responder, which replies inside it) runs. */
  async #withReplyRoute(
    correlationId: string | undefined,
    replyTo: string | undefined,
    work: () => Promise<void>,
  ): Promise<void> {
    if (correlationId === undefined || replyTo === undefined) return work();
    this.#replyRoutes.set(correlationId, replyTo);
    try {
      await work();
    } finally {
      if (this.#replyRoutes.get(correlationId) === replyTo) this.#replyRoutes.delete(correlationId);
    }
  }

  /**
   * control plane → tenant: push a correlated {@link RunReply} onto the inbox of the instance that sent
   * the request (`${P}:run-replies:<instance>`). Only the instance that consumed the request knows the
   * requester, so this must run while that request is being handled — which is what the responder does.
   * A reply with no known requester (a request that carried no `replyTo`) is dropped and reported.
   */
  async publishRunReply(reply: RunReply): Promise<void> {
    const owner = this.#replyRoutes.get(reply.requestId);
    if (owner === undefined) {
      this.#onError(
        new Error(
          `[QueueTransport] dropped the run reply for "${reply.requestId}": no requester is known for it on this instance`,
        ),
      );
      return;
    }
    const queue = runRepliesQueue(this.#effectivePrefix(), owner);
    await this.#adapter.pushOn(queue, this.#job('runReply', reply));
    this.#inboxes.notePush(queue, owner);
  }

  /**
   * tenant ← control plane: consume this instance's reply inbox. Idempotent — a second call is a no-op
   * (one gateway per transport matches every reply by id). The inbox is private to this instance, so it
   * is consumed even when consumers are deferred: no other process could take its jobs.
   */
  onRunReply(handler: (reply: RunReply) => void): void {
    if (this.#runReplyHandler) return;
    this.#runReplyHandler = handler;
    this.#ensureRunRepliesLoop();
  }

  /** Start consuming the reply inbox (once). Also started on the first request, so a reply is never
   *  left for a dead queue just because the gateway subscribed late. */
  #ensureRunRepliesLoop(): void {
    if (this.#runRepliesLoop) return;
    this.#runRepliesLoop = true;
    this.#inboxes.activateInbox();
    // On the critical path of every proxied call: never back off (like the results loop).
    this.#reallyStartLoop(
      runRepliesQueue(this.#effectivePrefix(), this.#instanceId),
      async (job) => {
        const reply = fromJson<RunReply>(job.payload);
        try {
          this.#runReplyHandler?.(reply);
        } catch (err) {
          this.#onError(err); // a throwing listener must not redeliver the reply
        }
      },
      { idleBackoffMax: 1 },
    );
  }

  /**
   * control plane → tenant: push a {@link TenantEvent} onto the inbox of every instance with a live
   * subscription to `evt.tenant` (none: nothing is pushed). Publishes are serialized, so each
   * subscriber receives one publisher's events in publish order.
   */
  publishTenantEvent(evt: TenantEvent): Promise<void> {
    this.#ensureRegistrationsLoop();
    const run = this.#tenantPublishChain.then(async () => {
      const owners = await this.#inboxes.subscribersOf(evt.tenant);
      for (const owner of owners) {
        const queue = tenantEventsQueue(this.#effectivePrefix(), owner);
        await this.#adapter.pushOn(queue, this.#job('tenantEvent', evt));
        this.#inboxes.notePush(queue, owner);
      }
    });
    this.#tenantPublishChain = run.catch(() => undefined);
    return run;
  }

  /**
   * control plane: record the inbox registrations instances announce (their subscriptions and inbox
   * liveness) in this instance's worker-key store, where {@link publishTenantEvent} and the janitor read
   * them. Started by whichever control-plane surface comes up first (the responder's consumers, or the
   * first publish). Point-to-point: control-plane replicas share the store, so one recording suffices.
   */
  #ensureRegistrationsLoop(): void {
    if (this.#registrationsLoop) return;
    this.#registrationsLoop = true;
    this.#startLoop(
      inboxRegistrationsQueue(this.#effectivePrefix()),
      (job) => this.#inboxes.record(fromJson<unknown>(job.payload)),
      { idleBackoffMax: this.#idleBackoffMax },
    );
  }

  /**
   * tenant ← control plane: subscribe to `tenant`'s events. Announces the subscription to the control
   * plane (re-announced every third of {@link QueueTransportOptions.inboxTtlMs} while it lasts) and
   * consumes this instance's event inbox. Needs no store on this side. Returns an unsubscribe fn that
   * detaches only this handler; the last one withdraws the subscription.
   */
  onTenantEvent(tenant: string, handler: (evt: TenantEvent) => void): () => void {
    let handlers = this.#tenantEventHandlers.get(tenant);
    if (!handlers) {
      handlers = new Set();
      this.#tenantEventHandlers.set(tenant, handlers);
    }
    handlers.add(handler);
    this.#inboxes.subscribe(tenant);
    this.#ensureTenantEventsLoop();
    return () => {
      const set = this.#tenantEventHandlers.get(tenant);
      if (!set?.delete(handler) || set.size > 0) return;
      this.#tenantEventHandlers.delete(tenant);
      this.#inboxes.unsubscribe(tenant);
    };
  }

  /** Consume the tenant-event inbox (once; private to this instance, so never deferred). Keeps running
   *  after the last unsubscribe so events pushed before the withdrawal are drained, not left behind. */
  #ensureTenantEventsLoop(): void {
    if (this.#tenantEventsLoop) return;
    this.#tenantEventsLoop = true;
    this.#reallyStartLoop(
      tenantEventsQueue(this.#effectivePrefix(), this.#instanceId),
      async (job) => {
        const evt = fromJson<TenantEvent>(job.payload);
        for (const h of this.#tenantEventHandlers.get(evt.tenant) ?? []) {
          try {
            h(evt);
          } catch (err) {
            this.#onError(err); // a throwing listener must not redeliver (and reorder) the event
          }
        }
      },
      { idleBackoffMax: this.#idleBackoffMax },
    );
  }

  /** Withdraw this instance's advertisements, then drop what is left in its own inboxes: replies and
   *  events addressed to a process that is going away have no one else to go to. */
  async #closeInboxes(): Promise<void> {
    await this.#inboxes.close();
    const prefix = this.#effectivePrefix();
    const own = [
      ...(this.#runRepliesLoop ? [runRepliesQueue(prefix, this.#instanceId)] : []),
      ...(this.#tenantEventsLoop ? [tenantEventsQueue(prefix, this.#instanceId)] : []),
    ];
    for (const queue of own) {
      await this.#drainQueue(queue, 1_000).catch((err) => this.#onError(err));
    }
  }

  /** Pop and finalize up to `max` jobs of `queue` without running them (the janitor, and close()).
   *  Resolves `true` once the queue came back empty. */
  async #drainQueue(queue: string, max: number): Promise<boolean> {
    for (let i = 0; i < max; i += 1) {
      const job = await this.#adapter.popFrom(queue);
      if (!job) return true;
      await this.#adapter.completeJob(jobHandle(job), queue);
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // poll loop
  // ---------------------------------------------------------------------------

  /**
   * Poll `queue`, handing each popped job to `onJob` then marking it complete. One job is popped per
   * tick; core's {@link Pollers} drains a burst (re-ticking while a job was found) before sleeping,
   * and owns the stop-all bookkeeping. Returns a handle that stops just this loop.
   *
   * A throwing `onJob` did NOT do the job's work, so the job is REDELIVERED (`retryJob`, delayed one
   * poll interval) rather than destroyed, and the error is reported to `onError`. For the results
   * queue, "the job's work" is settling the checkpoint: the engine's result handler persists the
   * checkpoint BEFORE kicking the run's resume (which runs fire-and-forget, never holding this
   * loop), so a throw here means the completion was never recorded — the ONLY copy of the result
   * must stay on the queue. (A pod mid-rolling-deploy without the workflow registered still settles
   * fine — settling needs no registry — and acks; its background resume fails into the run's
   * reconcile recovery instead of wedging or losing the result.) A job nobody can settle loops at
   * the poll rate and says so on every attempt, which is the failure we want — loud, not invisible.
   */
  #startLoop(
    queue: string,
    onJob: (job: JobData) => Promise<void>,
    opts: LoopOptions = {},
  ): PollLoop {
    // Deferred consumption (see deferConsumers): park the start; startConsumers() flushes it. The
    // handle returned now still stops the loop whether it is flushed later or never.
    if (this.#consumersDeferred) {
      let cancelled = false;
      let live: PollLoop | undefined;
      this.#deferredStarts.push(() => {
        if (!cancelled) live = this.#reallyStartLoop(queue, onJob, opts);
      });
      return {
        stop: () => {
          cancelled = true;
          live?.stop();
        },
      };
    }
    return this.#reallyStartLoop(queue, onJob, opts);
  }

  #reallyStartLoop(
    queue: string,
    onJob: (job: JobData) => Promise<void>,
    { concurrency = 1, idleBackoffMax }: LoopOptions,
  ): PollLoop {
    // Record every queue we consume from so the reclaim sweep can walk exactly this set.
    this.#poppedQueues.add(queue);
    // This loop's jobs still in a handler. With one fixed slot the tick awaits its job (the historical
    // shape); otherwise it hands each job off and keeps popping until every slot is taken, so N
    // slots cost ONE poll loop, not N. A live (adaptive) limit is re-read on every tick.
    const limit = typeof concurrency === 'function' ? concurrency : () => concurrency;
    const inFlight = new Set<Promise<void>>();
    return this.#pollers.start(
      async () => {
        if (inFlight.size >= limit()) {
          // Every slot busy: wait for one to free (or the limit to move), then report work so the
          // loop re-ticks at once.
          await this.#slotFreed(inFlight);
          return true;
        }
        let job: AcquiredJob | null;
        try {
          job = await this.#adapter.popFrom(queue);
        } catch {
          // A transient adapter error: treat as "no work", retry on the next tick.
          return false;
        }
        if (!job) return false;
        const run = this.#runJob(queue, job, onJob);
        if (concurrency === 1) {
          await run;
          return true;
        }
        inFlight.add(run);
        void run.finally(() => inFlight.delete(run));
        return true;
      },
      idleBackoffMax === undefined ? undefined : { idleBackoffMax },
    );
  }

  /** Resolve when one of `inFlight` settles or the adaptive controller moves the limit. */
  async #slotFreed(inFlight: Set<Promise<void>>): Promise<void> {
    let wake: () => void = () => {};
    const moved = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.#limitWaiters.add(wake);
    try {
      await Promise.race([...inFlight, moved]);
    } finally {
      this.#limitWaiters.delete(wake);
    }
  }

  /**
   * Run one popped job and finalize it: complete on success, hand back for redelivery on a throw.
   * Tracked in {@link #openJobs} (renewed, and handed back by `close()` if unfinished) and in
   * {@link #runningJobs} (waited for by `close()`, bounded).
   */
  #runJob(queue: string, job: AcquiredJob, onJob: (job: JobData) => Promise<void>): Promise<void> {
    // Track the popped-but-unfinished job so close() can hand it back to the broker instead of
    // destroying the adapter under it (which stranded it `active` until the stalled sweep —
    // every deploy of a busy fleet parked its mid-flight jobs for up to the stalled threshold).
    const handle = jobHandle(job);
    this.#openJobs.set(job.id, { queue, handle });
    const run = (async () => {
      try {
        await onJob(job);
        // A lease-based adapter answers `false` when the lease was lost (the reclaim sweep re-delivered
        // the job meanwhile): nothing to do — the re-delivery runs it again, which is idempotent.
        await this.#adapter.completeJob(handle, queue);
      } catch (err) {
        this.#onError(err);
        // Delay the redelivery by one poll interval: it keeps a job nobody can handle from spinning
        // the burst-drain loop hot (a ready job makes every tick report work and never sleep).
        await this.#adapter
          .retryJob(handle, queue, new Date(Date.now() + this.#pollIntervalMs))
          .catch((retryErr) => this.#onError(retryErr));
      } finally {
        this.#openJobs.delete(job.id);
      }
    })();
    this.#runningJobs.add(run);
    void run.finally(() => this.#runningJobs.delete(run));
    return run;
  }

  // ---------------------------------------------------------------------------
  // stalled-job reclaim
  // ---------------------------------------------------------------------------

  /**
   * Periodically re-deliver jobs whose claiming worker died mid-flight.
   *
   * WHY this lives here at all: this transport drives the adapter directly (`pushOn` / `popFrom` /
   * `completeJob`) instead of the broker's `Worker` class — see the class header for the reason. But
   * `recoverStalledJobs` (the Lua/SQL that moves a claim whose `acquiredAt` is older than a cutoff back
   * from `active` to `pending`) is ONLY ever called from that same `Worker` class we bypass. So in this
   * transport nothing reclaimed a claimed job: a worker (or the engine, for result/heartbeat/control
   * jobs) that crashed between `popFrom` and `completeJob` left the job wedged in the adapter's `active`
   * set forever — there is no `waiting` state to fall back to, so the task was simply lost (observed in
   * production: jobs stuck in `…:tasks:…::active`, each stamped with a distinct dead `workerId`). This
   * sweep restores the recovery the `Worker` class would have done.
   *
   * WHY re-delivery is safe (and why default-on): durable steps are idempotent by contract, and the
   * engine ignores results for a checkpoint that already completed — so re-running a reclaimed step, or
   * re-delivering the two production shapes (result published but `completeJob` never reached; or claimed
   * and died before any result), cannot corrupt a run. The only cost is wasted work when a merely-slow
   * worker's job is re-delivered — which claim renewal ({@link #startClaimRenewal}) rules out on an
   * adapter that supports it, and which is why {@link DEFAULT_STALLED_THRESHOLD_MS} is deliberately
   * generous on one that doesn't. A permanently lost job is a worse failure than a rare double-run of an idempotent step, so
   * this defaults ON; set `stalledCheckIntervalMs: 0` to opt out.
   *
   * Feature-detected: an adapter that doesn't implement `recoverStalledJobs` (not every driver does)
   * simply gets no sweep — skipped silently, since a missing capability is not a transport error.
   */
  #startReclaimSweep(intervalMs: number): Pollers | undefined {
    if (typeof this.#adapter.recoverStalledJobs !== 'function' || intervalMs <= 0) return undefined;
    const pollers = new Pollers(intervalMs, this.#onError);
    // Returns `false` every round so {@link Pollers} sleeps the FULL interval between sweeps — the
    // reclaim check is coarse and must not ride the fast burst-drain of the job-poll loops.
    pollers.start(async () => {
      for (const queue of this.#poppedQueues) {
        try {
          const outcome = await this.#adapter.recoverStalledJobs?.(
            queue,
            this.#stalledThresholdMs,
            this.#maxStalledCount,
            MAX_EXCEEDED_PER_SWEEP,
          );
          // `@adonisjs/queue` 0.7 (`@boringnode/queue` >= 0.8) no longer fails a job that stalled too
          // many times: it keeps it `active`, re-leases it to us and returns it in `exceeded`, so the
          // caller fails it. Left alone it would stay `active` forever. 0.6 returns a count and has
          // already failed (deleted) them — nothing to do, and nothing left to bridge.
          if (outcome && typeof outcome === 'object') {
            for (const job of outcome.exceeded) await this.#failPoisonJob(queue, job);
          }
        } catch (err) {
          this.#onError(err);
        }
      }
      return false;
    });
    return pollers;
  }

  /**
   * Fail a job that stalled more than `maxStalledCount` times and, for a STEP task, publish a failed
   * {@link StepResult} for it — the queue twin of the BullMQ transport's `worker.on('failed')` bridge.
   * No handler produced a result for that step (its workers kept dying), so without one the run would
   * wait on its `pending` checkpoint forever. The result is RETRYABLE: the engine re-dispatches while
   * the step has attempts left, then fails it into the workflow's error path. Only after `failJob`
   * succeeded (a lost lease means another sweep owns the job), and only for task queues: a stalled
   * result/heartbeat/control job carries no step to fail, and a workflow-turn payload has no step
   * identity, so both are just failed.
   */
  async #failPoisonJob(queue: string, job: AcquiredJob): Promise<void> {
    const reason = `stalled more than ${this.#maxStalledCount} times`;
    let failed: unknown;
    try {
      failed = await this.#adapter.failJob(jobHandle(job), queue, new Error(reason));
    } catch (err) {
      this.#onError(err);
      return;
    }
    if (failed === false || !this.#taskQueues.has(queue)) return;
    let identity: ReturnType<typeof failedTaskIdentity>;
    try {
      identity = failedTaskIdentity(fromJson<unknown>(job.payload));
    } catch {
      return; // an unparseable payload: nothing safe to publish
    }
    if (!identity) return;
    try {
      await this.#adapter.pushOn(
        this.#resultsQueue(),
        this.#job('result', infrastructureFailure(identity, reason)),
      );
    } catch (err) {
      this.#onError(err);
    }
  }

  // ---------------------------------------------------------------------------
  // claim renewal
  // ---------------------------------------------------------------------------

  /**
   * Renew every claim this instance is still working on, each half {@link #stalledThresholdMs} —
   * the heartbeat `@boringnode/queue`'s own `Worker` runs, which this transport bypasses (see the
   * class header) exactly as it bypasses that class's stalled recovery.
   *
   * WHY: without it, a claim's age is the step's elapsed runtime, so the threshold had to exceed the
   * longest step — a 30min default that also left a dead worker's job unrecovered for 30min, while a
   * step that legitimately ran longer was re-delivered and ran twice. Renewing makes the age measure
   * the worker's silence instead, so a short threshold recovers crashes fast without ever re-running a
   * healthy long step.
   *
   * Each claim is renewed with the handle it is finalized with (lease on 0.9, job id on 0.6). The timer is `unref`'d, and a round still in flight skips the next tick instead of stacking.
   */
  #startClaimRenewal(): void {
    const intervalMs = Math.max(Math.floor(this.#stalledThresholdMs / 2), 1);
    this.#renewTimer = setInterval(() => {
      if (this.#renewal) return;
      const round = this.#renewOpenClaims().finally(() => {
        if (this.#renewal === round) this.#renewal = undefined;
      });
      this.#renewal = round;
    }, intervalMs);
    this.#renewTimer.unref?.();
  }

  async #renewOpenClaims(): Promise<void> {
    if (this.#openJobs.size === 0) return;
    const byQueue = new Map<string, JobHandle[]>();
    for (const { queue, handle } of this.#openJobs.values()) {
      const leases = byQueue.get(queue) ?? [];
      leases.push(handle);
      byQueue.set(queue, leases);
    }
    for (const [queue, leases] of byQueue) {
      try {
        const renewed = await this.#adapter.renewJobs?.(queue, leases);
        // A job that finished normally during the round-trip was finalized, not lost: count only the
        // claims still open under the same handle, or a healthy completion would raise a false alarm.
        const stillHeld = leases.filter(
          (lease) =>
            this.#openJobs.get(typeof lease === 'string' ? lease : lease.id)?.handle === lease,
        ).length;
        // Fewer renewed than still held: the sweep already re-delivered those claims (this worker went
        // silent past the threshold), so another worker may be running the same step right now. The
        // handler can't be aborted — durable steps are idempotent — but the double run must be loud.
        if (typeof renewed === 'number' && renewed < stillHeld) {
          this.#onError(
            new Error(
              `[QueueTransport] lost ${stillHeld - renewed} of ${stillHeld} claim(s) on "${queue}" before renewing them — the jobs were re-delivered and may run twice; raise stalledThresholdMs if this worker blocks its event loop`,
            ),
          );
        }
      } catch (err) {
        this.#onError(err);
      }
    }
  }

  /**
   * Stop every poll loop, WAIT (bounded) for the job already in a handler's hands, and hand any
   * still-unfinished job back to the broker before destroying the adapter. Without the wait, a
   * SIGTERM mid-step neither completed nor retried the popped job — it sat `active` until the
   * stalled-reclaim threshold (30 min default), or forever on an adapter without
   * `recoverStalledJobs`.
   */
  async close(): Promise<void> {
    this.#pollers.stopAll();
    this.#reclaimPollers?.stopAll();
    this.#taskLoops.clear();
    this.#controller.stop();
    if (this.#workerHeartbeatTimer) clearInterval(this.#workerHeartbeatTimer);
    // A clean stop withdraws this instance's liveness keys at once, so the dashboard and
    // `listWorkerGroups` drop it now instead of after the 35s TTL. In-flight beats land first, or one
    // could re-create a key after its removal.
    if (this.#heartbeatTokens.size > 0) {
      await Promise.allSettled([...this.#livenessWrites]);
      const keys = [...this.#heartbeatTokens].map((t) =>
        workerHeartbeatKey(this.#effectivePrefix(), t, this.#instanceId),
      );
      this.#heartbeatTokens.clear();
      await Promise.resolve()
        .then(() => this.#workerKeys.remove(keys))
        .catch((err) => this.#onError(err));
    }
    this.#workerHeartbeatTimer = undefined;
    const drainDeadline = Date.now() + this.#closeTimeoutMs;
    await this.#pollers.drain(this.#closeTimeoutMs);
    // Jobs handed off by a multi-slot loop are not part of a poll tick: wait for them too, within the
    // same budget.
    if (this.#runningJobs.size > 0) {
      const left = Math.max(drainDeadline - Date.now(), 0);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.#runningJobs]),
        new Promise((r) => {
          timer = setTimeout(r, left);
        }),
      ]);
      clearTimeout(timer);
    }
    // Renewal keeps running through the drain (a job finishing inside it must keep its claim), then
    // stops before the leftovers are handed back.
    if (this.#renewTimer) clearInterval(this.#renewTimer);
    this.#renewTimer = undefined;
    await this.#renewal;
    // Anything still open after the bounded drain (a long step): re-deliver it now so another
    // worker picks it up immediately instead of waiting out the stalled threshold.
    for (const [jobId, { queue, handle }] of [...this.#openJobs]) {
      this.#openJobs.delete(jobId);
      await this.#adapter.retryJob(handle, queue, new Date()).catch((err) => this.#onError(err));
    }
    await this.#closeInboxes();
    await this.#adapter.destroy();
  }
}
