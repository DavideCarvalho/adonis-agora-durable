import type { StepError } from './interfaces.js';

/**
 * Routes a failed run to a handler workflow instead of failing it: when a run of the workflow ends
 * `failed` with an error whose `code` matches (or with any error, for the route without a `code`), the
 * engine starts `workflow` with an {@link OnErrorInput} and the failed run waits for it. The run then
 * settles with the handler's outcome: its output on success, its error on failure.
 */
export interface OnErrorRoute {
  /** The error `code` to route. Omitted: routes any failure no other route's `code` matches. */
  code?: string | undefined;
  /** The registered handler workflow's name. */
  workflow: string;
}

/** The input an {@link OnErrorRoute} handler workflow is started with. */
export interface OnErrorInput<TInput = unknown> {
  /** The run that failed; it completes with this handler's output. */
  runId: string;
  /** The failed run's workflow. */
  workflow: string;
  /** The failed run's input. */
  input: TInput;
  /** The failure, as the run recorded it. */
  error: StepError;
}

/**
 * Codes of failures that mean the code or the deployment is broken, not that the work failed: routing
 * them would turn a non-deterministic deploy or a misuse of the ctx into a completed run.
 */
const UNROUTABLE_CODES = new Set(['non_determinism', 'nested_workflow_call']);

/** The id of the handler run a failed run hands off to. */
export const onErrorRunId = (runId: string): string => `${runId}.onError`;

/** The route a failure takes: the one for its exact code, else the catch-all, else none. */
export function routeFor(
  routes: OnErrorRoute[] | undefined,
  error: StepError,
): OnErrorRoute | undefined {
  if (!routes?.length || (error.code && UNROUTABLE_CODES.has(error.code))) return undefined;
  return (
    (error.code ? routes.find((r) => r.code === error.code) : undefined) ??
    routes.find((r) => r.code === undefined)
  );
}

/** Reject two routes for one code, or two catch-alls — ambiguous config, caught at registration. */
export function assertRoutes(workflow: string, routes: OnErrorRoute[]): void {
  const seen = new Set<string | undefined>();
  for (const r of routes) {
    if (seen.has(r.code)) {
      throw new Error(
        r.code === undefined
          ? `workflow ${workflow}: more than one onError route without a code`
          : `workflow ${workflow}: more than one onError route for code "${r.code}"`,
      );
    }
    seen.add(r.code);
  }
}

/** The `code` carried by a thrown value: its own, a dispatched step's, or a thin-worker step's. */
export function codeOf(err: unknown): string | undefined {
  const e = err as { code?: unknown; stepError?: { code?: unknown }; error?: { code?: unknown } };
  return [e?.code, e?.stepError?.code, e?.error?.code].find(
    (c): c is string => typeof c === 'string',
  );
}
