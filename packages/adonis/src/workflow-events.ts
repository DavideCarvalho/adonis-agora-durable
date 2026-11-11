import { parseDuration } from './duration.js';
import type { EventBatchConfig } from './event-accumulators.js';
import type { OnEventEntry } from './events.js';
import {
  type LifecycleEventOf,
  runCompletedEvent,
  runFailedEvent,
  type WorkflowLifecycleEvent,
} from './lifecycle-events.js';
import { callerFile, rememberDeclaringFile } from './origin.js';
import {
  type WorkflowClass,
  type WorkflowOptions,
  type WorkflowRef,
  workflowMeta,
} from './workflow-ref.js';

/**
 * Event-triggered workflows: a workflow class declares which **AdonisJS emitter** events start a
 * run (`@OnEvent`). The durable provider bridges the emitter into the engine (a fresh run per
 * matching event, payload as input), mirroring how `static schedule`/`@Scheduled` bridge time into
 * the engine. To start a workflow from a `@adonis-agora/diagnostics` event, write a diagnostics
 * listener that calls `MyWorkflow.dispatch(event.payload, { runId: `evt:${event.id}` })`.
 *
 * Two authoring forms, exactly like schedules:
 * - the `@OnEvent(...)` decorator (named params), and
 * - a colocated `static on = [...]` literal — the decorator only stamps `static on`.
 *
 * ```ts
 * @OnEvent({ event: 'order:placed' })
 * export class ProcessOrderWorkflow extends BaseWorkflow {
 *   static workflow = { name: 'process-order' }
 *   async run(ctx, input) { /* input = the event payload *\/ }
 * }
 * ```
 */

/** A trigger fed by the AdonisJS emitter. Exact event names only (the emitter has no wildcard). */
export interface EmitterTriggerConfig {
  /** The emitter event name, e.g. `'order:placed'`. */
  event: string;
}

/** One colocated event trigger (the `static on` entry). */
export type WorkflowEventTrigger = { source: 'emitter' } & EmitterTriggerConfig;

/** A normalized trigger: the workflow name filled in, ready for the bridge/engine. */
export type NormalizedEventTrigger = { source: 'emitter' } & EmitterTriggerConfig & {
    workflow: string;
  };

/**
 * The canonical engine event name a trigger maps to — the name the workflow registers under
 * `onEvent` and the bridge publishes with: the emitter event name.
 */
export function eventTriggerCanonicalName(trigger: NormalizedEventTrigger): string {
  return trigger.event;
}

/** Read a class's colocated event triggers (`static on`) and fill the workflow name. */
export function workflowEvents(target: unknown): NormalizedEventTrigger[] {
  const meta = workflowMeta(target);
  if (!meta) return [];
  const raw = (target as { on?: WorkflowEventTrigger | WorkflowEventTrigger[] }).on;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((t) => {
    // `source: 'diagnostics'` (the old `@OnDiagnostic`) is gone: fail at boot instead of wiring a
    // trigger that would never fire.
    if ((t as { source?: unknown }).source !== 'emitter') {
      throw new Error(
        `durable: workflow "${meta.name}" declares a \`static on\` trigger with source "${String((t as { source?: unknown }).source)}". Only 'emitter' (\`@OnEvent\`) is supported; to start a workflow from a diagnostics event, write a diagnostics listener that dispatches it (\`dispatch(event.payload, { runId: \`evt:\${event.id}\` })\`), or use \`transports.durable()\`.`,
      );
    }
    return { ...t, workflow: meta.name };
  });
}

/** Stamp `static on` (prepend, mirroring {@link Scheduled}). */
function stampOn(target: unknown, config: WorkflowEventTrigger | WorkflowEventTrigger[]): void {
  const cls = target as { on?: WorkflowEventTrigger | WorkflowEventTrigger[] };
  const existing = cls.on === undefined ? [] : Array.isArray(cls.on) ? cls.on : [cls.on];
  const added = Array.isArray(config) ? config : [config];
  cls.on = [...added, ...existing];
}

/**
 * Listen to an exact event on the **AdonisJS emitter** and start this workflow with the
 * event payload. Named params:
 *
 * ```ts
 * @OnEvent({ event: 'order:placed' })
 * ```
 */
export function OnEvent(config: EmitterTriggerConfig): ClassDecorator {
  // The declaring module is the caller of this factory: the class's origin (see `./origin.ts`).
  const declaredIn = callerFile(OnEvent);
  return (target) => {
    rememberDeclaringFile(target, declaredIn);
    stampOn(target, { source: 'emitter', ...config });
  };
}

/** Workflow-class shape used by the bridge to start a run on a matching event. */
export type EventTriggeredWorkflow = WorkflowClass;

/** Debounce for {@link OnWorkflowCompleted} / {@link OnWorkflowFailed}: see {@link OnWorkflowSettledOptions.debounce}. */
export interface SubscriberDebounce<TRunInput> {
  /** Start once no event arrived for this long (ms, or a duration like `'30s'`). */
  windowMs: number | string;
  /** Coalesce per key instead of per workflow; receives the subscriber's input. */
  key?: ((input: TRunInput) => string) | undefined;
}

/** Batch for {@link OnWorkflowCompleted} / {@link OnWorkflowFailed}: see {@link OnWorkflowSettledOptions.batch}. */
export interface SubscriberBatch<TRunInput> {
  /** Start once this many events arrived. */
  maxSize: number;
  /** Or once this long (ms, or a duration like `'1m'`) passed since the first event. */
  windowMs: number | string;
  /** Coalesce per key instead of per workflow; receives the subscriber's input. */
  key?: ((input: TRunInput) => string) | undefined;
}

/** Options for {@link OnWorkflowCompleted} / {@link OnWorkflowFailed}. */
export interface OnWorkflowSettledOptions<TEvent, TRunInput> {
  /** Start only for the settled runs this returns true for, e.g. by `input` or `searchAttributes`. */
  where?: ((event: TEvent) => boolean) | undefined;
  /**
   * The started run's input, built from the event. Without it the run receives the
   * {@link WorkflowLifecycleEvent} itself. Lets an existing workflow subscribe with its own input
   * shape, and keeps the settled run's whole input and output out of the new run's row.
   */
  input?: ((event: TEvent) => TRunInput) | undefined;
  /**
   * Start one run with the last input once events stopped arriving for `windowMs`, instead of one
   * run per settled run; with `key`, one per key. Sets the workflow's `eventBatch`, so it applies to
   * every event the workflow subscribes to.
   */
  debounce?: SubscriberDebounce<TRunInput> | undefined;
  /**
   * Start one run with `{ events }` (every input collected) once `maxSize` arrived or `windowMs`
   * passed since the first, instead of one run per settled run; with `key`, one per key. Sets the
   * workflow's `eventBatch`, like `debounce`; the two cannot be combined.
   */
  batch?: SubscriberBatch<TRunInput> | undefined;
}

/** Options for {@link OnWorkflowFailed}: also which endings start the subscriber. */
export interface OnWorkflowFailedOptions<TEvent, TRunInput>
  extends OnWorkflowSettledOptions<TEvent, TRunInput> {
  /** The endings that start it. Defaults to all three: `failed`, `cancelled` and `dead`. */
  statuses?: Array<'failed' | 'cancelled' | 'dead'> | undefined;
}

/** Options with `batch` set: the subscriber receives `{ events }` and cannot also debounce. */
type Batched<O, TRunInput> = O & { batch: SubscriberBatch<TRunInput>; debounce?: undefined };
/** Options without `batch`: the subscriber receives one input. */
type Unbatched<O> = O & { batch?: undefined };

/**
 * A class decorator that only accepts a workflow whose `run(ctx, input)` takes `TRunInput`, so a
 * subscriber with the wrong input shape fails to compile instead of failing at runtime.
 */
export type SubscriberDecorator<TRunInput> = <
  T extends abstract new (
    ...args: never[]
  ) => { run: (ctx: never, input: TRunInput) => unknown },
>(
  target: T,
) => void;

/**
 * Start a fresh run of the decorated workflow whenever a run of `workflow` **completes**. The new
 * run's input is the {@link WorkflowLifecycleEvent} (run id, input, output, tags, search
 * attributes), or what `input` builds from it. The settling workflow does not know about its
 * subscribers. Exactly once per settled run: see `runCompletedEvent`.
 *
 * It only adds an entry to the class's `static workflow.onEvent` (and sets `eventBatch` for
 * `debounce` / `batch`), so the class must declare `static workflow = { name }`. With a class ref,
 * the decorated workflow's `run` input is type-checked against the event (or against `input`'s
 * return type, or `{ events: [...] }` of it with `batch`). Child runs publish too, so a workflow
 * another one starts with `ctx.child` also starts its subscribers.
 *
 * ```ts
 * @OnWorkflowCompleted(IngestionWorkflow, {
 *   where: (e) => e.input.type === 'mvr',
 *   input: (e) => ({ baseId: e.input.baseId }),
 *   debounce: { windowMs: '30s', key: (input) => input.baseId },
 * })
 * export class RefreshSummariesWorkflow extends BaseWorkflow {
 *   static workflow = { name: 'refresh-summaries' }
 *   async run(ctx: WorkflowCtx, input: { baseId: string }) {}
 * }
 * ```
 */
export function OnWorkflowCompleted<C extends WorkflowClass, TRunInput = LifecycleEventOf<C>>(
  workflow: C,
  options: Batched<OnWorkflowSettledOptions<LifecycleEventOf<C>, TRunInput>, TRunInput>,
): SubscriberDecorator<{ events: TRunInput[] }>;
export function OnWorkflowCompleted<C extends WorkflowClass, TRunInput = LifecycleEventOf<C>>(
  workflow: C,
  options?: Unbatched<OnWorkflowSettledOptions<LifecycleEventOf<C>, TRunInput>>,
): SubscriberDecorator<TRunInput>;
export function OnWorkflowCompleted(
  workflow: string,
  options?: OnWorkflowSettledOptions<WorkflowLifecycleEvent, unknown>,
): ClassDecorator;
export function OnWorkflowCompleted(
  workflow: WorkflowRef,
  options?: OnWorkflowSettledOptions<WorkflowLifecycleEvent, unknown>,
): ClassDecorator {
  const declaredIn = callerFile(OnWorkflowCompleted);
  return onWorkflowSettled(runCompletedEvent(workflow), options?.where, options, declaredIn);
}

/**
 * Start a fresh run of the decorated workflow whenever a run of `workflow` ends **failed,
 * cancelled or dead** (narrow it with `statuses`). Same contract as {@link OnWorkflowCompleted};
 * the event carries `error` and `status` instead of `output`.
 */
export function OnWorkflowFailed<C extends WorkflowClass, TRunInput = LifecycleEventOf<C>>(
  workflow: C,
  options: Batched<OnWorkflowFailedOptions<LifecycleEventOf<C>, TRunInput>, TRunInput>,
): SubscriberDecorator<{ events: TRunInput[] }>;
export function OnWorkflowFailed<C extends WorkflowClass, TRunInput = LifecycleEventOf<C>>(
  workflow: C,
  options?: Unbatched<OnWorkflowFailedOptions<LifecycleEventOf<C>, TRunInput>>,
): SubscriberDecorator<TRunInput>;
export function OnWorkflowFailed(
  workflow: string,
  options?: OnWorkflowFailedOptions<WorkflowLifecycleEvent, unknown>,
): ClassDecorator;
export function OnWorkflowFailed(
  workflow: WorkflowRef,
  options?: OnWorkflowFailedOptions<WorkflowLifecycleEvent, unknown>,
): ClassDecorator {
  const declaredIn = callerFile(OnWorkflowFailed);
  const statuses = options?.statuses;
  const where = options?.where;
  const accepts =
    statuses || where
      ? (event: WorkflowLifecycleEvent) =>
          (!statuses || (statuses as string[]).includes(event.status)) && (!where || where(event))
      : undefined;
  return onWorkflowSettled(runFailedEvent(workflow), accepts, options, declaredIn);
}

/** The `eventBatch` a subscriber decorator's `debounce` / `batch` option sets, if any. */
function subscriberEventBatch(
  decorator: string,
  options: OnWorkflowSettledOptions<WorkflowLifecycleEvent, unknown> | undefined,
): EventBatchConfig | undefined {
  const { debounce, batch } = options ?? {};
  if (debounce && batch) {
    throw new Error(`${decorator}: pass debounce or batch, not both.`);
  }
  if (debounce) {
    return {
      mode: 'debounce',
      windowMs: parseDuration(debounce.windowMs),
      ...(debounce.key ? { key: debounce.key } : {}),
    };
  }
  if (batch) {
    return {
      mode: 'batch',
      maxSize: batch.maxSize,
      windowMs: parseDuration(batch.windowMs),
      ...(batch.key ? { key: batch.key } : {}),
    };
  }
  return undefined;
}

/**
 * Whether two `eventBatch` configs coalesce the same way: same mode, window and batch size, and
 * `key` functions with the same source text (two separately written but identical arrows match;
 * keys whose source differs do not, even when they compute the same key).
 */
function sameEventBatch(a: EventBatchConfig, b: EventBatchConfig): boolean {
  return (
    a.mode === b.mode &&
    a.windowMs === b.windowMs &&
    (a.mode === 'batch' ? a.maxSize : undefined) === (b.mode === 'batch' ? b.maxSize : undefined) &&
    a.key?.toString() === b.key?.toString()
  );
}

function onWorkflowSettled(
  event: string,
  where: ((event: WorkflowLifecycleEvent) => boolean) | undefined,
  options: OnWorkflowSettledOptions<WorkflowLifecycleEvent, unknown> | undefined,
  declaredIn: string | undefined,
): ClassDecorator {
  const decorator = event.startsWith('run.completed:')
    ? '@OnWorkflowCompleted'
    : '@OnWorkflowFailed';
  const eventBatch = subscriberEventBatch(decorator, options);
  const input = options?.input;
  const entry: OnEventEntry = {
    event,
    ...(where ? { where: where as (payload: unknown) => boolean } : {}),
    ...(input ? { input: input as (payload: unknown) => unknown } : {}),
  };
  return (target) => {
    const cls = target as unknown as { name: string; workflow?: WorkflowOptions };
    if (!cls.workflow || typeof cls.workflow.name !== 'string') {
      throw new Error(
        `@OnWorkflowCompleted / @OnWorkflowFailed on ${cls.name}: the class declares no \`static workflow = { name }\`.`,
      );
    }
    const declared = cls.workflow.eventBatch;
    if (eventBatch && declared && !sameEventBatch(declared, eventBatch)) {
      throw new Error(
        `${decorator} on ${cls.name}: its debounce/batch differs from the workflow's eventBatch. A workflow coalesces all its events one way; declare it once.`,
      );
    }
    rememberDeclaringFile(target, declaredIn);
    // A fresh config object, so a subclass never adds its subscription to its parent's.
    cls.workflow = {
      ...cls.workflow,
      onEvent: [entry, ...(cls.workflow.onEvent ?? [])],
      ...(eventBatch ? { eventBatch } : {}),
    };
  };
}
