import { type AdmissionBackend, InMemoryAdmissionBackend } from './admission.js';
import { backoffDelay } from './backoff.js';
import { instantCheckpoint, stepCheckpoint } from './checkpoints.js';
import { type Completion } from './completion.js';
import {
  type BlockedDispatch,
  type DispatchPlan,
  WorkflowBlocked,
  controlPlaneDescriptor,
  planDispatch,
} from './dispatch-routing.js';
import { parseDuration } from './duration.js';
import { Entities, type EntityConfig } from './entities.js';
import {
  ContinueAsNew,
  FatalError,
  NonDeterminismError,
  RemoteStepTimeout,
  SignalTimeoutError,
  WorkflowSuspended,
} from './errors.js';
import { EventAccumulators, type EventBatchConfig } from './event-accumulators.js';
import { eventMatchOf, eventMatches, eventPrefix } from './events.js';
import type { WorkerDescriptor } from './handshake/descriptor.js';
import type {
  ControlPlane,
  EngineEvent,
  EngineListener,
  GroupHealth,
  Heartbeat,
  NamedTransport,
  RemoteTask,
  RunDispatcher,
  RunQuery,
  RunResult,
  RunStatus,
  SearchAttributes,
  SignalWaiter,
  StateStore,
  StepCheckpoint,
  StepDef,
  StepError,
  StepEvent,
  StepInterceptor,
  StepInvocation,
  StepKind,
  StepResult,
  Transport,
  UpdateResult,
  UpdateValidator,
  WorkflowCommand,
  WorkflowCtx,
  WorkflowDecision,
  WorkflowExecutor,
  WorkflowRun,
  WorkflowStepEvent,
} from './interfaces.js';
import type { HistoryEvent } from './interfaces.js';
import { breakpointToken, stepId } from './protocol.js';
import type { QueueConfig } from './queue.js';
import { RemoteWorkflowExecutor } from './remote-workflow-executor.js';
import type { ScheduledWorkflow } from './scheduler.js';
import { SingletonGate } from './singleton-gate.js';
import { sanitizeQueueToken, tenantGroup } from './tenant-group.js';
import { TransportPool } from './transport-pool.js';
import { workflowAls } from './workflow-als.js';
import {
  type Compensation,
  type CtxHost,
  type StepRecord,
  createWorkflowCtx,
} from './workflow-ctx.js';
import {
  type WorkflowClass,
  type WorkflowInputOf,
  type WorkflowRef,
  workflowName,
} from './workflow-ref.js';

type WorkflowFn = (ctx: WorkflowCtx, input: unknown) => Promise<unknown>;

/** Options for {@link WorkflowEngine.start}. */
export interface StartOptions {
  /** Run-scoped tags, merged with the workflow's static `workflow` config `tags` onto the run. */
  tags?: string[] | undefined;
  /** Typed, queryable run data stamped on the run (e.g. `{ amount: 200, tier: 'pro' }`). */
  searchAttributes?: SearchAttributes | undefined;
  /**
   * Dispatch priority for a remote run — stamped on the run and carried onto every {@link WorkflowTask}
   * the engine dispatches to advance it. Higher wins; absent = unprioritised. See {@link WorkflowRun.priority}.
   */
  priority?: number | undefined;
  /**
   * Worker-pool partition to stamp on THIS run, overriding the engine's own `namespace` for it — the
   * operator hook: a control-plane engine (its own namespace `undefined`/`default`) can route a run
   * to a specific tenant's pool by passing that tenant here. Absent → the engine's namespace. Once
   * stamped, the run is only picked up / resumed by an engine in the same namespace.
   */
  namespace?: string | undefined;
}

/**
 * Serialize runs of a workflow that share a key — a durable, FIFO mutex (e.g. one pipeline per base).
 * Excess runs are admitted in creation order, `limit` at a time; the rest wait (suspended) and retry
 * admission on a timer until a slot frees. Race-free on a consistent store (admission order is the
 * same `(createdAt, id)` view for every instance).
 */
export interface SingletonConfig {
  /** Derive the serialization key from the workflow input. */
  key: (input: unknown) => string;
  /** Max concurrent runs sharing the key. Default 1 (a mutex). */
  limit?: number;
  /**
   * Max GATED (waiting-for-admission) runs allowed to queue behind the `limit` in-flight ones. When
   * set, `start` rejects with {@link SingletonQueueFullError} once in-flight + gated reaches
   * `limit + maxQueueDepth` — back-pressure against an unbounded same-key backlog. Omit for the
   * default unbounded queue. Counts `pending`/`running`/`suspended` runs sharing the key.
   */
  maxQueueDepth?: number;
}

/** Union of a workflow's static tags and a run's start-time tags, de-duplicated, or undefined if none. */
function mergeTags(staticTags?: string[], runTags?: string[]): string[] | undefined {
  if (!staticTags?.length && !runTags?.length) return undefined;
  return [...new Set([...(staticTags ?? []), ...(runTags ?? [])])];
}

/** A breakpoint checkpoint's `name` is `breakpoint` (or `breakpoint:<label>`). This name — not the
 *  reused `signal` kind — is the explicit marker the dashboard and `continue()` detect it by. */
const BREAKPOINT = 'breakpoint';
const isBreakpoint = (cp: { status: string; name: string }): boolean =>
  cp.status === 'pending' && cp.name.startsWith(BREAKPOINT);

/**
 * Every `RunStatus` from which a turn's outcome (`completed` / `failed` / `suspended` / `blocked`) is a
 * LEGITIMATE transition — i.e. every status EXCEPT the three `resume()` itself refuses to re-execute
 * (`cancelled`, `completed`, `dead` — see its own admission guard and comment). `failed` is
 * deliberately included even though it reads as terminal: `resume()`'s comment is explicit that
 * "`failed` is intentionally NOT terminal here: retry resumes a failed run", so a retried turn starts
 * from a persisted `failed` status and can legitimately land on any of these outcomes again. `pending`
 * and `running`/`suspended`/`blocked` cover the normal first-turn and every resumed-turn starting
 * point (the pending→running flip always lands before a turn runs, so `pending` is never actually
 * observed here, but it is harmless to include since it isn't one of the three genuinely-final
 * statuses either).
 *
 * This is the expected-status set for every `updateRunIf` call this engine makes on a turn's outcome:
 * the write is legitimate precisely when the run has not ALREADY reached `cancelled`/`completed`/`dead`
 * through some other path (an operator's cancel, a timeout sweep, a dead-letter) while this turn's
 * outcome was being computed from a possibly-stale snapshot.
 */
const SETTLE_ELIGIBLE_STATUSES: RunStatus[] = [
  'pending',
  'running',
  'suspended',
  'blocked',
  'failed',
];

interface RegisteredWorkflow {
  name: string;
  version: string;
  fn: WorkflowFn;
  /** Static `workflow` config `tags` — merged with per-run tags onto each run at start. */
  tags?: string[] | undefined;
  /** Per-key serialization (a durable mutex). See {@link SingletonConfig}. */
  singleton?: SingletonConfig | undefined;
  /** Max wall-clock lifetime (ms) before a run is cancelled by `sweepTimeouts`. */
  executionTimeoutMs?: number | undefined;
  /** Validate the input at start; throw to reject before a run is created. Validator-agnostic. */
  validateInput?: ((input: unknown) => void | Promise<void>) | undefined;
  /** Event names that start a fresh run of this workflow when published. See `publishEvent`. */
  onEvent?: string[] | undefined;
  /** Coalesce `onEvent` triggers: debounce (fire once it's quiet) or batch (fire on size/window). */
  eventBatch?: EventBatchConfig | undefined;
  /** Set for a workflow authored in another SDK (e.g. Python): the engine advances it by dispatching
   *  workflow tasks to `executor` instead of running `fn` in-process. See {@link WorkflowExecutor}. */
  remote?: { group: string; executor: WorkflowExecutor };
  /** Capabilities a live worker must advertise to run this workflow's dispatched turns (design §7.5).
   *  Enforced for a `remote` workflow before each turn's dispatch to its group; a run parks `blocked`
   *  when no capable+compatible worker is live. Absent/empty = no requirement. */
  requires?: string[] | undefined;
}

const versionKey = (name: string, version: string): string => `${name}@${version}`;

/**
 * The routing token a dispatched step lands on: the step's own (broker-safe) name, suffixed by the
 * tenant the RUN belongs to. `runNamespace` — not the executing engine's namespace — is the tenant
 * axis, because an operator (namespace unset) drives runs of EVERY tenant: deriving the token from
 * the engine would send a tenant's work to the operator's own bare pool.
 *
 * An explicit {@link StepDef.partition} still wins, so a step pinned to a dedicated pool stays pinned.
 * `tenantGroup` maps `undefined`/`''`/`'default'` to the BARE token, so a single-pool deployment (and
 * every `default`-namespace run) keeps byte-identical wire names.
 */
function stepGroup(
  step: { name: string; partition?: string | undefined },
  runNamespace?: string | undefined,
): string {
  return tenantGroup(sanitizeQueueToken(step.name), step.partition ?? runNamespace);
}

/** The id for the next continuation of a run: `r` → `r~1` → `r~2` … (stable, traceable lineage). */
function nextContinuationId(runId: string): string {
  const m = runId.match(/^(.*)~(\d+)$/);
  return m ? `${m[1]}~${Number(m[2]) + 1}` : `${runId}~1`;
}

/** True when version `a` is newer than `b` (numeric when both parse as numbers, else natural sort). */
function isNewerVersion(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na > nb;
  return a.localeCompare(b, undefined, { numeric: true }) > 0;
}

/** What a remote worker hands back: the output plus when it actually began (for queue-wait timing). */
interface RemoteResolution {
  output: unknown;
  startedAt?: number | undefined;
  events?: StepEvent[] | undefined;
}

interface PendingRemote {
  resolve: (result: RemoteResolution) => void;
  reject: (error: Error) => void;
}

/** A terminal/suspended transition handed to {@link WorkflowEngine.settleRun}. */
type RunOutcome =
  | { kind: 'completed'; output: unknown }
  | { kind: 'failed'; error: StepError }
  | { kind: 'suspended'; wakeAt?: number | undefined };

export interface WorkflowEngineDeps {
  store: StateStore;
  /** A single task transport. Shorthand for a one-entry `transports` pool (id `default`). */
  transport?: Transport | undefined;
  /**
   * An ordered pool of named transports. The engine dispatches on the first and fails over to the
   * next on a dispatch error; a step pins one via `ctx.step(step, input, { transport: id })`. Use
   * this instead of `transport` for failover / multi-broker setups.
   */
  transports?: NamedTransport[] | undefined;
  /**
   * Cross-instance broadcast pub/sub for lifecycle events + cancellation (see {@link ControlPlane}).
   * Separate from the task `transport`; omit for a single-instance / local-only setup. A transport
   * that can also broadcast may be passed here as well.
   */
  controlPlane?: ControlPlane | undefined;
  /** Epoch-ms clock; injectable for tests. Defaults to `Date.now`. */
  clock?: (() => number) | undefined;
  /** Unique id for this engine instance, used for recovery leases. Defaults to a random id. */
  instanceId?: string | undefined;
  /**
   * Worker-pool partition for this engine. Stamped on every run it creates; the poll paths
   * (`runPending` / `recoverIncomplete` / `resumeDueTimers` / `sweepTimeouts`) only act on runs in
   * this namespace, and `resume` of a foreign run throws {@link NamespaceMismatch}.
   *
   * **Leaving it UNSET makes this engine an operator**: it drives, recovers and resumes runs of EVERY
   * namespace (the store's poll filters no-op on `undefined`) and leaves its transports on their bare
   * prefix. That is what lets one control plane serve many tenant pools — the queue a step lands on
   * is derived from the RUN's namespace, not this engine's. Set a value to scope the instance to one
   * pool instead, so ONE state store can be shared across non-interchangeable pools (e.g. local dev
   * vs a cluster). `'default'` and `''` are the bare pool, byte-identical to a single-pool deployment.
   */
  namespace?: string | undefined;
  /** Recovery lease duration in ms — how long this instance owns a run it picked up. Default 30s. */
  leaseMs?: number | undefined;
  /**
   * Flow-control admission backend for `ctx.step(step, input, { queue })`. Defaults to an in-process
   * {@link InMemoryAdmissionBackend} (per-instance caps). Inject a store/Redis-backed backend to make
   * the concurrency/rate/ordering caps GLOBAL across engine replicas.
   */
  admission?: AdmissionBackend | undefined;
  /**
   * Cap how many times crash-recovery may pick up the same still-`running` run before giving up and
   * moving it to the `dead` dead-letter state (a poison pill that crashes the process every boot).
   * Omit for unlimited (the default — recovery always retries).
   */
  maxRecoveryAttempts?: number | undefined;
  /**
   * Fallback re-drive window (ms) for a run that SUSPENDS with no natural timer — i.e. it's waiting on
   * an EVENT to wake it (a child's completion, a signal, a remote step with no `timeoutMs`) rather than
   * a `ctx.sleep`. Those events re-drive the run directly; but if the wake is LOST (the delivering pod
   * crashed / rolled mid-handoff), the run would otherwise sit `suspended` forever with `wakeAt: null` —
   * invisible to both the timer poller (no `wakeAt`) and crash-recovery (no lease). This stamps a
   * fallback `wakeAt` so {@link resumeDueTimers} re-drives it after the window; the re-drive is an
   * idempotent replay (a still-pending dependency re-suspends via the checkpoint guard, a settled one
   * advances), so it's a safe self-heal, not a retry that can double-dispatch. The primary event path
   * still wins first for a healthy run (it re-drives long before this fires), so this only ever fires
   * for a genuinely-orphaned run. Default 5min; set `0` to disable (the prior wake-forever behavior).
   */
  reconcileMs?: number | undefined;
  /**
   * Opt-in self-heal window (ms) for a remote step with NO `timeoutMs` whose dispatched job was LOST —
   * the worker crashed mid-step leaving no result, or the transport dropped the job (a Redis
   * flush/eviction, or a broker moving a stalled job to `failed` and removing it). The `pending`
   * checkpoint then has no result to resume on, and — BY DESIGN (see {@link reconcileMs}) — the
   * reconcile re-drive re-suspends a still-pending step rather than re-dispatching, so a slow-but-live
   * worker is never double-run. That safety means a genuinely-lost dispatch would otherwise hang
   * forever. When set, a reconcile re-drive that finds a remote step still `pending` PAST this window
   * re-dispatches it (bumping `attempts`, bounded by {@link remoteRedispatchMax}). Off by default:
   * re-dispatch can double-run a step whose original job is merely slow, so the window MUST exceed the
   * longest such step and the step MUST be idempotent. Prefer a per-step `timeoutMs` (tighter,
   * heartbeat-aware) where you can; this is the store-driven net for no-timeout steps that must
   * survive a lost dispatch. {@link WorkflowEngine.redispatchPending} is the manual counterpart.
   */
  remoteRedispatchMs?: number | undefined;
  /**
   * Max times {@link remoteRedispatchMs} re-dispatches one lost remote step before giving up and
   * failing it as a {@link RemoteStepError} (`code: 'remote_step_lost'`), so the run fails / dead-letters
   * instead of re-dispatching forever. Default 10. Ignored when `remoteRedispatchMs` is unset.
   */
  remoteRedispatchMax?: number | undefined;
  /**
   * Build the public callback URL for a `ctx.webhook()` token (e.g.
   * ``(t) => `https://api.example.com/durable/webhooks/${t}` ``). Populates
   * {@link DurableWebhook.url}. Omit if you build URLs yourself from the token.
   */
  webhookUrl?: ((token: string) => string) | undefined;
  /**
   * Provide the current W3C `traceparent` to stamp on each dispatched {@link RemoteTask}, so a
   * worker (including the Python SDK) continues the distributed trace. Keep core OTel-free: supply
   * `otelTraceparent` from `@dudousxd/nestjs-durable-otel`, or your own context reader. Omit to send none.
   */
  traceparent?: (() => string | undefined) | undefined;
  /**
   * Provide an opaque context carrier (tenant / user / correlation ids) to attach to each dispatched
   * {@link RemoteTask} as its `context`, so a worker (including the Python SDK) re-exposes it to the
   * step handler — cross-process propagation alongside the {@link traceparent}. Keep core dependency-free:
   * supply this from `@dudousxd/nestjs-context` or your own request-scoped reader. The engine never
   * inspects the returned object's shape. Omit to send none.
   *
   * Re-evaluated at each (re)dispatch — including a retry or a resume that the engine drives AFTER a
   * crash/scale-down, which runs OUTSIDE the originating request scope. On such a path this provider
   * may return empty or stale values (the request-scoped tenant/user is gone). Treat the carrier as
   * best-effort correlation/propagation metadata only — do NOT treat it as an authorization boundary.
   */
  context?: (() => Record<string, unknown> | undefined) | undefined;
  /**
   * Re-hydrate the originating context around a LOCAL step body, so a `@DurableStep` reader sees the
   * tenant / user / correlation ids that were live when the run was started — even on a path the
   * engine drives outside the originating request scope (a resume after crash/scale-down, a timer).
   * Given the carrier produced by {@link context} (may be empty/undefined) and the step body `fn`, it
   * runs `fn` with that context ambiently established (e.g. inside `@dudousxd/nestjs-context`'s ALS)
   * and returns its result. Keep core dependency-free: supply this from the nestjs wiring (which owns
   * nestjs-context) or your own ALS bridge. The handler signature is unchanged — re-hydration is
   * ambient. Default: passthrough (`(_, fn) => fn()`), so behavior is byte-identical when unset.
   */
  rehydrate?: (<T>(carrier: Record<string, unknown> | undefined, fn: () => T) => T) | undefined;
  /**
   * Attempts for each saga compensation when the run fails (a transient undo — e.g. a refund API
   * hiccup — gets another try). Default 1 (no retry). Compensations must be idempotent.
   */
  compensationRetries?: number | undefined;
  /**
   * Persist a `running` checkpoint when a local step's body begins, so an in-flight step shows up
   * in the dashboard (and a fresh page load / REST query) the moment it starts — not only once it
   * completes. The `step.started` lifecycle event is emitted either way (the live SSE view always
   * sees the start); this flag only controls the extra checkpoint write. Default `true`. Set
   * `false` on hot paths with many short local steps to halve their checkpoint writes — you keep
   * the live event but lose reload-survivable in-flight visibility.
   */
  trackStepStart?: boolean | undefined;
  /**
   * Where a freshly-`start`ed run executes (see {@link RunDispatcher}). Defaults to in-process: the
   * run executes on this instance asynchronously (a microtask), so `start` returns without blocking.
   * Pass a no-op dispatcher on a caller that must NOT run workflows (e.g. an API/dashboard pod), and
   * run `runPending` on a worker pod to pick those up; or a broker-backed one for a worker pool.
   */
  runDispatcher?: RunDispatcher | undefined;
  /**
   * Capabilities the control-plane itself advertises in its handshake descriptor (design §7.3). The
   * CP is a router, not an executor, so this is rarely needed — leave empty. Never gates which workers
   * are dispatchable (that's the worker descriptors); it only shapes the `missingOnLocal` delta.
   */
  controlPlaneCapabilities?: string[] | undefined;
  /**
   * The wire-protocol band the control-plane speaks, negotiated against each worker (design §7.4).
   * Defaults to the current single-major band. Widen the `range` when this CP can talk to workers on
   * an older/newer major; a worker whose band doesn't overlap this one is flagged
   * `protocol.incompatible` and its runs park `blocked` instead of dispatching into the void.
   */
  controlPlaneProtocol?: { version: number; range: [number, number] } | undefined;
  /**
   * How long (ms) a run parked `blocked` (no capable/compatible worker, design §7.5) waits before the
   * blocked-recovery poll re-drives it to re-check the live fleet. Default 5000. The run proceeds the
   * moment a capable+compatible worker appears on the next poll; a lower value trades broker SCANs for
   * faster pickup.
   */
  blockedPollMs?: number | undefined;
}

/** Thrown by {@link WorkflowEngine.resume} when the run belongs to a different namespace. */
export class NamespaceMismatch extends Error {
  constructor() {
    super('namespace-mismatch');
    this.name = 'NamespaceMismatch';
  }
}

/**
 * The orchestrator. Owns workflow state and replays runs deterministically: each step's
 * result is checkpointed, so on resume a completed step returns its saved output instead of
 * re-executing. Remote steps are dispatched over the Transport; their results checkpoint the
 * same way local steps do.
 */
export class WorkflowEngine {
  private readonly store: StateStore;
  /** Ordered transport pool (dispatch + failover). Empty = no remote steps. */
  private readonly pool: TransportPool;
  /** The primary task transport (first of the pool), used to build an on-the-fly remote-workflow
   *  executor for convention dispatch. Undefined when no transport is wired. */
  private readonly primaryTransport?: Transport | undefined;
  private readonly controlPlane?: ControlPlane | undefined;
  private readonly clock: () => number;
  private readonly instanceId: string;
  /** Worker-pool partition stamped on created runs and used to scope the poll/resume paths.
   *  `undefined` is the OPERATOR: it scopes nothing and belongs to every namespace. */
  private readonly namespace: string | undefined;
  private readonly leaseMs: number;
  private readonly maxRecoveryAttempts?: number | undefined;
  private readonly reconcileMs: number | undefined;
  private readonly remoteRedispatchMs: number | undefined;
  private readonly remoteRedispatchMax: number;
  private readonly webhookUrl?: ((token: string) => string) | undefined;
  private readonly traceparent?: (() => string | undefined) | undefined;
  private readonly context?: (() => Record<string, unknown> | undefined) | undefined;
  /** Establish the originating context ambiently around a local step body (see {@link WorkflowEngineDeps.rehydrate}). Default passthrough. */
  private readonly rehydrate: <T>(carrier: Record<string, unknown> | undefined, fn: () => T) => T;
  private readonly compensationRetries: number;
  /** Persist a `running` checkpoint at the start of a local step body (see {@link WorkflowEngineDeps.trackStepStart}). */
  private readonly trackStepStart: boolean;
  /** Where a freshly-started run executes — in-process by default (see {@link RunDispatcher}). */
  private readonly runDispatcher: RunDispatcher;
  /**
   * True when NO custom `runDispatcher` was supplied — i.e. runs execute in-process via the default
   * fire-and-forget dispatcher. Only then does an internal handoff (continue-as-new, a deferred child)
   * own the run's pickup itself (a tracked {@link runOne}) so {@link drain} spans it end to end; with a
   * custom (no-op / broker) dispatcher the run executes off this instance, so the handoff guarantees
   * only the durable persist (the in-process rolled-back-transaction hazard doesn't apply there).
   */
  private readonly usesInProcessDispatch: boolean;
  /** The control-plane's OWN handshake descriptor — negotiated against each worker's descriptor to
   *  detect protocol incompatibility before dispatch (design §7.3/§7.4). Built once at construction. */
  private readonly cpDescriptor: WorkerDescriptor;
  /** How long a `blocked` run waits before the recovery poll re-checks the live fleet (design §7.5). */
  private readonly blockedPollMs: number;

  /** Per-key serialization for singleton workflows (admission, back-pressure, notify-on-release). */
  private readonly singletons: SingletonGate;
  /** Every registered workflow, keyed by `name@version` — so old versions stay runnable. */
  private readonly workflows = new Map<string, RegisteredWorkflow>();
  /** The newest registered version per workflow name — used to `start` new runs. */
  private readonly latest = new Map<string, RegisteredWorkflow>();
  /** Event name → workflow names started when that event is published (see `onEvent`). */
  private readonly eventTriggers = new Map<string, Set<string>>();
  /** Durable-entity subsystem (registers the `__entity` runner; see `registerEntity`). */
  private readonly entities: Entities;
  /** Colocated schedules (from `static schedule`) collected during auto-discovery; see `registerSchedules`. */
  readonly #discoveredSchedules: ScheduledWorkflow[] = [];
  /** Event debounce/batch accumulators (register the `__evt_*` runners; see `accumulators.route`). */
  private readonly accumulators: EventAccumulators;
  /** In-flight remote steps awaiting a worker result, keyed by stepId. */
  private readonly pending = new Map<string, PendingRemote>();
  /** Per-step "reset the liveness timer" callbacks, called when a heartbeat arrives. */
  private readonly heartbeatResets = new Map<string, () => void>();
  private readonly listeners = new Set<EngineListener>();
  /** Step interceptors (onion middleware around real local-step execution), first = outermost. */
  private readonly interceptors: StepInterceptor[] = [];
  /** Callbacks notified (on any instance) when a run is cancelled — for cooperative cancellation. */
  private readonly cancelListeners = new Set<(runId: string) => void>();
  /** Callbacks notified when a run is enqueued elsewhere — for low-latency cross-pod dispatch. */
  private readonly enqueuedListeners = new Set<(runId: string) => void>();
  /** Notified when a run is dead-lettered (moved to `dead`) — a hook for a DLQ handler. */
  private readonly deadListeners = new Set<(run: WorkflowRun) => void>();
  /** Validators gating `engine.update`, keyed by `<workflow>:<updateName>`. */
  private readonly updateValidators = new Map<string, UpdateValidator>();
  /** Runs being cancelled WITH saga compensation — see `cancel({ compensate: true })`. */
  private readonly cancelRequested = new Set<string>();
  /** Flow-control admission backend for remote steps (see {@link registerQueue}). */
  private readonly admission: AdmissionBackend;
  /** Runs on THIS instance blocked on admission, by queue — woken early on a freed-slot signal. */
  private readonly queueWaiters = new Map<string, Set<string>>();
  /** Which queue a dispatched step took a slot from, by stepId — so the result can release it. */
  private readonly stepQueue = new Map<string, string>();
  /** Executions currently in flight, so a graceful shutdown can wait for them to settle. */
  private readonly inflight = new Set<Promise<RunResult>>();
  /**
   * Post-settle side effects (parent notify, singleton wake) fired fire-and-forget AFTER a run's
   * status was persisted. They run OFF the `execute()` path — the caller of `execute()` must never
   * block on them — but they still issue store writes (waking a suspended parent, dispatching a
   * gated singleton run), so `drain()` has to wait for them too. Left untracked, those writes can
   * land after a test's global Lucid transaction rolled back ("Transaction query already complete"
   * as an unhandled rejection) or after a graceful shutdown thought it was done. See {@link track}
   * vs {@link trackEffect}: `inflight` is the execute() path, `postSettle` is everything that
   * escapes it.
   */
  private readonly postSettle = new Set<Promise<unknown>>();
  private draining = false;

  constructor(deps: WorkflowEngineDeps) {
    this.store = deps.store;
    this.pool = new TransportPool(
      deps.transports ?? (deps.transport ? [{ id: 'default', transport: deps.transport }] : []),
    );
    this.primaryTransport = deps.transports?.[0]?.transport ?? deps.transport;
    this.controlPlane = deps.controlPlane;
    this.clock = deps.clock ?? Date.now;
    this.admission = deps.admission ?? new InMemoryAdmissionBackend(this.clock);
    // Wake this instance's admission-blocked runs the moment a slot frees anywhere in the fleet,
    // instead of waiting for their retry tick. Best-effort (the retry tick remains the guarantee).
    this.admission.onFreed?.((queue) => this.wakeQueueWaiters(queue));
    this.instanceId = deps.instanceId ?? globalThis.crypto.randomUUID();
    this.namespace = deps.namespace;
    // The control-plane's own handshake descriptor — the side negotiated AGAINST each worker so a
    // protocol-incompatible fleet is detected before dispatch (design §7.3). Scoped to this engine's
    // namespace/partition; capabilities/protocol are config-driven (default: current single major).
    this.cpDescriptor = controlPlaneDescriptor({
      instanceId: this.instanceId,
      ...(deps.controlPlaneCapabilities !== undefined
        ? { capabilities: deps.controlPlaneCapabilities }
        : {}),
      ...(deps.controlPlaneProtocol !== undefined ? { protocol: deps.controlPlaneProtocol } : {}),
      ...(this.namespace !== undefined && this.namespace !== 'default'
        ? { namespace: this.namespace }
        : {}),
    });
    this.blockedPollMs = deps.blockedPollMs ?? 5000;
    // Propagate the engine's namespace to its transport(s) so the SAME namespace that partitions the
    // store also partitions the transport's queues/keys — set once on the engine, applied everywhere.
    // The transport makes "default" a no-op (byte-identical names); an empty pool is a no-op too.
    // An operator (no namespace) skips this entirely: not calling `useNamespace` IS the bare prefix,
    // which is what it must stay on to reach every tenant's queues.
    if (this.namespace !== undefined) this.pool.useNamespace(this.namespace);
    this.leaseMs = deps.leaseMs ?? 30_000;
    this.maxRecoveryAttempts = deps.maxRecoveryAttempts;
    // Default 5min; an explicit 0 disables the fallback (opt back into wake-forever-on-lost-event).
    this.reconcileMs = deps.reconcileMs === undefined ? 300_000 : deps.reconcileMs || undefined;
    // Opt-in: unset (or 0) leaves the by-design "re-suspend a lost dispatch, never re-dispatch" behavior.
    this.remoteRedispatchMs = deps.remoteRedispatchMs || undefined;
    this.remoteRedispatchMax = Math.max(1, deps.remoteRedispatchMax ?? 10);
    this.webhookUrl = deps.webhookUrl;
    this.traceparent = deps.traceparent;
    this.context = deps.context;
    // Default passthrough: with no bridge supplied, a local step body runs exactly as before.
    this.rehydrate = deps.rehydrate ?? ((_carrier, fn) => fn());
    this.compensationRetries = Math.max(1, deps.compensationRetries ?? 1);
    this.trackStepStart = deps.trackStepStart ?? true;
    // Default: execute the run on this instance, asynchronously, so `start` never blocks on the body.
    // A failed pickup is swallowed here (the run stays `pending` for a `runPending` poll to retry);
    // run failures themselves are handled inside `execute` and surfaced as the run's `failed` state.
    this.usesInProcessDispatch = deps.runDispatcher === undefined;
    this.runDispatcher = deps.runDispatcher ?? {
      dispatch: (runId) => queueMicrotask(() => void this.runOne(runId).catch(() => {})),
    };
    this.singletons = new SingletonGate({
      store: this.store,
      clock: this.clock,
      dispatch: (runId) => {
        this.runDispatcher.dispatch(runId);
      },
      configFor: (run) =>
        (
          this.workflows.get(versionKey(run.workflow, run.workflowVersion)) ??
          this.latest.get(run.workflow)
        )?.singleton,
    });
    this.pool.bind(
      async (result) => {
        // In-memory path (a `timeoutMs` step awaiting on THIS instance): resolve its pending promise.
        const waiter = this.pending.get(result.stepId);
        if (waiter) {
          this.pending.delete(result.stepId);
          if (result.status === 'completed') {
            waiter.resolve({
              output: result.output,
              startedAt: result.startedAt,
              events: result.events,
            });
          } else {
            waiter.reject(new RemoteStepError(result.error));
          }
          return;
        }
        // Durable path: no in-memory waiter (the step suspended the run, possibly on another
        // instance) → complete the checkpoint and resume the run here.
        await this.completeRemoteResult(result);
      },
      // A heartbeat for an in-flight long step resets its liveness window (see callRemote) and is
      // persisted (throttled) on the step's checkpoint so liveness is visible cross-process.
      async (beat) => {
        this.heartbeatResets.get(beat.stepId)?.();
        this.persistHeartbeat(beat);
      },
      // A remote workflow worker streams each local step's lifecycle (running → completed/failed) so
      // it's checkpointed live, not all-at-once when the long turn ends.
      async (event) => {
        await this.persistStepEvent(event);
      },
    );
    // Control plane: re-broadcast lifecycle events from OTHER instances to this instance's
    // subscribers (cross-pod live-tail), and act on cancellations issued elsewhere. A broker may
    // echo our own publish back — ignore those (we already handled them locally) to avoid duplicates.
    this.controlPlane?.onControl((msg) => {
      if (msg.from === this.instanceId) return;
      if (msg.kind === 'event') {
        // `at` may be a string after JSON transit (Redis) — normalize back to a Date.
        this.deliver({ ...msg.event, at: new Date(msg.event.at) });
      } else if (msg.kind === 'cancel') {
        this.notifyCancelled(msg.runId);
      } else if (msg.kind === 'enqueued') {
        // A run was enqueued on another instance — let worker subscribers pick it up immediately
        // instead of waiting for the next poll. (Self-broadcasts are already filtered above.)
        for (const fn of this.enqueuedListeners) {
          try {
            fn(msg.runId);
          } catch {
            /* an enqueue listener must not break the engine */
          }
        }
      }
    });
    this.accumulators = new EventAccumulators(this);
    this.entities = new Entities(this);
  }

  /**
   * Register a **durable entity** (a virtual object): a keyed actor whose `handlers` run **serialized
   * per key** over **durable state**, exactly once. Drive it with `signalEntity` (fire) /
   * `ctx.callEntity` (call + await result) and read its state with `getEntityState`. See {@link Entities}.
   */
  registerEntity<S>(name: string, config: EntityConfig<S>): void {
    this.entities.register(name, config);
  }

  /**
   * Register colocated schedules (from a workflow class's `static schedule`) discovered during
   * `app/workflows` auto-discovery. Inert bookkeeping — this does NOT touch execution or determinism;
   * it just collects the schedules the `durable:work` worker loop later merges with `config.schedules`
   * and fires. Idempotent per `key`: the first schedule registered for a key wins and a later duplicate
   * key is ignored with a warning (so re-scanning, or a config entry overriding it, can't double-fire).
   */
  registerSchedules(schedules: readonly ScheduledWorkflow[]): void {
    const seen = new Set(this.#discoveredSchedules.map((s) => s.key));
    for (const schedule of schedules) {
      if (seen.has(schedule.key)) {
        console.warn(
          `[adonis-durable] duplicate schedule key "${schedule.key}" ignored (first registration wins).`,
        );
        continue;
      }
      seen.add(schedule.key);
      this.#discoveredSchedules.push(schedule);
    }
  }

  /** Colocated schedules discovered from `static schedule`, for the worker loop to merge with config. */
  get discoveredSchedules(): readonly ScheduledWorkflow[] {
    return this.#discoveredSchedules;
  }

  /** Send an operation to an entity (fire-and-forget). Ordered + exactly-once per key. */
  signalEntity(name: string, key: string, op: string, arg?: unknown): Promise<void> {
    return this.entities.signal(name, key, op, arg);
  }

  /** Read an entity's current durable state (published after each op), or undefined if it has none yet. */
  getEntityState<S = unknown>(name: string, key: string): Promise<S | undefined> {
    return this.entities.getState<S>(name, key);
  }

  /**
   * Be notified when a run is enqueued on ANOTHER instance (via the control plane), so a worker can
   * pick it up at once — e.g. `engine.onEnqueued((runId) => engine.runOne(runId))`. Returns an
   * unsubscribe function. Only wire this on instances that should execute runs (workers).
   */
  onEnqueued(listener: (runId: string) => void): () => void {
    this.enqueuedListeners.add(listener);
    return () => this.enqueuedListeners.delete(listener);
  }

  /** Fire cooperative-cancellation listeners for `runId` (a worker bridge aborts in-flight work). */
  private notifyCancelled(runId: string): void {
    for (const fn of this.cancelListeners) {
      try {
        fn(runId);
      } catch {
        /* a cancel listener must not break the engine */
      }
    }
  }

  /**
   * Register a workflow version. Register multiple versions of the same name to keep in-flight
   * runs working across a breaking change: old runs resume on the version they started on, new
   * runs start on the newest registered version.
   */
  register(
    name: string,
    version: string,
    fn: WorkflowFn,
    opts?: {
      tags?: string[] | undefined;
      singleton?: SingletonConfig | undefined;
      executionTimeout?: string | number | undefined;
      validateInput?: ((input: unknown) => void | Promise<void>) | undefined;
      onEvent?: string[] | undefined;
      eventBatch?: EventBatchConfig | undefined;
      requires?: string[] | undefined;
    },
  ): void {
    const registered: RegisteredWorkflow = {
      name,
      version,
      fn,
      tags: opts?.tags,
      singleton: opts?.singleton,
      executionTimeoutMs:
        opts?.executionTimeout != null ? parseDuration(opts.executionTimeout) : undefined,
      validateInput: opts?.validateInput,
      onEvent: opts?.onEvent,
      eventBatch: opts?.eventBatch,
      requires: opts?.requires,
    };
    this.workflows.set(versionKey(name, version), registered);
    const current = this.latest.get(name);
    if (!current || isNewerVersion(version, current.version)) this.latest.set(name, registered);
    for (const event of opts?.onEvent ?? []) {
      const subscribers = this.eventTriggers.get(event) ?? new Set<string>();
      subscribers.add(name);
      this.eventTriggers.set(event, subscribers);
    }
  }

  /**
   * Register a workflow whose body runs in another SDK (e.g. Python). The engine owns the run exactly
   * as for a TS workflow — it persists checkpoints, recovers, runs timers — but advances it by handing
   * the run's history to `executor` (which dispatches a {@link WorkflowTask} to the worker) and applying
   * the {@link WorkflowDecision} the worker's replay returns. The worker never touches the store.
   */
  registerRemote(
    name: string,
    version: string,
    opts: {
      group: string;
      executor: WorkflowExecutor;
      tags?: string[];
      singleton?: SingletonConfig;
      executionTimeout?: string | number;
      validateInput?: (input: unknown) => void | Promise<void>;
      requires?: string[];
    },
  ): void {
    const registered: RegisteredWorkflow = {
      name,
      version,
      // A remote workflow has no in-process body; execute() branches on `remote` before this is read.
      fn: () => {
        throw new Error(`workflow ${name} is remote — it has no in-process body`);
      },
      tags: opts.tags,
      singleton: opts.singleton,
      executionTimeoutMs:
        opts.executionTimeout != null ? parseDuration(opts.executionTimeout) : undefined,
      validateInput: opts.validateInput,
      remote: { group: opts.group, executor: opts.executor },
      requires: opts.requires,
    };
    this.workflows.set(versionKey(name, version), registered);
    const current = this.latest.get(name);
    if (!current || isNewerVersion(version, current.version)) this.latest.set(name, registered);
  }

  /**
   * Convention-dispatch resolution: when `name` isn't locally registered but a LIVE worker group of
   * the same name exists, auto-register a remote workflow routed to that group (bare group, no
   * partition) so its runs advance over the broker like any `registerRemote`'d one. Always on — the
   * queue name IS the routing, exactly as the aviary engine does — so a Python/NestJS/thin-worker
   * workflow is reached by NAME with no `registerRemote` boilerplate. Returns whether `name` is
   * registered afterwards. A no-op (returns `false`) when no transport is wired (nothing to route
   * over) or no matching worker group is live (then `start`/`resume` throws `is not registered`).
   */
  private async ensureConventionWorkflow(name: string): Promise<boolean> {
    if (!this.primaryTransport) return false;
    if (this.latest.get(name)) return true;
    const groups = await this.pool.listWorkerGroups();
    if (!groups.includes(name)) return false;
    this.registerRemote(name, '1', {
      group: name,
      executor: new RemoteWorkflowExecutor(this.primaryTransport, name),
    });
    return true;
  }

  /**
   * Register a flow-control queue referenced by `ctx.step(name, input, { queue })`. Caps concurrent
   * in-flight steps and/or the admission rate; blocked calls re-suspend and retry, so the limit is
   * durable. Per engine instance (see {@link QueueConfig}). Registering the same name replaces it.
   */
  registerQueue(config: QueueConfig): void {
    this.admission.register(config);
  }

  /** Last persisted beat per stepId (time + whether it carried progress) — the write throttle for
   *  {@link persistHeartbeat}. */
  private readonly heartbeatPersists = new Map<string, { at: number; hadProgress: boolean }>();

  /**
   * Persist a worker heartbeat on its step's checkpoint (see {@link StepCheckpoint.lastHeartbeatAt}),
   * best-effort and THROTTLED per step (≥10s between writes) — beats may arrive every few seconds
   * from a hot batch loop, and liveness observability must not turn into a per-item UPDATE storm.
   * One exemption: a beat CARRYING progress punches through when the last persisted one had none —
   * the automatic pickup beat lands first (no payload) and must not shadow the handler's first real
   * progress for a whole window. Optional store capability: no `recordStepHeartbeat` → no-op.
   * Failures are swallowed (a lost liveness update never harms the run). The throttle map is cleared
   * wholesale past 1024 entries — a rare extra write, never a leak.
   */
  private persistHeartbeat(beat: Heartbeat): void {
    if (!this.store.recordStepHeartbeat) return;
    const now = this.clock();
    const last = this.heartbeatPersists.get(beat.stepId);
    const upgradesToProgress =
      beat.progress !== undefined && last !== undefined && !last.hadProgress;
    if (last !== undefined && now - last.at < 10_000 && !upgradesToProgress) return;
    if (this.heartbeatPersists.size > 1024) this.heartbeatPersists.clear();
    this.heartbeatPersists.set(beat.stepId, { at: now, hadProgress: beat.progress !== undefined });
    void this.store
      .recordStepHeartbeat(beat.runId, beat.seq, new Date(beat.at ?? now), beat.progress)
      .catch(() => undefined);
  }

  /**
   * Declare this process a worker: flush consumer subscriptions parked by a transport whose
   * consumption was deferred (see {@link Transport.deferConsumers}). The `durable:work` loop calls
   * this before its first tick; until then a deferred-transport process (an ace command, a REPL)
   * dispatches and reads but never claims broker jobs. Idempotent; a no-op on transports that
   * never defer (in-process transports, or a broker transport left eager).
   */
  startConsumers(): void {
    this.pool.startConsumers();
  }

  /** Subscribe to lifecycle events. Returns an unsubscribe function. */
  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Register a {@link StepInterceptor} — onion middleware run around the real execution of every
   * local `ctx.step` (timing, logging, tracing, error enrichment, context propagation). First
   * registered is outermost; interceptors fire only when a step executes, never on replay. Returns
   * an unsubscribe function.
   */
  use(interceptor: StepInterceptor): () => void {
    this.interceptors.push(interceptor);
    return () => {
      const i = this.interceptors.indexOf(interceptor);
      if (i >= 0) this.interceptors.splice(i, 1);
    };
  }

  /**
   * Fold the registered interceptors around a local step body (identity when there are none), then
   * run the whole thing inside the re-hydrated originating context. The carrier is read at execution
   * time from {@link context} — the SAME reader stamped on dispatched remote tasks — so a local step
   * sees the live tenant / user / trace ids ambiently (via the {@link rehydrate} bridge). Default
   * `rehydrate` is a passthrough, so this is byte-identical to a bare body call when unwired.
   */
  private interceptStep<T>(invocation: StepInvocation, body: () => Promise<T>): Promise<T> {
    const carrier = this.context?.();
    const run = (): Promise<T> => {
      if (this.interceptors.length === 0) return body();
      const chain = this.interceptors.reduceRight<() => Promise<unknown>>(
        (next, interceptor) => () => interceptor(invocation, next),
        body as () => Promise<unknown>,
      );
      return chain() as Promise<T>;
    };
    return this.rehydrate(carrier, run);
  }

  /**
   * Be notified when a run is cancelled — on ANY instance, via the transport control plane. A
   * worker bridge can use this for cooperative cancellation: abort the in-flight work for `runId`
   * instead of finishing it just to have the result discarded. Returns an unsubscribe function.
   */
  onCancel(listener: (runId: string) => void): () => void {
    this.cancelListeners.add(listener);
    return () => this.cancelListeners.delete(listener);
  }

  /**
   * Be notified when a run is **dead-lettered** — moved to `dead` after exceeding
   * `maxRecoveryAttempts`. The listener receives the dead run (status `dead`, with its error), so a
   * DLQ handler can do something other than just leaving it parked: alert, push to a real queue, or
   * start a dead-letter workflow (e.g. `engine.onDead((run) => engine.start('pipeline-dlq', run, ...))`).
   * Returns an unsubscribe function.
   */
  onDead(listener: (run: WorkflowRun) => void): () => void {
    this.deadListeners.add(listener);
    return () => this.deadListeners.delete(listener);
  }

  private notifyDead(run: WorkflowRun): void {
    for (const fn of this.deadListeners) {
      try {
        fn(run);
      } catch {
        /* a dead-letter handler must not break recovery */
      }
    }
  }

  /** Emit a locally-produced lifecycle event: deliver to subscribers AND broadcast it on the
   *  control plane so other instances (e.g. a dashboard pod) can live-tail this run. */
  private emit(event: Omit<EngineEvent, 'at'>): void {
    const full: EngineEvent = { ...event, at: new Date() };
    this.deliver(full);
    if (this.controlPlane) {
      void this.controlPlane
        .publishControl({ kind: 'event', event: full, from: this.instanceId })
        .catch(() => {
          // control-plane delivery is best-effort observability; never break execution
        });
    }
  }

  /** Deliver an event to local subscribers only (no re-broadcast) — used for both locally-produced
   *  events and ones received from the control plane, so an event shows up once on every instance. */
  private deliver(event: EngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a misbehaving subscriber must never break workflow execution
      }
    }
  }

  async start<C extends WorkflowClass>(
    workflow: C,
    input: WorkflowInputOf<C>,
    runId: string,
    opts?: StartOptions,
  ): Promise<RunResult>;
  async start<TInput>(
    workflow: string,
    input: TInput,
    runId: string,
    opts?: StartOptions,
  ): Promise<RunResult>;
  start(
    workflow: WorkflowRef,
    input: unknown,
    runId: string,
    opts?: StartOptions,
  ): Promise<RunResult> {
    // Return startCore's promise directly (no async wrapper): the extra microtask an `async`
    // delegator inserts would shift `start`'s resolution one tick later, which is observable in the
    // dispatch timing (a freshly-dispatched run reaching `running` before `start` resolves).
    return this.startCore(workflow, input, runId, opts, true);
  }

  /**
   * The shared body of {@link start}. `dispatch` gates the fire-and-forget hand-off to the run
   * dispatcher (+ the control-plane `enqueued` nudge): the public `start` always dispatches, while an
   * internal in-process handoff ({@link handoffRun}) passes `false` to persist the run and then OWN
   * its pickup with a tracked {@link runOne} — so no detached dispatcher run races it and {@link drain}
   * spans the handoff from the parent's settle until the new run has entered `inflight` and settled.
   */
  private async startCore(
    workflow: WorkflowRef,
    input: unknown,
    runId: string,
    opts: StartOptions | undefined,
    dispatch: boolean,
  ): Promise<RunResult> {
    const name = workflowName(workflow);
    let registered = this.latest.get(name);
    // Convention dispatch: an unregistered workflow whose name matches a LIVE worker group is routed
    // to it as a remote workflow (bare group). No registration needed — the queue name is the routing;
    // when no matching group is live this is a no-op and the "not registered" throw below fires.
    if (!registered && (await this.ensureConventionWorkflow(name))) {
      registered = this.latest.get(name);
    }
    if (!registered) throw new Error(`workflow ${name} is not registered`);
    // Validate the input up front — a bad payload is rejected before any run is created.
    await registered.validateInput?.(input);
    // Idempotent by run id: a redelivered trigger (at-least-once queues) or a scheduler re-tick for
    // the same id is a no-op, returning the existing run's state instead of starting a duplicate.
    const prior = await this.store.getRun(runId);
    if (prior) {
      return { runId, status: prior.status, output: prior.output, error: prior.error };
    }
    const now = new Date();
    // A singleton workflow stamps a `singleton:<key>` tag so the admission gate (in execute) can find
    // the other in-flight runs sharing the key via a tag+status query.
    const tags = mergeTags(
      registered.tags,
      registered.singleton
        ? [...(opts?.tags ?? []), this.singletons.tag(registered.singleton, input)]
        : opts?.tags,
    );
    // Singleton back-pressure: reject a start that would grow the same-key backlog past
    // `limit + maxQueueDepth` (no-op when no maxQueueDepth is configured).
    if (registered.singleton) {
      await this.singletons.assertCapacity(name, registered.singleton, input);
    }
    const run: WorkflowRun = {
      id: runId,
      workflow: name,
      workflowVersion: registered.version,
      status: 'pending',
      namespace: opts?.namespace ?? this.namespace,
      input,
      tags,
      searchAttributes: opts?.searchAttributes,
      priority: opts?.priority,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createRun(run);
    // The run is durably enqueued; a dispatcher (in-process by default) executes it — `start` does
    // NOT run the body inline. Await the terminal/suspended state with `waitForRun(runId)` if needed.
    // An internal in-process handoff persists with `dispatch: false` and drives the pickup itself.
    if (dispatch) {
      await this.runDispatcher.dispatch(runId);
      // Nudge worker instances to pick it up now instead of on their next poll (no-op without a control
      // plane; self-receipt is filtered, so it only helps OTHER pods — e.g. an API pod's enqueue).
      if (this.controlPlane) {
        void this.controlPlane
          .publishControl({ kind: 'enqueued', runId, from: this.instanceId })
          .catch(() => undefined);
      }
    }
    return { runId, status: 'pending' };
  }

  /**
   * Bridge an INTERNAL run handoff — the next execution of a `continue-as-new`, or a deferred child
   * start — into the {@link postSettle} registry so {@link drain} cannot slip through the microtask +
   * store-I/O gap between the parent settling and the new run entering `inflight`. The bare
   * `queueMicrotask(() => void this.start(...))` these replaced left exactly that window open: the
   * parent's `execute()` promise had already left `inflight` and its post-settle effects could have
   * drained before the deferred `start` even ran — so `drain()` could observe both sets empty and
   * return early, letting the continuation's/child's store writes escape onto a torn-down connection
   * (the rolled-back Lucid test transaction → "Transaction query already complete").
   *
   * The tracked promise is registered SYNCHRONOUSLY (at the parent's settle), then defers ONE microtask
   * — preserving the original reentrancy guard so a fast child can't resume a still-suspending parent —
   * before starting. With the default in-process dispatcher it then OWNS the pickup via {@link runOne}
   * (persisting with `dispatch: false` so no detached dispatcher run races it), so the promise stays in
   * `postSettle` until the run has entered `inflight` and settled here; the run is briefly in BOTH sets,
   * which is harmless because {@link drain}'s loop re-snapshots both each iteration. With a custom
   * dispatcher the run executes off-instance, so only the durable persist is guaranteed. A start that
   * throws is handed to `onStartError` (a child delivers it to its waiting parent) instead of vanishing.
   */
  private handoffRun(
    workflow: WorkflowRef,
    input: unknown,
    runId: string,
    opts?: StartOptions,
    onStartError?: (err: unknown) => void,
  ): void {
    this.trackEffect(
      (async () => {
        // Defer one microtask: never reentrantly resume the parent that is still suspending/settling.
        await Promise.resolve();
        try {
          if (this.usesInProcessDispatch) {
            // Persist WITHOUT the fire-and-forget dispatch, then drive the pickup ourselves so this
            // promise is the SOLE executor of the run (no race with a detached dispatcher `runOne`) and
            // stays tracked until the run has entered `inflight` and settled. `runOne` no-ops (returns
            // null) on replay (the run already exists) or while draining (the run is left `pending` for
            // recovery) — the durable persist above is what matters on those paths.
            const result = await this.startCore(workflow, input, runId, opts, false);
            // Guard-free pickup: the continuation/child is in-flight work `drain()` is waiting on, so it
            // runs even while draining (a `runOne` here would no-op on `this.draining`, stranding it
            // `pending` after its persist — persisted-but-not-processed). Mirrors a signal-driven resume.
            if (result.status === 'pending') await this.leaseAndResume(runId);
          } else {
            // Custom dispatcher owns execution (possibly on another pod); guarantee the persist + its
            // normal dispatch/broadcast. The in-process rolled-back-transaction hazard doesn't apply.
            await this.startCore(workflow, input, runId, opts, true);
          }
        } catch (err) {
          if (onStartError) onStartError(err);
        }
      })(),
    );
  }

  /** Read a run's current persisted state (or null if unknown). A thin pass-through to the store. */
  getRun(runId: string): Promise<WorkflowRun | null> {
    return this.store.getRun(runId);
  }

  /**
   * List persisted runs matching `query` (newest activity first, per the store's own ordering). The
   * engine's read API for inspection surfaces (the dashboard, the `durable:runs` CLI) so they query
   * through the engine rather than reaching for its private store.
   */
  listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    return this.store.listRuns(query);
  }

  /** List a run's step checkpoints (its timeline). Part of the engine's read API; see {@link listRuns}. */
  listCheckpoints(runId: string): Promise<StepCheckpoint[]> {
    return this.store.listCheckpoints(runId);
  }

  /**
   * Hard-delete a run and its whole child subtree from the store, returning the number of runs
   * removed (0 if `runId` is unknown). Children are collected BEFORE this run's checkpoints are
   * deleted (the parent→children edge is read from them). Use for retention/cleanup; this is a
   * destructive store operation, not a cancellation — a running run should be {@link cancel}led first.
   */
  async deleteRun(runId: string): Promise<number> {
    const run = await this.store.getRun(runId);
    if (!run) return 0;
    // Collect children BEFORE deleting this run's checkpoints (getRunChildren reads them).
    let deleted = 0;
    for (const childId of await this.getRunChildren(runId)) {
      deleted += await this.deleteRun(childId);
    }
    await this.store.deleteRun(runId);
    return deleted + 1;
  }

  async resume(runId: string): Promise<RunResult> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    // A definitively-finished run must not be re-executed (e.g. a worker result landing after the
    // run was cancelled, or a duplicate resume) — that would replay the body and clobber the
    // terminal state. `failed` is intentionally NOT terminal here: retry resumes a failed run.
    if (run.status === 'cancelled' || run.status === 'completed' || run.status === 'dead') {
      return { runId, status: run.status, output: run.output, error: run.error };
    }
    // Namespace guard: release the lock and bail when this run belongs to a different worker pool.
    // Piggybacked on the existing store.getRun above — no extra async step on the happy path. An
    // undefined namespace (a store row created before the field existed) is treated as "belongs to
    // everyone" for back-compat: don't skip it. An operator (this.namespace undefined) belongs to
    // every namespace too, so the guard never applies to it — that is the whole point of the role.
    if (
      this.namespace !== undefined &&
      run.namespace !== undefined &&
      run.namespace !== this.namespace
    ) {
      await this.store.releaseRunLock(runId);
      throw new NamespaceMismatch();
    }
    // Pin to the version the run STARTED on — replay is positional, so running a changed
    // workflow body against old checkpoints would corrupt the run.
    let registered = this.workflows.get(versionKey(run.workflow, run.workflowVersion));
    // Convention dispatch: a run recovered on an instance that never registered this workflow (e.g. a
    // crash-recovery pickup) is re-routed to a live worker group of the same name, if one exists.
    if (!registered && (await this.ensureConventionWorkflow(run.workflow))) {
      registered =
        this.workflows.get(versionKey(run.workflow, run.workflowVersion)) ??
        this.latest.get(run.workflow);
    }
    if (!registered) {
      throw new Error(
        `workflow ${run.workflow}@${run.workflowVersion} is not registered — keep the prior version deployed so in-flight runs can drain (skew protection)`,
      );
    }
    return this.track(this.execute(run, registered.fn));
  }

  /** Track an in-flight execution so {@link drain} can wait for it. */
  private track(p: Promise<RunResult>): Promise<RunResult> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }

  /**
   * Track a post-settle side effect (parent notify, singleton wake) so {@link drain} waits for it,
   * WITHOUT the `execute()`/`settleRun` caller ever blocking on it — the run's result is returned
   * to its caller the moment its status is persisted; this only holds the effect for `drain()`.
   * Errors are swallowed (these are best-effort wakeups; the durable timer is the real fallback),
   * exactly as the original `void ....catch(() => undefined)` fire-and-forget did.
   */
  private trackEffect(p: Promise<unknown>): void {
    const tracked = p.catch(() => undefined);
    this.postSettle.add(tracked);
    void tracked.finally(() => this.postSettle.delete(tracked));
  }

  /**
   * Graceful shutdown: stop picking up new runs (recovery/timer become no-ops) and wait for
   * in-flight executions to settle, up to `timeoutMs`. Call from your app's shutdown hook so a
   * deploy hands off cleanly instead of leaving runs to the lease timeout.
   *
   * Because an internal handoff ({@link handoffRun}) is finishing work already in flight, `drain()`
   * follows a `continue-as-new` chain across its links (and a deferred child through its parent's
   * resume). A HOT continue-as-new loop — one that hands off to a fresh link faster than it settles —
   * therefore keeps `postSettle`/`inflight` non-empty and consumes the ENTIRE `timeoutMs` before this
   * returns. That is by design (tearing down mid-continuation would orphan the continuation's writes);
   * on timeout the frontier link is left persisted and leased, so the next boot's recovery re-drives it
   * (no loss) — the cost is spending the full timeout on shutdown. Size `timeoutMs` accordingly.
   */
  async drain(timeoutMs = 10_000): Promise<void> {
    this.draining = true;
    if (this.inflight.size === 0 && this.postSettle.size === 0) return;
    const timer = new Promise<'timeout'>((resolve) => {
      const t = setTimeout(() => resolve('timeout'), timeoutMs);
      (t as { unref?: () => void }).unref?.();
    });
    // Loop, don't snapshot-once: settling an in-flight run fires post-settle effects (parent notify,
    // singleton wake) that can resume — and thus re-inflight — another run, which settles and fires
    // more effects. Wait until BOTH sets reach steady-state empty, or the shared timer wins. The
    // `Promise<'timeout'>` sentinel is distinguishable from `allSettled`'s array so the race is
    // unambiguous even when everything resolves in the same tick.
    while (this.inflight.size > 0 || this.postSettle.size > 0) {
      const pending = Promise.allSettled([...this.inflight, ...this.postSettle]);
      const outcome = await Promise.race([pending, timer]);
      if (outcome === 'timeout') return;
    }
  }

  /**
   * Cancel in-flight runs that have outlived their workflow's `executionTimeout`. Call it from the
   * timer poller alongside {@link resumeDueTimers}. A timed-out run is moved to `cancelled` with an
   * `execution_timeout` error (terminal, so a late step result can't resurrect it).
   */
  async sweepTimeouts(now: number = this.clock()): Promise<void> {
    for (const reg of new Set(this.latest.values())) {
      if (reg.executionTimeoutMs == null) continue;
      const deadline = now - reg.executionTimeoutMs;
      const inflight = [
        ...(await this.store.listRuns({
          workflow: reg.name,
          status: 'running',
          namespace: this.namespace,
        })),
        ...(await this.store.listRuns({
          workflow: reg.name,
          status: 'suspended',
          namespace: this.namespace,
        })),
      ];
      for (const run of inflight) {
        if (run.createdAt.getTime() > deadline) continue;
        const error = { message: 'execution timeout', code: 'execution_timeout' };
        // Conditional on the exact statuses just queried: an await separates this loop's iterations
        // (and the listRuns calls above it), so this run could have settled on its own — via its own
        // in-flight turn, an operator cancel, or another sweep — in the gap. Only clobber it into
        // `cancelled` if it's still genuinely `running`/`suspended`.
        const applied = await this.store.updateRunIf(run.id, ['running', 'suspended'], {
          status: 'cancelled',
          error,
          updatedAt: new Date(),
        });
        if (!applied) continue;
        this.emit({
          type: 'run.failed',
          runId: run.id,
          workflow: run.workflow,
          namespace: run.namespace,
          error,
        });
      }
    }
  }

  /**
   * Resume every run left incomplete by a crash or deploy. Called on boot. Completed steps
   * replay from their checkpoints, so only the work that had not finished runs again.
   */
  async recoverIncomplete(nowMs: number = this.clock()): Promise<RunResult[]> {
    if (this.draining) return [];
    const results: RunResult[] = [];
    for (const run of await this.store.listIncompleteRuns(this.namespace)) {
      // A live worker renews its lease, so an acquirable lease means the run is genuinely orphaned
      // (its worker crashed). Skip the ones still owned.
      const acquired = await this.store.tryLockRun(
        run.id,
        this.instanceId,
        nowMs + this.leaseMs,
        nowMs,
      );
      if (!acquired) continue;
      // Count the attempt / dead-letter a poison pill past maxRecoveryAttempts.
      const settled = await this.countRecovery(run);
      if (settled) {
        results.push(settled);
        continue;
      }
      // Re-enqueue rather than resume inline: recovery must NOT block (boot, or a poll tick) on a
      // long workflow step. A dispatcher/worker re-runs it, replaying its checkpoints.
      await this.store.releaseRunLock(run.id);
      await this.store.updateRun(run.id, { status: 'pending', updatedAt: new Date() });
      await this.runDispatcher.dispatch(run.id);
      results.push({ runId: run.id, status: 'pending' });
    }
    return results;
  }

  /**
   * Per-recovery bookkeeping (called once the lease is held): count the attempt, or — past
   * `maxRecoveryAttempts` — move a poison pill to the `dead` dead-letter state. Returns a terminal
   * result to skip the resume, or `undefined` to proceed.
   */
  private async countRecovery(run: WorkflowRun): Promise<RunResult | undefined> {
    const attempts = (run.recoveryAttempts ?? 0) + 1;
    if (this.maxRecoveryAttempts != null && attempts > this.maxRecoveryAttempts) {
      const error = {
        message: `run exceeded maxRecoveryAttempts (${this.maxRecoveryAttempts}) — moved to dead-letter`,
        code: 'max_recovery_attempts',
      };
      await this.store.updateRun(run.id, { status: 'dead', error, updatedAt: new Date() });
      await this.store.releaseRunLock(run.id);
      this.emit({
        type: 'run.failed',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
        error,
      });
      this.notifyDead({ ...run, status: 'dead', error, recoveryAttempts: attempts });
      return { runId: run.id, status: 'dead', error };
    }
    // Count BEFORE resuming, so a crash mid-resume still advances the counter.
    await this.store.updateRun(run.id, { recoveryAttempts: attempts, updatedAt: new Date() });
    return undefined;
  }

  /**
   * Resume every suspended run whose durable timer is due — AND every run parked `blocked` (no
   * capable/compatible worker, design §7.5) whose recovery poll is due. Call periodically (a poller)
   * and on boot. A blocked run re-drives to re-check the live fleet: it dispatches the moment a
   * capable+compatible worker has appeared, else re-parks `blocked` with a fresh `wakeAt`. A run still
   * not due re-suspends cheaply without running new work.
   */
  async resumeDueTimers(nowMs: number = this.clock()): Promise<RunResult[]> {
    const due = await this.store.listDueTimers(nowMs, this.namespace);
    const blocked = await this.dueBlockedRuns(nowMs);
    return this.resumeLeased([...due, ...blocked], nowMs);
  }

  /**
   * Lease and execute one run by id — the worker side of dispatch. Acquires the recovery lease (so
   * exactly one instance runs it), then resumes the body. Returns the result, or null if another
   * instance holds the lease or the engine is draining. The default in-process dispatcher calls this;
   * a broker-backed worker calls it per consumed run id.
   */
  async runOne(runId: string): Promise<RunResult | null> {
    if (this.draining) return null;
    return this.leaseAndResume(runId);
  }

  /**
   * Lease and resume a run WITHOUT the {@link runOne} draining guard. The guard's job is to stop
   * picking up NEW work once shutdown began; but an internal handoff ({@link handoffRun}) completing a
   * continue-as-new continuation or a deferred child is finishing work already in flight — the very
   * work {@link drain} is waiting on — so it must run even while draining, exactly as a signal-driven
   * resume ({@link deliverSignal}) already does. Returns null if another instance holds the lease.
   */
  private async leaseAndResume(runId: string): Promise<RunResult | null> {
    const nowMs = this.clock();
    const acquired = await this.store.tryLockRun(
      runId,
      this.instanceId,
      nowMs + this.leaseMs,
      nowMs,
    );
    if (!acquired) return null;
    // resume() checks the namespace and throws NamespaceMismatch when it doesn't match (releasing the
    // lease) — a foreign run leased here is simply skipped rather than run.
    return this.resume(runId).catch((err) => {
      if (err instanceof NamespaceMismatch) return null;
      throw err;
    });
  }

  /**
   * Re-enqueue a run for a worker to (re-)execute — the dispatch-model **retry**. Sets it back to
   * `pending`, clears any stale lease, and dispatches; a worker resumes it (replaying its checkpoints,
   * re-attempting the failed step). Returns the enqueued state immediately — never runs the body
   * inline — or null if the run is unknown. The dashboard "retry" goes through here so it can't block
   * the HTTP request on workflow execution.
   */
  async requeue(runId: string, _seen?: Set<string>): Promise<RunResult | null> {
    const seen = _seen ?? new Set<string>();
    if (seen.has(runId)) return null;
    seen.add(runId);
    const run = await this.store.getRun(runId);
    if (!run) return null;
    // A FAILED/DEAD run's replay deterministically re-throws its recorded failures — an exhausted
    // failed checkpoint rethrows, and an awaited child's failure completion rethrows through
    // unwrapCompletion — so "retry" without resetting that state is a no-op that re-fails in
    // milliseconds. Reset the failure state first so replay RE-EXECUTES the failed parts:
    // - a `failed` checkpoint becomes retryable-now (attempts 0, wake immediately, `retryable`
    //   forced back on): the durable-retry machinery re-dispatches it as a fresh first attempt;
    // - an awaited-child `signal:child:` checkpoint holding a FAILURE completion returns to its
    //   live `running` placeholder, so replay re-registers the `child:<id>` waiter — a separately
    //   retried child's completion (already buffered, or still to come) then resumes this run.
    //   Retry child and parent in either order; signal buffering makes it converge.
    if (run.status === 'failed' || run.status === 'dead') {
      const isFailureCompletion = (v: unknown): boolean =>
        typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;
      for (const cp of await this.store.listCheckpoints(runId)) {
        if (cp.status === 'failed') {
          await this.store.saveCheckpoint({
            ...cp,
            attempts: 0,
            wakeAt: this.clock(),
            ...(cp.error ? { error: { ...cp.error, retryable: true } } : {}),
          });
        } else if (
          cp.kind === 'signal' &&
          cp.name.startsWith('signal:child:') &&
          cp.status === 'completed' &&
          isFailureCompletion(cp.output)
        ) {
          await this.store.saveCheckpoint({ ...cp, status: 'running', output: undefined });
          // CASCADE: retrying only the parent is useless in a live engine — replay re-registers
          // the `child:<id>` waiter and the reconciler re-delivers the child's still-FAILED
          // terminal state within seconds, re-failing the parent with the same error. Requeue the
          // failed child too so the pair converges: whichever finishes the handshake last (waiter
          // registered vs completion buffered) resumes the parent.
          //
          // Exception: a SUCCESS already buffered on this token (a completed `~retry~` fix of the
          // child — see notifyParent's origin delivery) is the outcome the replay will consume, so
          // re-running the failed origin would be pure waste. Peek = take + re-buffer.
          const childId = cp.name.slice('signal:child:'.length);
          // Drain-and-restore keeps relative order (a partial take+re-buffer would rotate it).
          const parked: unknown[] = [];
          for (;;) {
            const buffered = await this.store.takeBufferedSignal(`child:${childId}`);
            if (!buffered) break;
            parked.push(buffered.payload);
          }
          for (const payload of parked) await this.store.bufferSignal(`child:${childId}`, payload);
          const bufferedSuccess = parked.some(
            (payload) =>
              typeof payload === 'object' &&
              payload !== null &&
              (payload as { ok?: unknown }).ok === true,
          );
          if (!bufferedSuccess) {
            const child = await this.store.getRun(childId);
            if (child && (child.status === 'failed' || child.status === 'dead')) {
              await this.requeue(childId, seen);
            }
          }
        }
      }
    }
    await this.store.releaseRunLock(runId);
    // Explicit `error: undefined` CLEARS the stale failure (the store spreads the patch over the
    // run) — otherwise the dashboard keeps showing the old error while the run is re-executing.
    await this.store.updateRun(runId, {
      status: 'pending',
      error: undefined,
      updatedAt: new Date(),
    });
    await this.runDispatcher.dispatch(runId);
    return { runId, status: 'pending' };
  }

  /**
   * Explicitly re-dispatch every remote step of `runId` stuck `pending` — the OPERATOR escape hatch for
   * a run whose dispatched step job was LOST (worker crashed with no result, or a transport that dropped
   * the job). No automatic recovery re-drives these: a reconcile re-drive re-suspends a still-pending
   * step by design (unless `remoteRedispatchMs` is set), `recoverIncomplete` only reclaims LEASED runs,
   * and `requeue` just replays back to the pending guard. This re-enqueues the same `stepId` so the
   * (idempotent) step re-runs and its result resumes the run. Safe to call on a healthy run — it re-runs
   * only in-flight `pending` remote steps, which are idempotent by the durable contract. Returns the
   * run's current status (with the count re-dispatched), or null if the run is unknown.
   */
  async redispatchPending(runId: string): Promise<(RunResult & { redispatched: number }) | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    const pending = (await this.store.listCheckpoints(runId)).filter(
      (cp) => cp.kind === 'remote' && cp.status === 'pending',
    );
    let redispatched = 0;
    for (const cp of pending) {
      if (!cp.stepId) continue;
      const reAttempt = cp.attempts + 1;
      const reEnqueuedAt = new Date();
      await this.store.saveCheckpoint({
        ...cp,
        attempts: reAttempt,
        enqueuedAt: reEnqueuedAt,
        startedAt: reEnqueuedAt,
        finishedAt: reEnqueuedAt,
      });
      await this.dispatchRemoteTask({
        runId,
        seq: cp.seq,
        name: cp.name,
        stepId: cp.stepId,
        group: cp.workerGroup ?? sanitizeQueueToken(cp.name),
        input: cp.input,
        attempt: reAttempt,
      });
      redispatched += 1;
    }
    return { runId, status: run.status, redispatched };
  }

  /**
   * **Fix-and-replay**: re-run a run (typically a `dead`/`failed` one) with a corrected `input`, as a
   * fresh run with clean history. It's a NEW run — `newRunId` defaults to `<runId>~retry~<uuid>` — so
   * the original stays inspectable. Returns the new run's id, or null if `runId` is unknown.
   */
  async retryWithInput(
    runId: string,
    input: unknown,
    newRunId?: string,
  ): Promise<{ runId: string } | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    const id = newRunId ?? `${runId}~retry~${globalThis.crypto.randomUUID().slice(0, 8)}`;
    // Inherit the original run's namespace so a retry lands in the SAME worker-pool partition (an
    // operator-routed run keeps its tenant on retry, rather than falling back to the engine's own).
    await this.start(run.workflow, input, id, { tags: run.tags, namespace: run.namespace });
    return { runId: id };
  }

  /**
   * Pick up and execute every `pending` run — the poll-based side of dispatch for a worker pod with
   * no broker. Runs enqueued by other pods (or by a caller using a no-op dispatcher) sit `pending`
   * in the store until polled; leasing ensures exactly one pod runs each. Call periodically alongside
   * {@link resumeDueTimers}.
   */
  async runPending(nowMs: number = this.clock()): Promise<RunResult[]> {
    // Oldest-first (FIFO), capped per call so a backlog drains over several polls without one sweep
    // fetching unboundedly. A run not picked up this tick is picked up the next.
    return this.resumeLeased(await this.store.listPendingRuns(100, this.namespace), nowMs);
  }

  /**
   * Resolve once `runId` reaches a settled state — terminal (completed/failed/cancelled/dead) or
   * suspended (handed off to a timer/signal/event). The async counterpart to dispatch: pair it with
   * `start` when a call site needs the outcome — `await start(...); const r = await waitForRun(id)`.
   *
   * Pass `{ terminal: true }` to wait for a strictly TERMINAL state only (completed/failed/cancelled/
   * dead) — a `suspended` run (e.g. one parked on `ctx.sleep`/`ctx.waitForSignal`) does NOT resolve;
   * the wait continues until the run reaches an end state. This is what `BaseWorkflow.start` needs so
   * "I want the result" blocks through a suspension instead of returning early with no output. The
   * default (`terminal` unset/false) resolves on any settled state, suspended included.
   */
  waitForRun(runId: string, opts?: { timeoutMs?: number; terminal?: boolean }): Promise<RunResult> {
    const isTerminal = (s: RunStatus): boolean =>
      s === 'completed' || s === 'failed' || s === 'cancelled' || s === 'dead';
    const isSettled = (s: RunStatus): boolean => s !== 'pending' && s !== 'running';
    const shouldResolve = opts?.terminal ? isTerminal : isSettled;
    const toResult = (run: WorkflowRun): RunResult => ({
      runId,
      status: run.status,
      output: run.output,
      error: run.error,
    });
    return new Promise<RunResult>((resolve, reject) => {
      let done = false;
      let off: () => void = () => {};
      const timer =
        opts?.timeoutMs != null
          ? setTimeout(() => {
              if (done) return;
              done = true;
              off();
              reject(new Error(`waitForRun(${runId}) timed out after ${opts.timeoutMs}ms`));
            }, opts.timeoutMs)
          : undefined;
      const finish = (run: WorkflowRun): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        off();
        resolve(toResult(run));
      };
      const check = (): void => {
        void this.store.getRun(runId).then((run) => {
          if (run && shouldResolve(run.status)) finish(run);
        });
      };
      // React only to this run's settling events (not its every step event), and subscribe BEFORE the
      // initial read so a run that settles in between isn't missed.
      off = this.subscribe((ev) => {
        if (
          ev.runId === runId &&
          (ev.type === 'run.completed' || ev.type === 'run.failed' || ev.type === 'run.suspended')
        ) {
          check();
        }
      });
      check();
    });
  }

  /**
   * Resume each run only if this instance can acquire its recovery lease — so when several
   * replicas recover or poll at once, each run is picked up by exactly one of them.
   */
  private async resumeLeased(
    runs: WorkflowRun[],
    nowMs: number = this.clock(),
    onLocked?: (run: WorkflowRun) => Promise<RunResult | undefined>,
  ): Promise<RunResult[]> {
    if (this.draining) return []; // shutting down — don't pick up new runs
    const results: RunResult[] = [];
    for (const run of runs) {
      const acquired = await this.store.tryLockRun(
        run.id,
        this.instanceId,
        nowMs + this.leaseMs,
        nowMs,
      );
      if (!acquired) continue;
      // A per-run hook (recovery counting / dead-lettering) may settle the run terminally instead.
      const settled = onLocked ? await onLocked(run) : undefined;
      results.push(settled ?? (await this.resume(run.id)));
    }
    return results;
  }

  /**
   * Deliver an external signal to the run waiting on `token` and resume it with `payload`.
   * Returns the run result, or null if no run is waiting for that token.
   */
  /**
   * Publish a named event. It does two things, and returns how many runs it touched (the sum):
   *  1. **Resumes** every in-flight run waiting on it via `ctx.waitForEvent(name, { match })` whose
   *     match the payload satisfies (fan-out, vs `signal`'s point-to-point token).
   *  2. **Starts** a fresh run of every workflow registered with `onEvent: [name]`, passing the
   *     payload as input. Idempotent by `evt:<id>:<workflow>` — pass `opts.id` to dedupe redeliveries
   *     of the same logical event (default: a fresh uuid, so each publish triggers once).
   *
   * Reliable (buffered) delivery — mirrors `signalWithStart`'s reliability contract, so document it
   * exactly: a publish that resumes ≥1 live waiter, OR routes into an `eventBatch` accumulator /
   * starts ≥1 subscriber, is NOT buffered (fan-out stays live-only). A publish that touches NEITHER
   * buffers ONE copy (via {@link StateStore.bufferEvent}) unless `opts.buffer === false`, so it isn't
   * silently dropped just because nobody was listening yet. That buffered copy is consumed by the
   * FIRST future `ctx.waitForEvent(name, { match })` whose match accepts its payload — point-to-point
   * on redelivery, never by a later-registered onEvent subscriber. Right after buffering, this
   * re-checks `listSignalWaiters` ONCE (sandwich parity with `signal`'s take → buffer → re-check) so a
   * waiter that registers in the sliver between the initial miss and the buffer write is still paired
   * instead of leaving both rows stranded (`waitForEvent`'s post-registration scan is the mirror half).
   */
  async publishEvent(
    name: string,
    payload: unknown,
    opts?: { id?: string; buffer?: boolean },
  ): Promise<number> {
    let touched = 0;
    const waiters = await this.store.listSignalWaiters(eventPrefix(name));
    for (const w of waiters) {
      if (eventMatches(payload, eventMatchOf(w.token))) {
        await this.signal(w.token, payload);
        touched += 1;
      }
    }
    const subscribers = this.eventTriggers.get(name);
    if (subscribers?.size) {
      const eventId = opts?.id ?? globalThis.crypto.randomUUID();
      for (const workflow of subscribers) {
        // A subscriber that rejects the payload (validateInput) must not block the others or the
        // waiters — its run simply never starts, mirroring fire-and-forget dead-letter routing.
        try {
          const batch = this.latest.get(workflow)?.eventBatch;
          if (batch) {
            // Coalesce: route the event into a per-workflow accumulator (one long-lived run that
            // debounces/batches and then starts the target with the collected payload(s)).
            await this.accumulators.route(workflow, batch, payload);
          } else {
            await this.start(workflow, payload, `evt:${eventId}:${workflow}`);
          }
          touched += 1;
        } catch {
          // skip this subscriber
        }
      }
    }
    // Nobody received it live (no waiter matched, no subscriber exists/started) — buffer ONE copy
    // unless the caller opted out. `touched > 0` covers BOTH the waiter fan-out and the subscriber loop.
    if (touched > 0 || opts?.buffer === false) return touched;
    const bufferedId = globalThis.crypto.randomUUID();
    await this.store.bufferEvent({ name, payload, id: bufferedId, publishedAt: this.clock() });
    // Re-check: a waiter may have registered in the window between the miss above and this buffer
    // write (the events-side mirror of engine.signal's interleaving proof). Only the FIRST
    // late-registered matching waiter matters — only one buffered copy exists.
    const lateWaiters = await this.store.listSignalWaiters(eventPrefix(name));
    const lateWaiter = lateWaiters.find((w) => eventMatches(payload, eventMatchOf(w.token)));
    if (!lateWaiter) return touched;
    if (!(await this.store.removeBufferedEvent(bufferedId))) return touched; // claimed elsewhere already
    // `takeSignalWaiter` is safe here even though it deletes ANY row for the token: an event token
    // embeds this ONE `waitForEvent` call's own `runId#seq` (see eventToken in events.ts), so no other
    // registration could ever share it.
    const waiter = await this.store.takeSignalWaiter(lateWaiter.token);
    if (waiter) {
      const settled = await this.deliverSignal(waiter, payload);
      if (settled) touched += 1;
    }
    // If `waiter` is null, that exact registration resolved itself some other way in the interim (most
    // likely its own timeout deadline) — the buffered copy is already spent, so drop it rather than
    // resuming a run a second time or re-buffering for a THIRD, unrelated waiter to pick up later.
    return touched;
  }

  /**
   * Deliver a signal to an already-known waiter: write its resolving `signal:<token>` checkpoint and
   * resume the run. Shared by {@link signal}'s direct hit and its post-buffer re-check reclaim — both
   * resolve a waiter the exact same way.
   */
  private async deliverSignal(waiter: SignalWaiter, payload: unknown): Promise<RunResult | null> {
    await this.store.saveCheckpoint(
      instantCheckpoint({
        runId: waiter.runId,
        seq: waiter.seq,
        name: `signal:${waiter.token}`,
        kind: 'signal',
        output: payload,
        // Carry the awaiting command's fan group (set when a `ctx.gather_children`/`ctx.all` fan-out
        // registered this waiter) onto the resolving `signal:child:<id>` checkpoint, so the dashboard
        // groups the child fan-out vertically instead of rendering it as a sequential chain. Undefined
        // for an ordinary (non-fan) signal/child await.
        parallelGroup: waiter.parallelGroup,
      }),
    );
    return this.resume(waiter.runId);
  }

  /**
   * Deliver an external signal to the run waiting on `token`, resume it with `payload`, and return
   * the run result — or null if no run is (or ends up) waiting for it.
   *
   * Race with the waiter side (`waitForSignal`'s check → `putSignalWaiter` → re-check): a waiter can
   * register in the sliver between this method's initial `takeSignalWaiter` miss and its
   * `bufferSignal` write, and the naive old flow (buffer and return) would then leave BOTH a buffered
   * payload and a registered waiter sitting in the store with nothing left to pair them — a lost wake,
   * forever suspended. The interleaving proof: the waiter side does check → put → re-check, this side
   * does take → buffer → re-check; whichever side's SECOND look runs last always observes the other
   * side's write, and the destructive `take*` ops arbitrate so a signal is never delivered twice.
   */
  async signal(token: string, payload: unknown): Promise<RunResult | null> {
    const waiter = await this.store.takeSignalWaiter(token);
    if (waiter) return this.deliverSignal(waiter, payload);
    // No one was waiting yet — buffer it so the next `waitForSignal(token)` consumes it instead of
    // dropping it (reliable signals; the basis of `signalWithStart`).
    await this.store.bufferSignal(token, payload);
    // Re-check: a waiter may have registered in the window between the miss above and this buffer
    // write (see the interleaving proof above).
    const lateWaiter = await this.store.takeSignalWaiter(token);
    if (!lateWaiter) return null;
    const reclaimed = await this.store.takeBufferedSignal(token);
    if (!reclaimed) {
      // The waiter side won the race to consume the buffer itself (its own checkpoint+resume already
      // delivered the payload) in the sliver between our takeSignalWaiter and takeBufferedSignal just
      // above. We've already (destructively) taken `lateWaiter` off the store, but there is nothing
      // left to deliver — drop it deliberately rather than resuming the run a second time.
      return null;
    }
    return this.deliverSignal(lateWaiter, reclaimed.payload);
  }

  /**
   * Ensure a run exists for `runId`, then deliver a signal to it — atomically race-free thanks to
   * signal buffering: if the run is new (or busy / not yet waiting), the signal is buffered and
   * consumed when it reaches `waitForSignal(token)`. The canonical **durable-entity / accumulator**
   * pattern: one long-lived run per key (the `runId`) that loops on `waitForSignal`, fed events by
   * many `signalWithStart` calls. `start` is idempotent by `runId`, so concurrent callers converge on
   * one run. (Use a per-run `token`, e.g. derived from `runId`, so the signal targets this entity.)
   */
  async signalWithStart(
    workflow: WorkflowRef,
    input: unknown,
    runId: string,
    signal: { token: string; payload?: unknown },
    opts?: StartOptions,
  ): Promise<{ runId: string }> {
    // `start` is overloaded per ref kind (class | string); a `WorkflowRef` union fits neither
    // overload, so resolve to the string overload (the engine handles both at runtime).
    await this.start(workflow as string, input, runId, opts); // idempotent: no-op if run exists
    await this.signal(signal.token, signal.payload);
    return { runId };
  }

  /**
   * Report the result of a `ctx.task(name, …)` back to its run (async completion). The external
   * worker that the task dispatched to calls this when done; the run resumes with `result`. Returns
   * null if no run is waiting on the task (e.g. a duplicate/late delivery) — a safe no-op.
   */
  async completeTask(runId: string, name: string, result: unknown): Promise<RunResult | null> {
    return this.signal(`task:${runId}:${name}`, {
      ok: true,
      value: result,
    } satisfies Completion<unknown>);
  }

  /** Report that a `ctx.task` failed — the run resumes and throws a FatalError at the task. */
  async failTask(runId: string, name: string, error: string): Promise<RunResult | null> {
    return this.signal(`task:${runId}:${name}`, { ok: false, error } satisfies Completion<never>);
  }

  /**
   * Notify a parent that's waiting on `runId` as a child of its terminal outcome (the `ctx.child`
   * rendezvous). A no-op when no parent is waiting, so `execute()` can call it on every run without
   * knowing about the child feature.
   */
  private notifyParent(runId: string, completion: Completion<unknown>): void {
    // Tracked, not bare fire-and-forget: `signal` can wake a suspended parent and resume it, issuing
    // store writes that must be awaited by `drain()` even though the settling child returned already.
    this.trackEffect(this.signal(`child:${runId}`, completion));
    // A fix-and-replay run (`<origin>~retry~<hash>`) is standalone, but its SUCCESS is the
    // origin's outcome for all practical purposes: deliver it on the ORIGIN's token too, so a
    // parent that failed on that child and is retried later consumes this success (buffered or
    // live) instead of waiting on a child nobody re-runs. Failures stay retry-only — a failed
    // fix attempt must not poison the origin's token.
    const at = runId.lastIndexOf('~retry~');
    if (at !== -1 && completion.ok) {
      this.trackEffect(this.signal(`child:${runId.slice(0, at)}`, completion));
    }
  }

  /**
   * Deferred child start shared by the in-process ctx host and the remote `startChild` command.
   * Deferred (microtask) so a fast child can't reentrantly resume a still-suspending parent. A start
   * that THROWS (unregistered/unroutable workflow, input validation, singleton back-pressure, store
   * failure) must NOT be swallowed: the parent is already suspended on `child:<childId>` (the waiter
   * is put BEFORE start on every path), so a silent drop parks it in suspended-forever, invisibly
   * re-attempting on every recovery wake — a misconfigured remote child looks exactly like a healthy
   * long wait. Instead the failure is delivered to that waiter like a failed child (notifyParent):
   * the parent resumes and fails loudly with the cause. For a fire-and-forget `ctx.startChild`
   * (spawn — no waiter) the completion is buffered; a later join by the same id consumes it and
   * correctly observes the failed start.
   */
  private startChildDeferred(
    workflow: string,
    input: unknown,
    childId: string,
    opts?: StartOptions,
  ): void {
    // Tracked handoff (see {@link handoffRun}): the deferral + reentrancy guard are preserved, but the
    // start is now held in `postSettle` so `drain()` waits for the child to enter `inflight` and settle
    // rather than slipping through the gap before the deferred start ran.
    this.handoffRun(workflow, input, childId, opts, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.notifyParent(childId, {
        ok: false,
        error: `child workflow "${workflow}" failed to start: ${message}`,
      });
    });
  }

  /**
   * Cancel a run (e.g. from the dashboard). Returns null if the run does not exist. Pass
   * `{ compensate: true }` to undo the saga first: the suspended run is resumed so its completed
   * steps' compensations run in reverse (visible as `compensate:<step>` events), then it's marked
   * cancelled. Without it, cancellation is immediate (no undo).
   */
  async cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    // Already finished — nothing to cancel (and don't clobber a completed/dead run). This also stops
    // the child cascade below from looping on already-cancelled runs.
    if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'dead') {
      return { runId, status: run.status, output: run.output, error: run.error };
    }
    // Compensating cancel: resume the run with a cancellation pending — replay re-registers the saga,
    // and at the suspension point execute() runs the undo and marks it cancelled. Run that resume in
    // the BACKGROUND so the caller (e.g. an HTTP request) never blocks on replaying the workflow +
    // compensations. `execute` holds the run's lease, so this can't double-run one a live worker owns
    // (its lease acquire fails and it no-ops); the broadcast tells that worker to abort cooperatively.
    if (opts?.compensate && (run.status === 'suspended' || run.status === 'running')) {
      this.cancelRequested.add(runId);
      if (this.controlPlane) {
        void this.controlPlane
          .publishControl({ kind: 'cancel', runId, from: this.instanceId })
          .catch(() => undefined);
      }
      // Tracked (see {@link trackEffect}): the background resume replays the run and drives its saga
      // compensations to the terminal `cancelled` write. As a bare `queueMicrotask` that whole sequence
      // ran untracked — and because `resume()` only enters `inflight` once it is actually called (a
      // microtask later), `drain()` could observe both registries empty in the gap and return BEFORE the
      // compensation writes, letting them land on a torn-down connection ("Transaction query already
      // complete"). Holding the deferred resume in `postSettle` closes that gap; `resume()` then also
      // tracks its own execution in `inflight`, so the run is briefly in both sets (harmless — the drain
      // loop re-snapshots each iteration). NOT a `handoffRun`: that STARTS a new run via `startCore`;
      // here an EXISTING run is resumed, whose execution already self-tracks — only the pre-call gap
      // needed covering. The one-microtask defer is preserved; the promise is registered synchronously.
      this.trackEffect(
        Promise.resolve().then(() => this.resume(runId).then(() => this.notifyCancelled(runId))),
      );
      await this.cancelChildren(runId, opts);
      return { runId, status: run.status };
    }
    const error = { message: 'cancelled' };
    await this.store.updateRun(runId, { status: 'cancelled', error, updatedAt: new Date() });
    this.emit({
      type: 'run.failed',
      runId,
      workflow: run.workflow,
      namespace: run.namespace,
      error,
    });
    await this.cancelChildren(runId, opts);
    // Notify local cancel listeners now (a worker on this pod), and broadcast so the instance/worker
    // actually running this run learns of it and can abort cooperatively (the store already records
    // `cancelled`, but a busy worker won't re-read it).
    this.notifyCancelled(runId);
    if (this.controlPlane) {
      void this.controlPlane
        .publishControl({ kind: 'cancel', runId, from: this.instanceId })
        .catch(() => undefined);
    }
    // A cancelled singleton run frees its slot — wake the next gated waiter now (notify-on-release).
    this.trackEffect(this.singletons.wakeNext(run));
    return { runId, status: 'cancelled', error };
  }

  /**
   * Bulk-cancel every run matching a filter — e.g. cancel all `order` runs tagged `vip`, or every run
   * whose `tier` search attribute is `free`. The filter is a {@link RunQuery} (workflow / status / tag
   * / search-attribute predicates), so it reuses the same matching the dashboard list uses. Each match
   * is run through {@link cancel}, so the same plumbing applies per run: child cascade, the optional
   * saga `compensate`, local cancel listeners, and the control-plane broadcast that tells the owning
   * worker to abort. Returns one {@link RunResult} per matched run (already-finished matches report
   * their terminal status — `cancel` is a no-op on them, never clobbering a completed/dead run).
   */
  async cancelWhere(
    filter: Omit<RunQuery, 'limit' | 'offset'>,
    opts?: { compensate?: boolean },
  ): Promise<RunResult[]> {
    const runs = await this.store.listRuns(filter);
    const results: RunResult[] = [];
    for (const run of runs) {
      const r = await this.cancel(run.id, opts);
      if (r) results.push(r);
    }
    return results;
  }

  /**
   * Cascade cancellation to a run's children — both awaited (`ctx.child`, found via its live
   * `child:<id>` waiter) and fire-and-forget (`ctx.startChild`, found via its `spawn:<id>`
   * checkpoint). Recursive, so a whole subtree is cancelled; the terminal guard in `cancel` stops it
   * at finished / already-cancelled runs (no loops, no re-cancel).
   */
  private async cancelChildren(
    parentRunId: string,
    opts?: { compensate?: boolean },
  ): Promise<void> {
    for (const id of await this.getRunChildren(parentRunId)) {
      await this.cancel(id, opts).catch(() => undefined);
    }
  }

  /**
   * The ids of the runs a run spawned — both awaited (`ctx.child`) and fire-and-forget
   * (`ctx.startChild`, found via its `spawn:<id>` checkpoint). The canonical parent→children edge,
   * used for both cancellation cascades and the dashboard run-tree.
   *
   * An awaited child is discovered two ways, because the live `child:<id>` waiter only exists WHILE
   * the parent is suspended on it: the waiter resolves and is consumed the moment the child settles,
   * so a completed parent (or a completed awaited child) would otherwise drop out of the tree. The
   * `signal:child:<id>` checkpoint (the placeholder written when the parent first awaits the child,
   * overwritten as completed/failed when it settles) persists across completion, so we read both and
   * dedupe — the edge stays stable for a finished run, not just a live one.
   */
  async getRunChildren(parentRunId: string): Promise<string[]> {
    const childIds = new Set<string>();
    for (const w of await this.store.listSignalWaiters('child:')) {
      if (w.runId === parentRunId) childIds.add(w.token.slice('child:'.length));
    }
    // Targeted read: only the `signal:child:` / `spawn:` checkpoints, not the whole history. Falls
    // back to a full listCheckpoints + in-JS prefix scan for a custom store that omits the method.
    const prefixes = ['signal:child:', 'spawn:'];
    const childCheckpoints = this.store.listCheckpointsByNamePrefix
      ? await this.store.listCheckpointsByNamePrefix(parentRunId, prefixes)
      : (await this.store.listCheckpoints(parentRunId)).filter((cp) =>
          prefixes.some((p) => cp.name.startsWith(p)),
        );
    for (const cp of childCheckpoints) {
      if (cp.name.startsWith('signal:child:')) childIds.add(cp.name.slice('signal:child:'.length));
      if (cp.name.startsWith('spawn:') && typeof cp.output === 'string') childIds.add(cp.output);
    }
    return [...childIds];
  }

  /**
   * Bulk-list current signal waiters by token prefix (`''` for every waiter) — a thin passthrough to
   * the store, exposed so a caller with no store reference of its own (e.g. the dashboard's
   * `storeDashboardEngine` adapter) can do the SAME bulk scan {@link getRunChildren} already does for
   * `child:` waiters, but for `run-waiting.ts`'s `resolveRunWaiting`/`indexWaitersByRun` — naming what
   * a `suspended` run in a list row is parked on (signal/webhook/child/breakpoint) without a per-run
   * timeline fetch.
   */
  listSignalWaiters(prefix: string): Promise<SignalWaiter[]> {
    return this.store.listSignalWaiters(prefix);
  }

  /** The worker groups this engine dispatches to: every registered remote workflow's group, plus any
   *  `extra` the caller declares. Local-step groups (a group consumed by in-process `@DurableStep`
   *  workers, e.g. `pipeline`) aren't derivable from registrations — pass them via `extra` so a group
   *  with backlog and ZERO workers is still reported (the alert case has no heartbeat to discover). */
  knownGroups(extra: string[] = []): string[] {
    const groups = new Set<string>(extra);
    for (const def of this.workflows.values()) {
      if (def.remote?.group) groups.add(def.remote.group);
    }
    return [...groups];
  }

  /** Per-group worker health (queue backlog + live worker heartbeats). Covers {@link knownGroups}
   *  (so a registered group with backlog and ZERO workers still reports — the alert case) UNION the
   *  groups discovered from live heartbeats (so a local-step group like `pipeline`, not derivable
   *  from registrations, shows once its workers beat). Empty when no transport can introspect health
   *  (only the BullMQ transport implements `groupHealth`). */
  async workerHealth(extra: string[] = []): Promise<GroupHealth[]> {
    const groups = new Set([...this.knownGroups(extra), ...(await this.pool.listWorkerGroups())]);
    const out: GroupHealth[] = [];
    for (const group of groups) {
      const health = await this.pool.groupHealth(group);
      if (health) out.push(health);
    }
    return out;
  }

  /**
   * Persist a streamed local-step lifecycle event from a remote workflow worker (see
   * {@link WorkflowStepEvent}). A Python `@workflow` runs its `ctx.step`s inline over one turn that
   * can last minutes; the worker streams each step's start/finish so the engine checkpoints it LIVE —
   * a step shows `running` the moment its body begins, then resolves to `completed`/`failed` with its
   * real wall-clock window and sub-process events — instead of every step appearing at once when the
   * turn ends. The turn's final `recordStep` command re-persists the same (runId, seq) checkpoint
   * idempotently, so this is purely additive observability and never changes the run's outcome.
   */
  private async persistStepEvent(event: WorkflowStepEvent): Promise<void> {
    const startedAt = new Date(event.startedAt);
    if (event.phase === 'running') {
      await this.store.saveCheckpoint(
        stepCheckpoint({
          runId: event.runId,
          seq: event.seq,
          name: event.name,
          kind: 'local',
          status: 'running',
          events: event.events,
          attempts: 1,
          enqueuedAt: startedAt,
          startedAt,
          finishedAt: startedAt, // placeholder until the step settles
        }),
      );
      this.emit({
        type: 'step.started',
        runId: event.runId,
        seq: event.seq,
        name: event.name,
        kind: 'local',
      });
      return;
    }
    const failed = event.phase === 'failed';
    await this.store.saveCheckpoint(
      stepCheckpoint({
        runId: event.runId,
        seq: event.seq,
        name: event.name,
        kind: 'local',
        status: failed ? 'failed' : 'completed',
        output: failed ? undefined : event.output,
        error: failed ? event.error : undefined,
        events: event.events,
        attempts: 1,
        enqueuedAt: startedAt,
        startedAt,
        finishedAt: event.finishedAt != null ? new Date(event.finishedAt) : new Date(),
      }),
    );
    this.emit({
      type: failed ? 'step.failed' : 'step.completed',
      runId: event.runId,
      seq: event.seq,
      name: event.name,
      kind: 'local',
      output: failed ? undefined : event.output,
      error: failed ? event.error : undefined,
    });
  }

  /**
   * Announce a local step's body has begun and (when `trackStepStart`) checkpoint it as `running`,
   * so it's visible in flight rather than appearing only on completion. The checkpoint is a
   * placeholder overwritten by {@link completeStep}/{@link failStep}; it never short-circuits replay
   * (only `completed` does), so a crash mid-body just re-runs the step. The `step.started` event
   * fires regardless — the live SSE view sees the start even with persistence off.
   */
  private async startStep(step: StepRecord): Promise<void> {
    if (this.trackStepStart) {
      await this.store.saveCheckpoint(
        stepCheckpoint({
          runId: step.runId,
          seq: step.seq,
          name: step.name,
          kind: step.kind,
          status: 'running',
          input: step.input,
          events: step.events,
          attempts: step.attempts,
          workerGroup: step.workerGroup,
          enqueuedAt: step.enqueuedAt,
          startedAt: step.startedAt,
          finishedAt: step.startedAt, // placeholder until the body settles
        }),
      );
    }
    this.emit({
      type: 'step.started',
      runId: step.runId,
      seq: step.seq,
      name: step.name,
      kind: step.kind,
    });
  }

  /** Checkpoint a finished step and announce it — the two things that must always happen together. */
  private async completeStep(step: StepRecord & { output: unknown }): Promise<void> {
    await this.store.saveCheckpoint(
      stepCheckpoint({
        runId: step.runId,
        seq: step.seq,
        name: step.name,
        kind: step.kind,
        status: 'completed',
        input: step.input,
        output: step.output,
        events: step.events,
        attempts: step.attempts,
        workerGroup: step.workerGroup,
        enqueuedAt: step.enqueuedAt,
        startedAt: step.startedAt,
        finishedAt: new Date(),
      }),
    );
    this.emit({
      type: 'step.completed',
      runId: step.runId,
      seq: step.seq,
      name: step.name,
      kind: step.kind,
      output: step.output,
      queueMs: step.startedAt.getTime() - step.enqueuedAt.getTime(),
      durationMs: Date.now() - step.startedAt.getTime(),
    });
  }

  /** Checkpoint a step that failed terminally, so the failure point is visible (not just the run). */
  private async failStep(step: StepRecord & { error: StepError }): Promise<void> {
    await this.store.saveCheckpoint(
      stepCheckpoint({
        runId: step.runId,
        seq: step.seq,
        name: step.name,
        kind: step.kind,
        status: 'failed',
        input: step.input,
        error: step.error,
        events: step.events,
        attempts: step.attempts,
        workerGroup: step.workerGroup,
        enqueuedAt: step.enqueuedAt,
        startedAt: step.startedAt,
        finishedAt: new Date(),
      }),
    );
    this.emit({
      type: 'step.failed',
      runId: step.runId,
      seq: step.seq,
      name: step.name,
      kind: step.kind,
      error: step.error,
      queueMs: step.startedAt.getTime() - step.enqueuedAt.getTime(),
      durationMs: Date.now() - step.startedAt.getTime(),
    });
  }

  private async execute(run: WorkflowRun, fn: WorkflowFn): Promise<RunResult> {
    const registered = this.workflows.get(versionKey(run.workflow, run.workflowVersion));
    // Hold the lease for the WHOLE execution — whatever path got us here (leased sweep, a signal, a
    // remote result, a dashboard action). The leased sweeps already own it; the event-driven paths
    // don't, so acquire it here. If another instance owns it, don't double-run. While we run, renew
    // the lease periodically so a long run keeps it (a crashed worker's lease still expires and is
    // reclaimed by periodic recovery).
    const lockNow = this.clock();
    if (run.lockedBy !== this.instanceId || (run.lockedUntil ?? 0) <= lockNow) {
      if (
        !(await this.store.tryLockRun(run.id, this.instanceId, lockNow + this.leaseMs, lockNow))
      ) {
        return { runId: run.id, status: run.status };
      }
    }
    const renew = setInterval(
      () => {
        void this.store
          .renewRunLock(run.id, this.instanceId, this.clock() + this.leaseMs)
          .catch(() => undefined);
      },
      Math.max(50, Math.floor(this.leaseMs / 2)),
    );
    renew.unref?.();
    try {
      // A remote (e.g. Python) workflow is advanced by dispatching workflow tasks, not by running an
      // in-process body — but everything around it (lease, recovery, timers, the resume that lands us
      // here on a step result) is identical, so it branches here under the same lease.
      const result = registered?.remote
        ? await this.runRemoteExecution(run, registered)
        : await this.runExecution(run, fn, registered);
      // Notify-on-release: a singleton run that just reached a terminal state freed a slot — wake the
      // next gated waiter(s) now instead of waiting for the ~1s retry timer. Fire-and-forget so it
      // never blocks the settling run; the durable timer is still the cross-instance/crash fallback.
      if (
        registered?.singleton &&
        (result.status === 'completed' ||
          result.status === 'failed' ||
          result.status === 'cancelled' ||
          result.status === 'dead')
      ) {
        this.trackEffect(this.singletons.wakeNext(run));
      }
      return result;
    } finally {
      clearInterval(renew);
    }
  }

  /**
   * Advance a remote (cross-SDK) workflow one turn: hand its history to the executor (which dispatches
   * a workflow task to the worker and awaits its replay) and apply the decision. Mirrors
   * {@link runExecution}'s settle/suspend; the lease is held by {@link execute}. The result that lands
   * us back here (a remote step finished, a timer fired) goes through `resume` like any TS workflow.
   */
  /**
   * Apply a terminal/suspended transition once: persist the new run status, emit the matching
   * lifecycle event, and (on completion/failure) wake a waiting parent. Both the TS and remote
   * executors funnel their completed/failed/suspended outcomes through here so a status update can
   * never drift from its event or `notifyParent` call. Does NOT touch the run lock — each executor
   * keeps its own lease handling (the TS executor's `finally`, the remote path's caller).
   */
  private async settleRun(run: WorkflowRun, outcome: RunOutcome): Promise<RunResult> {
    const updatedAt = new Date();
    if (outcome.kind === 'completed') {
      // This outcome was computed by a turn that started from a possibly-stale run snapshot. If the
      // run reached `cancelled`/`completed`/`dead` WHILE that turn was still executing (e.g. an
      // operator's `cancel`, or `sweepTimeouts`), this now-stale "completed" outcome must not
      // resurrect/clobber it — the conditional write (status still one of SETTLE_ELIGIBLE_STATUSES) is
      // the guard; the database, not a prior JS read, arbitrates. Also clears any error from an
      // earlier failed-then-retried attempt — a completed run is a success.
      const applied = await this.store.updateRunIf(run.id, SETTLE_ELIGIBLE_STATUSES, {
        status: 'completed',
        output: outcome.output,
        error: undefined,
        updatedAt,
      });
      if (!applied) return this.echoCurrentStatus(run.id);
      this.emit({
        type: 'run.completed',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
        output: outcome.output,
      });
      this.notifyParent(run.id, { ok: true, value: outcome.output });
      return { runId: run.id, status: 'completed', output: outcome.output };
    }
    if (outcome.kind === 'failed') {
      // Same race as the `completed` branch above — guard identically.
      const applied = await this.store.updateRunIf(run.id, SETTLE_ELIGIBLE_STATUSES, {
        status: 'failed',
        error: outcome.error,
        updatedAt,
      });
      if (!applied) return this.echoCurrentStatus(run.id);
      this.emit({
        type: 'run.failed',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
        error: outcome.error,
      });
      this.notifyParent(run.id, { ok: false, error: outcome.error.message });
      return { runId: run.id, status: 'failed', error: outcome.error };
    }
    // This outcome was computed by a turn that started from a possibly-stale run snapshot. If the run
    // was cancelled WHILE that turn was still executing (e.g. `ctx.all`'s failFast cancelling a
    // sibling mid-turn — plain `cancel()` writes `cancelled` directly, without waiting for the target's
    // in-flight turn to notice), this now-stale "suspended" outcome must not resurrect it. The
    // conditional write IS the guard — it subsumes the read-then-write this branch used to do (that
    // was itself a narrower, TOCTOU-prone version of the same check, and only looked for `cancelled`;
    // this now also catches `completed`/`dead` reached via any other path mid-turn).
    const applied = await this.store.updateRunIf(run.id, SETTLE_ELIGIBLE_STATUSES, {
      status: 'suspended',
      wakeAt: this.reconcileWakeAt(outcome.wakeAt),
      updatedAt,
    });
    if (!applied) return this.echoCurrentStatus(run.id);
    this.emit({
      type: 'run.suspended',
      runId: run.id,
      workflow: run.workflow,
      namespace: run.namespace,
    });
    return { runId: run.id, status: 'suspended' };
  }

  /**
   * Re-read a run's CURRENT persisted state and report it as a `RunResult` — called when an
   * `updateRunIf` write lost the race (the run reached a terminal state via a different path while
   * this turn's outcome was being computed from a stale snapshot). No emit, no `notifyParent`: the
   * path that actually won the race already did its own emit/notify when it wrote.
   */
  private async echoCurrentStatus(runId: string): Promise<RunResult> {
    const latest = await this.store.getRun(runId);
    // A store only reports `updateRunIf` as non-applied for a row that still exists (the predicate
    // just didn't match its status) OR a row that's gone — the latter isn't reachable via any path
    // this engine takes concurrently with an in-flight turn, but report the safest terminal reading
    // (never a fabricated success) rather than throw out of a settle path.
    return {
      runId,
      status: latest?.status ?? 'cancelled',
      output: latest?.output,
      error: latest?.error,
    };
  }

  /**
   * A wakeAt to persist on a suspend: the natural timer if the turn produced one (a `ctx.sleep`, a
   * remote-step deadline), else the {@link reconcileMs} fallback so an event-waiting run (child/signal/
   * timeout-less remote step) can't be orphaned forever if its wake is lost. `undefined` only when the
   * fallback is disabled (`reconcileMs: 0`). See {@link WorkflowEngineDeps.reconcileMs}.
   */
  private reconcileWakeAt(wakeAt: number | undefined): number | undefined {
    if (wakeAt != null) return wakeAt;
    return this.reconcileMs != null ? this.clock() + this.reconcileMs : undefined;
  }

  private async runRemoteExecution(
    run: WorkflowRun,
    registered: RegisteredWorkflow,
  ): Promise<RunResult> {
    const remote = registered.remote as NonNullable<RegisteredWorkflow['remote']>;
    if (run.status === 'pending') {
      await this.store.updateRun(run.id, { status: 'running', updatedAt: new Date() });
      run.status = 'running';
      this.emit({
        type: 'run.started',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
      });
    }
    if (registered.singleton && !(await this.singletons.admit(run, registered.singleton))) {
      const wakeAt = this.singletons.retryWakeAt();
      await this.store.updateRun(run.id, { status: 'suspended', wakeAt, updatedAt: new Date() });
      this.emit({
        type: 'run.suspended',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
      });
      await this.store.releaseRunLock(run.id);
      return { runId: run.id, status: 'suspended' };
    }

    // Capability/protocol guard (design §7.5): a remote workflow's turn dispatches a WorkflowTask to
    // its group — if no live worker on that group can run it, park `blocked` before advancing rather
    // than handing the task to the executor to enqueue into a void. Re-checked each turn (recovery).
    const routePlan = await this.planRoute(remote.group, registered.requires);
    if (routePlan?.status === 'blocked') return this.parkBlocked(run, routePlan);

    const history = await this.remoteHistory(run.id);
    let decision: WorkflowDecision;
    try {
      decision = await remote.executor.advance(run, history);
    } catch (err) {
      const error = {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      };
      await this.store.updateRun(run.id, { status: 'failed', error, updatedAt: new Date() });
      this.emit({
        type: 'run.failed',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
        error,
      });
      return { runId: run.id, status: 'failed', error };
    }

    if (decision.status === 'completed') {
      // Persist the local steps THIS turn ran before marking the run done. A workflow that runs
      // straight to completion in a single turn (every step inline, never suspending — e.g. a Python
      // @workflow whose body is a sequence of ctx.step calls) emits ALL its recordStep commands on
      // this terminal turn; without applying them the run shows `completed` with zero recorded steps.
      // Only this turn's NEW steps are present (prior turns' steps replay as `found`, emitting no
      // command), so there's no duplication.
      await this.applyCommands(run, decision.commands);
      return this.settleRun(run, { kind: 'completed', output: decision.output });
    }
    if (decision.status === 'failed') {
      // Same as completed: persist the steps this turn ran — including the failed one (the worker
      // records a failed-step command before raising) — so the dashboard shows WHERE it failed.
      await this.applyCommands(run, decision.commands);
      return this.settleRun(run, {
        kind: 'failed',
        error: decision.error ?? { message: 'workflow failed' },
      });
    }

    if (decision.status === 'cancelled') {
      // The worker bailed at an op boundary because the run was cancelled mid-turn — `cancel` already
      // set status=cancelled, cascaded to children and emitted the lifecycle event. Persist the steps
      // that DID run this turn (partial progress / where it stopped) and reassert `cancelled`
      // (idempotent with `cancel`'s write; preserves the existing error). The point is to NOT resurrect
      // the run to `suspended` or flip it to `failed` — both of which a normal turn result would do.
      await this.applyCommands(run, decision.commands);
      await this.store.updateRun(run.id, { status: 'cancelled', updatedAt: new Date() });
      return { runId: run.id, status: 'cancelled' };
    }

    // continue: persist any local steps the replay ran, dispatch the blocking ops, then suspend. When
    // those resolve (a result lands, a timer fires) `resume` brings us back for the next turn.
    const wakeAt = await this.applyCommands(run, decision.commands);
    return this.settleRun(run, { kind: 'suspended', wakeAt });
  }

  /** The run's resolved durable ops as replay inputs: completed/failed steps + elapsed timers. */
  private async remoteHistory(runId: string): Promise<HistoryEvent[]> {
    const checkpoints = await this.store.listCheckpoints(runId);
    const kindOf: Record<StepKind, HistoryEvent['kind']> = {
      remote: 'call',
      local: 'step',
      sleep: 'timer',
      signal: 'signal',
    };
    const events: HistoryEvent[] = [];
    for (const cp of checkpoints) {
      if (cp.status === 'completed' || cp.status === 'failed') {
        // A child run resolves THROUGH the signal machinery (a `child:<id>` waiter notified on the
        // child's terminal state), so its checkpoint is kind `signal` with a `signal:child:` name and
        // a Completion payload. Surface it as a `child` event with the value/error unwrapped.
        if (cp.kind === 'signal' && cp.name.startsWith('signal:child:')) {
          const completion = cp.output as Completion<unknown> | undefined;
          events.push({
            seq: cp.seq,
            kind: 'child',
            output: completion?.ok ? completion.value : undefined,
            error:
              completion && completion.ok === false ? { message: completion.error } : undefined,
          });
          continue;
        }
        events.push({
          seq: cp.seq,
          kind: kindOf[cp.kind] ?? 'step',
          // A signal checkpoint's name is the internal `signal:<token>`, not the workflow-level signal
          // name the replay used — omit it so the replay matches on seq + kind (its determinism anchor).
          name: cp.kind === 'signal' ? undefined : cp.name,
          output: cp.status === 'completed' ? cp.output : undefined,
          error: cp.status === 'failed' ? cp.error : undefined,
        });
      } else if (cp.kind === 'sleep' && cp.wakeAt != null && cp.wakeAt <= this.clock()) {
        // a still-`pending` sleep whose deadline has passed reads as a resolved timer on replay.
        events.push({ seq: cp.seq, kind: 'timer', name: cp.name });
      }
    }
    return events.sort((a, b) => a.seq - b.seq);
  }

  /** Apply a turn's commands: persist recorded local steps, dispatch remote calls, schedule timers.
   *  Returns the earliest timer deadline to suspend on (or undefined — suspended on a result). */
  private async applyCommands(
    run: WorkflowRun,
    commands: WorkflowCommand[],
  ): Promise<number | undefined> {
    let wakeAt: number | undefined;
    for (const cmd of commands) {
      const at = new Date();
      const id = stepId(run.id, cmd.seq);
      if (cmd.kind === 'recordStep') {
        // Prefer the step's real wall-clock window + sub-process events (carried by the command, and
        // already streamed live via persistStepEvent) so the checkpoint shows a true duration and its
        // p-process trail — not a 0ms placeholder. Fall back to apply-time for older workers.
        const startedAt = cmd.startedAt != null ? new Date(cmd.startedAt) : at;
        const finishedAt = cmd.finishedAt != null ? new Date(cmd.finishedAt) : at;
        await this.store.saveCheckpoint(
          stepCheckpoint({
            runId: run.id,
            seq: cmd.seq,
            name: cmd.name,
            kind: 'local',
            status: cmd.error ? 'failed' : 'completed',
            output: cmd.output,
            error: cmd.error,
            events: cmd.events,
            attempts: 1,
            enqueuedAt: startedAt,
            startedAt,
            finishedAt,
          }),
        );
        this.emit({
          type: cmd.error ? 'step.failed' : 'step.completed',
          runId: run.id,
          seq: cmd.seq,
          name: cmd.name,
          kind: 'local',
          output: cmd.output,
          error: cmd.error,
        });
      } else if (cmd.kind === 'call') {
        // Idempotency (load-bearing for `ctx.gather_calls`): a fan-out re-emits its still-pending
        // `call` commands on every PARTIAL resume (a sibling settled, but not all). Without this guard
        // each re-emit would re-persist + re-dispatch an already-in-flight (or already-completed) step,
        // double-dispatching the worker and resetting attempts. So if a checkpoint for (run.id, seq)
        // already exists — pending OR terminal — skip the save + dispatch entirely; its result lands
        // independently via the remote-result path (keyed by seq, so concurrent calls never clobber).
        // Mirrors the `startChild` `getRun(childId)` guard below.
        if (await this.store.getCheckpoint(run.id, cmd.seq)) continue;
        // Route this cross-SDK-worker `call` by the SAME name-based token a native `ctx.step`
        // dispatches with (and a worker subscribes to per handler name), so a decision-driven remote
        // step and an in-process one land on the identical queue. The command's own `group` is not a
        // routing input; the run's namespace is, so a tenant's fan-out stays on the tenant's pool.
        const callToken = tenantGroup(sanitizeQueueToken(cmd.name), run.namespace);
        await this.store.saveCheckpoint(
          stepCheckpoint({
            runId: run.id,
            seq: cmd.seq,
            name: cmd.name,
            kind: 'remote',
            status: 'pending',
            input: cmd.input,
            attempts: 1,
            workerGroup: callToken,
            enqueuedAt: at,
            startedAt: at,
            finishedAt: at,
            // A `ctx.gather_calls([...])` fan-out stamps every dispatched `call` in the fan with the
            // same group, so the dashboard renders the remote steps as one parallel fan (parity with
            // the gathered `recordStep`/`startChild` tags). Undefined for a lone sequential `ctx.step`.
            parallelGroup: cmd.parallelGroup,
          }),
        );
        await this.pool.dispatch(
          {
            runId: run.id,
            seq: cmd.seq,
            name: cmd.name,
            stepId: id,
            group: callToken,
            input: cmd.input,
            traceparent: this.traceparent?.(),
            context: this.context?.(),
            attempt: 1,
          },
          undefined,
        );
        this.emit({
          type: 'step.started',
          runId: run.id,
          seq: cmd.seq,
          name: cmd.name,
          kind: 'remote',
        });
      } else if (cmd.kind === 'sleep') {
        const deadline = this.clock() + cmd.ms;
        await this.store.saveCheckpoint(
          stepCheckpoint({
            runId: run.id,
            seq: cmd.seq,
            name: `sleep:${cmd.seq}`,
            kind: 'sleep',
            status: 'pending',
            attempts: 1,
            wakeAt: deadline,
            enqueuedAt: at,
            startedAt: at,
            finishedAt: at,
          }),
        );
        wakeAt = wakeAt == null ? deadline : Math.min(wakeAt, deadline);
      } else if (cmd.kind === 'waitSignal') {
        // Park on a signal: register a waiter at this seq so engine.signal(token) lands the resolving
        // `signal` checkpoint here and resumes the run. The token is the signal name, so an external
        // engine.signal(name, payload) delivers it. If the signal was already delivered (buffered
        // before the workflow reached this point — e.g. signalWithStart), resolve it now and re-drive
        // on a macrotask, AFTER this turn suspends and frees the run lock (a re-entrant resume bails).
        const deliverBuffered = async (payload: unknown): Promise<void> => {
          await this.store.saveCheckpoint(
            instantCheckpoint({
              runId: run.id,
              seq: cmd.seq,
              name: `signal:${cmd.signal}`,
              kind: 'signal',
              output: payload,
            }),
          );
          setTimeout(() => void this.resume(run.id).catch(() => undefined), 0);
        };
        const buffered = await this.store.takeBufferedSignal(cmd.signal);
        if (buffered) {
          await deliverBuffered(buffered.payload);
        } else {
          // Same reorder as the in-process ctx.waitForSignal: register on a miss, then re-check once
          // more before suspending — closing the lost-wake window where a signal races in between the
          // miss above and the registration below (see the interleaving proof at engine.signal).
          await this.store.putSignalWaiter({ token: cmd.signal, runId: run.id, seq: cmd.seq });
          const lateBuffered = await this.store.takeBufferedSignal(cmd.signal);
          if (lateBuffered) {
            // Resolved it ourselves — remove OUR OWN row via the exact match (not
            // takeSignalWaiter(cmd.signal), which deletes ANY row for this token and could steal a
            // different run's waiter that has since claimed the same token).
            await this.store.removeSignalWaiter({ token: cmd.signal, runId: run.id, seq: cmd.seq });
            await deliverBuffered(lateBuffered.payload);
          }
        }
      } else if (cmd.kind === 'startChild') {
        // Start a child run and await it (the worker's ctx.start_child suspends until the child's
        // result is in history). Mirror the in-process `ctx.child`: register a `child:<id>` waiter at
        // this seq — the child notifies it on its terminal state (engine.notifyParent) — then start the
        // child once, deferred so a fast child can't reentrantly resume this still-suspending parent,
        // and id-idempotent so replay/recovery never double-starts it.
        const childId = `${run.id}.child.${cmd.seq}`;
        await this.store.putSignalWaiter({
          token: `child:${childId}`,
          runId: run.id,
          seq: cmd.seq,
          // A `ctx.gather_children`/`ctx.all` fan-out stamps every `startChild` in the fan with the same
          // group. Thread it onto the waiter so the child's terminal `signal:child:<id>` checkpoint
          // (written by engine.signal when the child notifies the parent) carries the group and the
          // dashboard renders the fan as one parallel group. Undefined for a lone (non-fan) child.
          parallelGroup: cmd.parallelGroup,
        });
        if (!(await this.store.getRun(childId))) {
          // Same inheritance rule as the in-process `ctx.child` path: the child belongs to the run
          // that spawned it, not to whichever engine happened to advance that run.
          this.startChildDeferred(cmd.workflow, cmd.input, childId, { namespace: run.namespace });
        }
      } else {
        throw new Error(
          `remote workflow command '${(cmd as { kind: string }).kind}' is not supported yet`,
        );
      }
    }
    return wakeAt;
  }

  /** The run body, lease held + renewed by {@link execute}. */
  private async runExecution(
    run: WorkflowRun,
    fn: WorkflowFn,
    registered: RegisteredWorkflow | undefined,
  ): Promise<RunResult> {
    // First execution of an enqueued run: mark it running and announce the start, BEFORE the singleton
    // gate — `singletons.admit` only counts `running`/`suspended` runs, so a still-`pending` run could
    // never be admitted. A resumed run is already past `pending`, so this fires exactly once.
    if (run.status === 'pending') {
      await this.store.updateRun(run.id, { status: 'running', updatedAt: new Date() });
      run.status = 'running';
      this.emit({
        type: 'run.started',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
      });
    }
    // Singleton admission gate: if this run shares its key with `limit` older in-flight runs, wait
    // (suspend on a short timer) until a slot frees instead of running now. Re-checked on each resume.
    if (registered?.singleton && !(await this.singletons.admit(run, registered.singleton))) {
      const wakeAt = this.singletons.retryWakeAt();
      await this.store.updateRun(run.id, { status: 'suspended', wakeAt, updatedAt: new Date() });
      this.emit({
        type: 'run.suspended',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
      });
      await this.store.releaseRunLock(run.id);
      return { runId: run.id, status: 'suspended' };
    }
    // Saga compensations registered by completed steps; run in reverse if the run later fails.
    const compensations: Compensation[] = [];
    // Load this run's checkpoints ONCE and key them by seq, so replaying the completed prefix reads
    // from memory instead of one `getCheckpoint` SELECT per primitive (the O(N²) replay-reads fix).
    // Read once at execution start: a checkpoint written AFTER this snapshot (the signal/timer/child
    // this resume wakes on, or one written later in this same execution) is absent from the map, and
    // the ctx falls back to the live store for any absent seq — so replay semantics are unchanged.
    const snapshot = await this.store.listCheckpoints(run.id);
    const replay = new Map<number, StepCheckpoint>();
    for (const cp of snapshot) replay.set(cp.seq, cp);
    const ctx = createWorkflowCtx(
      this.ctxHostFor(replay, run.namespace),
      run.id,
      compensations,
      run.workflow,
    );
    try {
      // Establish the ambient ctx for the duration of this body turn so context-aware statics
      // (`BaseWorkflow.start`/`dispatch`) reachable from `fn` route through this run's `ctx.child`/
      // `ctx.startChild`. Re-set on every replay turn (each is its own async scope) — correct.
      const output = await workflowAls.run(ctx, () => fn(ctx, run.input));
      return this.settleRun(run, { kind: 'completed', output });
    } catch (err) {
      if (err instanceof ContinueAsNew) {
        // Hand off to a fresh execution with a clean history: complete this run, then start the next
        // (`<id>~N`) with the new input. Deferred + idempotent by the continuation id, so a crash
        // mid-handoff re-derives the same next run instead of forking.
        await this.store.updateRun(run.id, {
          status: 'completed',
          output: undefined,
          error: undefined,
          updatedAt: new Date(),
        });
        this.emit({
          type: 'run.completed',
          runId: run.id,
          workflow: run.workflow,
          namespace: run.namespace,
        });
        this.notifyParent(run.id, { ok: true, value: undefined });
        const nextId = nextContinuationId(run.id);
        // Tracked handoff (see {@link handoffRun}): held in `postSettle` from this settle until the
        // continuation has entered `inflight` and settled, so `drain()` can't return before the next
        // run's store writes land. Still deferred + idempotent by the continuation id.
        this.handoffRun(run.workflow, err.input, nextId);
        return { runId: run.id, status: 'completed' };
      }
      if (err instanceof WorkflowBlocked) {
        // No live worker can run the next dispatch (capability/protocol) — park `blocked` with the
        // structured reason + diagnostics instead of suspending on a timer that would re-drive into the
        // same void. The blocked-recovery poll re-drives it when a capable+compatible worker appears.
        return this.parkBlocked(run, err.plan);
      }
      if (err instanceof WorkflowSuspended) {
        // A compensating cancel resumed this run to reach here: the replay re-registered the saga,
        // so undo the completed steps in reverse and mark it cancelled instead of re-suspending.
        if (this.cancelRequested.has(run.id)) {
          this.cancelRequested.delete(run.id);
          for (let i = compensations.length - 1; i >= 0; i -= 1) {
            const comp = compensations[i];
            if (comp) await this.runCompensation(run, comp);
          }
          const error = { message: 'cancelled' };
          await this.store.updateRun(run.id, { status: 'cancelled', error, updatedAt: new Date() });
          this.emit({
            type: 'run.failed',
            runId: run.id,
            workflow: run.workflow,
            namespace: run.namespace,
            error,
          });
          return { runId: run.id, status: 'cancelled', error };
        }
        return this.settleRun(run, { kind: 'suspended', wakeAt: err.wakeAt });
      }
      const error = {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      };
      // Saga: undo completed steps in reverse, each retried up to `compensationRetries`. Outcomes
      // are emitted as `compensate:<step>` step events so a stranded undo is VISIBLE (not silently
      // swallowed) in the dashboard/telescope; a failing one is still skipped so it can't mask the
      // original failure or strand the rest. (Compensations should be idempotent.)
      for (let i = compensations.length - 1; i >= 0; i -= 1) {
        const comp = compensations[i];
        if (!comp) continue;
        await this.runCompensation(run, comp);
      }
      return this.settleRun(run, { kind: 'failed', error });
    } finally {
      // Release the recovery lease once the run reaches a terminal/suspended state, so the
      // next instance (or the timer poller) can pick it up promptly.
      await this.store.releaseRunLock(run.id);
    }
  }

  /**
   * Run one saga compensation, retried up to `compensationRetries`, emitting a `compensate:<step>`
   * step event for its outcome so a stranded undo is visible. Never throws — a permanently-failing
   * compensation is skipped so it can't mask the original failure. Handles both compensation shapes:
   * a LOCAL `fn` (run in-process) and a DISPATCHED undo (an ordinary step def sent to a worker and
   * awaited inline — the worker serving its name runs it with the {@link StepUndo} envelope).
   */
  private async runCompensation(run: WorkflowRun, comp: Compensation): Promise<void> {
    const name = `compensate:${comp.name}`;
    for (let attempt = 1; attempt <= this.compensationRetries; attempt += 1) {
      const startedAt = Date.now();
      try {
        if ('fn' in comp) {
          await comp.fn();
        } else {
          await this.dispatchCompensation(run, comp.dispatch.def, comp.dispatch.args, attempt);
        }
        this.emit({
          type: 'step.completed',
          runId: run.id,
          workflow: run.workflow,
          name,
          kind: 'local',
          durationMs: Date.now() - startedAt,
        });
        return;
      } catch (err) {
        if (attempt >= this.compensationRetries) {
          this.emit({
            type: 'step.failed',
            runId: run.id,
            workflow: run.workflow,
            name,
            kind: 'local',
            error: { message: err instanceof Error ? err.message : String(err) },
            durationMs: Date.now() - startedAt,
          });
        }
      }
    }
  }

  /**
   * Dispatch a saga undo step to a worker and await its result INLINE (the saga unwind already runs
   * outside the positional replay, so this is not checkpointed — it's a one-shot dispatch + await).
   * Routes by the undo def's own name/partition token, applies its own optional input schema, and
   * honours its own liveness `timeoutMs` via the heartbeat window. Throws on a worker-reported failure
   * or timeout so `runCompensation`'s retry/skip logic applies uniformly to both compensation shapes.
   */
  private async dispatchCompensation(
    run: WorkflowRun,
    def: StepDef<unknown, unknown>,
    args: unknown,
    attempt: number,
  ): Promise<void> {
    if (this.pool.size === 0) throw new Error('dispatched compensation requires a Transport');
    const token = stepGroup(def, run.namespace);
    const validInput = def.input ? def.input.parse(args) : args;
    const id = `${run.id}:compensate:${def.name}:${attempt}`;
    const resultPromise = new Promise<RemoteResolution>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      await this.pool.dispatch({
        runId: run.id,
        seq: -1,
        name: def.name,
        stepId: id,
        group: token,
        input: validInput,
        traceparent: this.traceparent?.(),
        context: this.context?.(),
        attempt: 1,
      });
      await (def.timeoutMs
        ? this.awaitWithHeartbeat(id, resultPromise, def.timeoutMs)
        : resultPromise);
    } catch (err) {
      this.pending.delete(id);
      throw err;
    }
  }

  /** The seam handed to {@link createWorkflowCtx}: the authoring API reaches durability + lifecycle
   *  (checkpointing, dispatch, child start) through this, so the ctx primitives live in their own
   *  module and the engine stays the orchestrator. */
  private ctxHostFor(
    replay?: Map<number, StepCheckpoint>,
    runNamespace?: string | undefined,
  ): CtxHost {
    return {
      store: this.store,
      replay,
      clock: this.clock,
      webhookUrl: this.webhookUrl,
      startStep: (s) => this.startStep(s),
      completeStep: (s) => this.completeStep(s),
      failStep: (s) => this.failStep(s),
      callRemote: (runId, seq, step, input, queue, transport, admission) =>
        this.callRemote(runId, seq, step, input, queue, transport, replay, admission, runNamespace),
      // Defer so a fast child can't reentrantly resume a still-running parent. The child inherits the
      // PARENT RUN's namespace, not this engine's: an operator legitimately executes every tenant's
      // parents, and without this the child would fall to the operator's own pool.
      startChild: (workflow, input, id, priority) => {
        this.startChildDeferred(workflow, input, id, { priority, namespace: runNamespace });
      },
      // Deferred for the same reentrancy reason as `startChild` above. `cancel()` is already
      // idempotent on a terminal/cancelled run (returns its existing status without side effects), so
      // no extra guard is needed here for the failFast replay case (re-issuing the same cancel calls).
      // Tracked (see {@link trackEffect}): `cancel()` writes the child — and its whole cancel cascade —
      // to the store, so this fire-and-forget is held in `postSettle`. Fired from a settling parent
      // (e.g. failFast cancelling surviving siblings), an untracked cancel's writes could otherwise
      // escape `drain()` onto a torn-down connection ("Transaction query already complete"). The
      // one-microtask defer is preserved; the promise is registered synchronously.
      cancelChild: (childId) => {
        this.trackEffect(Promise.resolve().then(() => this.cancel(childId)));
      },
      // Shallow-merge into the run's searchAttributes (the ctx primitive makes this exactly-once).
      upsertSearchAttributes: async (runId, attrs) => {
        const run = await this.store.getRun(runId);
        await this.store.updateRun(runId, {
          searchAttributes: { ...(run?.searchAttributes ?? {}), ...attrs },
          updatedAt: new Date(),
        });
      },
      // Tracked (see {@link trackEffect}): `entities.dispatch` persists via `signalWithStart`
      // (createRun/signal on the entity's run), so this fire-and-forget is held in `postSettle` — else
      // an entity op signalled from a settling workflow could write after `drain()` returned (torn-down
      // connection → "Transaction query already complete"). The one-microtask defer is preserved; the
      // promise is registered synchronously.
      signalEntity: (name, key, op, arg, reply) => {
        this.trackEffect(
          Promise.resolve().then(() => this.entities.dispatch(name, key, op, arg, reply)),
        );
      },
      interceptStep: (invocation, body) => this.interceptStep(invocation, body),
    };
  }

  /**
   * Resume a run paused at a {@link WorkflowCtx.breakpoint} (e.g. the dashboard "continue" button).
   * Finds the run's pending breakpoint checkpoint and signals it. Returns null if the run isn't
   * paused at a breakpoint.
   */
  async continue(runId: string): Promise<RunResult | null> {
    const checkpoints = await this.store.listCheckpoints(runId);
    const bp = checkpoints.find(isBreakpoint);
    if (!bp) return null;
    return this.signal(breakpointToken(runId, bp.seq), undefined);
  }

  /**
   * Read the latest value a run published for `key` via {@link WorkflowCtx.setEvent} — a
   * side-effect-free query of a live (or finished) run's state. Returns `undefined` if the run
   * never published that key. The suspend-model counterpart of a Temporal query.
   */
  async getEvent<TValue = unknown>(runId: string, key: string): Promise<TValue | undefined> {
    const name = `event:${key}`;
    // Targeted read: the highest-seq checkpoint for this name is the most recent value (a re-published
    // key overwrites at a higher seq), matching the old "last in seq order wins" scan. Falls back to a
    // full listCheckpoints scan (last match in seq-ascending order wins) for a store that omits it.
    if (this.store.getLatestCheckpointByName) {
      const latest = await this.store.getLatestCheckpointByName(runId, name);
      return latest?.output as TValue | undefined;
    }
    // listCheckpoints is ordered by seq ascending, so the last match is the most recent value.
    let latest: TValue | undefined;
    for (const cp of await this.store.listCheckpoints(runId))
      if (cp.name === name) latest = cp.output as TValue;
    return latest;
  }

  /**
   * Register a validator gating `engine.update(runId, name, …)` for runs of `workflow`. The
   * validator runs BEFORE the update is delivered, so a rejection leaves the run untouched. One
   * validator per (workflow, update name); registering again replaces it.
   */
  registerUpdateValidator<TArg>(
    workflow: string,
    name: string,
    validate: UpdateValidator<TArg>,
  ): void {
    this.updateValidators.set(`${workflow}:${name}`, validate as UpdateValidator);
  }

  /**
   * Deliver a validated update to the run waiting at `ctx.onUpdate(name)`. Runs the registered
   * validator (if any) first: on rejection returns `{ accepted: false, reason }` without disturbing
   * the run; otherwise delivers `arg` and resumes, returning `{ accepted: true, run }` (`run` is null
   * if nothing was waiting — a too-early or duplicate update).
   */
  async update(runId: string, name: string, arg: unknown): Promise<UpdateResult> {
    const run = await this.store.getRun(runId);
    if (!run) return { accepted: false, reason: `run ${runId} not found` };
    const validate = this.updateValidators.get(`${run.workflow}:${name}`);
    if (validate) {
      try {
        const reason = await validate(arg);
        if (typeof reason === 'string' && reason.length > 0) return { accepted: false, reason };
      } catch (err) {
        return { accepted: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }
    const result = await this.signal(`update:${runId}:${name}`, arg);
    return { accepted: true, run: result };
  }

  // ---------------------------------------------------------------------------
  // Capability- & protocol-aware dispatch guard (design §7.5/§7.6)
  // ---------------------------------------------------------------------------

  /** The LIVE worker handshake descriptors advertised on `token`, read from the primary transport's
   *  descriptor keyspace. Empty when no transport can introspect it (in-process / pre-handshake broker)
   *  OR nobody is publishing — either way the guard is skipped and dispatch proceeds legacy
   *  assume-compatible (design §7.7). Never throws (the transport degrades to `[]`). */
  private async liveDescriptorsFor(token: string): Promise<WorkerDescriptor[]> {
    const read = this.primaryTransport?.listWorkerDescriptors;
    if (!read) return [];
    try {
      return await read.call(this.primaryTransport, token);
    } catch {
      return [];
    }
  }

  /**
   * Plan a dispatch to `token` for a handler requiring `requires` (design §7.5). Returns:
   * - `undefined` — NO live descriptors published on this token: the guard does not engage, so a
   *   pre-handshake fleet (or an in-process transport) keeps flowing exactly as before (design §7.7);
   * - a `routable` plan — ≥1 live worker is capability-capable AND protocol-compatible (dispatch);
   * - a `blocked` plan — descriptors exist but none can run it (park the run, never dispatch into it).
   */
  private async planRoute(
    token: string,
    requires: string[] | undefined,
  ): Promise<DispatchPlan | undefined> {
    const descriptors = await this.liveDescriptorsFor(token);
    if (descriptors.length === 0) return undefined; // legacy/no-runtime path — skip the guard
    return planDispatch(requires ?? [], descriptors, this.cpDescriptor, token);
  }

  /** Throw {@link WorkflowBlocked} when no live worker can run a dispatch to `token` — so the caller's
   *  run-execution catch parks the run `blocked` (with the plan) instead of persisting a `pending`
   *  checkpoint + dispatching into a queue nobody consumes (design §7.5). A no-op when the guard does
   *  not engage (no descriptors) or a capable+compatible worker exists. */
  private async ensureRoutable(token: string, requires: string[] | undefined): Promise<void> {
    const plan = await this.planRoute(token, requires);
    if (plan?.status === 'blocked') throw new WorkflowBlocked(plan);
  }

  /**
   * Park a run `blocked`: no live worker can run its next dispatch (design §7.5/§7.6). Persists the
   * `blocked` status with a human reason + a `wakeAt` so the blocked-recovery poll re-drives it, emits
   * the LOUD structured `capability.unavailable`/`protocol.incompatible` diagnostics event (carrying
   * both descriptors + the precise delta), and releases the run lease so any instance can re-drive it.
   * Conditional on the same {@link SETTLE_ELIGIBLE_STATUSES} set `settleRun` uses — this used to
   * re-check only `cancelled`/`completed` (a narrower, TOCTOU-prone read-then-write), silently missing
   * `failed`→retry-in-flight and `dead`; the conditional write closes both gaps atomically.
   */
  private async parkBlocked(run: WorkflowRun, blocked: BlockedDispatch): Promise<RunResult> {
    const error = { message: blocked.reason, retryable: true };
    const wakeAt = this.clock() + this.blockedPollMs;
    const applied = await this.store.updateRunIf(run.id, SETTLE_ELIGIBLE_STATUSES, {
      status: 'blocked',
      error,
      wakeAt,
      updatedAt: new Date(),
    });
    if (!applied) {
      await this.store.releaseRunLock(run.id);
      return this.echoCurrentStatus(run.id);
    }
    this.emit({
      type: blocked.code,
      runId: run.id,
      workflow: run.workflow,
      namespace: run.namespace,
      error,
      diagnostics: blocked.diagnostics,
    });
    // Release the lease so the blocked-recovery poll (this or any instance) can re-drive it promptly
    // once a capable+compatible worker appears — mirrors the suspended path's release.
    await this.store.releaseRunLock(run.id);
    return { runId: run.id, status: 'blocked', error };
  }

  /** Runs parked `blocked` whose recovery poll is due (`wakeAt <= nowMs`), namespace-scoped like
   *  {@link resumeDueTimers}. Re-driving one re-checks the live fleet: it dispatches if a
   *  capable+compatible worker has appeared, else re-parks with a fresh `wakeAt` (design §7.5). */
  private async dueBlockedRuns(nowMs: number): Promise<WorkflowRun[]> {
    const blocked = await this.store.listRuns({ statuses: ['blocked'] });
    // Unlike the store-side poll paths, this filters in memory, so the operator case is explicit:
    // an engine with no namespace drives every pool's blocked runs, exactly as it drives their
    // pending and due ones.
    return blocked.filter(
      (r) =>
        (this.namespace === undefined ||
          r.namespace === undefined ||
          r.namespace === this.namespace) &&
        r.wakeAt !== undefined &&
        r.wakeAt <= nowMs,
    );
  }

  private async callRemote<TInput, TOutput>(
    runId: string,
    seq: number,
    step: StepDef<TInput, TOutput>,
    input: TInput,
    queue?: string,
    transport?: string,
    replay?: Map<number, StepCheckpoint>,
    admission?: { priority?: number | undefined; fairnessKey?: string | undefined },
    runNamespace?: string | undefined,
  ): Promise<TOutput> {
    // Read the prefix from the per-execution snapshot (avoids the O(N²) replay SELECTs); a seq absent
    // from the snapshot — not yet dispatched, or written after the snapshot — falls back to the store.
    const existing = replay?.get(seq) ?? (await this.store.getCheckpoint(runId, seq));
    if (existing && existing.name !== step.name) {
      throw new NonDeterminismError(runId, seq, step.name, existing.name);
    }
    if (existing?.status === 'completed') return existing.output as TOutput;
    if (this.pool.size === 0) throw new Error('remote steps require a Transport');
    // A step with a liveness `timeoutMs` keeps the in-memory await + heartbeat path (re-dispatch a
    // presumed-dead worker). Without one, the call SUSPENDS DURABLY: dispatch, persist a `pending`
    // checkpoint, and let the result resume the run on whichever instance receives it — so a worker
    // pod can scale down or crash mid-step without losing the run or re-running completed work.
    if (step.timeoutMs)
      return this.callRemoteInMemory(runId, seq, step, input, transport, runNamespace);
    if (existing?.status === 'pending') {
      // Dispatched; normally we just keep waiting for the result to resume the run. But a LOST dispatch
      // (worker crashed with no result, or the transport dropped the job) would hang here forever — a
      // reconcile re-drive replays straight back to this guard. Opt-in self-heal: once the step has been
      // pending longer than `remoteRedispatchMs`, re-dispatch the same stepId (the idempotent step
      // re-runs, its result resumes the run), bounded by `remoteRedispatchMax` so a never-settling step
      // fails instead of looping. Unset (default) keeps the by-design "re-suspend, never re-dispatch".
      if (this.remoteRedispatchMs == null) throw new WorkflowSuspended();
      // Stamp a redispatch deadline (clock-space, persisted) the first time we see this pending step,
      // stable across replays and crashes — mirrors the failed-retry backoff below. The run's wakeAt
      // becomes this deadline, so a reconcile re-drive lands exactly when it's due to re-dispatch.
      if (existing.wakeAt == null) {
        const wakeAt = this.clock() + this.remoteRedispatchMs;
        await this.store.saveCheckpoint({ ...existing, wakeAt });
        throw new WorkflowSuspended(wakeAt);
      }
      if (this.clock() < existing.wakeAt) throw new WorkflowSuspended(existing.wakeAt);
      // Past the deadline with no result — the dispatch is presumed lost. Re-dispatch (bounded by
      // `remoteRedispatchMax` so a step that never settles fails the run instead of looping forever).
      if (existing.attempts >= this.remoteRedispatchMax) {
        throw new RemoteStepError({
          message: `remote step "${step.name}" lost — no result after ${existing.attempts} re-dispatch(es)`,
          code: 'remote_step_lost',
        });
      }
      const reAttempt = existing.attempts + 1;
      const nextDeadline = this.clock() + this.remoteRedispatchMs;
      const reEnqueuedAt = new Date();
      await this.store.saveCheckpoint({
        ...existing,
        attempts: reAttempt,
        wakeAt: nextDeadline,
        enqueuedAt: reEnqueuedAt,
        startedAt: reEnqueuedAt,
        finishedAt: reEnqueuedAt,
      });
      await this.dispatchRemoteTask({
        runId,
        seq,
        name: step.name,
        stepId: existing.stepId ?? stepId(runId, seq),
        group: existing.workerGroup ?? stepGroup(step, runNamespace),
        input: existing.input,
        priority: admission?.priority,
        attempt: reAttempt,
        transport,
      });
      throw new WorkflowSuspended(nextDeadline);
    }

    // Durable retry: a failed attempt re-dispatches up to `retries`, spacing attempts by `backoff` —
    // unless the worker marked the error non-retryable (a deterministic verdict like a declined card).
    // The retry deadline is stamped on the failed checkpoint as `wakeAt` (clock-space, persisted) the
    // first time we see it, so it's stable across replays and survives a crash.
    let attempt = 1;
    if (existing?.status === 'failed') {
      const maxAttempts = Math.max(1, step.retries ?? 1);
      const retryable = existing.error?.retryable !== false;
      if (!retryable || existing.attempts >= maxAttempts) throw new RemoteStepError(existing.error);
      if (existing.wakeAt == null) {
        const wakeAt = this.clock() + backoffDelay(existing.attempts, step);
        await this.store.saveCheckpoint({ ...existing, wakeAt });
        throw new WorkflowSuspended(wakeAt);
      }
      if (this.clock() < existing.wakeAt) throw new WorkflowSuspended(existing.wakeAt);
      attempt = existing.attempts + 1;
    }

    const id = stepId(runId, seq);
    // Flow control: a queued call that can't be admitted (concurrency/rate) does NOT dispatch — the
    // run re-suspends with the queue's retry time and the timer poller re-tries admission later, so
    // the limit is durable. The admitted slot is released when the result lands (completeRemoteResult).
    if (queue && this.admission.handles(queue)) {
      // Admission carries the per-call priority + fairness key (default the runId so each run is its
      // own fairness bucket), and the stepId as a STABLE waiter id so the backend tracks one waiter
      // across this call's durable retries. Ordering lives in the backend (in-process by default, or
      // global) — this is the dispatch/admission layer, not the positional replay path.
      const decision = await this.admission.tryAdmit(queue, {
        priority: admission?.priority,
        key: admission?.fairnessKey ?? runId,
        waiterId: id,
      });
      if (!decision.ok) {
        // Remember this run as blocked on `queue` so a freed-slot signal can wake it early.
        const waiters = this.queueWaiters.get(queue) ?? new Set<string>();
        waiters.add(runId);
        this.queueWaiters.set(queue, waiters);
        throw new WorkflowSuspended(decision.retryAt);
      }
      this.queueWaiters.get(queue)?.delete(runId);
      this.stepQueue.set(id, queue);
    }

    // Optional runtime schema: validate only when the def carries one (a bare `@Step()` / string-name
    // call carries none — the engine passes the input through untouched then).
    const validInput = step.input ? step.input.parse(input) : input;
    // Routing token: BY NAME (sanitized for brokers), optionally partition-suffixed. Computed once and
    // used at BOTH the checkpoint's workerGroup and the dispatched task's routing `group`, so the same
    // token the worker subscribes to per handler name serves this step.
    const token = stepGroup(step, runNamespace);
    // Capability/protocol guard (design §7.5): if the live fleet on this token can't run the step,
    // throw WorkflowBlocked BEFORE the pending checkpoint + dispatch — so the run parks `blocked`
    // (recovered by the blocked poll) instead of writing a `pending` row a `WorkflowSuspended` re-drive
    // would mistake for "already dispatched" and wait on forever. A no-op when no descriptors exist.
    await this.ensureRoutable(token, step.requires);
    const enqueuedAt = new Date();
    // Persist the pending checkpoint BEFORE dispatching, so a fast result always finds it to complete.
    await this.store.saveCheckpoint({
      runId,
      seq,
      name: step.name,
      kind: 'remote',
      stepId: id,
      status: 'pending',
      input: validInput,
      attempts: attempt,
      workerGroup: token,
      enqueuedAt,
      startedAt: enqueuedAt, // placeholders until the worker result lands
      finishedAt: enqueuedAt,
    });
    await this.dispatchRemoteTask({
      runId,
      seq,
      name: step.name,
      stepId: id,
      group: token,
      input: validInput,
      priority: admission?.priority,
      attempt,
      transport,
    });
    this.emit({ type: 'step.started', runId, seq, name: step.name, kind: 'remote' });
    throw new WorkflowSuspended();
  }

  /**
   * Enqueue a remote step task to its worker group via the transport pool. Shared by the initial
   * dispatch, the opt-in self-heal re-dispatch (see `remoteRedispatchMs`), and the explicit
   * {@link redispatchPending}. Carries the current trace/context so a re-dispatch is traceable.
   */
  private dispatchRemoteTask(task: {
    runId: string;
    seq: number;
    name: string;
    stepId: string;
    group: string;
    input: unknown;
    attempt: number;
    priority?: number | undefined;
    transport?: string | undefined;
  }): Promise<void> {
    return this.pool.dispatch(
      {
        runId: task.runId,
        seq: task.seq,
        name: task.name,
        stepId: task.stepId,
        group: task.group,
        input: task.input,
        traceparent: this.traceparent?.(),
        context: this.context?.(),
        priority: task.priority,
        attempt: task.attempt,
      },
      task.transport,
    );
  }

  /**
   * Complete a durable remote step from its worker result and resume the run — runs on whichever
   * instance receives the result (the dispatching one may be gone), so the run is crash/scale-safe.
   */
  private async completeRemoteResult(result: StepResult): Promise<void> {
    const cp = await this.store.getCheckpoint(result.runId, result.seq);
    if (!cp) return;
    const run = await this.store.getRun(result.runId);
    const terminal =
      run != null &&
      (run.status === 'completed' ||
        run.status === 'failed' ||
        run.status === 'cancelled' ||
        run.status === 'dead');
    // This does TWO durable things — settle the checkpoint, then resume the run — and only the first
    // is idempotent by its own state. So an already-settled checkpoint does NOT mean the resume half
    // also happened: the instance that settled it may have died in between, or thrown on the resume
    // (a pod without this workflow registered), and a run suspended on a remote step carries no
    // `wakeAt` — no timer or recovery sweep would ever pick it up again. A redelivered result must
    // therefore re-drive the resume rather than be dropped. Resuming twice is safe (the run lease
    // admits one executor and replay is positional); dropping the last copy is not.
    //
    // UNLESS the run is TERMINAL: resuming replays it back to LIFE (observed in production — a late
    // batch result resurrected a `failed` run into `suspended`, which then continued executing as if
    // the failure never happened, racing whatever the operator did about it, and after any saga
    // compensations already ran). Terminal is terminal — recovery of a failed run belongs to an
    // explicit `requeue`/`durable:retry`, never to a stray result.
    if (cp.status !== 'pending') {
      if (!terminal) await this.resume(result.runId);
      return;
    }
    // A result settling this step frees its flow-control slot (no-op if it wasn't queued). Done
    // before the terminal-run early-returns below, so a cancellation can't leak the slot.
    await this.releaseQueueSlot(cp.stepId);
    // Drop a late result for a run that was cancelled/finished meanwhile — don't complete the step
    // or resume (the run is already terminal). This is the engine side of cooperative cancellation.
    if (run && (run.status === 'cancelled' || run.status === 'completed')) return;
    // A late SUCCESS for a failed/dead run: salvage the finished work onto the checkpoint — an
    // explicit retry's replay then short-circuits this step instead of re-running it (the work may
    // be minutes of real compute) — but never resume. A late FAILURE has nothing to salvage: drop.
    if (run && (run.status === 'failed' || run.status === 'dead')) {
      if (result.status === 'completed') {
        await this.store.saveCheckpoint({
          ...cp,
          status: 'completed',
          output: result.output,
          events: result.events ?? cp.events,
          startedAt: result.startedAt ? new Date(result.startedAt) : cp.startedAt,
          finishedAt: new Date(),
        });
      }
      return;
    }
    const finishedAt = new Date();
    const startedAt = result.startedAt ? new Date(result.startedAt) : cp.startedAt;
    await this.store.saveCheckpoint({
      ...cp,
      status: result.status,
      output: result.status === 'completed' ? result.output : cp.output,
      error: result.error,
      events: result.events ?? cp.events,
      startedAt,
      finishedAt,
    });
    this.emit({
      type: result.status === 'completed' ? 'step.completed' : 'step.failed',
      runId: result.runId,
      seq: result.seq,
      name: cp.name,
      kind: cp.kind,
      output: result.output,
      error: result.error,
      queueMs: startedAt.getTime() - cp.enqueuedAt.getTime(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    });
    await this.resume(result.runId);
  }

  /**
   * A slot freed on `queue` (a fleet-wide signal): resume this instance's runs blocked on it so they
   * re-contend now instead of at their retry tick. Snapshot-and-clear — a run still blocked after the
   * retry re-registers itself, and one that's gone (cancelled/admitted) is dropped. Best-effort.
   */
  private wakeQueueWaiters(queue: string): void {
    const waiters = this.queueWaiters.get(queue);
    if (!waiters || waiters.size === 0) return;
    const runIds = [...waiters];
    waiters.clear();
    for (const runId of runIds) void this.resume(runId).catch(() => undefined);
  }

  /** Release the flow-control slot a dispatched step held (if any), by its stepId. */
  private async releaseQueueSlot(id: string): Promise<void> {
    const queue = this.stepQueue.get(id);
    if (queue === undefined) return;
    this.stepQueue.delete(id);
    await this.admission.release(queue, id);
  }

  /** In-memory await path for a remote step with a liveness `timeoutMs` (re-dispatch on timeout). */
  private async callRemoteInMemory<TInput, TOutput>(
    runId: string,
    seq: number,
    step: StepDef<TInput, TOutput>,
    input: TInput,
    transport?: string,
    runNamespace?: string | undefined,
  ): Promise<TOutput> {
    if (this.pool.size === 0) throw new Error('remote steps require a Transport');
    const validInput = step.input ? step.input.parse(input) : input;
    const token = stepGroup(step, runNamespace);
    // Capability/protocol guard (design §7.5) — same as the durable path, before the `step.started`
    // emit + dispatch, so a step nobody can run parks `blocked` instead of awaiting a phantom worker.
    await this.ensureRoutable(token, step.requires);
    const id = stepId(runId, seq);
    const enqueuedAt = new Date();
    this.emit({ type: 'step.started', runId, seq, name: step.name, kind: 'remote' });
    // Retry policy differs from a LOCAL step on purpose: a local `ctx.step` retries any non-fatal
    // throw (the work is in-process), but a remote step only re-dispatches on a liveness TIMEOUT
    // (presumed-dead worker). A worker that *reported* an error returned a deterministic verdict, so
    // we surface it to the workflow instead of hammering the worker. Timeout retries need a window
    // to detect death, so they're gated on `timeoutMs` being set.
    const maxAttempts = step.timeoutMs ? Math.max(1, step.retries ?? 1) : 1;

    for (let attempt = 1; ; attempt += 1) {
      const resultPromise = new Promise<RemoteResolution>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
      });
      // Persist the in-flight `pending` checkpoint BEFORE dispatching. The in-memory await needs no
      // row to resume — but without one this step was INVISIBLE outside this process (no liveness
      // surface, nowhere for worker heartbeats to land) and a result consumed by another engine
      // instance (shared results queue) found no checkpoint and was dropped. Replay-safe: a replayed
      // `timeoutMs` step routes back here regardless of a pending row (see callRemote's routing),
      // and `completeStep` below overwrites this row when the result lands.
      const attemptAt = attempt === 1 ? enqueuedAt : new Date();
      await this.store.saveCheckpoint({
        runId,
        seq,
        name: step.name,
        kind: 'remote',
        stepId: id,
        status: 'pending',
        input: validInput,
        attempts: attempt,
        workerGroup: token,
        enqueuedAt: attemptAt,
        startedAt: attemptAt,
        finishedAt: attemptAt,
      });
      await this.pool.dispatch(
        {
          runId,
          seq,
          name: step.name,
          stepId: id,
          group: token,
          input: validInput,
          traceparent: this.traceparent?.(),
          context: this.context?.(),
          attempt,
        },
        transport,
      );
      try {
        const resolution = step.timeoutMs
          ? await this.awaitWithHeartbeat(id, resultPromise, step.timeoutMs, step.pickupTimeoutMs)
          : await resultPromise;
        const output = (
          step.output ? step.output.parse(resolution.output) : resolution.output
        ) as TOutput;
        // The worker reports when it actually picked the task up; fall back to dispatch time if a
        // transport doesn't carry it (queue-wait then reads as zero rather than going negative).
        const startedAt = resolution.startedAt ? new Date(resolution.startedAt) : enqueuedAt;
        await this.completeStep({
          runId,
          seq,
          name: step.name,
          kind: 'remote',
          input: validInput,
          output,
          events: resolution.events,
          attempts: attempt,
          workerGroup: token,
          enqueuedAt,
          startedAt,
        });
        return output;
      } catch (err) {
        this.pending.delete(id);
        if (err instanceof RemoteStepTimeout && attempt < maxAttempts) continue;
        throw err;
      }
    }
  }

  /**
   * Await a remote result, but reject with `RemoteStepTimeout` if neither the result nor a heartbeat
   * arrives within `timeoutMs`. Each heartbeat (delivered via `transport.onHeartbeat`) rearms the
   * window, so a worker that keeps beating stays alive past `timeoutMs`.
   */
  private awaitWithHeartbeat(
    id: string,
    resultPromise: Promise<RemoteResolution>,
    timeoutMs: number,
    pickupTimeoutMs?: number,
  ): Promise<RemoteResolution> {
    return new Promise<RemoteResolution>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      // Two windows, one timer: until the FIRST beat arrives the job may be sitting in the broker
      // queue behind long work — a stretch that produces no heartbeats by definition, so it gets
      // `pickupTimeoutMs` (default: `timeoutMs`, the historical behavior). The worker's automatic
      // pickup beat flips to the (typically tighter) `timeoutMs`, which then means "max silence
      // while RUNNING". Without the split, a dispatch-anchored window false-failed a healthy
      // single-concurrency fleet whose next batch queued ~15min behind the current one.
      let seenBeat = false;
      const window = () => (seenBeat ? timeoutMs : (pickupTimeoutMs ?? timeoutMs));
      const cleanup = () => {
        clearTimeout(timer);
        this.heartbeatResets.delete(id);
      };
      const arm = () => {
        const ms = window();
        timer = setTimeout(() => {
          cleanup();
          this.pending.delete(id);
          reject(new RemoteStepTimeout(id, ms));
        }, ms);
        (timer as { unref?: () => void }).unref?.();
      };
      this.heartbeatResets.set(id, () => {
        seenBeat = true;
        clearTimeout(timer);
        arm();
      });
      arm();
      resultPromise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (err) => {
          cleanup();
          reject(err);
        },
      );
    });
  }
}

/** Raised inside the workflow when a remote worker reports a step failure. */
export class RemoteStepError extends Error {
  readonly stepError?: StepError | undefined;
  constructor(stepError?: StepError) {
    super(stepError?.message ?? 'remote step failed');
    this.name = 'RemoteStepError';
    this.stepError = stepError;
  }
}
