import type { WorkerDescriptor } from '../../handshake/descriptor.js';
import type {
  GroupHealth,
  Heartbeat,
  RemoteTask,
  RunReply,
  RunRequest,
  StartRunMessage,
  StepResult,
  TenantEvent,
  Transport,
  WorkerHeartbeat,
  WorkflowDecision,
  WorkflowStepEvent,
  WorkflowTask,
} from '../../interfaces.js';
import { type StepHandler, runStepHandler } from '../../protocol.js';
import { type WorkflowTurnHandler, isWorkflowTask } from '../../workflow-turn.js';
import type { BullMQDeps, JobLike, QueueLike, RedisLike, WorkerLike } from './deps.js';
import {
  decisionsName,
  effectivePrefix,
  heartbeatChannel,
  resultsName,
  routingToken,
  runReplyChannel,
  runRequestName,
  startRunName,
  stepEventsName,
  tasksName,
  tenantEventsChannel,
  workerDescriptorTokenPrefix,
  workerHeartbeatKey,
  workerHeartbeatKeyPrefix,
} from './naming.js';
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_SECONDS,
  buildInstanceId,
  heartbeatKeyValue,
  jobOptions,
  parseHeartbeatValue,
  taskJobOptions,
} from './serialization.js';

export interface BullMQTransportOptions {
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
}

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

  readonly #handlers = new Map<string, StepHandler>();
  // Worker-side workflow turn consumers, keyed by workflow name — a `workflow`-shaped job routes here.
  readonly #workflowTurns = new Map<string, WorkflowTurnHandler>();
  // One task queue/worker per registered handler name (its routing token) — never a shared queue.
  readonly #queues = new Map<string, QueueLike>();
  readonly #taskWorkers = new Map<string, WorkerLike>();
  #resultsWorker: WorkerLike | undefined;
  #decisionsWorker: WorkerLike | undefined;
  #stepEventsWorker: WorkerLike | undefined;

  // Long-step heartbeat pub/sub (distinct from the worker-liveness key registry below).
  #heartbeatPub: RedisLike | undefined;
  #heartbeatSub: RedisLike | undefined;

  // Worker liveness: one TTL'd key per handled routing token, refreshed on a single shared interval.
  #workerRedis: RedisLike | undefined;
  #workerHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  readonly #heartbeatTokens = new Set<string>();

  // P4 store-less protocol: start-run / run-request queues + consumers, run-reply / tenant-events pub/sub.
  #startRunWorker: WorkerLike | undefined;
  #runRequestWorker: WorkerLike | undefined;
  #runReplyPub: RedisLike | undefined;
  #runReplySub: RedisLike | undefined;
  #tenantEventPub: RedisLike | undefined;
  // ONE shared subscriber for every tenant-events channel; a message is routed to the channel's
  // handler set, so `onTenantEvent` can be called for several tenants (or several times per tenant).
  #tenantEventSub: RedisLike | undefined;
  readonly #tenantEventChannels = new Set<string>();
  readonly #tenantEventHandlers = new Map<string, Set<(evt: TenantEvent) => void>>();

  constructor(options: BullMQTransportOptions) {
    this.#deps = options.deps;
    this.#partition = options.partition;
    this.#prefix = options.prefix ?? 'durable';
    this.#namespace = options.namespace;
    this.#explicitNamespace = options.namespace !== undefined;
    this.#instanceId = options.instanceId ?? buildInstanceId();
    this.#onError = options.onError ?? (() => {});
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

  #effectivePrefix(): string {
    return effectivePrefix(this.#prefix, this.#namespace);
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
   * Capability hook consumed by the `tenant`-role provider: mint a DEDICATED Redis client the
   * store-less {@link WorkerRuntime}'s registry uses to publish/refresh its `-worker-descriptor:`
   * and `-worker-heartbeat:` keys (SET…EX). Dedicated so the registry disconnecting on worker
   * drain never tears down the transport's own broker clients. The returned `RedisLike` structurally
   * satisfies the registry's `DescriptorRedis` port (`set`/`del`/`disconnect`), and is what the
   * control-plane's `listWorkerDescriptors` SCAN later reads back — closing the descriptor loop.
   */
  createDescriptorRedis(): RedisLike {
    return this.#deps.makeRedis();
  }

  // ---------------------------------------------------------------------------
  // engine → worker
  // ---------------------------------------------------------------------------

  /** `task.group` already carries the FINAL routing token (computed by the engine) — target that
   *  handler's dedicated queue. Job name `task`; DTO is the raw job data. */
  async dispatch(task: RemoteTask): Promise<void> {
    await this.#queue(tasksName(this.#effectivePrefix(), task.group)).add(
      'task',
      task,
      taskJobOptions(task.priority),
    );
  }

  /** engine → workflow worker: a `WorkflowTask` on the workflow's dedicated task queue (same queue a
   *  Python workflow worker consumes). Job name `workflow`; the decision returns on `${P}-decisions`. */
  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    await this.#queue(tasksName(this.#effectivePrefix(), task.group)).add(
      'workflow',
      task,
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
    this.#ensureTaskWorker(routingToken(name, this.#partition));
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
    this.#ensureTaskWorker(routingToken(name, this.#partition));
  }

  /** Start (once per routing token) the discriminating task worker + its liveness heartbeat. Shared by
   *  {@link handle} (steps) and {@link handleWorkflow} (workflow turns) — both ride `${P}-tasks-<token>`. */
  #ensureTaskWorker(token: string): void {
    if (this.#taskWorkers.has(token)) return;
    const worker = this.#deps.makeWorker(tasksName(this.#effectivePrefix(), token), (job) =>
      this.#runJob(job.data),
    );
    // Terminal-failure bridge: a task job reaching a TERMINAL `failed` state is an INFRASTRUCTURE
    // failure (worker crash / stalled-count exhaustion), never a handler business error —
    // `runStepHandler` catches every handler throw and publishes a failed StepResult so the job
    // SUCCEEDS. `failed` fires only when no StepResult was produced, so without this the run hangs on
    // its `pending` checkpoint forever. Synthesize a RETRYABLE failed StepResult so the engine settles
    // the checkpoint and re-dispatches. A PEER replica's worker fails a crashed worker's stalled job,
    // so this still fires cross-process. (A failed WORKFLOW job carries no step identity, so the bridge
    // no-ops for it — the engine's RemoteWorkflowExecutor re-drives the turn on recovery instead.)
    worker.on('failed', (job, error) => {
      const identity = failedTaskIdentity(job?.data);
      if (!identity) return; // payload already GC'd, malformed, or a workflow job — nothing safe to publish
      void this.#bridgeTaskFailure(identity, job?.failedReason ?? error?.message ?? 'unknown');
    });
    this.#taskWorkers.set(token, worker);
    this.#startWorkerHeartbeat(token);
  }

  /** Route one task job by SHAPE (spec §6.3): a workflow turn runs the replay → decision path, a step
   *  runs the `runStepHandler` → result path. Both kinds share a token's queue but never each other's. */
  async #runJob(data: unknown): Promise<void> {
    if (isWorkflowTask(data)) return this.#runWorkflowTask(data);
    return this.#runTask(data as RemoteTask);
  }

  /** Worker side: replay a workflow turn and publish its {@link WorkflowDecision} on `${P}-decisions`
   *  (job `decision`) — the queue the engine's `onDecision` consumes. An unknown workflow or a turn
   *  that throws still publishes a `failed` decision so the engine settles the run (never hangs). */
  async #runWorkflowTask(task: WorkflowTask): Promise<void> {
    let decision: WorkflowDecision;
    try {
      const turn = this.#workflowTurns.get(task.workflow);
      decision = turn
        ? await turn(task)
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
    try {
      await this.#queue(decisionsName(this.#effectivePrefix())).add(
        'decision',
        decision,
        jobOptions(),
      );
    } catch (err) {
      // The decisions-queue publish threw (Redis blipped). Rethrow so the job is marked `failed` and the
      // engine re-drives the turn on recovery rather than the run hanging awaiting a decision.
      this.#onError(err);
      throw err;
    }
  }

  async #runTask(task: RemoteTask): Promise<void> {
    let result: StepResult;
    try {
      result = await runStepHandler(task, this.#handlers.get(task.name), (beat) =>
        this.heartbeat(beat),
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
    try {
      await this.#queue(resultsName(this.#effectivePrefix())).add('result', result, jobOptions());
    } catch (err) {
      // The results-queue publish itself threw (e.g. Redis blipped). We still hold `task`, so
      // rethrow so the BullMQ job is marked `failed` and the terminal-failure bridge + durable retry
      // become the last line of defence rather than the run hanging on `pending`.
      this.#onError(err);
      throw err;
    }
  }

  /** Worker side: publish a liveness heartbeat for an in-flight long step on the `${P}-heartbeat`
   *  pub/sub channel (resets the engine's `timeoutMs` window on whichever pod is awaiting it). */
  async heartbeat(beat: Heartbeat): Promise<void> {
    if (!this.#heartbeatPub) this.#heartbeatPub = this.#deps.makeRedis();
    await this.#heartbeatPub.publish(
      heartbeatChannel(this.#effectivePrefix()),
      JSON.stringify(beat),
    );
  }

  /** Publish a synthetic FAILED StepResult for a task that failed at the infrastructure level (see the
   *  `handle()` bridge). Correlated purely by runId/seq/stepId (StepResult has no `name`). Best-effort. */
  async #bridgeTaskFailure(
    identity: { runId: string; seq: number; stepId: string },
    reason: string,
  ): Promise<void> {
    const result: StepResult = {
      runId: identity.runId,
      seq: identity.seq,
      stepId: identity.stepId,
      status: 'failed',
      error: { message: `remote step worker failed: ${reason}`, retryable: true },
    };
    try {
      await this.#queue(resultsName(this.#effectivePrefix())).add('result', result, jobOptions());
    } catch (err) {
      this.#onError(err); // best-effort — the engine's reconcile path is the last resort
    }
  }

  // ---------------------------------------------------------------------------
  // worker → engine — the engine consumes results / decisions / step events / heartbeats
  // ---------------------------------------------------------------------------

  onResult(handler: (result: StepResult) => Promise<void>): void {
    if (this.#resultsWorker) return;
    this.#resultsWorker = this.#deps.makeWorker(resultsName(this.#effectivePrefix()), (job) =>
      handler(job.data as StepResult),
    );
  }

  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    if (this.#decisionsWorker) return;
    this.#decisionsWorker = this.#deps.makeWorker(decisionsName(this.#effectivePrefix()), (job) =>
      handler(job.data as WorkflowDecision),
    );
  }

  /** workflow worker → engine: stream a local step's lifecycle on `${P}-step-events` (job `stepEvent`),
   *  point-to-point so one engine instance checkpoints each once. */
  async dispatchStepEvent(event: WorkflowStepEvent): Promise<void> {
    await this.#queue(stepEventsName(this.#effectivePrefix())).add(
      'stepEvent',
      event,
      jobOptions(),
    );
  }

  onStepEvent(handler: (event: WorkflowStepEvent) => Promise<void>): void {
    if (this.#stepEventsWorker) return;
    this.#stepEventsWorker = this.#deps.makeWorker(stepEventsName(this.#effectivePrefix()), (job) =>
      handler(job.data as WorkflowStepEvent),
    );
  }

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    if (this.#heartbeatSub) return; // one subscription per transport
    const sub = this.#deps.makeRedis();
    this.#heartbeatSub = sub;
    void sub.subscribe(heartbeatChannel(this.#effectivePrefix()));
    sub.on('message', ((_channel: string, payload: string) => {
      try {
        void handler(JSON.parse(payload) as Heartbeat);
      } catch {
        /* ignore malformed heartbeats */
      }
    }) as never);
  }

  // ---------------------------------------------------------------------------
  // worker liveness registry — `${P}-worker-heartbeat:${token}:${instanceId}` (SET … EX 35)
  // ---------------------------------------------------------------------------

  /** Refresh EVERY handled routing token's TTL'd liveness key on ONE shared 10s interval until
   *  `close()`. A newly added token beats immediately so a freshly-registered handler is visible
   *  without waiting a full interval. Best-effort: a failed refresh is swallowed (the key then expires,
   *  and that gap is itself the signal). */
  #startWorkerHeartbeat(token: string): void {
    const client = this.#workerRedisClient();
    const beatOne = (t: string): void => {
      const key = workerHeartbeatKey(this.#effectivePrefix(), t, this.#instanceId);
      void client
        .set(key, heartbeatKeyValue(), 'EX', WORKER_HEARTBEAT_TTL_SECONDS)
        .catch((err) => this.#onError(err));
    };
    const isNew = !this.#heartbeatTokens.has(token);
    this.#heartbeatTokens.add(token);
    if (isNew) beatOne(token);
    if (this.#workerHeartbeatTimer) return;
    this.#workerHeartbeatTimer = setInterval(() => {
      for (const t of this.#heartbeatTokens) beatOne(t);
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    // Don't keep the event loop alive just for the heartbeat.
    this.#workerHeartbeatTimer.unref?.();
  }

  /** Distinct routing tokens with a live worker heartbeat, discovered by SCANning the heartbeat
   *  keyspace (never KEYS — it blocks Redis). A key is `${P}-worker-heartbeat:<token>:<instance>`, and
   *  neither segment carries a `:`, so the token is the segment between the fixed prefix and the next `:`. */
  async listWorkerGroups(): Promise<string[]> {
    const client = this.#workerRedisClient();
    const prefix = workerHeartbeatKeyPrefix(this.#effectivePrefix());
    const groups = new Set<string>();
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const sep = rest.indexOf(':');
        const group = sep === -1 ? rest : rest.slice(0, sep);
        if (group) groups.add(group);
      }
    } while (cursor !== '0');
    return [...groups];
  }

  /** The LIVE worker descriptors advertised on `token` — SCAN the `${P}-worker-descriptor:<token>:*`
   *  keys a worker runtime publishes (design §7.2), GET + parse each. Degrades gracefully to `[]`: a
   *  missing/unreadable/malformed key is skipped (never throws), so a broker without descriptor
   *  advertisement (or a scan that races a key's expiry) reads as "no descriptors" and the control-plane
   *  falls back to legacy assume-compatible dispatch. Never uses KEYS (it blocks Redis). */
  async listWorkerDescriptors(token: string): Promise<WorkerDescriptor[]> {
    const client = this.#workerRedisClient();
    const prefix = workerDescriptorTokenPrefix(this.#effectivePrefix(), token);
    const descriptors: WorkerDescriptor[] = [];
    try {
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
        cursor = next;
        for (const key of keys) {
          const raw = await client.get(key);
          if (raw == null) continue; // expired between SCAN and GET — just skip it
          try {
            descriptors.push(JSON.parse(raw) as WorkerDescriptor);
          } catch {
            /* a malformed descriptor value never blocks routing — treat it as absent */
          }
        }
      } while (cursor !== '0');
    } catch (err) {
      // A backend that can't SCAN/GET the descriptor keyspace degrades to "no descriptors" — the
      // engine then dispatches legacy assume-compatible rather than parking every run.
      this.#onError(err);
      return [];
    }
    return descriptors;
  }

  /** Per-group worker-health: queue depth (waiting+active+delayed+prioritized) + live workers (their
   *  non-expired heartbeat keys). `group` is a routing token — the same value a dispatch targets. */
  async groupHealth(group: string): Promise<GroupHealth> {
    const counts = await this.#queue(tasksName(this.#effectivePrefix(), group)).getJobCounts(
      'waiting',
      'active',
      'delayed',
      'prioritized',
    );
    const depth = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
    return { group, depth, liveWorkers: await this.#listLiveWorkers(group) };
  }

  async #listLiveWorkers(group: string): Promise<WorkerHeartbeat[]> {
    const client = this.#workerRedisClient();
    const keyPrefix = workerHeartbeatKey(this.#effectivePrefix(), group, '');
    const match = `${keyPrefix}*`;
    const workers: WorkerHeartbeat[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        const raw = await client.get(key);
        workers.push({
          group,
          instanceId: key.slice(keyPrefix.length),
          lastBeatAt: parseHeartbeatValue(raw).lastBeatAt,
        });
      }
    } while (cursor !== '0');
    return workers;
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

  /** tenant → control plane: enqueue a {@link StartRunMessage} on `${P}-start-run` (job `startRun`). */
  async dispatchStartRun(msg: StartRunMessage): Promise<void> {
    await this.#queue(startRunName(this.#effectivePrefix())).add('startRun', msg, jobOptions());
  }

  /** control plane ← tenant: consume {@link StartRunMessage}s. Idempotent — a second call is a no-op. */
  onStartRun(handler: (msg: StartRunMessage) => Promise<void>): void {
    if (this.#startRunWorker) return;
    this.#startRunWorker = this.#deps.makeWorker(startRunName(this.#effectivePrefix()), (job) =>
      handler(job.data as StartRunMessage),
    );
  }

  /** tenant → control plane: enqueue a {@link RunRequest} on `${P}-run-request` (job `runRequest`). */
  async dispatchRunRequest(msg: RunRequest): Promise<void> {
    await this.#queue(runRequestName(this.#effectivePrefix())).add('runRequest', msg, jobOptions());
  }

  /** control plane ← tenant: consume {@link RunRequest}s. Idempotent — a second call is a no-op. */
  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void {
    if (this.#runRequestWorker) return;
    this.#runRequestWorker = this.#deps.makeWorker(runRequestName(this.#effectivePrefix()), (job) =>
      handler(job.data as RunRequest),
    );
  }

  /** control plane → tenant: publish a correlated {@link RunReply} on `${P}-run-reply` (pub/sub). */
  async publishRunReply(reply: RunReply): Promise<void> {
    if (!this.#runReplyPub) this.#runReplyPub = this.#deps.makeRedis();
    await this.#runReplyPub.publish(
      runReplyChannel(this.#effectivePrefix()),
      JSON.stringify(reply),
    );
  }

  /** tenant ← control plane: consume {@link RunReply}s (the proxy filters by `requestId`). Idempotent. */
  onRunReply(handler: (reply: RunReply) => void): void {
    if (this.#runReplySub) return; // one subscription per transport
    const channel = runReplyChannel(this.#effectivePrefix());
    const sub = this.#deps.makeRedis();
    this.#runReplySub = sub;
    void sub.subscribe(channel);
    sub.on('message', ((msgChannel: string, payload: string) => {
      // Filter by channel: a shared pub/sub connection may also carry other channels' messages.
      if (msgChannel !== channel) return;
      try {
        handler(JSON.parse(payload) as RunReply);
      } catch {
        /* ignore malformed run replies */
      }
    }) as never);
  }

  /** control plane → tenant: re-publish a lifecycle {@link TenantEvent} on `${P}-tenant-events-<tenant>`. */
  async publishTenantEvent(evt: TenantEvent): Promise<void> {
    if (!this.#tenantEventPub) this.#tenantEventPub = this.#deps.makeRedis();
    await this.#tenantEventPub.publish(
      tenantEventsChannel(this.#effectivePrefix(), evt.tenant),
      JSON.stringify(evt),
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
      void sub.subscribe(channel);
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
    const sub = this.#deps.makeRedis();
    this.#tenantEventSub = sub;
    sub.on('message', ((msgChannel: string, payload: string) => {
      const handlers = this.#tenantEventHandlers.get(msgChannel);
      if (!handlers || handlers.size === 0) return;
      let evt: TenantEvent;
      try {
        evt = JSON.parse(payload) as TenantEvent;
      } catch {
        return; // ignore malformed tenant events
      }
      for (const h of handlers) h(evt);
    }) as never);
    return sub;
  }

  // ---------------------------------------------------------------------------
  // shutdown
  // ---------------------------------------------------------------------------

  /** Close all workers/queues and disconnect pub/sub + heartbeat connections so the process can exit. */
  async close(): Promise<void> {
    if (this.#workerHeartbeatTimer) clearInterval(this.#workerHeartbeatTimer);
    this.#workerHeartbeatTimer = undefined;
    await Promise.all([...this.#taskWorkers.values()].map((w) => w.close()));
    await this.#resultsWorker?.close();
    await this.#decisionsWorker?.close();
    await this.#stepEventsWorker?.close();
    await this.#startRunWorker?.close();
    await this.#runRequestWorker?.close();
    await Promise.all([...this.#queues.values()].map((q) => q.close()));
    this.#heartbeatPub?.disconnect();
    this.#heartbeatSub?.disconnect();
    this.#workerRedis?.disconnect();
    this.#runReplyPub?.disconnect();
    this.#runReplySub?.disconnect();
    this.#tenantEventPub?.disconnect();
    this.#tenantEventSub?.disconnect();
  }
}

/**
 * Narrow a FAILED task job's `data` to the {@link RemoteTask} fields the terminal-failure bridge needs
 * (runId/seq/stepId), WITHOUT an unsafe cast. Returns `undefined` for a payload BullMQ has already
 * GC'd or a malformed job — so the bridge safely no-ops instead of publishing a bogus result.
 */
function failedTaskIdentity(
  data: unknown,
): { runId: string; seq: number; stepId: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  if (!('runId' in data) || !('seq' in data) || !('stepId' in data)) return undefined;
  const { runId, seq, stepId } = data as Record<string, unknown>;
  if (typeof runId !== 'string' || typeof seq !== 'number' || typeof stepId !== 'string') {
    return undefined;
  }
  return { runId, seq, stepId };
}
