import type { z } from 'zod';
import type { DispatchDiagnostics } from './dispatch-routing.js';
import type { WorkerDescriptor } from './handshake/descriptor.js';
import type { StepRef } from './step-name-symbol.js';
import type { WorkflowClass, WorkflowInputOf, WorkflowOutputOf } from './workflow-ref.js';

/**
 * Core type contracts for nestjs-durable.
 *
 * These are intentionally framework-agnostic: `@dudousxd/nestjs-durable-core` knows only
 * these interfaces, never a concrete transport, store or ORM. Adapters implement them.
 */

// ---------------------------------------------------------------------------
// Runs & checkpoints — the durable state owned by the orchestrator
// ---------------------------------------------------------------------------

export type RunStatus =
  /** Created + enqueued by `start`, not yet picked up — a worker will lease and execute it. */
  | 'pending'
  | 'running'
  | 'suspended'
  /**
   * Parked because NO live worker can run the next dispatch — a required capability is unadvertised,
   * or every live worker is protocol-incompatible (design §7.5/§7.6). NOT terminal and NOT a silent
   * hang: it carries a human `error.message` reason + fires a `capability.unavailable`/
   * `protocol.incompatible` diagnostics event, and the blocked-recovery poll re-drives it (via
   * `wakeAt`) so it proceeds the moment a capable+compatible worker appears.
   */
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** Dead-letter: recovery gave up after `maxRecoveryAttempts` (a poison pill). Terminal; inspect it. */
  | 'dead';

/** One execution of a workflow. The unit of durability and the unit shown in the dashboard. */
export interface WorkflowRun {
  id: string;
  /** Registered workflow name, e.g. `checkout`. */
  workflow: string;
  /** Code version at start; old runs must resume on the version they began on. */
  workflowVersion: string;
  status: RunStatus;
  /**
   * Worker-pool partition this run belongs to (default `'default'`). A worker only picks up /
   * recovers / resumes-timers-for / times-out runs in its OWN namespace, so one shared state store
   * can host non-interchangeable pools (e.g. local dev vs a cluster) without them stealing each
   * other's runs. `undefined` on a run created before this field existed — treated as "belongs to
   * everyone" for back-compat (no namespace guard skips it). Read paths (dashboard, `getRun`) are
   * NOT namespace-scoped.
   */
  namespace?: string | undefined;
  /** Serialized workflow input (the args the run was started with). */
  input: unknown;
  /** Serialized workflow output, once `completed`. */
  output?: unknown;
  /** Structured error, once `failed`. */
  error?: StepError | undefined;
  /** When `suspended` on a durable sleep: epoch ms at which the run becomes due to resume. */
  wakeAt?: number | undefined;
  /** Recovery lease owner (engine instance id) while a run is being resumed. */
  lockedBy?: string | undefined;
  /** Recovery lease expiry (epoch ms); another instance may take over once it passes. */
  lockedUntil?: number | undefined;
  /** How many times crash-recovery has picked this run up — caps poison pills (see maxRecoveryAttempts). */
  recoveryAttempts?: number | undefined;
  /** Searchable labels: the workflow's static `workflow` config `tags` merged with the run's start-time tags. */
  tags?: string[] | undefined;
  /** Typed, queryable run data (e.g. `{ amount: 200, tier: 'pro' }`) — see {@link RunQuery.attributes}. */
  searchAttributes?: SearchAttributes | undefined;
  /**
   * Dispatch priority for a REMOTE run (one advanced by a {@link WorkflowExecutor} over a broker):
   * carried onto each {@link WorkflowTask} so an urgent child workflow can jump ahead of enqueued
   * lower-priority ones at the worker. Higher wins; absent = unprioritised. Best-effort ordering, not
   * durable state required for correctness — a transport without priority support ignores it.
   */
  priority?: number | undefined;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * WHAT an event-parked suspended run is waiting on, resolved for display — the engine keeps one
 * generic `suspended` status (it's what drives recovery/timers/queries), but to a human "waiting on
 * signal `approve`" reads very differently from "waiting on webhook `stripe-cb`". Computed by
 * {@link resolveRunWaiting} (`run-waiting.ts`) from the run's signal waiters (`listSignalWaiters`, ONE
 * bulk scan), so the dashboard can NAME the wait in a list row without fetching each run's timeline.
 * `on` is derived from the waiter token's prefix (see `classifyWaiterToken`): `wh:<runId>:<seq>` ⇒
 * `webhook`, `child:<id>` ⇒ `child`, `bp:<runId>:<seq>` ⇒ `breakpoint`, `event:<name>:…` ⇒ `signal`
 * (name decoded), anything else ⇒ `signal` (the token IS the signal name). Mirrors
 * `@dudousxd/nestjs-durable-core`'s `RunWaiting` byte-for-byte.
 */
export interface RunWaiting {
  on: 'signal' | 'webhook' | 'child' | 'breakpoint';
  name: string;
}

export type StepKind = 'local' | 'remote' | 'sleep' | 'signal';

/**
 * The recorded result of a single step at a deterministic logical position (`seq`).
 * On replay, a `completed` checkpoint means the step is NOT re-executed — its `output` is
 * returned. A non-terminal checkpoint (`pending`/`running`) does not short-circuit: the step is
 * re-awaited (remote) or re-run (local).
 */
export interface StepCheckpoint {
  runId: string;
  /** Deterministic logical position of the step within the run. */
  seq: number;
  /** Registered step name (matches the remote handler name for remote steps). */
  name: string;
  kind: StepKind;
  /** Stable id passed to remote workers so they can dedupe a re-delivered task. */
  stepId: string;
  /**
   * `pending` = a remote step dispatched and awaiting its worker result (the run is durably
   * suspended, not held in memory); it becomes `completed`/`failed` when the result arrives.
   * `running` = a local step whose body is executing in-process right now (see `trackStepStart`);
   * it's overwritten by `completed`/`failed` when the body settles, and on a crash mid-body it
   * simply re-runs on replay (only `completed` short-circuits).
   */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** What the step was called with — the `ctx.step` (dispatched) args for a remote step (a local step has none). */
  input?: unknown;
  output?: unknown;
  error?: StepError | undefined;
  attempts: number;
  /** For remote steps: which worker group ran it. */
  workerGroup?: string | undefined;
  /** Structured events/logs the step emitted (sub-step outcomes, debug/error lines). */
  events?: StepEvent[] | undefined;
  /** For sleep steps: epoch ms the sleep elapses at. */
  wakeAt?: number | undefined;
  /**
   * Set on the running placeholder checkpoints of the children dispatched by one `ctx.all` call —
   * a shared tag (`all:<firstSeq>`) grouping the N siblings so the dashboard can render them as one
   * parallel fan-out. Also carried onto remote `ctx.gather_calls` step checkpoints and onto the
   * resolving `signal:child:<id>` await checkpoint of a `gather_children` fan. Optional and additive:
   * absent on every non-parallel checkpoint. Mirrors the Python SDK's `parallelGroup`.
   */
  parallelGroup?: string | undefined;
  /**
   * When the step entered the system: for a remote step, when the engine dispatched it to the
   * transport; for a local step, when it began. Queue-wait time = `startedAt − enqueuedAt`.
   */
  enqueuedAt: Date;
  /** When processing actually began: worker pickup for a remote step, execution start for a local one. */
  startedAt: Date;
  finishedAt: Date;
  /**
   * The last worker heartbeat the engine persisted for this step (throttled — the true beat cadence
   * may be finer). A `pending` remote step with a RECENT beat is alive mid-flight; one silent past
   * its expected cadence is hung or lost. Absent when the handler never called `log.heartbeat`.
   */
  lastHeartbeatAt?: Date | undefined;
  /** The progress payload carried by that last persisted heartbeat, verbatim. */
  heartbeatProgress?: unknown;
}

/**
 * A structured event a step (or its worker) emits while running — a log line and/or a sub-step
 * outcome. The dashboard renders these under the step, so you can see what happened inside a step
 * that the workflow treats as one unit (e.g. which of N parallel sub-processes ok/failed/skipped).
 */
export interface StepEvent {
  /** Epoch ms. */
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  /** Stable run identity for a sub-process. Distinct invocations of the same `name` carry distinct
   *  ids, so their phases and log trails never collapse into one. Absent on events emitted by the
   *  legacy `sub()` path, which keys by `name` instead. */
  subId?: string;
  /** For a sub-step/sub-process within the step: its name. */
  name?: string;
  /** Open, consumer-defined grouping label for a sub-process (e.g. a handler/lane). The dashboard
   *  groups rows by it. The library never interprets it. */
  group?: string;
  /** For a sub-step: its terminal outcome (closed enum — drives colour + aggregation). */
  status?: 'ok' | 'failed' | 'skipped';
  /** Open, consumer-defined intermediate phase label for a sub-process transition. Carries no
   *  terminal `status`; the library timestamps and orders it but never interprets it. */
  phase?: string;
  /** For a log line emitted *inside* a sub-process: that owning sub-process's name, so the dashboard
   *  can group a step's log trail under each sub-process instead of one flat list. Set on logs (no
   *  `status`); a worker stamps it from the sub-process it's running.
   *  @deprecated Superseded by `subId` for run-distinct grouping; kept so existing workers/runs render. */
  process?: string;
  /** Optional structured payload. `data.durationMs` (number) overrides the derived duration. */
  data?: unknown;
}

/**
 * Handed to a local step's body (`ctx.step(name, (log) => …)`) so it can record what happened
 * inside the step — debug/info/warn/error lines and per-sub-process outcomes. The events are
 * checkpointed with the step and rendered under it in the dashboard. The remote/cross-language
 * counterpart is the worker attaching the same `StepEvent[]` to its `StepResult` (see the Python
 * SDK's `StepContext`), so observability is symmetric regardless of where the step ran.
 */
export interface StepLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  /**
   * Signal "this step is ALIVE mid-flight" — the missing half of step liveness. Logs and sub-events
   * ship WITH the result when the step finishes, so a long step (a 15-minute browser batch) is
   * indistinguishable from a hung one until its `timeoutMs` fires. A heartbeat travels NOW: it
   * rearms the step's `timeoutMs` window on the engine (a beating step never falsely times out —
   * so `timeoutMs` can be tightened to "max silence", not "max duration") and the engine persists
   * the latest beat on the step's checkpoint (throttled), making liveness visible cross-process
   * (`durable:runs`, status commands, dashboard). Optional `progress` is any JSON-safe payload
   * (`log.heartbeat({done: 12, total: 50})`). Throttled internally (min ~5s between emissions) —
   * call it as often as you like, e.g. once per item of a batch. No-op where no emitter is wired
   * (local steps run in-process; the run itself is live).
   */
  heartbeat(progress?: unknown): void;
  /** Record a sub-step / sub-process outcome (e.g. one of N parallel p-processes). */
  sub(name: string, status: 'ok' | 'failed' | 'skipped', message?: string, data?: unknown): void;
  /** Record a sub-process event. Typically pass `phase` for an intermediate transition (carrying no
   *  terminal status), or `status` for the terminal outcome — the type permits either; the engine
   *  interprets which is set. `id` is the run identity (distinct per invocation); `group` is an
   *  open grouping label. */
  subEvent(e: {
    id: string;
    name: string;
    group?: string | undefined;
    phase?: string | undefined;
    status?: 'ok' | 'failed' | 'skipped' | undefined;
    message?: string | undefined;
    data?: unknown;
  }): void;
  /**
   * Ergonomic sub-process lifecycle: run `body`, timing it, and record a terminal `ok` with the
   * measured `durationMs` on success — or `failed` (with the error message) if it throws, then
   * re-throw. `sp.phase(label)` records an intermediate transition; `sp.skip(reason)` a terminal
   * `skipped`. Logs emitted inside `body` are tagged to this sub-process so the dashboard groups
   * them under it. Returns whatever `body` returns. The TS twin of the Python SDK's `sub_process`.
   *
   * ```ts
   * const rows = await log.subProcess('fetch-data', async () => readEverything());
   * await log.subProcess('export-file', () => upload(rows));
   * ```
   */
  subProcess<T>(
    name: string,
    body: (sp: SubProcessHandle) => Promise<T> | T,
    opts?: { group?: string; id?: string },
  ): Promise<T>;
}

/** The handle a {@link StepLogger.subProcess} body receives to mark phases / a non-`ok` outcome. */
export interface SubProcessHandle {
  /** Record an intermediate phase transition (a consumer-defined label, no terminal status). */
  phase(phase: string, data?: unknown): SubProcessHandle;
  /** Record a terminal `skipped` outcome (e.g. nothing to do / validation failed). */
  skip(reason?: string, data?: unknown): void;
  /** Record a terminal `failed` outcome explicitly (the wrapper also does this if the body throws). */
  fail(reason?: string, data?: unknown): void;
}

export interface StepError {
  message: string;
  /** Optional machine-readable code, e.g. `declined`, `timeout`. */
  code?: string | undefined;
  /** Whether the engine should treat this as retryable. */
  retryable?: boolean | undefined;
  stack?: string | undefined;
}

// ---------------------------------------------------------------------------
// StateStore — where runs and checkpoints live (Postgres / MySQL / SQLite via ORM adapters)
// ---------------------------------------------------------------------------

export interface StateStore {
  /**
   * Provision the tables/collections this store needs, idempotently. Called on boot when the
   * module's `autoSchema` is on. Optional: stores that need no setup (in-memory) omit it.
   */
  ensureSchema?(): Promise<void>;

  createRun(run: WorkflowRun): Promise<void>;
  updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void>;

  /**
   * Conditional (compare-and-set) variant of {@link updateRun}: apply `patch` ONLY IF the run's
   * CURRENTLY PERSISTED `status` is one of `expectedStatuses` at write time. Returns `true` when the
   * write was applied, `false` when the predicate did not match — a non-match is a normal outcome,
   * never a throw.
   *
   * The predicate MUST be evaluated atomically with the write — part of the same UPDATE statement for
   * a SQL store, or the same synchronous check (no `await` between read and mutate) for an in-process
   * store. A JS read-then-write is a TOCTOU race, not a substitute: two racing callers could both
   * observe a matching status before either writes.
   *
   * Exists so a terminal-status write (settling a run `completed`/`failed`, or re-suspending it) can't
   * silently clobber a state change — e.g. an operator's `cancelled` — that landed while the write's
   * outcome was still being computed from a now-stale run snapshot.
   */
  updateRunIf(
    runId: string,
    expectedStatuses: RunStatus[],
    patch: Partial<WorkflowRun>,
  ): Promise<boolean>;

  getRun(runId: string): Promise<WorkflowRun | null>;

  /**
   * Hard-delete a run and everything tied to it (its checkpoints, signal waiters, and search-attribute
   * index rows). Idempotent: deleting an unknown run is a no-op. This removes exactly the one run — the
   * engine's {@link WorkflowEngine.deleteRun} handles the child-subtree cascade.
   */
  deleteRun(runId: string): Promise<void>;

  getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null>;
  /**
   * Persist a checkpoint and advance the run atomically. Durable semantics depend on this
   * being a single transaction; stores without transactions cannot give the strong guarantee.
   */
  saveCheckpoint(checkpoint: StepCheckpoint): Promise<void>;

  /**
   * Used by recovery on boot to find runs to resume (crashed, left `running`). When `namespace` is
   * given, restrict to runs in that worker-pool partition (ANDed); omit it to return all (back-compat).
   */
  listIncompleteRuns(namespace?: string): Promise<WorkflowRun[]>;

  /**
   * The oldest `pending` runs awaiting dispatch (FIFO, by `createdAt`), capped at `limit`. When
   * `namespace` is given, restrict to runs in that worker-pool partition (ANDed); omit it for all.
   */
  listPendingRuns(limit: number, namespace?: string): Promise<WorkflowRun[]>;

  /**
   * Suspended runs whose durable timer is due (`wakeAt <= nowMs`), ready to resume. When `namespace`
   * is given, restrict to runs in that worker-pool partition (ANDed); omit it to return all.
   */
  listDueTimers(nowMs: number, namespace?: string): Promise<WorkflowRun[]>;

  /**
   * Atomically acquire the recovery lease on a run for `owner` until `leaseUntilMs`, but only if
   * it is currently unlocked or its lease has expired (`<= nowMs`). Returns whether it was
   * acquired — so concurrent engine instances never recover the same run twice.
   */
  tryLockRun(runId: string, owner: string, leaseUntilMs: number, nowMs: number): Promise<boolean>;

  /** Release a run's recovery lease so another instance can pick it up (e.g. once it suspends). */
  releaseRunLock(runId: string): Promise<void>;

  /**
   * Extend a run's lease to `leaseUntilMs`, but ONLY if `owner` still holds it — so a live worker
   * heartbeating its long run keeps the lease, while a dead worker's lease still expires and gets
   * reclaimed. Returns false if the lease was lost (taken over or released).
   */
  renewRunLock(runId: string, owner: string, leaseUntilMs: number): Promise<boolean>;

  /** Record that a run is suspended waiting for an external signal `token`. */
  putSignalWaiter(waiter: SignalWaiter): Promise<void>;
  /** Atomically take (and remove) the run waiting on `token`, if any. */
  takeSignalWaiter(token: string): Promise<SignalWaiter | null>;
  /** List waiters whose `token` starts with `prefix` — used to fan out an event to its subscribers. */
  listSignalWaiters(prefix: string): Promise<SignalWaiter[]>;

  /**
   * Delete the EXACT waiter row — `token` AND `runId` AND `seq` must all match — no-op if absent.
   * Unlike {@link takeSignalWaiter}, which deletes ANY row for `token` (fine when the caller just won
   * the race to consume it), this is for a caller removing its OWN registration after resolving the
   * wait some other way (a buffered hit, a timeout): blind `takeSignalWaiter(token)` there could steal
   * a DIFFERENT run's waiter that has since claimed the same token (`token` is the store's primary key,
   * so a later `putSignalWaiter` for the same token replaces the row). The exact-match variant only
   * ever removes the row this caller itself put there.
   */
  removeSignalWaiter(waiter: SignalWaiter): Promise<void>;

  /**
   * Buffer a signal whose waiter hasn't arrived yet, so the next `waitForSignal(token)` consumes it
   * instead of it being lost (FIFO per token). Makes signals reliable regardless of timing and
   * powers `signalWithStart`.
   */
  bufferSignal(token: string, payload: unknown): Promise<void>;
  /** Take the oldest buffered signal for `token` (FIFO), or null if none is buffered. */
  takeBufferedSignal(token: string): Promise<{ payload: unknown } | null>;

  /**
   * Buffer a published event that matched NO live waiter, so a LATER `ctx.waitForEvent(name, { match })`
   * still consumes it instead of it being silently dropped — the events analog of {@link bufferSignal}'s
   * reliability contract for signals, but MATCH-based rather than token-based: an event's buffer is keyed
   * by `name` alone (many waiters can share a name with different `match` criteria), so consumption is
   * list ({@link listBufferedEvents}) + evaluate the WAITER's own match predicate + claim
   * ({@link removeBufferedEvent}) — never a blind take, because the store has no way to know which
   * candidate a given waiter wants. `input.id` is minted by the caller (engine.publishEvent) so
   * {@link removeBufferedEvent} can later target this exact row.
   */
  bufferEvent(input: {
    name: string;
    payload: unknown;
    id: string;
    publishedAt: number;
  }): Promise<void>;
  /**
   * Buffered events for `name`, OLDEST (`publishedAt`) first, capped at `limit`. A waiter scans these,
   * evaluates its own `eventMatches(payload, match)` locally, and claims the one it wants via
   * {@link removeBufferedEvent} — the match predicate belongs to the WAITER, never the store.
   */
  listBufferedEvents(
    name: string,
    limit: number,
  ): Promise<Array<{ id: string; payload: unknown; publishedAt: number }>>;
  /**
   * Atomically delete the buffered event `id`. Returns `true` iff a row was actually deleted, `false`
   * if it was already gone (claimed by a concurrent waiter, reclaimed by `engine.publishEvent`'s own
   * late re-check, or pruned as expired) — the arbiter under concurrency: whichever caller's delete
   * returns `true` is the one that gets to deliver the payload; every other caller backs off.
   */
  removeBufferedEvent(id: string): Promise<boolean>;

  /**
   * Run `work` in a SINGLE store transaction — giving it the store-native transaction handle (`raw`)
   * for the caller's own DB writes plus a `saveCheckpoint` that commits IN THE SAME transaction, so a
   * business write and the step's "done" checkpoint are atomic (exactly-once). Optional — only the SQL
   * adapters implement it; `ctx.transaction` errors on a store without it.
   */
  transaction?<T>(work: (tx: StoreTransaction) => Promise<T>): Promise<T>;

  // Dashboard queries
  listRuns(query: RunQuery): Promise<WorkflowRun[]>;
  listCheckpoints(runId: string): Promise<StepCheckpoint[]>;

  /**
   * Persist the latest worker heartbeat for the step at (`runId`, `seq`) — see
   * {@link StepCheckpoint.lastHeartbeatAt}. Optional: the engine calls it best-effort and throttled
   * (a store without it simply has no persisted step liveness; nothing else degrades). A no-matching-
   * checkpoint update is a silent no-op (the beat may race the checkpoint's own insert or outlive a
   * completed step).
   */
  recordStepHeartbeat?(runId: string, seq: number, at: Date, progress?: unknown): Promise<void>;

  /**
   * The LATEST checkpoint for `runId` whose `name` equals `name` exactly (highest `seq` wins), or
   * `undefined` if none. A targeted read that avoids fetching + deserializing every checkpoint just to
   * keep one match — the store does the filter (`WHERE name = … ORDER BY seq DESC LIMIT 1`). Preserves
   * the "last in seq order wins" semantics the engine relies on for `getEvent` (a re-published key
   * overwrites the prior value at a higher seq, so the highest-seq match is the current value).
   *
   * Optional: a store that omits it still works — the engine falls back to {@link listCheckpoints}
   * plus an in-JS filter that produces the identical result.
   */
  getLatestCheckpointByName?(runId: string, name: string): Promise<StepCheckpoint | undefined>;

  /**
   * All checkpoints for `runId` whose `name` starts with ANY of `prefixes`, ordered by `seq` ascending
   * (same order as {@link listCheckpoints}). A targeted read that avoids scanning every checkpoint just
   * to keep the prefix matches — the store does the filter (`WHERE name LIKE 'prefix%' …`). Used by the
   * run-tree to find a parent's child edges (`signal:child:` / `spawn:` checkpoints) without loading the
   * whole history. An empty `prefixes` array matches nothing.
   *
   * Optional: a store that omits it still works — the engine falls back to {@link listCheckpoints}
   * plus an in-JS prefix scan that produces the identical result.
   */
  listCheckpointsByNamePrefix?(runId: string, prefixes: string[]): Promise<StepCheckpoint[]>;
}

/** Typed, queryable per-run data — exact values for `eq`/`ne`, numbers/strings for range ops. */
export type SearchAttributes = Record<string, string | number | boolean>;

export type AttributeOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

/** One predicate over a run's {@link SearchAttributes}; a {@link RunQuery} ANDs them all. */
export interface AttributeFilter {
  key: string;
  op: AttributeOp;
  value: string | number | boolean;
}

export interface RunQuery {
  workflow?: string | undefined;
  status?: RunStatus | undefined;
  /**
   * Restrict to runs in this worker-pool partition (exact match against {@link WorkflowRun.namespace}),
   * ANDed with the other predicates. Omit to span all namespaces — read surfaces (dashboard, CLI) stay
   * namespace-agnostic by default; the engine passes its own namespace here on the poll paths it scopes.
   */
  namespace?: string | undefined;
  /**
   * Match any of these statuses (a `status IN (...)` filter). ORed together, and ANDed with the other
   * predicates. Use this instead of issuing one {@link listRuns} call per status — e.g. the singleton
   * admission gate counts `running` + `suspended` in-flight runs in a single scan. If both `status` and
   * `statuses` are set, both must hold (the single `status` further narrows the set). Empty array =
   * matches nothing.
   */
  statuses?: RunStatus[] | undefined;
  /** Only runs carrying this tag (exact match against {@link WorkflowRun.tags}). */
  tag?: string | undefined;
  /**
   * Typed/range predicates over {@link WorkflowRun.searchAttributes}, ANDed together (e.g. `amount`
   * >= 200 and `tier` = 'pro'). Applied in-process after the coarse filters, so pair with
   * `workflow`/`status`/`tag` to bound the scan on large stores.
   */
  attributes?: AttributeFilter[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** The transaction handle `StateStore.transaction` hands to its work callback. */
export interface StoreTransaction {
  /** The store-native transaction handle (TypeORM `EntityManager`, Prisma tx client, MikroORM `EntityManager`,
   *  Drizzle tx) — do your business DB writes on THIS so they commit atomically with the checkpoint. */
  readonly raw: unknown;
  /** Persist the step checkpoint inside this transaction. */
  saveCheckpoint(checkpoint: StepCheckpoint): Promise<void>;
}

/** Binds an external signal `token` to the suspended run/step position waiting for it. */
export interface SignalWaiter {
  token: string;
  runId: string;
  seq: number;
  /**
   * The parallel-fan group this waiter belongs to, carried from the awaiting command so the resolving
   * `signal:<token>` checkpoint (notably `signal:child:<id>` for an awaited child run) can be tagged
   * with it. A worker's `ctx.gather_children`/`ctx.all` fan-out stamps every `startChild` with the same
   * group; without threading it through the waiter, the child-await checkpoint comes out untagged and the
   * dashboard renders the fan as a sequential chain instead of one parallel group. Undefined for an
   * ordinary (non-fan) signal/child await.
   */
  parallelGroup?: string | undefined;
}

// ---------------------------------------------------------------------------
// Transport — how a remote task travels to a worker and the result returns
// ---------------------------------------------------------------------------

/** A unit of work dispatched to a remote worker. This is the documented wire payload. */
export interface RemoteTask {
  runId: string;
  seq: number;
  /** Handler name the worker registered, e.g. `payments.charge-card`. */
  name: string;
  stepId: string;
  /** Worker group expected to handle this task. */
  group: string;
  input: unknown;
  /** W3C traceparent so the worker can continue the distributed trace. */
  traceparent?: string | undefined;
  /**
   * Opaque context carrier (tenant / user / correlation ids) the worker re-exposes to the step
   * handler, for cross-process propagation alongside the {@link traceparent}. The engine treats it
   * as a pass-through object and never inspects its shape — the producer (e.g. `@dudousxd/nestjs-context`)
   * owns the keys. Absent when no `context` provider is configured.
   */
  context?: Record<string, unknown> | undefined;
  /**
   * Id of the transport this task was dispatched on (when the engine runs a pool — see
   * {@link NamedTransport}). A worker that consumes several transports replies via the matching one,
   * so failover is symmetric without the worker choosing a transport. Absent for a single transport.
   */
  transport?: string | undefined;
  /**
   * Admission priority carried through to the broker (the queue job `priority`) so a transport that
   * supports priority ordering lets an urgent task jump ahead of already-enqueued lower-priority
   * ones at the worker. Mirrors the per-call `priority` from `ctx.step(..., { priority })`. Higher
   * wins; absent means default/unprioritised. Transports without priority support ignore it.
   */
  priority?: number | undefined;
  attempt: number;
}

export interface StepResult {
  runId: string;
  seq: number;
  stepId: string;
  status: 'completed' | 'failed';
  output?: unknown;
  error?: StepError | undefined;
  /** Epoch ms when the worker began processing — lets the engine report queue-wait time. */
  startedAt?: number | undefined;
  /** Structured events the worker emitted while running the step (sub-step outcomes, logs). */
  events?: StepEvent[] | undefined;
}

export interface Heartbeat {
  runId: string;
  seq: number;
  stepId: string;
  group: string;
  /** Worker-side emission time (epoch ms). Optional on the wire for back-compat with 0.17-era workers. */
  at?: number | undefined;
  /**
   * Opaque JSON-safe progress payload the step handler attached (`log.heartbeat({done: 12, total: 50})`).
   * The engine persists the latest one on the step's checkpoint (throttled), so ops surfaces can show
   * "alive AND advancing: 12/50" instead of inferring liveness from domain tables.
   */
  progress?: unknown;
}

// ---------------------------------------------------------------------------
// Polyglot workflows — the workflow-task / commands protocol
//
// A workflow authored in a non-TS SDK (e.g. Python) runs coordinator-driven: the engine stays the
// sole owner of the durable state + recovery/timers and advances the run one TURN at a time by
// dispatching a {@link WorkflowTask} (the run's history) to a workflow worker, which REPLAYS the
// function locally and returns a {@link WorkflowDecision} (the commands it produced). The engine
// applies the decision (persist checkpoints, dispatch steps, schedule timers, settle the run). The
// worker never touches the store. See docs/plans/2026-06-15-polyglot-workflows-protocol.md.
// ---------------------------------------------------------------------------

/** engine → workflow worker: advance this run one turn by replaying the function against `history`. */
export interface WorkflowTask {
  /** Dedupe id for this turn (a re-delivered task must be idempotent). */
  taskId: string;
  runId: string;
  /** Registered workflow name + the version the run started on — replay must use that version. */
  workflow: string;
  workflowVersion: string;
  input: unknown;
  /** Completed durable ops so far, ordered by seq — what the worker replays its results from. */
  history: HistoryEvent[];
  /** Signals delivered to the run but not yet consumed, so `wait_signal` resolves on replay. */
  pendingSignals?: Array<{ seq: number; signal: string; payload: unknown }>;
  group: string;
  /** Id of the transport this task was dispatched on (pool failover) — see {@link NamedTransport}. */
  transport?: string;
  traceparent?: string;
  /**
   * Admission priority carried to the broker (the queue job `priority`) so an urgent child workflow
   * can jump ahead of already-enqueued lower-priority ones at the worker. Higher wins; absent means
   * default/unprioritised. Transports without priority support ignore it.
   */
  priority?: number | undefined;
  attempt: number;
}

/** One resolved durable op in a run's history — a superset of a completed {@link StepCheckpoint}. */
export interface HistoryEvent {
  seq: number;
  kind: 'step' | 'call' | 'timer' | 'signal' | 'child';
  name?: string | undefined;
  /** Resolved value: a step/call output, a child run's output, a signal payload. */
  output?: unknown;
  /** Set when the op resolved to a failure (e.g. a failed remote step the workflow may catch). */
  error?: StepError | undefined;
}

/** A decision the workflow function produced at a `seq` that was not yet in history. */
export type WorkflowCommand =
  /** `ctx.step(handlerOrName, input)` — dispatch a step (by ref or name) and await it. A worker's
   *  `ctx.gather_calls([...])` fan-out tags every dispatched call with the same `parallelGroup` so the
   *  dashboard renders the remote steps as one parallel fan (parity with the gathered `recordStep` /
   *  `startChild` tags). Undefined for a lone sequential `ctx.step`. */
  | {
      kind: 'call';
      seq: number;
      name: string;
      group: string;
      input: unknown;
      parallelGroup?: string;
    }
  /** `ctx.step(name, body)` — a LOCAL step the worker already ran this turn; the engine persists its
   *  result so replay returns it instead of re-running (durability for side-effectful work).
   *  `startedAt`/`finishedAt` (epoch ms) carry the step's real wall-clock window so the dashboard
   *  shows a true duration instead of 0ms, and `events` carry the sub-process/log trail the step
   *  emitted (so each handler's p-processes show under it). All optional for back-compat. */
  | {
      kind: 'recordStep';
      seq: number;
      name: string;
      output?: unknown;
      error?: StepError;
      startedAt?: number;
      finishedAt?: number;
      events?: StepEvent[];
    }
  /** `ctx.sleep(ms)` — a durable timer of `ms` duration. The engine computes the absolute deadline
   *  (now + ms) when it applies the command, so the worker never reads the clock (determinism). */
  | { kind: 'sleep'; seq: number; ms: number }
  /** `ctx.wait_signal(name)` — block until a signal `name` is delivered to the run. */
  | { kind: 'waitSignal'; seq: number; signal: string }
  /** `ctx.start_child(workflow, input)` — start a child run with its own lifecycle. A worker's
   *  `ctx.gather_children(...)` fan-out tags every started child with the same `parallelGroup`, which
   *  the engine threads onto the child-await signal waiter and its resolving `signal:child:<id>`
   *  checkpoint. Undefined for a lone (non-fan) child. */
  | {
      kind: 'startChild';
      seq: number;
      workflow: string;
      input: unknown;
      parallelGroup?: string;
    };

/** workflow worker → engine: the result of replaying one turn of a remote workflow. */
export interface WorkflowDecision {
  taskId: string;
  runId: string;
  /** `continue` = produced `commands` and is blocked on an await; otherwise the run settles.
   *  `cancelled` = the worker bailed at an op boundary because the run was cancelled mid-turn. */
  status: 'continue' | 'completed' | 'failed' | 'cancelled';
  /** New durable ops the replay produced this turn (status === 'continue'), ordered by seq. */
  commands: WorkflowCommand[];
  /** Final workflow output (status === 'completed'). */
  output?: unknown;
  /** Terminal error (status === 'failed'). */
  error?: StepError;
}

/**
 * workflow worker → engine: a LOCAL step's lifecycle, streamed AS IT HAPPENS (not batched into the
 * turn's final {@link WorkflowDecision}). A Python `@workflow` runs its `ctx.step`s inline over one
 * turn that can last minutes; without this the engine learns of the steps only when the turn ends,
 * so the dashboard shows nothing mid-run. The worker emits `running` when a step's body starts and
 * `completed`/`failed` when it settles; the engine checkpoints each immediately, so a step appears
 * in-flight and then resolves live. The turn's final `recordStep` command re-persists the same
 * checkpoint idempotently (replay history), so this is purely additive observability.
 */
export interface WorkflowStepEvent {
  runId: string;
  seq: number;
  name: string;
  phase: 'running' | 'completed' | 'failed';
  /** Epoch ms the step body began (all phases) and settled (`completed`/`failed`). */
  startedAt: number;
  finishedAt?: number;
  /** The replayed result / failure for the settled phases. */
  output?: unknown;
  error?: StepError;
  /** Sub-process + log trail the step emitted so far (the handler's p-processes). */
  events?: StepEvent[];
}

/**
 * Advances a workflow run one turn. The engine has one per workflow: the default {@link InProcess}
 * one runs a registered TS function with the in-process replay machinery; a remote one dispatches a
 * {@link WorkflowTask} to a worker (Python) and awaits its {@link WorkflowDecision}. Either way the
 * engine applies the returned decision — so recovery, timers, singleton and dead-letter stay engine
 * concerns, identical for in-process and remote workflows.
 */
export interface WorkflowExecutor {
  advance(
    run: WorkflowRun,
    history: HistoryEvent[],
    pendingSignals?: WorkflowTask['pendingSignals'],
  ): Promise<WorkflowDecision>;
}

/**
 * A transport in an ordered pool, identified by `id`. The engine dispatches on the first by default
 * and fails over to the next on a dispatch error; a step can pin one via `ctx.step(…, { transport })`.
 * The chosen `id` is stamped on the {@link RemoteTask} so a worker replies through the matching one.
 */
export interface NamedTransport {
  id: string;
  transport: Transport;
}

/**
 * Decides where a freshly-`start`ed run executes. `start` creates the run as `pending` and hands its
 * id here instead of running the body inline — so the API/caller never blocks on workflow execution.
 * The default in-process dispatcher runs it on this instance (a microtask); a broker-backed one
 * enqueues the id for a worker pool to consume (`engine.runOne(runId)`); a no-op one leaves it
 * `pending` in the store for a worker's `runPending` poll to pick up (DB-only, caller-doesn't-execute).
 */
export interface RunDispatcher {
  dispatch(runId: string): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// P4 — store-less read/control/start wire DTOs (byte-compatible with aviary)
//
// A store-less `tenant` pod owns no store; every read/control/start round-trips over the transport to
// the control plane and back. These four DTOs are the wire contract, and they cross the queue / pub-sub
// as PLAIN JSON with NO envelope (the DTO IS the payload) — byte-for-byte identical to aviary's
// `StartRunMessage`/`RunRequest`/`RunReply`/`TenantEvent` so a Python/NestJS worker interoperates
// unchanged (spec §8, Appendix A). Dates nested in an `EngineEvent`/`WorkflowRun` carried by a
// `TenantEvent`/`RunReply` cross as ISO strings (`Date.toJSON`), exactly what `JSON.stringify` produces.
// ---------------------------------------------------------------------------

/**
 * A store-less `tenant` pod → control-plane request to start a run, published on `${P}-start-run`
 * (BullMQ queue, job `startRun`). The control plane's `onStartRun` consumer turns it into a durable
 * run via the engine. `tenant` names the namespace/partition that owns the run (the responder trusts
 * a verified token over this claim — spec §9); it is separate from the wire-level key prefix so one
 * transport can serve multiple tenants. Byte-compatible with aviary's `StartRunMessage`.
 */
export interface StartRunMessage {
  /** The tenant/namespace the run belongs to (a claim; the responder derives the real one from the token). */
  tenant: string;
  /** Registered workflow name. */
  workflow: string;
  input: unknown;
  /** Caller-supplied run id (idempotency key). The proxy always mints one so it can correlate the reply. */
  runId?: string | undefined;
  /** Tags to stamp on the run (merged with the workflow's static tags). */
  tags?: string[] | undefined;
  /** Typed, queryable run data to stamp on the run (same as {@link StartOptions.searchAttributes}). */
  searchAttributes?: SearchAttributes | undefined;
}

/**
 * A store-less `tenant` pod → control-plane read/control request, enqueued on `${P}-run-request`
 * (BullMQ queue, job `runRequest`). The control plane's `onRunRequest` consumer answers it — scoped to
 * `tenant` (spec §9) — and publishes a correlated {@link RunReply} on `${P}-run-reply`. Envelope is
 * byte-compatible with aviary; the {@link RunRequestKind} verb set mirrors THIS package's
 * {@link RunGateway} surface (see the note on `RunRequestKind`).
 */
export interface RunRequest {
  /** Correlation id minted by the tenant; the matching {@link RunReply} carries it back. */
  requestId: string;
  /** The requesting tenant — the responder scopes the run's namespace/ownership to this. */
  tenant: string;
  body: RunRequestKind;
}

/**
 * The discriminated verb + args of a {@link RunRequest}. Mirrors THIS package's tenant-facing
 * {@link RunGateway} — so it diverges from aviary's verb set (aviary has `getRunDetail`/`retry`/
 * `continue`/`retryWithInput`/`waitingFor`; this package has `getRun`/`getCheckpoints`/
 * `getSearchAttributes`/`signal`) while the shared verbs (`listRuns`/`cancel`/`redispatch`/
 * `workerHealth`) keep aviary's EXACT shape, and the request/reply ENVELOPE stays byte-compatible.
 * `start` and `subscribe` are NOT here — they ride `${P}-start-run` and `${P}-tenant-events-<tenant>`
 * respectively.
 */
export type RunRequestKind =
  | { kind: 'getRun'; runId: string }
  | { kind: 'listRuns'; query: RunQuery }
  | { kind: 'getCheckpoints'; runId: string }
  | { kind: 'getSearchAttributes'; runId: string }
  // Parent→child fan-out (the ids of the runs `runId` spawned). runId-bearing, so the responder
  // enforces the tenant-ownership check before answering (anti-IDOR). Additive to the wire: an older
  // control plane simply rejects the unknown verb, an older tenant never sends it.
  | { kind: 'getRunChildren'; runId: string }
  // Per-group worker health — the responder answers it scoped to the requester's own `@<tenant>`
  // groups (see `RunRequestResponder`), so a tenant's Workers panel shows ITS queues, never another's.
  | { kind: 'workerHealth' }
  | { kind: 'signal'; runId: string; signal: string; payload?: unknown }
  | { kind: 'cancel'; runId: string; opts?: { compensate?: boolean } }
  | { kind: 'redispatch'; runId: string };

/** The control plane's answer to a {@link RunRequest} (or to a start-run, correlated by the minted
 *  runId), keyed by `requestId`. Byte-compatible with aviary's `RunReply`. */
export interface RunReply {
  requestId: string;
  result: RunReplyResult;
}

/** Success carries the verb's payload (JSON-serialised); failure carries a re-throwable domain error
 *  (run not found, cross-tenant, unknown workflow). Transport/timeout failures are gateway-level, never
 *  a `RunReply`. */
export type RunReplyResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { message: string; code?: string } };

/**
 * A lifecycle {@link EngineEvent} re-published to a single tenant's channel
 * (`${P}-tenant-events-<tenant>`) so a store-less tenant can live-tail ITS OWN runs. Scoped by the
 * run's namespace at publish time (spec §8). Byte-compatible with aviary's `TenantEvent`.
 */
export interface TenantEvent {
  tenant: string;
  event: EngineEvent;
}

export interface Transport {
  /** engine → worker */
  dispatch(task: RemoteTask): Promise<void>;
  /** worker → engine: a step finished (ok or error). */
  onResult(handler: (result: StepResult) => Promise<void>): void;
  /** worker → engine: liveness signal for an in-flight long step. */
  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void;
  /**
   * Partition this transport's queues/keys by `namespace` (matching the engine's store namespace), so
   * multiple logical deployments can share one broker. Idempotent. An explicit namespace passed to the
   * transport's constructor TAKES PRECEDENCE over this. No-op when `namespace === "default"` (the
   * un-namespaced and `"default"` schemes stay byte-identical — production names never change).
   * Optional — transports that don't partition simply omit it.
   */
  useNamespace?(namespace: string): void;
  /**
   * Park consumer subscriptions (task/result/heartbeat/control loops) instead of starting them,
   * until {@link Transport.startConsumers}. Optional — only broker transports whose queues are
   * point-to-point implement it: there, ANY subscribing process competes with the worker fleet for
   * production jobs, so a process that is not a worker (an ace command, a REPL) must be able to
   * stay a pure producer. In-process transports have no cross-process queues to protect. Must be
   * called before subscriptions are made; dispatching is never deferred.
   */
  deferConsumers?(): void;
  /** Start every consumer subscription parked by {@link Transport.deferConsumers} — the explicit
   *  "this process IS a worker" declaration. Idempotent; a no-op when nothing was deferred. */
  startConsumers?(): void;
  /** Release the transport's resources (broker workers, queues, connections) for a clean shutdown.
   *  Optional — an in-process transport has nothing to close. Called on `onApplicationShutdown`
   *  after the engine drains, so a deploy hands off instead of leaving the broker to time out. */
  close?(): Promise<void>;
  /** engine → workflow worker: dispatch a {@link WorkflowTask} (the polyglot-workflow path). Optional
   *  — only transports that carry workflow tasks (BullMQ) implement it; the {@link RemoteWorkflowExecutor}
   *  uses it + {@link onDecision} to advance a remote workflow over the broker. */
  dispatchWorkflowTask?(task: WorkflowTask): Promise<void>;
  /** workflow worker → engine: a replayed turn's {@link WorkflowDecision}. Pair with dispatchWorkflowTask. */
  onDecision?(handler: (decision: WorkflowDecision) => Promise<void>): void;
  /** workflow worker → engine: a LOCAL step's {@link WorkflowStepEvent}, streamed mid-turn so the
   *  engine can checkpoint it live. Point-to-point (a single engine instance consumes each event and
   *  persists it once — no cross-pod duplicate writes). Optional; only broker transports carry it. */
  dispatchStepEvent?(event: WorkflowStepEvent): Promise<void>;
  /** engine ← workflow worker: consume streamed {@link WorkflowStepEvent}s. Pair with dispatchStepEvent. */
  onStepEvent?(handler: (event: WorkflowStepEvent) => Promise<void>): void;
  /** Worker-health for a group: queue backlog + live worker heartbeats. Optional — only broker
   *  transports (BullMQ) that can introspect the task queue and the worker-heartbeat keys implement
   *  it. The engine aggregates this across its groups in {@link WorkflowEngine.workerHealth}. */
  groupHealth?(group: string): Promise<GroupHealth>;
  /** Distinct groups that currently have a live worker heartbeat — discovered from the heartbeat
   *  keyspace, so a group with workers but no engine-side registration (e.g. a local-step group)
   *  still surfaces. Pairs with {@link groupHealth}. */
  listWorkerGroups?(): Promise<string[]>;
  /**
   * The LIVE worker handshake descriptors advertised on a routing `token` — read from the
   * `${P}-worker-descriptor:<token>:*` keys a {@link WorkerDescriptor}-publishing worker runtime
   * writes (design §7.2). The control-plane consults these BEFORE dispatch to route capability-aware
   * and negotiate protocol compatibility (design §7.5): if none is capable/compatible the run parks
   * `blocked` instead of hanging. OPTIONAL and additive — a transport that can't introspect the
   * descriptor keyspace (in-process, or a pre-handshake broker) simply omits it, and the engine then
   * skips the guard and dispatches as before (legacy assume-compatible, design §7.7). MUST degrade to
   * `[]` (never throw) when the keyspace is empty or unreadable. Pairs with {@link listWorkerGroups}.
   */
  listWorkerDescriptors?(token: string): Promise<WorkerDescriptor[]>;

  // -------------------------------------------------------------------------
  // P4 — store-less read/control/start protocol (spec §6.2, §8). All OPTIONAL:
  // only broker transports that carry the hosted-control-plane protocol (BullMQ) implement them, so a
  // caller capability-checks (`transport.dispatchRunRequest?.(…)`) before wiring the proxy/responder.
  // start-run & run-request ride BullMQ QUEUES (durable, one consumer); run-reply & tenant-events ride
  // Redis PUB/SUB (fan-out) — the same substrate `RedisControlPlane` uses (spec §6 note).
  // -------------------------------------------------------------------------

  /** tenant → control plane: publish a {@link StartRunMessage} on `${P}-start-run` (queue, job
   *  `startRun`) requesting a new run. Pair with {@link onStartRun}. */
  dispatchStartRun?(msg: StartRunMessage): Promise<void>;
  /** control plane ← tenant: consume {@link StartRunMessage}s and start runs. Pair with
   *  {@link dispatchStartRun}. Idempotent — a second call is a no-op. */
  onStartRun?(handler: (msg: StartRunMessage) => Promise<void>): void;
  /** tenant → control plane: publish a {@link RunRequest} (read/control) on `${P}-run-request` (queue,
   *  job `runRequest`). Pair with {@link onRunRequest}. */
  dispatchRunRequest?(msg: RunRequest): Promise<void>;
  /** control plane ← tenant: consume {@link RunRequest}s. Pair with {@link dispatchRunRequest}.
   *  Idempotent — a second call is a no-op. */
  onRunRequest?(handler: (msg: RunRequest) => Promise<void>): void;
  /** control plane → tenant: publish a correlated {@link RunReply} on `${P}-run-reply` (pub/sub; every
   *  tenant subscribes and filters by `requestId` client-side). Pair with {@link onRunReply}. */
  publishRunReply?(reply: RunReply): Promise<void>;
  /** tenant ← control plane: consume {@link RunReply}s (filter by `requestId` client-side). Pair with
   *  {@link publishRunReply}. Idempotent — a second call is a no-op. */
  onRunReply?(handler: (reply: RunReply) => void): void;
  /** control plane → tenant: re-publish a lifecycle {@link TenantEvent} on the run's per-tenant channel
   *  `${P}-tenant-events-<tenant>`. Pair with {@link onTenantEvent}. */
  publishTenantEvent?(evt: TenantEvent): Promise<void>;
  /** tenant ← control plane: subscribe to THIS tenant's event channel. Returns an unsubscribe fn.
   *  Several tenants (or several callers per tenant) may subscribe independently. */
  onTenantEvent?(tenant: string, handler: (evt: TenantEvent) => void): () => void;
}

/** One worker's liveness record — a TTL'd heartbeat a worker refreshes while it's consuming. Its
 *  ABSENCE (the key expired) is the signal: a worker that died or stalled stops refreshing. */
export interface WorkerHeartbeat {
  /** The worker group this instance serves (e.g. `pipeline`, `processing-workflows`). */
  group: string;
  /** Stable per-process id (host + pid), so N replicas of a group each show as a distinct worker. */
  instanceId: string;
  /** Epoch ms of the worker's most recent heartbeat. */
  lastBeatAt: number;
}

/** Per-group worker-health snapshot: how much work is queued vs. how many workers are alive to do it.
 *  The actionable alert state is `depth > 0 && liveWorkers.length === 0` — work piling up with no
 *  consumer (exactly the failure where a worker is "alive but not consuming"). */
export interface GroupHealth {
  group: string;
  /** Outstanding jobs in the group's task queue (waiting + active + delayed + prioritized). */
  depth: number;
  /** Workers with a non-expired heartbeat for this group. */
  liveWorkers: WorkerHeartbeat[];
}

/**
 * The **control plane** — a broadcast pub/sub across ALL engine instances (every pod), separate
 * from the {@link Transport}'s point-to-point work queues (`dispatch`/`onResult`). It carries what
 * every instance may need regardless of who runs a given run: lifecycle events (so a dashboard-only
 * pod can live-tail a run executing on a worker pod) and cancellation (so the pod actually running a
 * run learns it was cancelled elsewhere). In-process implementations broadcast locally; a
 * cross-process one (BullMQ) fans out over its broker (Redis pub/sub). Give the engine a
 * `controlPlane` to enable cross-instance events/cancellation; omit it and the engine is local-only.
 * A transport that can broadcast may implement this too and be passed as both.
 */
export interface ControlPlane {
  publishControl(msg: ControlMessage): Promise<void>;
  onControl(handler: (msg: ControlMessage) => void): void;
}

/** A message on the {@link ControlPlane}. `from` is the originating engine's `instanceId`, so a
 *  broker that echoes a publish back to its own subscriber (e.g. Redis pub/sub) can be deduped by
 *  the originator. */
export type ControlMessage = { from?: string } & (
  | { kind: 'event'; event: EngineEvent }
  | { kind: 'cancel'; runId: string }
  // A run was just enqueued — nudge worker instances to pick it up now instead of on the next poll.
  | { kind: 'enqueued'; runId: string }
);

// ---------------------------------------------------------------------------
// Authoring — workflows, local steps, and typed remote steps
// ---------------------------------------------------------------------------

export type BackoffStrategy = 'fixed' | 'exp';

/**
 * Options for `ctx.child` / `ctx.startChild`. A bare string passed instead is shorthand for
 * `{ childId }`, so the existing `ctx.child(ref, input, 'my-id')` form keeps working.
 */
export interface ChildCallOptions {
  /** Deterministic child run id; defaults to one derived from the parent run id + call position. */
  childId?: string | undefined;
  /**
   * Dispatch priority for a REMOTE child workflow — stamped on the child run and carried onto every
   * {@link WorkflowTask} dispatched to advance it, so an urgent child can jump ahead of enqueued
   * lower-priority ones at the worker. Higher wins; absent = unprioritised. Ignored for an in-process
   * (TS class) child, which runs in the engine and never hits a broker queue.
   */
  priority?: number | undefined;
}

export interface StepOptions {
  /** Max attempts before the step (and run) fails. */
  retries?: number;
  /** How the delay between retries grows: `fixed` (constant) or `exp` (doubles each attempt). */
  backoff?: BackoffStrategy;
  /** Base delay in ms between retries. Omit (or 0) to retry with no delay. */
  backoffMs?: number;
  /** Upper bound on the (exponential) backoff delay. */
  backoffMaxMs?: number;
  /** Add random jitter (50–100% of the computed delay) to avoid thundering-herd retries. */
  jitter?: boolean;
  /**
   * Liveness window for a dispatched step (`ctx.step`): if the worker produces no result and no
   * heartbeat within this many ms, the engine presumes it dead and fails the dispatch with a
   * `RemoteStepTimeout` (retryable — it re-dispatches per `retries`). Each heartbeat resets the
   * window. Ignored for local steps. Omit to wait indefinitely.
   */
  timeoutMs?: number;
  /**
   * Liveness window (ms) for the stretch BEFORE the worker's first heartbeat — i.e. the queue wait
   * plus execution start. Defaults to `timeoutMs`. Set it LARGER than `timeoutMs` when jobs can
   * legitimately queue behind long work with no one beating for them (a single-concurrency worker
   * whose batches run ~15min: the next batch waits silently the whole time) — otherwise the
   * dispatch-anchored window false-fails a healthy-but-busy fleet. The worker emits an automatic
   * pickup beat when it claims the task, so once execution starts the (tighter) `timeoutMs` governs:
   * `pickupTimeoutMs` = "how long may it stay queued", `timeoutMs` = "max silence while running".
   * Only meaningful together with `timeoutMs`.
   */
  pickupTimeoutMs?: number;
  /**
   * Saga compensation: if this step completes but the run later **fails**, the engine runs the
   * registered `compensate` callbacks in reverse order (undo what was done). Local steps only.
   * Idempotency note: a step is already deduplicated by its deterministic `stepId` (runId:seq) —
   * remote workers can use it as the idempotency key, so there's no separate key option.
   */
  compensate?: () => Promise<void>;
  /**
   * Capabilities a live worker must advertise (in its handshake descriptor) to run this step
   * (design §7.5). The control-plane dispatches only to workers whose descriptor advertises EVERY
   * name here; if no live capable+protocol-compatible worker exists the run parks `blocked` with a
   * precise reason instead of dispatching into a queue nobody consumes. Absent/empty = "runs
   * anywhere" (the backward-compatible default — no requirement). Order-insensitive (a set).
   */
  requires?: string[] | undefined;
}

/**
 * The structural carrier a dispatched `ctx.step` call resolves to and hands the engine. `name` is
 * the routing contract: the worker registers a handler under the same name, and routing is BY that
 * name (a worker subscribes per registered handler name, not a hand-declared group). There is no
 * public factory for this anymore — `ctx.step(ref, input)` builds one internally from the
 * `@Step`-stamped name (see {@link StepRef}/`stepNameOf`) and a `ctx.step(name, input)` from the
 * literal string. `input`/`output` are OPTIONAL runtime zod schemas an authoring layer MAY attach
 * (e.g. `@Step({ input, output })`) for validation at the dispatch boundary — a bare `@Step()`
 * carries neither, and the engine skips validation when they're absent. The `StepOptions` fields
 * (retries/backoff/timeoutMs …) carry the merged per-call/def dispatch policy.
 */
export interface StepDef<TInput = unknown, TOutput = unknown> extends StepOptions {
  name: string;
  /** Optional isolation partition; routing is by `name`. Suffixes the routing token as
   *  `<name>@<partition>` (via `tenantGroup`) — omit to route by the bare (sanitized) `name`. */
  partition?: string | undefined;
  input?: z.ZodType<TInput> | undefined;
  output?: z.ZodType<TOutput> | undefined;
}

/**
 * Options for a dispatched {@link WorkflowCtx.step} call. `retries`/`backoff`/`backoffMs`/
 * `backoffMaxMs`/`jitter`/`timeoutMs` are a PER-CALL override of the `@Step`-declared policy — the
 * effective policy `ctx.step` builds into the dispatched {@link StepDef} is
 * `{ ...stepConfigOf(ref), ...opts }`, so a call-site value wins field-by-field. The string
 * (cross-runtime) form of `ctx.step` has no stamped `@Step` to read, so it uses these fields as-is.
 */
export interface StepDispatchOpts {
  /** Subject the dispatch to a registered flow-control queue (concurrency / rate limit). */
  queue?: string;
  /** Admission priority within `queue`; higher is admitted first when a slot is contended
   *  (default 0). No effect without a `queue`. */
  priority?: number;
  /** The fairness bucket for a queue with `fairness: 'key'` (e.g. a tenant id) — the queue
   *  round-robins across distinct keys so one key can't monopolize the budget. Defaults to the run
   *  id when omitted. No effect without a `queue`. */
  fairnessKey?: string;
  /** Pin the dispatch to a named transport in the pool (else the pool's first, with failover to the
   *  rest). */
  transport?: string;
  /** Max attempts before the step (and run) fails. Overrides the `@Step`-declared value. */
  retries?: number;
  /** How the delay between retries grows: `fixed` (constant) or `exp` (doubles each attempt). */
  backoff?: BackoffStrategy;
  /** Base delay in ms between retries. Omit (or 0) to retry with no delay. */
  backoffMs?: number;
  /** Upper bound on the (exponential) backoff delay. */
  backoffMaxMs?: number;
  /** Add random jitter (50–100% of the computed delay) to avoid thundering-herd retries. */
  jitter?: boolean;
  /** Liveness window for this dispatched step (ms): presume the worker dead and re-dispatch on
   *  timeout (retryable per `retries`). Omit to wait indefinitely. Overrides the `@Step` value. */
  timeoutMs?: number;
  /** Pre-first-heartbeat liveness window (queue wait + pickup; see {@link StepOptions.pickupTimeoutMs}).
   *  Overrides the `@Step` value. Defaults to `timeoutMs`. */
  pickupTimeoutMs?: number;
  /** Capabilities a live worker must advertise to run this step (design §7.5). Overrides/augments the
   *  `@Step`-declared `requires`. If no live capable+compatible worker exists the run parks `blocked`
   *  with a precise reason rather than dispatching into a queue nobody consumes. Absent = no
   *  requirement (runs anywhere) — the backward-compatible default. */
  requires?: string[];
}

/** What a saga undo handler receives: the compensated step's original input and its result — the
 *  dispatched envelope handed to a `ctx.step(..., { compensate })` undo at unwind time. */
export interface StepUndo<TInput, TOutput> {
  input: TInput;
  output: TOutput;
}

/**
 * The {@link StepUndo} envelope for a step handler `H`, derived from its signature so the ref form of
 * `ctx.step(..., { compensate })` is compile-checked against the step it undoes:
 *
 * ```ts
 * async cancelBooking(undo: UndoOf<FlightService['book']>) { ... }
 * ```
 */
export type UndoOf<H> = H extends (input: infer I, ...rest: never[]) => infer R
  ? StepUndo<I, Awaited<R>>
  : StepUndo<unknown, unknown>;

/**
 * A durable webhook handle minted by {@link WorkflowCtx.webhook}. Hand `url` to a third party,
 * then `await wait()` — the run suspends with zero compute until the external system POSTs the
 * callback (delivered as `engine.signal(token, body)`), and resumes with the body.
 */
export interface DurableWebhook<TPayload = unknown> {
  /** Deterministic signal token (`wh:<runId>:<seq>`) the callback delivers on — stable across replay. */
  readonly token: string;
  /**
   * Public callback URL for `token`, built by the engine's `webhookUrl` option. Hand this to the
   * third party. `undefined` when no builder is configured (use {@link DurableWebhook.token} to
   * build your own).
   */
  readonly url?: string | undefined;
  /**
   * Suspend until the callback arrives, then resume with its payload. Waits indefinitely by default —
   * no compute consumed. Pass `{ timeoutMs }` to bound the wait: if the deadline passes first the call
   * throws a `SignalTimeoutError` (catch it in the workflow to branch) — same timeout semantics as
   * {@link WorkflowCtx.waitForSignal}. The deadline is computed once (on the first call) and persisted,
   * so a replay reuses the recorded deadline rather than recomputing it from the current clock.
   */
  wait(opts?: { timeoutMs?: number }): Promise<TPayload>;
}

/**
 * The context handed to a workflow function. Every interaction with the outside world goes
 * through it so the engine can checkpoint — the workflow body itself stays deterministic.
 */
export interface WorkflowCtx {
  readonly runId: string;
  /**
   * Run a durable step — always dispatched, always engine-scheduled: the ONE step primitive (no
   * local/remote placement choice). Pass the step's method **reference** (a `@Step`-decorated method
   * or a {@link import('./step-ref.js').defineStep} handle, typed by its own signature —
   * refactor-safe, autocompleted):
   *
   * ```ts
   * const r = await ctx.step(this.extraction.runExtractionPage, { page, key })
   * ```
   *
   * or its **name** for a cross-runtime handler (no JS reference to import, e.g. a Python worker):
   *
   * ```ts
   * const out = await ctx.step<ProcResult>('processing:proc', input)
   * ```
   *
   * Both forms dispatch identically — a step runs on whatever worker serves that name and the run
   * suspends (zero compute) until the result lands, then resumes with it (durable, replay-safe).
   * `opts.compensate` registers a saga undo (a `@Step` ref/name) run in reverse if the run later
   * fails or is cancelled `{ compensate: true }`; it receives this call's {@link StepUndo} envelope.
   */
  step<TInput, TOutput>(
    handler: StepRef<TInput, TOutput>,
    input: TInput,
    opts?: StepDispatchOpts & { compensate?: StepRef<StepUndo<TInput, TOutput>, unknown> | string },
  ): Promise<TOutput>;
  step<TOutput = unknown>(
    name: string,
    input: unknown,
    opts?: StepDispatchOpts & {
      compensate?: StepRef<StepUndo<unknown, TOutput>, unknown> | string;
    },
  ): Promise<TOutput>;
  /**
   * Run an **in-process** local durable step: executed once IN THE ENGINE, then its result is
   * checkpointed and replayed (never dispatched to a worker). Unlike {@link step} (always
   * dispatched), this runs the body right here — for cheap in-process work, or the deterministic
   * capture helpers. The body receives a {@link StepLogger} to record debug/error lines and
   * sub-process outcomes, checkpointed with the step. Supports `compensate` for in-process sagas.
   */
  localStep<TOutput>(
    name: string,
    fn: (log: StepLogger) => Promise<TOutput>,
    options?: StepOptions,
  ): Promise<TOutput>;
  /**
   * **Exactly-once** durable step for DB work: runs `fn` and writes the step's checkpoint in ONE
   * store transaction, so the business write and the "done" marker commit atomically — a crash can
   * never leave the write done-but-not-checkpointed (which a plain `ctx.step` would re-run). `fn`
   * receives the store-native transaction handle (`tx` — a TypeORM/MikroORM `EntityManager`, a Prisma
   * tx client, or a Drizzle tx); do your writes on it. Needs a SQL store that supports transactions
   * (the bundled SQL adapters do); throws otherwise.
   */
  transaction<TOutput>(name: string, fn: (tx: unknown) => Promise<TOutput>): Promise<TOutput>;
  /**
   * Call a durable **entity** op and await its result — the entity (`engine.registerEntity`) runs the
   * op serialized per `key` over durable state. e.g. `await ctx.callEntity('cart', userId, 'add', item)`.
   */
  callEntity<TResult = unknown>(
    name: string,
    key: string,
    op: string,
    arg?: unknown,
  ): Promise<TResult>;
  /** Send a durable entity op without awaiting a result (fire-and-forget, dispatched once). */
  signalEntity(name: string, key: string, op: string, arg?: unknown): Promise<void>;
  /**
   * Durable sleep: suspends the run for `duration` (e.g. `'30s'`, `'2h'`, `'7 days'`, or ms as a
   * number) without consuming resources, resuming automatically once the timer is due — even
   * across restarts.
   */
  sleep(duration: string | number): Promise<void>;
  /**
   * Durable sleep until an **absolute** time (a `Date` or epoch ms) — like {@link sleep} but for a
   * fixed deadline (e.g. "resume at midnight"). Resumes automatically once the time passes, across
   * restarts. The recorded wake time is fixed on the first run, so it's replay-stable.
   */
  sleepUntil(when: Date | number): Promise<void>;
  /**
   * End this run and **continue as a fresh execution** of the same workflow with `input` and a clean
   * history — for long-running / looping workflows that would otherwise accumulate unbounded
   * checkpoints (and slow replays). The next run gets id `<runId>~N`. Terminal: it always throws, so
   * code after it never runs. Carry forward whatever state the next iteration needs in `input`.
   */
  continueAsNew(input?: unknown): Promise<never>;
  /**
   * Suspend the run until an external `engine.signal(token, payload)` arrives (e.g. a webhook or
   * human approval), then resume with the payload. Waits indefinitely by default — no compute
   * consumed. Pass `{ timeoutMs }` to bound the wait: if the deadline passes first the call throws
   * a `SignalTimeoutError` (catch it in the workflow to branch).
   */
  waitForSignal<TPayload>(token: string, opts?: { timeoutMs?: number }): Promise<TPayload>;
  /**
   * Wait for a named **event** published via `engine.publishEvent(name, payload)`, then resume with
   * the payload. Unlike a signal (point-to-point by token), events are name-based pub/sub: pass an
   * optional `match` (a subset of the payload that must deep-equal) so a publish fans out only to the
   * runs it concerns — e.g. `ctx.waitForEvent('payment.settled', { match: { orderId } })`. `timeoutMs`
   * bounds the wait (throws `SignalTimeoutError`). No compute consumed while waiting.
   */
  waitForEvent<TPayload>(
    name: string,
    opts?: { match?: Record<string, unknown>; timeoutMs?: number },
  ): Promise<TPayload>;
  /**
   * An external task with **async completion**: run `dispatch` once (checkpointed — e.g. send to a
   * queue, kick off a non-durable worker or a foreign service like a Python process), then suspend
   * with zero compute until `engine.completeTask(runId, name, result)` (or `failTask`) reports back,
   * and resume with the result. The durable, first-class counterpart of the hand-rolled
   * "dispatch over SQS → wait for COMPLETE_PHASE → signal" pattern. `name` must be unique per run.
   */
  task<TResult>(
    name: string,
    dispatch: () => Promise<void>,
    options?: StepOptions,
  ): Promise<TResult>;
  /**
   * Run another registered workflow as a **tracked child** and await its result: starts it once and
   * suspends — zero compute — until the child reaches a terminal state, then resumes with the child's
   * output (or throws a FatalError if the child failed). `childId` defaults to a deterministic id
   * derived from this run and the call position, so it's stable across replay.
   *
   * Pass the child's **class** (`ctx.child(ShippingWorkflow, input)`) for a typed input + result; pass
   * a **string** name for a cross-runtime child (e.g. a Python workflow) where there's no class.
   */
  child<C extends WorkflowClass>(
    workflow: C,
    input: WorkflowInputOf<C>,
    options?: string | ChildCallOptions,
  ): Promise<WorkflowOutputOf<C>>;
  child<TOutput>(
    workflow: string,
    input: unknown,
    options?: string | ChildCallOptions,
  ): Promise<TOutput>;
  /**
   * Start a child workflow **fire-and-forget**: dispatches it once (checkpointed, replay-safe) and
   * returns its run id immediately — the parent keeps running instead of suspending. Use it to kick
   * off side work (an audit log, a notification) you don't need to wait on, or to fan out: collect
   * the ids, then later `await ctx.child(...)` each with the same id to join (the start is idempotent
   * by id, so the child runs exactly once). Class or string ref, like {@link child}.
   */
  startChild<C extends WorkflowClass>(
    workflow: C,
    input: WorkflowInputOf<C>,
    options?: string | ChildCallOptions,
  ): Promise<string>;
  startChild(
    workflow: string,
    input: unknown,
    options?: string | ChildCallOptions,
  ): Promise<string>;
  /**
   * Run N children of the SAME workflow **in parallel** and wait for ALL of them: dispatches one
   * child per entry in `inputs` (concurrently, each with its own durable lifecycle), suspends — zero
   * compute — until every child reaches a terminal state, then resumes with their outputs in **input
   * order**. Child ids are group-scoped and stable (`<runId>.all.<firstSeq>.<i>`), and the running
   * placeholders share a `parallelGroup` tag so the dashboard renders the fan-out as one group.
   *
   * `mode` (default `waitAll`): `waitAll` waits for all then throws an aggregate {@link GatherError}
   * if any failed; `failFast` throws as soon as a failed child is seen, and requests cancellation of
   * every sibling that hasn't completed yet (best-effort, plain cancel — no saga undo; a sibling
   * mid-step only observes it at its next checkpoint, it isn't force-killed mid-synchronous-execution,
   * so a fast sibling can still slip through and complete). Empty `inputs` returns `[]` with no side
   * effects. The wait-all / fan-out counterpart to {@link child}; parity with the Python SDK's
   * `gather_children`.
   */
  all<C extends WorkflowClass>(
    workflow: C,
    inputs: WorkflowInputOf<C>[],
    opts?: { mode?: 'waitAll' | 'failFast' },
  ): Promise<WorkflowOutputOf<C>[]>;
  all<TOutput = unknown>(
    workflow: string,
    inputs: unknown[],
    opts?: { mode?: 'waitAll' | 'failFast' },
  ): Promise<TOutput[]>;
  /**
   * Pause the run at this point until a human resumes it from the dashboard (or
   * `engine.continue(runId)`). Records a visible `pending` checkpoint so the breakpoint shows up
   * in the timeline, then suspends with zero compute — the durable equivalent of a debugger
   * breakpoint. Gate it on your own config to make breakpoints opt-in per run:
   * `if (cfg.breakAfterExtraction) await ctx.breakpoint('after-extraction')`.
   */
  breakpoint(label?: string): Promise<void>;
  /**
   * Mint a durable webhook: returns a handle with a deterministic `token` and (if the engine has a
   * `webhookUrl` builder) a public `url`. Hand the url to a third party — inside a `ctx.step` — then
   * `await handle.wait()` to suspend with zero compute until they POST the callback (the dashboard
   * turns that POST into `engine.signal(token, body)`). The first-class, replay-safe version of
   * "expose a callback URL and wait for it".
   */
  webhook<TPayload>(): DurableWebhook<TPayload>;
  /**
   * Publish a named, queryable value from inside the run — the latest value for `key` is readable
   * externally via `engine.getEvent(runId, key)` while the run is still in flight (progress, a
   * partial result, a status). Checkpointed and replay-safe (overwrites the previous value for the
   * same key). The read side has no effect on the run — the durable, suspend-model counterpart of a
   * Temporal query.
   */
  setEvent<TValue>(key: string, value: TValue): Promise<void>;
  /**
   * Expose a named **update point**: suspend until an external `engine.update(runId, name, arg)`
   * delivers `arg`, then resume with it. The update is run-scoped (`name` need only be unique within
   * the run) and gated by any validator registered via `engine.registerUpdateValidator` — a rejected
   * update never reaches here. Pass `{ timeoutMs }` to bound the wait (throws `SignalTimeoutError`).
   * The durable counterpart of a Temporal update handler.
   */
  onUpdate<TArg>(name: string, opts?: { timeoutMs?: number }): Promise<TArg>;
  /**
   * Guard an in-place workflow change without a new version. Wrap the changed code in
   * `if (await ctx.patched('my-change')) { …new… } else { …old… }`: a fresh run records a marker and
   * takes the new branch (`true`); a run already recorded under the old code keeps the old branch
   * (`false`), because its history has a real step where the marker would sit. The marker is
   * position-transparent for old runs (it doesn't shift their recorded steps), so guarding code is
   * replay-safe. Once every old run has drained, remove the guard (keep the new branch).
   */
  patched(id: string): Promise<boolean>;
  /**
   * Deterministic wall-clock (epoch ms): records the time on the first run and replays the SAME
   * value afterwards. Use this instead of `Date.now()` inside a workflow — a raw `Date.now()` returns
   * a different value on every replay, which silently corrupts a durable run.
   */
  now(): Promise<number>;
  /**
   * **Deterministic capture.** Run `fn` once, checkpoint its result, and on replay return the SAME
   * value WITHOUT re-running `fn` — the durable way to bring a non-deterministic value into a
   * workflow where you control the generator: `ctx.sideEffect(() => uuidv7())`, `() => ulid()`,
   * `() => Math.random()`, a config/env read. Prefer a {@link step} for real work with side effects
   * (a DB write, an API call): `fn` here runs only once and MUST be effectively pure (it produces a
   * value; it is not re-executed on replay), like Temporal's `sideEffect`. For a plain timestamp use
   * {@link now}. Replaces the removed `ctx.random()`/`ctx.uuid()` — pass your own generator.
   */
  sideEffect<TValue>(fn: () => TValue | Promise<TValue>): Promise<TValue>;
  /**
   * Merge `attrs` into THIS run's {@link WorkflowRun.searchAttributes} — the indexed metadata the
   * dashboard and {@link RunQuery} filter on. Shallow merge: keys you don't pass are kept. Durable +
   * exactly-once — recorded at this position on the first run and SKIPPED on replay, so it does one
   * write, not one per turn. Use this instead of injecting the {@link StateStore} to mutate the run
   * you're executing (`store.updateRun(ctx.runId, …)` becomes `ctx.upsertSearchAttributes(…)`).
   */
  upsertSearchAttributes(attrs: SearchAttributes): Promise<void>;
}

/** Result of executing or resuming a workflow run. */
export interface RunResult {
  runId: string;
  status: RunStatus;
  output?: unknown;
  error?: StepError | undefined;
}

/**
 * Validates an incoming `engine.update` before it is delivered to the run. Throw (or return a
 * non-empty string) to reject — the run is left untouched. Return nothing/void to accept. May be
 * async (e.g. a business-rule check against a DB).
 */
// A validator may return nothing (accept) or a reason string (reject); `void` is the intended
// "returned nothing" case, sync or async.
export type UpdateValidator<TArg = unknown> =
  // biome-ignore lint/suspicious/noConfusingVoidType: `void` here means "returned nothing" (accept).
  (arg: TArg) => void | string | Promise<void | string>;

/** Outcome of `engine.update`: rejected by the validator, or accepted and delivered. */
export type UpdateResult =
  | { accepted: false; reason: string }
  | { accepted: true; run: RunResult | null };

export type EngineEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.suspended'
  | 'step.started'
  | 'step.completed'
  | 'step.failed'
  // A single step event (log line / sub-process outcome) emitted WHILE a step is still running, so
  // observers tail a long step's progress live instead of waiting for `step.completed` to deliver
  // the whole `events` array at once. Carries `event`; never persisted (live-tail only).
  | 'step.progress'
  // The run parked `blocked`: no live worker advertised a capability it required (design §7.5/§7.6).
  // Carries `error` (the human reason) + `diagnostics` (the missing-capability delta + descriptors).
  | 'capability.unavailable'
  // The run parked `blocked`: a capable worker existed but every live one is protocol-incompatible
  // (no common major, design §7.4/§7.6). Carries `error` + `diagnostics` (the protocol-range delta).
  | 'protocol.incompatible';

/**
 * A lifecycle event emitted by the engine. The observability surfaces (dashboard, OTel, the
 * Telescope integration) all subscribe to these rather than reaching into the store.
 */
export interface EngineEvent {
  type: EngineEventType;
  runId: string;
  workflow?: string | undefined;
  /** The worker-pool partition the run belongs to (stamped on `run.*` lifecycle events), so an
   *  operator control plane can attribute each event to its tenant/pool. Absent on step events. */
  namespace?: string | undefined;
  seq?: number | undefined;
  name?: string | undefined;
  kind?: StepKind | undefined;
  output?: unknown;
  error?: StepError | undefined;
  /** Wall-clock duration of the unit that just finished (step or run), when known. */
  durationMs?: number | undefined;
  /** For a remote step: how long it waited in the queue before a worker picked it up. */
  queueMs?: number | undefined;
  /** The live step event carried by a `step.progress` (the single log line / sub-process outcome a
   *  running step just emitted). Absent on lifecycle events. */
  event?: StepEvent | undefined;
  /** The structured routing delta carried by a `capability.unavailable`/`protocol.incompatible`
   *  diagnostics event (design §7.6): required capabilities, the live descriptors considered and the
   *  control-plane descriptor negotiated against — enough to render WHY the run parked. Absent on all
   *  other event types. */
  diagnostics?: DispatchDiagnostics | undefined;
  at: Date;
}

export type EngineListener = (event: EngineEvent) => void;

/** What a {@link StepInterceptor} is told about the local step it is wrapping. */
export interface StepInvocation {
  readonly runId: string;
  readonly workflow: string;
  /** The step name passed to `ctx.localStep(name, ...)` (also `'now'`/`'sideEffect'` internals). */
  readonly stepName: string;
  /** The step's logical position within the run. */
  readonly seq: number;
  /** 1-based attempt number — increments across `ctx.step` retries. */
  readonly attempt: number;
}

/**
 * Wraps the **real execution** of a local `ctx.step` (Template/Nest-style onion middleware). Call
 * `next()` to run the step body (or the next interceptor) and return — or transform — its result;
 * throw to fail the step. First-registered runs outermost. Interceptors fire only when a step
 * actually executes, NOT on replay (a replayed step returns its recorded output without running),
 * so they see true execution timing. Register with `engine.use`.
 */
export type StepInterceptor = (
  invocation: StepInvocation,
  next: () => Promise<unknown>,
) => Promise<unknown>;
