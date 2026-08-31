import { randomUUID } from 'node:crypto';
import type { AcquiredJob, Adapter, AdapterFactory, JobData } from '@adonisjs/queue/types';
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

/** How often (ms) the stalled-job reclaim sweep runs — a coarse, low-frequency check, NOT per poll
 *  tick. Mirrors `DbTransport`'s crash-recovery cadence (its stale-lease default is also 30s). */
const DEFAULT_STALLED_CHECK_INTERVAL_MS = 30_000;
/** How old (ms) a claim must be before the sweep presumes its worker dead and re-delivers the job.
 *  Deliberately generous: re-delivery double-runs a step whose worker is merely slow, so this must
 *  comfortably exceed the longest legitimate step execution (see the reclaim doc block for why this
 *  is safe under the durable idempotency contract). The claim's `acquiredAt` is never renewed while
 *  the worker processes — long-running steps hold one claim for their whole duration — so this
 *  default clears real steps in the tens of minutes; a step routinely longer should raise it. */
const DEFAULT_STALLED_THRESHOLD_MS = 1_800_000;
/** How many times a single job may be reclaimed before the adapter fails it permanently instead of
 *  re-delivering — bounds a poison job that stalls every worker it touches. */
const DEFAULT_MAX_STALLED_COUNT = 3;

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
   * How often (ms) the stalled-job reclaim sweep runs. Reclaim is ON by default (default 30s); set to
   * `0` to disable it entirely. This is a coarse background check, NOT run on every poll tick — see
   * the reclaim doc block on {@link QueueTransport} for what it recovers and why default-on is safe.
   */
  stalledCheckIntervalMs?: number;
  /**
   * How old (ms) a claim must be before the reclaim sweep presumes its worker dead and re-delivers the
   * job. Default 30min — intentionally generous, because the claim's `acquiredAt` is never renewed
   * while the worker processes: a legitimately long step holds one claim for its entire duration, and
   * re-delivery double-runs a step whose worker is merely slow. Raise it above your longest step. Only used when the adapter implements
   * `recoverStalledJobs` and the sweep is enabled.
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
}

/**
 * A `@adonisjs/queue`-backed {@link Transport}. Remote steps are dispatched to a per-group task
 * queue; the worker side runs the registered handler via {@link runStepHandler} and pushes the
 * {@link StepResult} onto a results queue the engine consumes. Heartbeats ride their own queue.
 *
 * `@adonisjs/queue` v0.6 is a one-directional job queue (dispatch → a separate `Worker` process
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
  readonly #adapter: Adapter;
  readonly #partition: string | undefined;
  readonly #prefix: string;
  // Logical deployment namespace folded into every queue name via `#effectivePrefix()`. Mutable so an
  // engine can push its namespace onto a transport via `useNamespace()` — but only when one wasn't
  // passed explicitly to the constructor (`#explicitNamespace`), which always wins.
  #namespace: string | undefined;
  readonly #explicitNamespace: boolean;
  readonly #pollIntervalMs: number;
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
  /** Drives the stalled-job reclaim sweep on its own (coarse) interval. Absent when reclaim is disabled
   *  (`stalledCheckIntervalMs <= 0`) or the adapter can't `recoverStalledJobs`. Separate from
   *  {@link #pollers} because the sweep cadence is unrelated to the fast job-poll cadence. */
  readonly #reclaimPollers: Pollers | undefined;
  /** When set (see {@link deferConsumers}), {@link QueueTransport.#startLoop} parks its loop here
   *  instead of polling — {@link startConsumers} flushes the parked starts. Dispatching (`pushOn`)
   *  is never deferred; only consumption is. */
  #consumersDeferred = false;
  readonly #deferredStarts: Array<() => void> = [];

  constructor(options: QueueTransportOptions) {
    this.#adapter = options.adapter();
    this.#partition = options.partition;
    this.#prefix = options.prefix ?? 'durable';
    this.#namespace = options.namespace;
    this.#explicitNamespace = options.namespace !== undefined;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#stalledThresholdMs = options.stalledThresholdMs ?? DEFAULT_STALLED_THRESHOLD_MS;
    this.#maxStalledCount = options.maxStalledCount ?? DEFAULT_MAX_STALLED_COUNT;
    this.#instanceId = options.instanceId ?? randomUUID();
    this.#onError = options.onError ?? DEFAULT_LOG;
    // pop()/popFrom() require a worker id be set on the adapter before consuming.
    this.#adapter.setWorkerId(this.#instanceId);
    this.#pollers = new Pollers(this.#pollIntervalMs, this.#onError);
    this.#reclaimPollers = this.#startReclaimSweep(
      options.stalledCheckIntervalMs ?? DEFAULT_STALLED_CHECK_INTERVAL_MS,
    );
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
      this.#startLoop(this.#tasksQueue(token), async (job) => {
        const task = fromJson<TaskPayload>(job.payload);
        const result = await runStepHandler(task, this.#handlers.get(task.name), (beat) =>
          this.heartbeat(beat),
        );
        await this.#adapter.pushOn(this.#resultsQueue(), this.#job('result', result));
      }),
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
    this.#startLoop(this.#resultsQueue(), async (job) => {
      await handler(fromJson<ResultPayload>(job.payload));
    });
  }

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    this.#startLoop(this.#heartbeatsQueue(), async (job) => {
      await handler(fromJson<HeartbeatPayload>(job.payload));
    });
  }

  // ---------------------------------------------------------------------------
  // control plane (best-effort, point-to-point)
  // ---------------------------------------------------------------------------

  async publishControl(msg: ControlMessage): Promise<void> {
    const stamped: ControlMessage = msg.from ? msg : { ...msg, from: this.#instanceId };
    await this.#adapter.pushOn(this.#controlQueue(), this.#job('control', stamped));
  }

  onControl(handler: (msg: ControlMessage) => void): void {
    this.#startLoop(this.#controlQueue(), async (job) => {
      handler(fromJson<ControlPayload>(job.payload));
    });
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
   * poll interval) rather than destroyed, and the error is reported to `onError`. This matters most
   * for the results queue, which is point-to-point: every engine instance polls it, so a result can
   * be popped by one that cannot act on it (a pod mid-rolling-deploy without the workflow registered,
   * a stale process from an older build). Failing the job there dropped the ONLY copy of the result —
   * the run stayed `suspended` with no `wakeAt`, unreachable by every recovery path, forever and
   * silently. Redelivery hands it to an instance that CAN resume it; a job nobody can handle now
   * loops at the poll rate and says so on every attempt, which is the failure we want — loud, not
   * invisible.
   */
  #startLoop(queue: string, onJob: (job: JobData) => Promise<void>): PollLoop {
    // Deferred consumption (see deferConsumers): park the start; startConsumers() flushes it. The
    // handle returned now still stops the loop whether it is flushed later or never.
    if (this.#consumersDeferred) {
      let cancelled = false;
      let live: PollLoop | undefined;
      this.#deferredStarts.push(() => {
        if (!cancelled) live = this.#reallyStartLoop(queue, onJob);
      });
      return {
        stop: () => {
          cancelled = true;
          live?.stop();
        },
      };
    }
    return this.#reallyStartLoop(queue, onJob);
  }

  #reallyStartLoop(queue: string, onJob: (job: JobData) => Promise<void>): PollLoop {
    // Record every queue we consume from so the reclaim sweep can walk exactly this set.
    this.#poppedQueues.add(queue);
    return this.#pollers.start(async () => {
      let job: AcquiredJob | null;
      try {
        job = await this.#adapter.popFrom(queue);
      } catch {
        // A transient adapter error: treat as "no work", retry on the next tick.
        return false;
      }
      if (!job) return false;
      try {
        await onJob(job);
        await this.#adapter.completeJob(job.id, queue);
      } catch (err) {
        this.#onError(err);
        // Delay the redelivery by one poll interval: it keeps a job nobody can handle from spinning
        // the burst-drain loop hot (a ready job makes every tick report work and never sleep).
        await this.#adapter
          .retryJob(job.id, queue, new Date(Date.now() + this.#pollIntervalMs))
          .catch((retryErr) => this.#onError(retryErr));
      }
      return true;
    });
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
   * worker's job is re-delivered, which is why {@link DEFAULT_STALLED_THRESHOLD_MS} is deliberately
   * generous. A permanently lost job is a worse failure than a rare double-run of an idempotent step, so
   * this defaults ON; set `stalledCheckIntervalMs: 0` to opt out.
   *
   * Feature-detected: an adapter that doesn't implement `recoverStalledJobs` (not every driver does)
   * simply gets no sweep — skipped silently, since a missing capability is not a transport error.
   */
  #startReclaimSweep(intervalMs: number): Pollers | undefined {
    const reclaim = (this.#adapter as { recoverStalledJobs?: unknown }).recoverStalledJobs;
    if (typeof reclaim !== 'function' || intervalMs <= 0) return undefined;
    const pollers = new Pollers(intervalMs, this.#onError);
    // Returns `false` every round so {@link Pollers} sleeps the FULL interval between sweeps — the
    // reclaim check is coarse and must not ride the fast burst-drain of the job-poll loops.
    pollers.start(async () => {
      for (const queue of this.#poppedQueues) {
        try {
          await this.#adapter.recoverStalledJobs(
            queue,
            this.#stalledThresholdMs,
            this.#maxStalledCount,
          );
        } catch (err) {
          this.#onError(err);
        }
      }
      return false;
    });
    return pollers;
  }

  /** Stop every poll loop and destroy the adapter so the process can exit. */
  async close(): Promise<void> {
    this.#pollers.stopAll();
    this.#reclaimPollers?.stopAll();
    this.#taskLoops.clear();
    await this.#adapter.destroy();
  }
}
