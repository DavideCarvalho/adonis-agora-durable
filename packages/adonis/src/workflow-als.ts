import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkflowCtx } from './interfaces.js';

/**
 * Ambient, per-run-turn {@link WorkflowCtx}. The engine wraps each body turn (`fn(ctx, input)`, and
 * every replay of it) in `workflowAls.run(ctx, …)`, so any code reachable from the body — including a
 * `BaseWorkflow` static like `Inner.start(...)` — can read the *current* run's ctx without threading
 * it through every call. Node's ALS is await-safe, so the ambient ctx propagates across the body's
 * `await` chain for the whole turn and is re-established on each replay (correct: a replay is a fresh
 * turn with its own ctx). The explicit `ctx` param stays the guaranteed accessor; this is the
 * convenience the context-aware statics read.
 */
export const workflowAls = new AsyncLocalStorage<WorkflowCtx>();

/**
 * The {@link WorkflowCtx} of the workflow run currently executing on this async call stack, or
 * `undefined` when called outside any run (a controller, service, script, or job). `BaseWorkflow`'s
 * static `start`/`dispatch` read this to route: a defined ctx means "inside a running workflow" (go
 * through `ctx.child`/`ctx.startChild` to stay deterministic); `undefined` means "outside" (go
 * through the engine). Must be read within the run's synchronous await flow — the normal case.
 */
export function getCurrentWorkflowCtx(): WorkflowCtx | undefined {
  return workflowAls.getStore();
}

/**
 * The ambient STEP scope: which workflow ctx's checkpointed step body (if any) is executing on this
 * async path. The engine installs it around every in-body step execution (`ctx.localStep`,
 * `ctx.transaction`, and everything built on them) so the ctx primitives can refuse to run from
 * inside a step body — see `NestedWorkflowCallError`. `owner` is the identity of the ctx whose step
 * is running, so a DIFFERENT run's body executed inline from a step (e.g. a step that signals a run
 * which resumes on this async path) is never mistaken for a nested call.
 */
export interface StepScope {
  readonly owner: object;
  readonly step: string;
}

export const stepScopeAls = new AsyncLocalStorage<StepScope>();

/** Run `fn` as the body of step `step` of the ctx identified by `owner`. Engine-internal. */
export function runInStepScope<T>(owner: object, step: string, fn: () => T): T {
  return stepScopeAls.run({ owner, step }, fn);
}

/** The step body currently executing on this async path, or `undefined` outside one. */
export function currentStepScope(): StepScope | undefined {
  return stepScopeAls.getStore();
}

/**
 * Run `fn` with NO ambient workflow ctx and no step scope — for a dispatched step handler. A handler
 * is not the workflow body (on a remote worker it never sees one), but an in-process transport
 * invokes it on the body's async path, where the parent's ctx would otherwise leak in and turn a
 * handler's `BaseWorkflow.dispatch()` into a journal-corrupting `ctx.startChild` of a parent that is
 * already suspended. Clearing it makes in-process and remote handlers behave identically.
 */
export function runOutsideWorkflowCtx<T>(fn: () => T): T {
  return workflowAls.exit(() => stepScopeAls.exit(fn));
}
