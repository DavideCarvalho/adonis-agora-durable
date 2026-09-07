/**
 * A **workflow reference** is how one workflow names another to call it: either a registered workflow
 * **name** (a string — the only option across runtimes, e.g. a Python workflow) or, for a same-runtime
 * TypeScript workflow, its **class**. The class carries the input/output types through the call, so
 * `ctx.child(ShippingWorkflow, input)` type-checks the input and returns a typed result — while a
 * string stays available for the cross-runtime case.
 */

import type { SingletonConfig } from './engine.js';
import type { ScheduledWorkflow, WorkflowScheduleConfig } from './scheduler.js';

/** Options for a workflow's `static workflow = { name, version, … }` config (see {@link BaseWorkflow}). */
export interface WorkflowOptions {
  /** The registered workflow name (the cross-runtime identity, e.g. `order`). */
  name: string;
  /** Workflow version. Defaults to `'1'`. Register a new version for a breaking change. */
  version?: string;
  /** Searchable labels merged onto every run of this workflow. */
  tags?: string[];
  /** Wall-clock budget for the whole run (a duration string like `'5m'`, or ms). */
  executionTimeout?: string | number;
  /** Event names that start a run of this workflow when published (see `onEvent`). */
  onEvent?: string[];
  /**
   * Per-key serialization for runs of this workflow (see {@link SingletonConfig}): `key` derives the
   * serialization key from the run input, `limit` (default 1) caps concurrent runs sharing it, and
   * excess runs gate (suspended) until a slot frees. Declared here so the `app/workflows` convention
   * carries it — before this, `SingletonConfig` was reachable only through a manual
   * `engine.register(name, version, fn, { singleton })`, which forced anyone needing a mutexed
   * scheduled workflow (a colocated `static schedule` fires a NEW run per window, active or not) to
   * bypass discovery entirely.
   */
  singleton?: SingletonConfig;
  /**
   * Package attribution stamped on every run of this workflow (see `WorkflowRun.origin`) — which
   * package's code produced it, e.g. `@adonis-agora/catalog-pipeline`. Powers the console's origin
   * facet; omit for an app-local workflow (renders as "unknown" until attributed).
   */
  origin?: string;
}

/** The metadata read off a workflow class's `static workflow` config for discovery + registration. */
export interface WorkflowMeta extends WorkflowOptions {
  version: string;
}

/**
 * Read a class's {@link WorkflowMeta} — its name/version/tags/… — from its `static workflow =
 * { name, version, … }` config (the {@link BaseWorkflow} authoring form). Any absent `version` is
 * normalized to `'1'`. Returns `undefined` for a class carrying no valid config (a class with no
 * `static workflow`, or one whose `name` is not a string, is not a registrable workflow).
 */
export function workflowMeta(target: unknown): WorkflowMeta | undefined {
  if (typeof target !== 'function') return undefined;
  const config = (target as { workflow?: WorkflowOptions }).workflow;
  if (config && typeof config === 'object' && typeof config.name === 'string') {
    return { ...config, version: config.version ?? '1' };
  }
  return undefined;
}

/**
 * Read a class's colocated schedule(s) from its `static schedule` config and normalize each into a
 * full {@link ScheduledWorkflow} (the same shape `config.schedules` uses), so the worker tick fires
 * class-declared and config-declared schedules identically. `workflow` is filled from the class's
 * `static workflow.name`; a missing `key` defaults to the workflow name (or `${name}:${i}` when the
 * class declares several).
 *
 * The default key is **derived from the class's workflow name, never random** — it becomes part of the
 * schedule's deterministic time-bucket run id, so two ticks (or two racing workers) resolve the same
 * key and thus start each window exactly once. Returns `[]` for a class carrying no `static workflow`
 * (not a registrable workflow) or no `static schedule`.
 */
export function workflowSchedules(target: unknown): ScheduledWorkflow[] {
  const meta = workflowMeta(target);
  if (!meta) return [];
  const raw = (target as { schedule?: WorkflowScheduleConfig | WorkflowScheduleConfig[] }).schedule;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((s, i) => ({
    ...s,
    workflow: meta.name,
    key: s.key ?? (arr.length > 1 ? `${meta.name}:${i}` : meta.name),
  }));
}

/**
 * Class-decorator form of the colocated schedule — the same declaration `static schedule = {...}`
 * makes, for codebases that prefer decorators:
 *
 * ```ts
 * @Scheduled({ cron: '0 4 * * *', timezone: 'America/Sao_Paulo' })
 * export default class CrawlWorkflow extends BaseWorkflow {
 *   static workflow = { name: 'crawl' }
 *   async run(ctx: WorkflowCtx) { … }
 * }
 * ```
 *
 * It only stamps `static schedule` on the class — normalization (key defaults, `workflow` fill-in)
 * stays in {@link workflowSchedules}, so both authoring forms behave identically, including the
 * requirement of a `static workflow` config (a decorated class without one is not registrable and
 * its schedules are ignored, same as a bare `static schedule`).
 *
 * Composes: repeated `@Scheduled(...)` applications and an existing `static schedule` accumulate.
 * Decorators apply bottom-up, so each application PREPENDS — the final array reads in **source
 * order** (top decorator first, then lower ones, then the `static schedule` literal). With several
 * schedules on one class, prefer explicit `key`s over the positional `${name}:${i}` defaults: the
 * key is part of the deterministic run id, and reordering declarations would silently re-key them.
 */
export function Scheduled(
  config: WorkflowScheduleConfig | WorkflowScheduleConfig[],
): ClassDecorator {
  return (target) => {
    const cls = target as unknown as {
      schedule?: WorkflowScheduleConfig | WorkflowScheduleConfig[];
    };
    const existing =
      cls.schedule === undefined ? [] : Array.isArray(cls.schedule) ? cls.schedule : [cls.schedule];
    const added = Array.isArray(config) ? config : [config];
    cls.schedule = [...added, ...existing];
  };
}

/** Structural shape of a workflow class — its `run(ctx, input)` carries the input/output types. */
export type WorkflowClass<TInput = unknown, TOutput = unknown> = abstract new (
  ...args: never[]
) => {
  run(ctx: never, input: TInput): Promise<TOutput> | TOutput;
};

/** A workflow reference: a registered name (cross-runtime) or a workflow class (typed, same-runtime). */
export type WorkflowRef<TInput = unknown, TOutput = unknown> =
  | string
  | WorkflowClass<TInput, TOutput>;

/** The input type a workflow class's `run` accepts. */
export type WorkflowInputOf<C> = C extends abstract new (
  ...args: never[]
) => {
  run(ctx: never, input: infer I): unknown;
}
  ? I
  : unknown;

/** The output type a workflow class's `run` resolves to (Promise unwrapped). */
export type WorkflowOutputOf<C> = C extends abstract new (
  ...args: never[]
) => {
  run(ctx: never, input: never): infer R;
}
  ? Awaited<R>
  : unknown;

/**
 * Resolve a {@link WorkflowRef} to its registered workflow name: a string is returned as-is; a
 * workflow class is resolved via the name on its `static workflow` config. Throws if a class carries
 * no `static workflow` config (so it has no registered name).
 */
export function workflowName(ref: WorkflowRef): string {
  if (typeof ref === 'string') return ref;
  const name = workflowMeta(ref)?.name;
  if (!name) {
    throw new Error(
      `workflow class ${ref.name} has no registered name — does it declare \`static workflow = { name }\`?`,
    );
  }
  return name;
}
