/**
 * A **workflow reference** is how one workflow names another to call it: either a registered workflow
 * **name** (a string — the only option across runtimes, e.g. a Python workflow) or, for a same-runtime
 * TypeScript workflow, its **class**. The class carries the input/output types through the call, so
 * `ctx.child(ShippingWorkflow, input)` type-checks the input and returns a typed result — while a
 * string stays available for the cross-runtime case.
 */

import type { ConcurrencyConfig } from './concurrency.js';
import type { SingletonConfig } from './engine.js';
import type { SearchAttributesSchema } from './interfaces.js';
import { callerFile, declaredOriginOf, originOfCaller, rememberDeclaringFile } from './origin.js';
import type { ScheduledWorkflow, WorkflowScheduleConfig } from './scheduler.js';
import type { StandardSchemaV1 } from './standard-schema.js';

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
   * A start-time concurrency QUOTA (see {@link ConcurrencyConfig}): at most `limit` runs sharing a
   * key in flight, and a start over it is REJECTED (`ConcurrencyLimitError`, nothing created) rather
   * than queued — e.g. `concurrency: { key: (input) => `tenant:${input.tenantId}`, limit: 8 }`. The
   * key is shared across workflows; `limit` may be an (async) function of the key; `countStatuses`
   * narrows what occupies a slot. Use `singleton` when excess runs should wait their turn instead.
   */
  concurrency?: ConcurrencyConfig;
  /**
   * Package attribution stamped on every run of this workflow (see `WorkflowRun.origin`) — which
   * package's code produced it, e.g. `@adonis-agora/catalog-pipeline`. Powers the console's origin
   * facet. Usually OMITTED: the origin is derived from the nearest `package.json` `name` of the
   * class's declaring file (captured by `@Scheduled` / `@OnEvent` / `@OnDiagnostic`), else of the
   * discovered module (`app/workflows/…` → the app), else of the code calling
   * `registerWorkflowClass` (a lib → the lib). Set it only to override that — e.g. an app that
   * hand-registers a lib's undecorated class would otherwise be credited with it. A value here
   * always wins; a workflow nothing can attribute has no origin (shown as `app` in the console).
   */
  origin?: string;
  /**
   * Route failed runs to a handler workflow by error `code`, instead of failing them: when a run ends
   * `failed` with a matching code, the engine starts `workflow` with an `OnErrorInput`
   * (`{ runId, workflow, input, error }`), the run waits for it, and settles with its outcome. `code`
   * is a string or an error class with a `static code`; omit it for the catch-all. e.g.
   * `onError: [{ code: InvalidLine, workflow: LineDeadLetterWorkflow }]`.
   */
  onError?: { code?: string | { readonly code: string }; workflow: WorkflowRef }[];
  /**
   * Where a run of this workflow that goes `dead` (past `maxRecoveryAttempts`) is handed: the engine
   * starts this workflow with a `DeadLetter` input (`{ deadRunId, workflow, input, error }`) under
   * the run id `dlq:<deadRunId>`, in the dead run's namespace. Overrides the config-level
   * `deadLetterWorkflow`. A class can instead define a `deadLetter(ctx, dead)` method (registered as
   * `<name>.dlq`); declaring both is an error at boot.
   */
  deadLetterWorkflow?: WorkflowRef;
  /**
   * Validate the run input at start against any Standard Schema (zod, valibot, arktype, …). A bad
   * payload throws a `SchemaValidationError` from `start` and no run is created (an `onEvent`
   * trigger with a rejected payload simply doesn't start this workflow). The run stores the input
   * AS SENT; `run(ctx, input)` receives the schema's OUTPUT value (parsed / coerced / defaulted),
   * re-parsed from the stored input before every turn, so a replay sees what the first turn saw.
   * Keep the schema deterministic, and bump `version` when it changes.
   */
  inputSchema?: StandardSchemaV1;
  /**
   * The run's typed search-attributes shape (a {@link SearchAttributesSchema}): every
   * `ctx.upsertSearchAttributes` validates the merged attributes against it and rejects a
   * non-conforming write. Pair with `run(ctx: WorkflowCtx<InferSearchAttributes<typeof schema>>)`
   * for compile-time typing, and read them back typed with `attributesOf(WorkflowClass, run)`.
   */
  searchAttributes?: SearchAttributesSchema;
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
  // Captured in the FACTORY, which runs in the declaring module (the returned decorator may be
  // applied from a `__decorate` helper in another package): the class's origin (see `./origin.ts`).
  const declaredIn = callerFile(Scheduled);
  return (target) => {
    rememberDeclaringFile(target, declaredIn);
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

/** A class's `onError` routes, with class refs resolved to names and error classes to their codes. */
export function onErrorRoutesOf(meta: WorkflowOptions): { code?: string; workflow: string }[] {
  return (meta.onError ?? []).map(({ code, workflow }) => ({
    ...(code === undefined ? {} : { code: typeof code === 'string' ? code : code.code }),
    workflow: workflowName(workflow),
  }));
}

/**
 * What a worker announces about a workflow class it runs (design §7.9): its version, declaring package
 * and onError routes — pass it as `WorkerRuntime.registerWorkflow`'s `meta`. Undefined for a class
 * carrying no `static workflow` config.
 */
export function workflowAnnouncement(
  target: unknown,
):
  | { version: string; origin?: string; onError?: { code?: string; workflow: string }[] }
  | undefined {
  // Same precedence as registration: explicit `origin` > the class's decorator-captured declaring
  // file > the package calling this (a lib announcing its own workflow). Derived before anything
  // else so the captured frame is the caller's.
  const callerOrigin = originOfCaller(workflowAnnouncement);
  const meta = workflowMeta(target);
  if (!meta) return undefined;
  const origin = meta.origin || declaredOriginOf(target) || callerOrigin;
  return {
    version: meta.version,
    ...(origin ? { origin } : {}),
    ...(meta.onError?.length ? { onError: onErrorRoutesOf(meta) } : {}),
  };
}
