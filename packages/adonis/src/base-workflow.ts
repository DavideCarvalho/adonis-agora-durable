import type { StartOptions } from './engine.js';
import { WorkflowEngine } from './engine.js';
import type { WorkflowCtx } from './interfaces.js';
import type { WorkflowScheduleConfig } from './scheduler.js';
import { getCurrentWorkflowCtx } from './workflow-als.js';
import type {
  WorkflowClass,
  WorkflowInputOf,
  WorkflowOptions,
  WorkflowOutputOf,
} from './workflow-ref.js';

/**
 * Options for `BaseWorkflow`'s static `start`/`dispatch`. A superset of {@link StartOptions} (priority,
 * namespace, tags, searchAttributes) plus an explicit `runId`:
 * - **Outside** a running workflow, `runId` sets the new run's id; omitted → a fresh `randomUUID()`.
 * - **Inside** a running workflow, `runId` is the deterministic child id; omitted → the ctx derives a
 *   replay-stable id from the call position (DO NOT pass a random one — it breaks determinism).
 */
export type WorkflowDispatchOptions = { runId?: string | undefined } & StartOptions;

/**
 * How `BaseWorkflow`'s OUTSIDE static path locates the {@link WorkflowEngine}. Defaults to resolving
 * the engine from the AdonisJS container (a module-singleton locator, exactly how a queue `Job`
 * resolves its manager). Tests (or advanced embeddings) override it with {@link setWorkflowEngineResolver}
 * to inject a specific engine without booting an application.
 */
export type WorkflowEngineResolver = () => WorkflowEngine | Promise<WorkflowEngine>;

let engineResolver: WorkflowEngineResolver | undefined;

/**
 * Override how `BaseWorkflow.start`/`dispatch` resolve the engine when called OUTSIDE a running
 * workflow. Pass a resolver returning the engine to use; pass `undefined` to restore the default
 * (container lookup). Primarily a testing seam — inject an in-memory engine, then reset in teardown.
 */
export function setWorkflowEngineResolver(resolver: WorkflowEngineResolver | undefined): void {
  engineResolver = resolver;
}

/** Resolve the engine for the OUTSIDE path: the injected resolver if set, else the app container. */
async function resolveEngine(): Promise<WorkflowEngine> {
  if (engineResolver) return engineResolver();
  // Lazy import so the module-singleton `app` locator is only touched on the outside path, and so
  // importing `BaseWorkflow` never eagerly pulls in `@adonisjs/core` (mirrors queue `Job.dispatch`).
  const app = (await import('@adonisjs/core/services/app')).default;
  return app.container.make(WorkflowEngine);
}

/**
 * Base class for a durable workflow. Declare the workflow's identity as a
 * `static workflow = { name, version }` config and implement `run(ctx, input)`:
 *
 * ```ts
 * export default class CheckoutWorkflow extends BaseWorkflow {
 *   static workflow = { name: 'checkout', version: '1' }
 *   async run(ctx: WorkflowCtx, order: Order) { … }
 * }
 * ```
 *
 * The static `workflow` config is resolved through `workflowName()` and registered via
 * `app/workflows` auto-discovery.
 *
 * ## Context-aware dispatch
 * The statics behave differently depending on whether they're called inside or outside a running
 * workflow body (detected via the ambient ctx — see {@link getCurrentWorkflowCtx}):
 *
 * |            | OUTSIDE (controller/service/script)                      | INSIDE a running workflow body        |
 * |------------|----------------------------------------------------------|---------------------------------------|
 * | `.start`   | `engine.start` + `waitForRun` → blocks, returns result   | `ctx.child` → linked child, awaits it |
 * | `.dispatch`| `engine.start` → fire-and-forget, returns `{ runId }`    | `ctx.startChild` → fire-and-forget    |
 *
 * `.start` always means "I want the result"; `.dispatch` always means "fire and forget" — in both
 * contexts. Inside a workflow, routing through `ctx.child`/`ctx.startChild` (never the engine) is what
 * keeps the run deterministic and replay-safe.
 */
export abstract class BaseWorkflow {
  /**
   * The workflow's identity + options. Read by `workflowMeta()`/`workflowName()` and by
   * `app/workflows` auto-discovery. Omit it and the class is not a registrable workflow.
   */
  static workflow?: WorkflowOptions;

  /**
   * Recurring schedule(s) for this workflow, colocated on the class (an alternative to listing them in
   * `config/durable.ts` → `schedules`). Discovered by `app/workflows` auto-discovery and merged with
   * the config schedules — the `durable:work` worker tick fires both identically. A single object
   * declares one schedule; an array declares several. `key` defaults to the workflow name (or
   * `${name}:${i}` for an array) and must stay stable — it is part of the deterministic run id. On a
   * key collision, an explicit `config.schedules` entry wins. Cron schedules need the optional
   * `cron-parser` peer dependency. See {@link WorkflowScheduleConfig}.
   */
  static schedule?: WorkflowScheduleConfig | WorkflowScheduleConfig[];

  /** The workflow body. `ctx` is the durable context; `input` is the run's typed input. */
  abstract run(ctx: WorkflowCtx, input: unknown): unknown;

  /**
   * Start a run and **wait for its result**. Outside a workflow, enqueues via the engine and blocks
   * until the run settles, returning its output. Inside a running workflow, starts a **linked child**
   * (`ctx.child`) — the parent suspends until the child settles — and returns the child's output.
   */
  static start<C extends WorkflowClass>(
    this: C,
    input: WorkflowInputOf<C>,
    opts?: WorkflowDispatchOptions,
  ): Promise<WorkflowOutputOf<C>> {
    const ctx = getCurrentWorkflowCtx();
    if (ctx) {
      // INSIDE: linked child. Pass opts?.runId as the childId; when absent, ctx.child derives a
      // deterministic, replay-stable id from call position — never generate one here.
      // biome-ignore lint/complexity/noThisInStatic: `this` is the polymorphic subclass, declared as `this: C` above — it is the dispatch mechanism. Naming the class here would always start BaseWorkflow instead of the caller's workflow.
      return ctx.child(this, input, opts?.runId) as Promise<WorkflowOutputOf<C>>;
    }
    // OUTSIDE: enqueue on the engine, then block until the run reaches a TERMINAL state. `runId` is a
    // BaseWorkflow-only option (not part of StartOptions) — strip it before forwarding to engine.start.
    return (async () => {
      const engine = await resolveEngine();
      const { runId: _runId, ...startOpts } = opts ?? {};
      const runId = opts?.runId ?? globalThis.crypto.randomUUID();
      // biome-ignore lint/complexity/noThisInStatic: see .start's child branch — `this` is the polymorphic subclass (`this: C`), not BaseWorkflow.
      await engine.start(this, input, runId, startOpts);
      // `terminal: true` so a workflow that suspends (sleep/waitForSignal/waitForEvent/async step)
      // keeps blocking through the suspension and returns the real output — the ".start = I want the
      // result" contract, matching the INSIDE ctx.child path (which also waits for terminal).
      const result = await engine.waitForRun(runId, { terminal: true });
      return result.output as WorkflowOutputOf<C>;
    })();
  }

  /**
   * Start a run **fire-and-forget** and return its `{ runId }` without waiting. Outside a workflow,
   * enqueues via the engine and returns immediately. Inside a running workflow, kicks off a
   * fire-and-forget child (`ctx.startChild`) — the parent keeps running — and returns the child id.
   */
  static dispatch<C extends WorkflowClass>(
    this: C,
    input: WorkflowInputOf<C>,
    opts?: WorkflowDispatchOptions,
  ): Promise<{ runId: string }> {
    const ctx = getCurrentWorkflowCtx();
    if (ctx) {
      // INSIDE: fire-and-forget child. Same childId rule as .start — let ctx derive it when absent.
      // biome-ignore lint/complexity/noThisInStatic: see .start — `this` is the polymorphic subclass (`this: C`), not BaseWorkflow.
      return ctx.startChild(this, input, opts?.runId).then((runId) => ({ runId }));
    }
    // OUTSIDE: enqueue and return the id without blocking on the settle. `runId` is a BaseWorkflow-only
    // option (not part of StartOptions) — strip it before forwarding to engine.start.
    return (async () => {
      const engine = await resolveEngine();
      const { runId: _runId, ...startOpts } = opts ?? {};
      const runId = opts?.runId ?? globalThis.crypto.randomUUID();
      // biome-ignore lint/complexity/noThisInStatic: see .start — `this` is the polymorphic subclass (`this: C`), not BaseWorkflow.
      await engine.start(this, input, runId, startOpts);
      return { runId };
    })();
  }
}
