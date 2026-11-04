import type { RunStatus, SearchAttributes, StepError, WorkflowRun } from './interfaces.js';
import {
  type WorkflowInputOf,
  type WorkflowOutputOf,
  type WorkflowRef,
  workflowName,
} from './workflow-ref.js';

/**
 * Lifecycle events: when a run settles, the engine publishes `run.completed:<workflow>` or
 * `run.failed:<workflow>` on the same bus as `publishEvent`, so another workflow can start on it
 * through `onEvent` (or `@OnWorkflowCompleted` / `@OnWorkflowFailed`)
 * without the settling workflow knowing it exists.
 *
 * Delivery is exactly once per subscriber and settled run. The terminal status write also tags the
 * run {@link LIFECYCLE_PENDING_TAG}, so a process that dies before publishing leaves a marker the
 * timer poller's lifecycle sweep picks up; the subscriber's run id is deterministic
 * ({@link lifecycleRunId}), so publishing twice starts it once.
 */

/** The event published when a run of `workflow` completes. */
export function runCompletedEvent(workflow: WorkflowRef): string {
  return `run.completed:${workflowName(workflow)}`;
}

/** The event published when a run of `workflow` ends failed, cancelled or dead. */
export function runFailedEvent(workflow: WorkflowRef): string {
  return `run.failed:${workflowName(workflow)}`;
}

/**
 * Tag written with a run's terminal status when some workflow subscribes to its lifecycle event,
 * and removed once the event is published. A settled run still carrying it was never published.
 *
 * Without any {@link LIFECYCLE_OWED_TAG_PREFIX} tag beside it, the run's owed set is unresolved: the
 * terminal write happened before this instance could read the subscriptions the fleet announces
 * (no read yet, or the last one failed). The publish that next reads them successfully resolves it
 * into owed tags; until then, the subscribers registered on an instance are started by it.
 */
export const LIFECYCLE_PENDING_TAG = 'durable:lifecycle:pending';

/**
 * How long after a run settled the lifecycle sweep still looks for subscribers the run owes its
 * event to but was never marked for: one announced by an instance that came up just after the
 * run settled, before the settling instance's snapshot of the fleet's subscriptions saw it. A
 * subscriber that appears later than this is a backfill, done with
 * `WorkflowEngine.republishLifecycle`.
 */
export const LIFECYCLE_HEAL_WINDOW_MS = 2 * 60 * 1000;

/** Prefix of the tags naming the subscribers a settled run started (`durable:triggered:<workflow>`). */
export const LIFECYCLE_TRIGGERED_TAG_PREFIX = 'durable:triggered:';

/**
 * Prefix of the tags naming each subscriber a settled run still owes its lifecycle event to
 * (`durable:lifecycle:owed:<workflow>`). Written with the terminal status, beside
 * {@link LIFECYCLE_PENDING_TAG}, for every subscriber registered locally or announced by a live
 * worker. An instance removes the owed tags of the subscribers it starts; the pending tag goes with
 * the last owed tag.
 */
export const LIFECYCLE_OWED_TAG_PREFIX = 'durable:lifecycle:owed:';

/**
 * How long after a run settled the lifecycle sweep keeps an owed subscriber that no live worker
 * announces and this instance does not register. Past it, the owed tag is dropped and the engine
 * emits `run.trigger_failed`, so a removed subscriber does not keep the run from retention forever.
 */
export const LIFECYCLE_ORPHAN_MS = 24 * 60 * 60 * 1000;

/**
 * Prefix of the tags naming each subscriber a settled run could not start
 * (`durable:trigger_failed:<workflow>`): its `where` threw, its input was rejected, its start failed,
 * or the sweep dropped it as an orphan (see {@link LIFECYCLE_ORPHAN_MS}). Written by the same tag
 * write that drops the subscriber's owed tag, and removed by the write that records a later start of
 * it. The reason is not stored: it is in the `run.trigger_failed` event the failure emits.
 */
export const LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX = 'durable:trigger_failed:';

/** The trigger-failed tag of `subscriber` (see {@link LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX}). */
export function lifecycleTriggerFailedTag(subscriber: string): string {
  return `${LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX}${subscriber}`;
}

/** The owed tag of `subscriber` (see {@link LIFECYCLE_OWED_TAG_PREFIX}). */
export function lifecycleOwedTag(subscriber: string): string {
  return `${LIFECYCLE_OWED_TAG_PREFIX}${subscriber}`;
}

/** The subscribers a run still owes its lifecycle event to, read from its owed tags. */
export function owedSubscribersOf(run: Pick<WorkflowRun, 'tags'>): string[] {
  return (run.tags ?? [])
    .filter((tag) => tag.startsWith(LIFECYCLE_OWED_TAG_PREFIX))
    .map((tag) => tag.slice(LIFECYCLE_OWED_TAG_PREFIX.length));
}

/**
 * The subscribers a settled run's tags record as done with its event: started (a
 * {@link LIFECYCLE_TRIGGERED_TAG_PREFIX} tag) or failed (a {@link LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX}
 * tag).
 */
export function deliveredSubscribersOf(run: Pick<WorkflowRun, 'tags'>): Set<string> {
  const out = new Set<string>();
  for (const tag of run.tags ?? []) {
    if (tag.startsWith(LIFECYCLE_TRIGGERED_TAG_PREFIX)) {
      out.add(tag.slice(LIFECYCLE_TRIGGERED_TAG_PREFIX.length));
    } else if (tag.startsWith(LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX)) {
      out.add(tag.slice(LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX.length));
    }
  }
  return out;
}

/**
 * Prefix of the tag holding the W3C `traceparent` of a settled run's own span
 * (`durable:lifecycle:trace:<traceparent>`). Written with the lifecycle marker, when some workflow
 * subscribes to the run's ending and the engine has a run trace provider (see
 * `WorkflowEngine.setRunTraceparent`), so a subscriber's trace can link to its source run from any
 * process.
 */
export const LIFECYCLE_TRACE_TAG_PREFIX = 'durable:lifecycle:trace:';

/** The traceparent a settled run recorded in its {@link LIFECYCLE_TRACE_TAG_PREFIX} tag, if any. */
export function lifecycleTraceparentOf(tags: readonly string[] | undefined): string | undefined {
  const tag = (tags ?? []).find((t) => t.startsWith(LIFECYCLE_TRACE_TAG_PREFIX));
  return tag?.slice(LIFECYCLE_TRACE_TAG_PREFIX.length) || undefined;
}

/** Whether `tag` is one of the engine's lifecycle bookkeeping tags rather than a user tag. */
export function isLifecycleTag(tag: string): boolean {
  return (
    tag === LIFECYCLE_PENDING_TAG ||
    tag.startsWith(LIFECYCLE_OWED_TAG_PREFIX) ||
    tag.startsWith(LIFECYCLE_TRIGGERED_TAG_PREFIX) ||
    tag.startsWith(LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX) ||
    tag.startsWith(LIFECYCLE_TRACE_TAG_PREFIX)
  );
}

/** The payload of a lifecycle event, read from the store after the run settled. */
export interface WorkflowLifecycleEvent<TInput = unknown, TOutput = unknown> {
  runId: string;
  workflow: string;
  workflowVersion: string;
  /** `completed` on `run.completed:*`; `failed`, `cancelled` or `dead` on `run.failed:*`. */
  status: RunStatus;
  namespace?: string | undefined;
  input: TInput;
  /** Present on a completed run. */
  output?: TOutput | undefined;
  /** Present on a run that did not complete. */
  error?: StepError | undefined;
  tags?: string[] | undefined;
  searchAttributes?: SearchAttributes | undefined;
}

/** The lifecycle event a run of workflow class `C` publishes, typed by its input and output. */
export type LifecycleEventOf<C> = WorkflowLifecycleEvent<WorkflowInputOf<C>, WorkflowOutputOf<C>>;

/** Which lifecycle event a settled run publishes: `completed`, or `failed` for any other ending. */
export type LifecycleKind = 'completed' | 'failed';

/**
 * The id of the run a lifecycle event starts for `subscriber`. Deterministic, so the same settled
 * run never starts the same subscriber twice, and either side of the link can be found from the other.
 */
export function lifecycleRunId(
  sourceRunId: string,
  kind: LifecycleKind,
  subscriber: string,
): string {
  return `evt:${sourceRunId}:${kind}:${subscriber}`;
}

/** The lifecycle event a run in `status` published, or undefined while it has not settled. */
export function lifecycleKindOf(status: RunStatus | undefined): LifecycleKind | undefined {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled' || status === 'dead') return 'failed';
  return undefined;
}

/** The event name a run of `workflow` publishes when it settles as `kind`. */
export function lifecycleEventName(workflow: string, kind: LifecycleKind): string {
  return kind === 'completed' ? runCompletedEvent(workflow) : runFailedEvent(workflow);
}

/** The workflow and ending a lifecycle event name stands for, or undefined for any other event. */
export function parseLifecycleEvent(
  event: string,
): { workflow: string; kind: LifecycleKind } | undefined {
  for (const kind of ['completed', 'failed'] as const) {
    const prefix = `run.${kind}:`;
    if (event.startsWith(prefix) && event.length > prefix.length) {
      return { workflow: event.slice(prefix.length), kind };
    }
  }
  return undefined;
}

/**
 * One workflow that starts when another settles, as the dashboard's workflow page lists it. `local`
 * is what the answering instance has registered, with what its subscription does to the payload;
 * an entry only live workers announce (a Python subscriber, or a TypeScript one served elsewhere)
 * states none of that, since the announcement carries only the event name.
 */
export interface LifecycleSubscriptionLink {
  /** The other end: the subscriber on `startsOnSettle`, the settling workflow on `startedBy`. */
  workflow: string;
  kind: LifecycleKind;
  /** Registered on the answering instance (true) or only announced by live workers (false). */
  local: boolean;
  /** Announced by at least one live worker. */
  announced: boolean;
  /** The subscription filters payloads with `where`. */
  where: boolean;
  /** The subscription maps the payload to the run's input with `input`. */
  input: boolean;
  /** The subscriber coalesces events: debounced or batched, and whether per `key`. */
  coalesce?: { mode: 'debounce' | 'batch'; keyed: boolean } | undefined;
}

/**
 * Who starts whom through lifecycle events, for one workflow: the subscribers of its
 * `run.completed:<workflow>` / `run.failed:<workflow>` events, and the workflows whose settling
 * starts it. Built from the answering instance's registry and the subscriptions live workers
 * announce.
 */
export interface WorkflowLifecycleLinks {
  workflow: string;
  /** Workflows that start when this one settles, sorted by workflow then kind. */
  startsOnSettle: LifecycleSubscriptionLink[];
  /** Workflows whose settling starts this one, sorted by workflow then kind. */
  startedBy: LifecycleSubscriptionLink[];
}

/**
 * The run whose settling started `run`, when a lifecycle event started it. Read from the run's id,
 * which ends in `:<kind>:<its own workflow>`, so it holds whatever input the subscriber was given.
 */
export function lifecycleSourceOf(run: {
  id: string;
  workflow: string;
}): { runId: string; kind: LifecycleKind } | undefined {
  if (!run.id.startsWith('evt:')) return undefined;
  for (const kind of ['completed', 'failed'] as const) {
    const suffix = `:${kind}:${run.workflow}`;
    if (run.id.endsWith(suffix) && run.id.length > 'evt:'.length + suffix.length) {
      return { runId: run.id.slice('evt:'.length, -suffix.length), kind };
    }
  }
  return undefined;
}

/**
 * The runs `run`'s settling started, read from its {@link LIFECYCLE_TRIGGERED_TAG_PREFIX} tags.
 * Empty for a run that has not settled or started nobody. Needs no subscriber registry, so any
 * process holding the run row can answer it.
 */
export function triggeredRunsOf(run: Pick<WorkflowRun, 'id' | 'status' | 'tags'>): string[] {
  const kind = lifecycleKindOf(run.status);
  if (!kind) return [];
  return (run.tags ?? [])
    .filter((tag) => tag.startsWith(LIFECYCLE_TRIGGERED_TAG_PREFIX))
    .map((tag) => lifecycleRunId(run.id, kind, tag.slice(LIFECYCLE_TRIGGERED_TAG_PREFIX.length)));
}

/** The {@link WorkflowLifecycleEvent} a settled run publishes. */
export function lifecycleEventOf(run: WorkflowRun): WorkflowLifecycleEvent {
  const completed = run.status === 'completed';
  return {
    runId: run.id,
    workflow: run.workflow,
    workflowVersion: run.workflowVersion,
    status: run.status,
    namespace: run.namespace,
    input: run.input,
    ...(completed ? { output: run.output } : { error: run.error }),
    tags: run.tags?.filter((tag) => !isLifecycleTag(tag)),
    searchAttributes: run.searchAttributes,
  };
}

/**
 * What `engine.republishLifecycle` publishes again: one settled run, or the settled runs of a
 * workflow (by ending and settle time). `subscriber` restricts it to one subscribing workflow.
 */
export type RepublishLifecycleTarget =
  | { runId: string; subscriber?: string | undefined }
  | {
      workflow: string;
      /** Only runs that settled this way. Both when absent. */
      kind?: LifecycleKind | undefined;
      /** Only runs that settled at or after this instant. */
      since?: Date | undefined;
      /** Only runs that settled at or before this instant. */
      until?: Date | undefined;
      subscriber?: string | undefined;
      /** At most this many runs. Default 1000. */
      limit?: number | undefined;
      /**
       * Only runs of this namespace. Defaults to the engine's own namespace (every namespace on an
       * engine without one). The run gateway's tenant proxy forces it to the tenant's.
       */
      namespace?: string | undefined;
    };

/** What `engine.republishLifecycle` did. */
export interface RepublishLifecycleResult {
  /** Settled runs it published. */
  runs: number;
  /** Subscriber runs it started. A subscriber run that already existed is not counted. */
  started: number;
  /** Subscribers it could not start, with why. */
  failed: { runId: string; subscriber: string; error: string }[];
}

/** The literal prefix of every `ctx.waitForRun` waiter token. */
export const RUN_WAIT_TOKEN_PREFIX = 'runwait:';

/** Token prefix of every `ctx.waitForRun` waiter on `targetRunId`. */
export function runWaitPrefix(targetRunId: string): string {
  return `${RUN_WAIT_TOKEN_PREFIX}${targetRunId}#`;
}

/** The waiter token of one `ctx.waitForRun(targetRunId)` call, unique by the waiting run's `runId#seq`. */
export function runWaitToken(targetRunId: string, runId: string, seq: number): string {
  return `${runWaitPrefix(targetRunId)}${runId}#${seq}`;
}

/**
 * The run a `ctx.waitForRun` waiter waits for, read from its token, or undefined for any other
 * waiter. The token ends in the waiter's own `#<runId>#<seq>`, so a target id holding `#` still
 * parses.
 */
export function runWaitTargetOf(waiter: {
  token: string;
  runId: string;
  seq: number;
}): string | undefined {
  if (!waiter.token.startsWith(RUN_WAIT_TOKEN_PREFIX)) return undefined;
  const suffix = `#${waiter.runId}#${waiter.seq}`;
  if (!waiter.token.endsWith(suffix)) return undefined;
  const target = waiter.token.slice(RUN_WAIT_TOKEN_PREFIX.length, -suffix.length);
  return target.length > 0 ? target : undefined;
}

/**
 * One end of a `ctx.waitForRun` wait, as a run detail lists it: the run waited for (`waitsFor`) or
 * the waiting run (`awaitedBy`), the waiting run's `seq` of the call, and the other run's status and
 * namespace when it was read.
 */
export interface RunWaitLink {
  runId: string;
  seq: number;
  status?: RunStatus | undefined;
  namespace?: string | undefined;
}

/**
 * Where a settled run's lifecycle event stands for one subscriber:
 * - `started`: its run exists (`runId`, a `durable:triggered:<subscriber>` tag);
 * - `owed`: still pending (a `durable:lifecycle:owed:<subscriber>` tag);
 * - `failed`: its last delivery failed (a `durable:trigger_failed:<subscriber>` tag): its `where`
 *   threw, its input was rejected, its start failed, or the sweep dropped it as an orphan. A
 *   republish retries it;
 * - `coalesced`: routed into a debounce/batch accumulator (`runId` is the accumulator's, when it
 *   can be derived);
 * - `not-started`: no run and nothing owed: its `where` declined the event, it coalesces on another
 *   instance, or it subscribed after the run settled.
 */
export type LifecycleDeliveryState = 'started' | 'owed' | 'failed' | 'coalesced' | 'not-started';

/** One subscriber of a settled run's lifecycle event, as the run detail lists it. */
export interface LifecycleDelivery {
  subscriber: string;
  state: LifecycleDeliveryState;
  /** The subscriber's run when `started`; the accumulator run when `coalesced` and derivable. */
  runId?: string | undefined;
  /** The status of a `started` subscriber's run, when it was read. */
  status?: RunStatus | undefined;
  /** The namespace of a `started` subscriber's run, when it was read. */
  namespace?: string | undefined;
  /** When an `owed` subscriber became owed: the settled run's last update (epoch ms). */
  owedSince?: number | undefined;
  /**
   * When the lifecycle sweep drops an `owed` subscriber that no live instance registers or
   * announces for the run's namespace (epoch ms; see {@link LIFECYCLE_ORPHAN_MS}). Absent while one
   * does.
   */
  orphanAt?: number | undefined;
  /**
   * Why a `failed` subscriber could not be started, when the caller knows it (the `run.trigger_failed`
   * event carries it). Not stored with the run, so {@link lifecycleDeliveriesOf} leaves it unset.
   */
  error?: string | undefined;
}

/**
 * The {@link LifecycleDelivery} of each subscriber of a settled run, sorted by subscriber: the
 * union of `subscribers` (the ones the run's event goes to now), the owed, triggered and
 * trigger-failed tags. A started subscriber wins over the others, then an owed one over a failed
 * one. `live` names the subscribers a live instance registers or announces; an owed subscriber
 * outside it gets `orphanAt`. `coalesced` maps each subscriber that coalesces its events to its
 * accumulator run id (undefined when it cannot be derived). Empty for a run that has not settled.
 */
export function lifecycleDeliveriesOf(
  run: Pick<WorkflowRun, 'id' | 'status' | 'tags' | 'updatedAt'>,
  opts: {
    subscribers: readonly string[];
    live: ReadonlySet<string>;
    coalesced?: ReadonlyMap<string, string | undefined> | undefined;
  },
): LifecycleDelivery[] {
  const kind = lifecycleKindOf(run.status);
  if (!kind) return [];
  const tags = run.tags ?? [];
  const owed = new Set(owedSubscribersOf(run));
  const triggered = new Set(
    tags
      .filter((t) => t.startsWith(LIFECYCLE_TRIGGERED_TAG_PREFIX))
      .map((t) => t.slice(LIFECYCLE_TRIGGERED_TAG_PREFIX.length)),
  );
  const failed = new Set(
    tags
      .filter((t) => t.startsWith(LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX))
      .map((t) => t.slice(LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX.length)),
  );
  // A run marked pending without owed tags is owed to every subscriber it has not started.
  const owedToAll = owed.size === 0 && tags.includes(LIFECYCLE_PENDING_TAG);
  const settledAt = run.updatedAt.getTime();
  const names = [...new Set([...opts.subscribers, ...owed, ...triggered, ...failed])].sort();
  return names.map((subscriber): LifecycleDelivery => {
    if (triggered.has(subscriber)) {
      return { subscriber, state: 'started', runId: lifecycleRunId(run.id, kind, subscriber) };
    }
    if (owed.has(subscriber) || owedToAll) {
      return {
        subscriber,
        state: 'owed',
        owedSince: settledAt,
        ...(opts.live.has(subscriber) ? {} : { orphanAt: settledAt + LIFECYCLE_ORPHAN_MS }),
      };
    }
    if (failed.has(subscriber)) return { subscriber, state: 'failed' };
    if (opts.coalesced?.has(subscriber)) {
      const runId = opts.coalesced.get(subscriber);
      return { subscriber, state: 'coalesced', ...(runId !== undefined ? { runId } : {}) };
    }
    return { subscriber, state: 'not-started' };
  });
}

/** The id of the run a continue-as-new of `runId` hands off to: `r` → `r~1` → `r~2` … */
export function nextContinuationId(runId: string): string {
  const m = runId.match(/^(.*)~(\d+)$/);
  return m ? `${m[1]}~${Number(m[2]) + 1}` : `${runId}~1`;
}

/** How many continue-as-new hops `ctx.waitForRun` follows to the run that ends a chain. */
export const RUN_WAIT_MAX_HOPS = 100;

/**
 * The run that ends `runId`'s continue-as-new chain: `runId` itself, or the last continuation it
 * handed off to, following at most {@link RUN_WAIT_MAX_HOPS} hops. A completed run whose
 * continuation exists was a handoff, not the end. Null when `runId` is unknown.
 */
export async function lastRunOfChain(
  getRun: (runId: string) => Promise<WorkflowRun | null>,
  runId: string,
): Promise<WorkflowRun | null> {
  let run = await getRun(runId);
  for (let hop = 0; run?.status === 'completed' && hop < RUN_WAIT_MAX_HOPS; hop += 1) {
    const next = await getRun(nextContinuationId(run.id));
    if (!next) break;
    run = next;
  }
  return run;
}

/**
 * The runs whose continue-as-new chain `runId` may end (`r~3` → `r`, `r~1`, `r~2`, at most
 * {@link RUN_WAIT_MAX_HOPS}), so a `ctx.waitForRun` on an earlier run of the chain is found when the
 * last one settles. Empty for a run that is no continuation.
 */
export function chainPredecessorsOf(runId: string): string[] {
  const m = runId.match(/^(.*)~(\d+)$/);
  if (!m) return [];
  const base = m[1] as string;
  const n = Number(m[2]);
  const ids: string[] = [];
  for (let i = Math.max(0, n - RUN_WAIT_MAX_HOPS); i < n; i += 1) {
    ids.push(i === 0 ? base : `${base}~${i}`);
  }
  return ids;
}

/**
 * The internal workflow whose runs make up the lifecycle subscription registry: one completed run
 * per engine that registers `onEvent` subscriptions (lifecycle ones included), id
 * {@link lifecycleRegistryRunId}, tagged {@link LIFECYCLE_REGISTRY_TAG}, its subscriptions in
 * `input` ({@link LifecycleRegistryEntry}) and its `updatedAt` the heartbeat. Each heartbeat also
 * sets `createdAt`, so a read of the live runs is a range over the store's `created_at` index. Kept
 * in the state store, so an engine learns what the others subscribe to over any transport.
 * Retention, run lists and the dashboard skip these runs.
 */
export const LIFECYCLE_REGISTRY_WORKFLOW = '__lifecycle_registry';

/** Tag every registry run carries. Retention never prunes a run that has it. */
export const LIFECYCLE_REGISTRY_TAG = 'durable:lifecycle:registry';

/** How often an engine's worker tick rewrites its registry run. */
export const LIFECYCLE_REGISTRY_HEARTBEAT_MS = 10_000;

/** How long after its last heartbeat a registry run still counts as a live engine's. */
export const LIFECYCLE_REGISTRY_TTL_MS = 35_000;

/** How long after its last heartbeat a registry run is deleted, by the tick of an engine with one. */
export const LIFECYCLE_REGISTRY_STALE_MS = 10 * 60 * 1000;

/** The id of the registry run of engine instance `instanceId`. */
export function lifecycleRegistryRunId(instanceId: string): string {
  return `${LIFECYCLE_REGISTRY_WORKFLOW}:${instanceId}`;
}

/** What a registry run holds in `input`: the `onEvent` subscriptions of one engine instance. */
export interface LifecycleRegistryEntry {
  instanceId: string;
  runtime: 'node';
  /**
   * The namespace of the engine that writes the row, or `null` for an engine with no namespace. The
   * row's own `namespace` cannot tell the two apart: the stores write both as `default`. An engine
   * with no namespace sweeps and starts its subscribers for the runs of every namespace, so its
   * subscriptions are owed by settled runs of any namespace; an engine with one, only by its own.
   */
  engineNamespace: string | null;
  /** Each subscribing workflow with the event names it starts on, lifecycle ones included. */
  subscriptions: { workflow: string; events: string[] }[];
}

/**
 * The namespace whose settled runs owe their lifecycle events to the subscriptions of a registry
 * run, or `null` for every namespace: the entry's `engineNamespace`, or for a row written without it,
 * the row's `namespace`, read as every namespace when that is `default` (an engine with no namespace
 * wrote it, as far as the row can tell).
 */
export function lifecycleRegistryNamespace(
  input: unknown,
  rowNamespace: string | undefined,
): string | null {
  const engineNamespace = (input as { engineNamespace?: unknown } | null | undefined)
    ?.engineNamespace;
  if (engineNamespace === null) return null;
  if (typeof engineNamespace === 'string') return engineNamespace || 'default';
  const row = rowNamespace || 'default';
  return row === 'default' ? null : row;
}

/** The subscriptions a registry run's `input` holds; malformed entries are skipped. */
export function lifecycleRegistrySubscriptions(
  input: unknown,
): { workflow: string; events: string[] }[] {
  const subscriptions = (input as Partial<LifecycleRegistryEntry> | null | undefined)
    ?.subscriptions;
  if (!Array.isArray(subscriptions)) return [];
  return subscriptions.flatMap((entry) => {
    const { workflow, events } = (entry ?? {}) as { workflow?: unknown; events?: unknown };
    if (typeof workflow !== 'string' || !Array.isArray(events)) return [];
    return [{ workflow, events: events.filter((e): e is string => typeof e === 'string') }];
  });
}

/**
 * Whether retention must keep a run with these `tags`: its lifecycle event is still owed
 * ({@link LIFECYCLE_PENDING_TAG}), or it is a lifecycle registry run ({@link LIFECYCLE_REGISTRY_TAG}).
 */
export function retentionKeeps(tags: unknown): boolean {
  if (!Array.isArray(tags)) return false;
  return tags.includes(LIFECYCLE_PENDING_TAG) || tags.includes(LIFECYCLE_REGISTRY_TAG);
}
