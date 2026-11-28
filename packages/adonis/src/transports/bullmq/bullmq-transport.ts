import { randomUUID } from 'node:crypto';
import { dispatchKeyOf } from '../../dispatch-key.js';
import type { WorkerDescriptor } from '../../handshake/descriptor.js';
import type {
  GroupHealth,
  Heartbeat,
  RemoteTask,
  RunDispatch,
  RunReply,
  RunRequest,
  StartRunMessage,
  StepResult,
  TenantEvent,
  Transport,
  WorkerHeartbeat,
  WorkerStatus,
  WorkflowDecision,
  WorkflowStepEvent,
  WorkflowTask,
} from '../../interfaces.js';
import { sealerOf, type TransportMessagesOptions } from '../../messages/resolve.js';
import {
  isMessageRejected,
  isSealedMessage,
  type MessageKind,
  type MessageSealer,
  taskKindOf,
} from '../../messages/sealer.js';
import { runStepHandler, type StepHandler, withTurnHeartbeat } from '../../protocol.js';
import { swallowSubscribe } from '../../safe-subscribe.js';
import type { DescriptorRedis } from '../../worker-runtime/registry.js';
import { isWorkflowTask, type WorkflowTurnHandler } from '../../workflow-turn.js';
import {
  failedTaskIdentity,
  fanOutDecision,
  infrastructureFailure,
  type TaskIdentity,
} from '../task-failure.js';
import { AdaptiveController, type ConcurrencyOption } from './adaptive-concurrency.js';
import {
  type BullMQDeps,
  type JobLike,
  type QueueLike,
  type RedisLike,
  type WorkerLike,
  workerConcurrency,
} from './deps.js';
import { HandlerLimiter } from './handler-limiter.js';
import {
  decisionsName,
  effectivePrefix,
  groupedTasksName,
  heartbeatChannel,
  legacyWorkerKeysPrefix,
  queueWorkKeys,
  replyAliveKey,
  replyInstancesKey,
  replyQueueName,
  resultBatchesName,
  resultsName,
  routingToken,
  runReplyChannel,
  runRequestName,
  runStartJobId,
  runsName,
  startRunName,
  stepEventsName,
  tasksName,
  tenantEventsChannel,
  type WorkerRegistryKind,
  workerHeartbeatKey,
  workerHeartbeatKeyPrefix,
  workerInstancesKey,
  workerRegistryHashKey,
  workerRegistryIndexKey,
} from './naming.js';
import {
  buildInstanceId,
  heartbeatKeyValue,
  jobOptions,
  parseHeartbeatValue,
  resultJobOptions,
  taskJobOptions,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from './serialization.js';

export interface BullMQTransportOptions {
  /**
   * Ceiling (ms) `close()` gives the graceful shutdown before it stops waiting and drops the Redis
   * connections anyway. Workers close first (concurrently), so an in-flight job can still publish its
   * result; only then do the queues close. Both phases share this one deadline. Default `5_000`; `0`
   * skips the wait. BullMQ memoizes `close()`, so escalating to `close(true)` cannot rescue a wedged
   * graceful close. After the deadline the pub/sub, heartbeat and liveness connections are
   * disconnected, but abandoned BullMQ workers may keep running their jobs on their own connections
   * until the process exits; an unfinished job is recovered through BullMQ's stalled-job handling.
   */
  closeTimeoutMs?: number | undefined;
  /** The broker factory (real bullmq/ioredis via `createBullMQDeps`, or a fake in tests). */
  deps: BullMQDeps;
  /**
   * Logical isolation partition suffixing every per-handler tasks queue this instance subscribes to
   * (via `tenantGroup`) — so several isolated worker pools can share one Redis without a `handle()`d
   * name colliding across pools. Unset routes each handler to the bare (sanitized) handler name.
   */
  partition?: string | undefined;
  /** Key prefix namespacing the durable queues. Default `durable`. */
  prefix?: string | undefined;
  /**
   * Logical deployment namespace, segmenting every queue/channel/key so one Redis can host multiple
   * isolated deployments. Unset or `"default"` keeps names BYTE-IDENTICAL to the un-namespaced scheme.
   * An explicit value here wins over a later {@link BullMQTransport.useNamespace}.
   */
  namespace?: string | undefined;
  /** Stable id for this worker process in the liveness keys. Default `ts-<host>-<pid>`. */
  instanceId?: string | undefined;
  /** Where a background failure (a failed heartbeat refresh, a result-publish error) is reported. */
  onError?: ((err: unknown) => void) | undefined;
  /**
   * Raises how many step results this instance takes from the results queue at once above its
   * floor of 512. The engine writes one run's results that are in hand together (one write, one
   * barrier read per batch), so a wide fan's results settle at the rate its steps finish; there is
   * rarely a reason to set this. A non-finite or sub-1 value is ignored.
   */
  resultConcurrency?: number | undefined;
  /**
   * How many tasks each per-routing-token task worker runs at once. A number pins it (a non-finite or
   * sub-1 value falls back to 1). `'adaptive'` or `{ mode: 'adaptive', min, max, start, tickMs,
   * ramCeilingPct, cpuCeilingPct }` lets an {@link AdaptiveController} move the limit at runtime from
   * step latency, error rate and stalls, braking on RAM (and CPU, when a ceiling is set). The live
   * limit, in-flight count and last adjustment ride the worker heartbeat in both modes. Unset leaves
   * each task worker at the deps' default concurrency.
   */
  concurrency?: ConcurrencyOption | undefined;
  /**
   * How often (ms) the shared subscriber watchdog PINGs every pub/sub subscriber connection this
   * transport owns (the long-step heartbeat, run-reply and tenant-event subscribers) to detect, and
   * recover from, a silent connection loss. A subscriber connection never writes on its own: when a
   * VPN, NAT or idle timeout drops the TCP connection, no write fails and no timeout fires, so the
   * connection sits "subscribed" while the server's `PUBSUB NUMSUB` already reads 0. Heartbeats stop
   * resetting step leases, and a tenant's run-gateway calls time out until the process restarts. A
   * PING that rejects or times out marks the connection dead: it is `disconnect(true)`ed, ioredis
   * reconnects and `autoResubscribe` restores its channels. `0` or `false` disables the watchdog.
   * Default `30_000`.
   */
  pingIntervalMs?: number | false | undefined;
  /**
   * Wall-clock ceiling (ms) for one step handler on THIS worker. A wedged handler (an await that will
   * never settle: a dead connection swallowed by a wrapper stream, an external call with no timeout)
   * otherwise holds its BullMQ job forever, because the job lock renews on a timer whether or not the
   * handler makes progress, so the job is never reclaimed as stalled. When set, a step still running
   * after `stepTimeoutMs` publishes a RETRYABLE failed StepResult (the engine's durable retry
   * re-dispatches it) and the orphaned handler promise is abandoned. Opt-in: pick a value well above
   * your slowest legitimate step. Unset (the default) = no ceiling.
   */
  stepTimeoutMs?: number | undefined;
  /**
   * Route a dispatched `ctx.step`'s result back to the engine instance that dispatched it (the task's
   * `replyTo`), on a queue of its own, while that instance is alive: it holds the workflow body parked
   * on the step, so with several engines the result continues the body instead of replaying it on
   * whichever engine takes it off the shared results. An instance announces it is alive with a Redis
   * key it refreshes; once the key lapses (a crash, a scale-down, a shutdown), workers send its
   * results to the shared queue again and every transport moves what is left on its queue there, so
   * no result is lost. Default `true`. `false` neither consumes nor sends routed replies. The keys
   * and queue are the NestJS transport's and the Python worker's, so a mixed fleet routes too.
   */
  replyRouting?: boolean | undefined;
  /** How long an engine's alive key outlives its last refresh (refreshed every third of it). Default 15 s. */
  replyAliveTtlMs?: number | undefined;
  /** How often a transport looks for dead engines' reply queues to move to the shared results. Default 5 s. */
  replySweepMs?: number | undefined;
  /** How long a dead engine's emptied reply queue is still watched before it is forgotten. Default 90 s. */
  replyDrainIdleMs?: number | undefined;
  /** Where and how the worker registry (liveness + descriptors) is kept. See {@link WorkerRegistryOptions}. */
  workerRegistry?: WorkerRegistryOptions | undefined;
  /**
   * How step and workflow tasks are laid out on BullMQ queues.
   *
   * - `'per-handler'` (default): one queue, one BullMQ `Worker` and one blocking connection per
   *   handler (`${P}-tasks-<token>`). Byte-compatible with the NestJS and Python SDKs.
   * - `'grouped'`: every handler of a partition shares ONE queue (`${P}-taskgroup`, or
   *   `${P}-taskgroup@<partition>`), consumed by one `Worker`; a job is routed to its handler by the
   *   routing token it carries. Idle polling, stalled checks and blocking connections no longer grow
   *   with the number of handlers. Each handler keeps its own concurrency limit through an in-process
   *   limiter. Every process consuming a partition's grouped queue must register the handlers
   *   dispatched to it; a job for a handler the process lacks is handed back to the queue (delayed
   *   10 s) for another process. Not understood by the NestJS / Python SDKs.
   *
   * Dispatcher and consumers of a fleet must agree; see {@link taskQueueDrain} for switching.
   */
  taskQueues?: 'per-handler' | 'grouped' | undefined;
  /**
   * While switching layouts, also consume the OTHER layout's queues of the handlers this process
   * serves, as long as they hold jobs: in `'grouped'` mode the per-handler `${P}-tasks-<token>`
   * queues (jobs dispatched by processes not yet upgraded, and delayed or stalled ones); in
   * `'per-handler'` mode the grouped queue (a rollback). A drain worker starts only for a queue that
   * has waiting, active, delayed, prioritized or paused jobs, and stops once it is empty. Checking
   * every queue is ONE `EXISTS` per interval. Default `true` with `'grouped'`, `false` with
   * `'per-handler'`. `{ intervalMs }` sets the check interval (default `60_000`).
   */
  taskQueueDrain?: boolean | { intervalMs?: number | undefined } | undefined;
  /**
   * How this transport seals its messages (see "Encrypting messages"): a ready sealer (what
   * `transports.bullmq()` builds from the app), or the options. Default: sent plain (`seal: true`
   * seals), sealed ones opened with a key derived from `process.env.APP_KEY` when it is set.
   */
  messages?: MessageSealer | TransportMessagesOptions | undefined;
}

/**
 * The worker registry: ONE hash per prefix, `${P}-workers:instances`, with one field per writing
 * instance that lists every routing token it serves (heartbeats and handshake descriptors). A worker
 * writes its field once per 10s beat whatever its token count, and a process reads the whole hash
 * with one `HGETALL`, reused for up to 30s by every reader. Readers on 1.0.0-rc.31 and older read the
 * per-instance keys (`${P}-worker-heartbeat:<token>:<instance>`, `${P}-worker-descriptor:<token>:<instance>`)
 * and the rc.31 per-token hashes (`${P}-workers:heartbeats:<token>`, indexed by `${P}-workers:tokens`);
 * see {@link legacyWrites}.
 */
export interface WorkerRegistryOptions {
  /**
   * Also read the per-instance keys that writers without the instances hash (1.0.0-rc.31 and older,
   * the NestJS or Python SDK) write, with one SCAN walk shared by every reader in the process and run
   * at most once per {@link legacyScanIntervalMs}. Turn it off once every writer is on this version.
   * Default `true`.
   */
  legacyScan?: boolean | undefined;
  /** The least time (ms) between two compatibility walks. Default `60_000`. */
  legacyScanIntervalMs?: number | undefined;
  /**
   * Also write what readers on 1.0.0-rc.31 and older (and the NestJS / Python fleet) read: each
   * token's per-instance key and its field in the rc.31 per-token hash, once per
   * {@link legacyWriteIntervalMs} (they live three intervals). Turn it off once every reader that
   * shares the Redis runs this version; that leaves one write per instance per beat. Default `true`.
   */
  legacyWrites?: boolean | undefined;
  /** How often (ms) the keys of {@link legacyWrites} are refreshed. Default `30_000`. */
  legacyWriteIntervalMs?: number | undefined;
  /**
   * Mints the client the registry hashes are written to and read from. Unset uses the transport's
   * own connection. The per-instance keys and the compatibility walk stay on the transport's
   * connection, where older readers and writers find them.
   */
  makeRedis?: (() => RedisLike) | undefined;
}

/** Default {@link BullMQTransportOptions.pingIntervalMs}. */
const DEFAULT_PING_INTERVAL_MS = 30_000;
/** How long one watchdog PING may take before its subscriber connection is presumed dead. */
const SUBSCRIBER_PING_TIMEOUT_MS = 5_000;

/** `undefined` → the default, `0`/`false` → disabled, any other number → itself. */
function normalizePingInterval(value: number | false | undefined): number | false {
  if (value === undefined) return DEFAULT_PING_INTERVAL_MS;
  if (value === false || value === 0) return false;
  // setInterval turns a negative, NaN or > 2^31-1 delay into ~1ms: a PING hot loop. Treat those as
  // unset (the default), like a non-positive stepTimeoutMs.
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    return DEFAULT_PING_INTERVAL_MS;
  }
  return value;
}

/** The largest delay `setInterval` honours (a signed 32-bit int); anything above fires at ~1ms. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** Most step results one job of the results-batch queue carries. */
const RESULT_BATCH_MAX = 256;
/** How long a worker trusts its last answer to "does an engine consume result batches?". */
const RESULT_BATCH_CONSUMERS_TTL_MS = 5_000;

/**
 * A queue-backed {@link Transport} over BullMQ/Redis, BYTE-COMPATIBLE with the aviary
 * (`nestjs-durable`) BullMQ transport and its Python raw-redis worker — so an Adonis engine can
 * dispatch to a Python worker (and vice versa) on the SAME Redis keys. Steps/workflow tasks go to a
 * per-routing-token queue (`${P}-tasks-${token}`); step results, workflow decisions and streamed step
 * events ride their own queues; run / long-step heartbeats ride a `${P}-heartbeat` pub/sub; and a
 * TTL'd `${P}-worker-heartbeat:${token}:${instance}` key registry advertises live workers.
 *
 * It implements the CURRENT {@link Transport} interface (dispatch/result/heartbeat + the optional
 * workflow-task / decision / step-event / group-health hooks). It deliberately does NOT implement the
 * control plane: the shipped `RedisControlPlane` already owns the byte-compatible `${P}-control`
 * channel, so pass it as the engine's `controlPlane` alongside this transport.
 *
 * The concrete broker is injected as {@link BullMQDeps} so this class stays pure — construct it via
 * `transports.bullmq({...})`, which builds the real bullmq/ioredis deps lazily.
 */
export class BullMQTransport implements Transport {
  readonly #deps: BullMQDeps;
  readonly #partition: string | undefined;
  readonly #prefix: string;
  #namespace: string | undefined;
  readonly #explicitNamespace: boolean;
  readonly #instanceId: string;
  readonly #onError: (err: unknown) => void;
  readonly #hasOnError: boolean;
  #closing = false;
  readonly #closeTimeoutMs: number;
  readonly #resultConcurrency: number;
  readonly #concurrency: ConcurrencyOption | undefined;
  // Shared by every task worker: tracks in-flight work and the step-completion window, snapshots the
  // heartbeat status and, in adaptive mode, sets every task worker's `concurrency` on each move.
  #controller: AdaptiveController | undefined;
  // Deferred consumption (see deferConsumers): worker constructions parked until startConsumers().
  #consumersDeferred = false;
  readonly #deferredWorkers: Array<() => void> = [];

  readonly #handlers = new Map<string, StepHandler>();
  // --- Task queue layout (see `taskQueues` / `taskQueueDrain`) ---
  readonly #taskQueues: 'per-handler' | 'grouped';
  readonly #drainEnabled: boolean;
  readonly #drainIntervalMs: number;
  /** Per-token concurrency of grouped and drained jobs (see HandlerLimiter). Created on first use. */
  #limiter: HandlerLimiter | undefined;
  /** Every routing token this process consumes (in either layout). */
  readonly #servedTokens = new Set<string>();
  /** The grouped task workers, by queue name, with the tokens each serves. */
  readonly #groupedWorkers = new Map<string, { worker: WorkerLike; tokens: Set<string> }>();
  /** Workers draining the other layout's queues, by queue name (see `taskQueueDrain`). */
  readonly #drainWorkers = new Map<string, { worker: WorkerLike; tokens: Set<string> }>();
  #drainTimer: ReturnType<typeof setInterval> | undefined;
  #drainChecking = false;
  /** How many times each job id was handed back for its handler being at its limit. */
  readonly #overflowBounces = new Map<string, number>();
  /** Tokens already reported as dispatched to a process that does not serve them. */
  readonly #foreignReported = new Set<string>();
  /** The last per-token depth read of each grouped queue (see #groupedSnapshot). */
  readonly #groupedSnapshots = new Map<string, { at: number; read: Promise<GroupedSnapshot> }>();
  /** Aborted when `close()` starts: the `log.signal` of every step this worker runs. */
  readonly #shutdown = new AbortController();
  /**
   * Task jobs whose handler is still running, with the lock token BullMQ handed the processor and the
   * hook that makes the processor let go. `close()` hands back whatever is still here when its budget
   * runs out.
   */
  readonly #openTasks = new Map<
    JobLike,
    { token: string | undefined; release: () => void; parked: boolean }
  >();
  /** Payloads of jobs handed back by `close()`: their abandoned handler must publish nothing. */
  readonly #handedBack = new WeakSet<object>();
  // Worker-side workflow turn consumers, keyed by workflow name — a `workflow`-shaped job routes here.
  readonly #workflowTurns = new Map<string, WorkflowTurnHandler>();
  // One task queue/worker per registered handler name (its routing token) — never a shared queue.
  readonly #queues = new Map<string, QueueLike>();
  readonly #taskWorkers = new Map<string, WorkerLike>();
  #resultsWorker: WorkerLike | undefined;
  #resultBatchesWorker: WorkerLike | undefined;
  /** The engine's result handlers (one per engine), also fed by the routed-reply queue. */
  readonly #resultHandlers = new Set<(result: StepResult) => Promise<void>>();
  // Step results waiting for the results-batch publish in flight to finish (see `#publishResult`).
  readonly #resultsToBatch: Array<{
    result: StepResult;
    resolve: () => void;
    reject: (err: unknown) => void;
  }> = [];
  #publishingResultBatch = false;
  #resultBatchConsumers: { consumed: boolean; at: number } | undefined;
  #resultBatchConsumersRead: Promise<boolean> | undefined;
  #decisionsWorker: WorkerLike | undefined;
  readonly #decisionHandlers = new Set<(decision: WorkflowDecision) => Promise<void>>();
  #stepEventsWorker: WorkerLike | undefined;

  // Long-step heartbeat pub/sub (distinct from the worker-liveness key registry below).
  #heartbeatPub: RedisLike | undefined;
  #heartbeatSub: RedisLike | undefined;

  // Worker liveness: one TTL'd key per handled routing token, refreshed on a single shared interval.
  #workerRedis: RedisLike | undefined;
  #workerHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  readonly #heartbeatTokens = new Set<string>();

  // Worker registry (see WorkerRegistryOptions).
  readonly #legacyScan: boolean;
  readonly #legacyScanIntervalMs: number;
  readonly #legacyWrites: boolean;
  readonly #legacyWriteIntervalMs: number;
  readonly #makeRegistryRedis: (() => RedisLike) | undefined;
  #registryRedis: RedisLike | undefined;
  /** Suffix of this transport's fields in the instances hash: two transports (or a restart) sharing
   *  an instance id never overwrite each other's field. */
  readonly #registryNonce = randomUUID().slice(0, 8);
  /** Every entry this process advertises, by {@link ownEntryKey}; written by {@link #flushRegistry}. */
  readonly #own = new Map<string, OwnEntry>();
  /** The flush scheduled for the next macrotask, if any (see #scheduleRegistryFlush). */
  #registryFlush: Promise<void> | undefined;
  /** The instances-hash fields this transport has written, by hash key (removed on close). */
  readonly #writtenFields = new Map<string, Set<string>>();
  /** When each instances hash last had its TTL refreshed and expired fields deleted. */
  readonly #instancesUpkeepAt = new Map<string, number>();
  /** The last read of the instances hash, and the one in flight (see #instancesSnapshot). */
  #registrySnapshot: { prefix: string; at: number; entries: RegistrySnapshot } | undefined;
  #registryRead: { prefix: string; read: Promise<RegistrySnapshot> } | undefined;
  /** When each per-instance key was last written for older readers, and with what value. */
  readonly #legacyWrittenAt = new Map<string, { at: number; value: string }>();
  /** When each rc.31 per-token hash last had its TTL and index entry refreshed, and was pruned. */
  readonly #registryUpkeepAt = new Map<string, { at: number; prunedAt: number }>();
  /** The last compatibility walk (see #legacyEntries) and the one in flight. */
  #legacyRead: { prefix: string; at: number; snapshot: RegistrySnapshot } | undefined;
  #legacyInFlight: { prefix: string; read: Promise<RegistrySnapshot> } | undefined;

  // P4 store-less protocol: start-run / run-request queues + consumers, run-reply / tenant-events pub/sub.
  #startRunWorker: WorkerLike | undefined;
  // The run queue consumers (see onDispatchedRun), by queue name, and the stop() each handed out.
  readonly #runsWorkers = new Map<string, { worker: WorkerLike; stop: () => Promise<void> }>();
  #runRequestWorker: WorkerLike | undefined;
  #runReplyPub: RedisLike | undefined;
  #runReplySub: RedisLike | undefined;
  #tenantEventPub: RedisLike | undefined;
  // ONE shared subscriber for every tenant-events channel; a message is routed to the channel's
  // handler set, so `onTenantEvent` can be called for several tenants (or several times per tenant).
  #tenantEventSub: RedisLike | undefined;
  readonly #tenantEventChannels = new Set<string>();
  readonly #tenantEventHandlers = new Map<string, Set<(evt: TenantEvent) => void>>();

  // Every pub/sub SUBSCRIBER connection, probed by the one shared watchdog interval. Publish-only
  // connections are not tracked: they write, so a dead one fails its next publish instead of silently.
  readonly #subscribers = new Set<RedisLike>();
  readonly #pingIntervalMs: number | false;
  readonly #stepTimeoutMs: number | undefined;
  #pingWatchdogTimer: ReturnType<typeof setInterval> | undefined;

  // --- Reply routing (see `replyRouting`) ---
  readonly #replyRouting: boolean;
  readonly #replyAliveTtlMs: number;
  readonly #replySweepMs: number;
  readonly #replyDrainIdleMs: number;
  /** The engine instance this transport consumes routed replies for. */
  #replyId: string | undefined;
  #replyWorker: WorkerLike | undefined;
  #replyRedisClient: RedisLike | undefined;
  #replyBeatTimer: ReturnType<typeof setInterval> | undefined;
  #replySweepTimer: ReturnType<typeof setInterval> | undefined;
  #replySweeping = false;
  readonly #replyAliveCache = new Map<string, { alive: boolean; at: number }>();
  /** Routed results waiting for the batch in flight to their instance's queue, by queue. */
  readonly #replyOutboxes = new Map<
    string,
    {
      entries: Array<{ result: StepResult; resolve: (sent: boolean) => void }>;
      publishing: boolean;
    }
  >();
  /** Dead engines' reply queues this transport is moving to the shared results. */
  readonly #replyDrains = new Map<string, { worker: WorkerLike; idleSince?: number | undefined }>();
  /** Seals what this transport sends and opens what it receives. */
  readonly #messages: MessageSealer;

  /** The sealer (the control plane's responder grants tenant keys through it). */
  get messageSealer(): MessageSealer {
    return this.#messages;
  }
  /** An opened task → the job data it came from (the hand-back check reads the job's object). */
  readonly #openedFrom = new WeakMap<object, object>();

  /** Run requests / starts that arrived plain (by correlation id): their replies go back plain. A
   *  start is answered with its run id as the reply's `requestId`, so both are looked up there. */
  readonly #plainRequests = new Set<string>();

  #notePlainRequest(raw: unknown, id: unknown): void {
    if (isSealedMessage(raw) || typeof id !== 'string') return;
    if (this.#plainRequests.size >= 10_000) {
      const oldest = this.#plainRequests.values().next().value;
      if (oldest !== undefined) this.#plainRequests.delete(oldest);
    }
    this.#plainRequests.add(id);
  }

  /** Whether `task` (opened or raw) was handed back on shutdown. */
  #wasHandedBack(task: object): boolean {
    return this.#handedBack.has(task) || this.#handedBack.has(this.#openedFrom.get(task) ?? task);
  }

  /** The opened message, or `undefined` when it is refused (logged once by the sealer). */
  async #openOrDrop<T>(kind: MessageKind, raw: unknown): Promise<T | undefined> {
    const plain = this.#messages.openPlain<T>(kind, raw);
    if (plain !== undefined) return plain;
    try {
      return await this.#messages.open<T>(kind, raw);
    } catch (err) {
      if (isMessageRejected(err)) return undefined;
      throw err;
    }
  }

  constructor(options: BullMQTransportOptions) {
    this.#messages = sealerOf(options.messages, 'bullmq');
    // A tenant pod asks the control plane for its message key over the run-request channel.
    this.#messages.attach?.({
      dispatchRunRequest: async (msg: RunRequest) => {
        this.#ensureRunReplySub();
        await this.dispatchRunRequest(msg);
      },
    } as never);
    this.#deps = options.deps;
    this.#partition = options.partition;
    this.#prefix = options.prefix ?? 'durable';
    this.#namespace = options.namespace;
    this.#explicitNamespace = options.namespace !== undefined;
    this.#instanceId = options.instanceId ?? buildInstanceId();
    this.#onError = options.onError ?? (() => {});
    this.#hasOnError = options.onError !== undefined;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    // At least RESULT_CONSUMER_MIN in flight: the engine settles one run's results in batches of
    // whatever has arrived, so a consumer handing over a few at a time makes a wide fan settle a few
    // results per write. `resultConcurrency` only raises it.
    this.#resultConcurrency = Math.max(
      RESULT_CONSUMER_MIN,
      workerConcurrency(options.resultConcurrency),
    );
    this.#concurrency = options.concurrency;
    this.#replyRouting = options.replyRouting !== false;
    this.#replyAliveTtlMs = positiveMs(options.replyAliveTtlMs, 15_000);
    this.#replySweepMs = positiveMs(options.replySweepMs, 5_000);
    this.#replyDrainIdleMs = positiveMs(options.replyDrainIdleMs, 90_000);
    this.#pingIntervalMs = normalizePingInterval(options.pingIntervalMs);
    this.#legacyScan = options.workerRegistry?.legacyScan !== false;
    this.#legacyScanIntervalMs = positiveMs(
      options.workerRegistry?.legacyScanIntervalMs,
      DEFAULT_LEGACY_SCAN_INTERVAL_MS,
    );
    this.#legacyWrites = options.workerRegistry?.legacyWrites !== false;
    this.#legacyWriteIntervalMs = positiveMs(
      options.workerRegistry?.legacyWriteIntervalMs,
      DEFAULT_LEGACY_WRITE_INTERVAL_MS,
    );
    this.#makeRegistryRedis = options.workerRegistry?.makeRedis;
    this.#taskQueues = options.taskQueues === 'grouped' ? 'grouped' : 'per-handler';
    const drain = options.taskQueueDrain;
    this.#drainEnabled = drain === undefined ? this.#taskQueues === 'grouped' : drain !== false;
    this.#drainIntervalMs = positiveMs(
      typeof drain === 'object' ? drain.intervalMs : undefined,
      DEFAULT_DRAIN_CHECK_INTERVAL_MS,
    );
    this.#stepTimeoutMs =
      options.stepTimeoutMs !== undefined &&
      Number.isFinite(options.stepTimeoutMs) &&
      options.stepTimeoutMs > 0
        ? options.stepTimeoutMs
        : undefined;
  }

  /**
   * A subscriber-mode connection: a fresh `makeRedis()` client registered with the ping watchdog and
   * given an `error` listener. Every pub/sub subscriber goes through here, because a subscriber never
   * writes on its own and so cannot surface a silent connection loss by itself.
   */
  #subscriberRedis(label: string): RedisLike {
    const sub = this.#deps.makeRedis();
    this.#trackSubscriber(sub, label);
    return sub;
  }

  /**
   * Attach a de-duplicated `error` listener and register `sub` with the watchdog. The listener is not
   * hygiene: an `error` emitted with no listener throws on a plain EventEmitter (and a dead,
   * reconnecting subscriber emits them in bursts), so a connection nothing else listens to could take
   * the process down. The first error of each reconnect burst goes to `onError` when one is
   * configured, else to `console.warn`.
   */
  #trackSubscriber(sub: RedisLike, label: string): void {
    this.#subscribers.add(sub);
    let loggedSinceReady = false;
    sub.on('error', ((err: Error) => {
      if (loggedSinceReady) return; // one report per reconnect burst, not one per retry
      loggedSinceReady = true;
      if (this.#hasOnError) this.#onError(err);
      else
        console.warn(`[adonis-durable] bullmq ${label} subscriber error: ${err?.message ?? err}`);
    }) as never);
    sub.on('ready', (() => {
      loggedSinceReady = false;
    }) as never);
    this.#startPingWatchdog();
  }

  /** Start the ONE shared watchdog interval (idempotent; unref'd; cleared in {@link close}). */
  #startPingWatchdog(): void {
    if (this.#pingWatchdogTimer || this.#pingIntervalMs === false) return;
    this.#pingWatchdogTimer = setInterval(() => {
      for (const sub of this.#subscribers) void this.#pingSubscriber(sub);
    }, this.#pingIntervalMs);
    this.#pingWatchdogTimer.unref?.();
  }

  /**
   * PING one subscriber; on rejection or timeout, `disconnect(true)` it so ioredis reconnects and
   * `autoResubscribe` restores its channels. A connection that is not `'ready'` is already
   * mid-(re)connect and is skipped. The timeout is capped at the interval, so a short interval
   * shortens the whole detect-and-reconnect cycle.
   */
  async #pingSubscriber(sub: RedisLike): Promise<void> {
    if (typeof sub.ping !== 'function') return;
    if (sub.status !== undefined && sub.status !== 'ready') return;
    const timeoutMs =
      this.#pingIntervalMs === false
        ? SUBSCRIBER_PING_TIMEOUT_MS
        : Math.min(SUBSCRIBER_PING_TIMEOUT_MS, this.#pingIntervalMs);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ping timed out')), timeoutMs);
        (sub.ping as () => Promise<unknown>)().then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          (err: unknown) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      });
    } catch (err) {
      // A ping in flight when close() lands must not resurrect the connection close() just dropped:
      // disconnect(true) reconnects rather than closes.
      if (this.#closing) return;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[adonis-durable] bullmq subscriber connection unresponsive (${message}); reconnecting to restore its subscription`,
      );
      sub.disconnect(true);
    }
  }

  /** The shared concurrency controller, created on first use (a task worker, a job or a heartbeat). */
  #concurrencyController(): AdaptiveController {
    if (!this.#controller) {
      this.#controller = new AdaptiveController({
        ...(this.#concurrency !== undefined ? { concurrency: this.#concurrency } : {}),
        apply: (limit) => this.#applyLimit(limit),
      });
    }
    return this.#controller;
  }

  /** A new per-handler limit, from the adaptive controller: every task worker and the limiter take it. */
  #applyLimit(limit: number): void {
    for (const worker of this.#taskWorkers.values()) worker.concurrency = limit;
    this.#limiter?.setLimit(limit);
    for (const entry of this.#groupedWorkers.values()) {
      entry.worker.concurrency = groupedSlots(limit, entry.tokens.size);
    }
    for (const entry of this.#drainWorkers.values()) {
      entry.worker.concurrency = groupedSlots(limit, entry.tokens.size);
    }
  }

  /** How many jobs of one handler run at once: the controller's limit, else the deps' default. */
  #taskLimit(): number {
    return this.#concurrency !== undefined
      ? this.#concurrencyController().limit
      : workerConcurrency(this.#deps.defaultConcurrency);
  }

  #handlerLimiter(): HandlerLimiter {
    this.#limiter ??= new HandlerLimiter(this.#taskLimit());
    return this.#limiter;
  }

  /** The task queue a routing token's jobs go to in this transport's layout. */
  #taskQueueName(token: string): string {
    return this.#taskQueues === 'grouped'
      ? groupedTasksName(this.#effectivePrefix(), token)
      : tasksName(this.#effectivePrefix(), token);
  }

  /**
   * Park every point-to-point consumer registered from now on — the task, results, decisions,
   * step-events, start-run and run-request workers — until {@link startConsumers}.
   *
   * WHY: a BullMQ `Worker` starts fetching the moment it is constructed, and these queues hand each
   * job to ONE consumer. Any process that registers them competes with the real worker fleet: a
   * `node ace` command or REPL claims jobs it then dies holding, and steals results addressed to the
   * long-lived engine (the bug the `queue` transport fixed the same way). Deferring construction makes
   * such a process a pure producer — it still dispatches and publishes; the jobs stay on the queues.
   * Pub/sub subscriptions (heartbeats, run replies, tenant events) are broadcast, take nothing from
   * anyone, and are left alone.
   *
   * Call it before any subscription is made (the provider does, right after building the transport);
   * workers already started are not stopped.
   */
  deferConsumers(): void {
    this.#consumersDeferred = true;
  }

  /** Construct every worker parked by {@link deferConsumers} and stop deferring — the explicit "this
   *  process IS a worker" declaration (`durable:work` makes it via `engine.startConsumers()`).
   *  Idempotent; a no-op when consumption was never deferred. */
  startConsumers(): void {
    if (!this.#consumersDeferred) return;
    this.#consumersDeferred = false;
    for (const start of this.#deferredWorkers.splice(0)) start();
  }

  /**
   * `deps.makeWorker`, unless consumption is deferred: then a stand-in that records `failed` listeners
   * and `concurrency` assignments (the adaptive controller keeps setting it) and builds the real
   * worker — replaying both — on {@link startConsumers}. `close()` on a never-started stand-in is a
   * no-op, so a producer process shuts down without ever touching the broker's consumer side.
   */
  #makeWorker(
    name: string,
    process: Parameters<BullMQDeps['makeWorker']>[1],
    opts?: { concurrency?: number },
  ): WorkerLike {
    if (!this.#consumersDeferred) return this.#deps.makeWorker(name, process, opts);
    const listeners: Array<(job: JobLike | undefined, err: Error) => void> = [];
    let real: WorkerLike | undefined;
    let closed = false;
    let concurrency = opts?.concurrency;
    const standIn: WorkerLike = {
      get concurrency() {
        return real ? real.concurrency : concurrency;
      },
      set concurrency(limit) {
        if (real) real.concurrency = limit;
        else concurrency = limit;
      },
      on: (_event, listener) => {
        if (real) real.on('failed', listener);
        else listeners.push(listener);
        return standIn;
      },
      close: async () => {
        closed = true;
        await real?.close();
      },
    };
    this.#deferredWorkers.push(() => {
      if (closed) return;
      real = this.#deps.makeWorker(
        name,
        process,
        concurrency !== undefined ? { ...opts, concurrency } : opts,
      );
      for (const listener of listeners) real.on('failed', listener);
    });
    return standIn;
  }

  /** Stable id stamped on this instance's worker-liveness keys. */
  get instanceId(): string {
    return this.#instanceId;
  }

  /**
   * Adopt `namespace` (the engine's), segmenting every name by it — but ONLY if one wasn't passed
   * explicitly to the constructor (an explicit one always wins). Idempotent. No-op for `"default"`.
   */
  useNamespace(namespace: string): void {
    if (this.#explicitNamespace) return;
    this.#namespace = namespace;
  }

  /**
   * The partition this instance serves (the `@<partition>` suffix of the routing tokens it consumes):
   * the explicit `partition`, else its namespace when that is set and not `default`. A namespaced
   * engine stamps its runs with its namespace and dispatches their steps to `<name>@<namespace>`, so
   * it serves those tokens by default, as nestjs-durable's `servingPartition()` does.
   */
  #servingPartition(): string | undefined {
    if (this.#partition !== undefined) return this.#partition;
    return this.#namespace && this.#namespace !== 'default' ? this.#namespace : undefined;
  }

  /** The user's `onError` when supplied, else undefined (so the helper falls back to console.warn). */
  #subscribeErrorSink(): ((err: unknown) => void) | undefined {
    return this.#hasOnError ? this.#onError : undefined;
  }

  #effectivePrefix(): string {
    return effectivePrefix(this.#prefix, this.#namespace);
  }

  /**
   * Publish a step's result, resolving once it is on a queue. While an engine consumes result
   * batches, results that finish while one batch is being published go out together in the next, so
   * a busy worker publishes one job per batch instead of one per step, and an idle one publishes each
   * result as soon as it finishes. A batch that fails to publish goes out one result per job.
   * Otherwise each result is its own job on the results queue.
   */
  async #publishResult(plain: StepResult, replyTo?: string, seal = true): Promise<void> {
    const result = seal ? await this.#messages.seal('result', plain) : plain;
    if (replyTo !== undefined && (await this.#publishReply(result, replyTo))) return;
    if (!(await this.#resultBatchesConsumed())) {
      await this.#queue(resultsName(this.#effectivePrefix())).add(
        'result',
        result,
        resultJobOptions(),
      );
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.#resultsToBatch.push({ result, resolve, reject });
      if (!this.#publishingResultBatch) void this.#publishResultBatches();
    });
  }

  async #publishResultBatches(): Promise<void> {
    this.#publishingResultBatch = true;
    try {
      while (this.#resultsToBatch.length > 0) {
        const batch = this.#resultsToBatch.splice(0, RESULT_BATCH_MAX);
        try {
          await this.#queue(resultBatchesName(this.#effectivePrefix())).add(
            'results',
            { results: batch.map((entry) => entry.result) },
            resultJobOptions(),
          );
          for (const entry of batch) entry.resolve();
        } catch {
          // The results queue takes them one by one, so a batch's failure costs no result of it.
          await Promise.all(
            batch.map((entry) =>
              this.#queue(resultsName(this.#effectivePrefix()))
                .add('result', entry.result, resultJobOptions())
                .then(() => entry.resolve(), entry.reject),
            ),
          );
        }
      }
    } finally {
      this.#publishingResultBatch = false;
    }
  }

  /**
   * Whether an engine consumes the results-batch queue: this instance's own consumer, else a live
   * worker on it, re-read at most every {@link RESULT_BATCH_CONSUMERS_TTL_MS}. A queue that cannot
   * count its workers, or a failed read, answers no, so results go out one job each.
   */
  async #resultBatchesConsumed(): Promise<boolean> {
    if (this.#resultBatchesWorker) return true;
    const known = this.#resultBatchConsumers;
    if (known && Date.now() - known.at < RESULT_BATCH_CONSUMERS_TTL_MS) return known.consumed;
    this.#resultBatchConsumersRead ??= Promise.resolve()
      .then(async () => {
        const queue = this.#queue(resultBatchesName(this.#effectivePrefix()));
        return queue.getWorkersCount ? (await queue.getWorkersCount()) > 0 : false;
      })
      .catch(() => false)
      .then((consumed) => {
        this.#resultBatchConsumers = { consumed, at: Date.now() };
        this.#resultBatchConsumersRead = undefined;
        return consumed;
      });
    return this.#resultBatchConsumersRead;
  }

  #queue(name: string): QueueLike {
    let queue = this.#queues.get(name);
    if (!queue) {
      queue = this.#deps.makeQueue(name);
      this.#queues.set(name, queue);
    }
    return queue;
  }

  #workerRedisClient(): RedisLike {
    if (!this.#workerRedis) this.#workerRedis = this.#deps.makeRedis();
    return this.#workerRedis;
  }

  /**
   * Capability hook consumed by the `tenant`-topology provider: mint a DEDICATED Redis client the
   * store-less {@link WorkerRuntime}'s registry uses to publish/refresh its `-worker-descriptor:`
   * and `-worker-heartbeat:` keys (SET…EX). Dedicated so the registry disconnecting on worker
   * drain never tears down the transport's own broker clients. The returned `RedisLike` structurally
   * satisfies the registry's `DescriptorRedis` port (`set`/`del`/`disconnect`). A per-instance worker
   * key it is asked to write becomes an entry of that instance's field in the instances hash (one
   * `HSET` for a whole beat), which is what `listWorkerDescriptors` reads back; the key itself is
   * written for older readers as {@link WorkerRegistryOptions.legacyWrites} says. Any other key is
   * written as asked.
   */
  createDescriptorRedis(): DescriptorRedis & { disconnect(): void } {
    const client = this.#deps.makeRedis();
    return {
      set: async (key, value, mode, ttl) => {
        const parsed = parseWorkerKey(key);
        if (!parsed) {
          await client.set(key, value, mode, ttl);
          return;
        }
        this.#setOwnEntry(parsed.effPrefix, parsed.instance, parsed.kind, parsed.token, value, ttl);
        await Promise.all([
          this.#scheduleRegistryFlush(),
          this.#writeLegacy(client, {
            effPrefix: parsed.effPrefix,
            instance: parsed.instance,
            kind: parsed.kind,
            tokens: [parsed.token],
            value,
            ttlSeconds: ttl,
            force: false,
          }),
        ]);
      },
      del: async (...keys) => {
        for (const key of keys) {
          const parsed = parseWorkerKey(key);
          if (!parsed) continue;
          this.#own.delete(
            ownEntryKey(parsed.effPrefix, parsed.instance, parsed.kind, parsed.token),
          );
        }
        await Promise.all([
          client.del?.(...keys),
          this.#removeLegacyHashFields(keys),
          this.#scheduleRegistryFlush(),
        ]);
      },
      disconnect: () => client.disconnect(),
    };
  }

  // ---------------------------------------------------------------------------
  // engine → worker
  // ---------------------------------------------------------------------------

  /** `task.group` already carries the FINAL routing token (computed by the engine) — target that
   *  handler's dedicated queue. Job name `task`; DTO is the raw job data. */
  async dispatch(task: RemoteTask): Promise<void> {
    await this.#queue(this.#taskQueueName(task.group)).add(
      'task',
      await this.#messages.seal('task', task),
      taskDispatchOptions(task),
    );
  }

  /**
   * {@link dispatch} for many tasks: `addBulk` per task queue, {@link TASK_ADD_BULK_CHUNK} jobs a
   * call, {@link TASK_ADD_BULK_IN_FLIGHT} calls at once. A queue without `addBulk` gets one `add` per
   * task.
   */
  async dispatchMany(tasks: RemoteTask[]): Promise<void> {
    const sealed = await Promise.all(tasks.map((task) => this.#messages.seal('task', task)));
    const byQueue = new Map<string, Array<{ task: RemoteTask; data: RemoteTask }>>();
    for (const [i, task] of tasks.entries()) {
      const entry = { task, data: sealed[i] as RemoteTask };
      const name = this.#taskQueueName(task.group);
      const queued = byQueue.get(name);
      if (queued) queued.push(entry);
      else byQueue.set(name, [entry]);
    }
    const calls: Array<() => Promise<unknown>> = [];
    for (const [name, queued] of byQueue) {
      const queue = this.#queue(name);
      for (let at = 0; at < queued.length; at += TASK_ADD_BULK_CHUNK) {
        const chunk = queued.slice(at, at + TASK_ADD_BULK_CHUNK).map(({ task, data }) => ({
          name: 'task',
          data,
          opts: taskDispatchOptions(task),
        }));
        calls.push(() =>
          queue.addBulk
            ? queue.addBulk(chunk)
            : Promise.all(chunk.map((job) => queue.add(job.name, job.data, job.opts))),
        );
      }
    }
    let next = 0;
    const lane = async () => {
      while (next < calls.length) {
        const call = calls[next] as () => Promise<unknown>;
        next += 1;
        await call();
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(TASK_ADD_BULK_IN_FLIGHT, calls.length) }, lane),
    );
  }

  /** engine → workflow worker: a `WorkflowTask` on the workflow's dedicated task queue (same queue a
   *  Python workflow worker consumes). Job name `workflow`; the decision returns on `${P}-decisions`. */
  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    await this.#queue(this.#taskQueueName(task.group)).add(
      'workflow',
      await this.#messages.seal('workflowTask', task),
      jobOptions(task.priority),
    );
  }

  // ---------------------------------------------------------------------------
  // worker side — register a step handler, run it, push the result back
  // ---------------------------------------------------------------------------

  /**
   * Register a step handler (worker side). Starts a DEDICATED task worker for `name`'s routing token on
   * first registration (see {@link #ensureTaskWorker}) and begins stamping this instance's liveness key
   * for that token. Re-registering swaps the handler fn; its worker is untouched.
   */
  handle(name: string, fn: StepHandler): void {
    this.#handlers.set(name, fn);
    this.#ensureTaskWorker(routingToken(name, this.#servingPartition()));
  }

  /**
   * Register a WORKFLOW turn consumer (worker side, design §4 / spec §6.3). Starts a DEDICATED task
   * worker for the workflow `name`'s routing token — the SAME `${P}-tasks-<token>` queue a Python
   * workflow worker consumes — which discriminates step-vs-workflow BY SHAPE ({@link #runJob}): a
   * `workflow`-shaped job runs `turn(task)` (the replay → decision) and its {@link WorkflowDecision} is
   * published on `${P}-decisions`. Re-registering swaps the turn fn; the worker is untouched.
   */
  handleWorkflow(name: string, turn: WorkflowTurnHandler): void {
    this.#workflowTurns.set(name, turn);
    this.#ensureTaskWorker(routingToken(name, this.#servingPartition()));
  }

  /** Start (once per routing token) the discriminating task worker + its liveness heartbeat. Shared by
   *  {@link handle} (steps) and {@link handleWorkflow} (workflow turns) — both ride `${P}-tasks-<token>`. */
  #ensureTaskWorker(token: string): void {
    if (this.#taskQueues === 'grouped') {
      this.#ensureGroupedWorker(token);
      return;
    }
    if (this.#taskWorkers.has(token)) return;
    this.#servedTokens.add(token);
    const controller = this.#concurrencyController();
    // A new worker starts at the controller's live limit, so a token registered after an adaptive
    // move joins at the current limit rather than at `start`.
    const worker = this.#makeWorker(
      tasksName(this.#effectivePrefix(), token),
      (job, token) => this.#runTaskJob(job, token),
      this.#concurrency !== undefined ? { concurrency: controller.limit } : undefined,
    );
    this.#bridgeFailures(worker);
    this.#taskWorkers.set(token, worker);
    controller.start();
    // Liveness says "a worker consumes this token". A deferred process (a `node ace` producer) has
    // no worker yet, so it must not show up in groupHealth / the dashboard as one: the heartbeat
    // starts with the parked worker, on startConsumers() (the queue and db transports do the same).
    this.#whenConsuming(() => {
      if (this.#closing) return;
      this.#startWorkerHeartbeat(token);
      this.#startDrainChecks();
    });
  }

  /**
   * `taskQueues: 'grouped'`: serve `token` from its partition's shared queue. The queue's one worker
   * is created with the first token and sized by {@link groupedSlots}, so every handler can run its
   * full limit even while each other handler has a limit's worth of jobs waiting in-process; the
   * {@link HandlerLimiter} keeps each handler at its own limit.
   */
  #ensureGroupedWorker(token: string): void {
    if (this.#servedTokens.has(token)) return;
    this.#servedTokens.add(token);
    const controller = this.#concurrencyController();
    const limiter = this.#handlerLimiter();
    const name = groupedTasksName(this.#effectivePrefix(), token);
    let entry = this.#groupedWorkers.get(name);
    if (!entry) {
      const worker = this.#makeWorker(name, (job, lock) => this.#runGroupedJob(job, lock), {
        concurrency: groupedSlots(limiter.limit, 1),
      });
      this.#bridgeFailures(worker);
      entry = { worker, tokens: new Set() };
      this.#groupedWorkers.set(name, entry);
    }
    entry.tokens.add(token);
    entry.worker.concurrency = groupedSlots(limiter.limit, entry.tokens.size);
    controller.start();
    this.#whenConsuming(() => {
      if (this.#closing) return;
      this.#startWorkerHeartbeat(token);
      this.#startDrainChecks();
    });
  }

  /**
   * Terminal-failure bridge: a task job reaching a TERMINAL `failed` state is an INFRASTRUCTURE
   * failure (worker crash / stalled-count exhaustion), never a handler business error —
   * `runStepHandler` catches every handler throw and publishes a failed StepResult so the job
   * SUCCEEDS. `failed` fires only when no StepResult was produced, so without this the run hangs on
   * its `pending` checkpoint forever. Synthesize a RETRYABLE failed StepResult so the engine settles
   * the checkpoint and re-dispatches. A PEER replica's worker fails a crashed worker's stalled job,
   * so this still fires cross-process. (A failed WORKFLOW job carries no step identity, so the bridge
   * no-ops for it — the turn's liveness window (`remoteAdvanceSilenceMs`) re-drives it instead.)
   */
  #bridgeFailures(worker: WorkerLike): void {
    worker.on('failed', (job, error) => {
      const identity = failedTaskIdentity(job?.data);
      if (!identity) return; // payload already GC'd, malformed, or a workflow job — nothing safe to publish
      void this.#bridgeTaskFailure(
        identity,
        job?.failedReason ?? error?.message ?? 'unknown',
        isSealedMessage(job?.data),
      );
    });
  }

  /** Whether this process has the handler (or workflow turn) a task job is for. */
  #servesTask(data: unknown): boolean {
    if (isWorkflowTask(data)) return this.#workflowTurns.has(data.workflow);
    // A sealed workflow turn keeps `workflow` and `taskId` in clear (its history is sealed).
    if (taskKindOf(data) === 'workflowTask') {
      return this.#workflowTurns.has((data as { workflow: string }).workflow);
    }
    const name = (data as { name?: unknown } | null | undefined)?.name;
    return typeof name === 'string' && this.#handlers.has(name);
  }

  /**
   * The processor of a grouped (or drained) task queue. A job is routed by the routing token in
   * `data.group`:
   * - a handler this process does not serve: handed back, delayed {@link FOREIGN_HANDBACK_MS}, for a
   *   process that does (no attempt is counted);
   * - a handler under its limit: runs now;
   * - a handler at its limit: waits in-process for a slot, up to one limit's worth of waiters per
   *   handler; beyond that the job is handed back with a delay that grows each time, so one handler's
   *   backlog cannot fill every slot of the shared worker and starve the others.
   * A job without a token, or a broker that cannot hand a job back (a test fake), runs as before.
   */
  async #runGroupedJob(job: JobLike, lock: string | undefined): Promise<void> {
    const group = (job.data as { group?: unknown } | null | undefined)?.group;
    if (typeof group !== 'string') return this.#runTaskJob(job, lock);
    if (!this.#servesTask(job.data)) {
      if (!job.moveToDelayed) return this.#runTaskJob(job, lock);
      if (!this.#foreignReported.has(group)) {
        this.#foreignReported.add(group);
        this.#onError(
          new Error(
            `@agora/durable: a '${group}' task reached a process that does not serve it on the grouped task queue; handing it back for another process. Every process consuming a partition's grouped queue must register the same handlers.`,
          ),
        );
      }
      return this.#handBack(job, lock, FOREIGN_HANDBACK_MS);
    }
    const limiter = this.#handlerLimiter();
    if (limiter.tryAcquire(group)) return this.#runTaskJob(job, lock, { token: group, held: true });
    if (job.moveToDelayed && limiter.waiting(group) >= limiter.limit) {
      return this.#handBack(job, lock, this.#overflowDelay(job, group));
    }
    return this.#runTaskJob(job, lock, { token: group, held: false });
  }

  /** Put an active job back on its queue, delayed `delayMs`, without counting an attempt. */
  async #handBack(job: JobLike, lock: string | undefined, delayMs: number): Promise<never> {
    await (job.moveToDelayed as NonNullable<JobLike['moveToDelayed']>)(Date.now() + delayMs, lock);
    throw handedBackError();
  }

  /**
   * How long a job of a handler at its limit waits before it is offered again: the handler's mean
   * job duration (at least {@link OVERFLOW_MIN_DELAY_MS}, {@link OVERFLOW_DEFAULT_DELAY_MS} before
   * one finished), doubled for each earlier hand-back of the same job, at most
   * {@link OVERFLOW_MAX_DELAY_MS}.
   */
  #overflowDelay(job: JobLike, token: string): number {
    const id = job.id;
    const bounces = id === undefined ? 0 : (this.#overflowBounces.get(id) ?? 0);
    if (id !== undefined) {
      this.#overflowBounces.delete(id);
      this.#overflowBounces.set(id, bounces + 1);
      if (this.#overflowBounces.size > OVERFLOW_BOUNCES_MAX) {
        const oldest = this.#overflowBounces.keys().next().value;
        if (oldest !== undefined) this.#overflowBounces.delete(oldest);
      }
    }
    const base = Math.max(
      OVERFLOW_MIN_DELAY_MS,
      this.#limiter?.averageMs(token) ?? OVERFLOW_DEFAULT_DELAY_MS,
    );
    return Math.min(OVERFLOW_MAX_DELAY_MS, base * 2 ** Math.min(bounces, 16));
  }

  // ---------------------------------------------------------------------------
  // Draining the other layout's task queues (see `taskQueueDrain`)
  // ---------------------------------------------------------------------------

  /** Start the periodic drain check (once), first run on the next macrotask so a burst of `handle()`
   *  calls is checked together. */
  #startDrainChecks(): void {
    if (!this.#drainEnabled || this.#drainTimer || this.#closing) return;
    const tick = (): void => {
      if (this.#drainChecking || this.#closing) return;
      this.#drainChecking = true;
      void this.#checkDrains()
        .catch((err) => this.#onError(err))
        .finally(() => {
          this.#drainChecking = false;
        });
    };
    this.#drainTimer = setInterval(tick, this.#drainIntervalMs);
    this.#drainTimer.unref?.();
    setTimeout(tick, 0).unref?.();
  }

  /** The other layout's queue of each served token, with the tokens it carries. */
  #otherLayoutQueues(): Map<string, Set<string>> {
    const prefix = this.#effectivePrefix();
    const queues = new Map<string, Set<string>>();
    for (const token of this.#servedTokens) {
      const name =
        this.#taskQueues === 'grouped' ? tasksName(prefix, token) : groupedTasksName(prefix, token);
      const tokens = queues.get(name);
      if (tokens) tokens.add(token);
      else queues.set(name, new Set([token]));
    }
    return queues;
  }

  /**
   * One drain check: stop the drain workers whose queue is empty, then look at every other queue
   * with ONE `EXISTS` over their work keys (chunked at {@link DRAIN_EXISTS_CHUNK} keys) and, only
   * when something exists, find which queues hold jobs and start a drain worker on each.
   */
  async #checkDrains(): Promise<void> {
    const client = this.#workerRedisClient();
    if (!client.exists) return;
    const exists = client.exists.bind(client);
    const bull = this.#deps.queueKeyPrefix ?? 'bull';
    const queues = this.#otherLayoutQueues();
    for (const [name, entry] of [...this.#drainWorkers]) {
      if (this.#closing) return;
      const tokens = queues.get(name);
      if (tokens) {
        entry.tokens = tokens;
        entry.worker.concurrency = groupedSlots(this.#handlerLimiter().limit, tokens.size);
      }
      if ((await exists(...queueWorkKeys(bull, name))) > 0) continue;
      this.#drainWorkers.delete(name);
      await entry.worker.close();
    }
    const idle = [...queues.keys()].filter((name) => !this.#drainWorkers.has(name));
    if (idle.length === 0) return;
    const keys = idle.flatMap((name) => queueWorkKeys(bull, name));
    let found = 0;
    for (let at = 0; at < keys.length && found === 0; at += DRAIN_EXISTS_CHUNK) {
      found += await exists(...keys.slice(at, at + DRAIN_EXISTS_CHUNK));
    }
    if (found === 0) return;
    for (const name of idle) {
      if (this.#closing) return;
      if ((await exists(...queueWorkKeys(bull, name))) === 0) continue;
      // close() collects the workers it stops when it starts: never add one after that.
      if (this.#closing) return;
      const tokens = queues.get(name) as Set<string>;
      const worker = this.#deps.makeWorker(name, (job, lock) => this.#runGroupedJob(job, lock), {
        concurrency: groupedSlots(this.#handlerLimiter().limit, tokens.size),
      });
      this.#bridgeFailures(worker);
      this.#drainWorkers.set(name, { worker, tokens });
    }
  }

  /** The queues this transport is draining right now (for tests and diagnostics). */
  get drainingQueues(): string[] {
    return [...this.#drainWorkers.keys()];
  }

  /**
   * The task-queue processor: {@link #runJob}, tracked in {@link #openTasks} so `close()` can hand the
   * job back to the broker if it outlives the shutdown budget. Handed back, the processor rejects with
   * a `DelayedError` (BullMQ matches it by name), which tells the worker the job was already moved and
   * must not be completed or failed; the handler itself keeps running until the process exits, and
   * {@link #handedBack} keeps it from publishing.
   */
  async #runTaskJob(
    job: JobLike,
    token: string | undefined,
    gate?: { token: string; held: boolean },
  ): Promise<void> {
    let release!: () => void;
    const released = new Promise<never>((_, reject) => {
      release = () => reject(handedBackError());
    });
    released.catch(() => undefined);
    const open = { token, release, parked: false };
    this.#openTasks.set(job, open);
    try {
      if (gate && !gate.held) {
        // Wait for one of the handler's slots (grouped queue). Handed back meanwhile, give up the
        // place in line (or the slot just granted) so it is never leaked.
        const slot = this.#handlerLimiter().acquire(gate.token);
        open.parked = true;
        try {
          await Promise.race([slot.ready, released]);
        } catch (err) {
          slot.cancel();
          throw err;
        }
        open.parked = false;
      }
      if (gate && job.id !== undefined) this.#overflowBounces.delete(job.id);
      const startedAt = performance.now();
      try {
        await Promise.race([this.#runJob(job.data), released]);
      } finally {
        if (gate) this.#handlerLimiter().release(gate.token, performance.now() - startedAt);
      }
    } finally {
      this.#openTasks.delete(job);
    }
  }

  /**
   * Hand every task job still running back to the broker: `moveToDelayed(now)` under the job's lock,
   * which skips the attempt count, so another worker picks it up at once instead of BullMQ finding it
   * stalled once this process is gone (and, past `maxStalledCount`, failing it for good). The same
   * hand-back the queue and db transports do on close.
   */
  async #handBackOpenTasks(onlyParked = false): Promise<void> {
    const open = [...this.#openTasks].filter(([, task]) => !onlyParked || task.parked);
    for (const [job] of open) this.#openTasks.delete(job);
    await Promise.allSettled(
      open.map(async ([job, { token, release }]) => {
        if (!job.moveToDelayed) return;
        try {
          await job.moveToDelayed(Date.now(), token);
        } catch (err) {
          // Lock already lost (or Redis gone): the stalled check redelivers it, as before.
          this.#onError(err);
          return;
        }
        if (job.data && typeof job.data === 'object') this.#handedBack.add(job.data);
        release();
      }),
    );
  }

  /** Route one task job by SHAPE (spec §6.3): a workflow turn runs the replay → decision path, a step
   *  runs the `runStepHandler` → result path. Both kinds share a token's queue but never each other's. */
  async #runJob(raw: unknown): Promise<void> {
    // A refused task fails its job (BullMQ keeps it as failed: the dead letter), and the failure
    // bridge reports the step failed, so its run does not wait on it.
    const kind = taskKindOf(raw);
    // Replies go back in kind: a plain task (from a process not upgraded yet) gets plain replies,
    // which that process can read, instead of sealed ones it would misread.
    const sealed = isSealedMessage(raw);
    const data =
      this.#messages.openPlain<RemoteTask | WorkflowTask>(kind, raw) ??
      (await this.#messages.open<RemoteTask | WorkflowTask>(kind, raw));
    if (data !== raw && raw && typeof raw === 'object') this.#openedFrom.set(data, raw);
    const controller = this.#concurrencyController();
    const startedAt = performance.now();
    controller.onStart();
    // Only step durations feed the latency gradient; a workflow turn still counts as in-flight work
    // and as forward progress for stall detection.
    if (isWorkflowTask(data)) {
      try {
        return await this.#runWorkflowTask(data, sealed);
      } finally {
        controller.onSettle(performance.now() - startedAt, true, 'workflow');
      }
    }
    let ok = false;
    try {
      ok = await this.#runTask(data as RemoteTask, sealed);
    } finally {
      controller.onSettle(performance.now() - startedAt, ok, 'step');
    }
  }

  /** Worker side: replay a workflow turn and publish its {@link WorkflowDecision} on `${P}-decisions`
   *  (job `decision`) — the queue the engine's `onDecision` consumes. An unknown workflow or a turn
   *  that throws still publishes a `failed` decision so the engine settles the run (never hangs). */
  async #runWorkflowTask(task: WorkflowTask, sealed = true): Promise<void> {
    let decision: WorkflowDecision;
    try {
      const turn = this.#workflowTurns.get(task.workflow);
      decision = turn
        ? await withTurnHeartbeat(
            task,
            (beat) => this.heartbeat(beat, sealed),
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
      // A turn handler is expected to be pure (it returns a `failed` decision rather than throwing), so
      // reaching here is unusual — publish a failed decision anyway so the run settles.
      this.#onError(err);
      decision = {
        taskId: task.taskId,
        runId: task.runId,
        status: 'failed',
        commands: [],
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    }
    // Handed back on shutdown: the broker already redelivers this turn elsewhere.
    if (this.#wasHandedBack(task)) return;
    try {
      await this.#queue(decisionsName(this.#effectivePrefix())).add(
        'decision',
        sealed ? await this.#messages.seal('decision', decision) : decision,
        jobOptions(),
      );
    } catch (err) {
      // The decisions-queue publish threw (Redis blipped). Rethrow so the job is marked `failed` and the
      // engine re-drives the turn on recovery rather than the run hanging awaiting a decision.
      this.#onError(err);
      throw err;
    }
  }

  /** Run one step and publish its result. Resolves `true` when the step completed. */
  async #runTask(task: RemoteTask, sealed = true): Promise<boolean> {
    let result: StepResult;
    try {
      result = await this.#withStepTimeout(
        task,
        runStepHandler(
          task,
          this.#handlers.get(task.name),
          (beat) => this.heartbeat(beat, sealed),
          this.#shutdown.signal,
        ),
      );
    } catch (err) {
      // runStepHandler is pure (a handler throw becomes a failed StepResult), so reaching here is a
      // bug — guard anyway so a future refactor can't turn it into an unsettled `pending` checkpoint.
      this.#onError(err);
      result = {
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        status: 'failed',
        error: {
          message: 'remote step worker failed: handler threw unexpectedly',
          retryable: true,
        },
      };
    }
    // Handed back on shutdown: the broker already redelivers this step elsewhere.
    if (this.#wasHandedBack(task)) return false;
    try {
      await this.#publishResult(result, task.replyTo, sealed);
      return result.status === 'completed';
    } catch (err) {
      // The results-queue publish itself threw (e.g. Redis blipped). We still hold `task`, so
      // rethrow so the BullMQ job is marked `failed` and the terminal-failure bridge + durable retry
      // become the last line of defence rather than the run hanging on `pending`.
      this.#onError(err);
      throw err;
    }
  }

  /**
   * Race a step handler against {@link BullMQTransportOptions.stepTimeoutMs}. At the ceiling, resolve
   * with a RETRYABLE failed StepResult and abandon the still-pending handler (a wedged await cannot be
   * cancelled from outside; what matters is that the run stops waiting on it). A rejection settles
   * through the caller's catch, as before. No ceiling configured: pass-through.
   */
  #withStepTimeout(task: RemoteTask, run: Promise<StepResult>): Promise<StepResult> {
    const ms = this.#stepTimeoutMs;
    if (ms === undefined) return run;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ceiling = new Promise<StepResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            runId: task.runId,
            seq: task.seq,
            stepId: task.stepId,
            status: 'failed',
            error: {
              message: `remote step worker failed: step exceeded stepTimeoutMs (${ms}ms), presumed wedged`,
              retryable: true,
            },
          }),
        ms,
      );
      timer.unref?.();
    });
    return Promise.race([run, ceiling]).finally(() => clearTimeout(timer));
  }

  /** Worker side: publish a liveness heartbeat for an in-flight long step on the `${P}-heartbeat`
   *  pub/sub channel (resets the engine's `timeoutMs` window on whichever pod is awaiting it). */
  async heartbeat(beat: Heartbeat, sealed = true): Promise<void> {
    if (!this.#heartbeatPub) this.#heartbeatPub = this.#deps.makeRedis();
    await this.#heartbeatPub.publish(
      heartbeatChannel(this.#effectivePrefix()),
      JSON.stringify(sealed ? await this.#messages.seal('heartbeat', beat) : beat),
    );
  }

  /** Publish a synthetic FAILED StepResult for a task that failed at the infrastructure level (see the
   *  `handle()` bridge). Correlated purely by runId/seq/stepId (StepResult has no `name`). Best-effort. */
  async #bridgeTaskFailure(identity: TaskIdentity, reason: string, sealed = true): Promise<void> {
    const result = infrastructureFailure(identity, reason);
    try {
      await this.#queue(resultsName(this.#effectivePrefix())).add(
        'result',
        sealed ? await this.#messages.seal('result', result) : result,
        resultJobOptions(),
      );
    } catch (err) {
      this.#onError(err); // best-effort — the engine's reconcile path is the last resort
    }
  }

  // ---------------------------------------------------------------------------
  // worker → engine — the engine consumes results / decisions / step events / heartbeats
  // ---------------------------------------------------------------------------

  onResult(handler: (result: StepResult) => Promise<void>): void {
    if (this.#resultsWorker) return;
    this.#resultHandlers.add(handler);
    this.#resultBatchesWorker = this.#makeWorker(
      resultBatchesName(this.#effectivePrefix()),
      async (job) => {
        const { results } = job.data as { results: StepResult[] };
        await Promise.all(
          results.map(async (raw) => {
            const result = await this.#openOrDrop<StepResult>('result', raw);
            if (result) await handler(result);
          }),
        );
      },
      { concurrency: this.#resultConcurrency },
    );
    this.#resultBatchesWorker.on('failed', (job, err) => {
      if (!job || (job.attemptsMade ?? 0) < (job.opts?.attempts ?? 1)) return;
      const results = (job.data as { results?: unknown[] } | null | undefined)?.results ?? [];
      const giveUp = new Error(
        `gave up on a batch of ${results.length} step results after ${job.attemptsMade} attempts: ${err.message}`,
        { cause: err },
      );
      if (this.#hasOnError) this.#onError(giveUp);
      else console.error(`[adonis-durable] ${giveUp.message}`);
    });
    this.#resultsWorker = this.#makeWorker(
      resultsName(this.#effectivePrefix()),
      async (job) => {
        const result = await this.#openOrDrop<StepResult>('result', job.data);
        if (result) await handler(result);
      },
      { concurrency: this.#resultConcurrency },
    );
    this.#resultsWorker.on('failed', (job, err) => {
      if (!job || (job.attemptsMade ?? 0) < (job.opts?.attempts ?? 1)) return;
      const data = job.data as Partial<StepResult> | null | undefined;
      const giveUp = new Error(
        `gave up on the result of step ${data?.stepId ?? '?'} (run ${data?.runId ?? '?'}) after ${job.attemptsMade} attempts: ${err.message}`,
        { cause: err },
      );
      if (this.#hasOnError) this.#onError(giveUp);
      else console.error(`[adonis-durable] ${giveUp.message}`);
    });
  }

  // --- Reply routing ------------------------------------------------------------------------------
  // A task carrying `replyTo` asks for its result back on `<P>-results-to-<replyTo>`, a queue only
  // that engine instance consumes, while its alive key (`<P>:reply-alive:<id>`, refreshed every third
  // of `replyAliveTtlMs`) exists. Every instance that consumed or was sent a routed reply is
  // remembered in `<P>:reply-instances`; any transport that routes replies sweeps that set and moves
  // the queue of an instance whose key lapsed onto the shared results, stalled jobs included (BullMQ's
  // stalled check hands a dead consumer's job to the next worker on that queue).

  /** The connection reply routing uses, or `undefined` when routing is off or the client lacks it. */
  #replyRedis():
    | (RedisLike & Required<Pick<RedisLike, 'exists' | 'del' | 'sadd' | 'srem' | 'smembers'>>)
    | undefined {
    if (!this.#replyRouting) return undefined;
    this.#replyRedisClient ??= this.#deps.makeRedis();
    const r = this.#replyRedisClient;
    if (!r.exists || !r.del || !r.sadd || !r.srem || !r.smembers) return undefined;
    return r as RedisLike &
      Required<Pick<RedisLike, 'exists' | 'del' | 'sadd' | 'srem' | 'smembers'>>;
  }

  /** Run `start` now, or once consumers start (see {@link deferConsumers}). */
  #whenConsuming(start: () => void): void {
    if (this.#consumersDeferred) this.#deferredWorkers.push(start);
    else start();
  }

  /** A results-queue job's results: one `result`, or a `results` batch. */
  #resultsOf(job: JobLike): StepResult[] {
    // A batch is recognized by its shape too: a fake job may carry no name.
    const data = job.data as { results?: StepResult[] } | StepResult;
    return job.name === 'results' || (job.name === undefined && 'results' in data)
      ? ((data as { results: StepResult[] }).results ?? [])
      : [data as StepResult];
  }

  /**
   * Engine side: consume the results routed to engine instance `replyTo`, keep its alive key fresh,
   * and sweep dead instances' reply queues. Once per transport. Resolves whether replies are routed
   * here (`false` with `replyRouting: false`, or a Redis client without the keys it needs). A process
   * whose consumers are deferred announces nothing until they start: until then its tasks' results
   * ride the shared queue.
   */
  consumeRepliesFor(replyTo: string): boolean {
    if (this.#replyId !== undefined) return this.#replyId === replyTo;
    const redis = this.#replyRedis();
    if (!redis || this.#resultHandlers.size === 0) return false;
    this.#replyId = replyTo;
    const prefix = this.#effectivePrefix();
    this.#replyWorker = this.#makeWorker(
      replyQueueName(prefix, replyTo),
      (job) => this.#handleResultJob(job),
      { concurrency: this.#resultConcurrency },
    );
    this.#replyWorker.on('failed', (job, err) => {
      if (!job || (job.attemptsMade ?? 0) < (job.opts?.attempts ?? 1)) return;
      const giveUp = new Error(
        `gave up on a routed step result after ${job.attemptsMade} attempts: ${err.message}`,
        { cause: err },
      );
      if (this.#hasOnError) this.#onError(giveUp);
      else console.error(`[adonis-durable] ${giveUp.message}`);
    });
    this.#whenConsuming(() => {
      if (this.#closing) return;
      const beat = async (): Promise<void> => {
        try {
          await redis.set(replyAliveKey(prefix, replyTo), '1', 'PX', this.#replyAliveTtlMs);
          await redis.sadd(replyInstancesKey(prefix), replyTo);
        } catch {
          // The next beat retries; a lapsed key only sends this instance's results to the shared queue.
        }
      };
      void beat();
      this.#replyBeatTimer = setInterval(
        () => void beat(),
        Math.max(50, Math.floor(this.#replyAliveTtlMs / 3)),
      );
      this.#replyBeatTimer.unref?.();
      this.#startReplySweeper();
    });
    return true;
  }

  /** Hand a results job to every result handler. */
  async #handleResultJob(job: JobLike): Promise<void> {
    const results = await Promise.all(
      this.#resultsOf(job).map((raw) => this.#openOrDrop<StepResult>('result', raw)),
    );
    await Promise.all(
      results.flatMap((result) =>
        result ? [...this.#resultHandlers].map((handler) => handler(result)) : [],
      ),
    );
  }

  /** Whether engine instance `id` is alive to take its routed replies (read at most every second). */
  async #replyAlive(id: string): Promise<boolean> {
    if (id === this.#replyId && this.#replyBeatTimer) return true;
    const known = this.#replyAliveCache.get(id);
    if (known && Date.now() - known.at < 1_000) return known.alive;
    const redis = this.#replyRedis();
    if (!redis) return false;
    const alive = (await redis.exists(replyAliveKey(this.#effectivePrefix(), id))) === 1;
    this.#replyAliveCache.set(id, { alive, at: Date.now() });
    return alive;
  }

  /**
   * Worker side: send `result` to engine instance `replyTo` while it is alive. Resolves `false` to
   * send it to the shared results instead (routing off, the instance gone, or Redis refusing).
   */
  async #publishReply(result: StepResult, replyTo: string): Promise<boolean> {
    if (!this.#replyRouting) return false;
    try {
      if (!(await this.#replyAlive(replyTo))) return false;
    } catch {
      return false;
    }
    // Batched like the shared results: the results that finish while one batch to this instance is
    // being published go out together in the next. A batch that cannot be published goes to the
    // shared results, one result per job.
    const queue = replyQueueName(this.#effectivePrefix(), replyTo);
    let outbox = this.#replyOutboxes.get(queue);
    if (!outbox) {
      outbox = { entries: [], publishing: false };
      this.#replyOutboxes.set(queue, outbox);
    }
    const box = outbox;
    const sent = await new Promise<boolean>((resolve) => {
      box.entries.push({ result, resolve });
      if (!box.publishing) void this.#publishReplyBatches(queue, box);
    });
    if (!sent) return false;
    // A sender also watches for dead engines, so routed results never wait on an engine coming back.
    this.#startReplySweeper();
    return true;
  }

  async #publishReplyBatches(
    queue: string,
    outbox: {
      entries: Array<{ result: StepResult; resolve: (sent: boolean) => void }>;
      publishing: boolean;
    },
  ): Promise<void> {
    outbox.publishing = true;
    try {
      while (outbox.entries.length > 0) {
        const batch = outbox.entries.splice(0, RESULT_BATCH_MAX);
        try {
          await (batch.length === 1
            ? this.#queue(queue).add('result', batch[0]?.result, resultJobOptions())
            : this.#queue(queue).add(
                'results',
                { results: batch.map((entry) => entry.result) },
                resultJobOptions(),
              ));
          for (const entry of batch) entry.resolve(true);
        } catch {
          for (const entry of batch) entry.resolve(false);
        }
      }
    } finally {
      outbox.publishing = false;
    }
  }

  #startReplySweeper(): void {
    if (this.#replySweepTimer || this.#closing || this.#consumersDeferred || !this.#replyRedis()) {
      return;
    }
    this.#replySweepTimer = setInterval(() => {
      if (this.#replySweeping) return;
      this.#replySweeping = true;
      void this.sweepReplyQueues()
        .catch(() => undefined)
        .finally(() => {
          this.#replySweeping = false;
        });
    }, this.#replySweepMs);
    this.#replySweepTimer.unref?.();
  }

  /**
   * Move the reply queue of every engine instance whose alive key lapsed onto the shared results: a
   * drain worker forwards each job (waiting, delayed, or stalled under the dead consumer) there. Once
   * a dead instance's queue has stayed empty for `replyDrainIdleMs` (past BullMQ's stalled check, and
   * past any sender's cached view of the instance), it is forgotten. Runs on its own every
   * `replySweepMs` on a transport that routes replies; exposed for tests.
   */
  async sweepReplyQueues(): Promise<void> {
    const redis = this.#replyRedis();
    if (!redis || this.#closing) return;
    const prefix = this.#effectivePrefix();
    for (const id of await redis.smembers(replyInstancesKey(prefix))) {
      if (id === this.#replyId || this.#closing) continue;
      const alive = (await redis.exists(replyAliveKey(prefix, id))) === 1;
      const drain = this.#replyDrains.get(id);
      if (alive) {
        if (drain) {
          this.#replyDrains.delete(id);
          await drain.worker.close().catch(() => undefined);
        }
        continue;
      }
      if (!drain) {
        const worker = this.#deps.makeWorker(replyQueueName(prefix, id), async (job) => {
          await Promise.all(
            this.#resultsOf(job).map((result) =>
              this.#queue(resultsName(prefix)).add('result', result, resultJobOptions()),
            ),
          );
        });
        this.#replyDrains.set(id, { worker });
        continue;
      }
      const counts = await this.#queue(replyQueueName(prefix, id)).getJobCounts(
        'waiting',
        'wait',
        'active',
        'delayed',
        'prioritized',
      );
      const left = Object.values(counts).reduce((sum, n) => sum + n, 0);
      if (left > 0) {
        drain.idleSince = undefined;
        continue;
      }
      drain.idleSince ??= Date.now();
      if (Date.now() - drain.idleSince < this.#replyDrainIdleMs) continue;
      this.#replyDrains.delete(id);
      await drain.worker.close().catch(() => undefined);
      // Forgotten only while still dead: an instance that came back re-adds itself on its next beat.
      if ((await redis.exists(replyAliveKey(prefix, id))) === 0) {
        await redis.srem(replyInstancesKey(prefix), id);
      }
    }
  }

  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    // EVERY handler gets every decision. An engine subscribes one stable handler (it applies a decision
    // by run id, dropping any its run no longer awaits); a set keeps a second registration of it, or a
    // second engine sharing this transport, from being lost — keeping only the first handler (an old
    // behaviour) silently dropped decisions, so runs never advanced.
    this.#decisionHandlers.add(handler);
    if (this.#decisionsWorker) return;
    this.#decisionsWorker = this.#makeWorker(
      decisionsName(this.#effectivePrefix()),
      async (job) => {
        const decision = await this.#openOrDrop<WorkflowDecision>('decision', job.data);
        if (!decision) return;
        // Every handler, concurrently; all settle before a failure fails (and retries) the job.
        await fanOutDecision(this.#decisionHandlers, decision, (err) => {
          if (this.#hasOnError) this.#onError(err);
          else console.warn(`[adonis-durable] bullmq decision handler failed: ${String(err)}`);
        });
      },
    );
  }

  /** workflow worker → engine: stream a local step's lifecycle on `${P}-step-events` (job `stepEvent`),
   *  point-to-point so one engine instance checkpoints each once. */
  async dispatchStepEvent(event: WorkflowStepEvent): Promise<void> {
    await this.#queue(stepEventsName(this.#effectivePrefix())).add(
      'stepEvent',
      await this.#messages.seal('stepEvent', event),
      jobOptions(),
    );
  }

  onStepEvent(handler: (event: WorkflowStepEvent) => Promise<void>): void {
    if (this.#stepEventsWorker) return;
    this.#stepEventsWorker = this.#makeWorker(
      stepEventsName(this.#effectivePrefix()),
      async (job) => {
        const event = await this.#openOrDrop<WorkflowStepEvent>('stepEvent', job.data);
        if (event) await handler(event);
      },
    );
  }

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    if (this.#heartbeatSub) return; // one subscription per transport
    const sub = this.#subscriberRedis('heartbeat');
    this.#heartbeatSub = sub;
    swallowSubscribe(
      sub.subscribe(heartbeatChannel(this.#effectivePrefix())),
      () => this.#closing,
      'bullmq heartbeat',
      this.#subscribeErrorSink(),
    );
    sub.on('message', ((_channel: string, payload: string) => {
      let raw: unknown;
      try {
        raw = JSON.parse(payload);
      } catch {
        return; /* ignore malformed heartbeats */
      }
      // The engine's handler writes to the store: report a rejection, never leave it unhandled.
      void this.#openOrDrop<Heartbeat>('heartbeat', raw)
        .then((beat) => (beat ? handler(beat) : undefined))
        .catch((err) => this.#onError(err));
    }) as never);
  }

  // ---------------------------------------------------------------------------
  // worker registry — ONE hash per prefix, `${P}-workers:instances`, one field per writing instance
  // holding every token it serves (see WorkerRegistryOptions). Older readers' keys (the per-instance
  // `${P}-worker-heartbeat:<token>:<instance>` keys and the 1.0.0-rc.31 per-token hashes) are still
  // written, on a slower cadence, while `legacyWrites` is on.
  // ---------------------------------------------------------------------------

  /**
   * The live execution/resource snapshot each heartbeat carries, which lights up the console's worker
   * cards (concurrency mode and live limit, in-flight, RSS/CPU, throughput, p95, last adjustment):
   * the same {@link WorkerStatus} the NestJS fleet stamps.
   */
  #workerStatus(): WorkerStatus {
    return this.#concurrencyController().snapshot();
  }

  /** Refresh EVERY handled routing token's liveness on ONE shared 10s interval until `close()`: one
   *  write of this instance's registry field for all of them, plus the keys older readers read when
   *  those are due (see {@link #writeLegacy}). A newly added token beats immediately, and this
   *  process's own reads see it at once. Best-effort: a failed refresh is reported and otherwise
   *  ignored (the entry then expires, and that gap is the signal). */
  #startWorkerHeartbeat(token: string): void {
    const beat = (tokens: string[], force: boolean): void => {
      const effPrefix = this.#effectivePrefix();
      const value = heartbeatKeyValue(Date.now(), this.#workerStatus());
      // Every token of the instance takes the newest value, so its field holds one group (see
      // encodeInstanceRecord) and costs the same one HSET; only `tokens` get their older keys.
      for (const t of this.#heartbeatTokens) {
        this.#setOwnEntry(
          effPrefix,
          this.#instanceId,
          'heartbeats',
          t,
          value,
          WORKER_HEARTBEAT_TTL_SECONDS,
        );
      }
      void Promise.all([
        this.#scheduleRegistryFlush(),
        this.#writeLegacy(this.#workerRedisClient(), {
          effPrefix,
          instance: this.#instanceId,
          kind: 'heartbeats',
          tokens,
          value,
          ttlSeconds: WORKER_HEARTBEAT_TTL_SECONDS,
          force,
        }),
      ]).catch((err) => this.#onError(err));
    };
    if (!this.#heartbeatTokens.has(token)) {
      this.#heartbeatTokens.add(token);
      beat([token], true);
    }
    if (this.#workerHeartbeatTimer) return;
    this.#workerHeartbeatTimer = setInterval(
      () => beat([...this.#heartbeatTokens], false),
      WORKER_HEARTBEAT_INTERVAL_MS,
    );
    // Don't keep the event loop alive just for the heartbeat.
    this.#workerHeartbeatTimer.unref?.();
  }

  /** Graceful shutdown: drop every registry field this transport wrote and the per-instance keys and
   *  rc.31 hash fields of its own heartbeats, so readers see it leave now rather than at expiry. */
  async #removeOwnHeartbeats(): Promise<void> {
    const tokens = [...this.#heartbeatTokens];
    this.#own.clear();
    const removals: Array<Promise<unknown> | undefined> = [];
    if (this.#hashesSupported()) {
      const client = this.#registryClient() as Required<RegistryCommands> & RedisLike;
      for (const [key, fields] of this.#writtenFields) {
        if (fields.size > 0) removals.push(client.hdel(key, ...fields));
      }
      this.#writtenFields.clear();
    }
    if (tokens.length > 0 && this.#workerRedis) {
      const effPrefix = this.#effectivePrefix();
      const keys = tokens.map((t) => workerHeartbeatKey(effPrefix, t, this.#instanceId));
      removals.push(this.#workerRedis.del?.(...keys));
      removals.push(this.#removeLegacyHashFields(keys));
    }
    await Promise.allSettled(removals);
  }

  /** The client the registry hashes are written to and read from (see `workerRegistry.makeRedis`). */
  #registryClient(): RedisLike {
    if (!this.#makeRegistryRedis) return this.#workerRedisClient();
    if (!this.#registryRedis) this.#registryRedis = this.#makeRegistryRedis();
    return this.#registryRedis;
  }

  /** Whether the registry client has the hash and sorted-set commands. One without them (a minimal
   *  client) neither writes nor reads the hashes: liveness and descriptors then come from the
   *  per-instance keys, written on every beat and walked on every read, as before the hashes existed. */
  #hashesSupported(): boolean {
    const c = this.#registryClient();
    return (
      typeof c.hset === 'function' &&
      typeof c.hgetall === 'function' &&
      typeof c.hdel === 'function' &&
      typeof c.pexpire === 'function' &&
      typeof c.zadd === 'function' &&
      typeof c.zrangebyscore === 'function' &&
      typeof c.zremrangebyscore === 'function'
    );
  }

  /** Record (or refresh) one entry this process advertises; the next flush writes it. */
  #setOwnEntry(
    effPrefix: string,
    instance: string,
    kind: WorkerRegistryKind,
    token: string,
    value: string,
    ttlSeconds: number,
  ): void {
    this.#own.set(ownEntryKey(effPrefix, instance, kind, token), {
      effPrefix,
      instance,
      kind,
      token,
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  /** Write this process's registry fields on the next macrotask, so the per-token writes of one beat
   *  (the transport's, or a worker runtime's `Promise.all` of `set`s) become one `HSET` per field. */
  #scheduleRegistryFlush(): Promise<void> {
    if (!this.#registryFlush) {
      this.#registryFlush = new Promise<void>((resolve, reject) => {
        setImmediate(() => {
          this.#registryFlush = undefined;
          this.#flushRegistry().then(resolve, reject);
        });
      });
    }
    return this.#registryFlush;
  }

  /**
   * Write every field this process owns: one per (prefix, instance), each holding all of that
   * instance's live entries grouped by value (a beat's value is the same for every token, so 85 tokens
   * cost one short list, not 85 copies). A field left with no entry is removed. Every
   * {@link INSTANCES_UPKEEP_MS} a hash also gets its TTL refreshed and the expired fields of other
   * writers (a crashed process) deleted.
   */
  async #flushRegistry(): Promise<void> {
    if (!this.#hashesSupported()) return;
    const client = this.#registryClient() as Required<RegistryCommands> & RedisLike;
    const now = Date.now();
    const records = new Map<string, { key: string; field: string; entries: OwnEntry[] }>();
    for (const [id, entry] of this.#own) {
      if (entry.expiresAt <= now) {
        this.#own.delete(id);
        continue;
      }
      const key = workerInstancesKey(entry.effPrefix);
      const field = `${entry.instance}#${this.#registryNonce}`;
      const slot = `${key}\n${field}`;
      const record = records.get(slot) ?? { key, field, entries: [] };
      record.entries.push(entry);
      records.set(slot, record);
    }
    const writes: Promise<unknown>[] = [];
    for (const { key, field, entries } of records.values()) {
      writes.push(client.hset(key, field, encodeInstanceRecord(entries)));
      const fields = this.#writtenFields.get(key) ?? new Set<string>();
      fields.add(field);
      this.#writtenFields.set(key, fields);
    }
    // A field whose every entry was removed (a worker runtime stopped): delete it.
    for (const [key, fields] of this.#writtenFields) {
      const stale = [...fields].filter((f) => !records.has(`${key}\n${f}`));
      if (stale.length === 0) continue;
      for (const f of stale) fields.delete(f);
      writes.push(client.hdel(key, ...stale));
    }
    await Promise.all(writes);
    for (const key of this.#writtenFields.keys()) {
      const last = this.#instancesUpkeepAt.get(key);
      if (last !== undefined && now - last < INSTANCES_UPKEEP_MS) continue;
      this.#instancesUpkeepAt.set(key, now);
      try {
        const [fields] = await Promise.all([
          client.hgetall(key),
          client.pexpire(key, INSTANCES_KEY_TTL_MS),
        ]);
        const expired = Object.entries(fields ?? {})
          .filter(([, raw]) => (decodeInstanceRecord(raw)?.expiresAt ?? 0) <= now)
          .map(([f]) => f);
        if (expired.length > 0) await client.hdel(key, ...expired);
      } catch (err) {
        this.#instancesUpkeepAt.delete(key); // the next flush tries again
        throw err;
      }
    }
  }

  /**
   * For readers on 1.0.0-rc.31 and older (and the NestJS / Python fleet, which read the same keys):
   * the per-instance key of each token (`SET … EX`) and, with hash commands, its field in the rc.31
   * per-token hash. With hash commands they are written at most once per `legacyWriteIntervalMs` per
   * key (a changed descriptor, or `force`, at once) and live three intervals; `legacyWrites: false`
   * skips them. Without hash commands the keys are the whole registry, so they are written on every
   * call with the caller's TTL, as before.
   */
  async #writeLegacy(
    client: Pick<RedisLike, 'set'>,
    w: {
      effPrefix: string;
      instance: string;
      kind: WorkerRegistryKind;
      tokens: string[];
      value: string;
      ttlSeconds: number;
      force: boolean;
    },
  ): Promise<void> {
    const hashes = this.#hashesSupported();
    if (hashes && !this.#legacyWrites) return;
    const now = Date.now();
    const ttlSeconds = hashes
      ? Math.max(w.ttlSeconds, Math.ceil((3 * this.#legacyWriteIntervalMs) / 1000))
      : w.ttlSeconds;
    const due: string[] = [];
    for (const token of w.tokens) {
      const key = perInstanceKey(w.effPrefix, w.kind, token, w.instance);
      const last = this.#legacyWrittenAt.get(key);
      const stale =
        !last ||
        now - last.at >= this.#legacyWriteIntervalMs ||
        (w.kind === 'descriptors' && last.value !== w.value);
      if (!hashes || w.force || stale) due.push(token);
    }
    if (due.length === 0) return;
    const keys = due.map((t) => perInstanceKey(w.effPrefix, w.kind, t, w.instance));
    for (const key of keys) this.#legacyWrittenAt.set(key, { at: now, value: w.value });
    try {
      await Promise.all(keys.map((key) => client.set(key, w.value, 'EX', ttlSeconds)));
      if (hashes) {
        await Promise.all(
          due.map((t) =>
            this.#registryWrite(w.effPrefix, w.kind, t, w.instance, w.value, ttlSeconds),
          ),
        );
      }
    } catch (err) {
      for (const key of keys) this.#legacyWrittenAt.delete(key); // the next beat tries again
      throw err;
    }
  }

  /**
   * Write `instance`'s entry into `token`'s rc.31 registry hash of `kind`, live for `ttlSeconds`: the
   * value is `{ expiresAt, value }` and rc.31 readers skip an entry past `expiresAt`. A new field, and
   * otherwise every {@link LEGACY_HASH_UPKEEP_MS}, also refreshes the hash's TTL and its token's
   * index entry (see {@link #legacyHashUpkeep}).
   */
  async #registryWrite(
    effPrefix: string,
    kind: WorkerRegistryKind,
    token: string,
    instance: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    const client = this.#registryClient() as Required<RegistryCommands> & RedisLike;
    const now = Date.now();
    const key = workerRegistryHashKey(effPrefix, kind, token);
    const added = await client.hset(
      key,
      instance,
      JSON.stringify({ expiresAt: now + ttlSeconds * 1000, value }),
    );
    const last = this.#registryUpkeepAt.get(key);
    if (added > 0 || last === undefined || now - last.at >= LEGACY_HASH_UPKEEP_MS) {
      const prune = last === undefined || now - last.prunedAt >= LEGACY_HASH_PRUNE_MS;
      this.#registryUpkeepAt.set(key, { at: now, prunedAt: prune ? now : last.prunedAt });
      try {
        await this.#legacyHashUpkeep(client, effPrefix, key, token, now, prune);
      } catch (err) {
        this.#registryUpkeepAt.delete(key); // the next write tries again
        throw err;
      }
    }
  }

  /**
   * Keep an rc.31 hash bounded: its TTL and its token's index score move to
   * {@link LEGACY_HASH_TTL_MS} from now (so a token nobody writes any more disappears). Every
   * {@link LEGACY_HASH_PRUNE_MS} the index's past entries and the hash's expired fields are deleted.
   */
  async #legacyHashUpkeep(
    client: Required<RegistryCommands>,
    effPrefix: string,
    key: string,
    token: string,
    now: number,
    prune: boolean,
  ): Promise<void> {
    const index = workerRegistryIndexKey(effPrefix);
    await Promise.all([
      client.pexpire(key, LEGACY_HASH_TTL_MS),
      client.zadd(index, now + LEGACY_HASH_TTL_MS, token),
      client.pexpire(index, LEGACY_HASH_TTL_MS),
    ]);
    if (!prune) return;
    const [fields] = await Promise.all([
      client.hgetall(key),
      client.zremrangebyscore(index, '-inf', now),
    ]);
    const expired = Object.entries(fields ?? {})
      .filter(([, stored]) => liveRegistryValue(stored, now) === undefined)
      .map(([field]) => field);
    if (expired.length > 0) await client.hdel(key, ...expired);
  }

  /** Remove the rc.31 hash fields matching per-instance `keys` (any other key is left alone). */
  async #removeLegacyHashFields(keys: string[]): Promise<void> {
    if (!this.#hashesSupported()) return;
    const client = this.#registryClient() as Required<RegistryCommands> & RedisLike;
    const removals: Promise<unknown>[] = [];
    for (const key of keys) {
      this.#legacyWrittenAt.delete(key);
      const parsed = parseWorkerKey(key);
      if (!parsed) continue;
      removals.push(
        client.hdel(
          workerRegistryHashKey(parsed.effPrefix, parsed.kind, parsed.token),
          parsed.instance,
        ),
      );
    }
    await Promise.all(removals);
  }

  /**
   * The registry entries of this process ({@link #own}) live at `now` under `prefix`. They are read
   * from memory, so an instance always sees what it advertises the moment it does.
   */
  #ownEntries(prefix: string, now: number): RegistrySnapshot {
    const out: RegistrySnapshot = { heartbeats: [], descriptors: [] };
    for (const entry of this.#own.values()) {
      if (entry.effPrefix !== prefix || entry.expiresAt <= now) continue;
      out[entry.kind].push({
        token: entry.token,
        instance: entry.instance,
        raw: entry.value,
        expiresAt: entry.expiresAt,
      });
    }
    return out;
  }

  /**
   * The other writers' entries: ONE `HGETALL` of `${P}-workers:instances`, shared by every reader in
   * the process and reused while it is younger than `maxAgeMs` (concurrent callers join the read in
   * flight). This process's own fields are skipped: {@link #ownEntries} has them. A failed read is not
   * kept; it rejects for every caller that joined it.
   */
  #instancesSnapshot(maxAgeMs: number): Promise<RegistrySnapshot> {
    const prefix = this.#effectivePrefix();
    const last = this.#registrySnapshot?.prefix === prefix ? this.#registrySnapshot : undefined;
    if (last && Date.now() - last.at < maxAgeMs) return Promise.resolve(last.entries);
    const inFlight = this.#registryRead?.prefix === prefix ? this.#registryRead.read : undefined;
    if (inFlight) return inFlight;
    const client = this.#registryClient() as Required<RegistryCommands> & RedisLike;
    const startedAt = Date.now();
    const read = client.hgetall(workerInstancesKey(prefix)).then((fields) => {
      const entries = decodeInstancesHash(fields ?? {}, `#${this.#registryNonce}`);
      this.#registrySnapshot = { prefix, at: startedAt, entries };
      return entries;
    });
    const slot = { prefix, read };
    this.#registryRead = slot;
    const clear = () => {
      if (this.#registryRead === slot) this.#registryRead = undefined;
    };
    read.then(clear, clear);
    return read;
  }

  /**
   * Every live registry entry: this process's own, the other writers' fields (at most `maxAgeMs` old,
   * `0` for a fresh read) and the per-instance keys of writers that only write those (see
   * {@link #legacyEntries}). The first entry for a (token, instance) wins, in that order. Without
   * hash commands it is the walk alone, plus this process's own entries.
   */
  async #registryEntries(maxAgeMs: number): Promise<RegistrySnapshot> {
    const prefix = this.#effectivePrefix();
    if (!this.#hashesSupported()) {
      const legacy = await this.#legacyEntries(maxAgeMs === 0);
      const own = this.#ownEntries(prefix, Date.now());
      return {
        heartbeats: mergeEntries(own.heartbeats, legacy.heartbeats),
        descriptors: mergeEntries(own.descriptors, legacy.descriptors),
      };
    }
    const [hashed, legacy] = await Promise.all([
      this.#instancesSnapshot(maxAgeMs),
      this.#legacyEntries(),
    ]);
    const now = Date.now();
    const own = this.#ownEntries(prefix, now);
    const live = (e: RegistryEntry) => e.expiresAt === undefined || e.expiresAt > now;
    // A walk is up to a walk interval old: keep a walked beat that was live at the walk.
    const keepWalked = (e: RegistryEntry) => {
      const { lastBeatAt } = parseHeartbeatValue(e.raw);
      return (
        lastBeatAt === 0 ||
        now - lastBeatAt < WORKER_HEARTBEAT_TTL_SECONDS * 1000 + this.#legacyScanIntervalMs
      );
    };
    return {
      heartbeats: mergeEntries(
        mergeEntries(own.heartbeats, hashed.heartbeats.filter(live)),
        legacy.heartbeats,
        keepWalked,
      ),
      descriptors: mergeEntries(
        mergeEntries(own.descriptors, hashed.descriptors.filter(live)),
        legacy.descriptors,
      ),
    };
  }

  /**
   * The per-instance keys, for writers that do not write the instances hash (an older version, the
   * NestJS or Python SDK): ONE SCAN walk collects heartbeats and descriptors alike, shared by every
   * reader in this process, and starts at most once per `legacyScanIntervalMs`. After the first walk,
   * readers get the last walk at once while a due walk runs in the background. With `legacyScan:
   * false` there is no walk. A client without hash commands has nothing else to read, so it walks on
   * every read, reused for {@link WORKER_HEARTBEAT_READ_TTL_MS}, a failed walk fails the read, and
   * `fresh` walks again. With hashes a failed walk is reported and keeps the previous walk's keys,
   * and `fresh` does not start a walk.
   */
  #legacyEntries(fresh = false): Promise<RegistrySnapshot> {
    const hashes = this.#hashesSupported();
    if (hashes && !this.#legacyScan) return Promise.resolve(EMPTY_REGISTRY);
    const prefix = this.#effectivePrefix();
    const interval = hashes ? this.#legacyScanIntervalMs : WORKER_HEARTBEAT_READ_TTL_MS;
    const last = this.#legacyRead?.prefix === prefix ? this.#legacyRead : undefined;
    // `fresh` only skips the reuse when the walk is the whole read; it never adds a throttled walk.
    const reusable = last && !(fresh && !hashes) && Date.now() - last.at < interval;
    if (last && reusable) return Promise.resolve(last.snapshot);
    let pending = this.#legacyInFlight?.prefix === prefix ? this.#legacyInFlight.read : undefined;
    if (!pending) {
      const startedAt = Date.now();
      const read = this.#walkLegacyKeys(prefix, hashes ? LEGACY_SCAN_COUNT : SCAN_COUNT).then(
        (snapshot) => {
          this.#legacyRead = { prefix, at: startedAt, snapshot };
          return snapshot;
        },
        (err: unknown) => {
          // Without hashes the walk is the whole read: fail it, uncached, as a read always failed.
          if (!hashes) throw err;
          this.#onError(err);
          const snapshot = last?.snapshot ?? EMPTY_REGISTRY;
          this.#legacyRead = { prefix, at: startedAt, snapshot };
          return snapshot;
        },
      );
      const slot = { prefix, read };
      this.#legacyInFlight = slot;
      const clear = () => {
        if (this.#legacyInFlight === slot) this.#legacyInFlight = undefined;
      };
      read.then(clear, clear);
      pending = read;
    }
    if (last && hashes) return Promise.resolve(last.snapshot);
    return pending;
  }

  /** One SCAN walk of `${P}-worker-*`, MGET per page, sorted into heartbeat and descriptor entries. */
  async #walkLegacyKeys(prefix: string, count: number): Promise<RegistrySnapshot> {
    const heartbeatAt = workerHeartbeatKeyPrefix(prefix);
    const descriptorAt = `${prefix}-worker-descriptor:`;
    const snapshot: RegistrySnapshot = { heartbeats: [], descriptors: [] };
    await this.#scanValues(
      this.#workerRedisClient(),
      legacyWorkerKeysPrefix(prefix),
      count,
      (key, raw) => {
        if (raw == null) return; // expired between the SCAN and the MGET
        const kind: WorkerRegistryKind | undefined = key.startsWith(heartbeatAt)
          ? 'heartbeats'
          : key.startsWith(descriptorAt)
            ? 'descriptors'
            : undefined;
        if (!kind) return;
        const rest = key.slice((kind === 'heartbeats' ? heartbeatAt : descriptorAt).length);
        const sep = rest.indexOf(':');
        snapshot[kind].push({
          token: sep === -1 ? rest : rest.slice(0, sep),
          instance: sep === -1 ? '' : rest.slice(sep + 1),
          raw,
        });
      },
    );
    return snapshot;
  }

  /** Distinct routing tokens with a live worker heartbeat, from the shared registry read. */
  async listWorkerGroups(): Promise<string[]> {
    const { heartbeats } = await this.#registryEntries(REGISTRY_READ_MAX_AGE_MS);
    const groups = new Set<string>();
    for (const { token } of heartbeats) if (token) groups.add(token);
    return [...groups];
  }

  /** Parsed descriptors by raw value: the same few values are read before every dispatch. */
  readonly #parsedDescriptors = new Map<string, WorkerDescriptor | null>();

  #parseDescriptors(entries: RegistryEntry[]): WorkerDescriptor[] {
    if (this.#parsedDescriptors.size > PARSED_DESCRIPTORS_MAX) this.#parsedDescriptors.clear();
    const out: WorkerDescriptor[] = [];
    for (const { raw } of entries) {
      let parsed = this.#parsedDescriptors.get(raw);
      if (parsed === undefined) {
        try {
          parsed = JSON.parse(raw) as WorkerDescriptor;
        } catch {
          parsed = null; // a malformed descriptor reads as absent (it never blocks routing)
        }
        this.#parsedDescriptors.set(raw, parsed);
      }
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /**
   * The LIVE worker descriptors advertised on `token` (design §7.2), from the shared registry read
   * (at most {@link REGISTRY_READ_MAX_AGE_MS} old). Degrades gracefully to `[]`: an unreadable
   * registry or a malformed value reads as "no descriptors", and the control-plane falls back to legacy
   * assume-compatible dispatch.
   *
   * `fresh` reads the instances hash again: the engine re-reads before it parks a run `blocked`, so a
   * capable worker that joined inside the reuse window is never missed. A read already in flight is
   * joined either way (it started no earlier).
   */
  async listWorkerDescriptors(
    token: string,
    opts?: { fresh?: boolean | undefined },
  ): Promise<WorkerDescriptor[]> {
    try {
      const { descriptors } = await this.#registryEntries(
        opts?.fresh ? 0 : REGISTRY_READ_MAX_AGE_MS,
      );
      return this.#parseDescriptors(descriptors.filter((e) => e.token === token));
    } catch (err) {
      // An unreadable registry degrades to "no descriptors" — the engine then dispatches legacy
      // assume-compatible rather than parking every run.
      this.#onError(err);
      return [];
    }
  }

  /** Every live descriptor on every token, from the shared registry read. Degrades to `[]`
   *  (reported through `onError`) when unreadable. */
  async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
    try {
      const { descriptors } = await this.#registryEntries(REGISTRY_READ_MAX_AGE_MS);
      return this.#parseDescriptors(descriptors);
    } catch (err) {
      this.#onError(err);
      return [];
    }
  }

  /** Every live worker heartbeat on every token, from the shared registry read. Degrades to `[]`. */
  async readAllWorkerHeartbeats(): Promise<WorkerHeartbeat[]> {
    try {
      const { heartbeats } = await this.#registryEntries(REGISTRY_READ_MAX_AGE_MS);
      return heartbeats.filter((e) => e.instance !== '').map(toWorkerHeartbeat);
    } catch (err) {
      this.#onError(err);
      return [];
    }
  }

  /** SCAN every key under `prefix` (never KEYS) and hand each key and its value to `visit`. */
  async #scanValues(
    client: RedisLike,
    prefix: string,
    count: number,
    visit: (key: string, raw: string | null) => void,
  ): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', count);
      cursor = next;
      if (keys.length === 0) continue;
      const raws = client.mget
        ? await client.mget(...keys)
        : await Promise.all(keys.map((k) => client.get(k)));
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        if (key !== undefined) visit(key, raws[i] ?? null);
      }
    } while (cursor !== '0');
  }

  /** Per-group worker-health: queue depth (waiting+active+delayed+prioritized) + live workers. `group`
   *  is a routing token — the same value a dispatch targets. The job counts and the shared registry
   *  read run concurrently. */
  async groupHealth(group: string): Promise<GroupHealth> {
    if (this.#taskQueues === 'grouped') return this.#groupedHealth(group);
    const [counts, liveWorkers] = await Promise.all([
      this.#queue(tasksName(this.#effectivePrefix(), group)).getJobCounts(
        'waiting',
        'active',
        'delayed',
        'prioritized',
      ),
      this.#listLiveWorkers(group),
    ]);
    const depth = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
    return { group, depth, liveWorkers };
  }

  /**
   * {@link groupHealth} on the grouped layout: the token's share of its partition's queue, read from
   * one sample of that queue's jobs that every token asking within {@link GROUPED_SNAPSHOT_TTL_MS}
   * reuses, plus its per-handler queue while that queue is being drained. `queue` / `queueDepth`
   * name the shared queue and its total; `depthSampled` says the sample did not cover every job.
   */
  async #groupedHealth(group: string): Promise<GroupHealth> {
    const prefix = this.#effectivePrefix();
    const name = groupedTasksName(prefix, group);
    const legacy = tasksName(prefix, group);
    const [snapshot, legacyDepth, liveWorkers] = await Promise.all([
      this.#groupedSnapshot(name),
      this.#drainWorkers.has(legacy) ? this.#queueDepth(legacy) : Promise.resolve(0),
      this.#listLiveWorkers(group),
    ]);
    return {
      group,
      depth: (snapshot.byToken.get(group) ?? 0) + legacyDepth,
      liveWorkers,
      queue: name,
      queueDepth: snapshot.total,
      ...(snapshot.sampled ? { depthSampled: true } : {}),
      ...(legacyDepth > 0 ? { drainingDepth: legacyDepth } : {}),
    };
  }

  async #queueDepth(name: string): Promise<number> {
    const counts = await this.#queue(name).getJobCounts(
      'waiting',
      'active',
      'delayed',
      'prioritized',
    );
    return Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
  }

  #groupedSnapshot(name: string): Promise<GroupedSnapshot> {
    const cached = this.#groupedSnapshots.get(name);
    if (cached && Date.now() - cached.at < GROUPED_SNAPSHOT_TTL_MS) return cached.read;
    const read = (async (): Promise<GroupedSnapshot> => {
      const queue = this.#queue(name);
      const total = await this.#queueDepth(name);
      const byToken = new Map<string, number>();
      if (total === 0) return { total, byToken, sampled: false };
      if (!queue.getJobs) return { total, byToken, sampled: true };
      const jobs = await queue.getJobs(
        ['waiting', 'active', 'delayed', 'prioritized'],
        0,
        GROUPED_DEPTH_SAMPLE - 1,
      );
      let counted = 0;
      for (const job of jobs) {
        const token = (job?.data as { group?: unknown } | undefined)?.group;
        if (typeof token !== 'string') continue;
        byToken.set(token, (byToken.get(token) ?? 0) + 1);
        counted += 1;
      }
      return { total, byToken, sampled: counted < total };
    })();
    this.#groupedSnapshots.set(name, { at: Date.now(), read });
    read.catch(() => this.#groupedSnapshots.delete(name));
    return read;
  }

  async #listLiveWorkers(group: string): Promise<WorkerHeartbeat[]> {
    const { heartbeats } = await this.#registryEntries(REGISTRY_READ_MAX_AGE_MS);
    return heartbeats.filter((e) => e.token === group && e.instance !== '').map(toWorkerHeartbeat);
  }

  // ---------------------------------------------------------------------------
  // P4 — store-less read/control/start protocol (spec §6.2, §8)
  //
  // start-run & run-request ride BullMQ QUEUES (durable, single consumer on the control plane); the DTO
  // is the raw job data (no envelope), job name `startRun`/`runRequest`, options `jobOptions()`
  // (removeOnComplete/removeOnFail: true) — byte-identical to aviary. run-reply & tenant-events ride
  // Redis PUB/SUB (fan-out) over the transport's own `makeRedis()` clients — the SAME substrate the
  // shipped `RedisControlPlane` uses (spec §6 note: fan-out "rides the shared ControlPlane pub/sub"),
  // kept on the transport so the whole P4 wire surface is one cohesive object and every channel name
  // lives with the rest of the naming contract in `naming.ts`.
  // ---------------------------------------------------------------------------

  /**
   * engine → engines: enqueue runs on `${P}-runs` (job `run`), {@link RUN_ADD_BULK_CHUNK} per
   * `addBulk`. A `start` with a key carries a job id derived from its run id and key
   * ({@link runStartJobId}), so a start re-sent for the same pending state is not queued twice; a new
   * key (the run went `pending` again) is a new job even while the earlier one is active. A `wake`
   * carries none: a wake that lands while an earlier one is being processed must not be dropped.
   */
  async dispatchRuns(
    runs: readonly RunDispatch[],
    opts?: { namespace?: string | undefined },
  ): Promise<void> {
    if (runs.length === 0) return;
    const queue = this.#queue(this.#runsQueueName(opts?.namespace));
    const jobs = runs.map((run) => ({
      name: 'run',
      data: run satisfies RunDispatch,
      opts:
        run.reason === 'start' && run.key !== undefined
          ? { ...jobOptions(run.priority), jobId: runStartJobId(run.runId, run.key) }
          : jobOptions(run.priority),
    }));
    for (let at = 0; at < jobs.length; at += RUN_ADD_BULK_CHUNK) {
      const chunk = jobs.slice(at, at + RUN_ADD_BULK_CHUNK);
      if (queue.addBulk) await queue.addBulk(chunk);
      else await Promise.all(chunk.map((job) => queue.add(job.name, job.data, job.opts)));
    }
  }

  /** `${P}-runs` of `namespace` (absent: this transport's own namespace). */
  #runsQueueName(namespace: string | undefined): string {
    return runsName(effectivePrefix(this.#prefix, namespace ?? this.#namespace));
  }

  /**
   * engine ← run queue: consume `${P}-runs` of `opts.namespace`, `opts.concurrency` jobs at once,
   * handing each run to `handler`. A second call for the same queue returns the first one's stop.
   * The stop closes the worker: BullMQ fetches nothing more and waits for the jobs in flight.
   */
  onDispatchedRun(
    handler: (run: RunDispatch) => Promise<void>,
    opts: { concurrency: number; namespace?: string | undefined },
  ): () => Promise<void> {
    const name = this.#runsQueueName(opts.namespace);
    const existing = this.#runsWorkers.get(name);
    if (existing) return existing.stop;
    const worker = this.#makeWorker(name, (job) => handler(job.data as RunDispatch), {
      concurrency: workerConcurrency(opts.concurrency),
    });
    let stopped: Promise<void> | undefined;
    const stop = () => {
      stopped ??= worker.close().then(
        () => undefined,
        () => undefined,
      );
      return stopped;
    };
    this.#runsWorkers.set(name, { worker, stop });
    return stop;
  }

  /** tenant → control plane: enqueue a {@link StartRunMessage} on `${P}-start-run` (job `startRun`). */
  async dispatchStartRun(msg: StartRunMessage): Promise<void> {
    await this.#queue(startRunName(this.#effectivePrefix())).add(
      'startRun',
      await this.#messages.seal('startRun', msg),
      jobOptions(),
    );
  }

  /** control plane ← tenant: consume {@link StartRunMessage}s. Idempotent — a second call is a no-op. */
  onStartRun(handler: (msg: StartRunMessage) => Promise<void>): void {
    if (this.#startRunWorker) return;
    this.#startRunWorker = this.#makeWorker(startRunName(this.#effectivePrefix()), async (job) => {
      const msg = await this.#openOrDrop<StartRunMessage>('startRun', job.data);
      if (!msg) return;
      this.#notePlainRequest(job.data, msg.runId);
      await handler(msg);
    });
  }

  /** tenant → control plane: enqueue a {@link RunRequest} on `${P}-run-request` (job `runRequest`). */
  async dispatchRunRequest(msg: RunRequest): Promise<void> {
    await this.#queue(runRequestName(this.#effectivePrefix())).add(
      'runRequest',
      await this.#messages.seal('runRequest', msg),
      jobOptions(),
    );
  }

  /** control plane ← tenant: consume {@link RunRequest}s. Idempotent — a second call is a no-op. */
  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void {
    if (this.#runRequestWorker) return;
    this.#runRequestWorker = this.#makeWorker(
      runRequestName(this.#effectivePrefix()),
      async (job) => {
        const msg = await this.#openOrDrop<RunRequest>('runRequest', job.data);
        if (!msg) return;
        this.#notePlainRequest(job.data, msg.requestId);
        await handler(msg);
      },
    );
  }

  /** control plane → tenant: publish a correlated {@link RunReply} on `${P}-run-reply` (pub/sub). */
  async publishRunReply(reply: RunReply): Promise<void> {
    if (!this.#runReplyPub) this.#runReplyPub = this.#deps.makeRedis();
    await this.#runReplyPub.publish(
      runReplyChannel(this.#effectivePrefix()),
      JSON.stringify(
        this.#plainRequests.delete(reply.requestId)
          ? reply
          : await this.#messages.seal('runReply', reply),
      ),
    );
  }

  /** tenant ← control plane: consume {@link RunReply}s (the proxy filters by `requestId`). Idempotent. */
  onRunReply(handler: (reply: RunReply) => void): void {
    if (this.#runReplyHandler) return; // one handler per transport
    this.#runReplyHandler = handler;
    this.#ensureRunReplySub();
  }

  /** The run-reply handler (the tenant's gateway), if any. */
  #runReplyHandler: ((reply: RunReply) => void) | undefined;

  /** Subscribe to run replies (once): for the gateway, and for this pod's message-key request. */
  #ensureRunReplySub(): void {
    if (this.#runReplySub) return; // one subscription per transport
    const channel = runReplyChannel(this.#effectivePrefix());
    const sub = this.#subscriberRedis('run-reply');
    this.#runReplySub = sub;
    swallowSubscribe(
      sub.subscribe(channel),
      () => this.#closing,
      'bullmq run-reply',
      this.#subscribeErrorSink(),
    );
    sub.on('message', ((msgChannel: string, payload: string) => {
      // Filter by channel: a shared pub/sub connection may also carry other channels' messages.
      if (msgChannel !== channel) return;
      let raw: unknown;
      try {
        raw = JSON.parse(payload);
      } catch {
        return; /* ignore malformed run replies */
      }
      void this.#openOrDrop<RunReply>('runReply', raw)
        .then((reply) => {
          if (!reply || this.#messages.takeReply?.(reply)) return;
          this.#runReplyHandler?.(reply);
        })
        .catch(() => undefined);
    }) as never);
  }

  /** control plane → tenant: re-publish a lifecycle {@link TenantEvent} on `${P}-tenant-events-<tenant>`. */
  async publishTenantEvent(evt: TenantEvent): Promise<void> {
    if (!this.#tenantEventPub) this.#tenantEventPub = this.#deps.makeRedis();
    const sealed = await this.#messages.seal('tenantEvent', evt);
    // Sealed events go on a channel of their own: a pod not upgraded yet never hears them (it would
    // read an event it cannot open as one with no run), and misses them instead.
    const channel = tenantEventsChannel(this.#effectivePrefix(), evt.tenant);
    await this.#tenantEventPub.publish(
      isSealedMessage(sealed) ? sealedChannel(channel) : channel,
      JSON.stringify(sealed),
    );
  }

  /**
   * tenant ← control plane: subscribe to THIS tenant's event channel. Returns an unsubscribe fn that
   * detaches only this handler (the shared subscriber connection and channel subscription stay for any
   * other listeners; both are torn down in {@link close}). Several tenants — or several callers for one
   * tenant — may subscribe independently, each routed by channel through the ONE shared subscriber.
   */
  onTenantEvent(tenant: string, handler: (evt: TenantEvent) => void): () => void {
    const channel = tenantEventsChannel(this.#effectivePrefix(), tenant);
    const sub = this.#tenantEventSubscriber();
    if (!this.#tenantEventChannels.has(channel)) {
      this.#tenantEventChannels.add(channel);
      for (const name of [channel, sealedChannel(channel)]) {
        swallowSubscribe(
          sub.subscribe(name),
          () => this.#closing,
          'bullmq tenant-event',
          this.#subscribeErrorSink(),
        );
      }
    }
    let handlers = this.#tenantEventHandlers.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.#tenantEventHandlers.set(channel, handlers);
    }
    handlers.add(handler);
    return () => {
      this.#tenantEventHandlers.get(channel)?.delete(handler);
    };
  }

  /** The ONE shared tenant-events subscriber, created lazily with a single channel-routing listener. */
  #tenantEventSubscriber(): RedisLike {
    if (this.#tenantEventSub) return this.#tenantEventSub;
    const sub = this.#subscriberRedis('tenant-event');
    this.#tenantEventSub = sub;
    sub.on('message', ((rawChannel: string, payload: string) => {
      const msgChannel = rawChannel.endsWith(SEALED_SUFFIX)
        ? rawChannel.slice(0, -SEALED_SUFFIX.length)
        : rawChannel;
      const handlers = this.#tenantEventHandlers.get(msgChannel);
      if (!handlers || handlers.size === 0) return;
      let raw: unknown;
      try {
        raw = JSON.parse(payload);
      } catch {
        return; // ignore malformed tenant events
      }
      void this.#openOrDrop<TenantEvent>('tenantEvent', raw)
        .then((evt) => {
          if (!evt) return;
          for (const h of this.#tenantEventHandlers.get(msgChannel) ?? []) h(evt);
        })
        .catch(() => undefined);
    }) as never);
    return sub;
  }

  // ---------------------------------------------------------------------------
  // shutdown
  // ---------------------------------------------------------------------------

  /** Close all workers/queues and disconnect pub/sub + heartbeat connections so the process can exit. */
  async close(): Promise<void> {
    this.#closing = true;
    // Steps still running get the word first, so a long one can stop before the budget below ends.
    this.#shutdown.abort(new Error('transport closing'));
    this.#controller?.stop();
    if (this.#workerHeartbeatTimer) clearInterval(this.#workerHeartbeatTimer);
    this.#workerHeartbeatTimer = undefined;
    if (this.#pingWatchdogTimer) clearInterval(this.#pingWatchdogTimer);
    this.#pingWatchdogTimer = undefined;
    if (this.#drainTimer) clearInterval(this.#drainTimer);
    this.#drainTimer = undefined;
    if (this.#replyBeatTimer) clearInterval(this.#replyBeatTimer);
    if (this.#replySweepTimer) clearInterval(this.#replySweepTimer);
    // Stop taking routed replies first: with the alive key gone, workers send to the shared results
    // and other instances move what is left on this instance's queue there.
    if (this.#replyId !== undefined && this.#replyBeatTimer && this.#replyRedisClient?.del) {
      await withTimeout(
        this.#replyRedisClient
          .del(replyAliveKey(this.#effectivePrefix(), this.#replyId))
          .catch(() => undefined),
        this.#closeTimeoutMs,
      );
    }
    // This instance stops advertising itself while its workers drain (they take no new jobs).
    const ownHeartbeatsRemoved = this.#removeOwnHeartbeats();
    // Workers first (concurrently with each other), THEN queues: a worker's close() waits for its
    // in-flight job, which publishes its result/decision through a queue, so that queue must still be
    // open until every worker has settled. One shared deadline bounds both phases: a graceful
    // Worker.close() that never settles must not strand the disconnects below.
    const deadline = Date.now() + this.#closeTimeoutMs;
    const remaining = (): number => Math.max(0, deadline - Date.now());
    const workers: Array<Promise<unknown> | undefined> = [
      ...[...this.#taskWorkers.values()].map((w) => w.close()),
      ...[...this.#groupedWorkers.values()].map((g) => g.worker.close()),
      ...[...this.#drainWorkers.values()].map((d) => d.worker.close()),
      this.#resultsWorker?.close(),
      this.#resultBatchesWorker?.close(),
      this.#replyWorker?.close(),
      ...[...this.#replyDrains.values()].map((d) => d.worker.close()),
      this.#decisionsWorker?.close(),
      this.#stepEventsWorker?.close(),
      this.#startRunWorker?.close(),
      this.#runRequestWorker?.close(),
      ...[...this.#runsWorkers.values()].map((r) => r.worker.close()),
    ];
    // The tail of the budget is kept for handing back a step that outlives the wait, so the hand-back
    // and the workers settling after it stay inside `closeTimeoutMs` too.
    const reserve = Math.min(HAND_BACK_RESERVE_MS, this.#closeTimeoutMs / 5);
    const settled = Promise.allSettled(workers.filter((p) => p !== undefined));
    // Jobs still waiting for a handler slot (grouped queue) have not started: the workers no longer
    // fetch, so give them back at once rather than make the close wait for them.
    if ([...this.#openTasks.values()].some((task) => task.parked)) {
      await withTimeout(this.#handBackOpenTasks(true), remaining());
    }
    await withTimeout(settled, remaining() - reserve);
    // A step that outlived the wait goes back to the broker now; its worker then settles at once.
    if (this.#openTasks.size > 0) {
      await withTimeout(this.#handBackOpenTasks(), remaining());
      await withTimeout(settled, remaining());
    }
    await withTimeout(
      Promise.allSettled([...this.#queues.values()].map((q) => q.close())),
      remaining(),
    );
    await withTimeout(ownHeartbeatsRemoved, remaining());
    this.#heartbeatPub?.disconnect();
    this.#heartbeatSub?.disconnect();
    this.#workerRedis?.disconnect();
    this.#registryRedis?.disconnect();
    this.#runReplyPub?.disconnect();
    this.#runReplySub?.disconnect();
    this.#tenantEventPub?.disconnect();
    this.#tenantEventSub?.disconnect();
    this.#replyRedisClient?.disconnect();
  }
}

/** A positive finite duration, else `fallback`. */
function positiveMs(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Resolve when `work` settles or `ms` elapses (the loser is abandoned). `ms <= 0` skips the wait. */
async function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  if (ms <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([work.then(() => undefined), expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/**
 * The tail of `closeTimeoutMs` that `close()` keeps for handing back the jobs still running and letting
 * their workers settle: at most this, and never more than a fifth of the budget.
 */
const HAND_BACK_RESERVE_MS = 1_000;

/**
 * The error a handed-back processor rejects with. BullMQ's worker matches `DelayedError` by NAME as
 * well as by class, so this needs no import of `bullmq` (an optional peer, loaded lazily).
 */
function handedBackError(): Error {
  const err = new Error('job handed back to the broker on shutdown');
  err.name = 'DelayedError';
  return err;
}
/**
 * The `COUNT` hint of every worker-key SCAN. The heartbeat and descriptor keys share the Redis db with
 * every BullMQ job hash, so a `MATCH` walk visits the whole keyspace however few keys match; at 100 a
 * keyspace of 6k job keys took ~60 round trips per walk. 1000 cuts that tenfold while each SCAN call
 * still returns in well under a millisecond on the server (it is a hint, never a blocking KEYS).
 */
const SCAN_COUNT = 1_000;
/**
 * The `COUNT` hint of the throttled compatibility walk (see `#legacyEntries`): one SCAN call is one
 * billed command however many keys it visits, so a walk of a 50k-key db is ~5 calls instead of ~50.
 * Each call still visits only ~10k dict entries, well under a millisecond or two on the server.
 */
const LEGACY_SCAN_COUNT = 10_000;
/** How long a walk is reused when it is the whole read (a client without hash commands). */
const WORKER_HEARTBEAT_READ_TTL_MS = 5_000;
/**
 * How long the read of the instances hash is reused by every reader in a process (descriptors before
 * a dispatch, the fleet's announced subscriptions, worker health). A `fresh` read skips it, and a
 * process's own entries never wait for it.
 */
const REGISTRY_READ_MAX_AGE_MS = 30_000;
/** Default `workerRegistry.legacyScanIntervalMs`: the least time between two compatibility walks. */
const DEFAULT_LEGACY_SCAN_INTERVAL_MS = 60_000;
/** Default `workerRegistry.legacyWriteIntervalMs`: how often the keys older readers read are refreshed. */
const DEFAULT_LEGACY_WRITE_INTERVAL_MS = 30_000;
/** How long the instances hash outlives the last upkeep of a writer; fields carry their own expiry. */
const INSTANCES_KEY_TTL_MS = 10 * 60_000;
/** How often a writer refreshes the instances hash's TTL and deletes other writers' expired fields. */
const INSTANCES_UPKEEP_MS = 5 * 60_000;
/** How long an rc.31 per-token hash, and its index entry, outlive the last upkeep of a writer. */
const LEGACY_HASH_TTL_MS = 30 * 60_000;
/** How often a writer refreshes an rc.31 per-token hash's TTL and index entry. */
const LEGACY_HASH_UPKEEP_MS = 10 * 60_000;
/** How often a writer deletes an rc.31 per-token hash's expired fields and the index's past entries. */
const LEGACY_HASH_PRUNE_MS = 30 * 60_000;
/** The most distinct descriptor values kept parsed before the cache starts over. */
const PARSED_DESCRIPTORS_MAX = 256;

/** The registry commands of {@link RedisLike} (optional there, checked before use). */
type RegistryCommands = Pick<
  RedisLike,
  'hset' | 'hgetall' | 'hdel' | 'pexpire' | 'zadd' | 'zrangebyscore' | 'zremrangebyscore'
>;

/** One instance's registry entry: its routing token, its instance id and its raw value. `instance` is
 *  `''` for a per-instance key with no instance segment (it only names a group). `expiresAt` is set
 *  for an entry of the instances hash. */
interface RegistryEntry {
  token: string;
  instance: string;
  raw: string;
  expiresAt?: number | undefined;
}

/** Registry entries by kind: a read of the instances hash, a compatibility walk, or a merge of both. */
interface RegistrySnapshot {
  heartbeats: RegistryEntry[];
  descriptors: RegistryEntry[];
}

const EMPTY_REGISTRY: RegistrySnapshot = Object.freeze({
  heartbeats: [],
  descriptors: [],
}) as RegistrySnapshot;

/** One entry this process advertises (see `#own`). */
interface OwnEntry {
  effPrefix: string;
  instance: string;
  kind: WorkerRegistryKind;
  token: string;
  value: string;
  expiresAt: number;
}

function ownEntryKey(
  effPrefix: string,
  instance: string,
  kind: WorkerRegistryKind,
  token: string,
): string {
  return `${effPrefix}\n${instance}\n${kind}\n${token}`;
}

/** The per-instance key older readers read for an entry. */
function perInstanceKey(
  effPrefix: string,
  kind: WorkerRegistryKind,
  token: string,
  instance: string,
): string {
  return kind === 'heartbeats'
    ? workerHeartbeatKey(effPrefix, token, instance)
    : `${effPrefix}${DESCRIPTOR_SEGMENT}${token}:${instance}`;
}

/** Version of the instances-hash field layout; a reader skips a field of a version it does not know. */
const INSTANCE_RECORD_VERSION = 1;

/**
 * One field of the instances hash: `{ v, instance, expiresAt, heartbeats, descriptors }`, where each
 * kind is a list of `{ value, expiresAt, tokens }` groups (entries sharing a value share a group).
 * `expiresAt` of the field is its latest entry's, for pruning.
 */
interface InstanceRecord {
  v: number;
  instance: string;
  expiresAt: number;
  heartbeats: InstanceRecordGroup[];
  descriptors: InstanceRecordGroup[];
}

interface InstanceRecordGroup {
  value: string;
  expiresAt: number;
  tokens: string[];
}

function encodeInstanceRecord(entries: OwnEntry[]): string {
  const record: InstanceRecord = {
    v: INSTANCE_RECORD_VERSION,
    instance: entries[0]?.instance ?? '',
    expiresAt: 0,
    heartbeats: [],
    descriptors: [],
  };
  const groups = new Map<string, InstanceRecordGroup>();
  for (const entry of entries) {
    record.expiresAt = Math.max(record.expiresAt, entry.expiresAt);
    const id = `${entry.kind}\n${entry.value}`;
    let group = groups.get(id);
    if (!group) {
      group = { value: entry.value, expiresAt: entry.expiresAt, tokens: [] };
      groups.set(id, group);
      record[entry.kind].push(group);
    }
    group.expiresAt = Math.max(group.expiresAt, entry.expiresAt);
    group.tokens.push(entry.token);
  }
  return JSON.stringify(record);
}

/** A field of the instances hash, or `undefined` when malformed or of an unknown version. */
function decodeInstanceRecord(raw: string): InstanceRecord | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<InstanceRecord>;
    if (
      parsed.v !== INSTANCE_RECORD_VERSION ||
      typeof parsed.instance !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      !Array.isArray(parsed.heartbeats) ||
      !Array.isArray(parsed.descriptors)
    ) {
      return undefined;
    }
    return parsed as InstanceRecord;
  } catch {
    return undefined;
  }
}

/**
 * The entries of the instances hash, skipping the fields whose name ends with `ownSuffix` (this
 * transport's own, read from memory instead) and malformed ones. Fields are taken newest first, so
 * when an instance restarted under the same id its latest field's entries come first.
 */
function decodeInstancesHash(fields: Record<string, string>, ownSuffix: string): RegistrySnapshot {
  const out: RegistrySnapshot = { heartbeats: [], descriptors: [] };
  const records = Object.entries(fields)
    .filter(([field]) => !field.endsWith(ownSuffix))
    .map(([, raw]) => decodeInstanceRecord(raw))
    .filter((r): r is InstanceRecord => r !== undefined)
    .sort((a, b) => b.expiresAt - a.expiresAt);
  for (const record of records) {
    for (const kind of ['heartbeats', 'descriptors'] as const) {
      for (const group of record[kind]) {
        if (typeof group?.value !== 'string' || !Array.isArray(group.tokens)) continue;
        for (const token of group.tokens) {
          if (typeof token !== 'string') continue;
          out[kind].push({
            token,
            instance: record.instance,
            raw: group.value,
            expiresAt: typeof group.expiresAt === 'number' ? group.expiresAt : record.expiresAt,
          });
        }
      }
    }
  }
  return out;
}

/** The value of a registry field still live at `now`, else `undefined` (expired or malformed). */
function liveRegistryValue(stored: string, now: number): string | undefined {
  try {
    const parsed = JSON.parse(stored) as { expiresAt?: unknown; value?: unknown };
    if (typeof parsed.expiresAt !== 'number' || typeof parsed.value !== 'string') return undefined;
    return parsed.expiresAt > now ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

/** `primary`, then each `legacy` entry of an instance `primary` does not have that `keep` accepts. */
function mergeEntries(
  primary: RegistryEntry[],
  legacy: RegistryEntry[],
  keep?: (entry: RegistryEntry) => boolean,
): RegistryEntry[] {
  const seen = new Set(primary.map((e) => `${e.token}\n${e.instance}`));
  const out = [...primary];
  for (const entry of legacy) {
    const id = `${entry.token}\n${entry.instance}`;
    if (seen.has(id) || (keep && !keep(entry))) continue;
    seen.add(id);
    out.push(entry);
  }
  return out;
}

function toWorkerHeartbeat(entry: RegistryEntry): WorkerHeartbeat {
  const parsed = parseHeartbeatValue(entry.raw);
  return {
    group: entry.token,
    instanceId: entry.instance,
    lastBeatAt: parsed.lastBeatAt,
    // Passed through as-is: the payload is worker-authored (this SDK's #workerStatus, or the
    // NestJS/Python fleet's own shape) and the console renders what it recognizes.
    ...(parsed.status !== undefined ? { status: parsed.status as unknown as WorkerStatus } : {}),
  };
}

const HEARTBEAT_SEGMENT = '-worker-heartbeat:';
const DESCRIPTOR_SEGMENT = '-worker-descriptor:';

/** Split a per-instance key `<P>-worker-heartbeat:<token>:<instance>` (or `-worker-descriptor:`). */
function parseWorkerKey(
  key: string,
): { effPrefix: string; kind: WorkerRegistryKind; token: string; instance: string } | undefined {
  for (const [segment, kind] of [
    [HEARTBEAT_SEGMENT, 'heartbeats'],
    [DESCRIPTOR_SEGMENT, 'descriptors'],
  ] as const) {
    const at = key.indexOf(segment);
    if (at <= 0) continue;
    const rest = key.slice(at + segment.length);
    const sep = rest.indexOf(':');
    if (sep <= 0 || sep === rest.length - 1) return undefined;
    return {
      effPrefix: key.slice(0, at),
      kind,
      token: rest.slice(0, sep),
      instance: rest.slice(sep + 1),
    };
  }
  return undefined;
}
/** The fewest step results a results consumer holds at once (see `resultConcurrency`). */
const RESULT_CONSUMER_MIN = 512;
/**
 * How long BullMQ keeps refusing a keyed dispatch's re-send after its job finished (see
 * {@link taskDispatchOptions}). Covers the window in which a crashed turn's step is re-sent although
 * its job already completed and only the result is still on its way back (a results batch held by
 * the dead pod is redelivered once BullMQ finds it stalled). One small Redis key per keyed dispatch,
 * expiring after this.
 */
const TASK_DEDUPE_TTL_MS = 120_000;

/**
 * The BullMQ options of a step task job: {@link taskJobOptions}, plus — when the task carries a
 * dispatch key (see `dispatch-key.ts`) — a job id and a deduplication id derived from it. BullMQ adds
 * nothing for an id it still holds, and nothing for a deduplication id seen within
 * {@link TASK_DEDUPE_TTL_MS}, so a re-send of the same dispatch (a crashed turn's step re-dispatched on
 * recovery) is a no-op while the original job waits or runs, or has just finished, instead of a second
 * execution. A new attempt, or a new checkpoint of the step, has another key. A task without a key gets
 * a broker-generated id, as before. The id escapes `%` and `:` (BullMQ refuses a custom id with `:`).
 * A BullMQ without deduplication ignores that option, and still dedupes by job id.
 */
function taskDispatchOptions(task: RemoteTask): ReturnType<typeof taskJobOptions> & {
  jobId?: string;
  deduplication?: { id: string; ttl: number };
} {
  const options = taskJobOptions(task.priority);
  const key = dispatchKeyOf(task);
  if (key === undefined) return options;
  const esc = (v: string) => v.replaceAll('%', '%25').replaceAll(':', '%3A');
  const jobId = `task-${esc(key)}`;
  return { ...options, jobId, deduplication: { id: jobId, ttl: TASK_DEDUPE_TTL_MS } };
}

/** Default `taskQueueDrain.intervalMs`: how often the other layout's queues are checked for jobs. */
const DEFAULT_DRAIN_CHECK_INTERVAL_MS = 60_000;
/** Most keys one drain-check `EXISTS` names. */
const DRAIN_EXISTS_CHUNK = 1_000;
/** How long a grouped-queue job for a handler this process lacks waits before it is offered again. */
const FOREIGN_HANDBACK_MS = 10_000;
/** Bounds of the delay a job of a handler at its limit is handed back with (see #overflowDelay). */
const OVERFLOW_MIN_DELAY_MS = 250;
const OVERFLOW_DEFAULT_DELAY_MS = 1_000;
const OVERFLOW_MAX_DELAY_MS = 30_000;
/** Most job ids whose hand-back count is remembered. */
const OVERFLOW_BOUNCES_MAX = 10_000;
/** How long one per-token depth read of a grouped queue serves every token's groupHealth. */
const GROUPED_SNAPSHOT_TTL_MS = 2_000;
/** Most jobs of a grouped queue read to split its depth per token. */
const GROUPED_DEPTH_SAMPLE = 500;

/**
 * The concurrency of a worker serving `tokens` handlers off one queue at `limit` each: two limits per
 * handler. A handler holds at most `limit` running and `limit` waiting jobs (the rest are handed
 * back), so the waiting ones never take a slot another handler needs to reach its limit.
 */
function groupedSlots(limit: number, tokens: number): number {
  return 2 * limit * Math.max(1, tokens);
}

/** One read of a grouped task queue: its depth, and how much of it each routing token holds. */
interface GroupedSnapshot {
  total: number;
  byToken: Map<string, number>;
  /** The jobs read did not cover the whole queue, so `byToken` undercounts. */
  sampled: boolean;
}

/** The most task jobs one `addBulk` carries, and how many such calls run at once (`dispatchMany`). */
const TASK_ADD_BULK_CHUNK = 500;
const TASK_ADD_BULK_IN_FLIGHT = 4;

/** The most run jobs one `addBulk` carries (see {@link BullMQTransport.dispatchRuns}). */
const RUN_ADD_BULK_CHUNK = 500;

/** The suffix of the pub/sub channel sealed tenant events go on. */
const SEALED_SUFFIX = ':sealed';
const sealedChannel = (channel: string): string => `${channel}${SEALED_SUFFIX}`;
