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

/**
 * Handoff checkpoints live at seqs from here up, one per handoff, so a body that runs again after a
 * retry can never reach one. Fits a 32-bit `seq` column.
 */
export const HANDOFF_SEQ_BASE = 1_000_000_000;

/** The id of the handler run of a run's `attempt`-th handoff. */
export const onErrorRunId = (runId: string, attempt: number): string =>
  `${runId}.onError.${attempt}`;

/** The waiter checkpoint a run waits on its handler under; renamed {@link retiredHandoffName} on retry. */
export const handoffName = (handlerId: string): string => `signal:child:${handlerId}`;

/** What a retry renames a handoff checkpoint to: kept in the timeline, never followed again. */
export const retiredHandoffName = (handlerId: string): string => `onError:retried:${handlerId}`;

/** The handler run id a live handoff checkpoint of `runId` names, or undefined for any other one. */
export function handoffHandlerId(
  runId: string,
  cp: { seq: number; name: string },
): string | undefined {
  const prefix = `signal:child:${runId}.onError.`;
  return cp.seq >= HANDOFF_SEQ_BASE && cp.name.startsWith(prefix)
    ? cp.name.slice('signal:child:'.length)
    : undefined;
}

/** The run's live handoff (its latest, unretired one), if it handed a failure off. */
export function liveHandoff<C extends { seq: number; name: string }>(
  runId: string,
  checkpoints: readonly C[],
): C | undefined {
  let live: C | undefined;
  for (const cp of checkpoints) {
    if (handoffHandlerId(runId, cp) !== undefined && (!live || cp.seq > live.seq)) live = cp;
  }
  return live;
}

/**
 * Codes a `schema_validation` route also catches: `SchemaValidationError`'s `static code`, which
 * input and output schema failures carried before they got codes of their own, so a route written
 * for it keeps catching them.
 */
const SCHEMA_VALIDATION_CODES = new Set(['invalid_input', 'invalid_output']);

/**
 * The route a failure takes: the one for its exact code, else (for an `invalid_input` /
 * `invalid_output` failure) a `schema_validation` route, else the catch-all, else none.
 */
export function routeFor(
  routes: OnErrorRoute[] | undefined,
  error: StepError,
): OnErrorRoute | undefined {
  if (!routes?.length || (error.code && UNROUTABLE_CODES.has(error.code))) return undefined;
  const { code } = error;
  return (
    (code ? routes.find((r) => r.code === code) : undefined) ??
    (code && SCHEMA_VALIDATION_CODES.has(code)
      ? routes.find((r) => r.code === 'schema_validation')
      : undefined) ??
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

type Carrier = {
  code?: unknown;
  details?: unknown;
  stepError?: { code?: unknown; details?: unknown };
  error?: { code?: unknown; details?: unknown };
};

/** The `code` carried by a thrown value: its own, a dispatched step's, or a thin-worker step's. */
export function codeOf(err: unknown): string | undefined {
  const e = err as Carrier | null;
  return [e?.code, e?.stepError?.code, e?.error?.code].find(
    (c): c is string => typeof c === 'string',
  );
}

/** The `details` carried by a thrown value, from the same places as {@link codeOf}. */
export function detailsOf(err: unknown): unknown {
  const e = err as Carrier | null;
  return e?.details ?? e?.stepError?.details ?? e?.error?.details;
}

/** `code` and `details` as optional keys, so an absent one is not written as `undefined`. */
export function codeAndDetails(err: unknown): { code?: string; details?: unknown } {
  const code = codeOf(err);
  const details = detailsOf(err);
  return {
    ...(code !== undefined ? { code } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}
