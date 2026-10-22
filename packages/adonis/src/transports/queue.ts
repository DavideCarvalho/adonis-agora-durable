import { randomUUID } from 'node:crypto';
import type { AcquiredJob, AdapterFactory, JobData } from '@adonisjs/queue/types';
import type { WorkerDescriptor } from '../handshake/descriptor.js';
import {
  type ControlMessage,
  type ControlPlane,
  type Heartbeat,
  type RemoteTask,
  type StepResult,
  type Transport,
} from '../interfaces.js';
import { atLeastOne, Pollers, type PollLoop } from '../pollers.js';
import { runStepHandler, type StepHandler } from '../protocol.js';
import { sanitizeQueueToken, tenantGroup } from '../tenant-group.js';
import type { DescriptorRedis } from '../worker-runtime/registry.js';
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

/** Per-loop knobs: how many jobs it keeps in flight, and its idle backoff (instance default if unset). */
interface LoopOptions {
  concurrency?: number;
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
   */
  concurrency?: number;
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
  /** How long a read of {@link workerKeys} is reused (ms). Default 5000; `0` reads every time. */
  workerKeysCacheMs?: number;
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
  readonly #concurrency: number;
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
  readonly #liveWorkerKeys: () => Promise<{ key: string; value: string }[]>;

  constructor(options: QueueTransportOptions) {
    // Typed through CompatAdapter so the same code drives the 0.6 (job-id) and 0.7 (lease) contracts.
    this.#adapter = options.adapter() as unknown as CompatAdapter;
    this.#partition = options.partition;
    this.#prefix = options.prefix ?? 'durable';
    this.#namespace = options.namespace;
    this.#explicitNamespace = options.namespace !== undefined;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#concurrency = atLeastOne(options.concurrency, 1);
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
    this.#workerKeys = options.workerKeys ?? NO_WORKER_KEYS;
    this.#liveWorkerKeys = cachedLiveKeys(
      this.#workerKeys,
      options.workerKeysCacheMs ?? 5_000,
      Date.now,
    );
  }

  /** The writer a worker runtime's registry advertises its descriptor and heartbeat through. */
  createDescriptorRedis(): DescriptorRedis {
    return workerKeyWriter(this.#workerKeys, Date.now);
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
    const token = tenantGroup(sanitizeQueueToken(name), this.#partition);
    if (this.#taskLoops.has(token)) return;
    this.#taskLoops.set(
      token,
      this.#startLoop(
        this.#tasksQueue(token),
        async (job) => {
          const task = fromJson<TaskPayload>(job.payload);
          const result = await runStepHandler(task, this.#handlers.get(task.name), (beat) =>
            this.heartbeat(beat),
          );
          await this.#adapter.pushOn(this.#resultsQueue(), this.#job('result', result));
        },
        { concurrency: this.#concurrency, idleBackoffMax: this.#idleBackoffMax },
      ),
    );
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
    // This loop's jobs still in a handler. With one slot the tick awaits its job (the historical
    // shape); with more it hands each job off and keeps popping until every slot is taken, so N
    // slots cost ONE poll loop, not N.
    const inFlight = new Set<Promise<void>>();
    return this.#pollers.start(
      async () => {
        if (inFlight.size >= concurrency) {
          // Every slot busy: wait for one to free, then report work so the loop re-ticks at once.
          await Promise.race(inFlight);
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
          // already failed them — nothing to do.
          if (outcome && typeof outcome === 'object') {
            for (const job of outcome.exceeded) {
              await this.#adapter
                .failJob(
                  jobHandle(job),
                  queue,
                  new Error(`stalled more than ${this.#maxStalledCount} times`),
                )
                .catch((err) => this.#onError(err));
            }
          }
        } catch (err) {
          this.#onError(err);
        }
      }
      return false;
    });
    return pollers;
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
    const drainDeadline = Date.now() + 5_000;
    await this.#pollers.drain(5_000);
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
    await this.#adapter.destroy();
  }
}
