import {
  applyCustomFilter,
  groupByCountFromRequest,
  InvalidColumnFilterError,
} from '@adonis-agora/filter';
import type {
  EngineEvent,
  GroupHealth,
  RunFacetQuery,
  RunQuery,
  RunResult,
  RunValueAxis,
  RunValueFacetOptions,
  RunValueFacetRow,
  SignalWaiter,
  StepCheckpoint,
  UpdateResult,
  WorkflowRun,
} from '../index.js';
import { RUN_VALUE_FACET_LIMIT } from '../run-value-facets.js';
import { indexWaitersByRun, resolveRunWaiting } from '../run-waiting.js';
import { RUN_STATUSES, RunFilter } from './run-filter.js';
import { RunQueryDraft } from './run-query-draft.js';
import { runValueAdapter } from './run-values.js';

/**
 * Framework-light JSON handlers over a {@link DashboardEngine}.
 *
 * Each handler takes a {@link Deps} bundle (just the read/control port — runs
 * and checkpoints are read through its own read API, {@link
 * DashboardEngine.listRuns} / {@link DashboardEngine.listCheckpoints}, so the
 * dashboard never reaches for a private store) plus a plain {@link
 * ApiRequest} (a thin view of the parts of an HTTP request it needs), and
 * returns a plain {@link ApiResponse} (status + JSON body). No AdonisJS types
 * leak in, so the handlers are unit-testable against a real in-memory engine
 * with no HTTP server. The provider adapts an AdonisJS `HttpContext` to these
 * shapes.
 *
 * `listRuns`/`getRun`/`retryRun`/`redispatchPendingRun`/`cancelRun`/`health` are the original
 * handlers this file always had (response shapes unchanged, so a hand-written client over the
 * JSON API keeps working — see `compat.ts`/`compat-view.ts`).
 * `workers`, `topology`, `retryWithInputRun`, `continueRun`, `runValues`, and `bulkAction` are
 * additions that give the new `@adonis-agora/durable-dashboard` React SPA parity with
 * `@dudousxd/nestjs-durable-dashboard`'s `DurableApiController` (fix-and-replay, bulk retry/cancel,
 * breakpoint continue, full worker heartbeats, topology badge, value pickers). The SSE `runs/:id/stream` route is wired directly in
 * `providers/dashboard_provider.ts` since streaming needs the raw HTTP response, not a JSON `ApiResponse`.
 */

/**
 * The bounded read/control surface the JSON handlers drive — declared STRUCTURALLY (a port), not by
 * importing the concrete `WorkflowEngine` class, so the same handlers serve BOTH durable topologies
 * (design §8): a store role passes an adapter over the real {@link
 * import('../engine.js').WorkflowEngine} (`storeDashboardEngine`); a store-less `tenant` pod passes an
 * adapter over its {@link import('../run-gateway/interface.js').RunGateway} (`gatewayDashboardEngine`).
 * Store presence is therefore invisible to the handlers. Mirrors the `RunGatewayEngine` port pattern
 * already used by `StoreRunGateway`.
 */
export interface DashboardEngine {
  getRun(runId: string): Promise<WorkflowRun | null>;
  listRuns(query: RunQuery): Promise<WorkflowRun[]>;
  listCheckpoints(runId: string): Promise<StepCheckpoint[]>;
  getRunChildren(runId: string): Promise<string[]>;
  requeue(runId: string): Promise<RunResult | null>;
  redispatchPending(runId: string): Promise<RunResult | null>;
  cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null>;
  workerHealth(extra?: string[]): Promise<GroupHealth[]>;
  /** Fix-and-replay: start a fresh linked run from `runId`'s workflow with a corrected `input`. Returns
   *  the new run's id, or `null` if `runId` is unknown. Degrades to `null` on a topology that can't
   *  perform it yet (a store-less `tenant` pod — see `gateway-adapter.ts`). */
  retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null>;
  /** Resume a run paused at a `ctx.breakpoint()`. Returns `null` if the run isn't paused at one, or on
   *  a topology that can't perform it yet (see `retryWithInput`). */
  continue(runId: string): Promise<RunResult | null>;
  /**
   * Deliver an external signal payload on `token` (the `ctx.waitForSignal` rendezvous) — the console
   * side of human-in-the-loop: the runs list already NAMES the token a suspended run is parked on;
   * this lets the operator act on it. Optional: absent on a topology without the engine's signal
   * surface yet (a store-less `tenant` pod), where the handler degrades to 404.
   */
  signal?(token: string, payload: unknown): Promise<RunResult | null>;
  /** Deliver a validated update to a run's `ctx.onUpdate(name)` point (the workflow's registered
   *  validator gates it server-side). Optional — see {@link signal}. */
  update?(runId: string, name: string, arg: unknown): Promise<UpdateResult>;
  /** Complete / fail a `ctx.task` the run dispatched to an external system. Optional — see {@link signal}. */
  completeTask?(runId: string, name: string, result: unknown): Promise<RunResult | null>;
  failTask?(runId: string, name: string, error: string): Promise<RunResult | null>;
  /** Live lifecycle events for ONE run; returns an unsubscribe fn. */
  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void;
  /**
   * Bulk-list current signal waiters by token prefix (`''` for every waiter) — powers `listRuns`'
   * `waiting` stamp (see `run-waiting.ts`'s `resolveRunWaiting`), naming what a `suspended` run is
   * parked on (signal/webhook/child/breakpoint) without a per-row timeline fetch. Optional: absent on
   * a topology that can't do the bulk scan yet (a store-less `tenant` pod — see `gateway-adapter.ts`,
   * mirrors `retryWithInput`/`continue`'s degrade-to-unavailable convention); `listRuns` simply skips
   * the `waiting` stamp when this is undefined, same as `@dudousxd/nestjs-durable-dashboard` skips it
   * for a gateway that can't do the scan.
   */
  listSignalWaiters?(prefix: string): Promise<SignalWaiter[]>;
  /**
   * Targeted variant: only the waiters registered by these runs (`run_id IN (...)`, indexed) — what
   * `listRuns` actually needs for one page. Optional; when absent the handlers fall back to the
   * full `listSignalWaiters('')` scan above.
   */
  listSignalWaitersByRunIds?(runIds: string[]): Promise<SignalWaiter[]>;
  /**
   * The distinct values of ONE filter axis over the runs matching `query`, with counts — what a
   * console's pickers list. Optional: absent on a port that can't do the scan yet (a store-less
   * `tenant` pod — see `gateway-adapter.ts`); {@link runValues} then counts a bounded
   * {@link listRuns} scan in-process instead, same answer shape, bounded approximation.
   */
  runValueFacets?(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]>;
}

/** The read/control port the handlers operate over (a store engine or a tenant gateway adapter). */
export interface Deps {
  engine: DashboardEngine;
}

/** The subset of an HTTP request the handlers read. */
export interface ApiRequest {
  /** Route params, e.g. `{ id: 'run-1' }`. */
  params: Record<string, string | undefined>;
  /** Decoded query string — nested when the client sends the filter envelope
   *  (`filter[where][0][field]`), flat for the legacy spelling. */
  query: Record<string, unknown>;
  /** Parsed JSON body (for POST actions). */
  body?: unknown;
}

/** A plain JSON response: an HTTP status and a serializable body. */
export interface ApiResponse {
  status: number;
  body: unknown;
}

/** A `200 OK` JSON response. Exported so sibling handlers (e.g. `compat`) share one convention. */
export const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const notFound = (message: string): ApiResponse => ({
  status: 404,
  body: { error: message },
});
const badRequest = (message: string): ApiResponse => ({
  status: 400,
  body: { error: message },
});

/** Rejecting an unreadable `compensate` beats guessing: the two guesses are "skip an undo the
 *  operator asked for" and "run an undo they did not", and both are silent. */
const INVALID_COMPENSATE =
  "compensate must be a boolean — 'true'/'1'/'yes'/'on' or 'false'/'0'/'no'/'off'";

function firstQuery(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

/** Parse a positive integer query param, falling back to `fallback` when absent/invalid. */
function intQuery(value: unknown, fallback: number): number {
  const raw = firstQuery(value);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Spellings accepted as `true` for a boolean flag. An empty value counts (a bare `?flag` is the
 *  usual "presence means on" convention). */
const TRUE_FLAGS = new Set(['', 'true', '1', 'yes', 'on']);
/** Spellings accepted as `false`. */
const FALSE_FLAGS = new Set(['false', '0', 'no', 'off']);

/**
 * Coerce one boolean flag, or `undefined` when it was not supplied at all. Deliberately an ALLOWLIST
 * rather than a truthiness test: `?compensate=false` and `?compensate=0` are how a client spells
 * "no", and a plain `Boolean(raw)` would read both as yes — silently running a saga undo nobody
 * asked for. An unrecognised spelling returns {@link INVALID_FLAG} so the caller can reject it
 * loudly instead of guessing.
 */
const INVALID_FLAG = Symbol('invalid-flag');
function parseFlag(raw: unknown): boolean | undefined | typeof INVALID_FLAG {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (TRUE_FLAGS.has(value)) return true;
    if (FALSE_FLAGS.has(value)) return false;
  }
  return INVALID_FLAG;
}

/**
 * Read a boolean action flag from EITHER the JSON body or the query string, defaulting to `false`.
 *
 * Both channels are read because both are in use: the bundled React console sends
 * `POST .../cancel?compensate=true` (no body at all), while the documented `{ compensate: true }`
 * body is what a hand-written client sends. Reading only one of them meant a
 * "Cancel + Undo" from the console performed a plain cancel and reported success — a silent wrong
 * answer, worse than an error. The body wins when it carries the key, so every existing body-based
 * caller keeps its exact behaviour and the query is purely additive.
 *
 * Returns {@link INVALID_FLAG} when a supplied value is not a recognised spelling, so the handler
 * can answer `400` rather than fall back to a default the caller did not choose.
 */
function readFlag(req: ApiRequest, key: string): boolean | typeof INVALID_FLAG {
  if (typeof req.body === 'object' && req.body !== null) {
    const fromBody = parseFlag((req.body as Record<string, unknown>)[key]);
    if (fromBody !== undefined) return fromBody;
  }
  const fromQuery = parseFlag(firstQuery(req.query[key]));
  return fromQuery ?? false;
}

/** Build a {@link RunQuery} from the query params shared by `listRuns`, `bulkAction` and the
 *  `runValues` scope — by running the console's {@link RunFilter} class over them (the filter
 *  lib's unified class form, with a draft in place of a Lucid builder).
 *
 *  Both spellings feed the same class: the flat form the console has always sent
 *  (`?status=failed&tag=etl`, repeatable for a set, `attr=key:op:value` repeats) and the structured
 *  `filter[...]` envelope `@adonis-agora/filter-client` builds. A refused filter
 *  (`InvalidColumnFilterError` — unknown field, unsupported operator, a group the draft cannot
 *  express) throws, and every caller maps it to `400` — a typo'd filter fails loudly instead of
 *  silently widening.
 *
 *  `limit`/`offset` never enter the draft (no method owns those endpoint mechanics — the caller
 *  reads them), and neither does `origin`: the engine has no `origin` column, so the class reads
 *  but ignores it and a client that always sends it never 400s. */
async function runFilterQuery(
  query: ApiRequest['query'],
): Promise<Omit<RunQuery, 'limit' | 'offset'>> {
  const draft = new RunQueryDraft();
  await applyCustomFilter(draft, RunFilter, { request: { qs: () => ({ ...query }) } });
  return draft.query;
}

/** Map a refused run filter to `400` (see {@link runFilterQuery}); rethrow anything else. */
function filterRejection(error: unknown): ApiResponse {
  if (error instanceof InvalidColumnFilterError) return badRequest(error.message);
  throw error;
}

/**
 * `GET /runs/values` — the distinct values one filter axis takes across the runs matching every
 * OTHER active predicate, with counts — what the console's pickers list instead of asking an
 * operator to type a value blind. Served through the filter lib's `groupByCountFromRequest` with
 * the console's adapter: the scope rides the same params as `listRuns`, and `field`/`limit`/
 * `offset`/`search` ride top-level (with the `groupByCount[field]` envelope as fallback).
 *
 * A picker pages as it scrolls and narrows as the operator types, both against the whole matching
 * set rather than the fetched page.
 */
export async function runValues(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const qs = req.query;
  const field = firstQuery(qs.field);
  const search = firstQuery(qs.search)?.trim();
  try {
    return ok(
      await groupByCountFromRequest(
        new RunQueryDraft(),
        RunFilter,
        { request: { qs: () => ({ ...qs }) } },
        {
          adapter: runValueAdapter(deps.engine),
          ...(field !== undefined && { field }),
          ...(qs.limit !== undefined && { limit: intQuery(qs.limit, RUN_VALUE_FACET_LIMIT) }),
          ...(qs.offset !== undefined && { offset: intQuery(qs.offset, 0) }),
          ...(search ? { search } : {}),
        },
      ),
    );
  } catch (error) {
    return filterRejection(error);
  }
}

/** `GET /runs` — list runs filtered by status/workflow/tag/namespace/search-attributes, paginated. */
export async function listRuns(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const { engine } = deps;
  const limit = Math.min(intQuery(req.query.limit, 50), 200);
  const offset = intQuery(req.query.offset, 0);

  let filter: Omit<RunQuery, 'limit' | 'offset'>;
  try {
    filter = await runFilterQuery(req.query);
  } catch (error) {
    return filterRejection(error);
  }
  const query: RunQuery = { limit, offset, ...filter };

  const runs = await engine.listRuns(query);
  // Resolve what each suspended run on THIS page is parked on — signal / webhook / child /
  // breakpoint — with no per-run timeline fetch. Prefers the targeted per-page lookup (`run_id IN
  // (...)`, indexed) over the legacy full-table waiter scan; absent on a topology that can't do
  // either yet (see `DashboardEngine.listSignalWaiters`'s doc), where the `waiting` stamp is
  // simply skipped, same as `@dudousxd/nestjs-durable-dashboard`.
  const waiters = engine.listSignalWaitersByRunIds
    ? await engine.listSignalWaitersByRunIds(runs.map((r) => r.id))
    : await (engine.listSignalWaiters?.('') ?? Promise.resolve(undefined));
  const waiterByRun = waiters ? indexWaitersByRun(waiters) : undefined;
  return ok({
    runs: runs.map((run) => summarizeRun(run, waiterByRun)),
    page: { limit, offset, count: runs.length },
    statuses: RUN_STATUSES,
  });
}

/** `GET /runs/:id` — a run's detail: the run, its step timeline, and child run ids. */
export async function getRun(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const { engine } = deps;
  const id = req.params.id;
  if (!id) return notFound('run id is required');
  const run = await engine.getRun(id);
  if (!run) return notFound(`run ${id} not found`);
  const [timeline, children] = await Promise.all([
    engine.listCheckpoints(id),
    engine.getRunChildren(id),
  ]);
  return ok({
    run: detailRun(run),
    timeline: timeline.map(summarizeCheckpoint),
    children,
  });
}

/**
 * `POST /runs/:id/retry` — re-enqueue a failed/incomplete run for a worker to
 * resume (completed steps replay from their checkpoints). Returns the enqueued
 * state immediately; never blocks on execution.
 */
export async function retryRun(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const id = req.params.id;
  if (!id) return notFound('run id is required');
  const result = await deps.engine.requeue(id);
  if (!result) return notFound(`run ${id} not found`);
  return ok({ result });
}

/**
 * `POST /runs/:id/redispatch` — re-enqueue every remote step of a run stuck `pending`, for a run
 * whose dispatched step job was LOST (worker crashed with no result, or the transport dropped the
 * job). The idempotent step re-runs and its result resumes the run. Returns the run's current status
 * and the count re-dispatched; never blocks on execution.
 */
export async function redispatchPendingRun(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const id = req.params.id;
  if (!id) return notFound('run id is required');
  const result = await deps.engine.redispatchPending(id);
  if (!result) return notFound(`run ${id} not found`);
  return ok({ result });
}

/**
 * `POST /runs/:id/cancel` — cancel a run. Ask for the saga undo with either `{ compensate: true }`
 * in the body or `?compensate=true` on the query string; see {@link readFlag} for why both.
 */
export async function cancelRun(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const id = req.params.id;
  if (!id) return notFound('run id is required');
  const compensate = readFlag(req, 'compensate');
  if (compensate === INVALID_FLAG) return badRequest(INVALID_COMPENSATE);
  const result = await deps.engine.cancel(id, compensate ? { compensate: true } : undefined);
  if (!result) return notFound(`run ${id} not found`);
  return ok({ result });
}

/**
 * `POST /runs/:id/retry-with-input` — fix-and-replay: start a fresh linked run of `runId`'s workflow
 * with a corrected `input`. Body: `{ input: unknown }`. Returns the new run's id; the ORIGINAL run is
 * left untouched (mirrors `@dudousxd/nestjs-durable-dashboard`'s `retryWithInput`).
 */
export async function retryWithInputRun(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const id = req.params.id;
  if (!id) return notFound('run id is required');
  const body = (req.body ?? {}) as { input?: unknown };
  const result = await deps.engine.retryWithInput(id, body.input);
  if (!result) return notFound(`run ${id} not found`);
  return ok({ result });
}

/**
 * `POST /runs/:id/continue` — resume a run paused at a {@link import('../interfaces.js').WorkflowCtx}
 * breakpoint (the dashboard's "continue" button). `404` if the run isn't paused at one.
 */
export async function continueRun(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const id = req.params.id;
  if (!id) return notFound('run id is required');
  const result = await deps.engine.continue(id);
  if (!result) return notFound(`run ${id} is not paused at a breakpoint`);
  return ok({ result });
}

/**
 * `POST /runs/:id/signal` — deliver `{ token, payload? }` to a run's `ctx.waitForSignal` rendezvous.
 * Guarded: unless `force: true`, the token must be one the run is CURRENTLY waiting on (the same
 * waiter rows the list's `waiting` column reads) — a typo'd token would otherwise buffer a stray
 * payload silently instead of resuming anything. The 409 carries the tokens the run IS waiting on,
 * so the console can offer them.
 */
export async function signalRun(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const { engine } = deps;
  const id = req.params.id;
  if (!id) return notFound('run id is required');
  if (!engine.signal) return notFound('signals are not available on this topology yet');
  const body = (req.body ?? {}) as { token?: unknown; payload?: unknown; force?: unknown };
  const token = typeof body.token === 'string' && body.token.length > 0 ? body.token : undefined;
  if (!token) return badRequest('token is required');
  const run = await engine.getRun(id);
  if (!run) return notFound(`run ${id} not found`);
  if (body.force !== true) {
    const waiters = engine.listSignalWaitersByRunIds
      ? await engine.listSignalWaitersByRunIds([id])
      : await engine.listSignalWaiters?.('');
    if (waiters) {
      const waitingOn = waiters.filter((w) => w.runId === id).map((w) => w.token);
      if (!waitingOn.includes(token)) {
        return {
          status: 409,
          body: {
            error: `run ${id} is not waiting on "${token}" (pass force: true to buffer it anyway)`,
            waitingOn,
          },
        };
      }
    }
  }
  const result = await engine.signal(token, body.payload);
  return ok({ result });
}

/**
 * `POST /runs/:id/update/:name` — deliver `{ arg? }` to a run's `ctx.onUpdate(name)` point. The
 * workflow's registered validator arbitrates server-side: a rejection comes back 422 with the
 * reason, and nothing is delivered.
 */
export async function updateRun(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const { engine } = deps;
  const id = req.params.id;
  const name = req.params.name;
  if (!id) return notFound('run id is required');
  if (!name) return notFound('update name is required');
  if (!engine.update) return notFound('updates are not available on this topology yet');
  const body = (req.body ?? {}) as { arg?: unknown };
  const result = await engine.update(id, name, body.arg);
  if (!result.accepted) {
    return { status: 422, body: { error: result.reason ?? 'update rejected', result } };
  }
  return ok({ result });
}

/** `POST /runs/:id/tasks/:name/complete` — complete a `ctx.task` from the console with `{ result? }`. */
export async function completeTaskRun(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const { engine } = deps;
  const id = req.params.id;
  const name = req.params.name;
  if (!id) return notFound('run id is required');
  if (!name) return notFound('task name is required');
  if (!engine.completeTask) return notFound('tasks are not available on this topology yet');
  const body = (req.body ?? {}) as { result?: unknown };
  const result = await engine.completeTask(id, name, body.result);
  // A null result means no waiter was live YET — the completion was BUFFERED (reliable delivery:
  // the run consumes it when it reaches the task's wait). Report that instead of pretending a 404.
  return ok({ result, delivered: result != null });
}

/** `POST /runs/:id/tasks/:name/fail` — fail a `ctx.task` from the console with `{ error }`. */
export async function failTaskRun(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const { engine } = deps;
  const id = req.params.id;
  const name = req.params.name;
  if (!id) return notFound('run id is required');
  if (!name) return notFound('task name is required');
  if (!engine.failTask) return notFound('tasks are not available on this topology yet');
  const body = (req.body ?? {}) as { error?: unknown };
  const error =
    typeof body.error === 'string' && body.error.length > 0 ? body.error : 'failed from console';
  const result = await engine.failTask(id, name, error);
  // Null = buffered (no live waiter yet) — same reliable-delivery semantics as completeTaskRun.
  return ok({ result, delivered: result != null });
}

/**
 * `POST /bulk/:action` (`action` = `retry`|`cancel`) — apply an action to every run matching the same
 * filter `listRuns` accepts (status/workflow/tag/namespace/attr), capped at 500 matches. Skips (does
 * not abort on) a run that can't take the action (e.g. already terminal). Mirrors
 * `@dudousxd/nestjs-durable-dashboard`'s `DashboardService.bulk`.
 */
export async function bulkAction(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const action = req.params.action;
  if (action !== 'retry' && action !== 'cancel') {
    return badRequest("action must be 'retry' or 'cancel'");
  }
  const compensate = readFlag(req, 'compensate');
  if (compensate === INVALID_FLAG) return badRequest(INVALID_COMPENSATE);
  let filter: Omit<RunQuery, 'limit' | 'offset'>;
  try {
    filter = await runFilterQuery(req.query);
  } catch (error) {
    return filterRejection(error);
  }
  const runs = await deps.engine.listRuns({ ...filter, limit: 500 });
  let applied = 0;
  for (const run of runs) {
    try {
      if (action === 'retry') {
        const result = await deps.engine.requeue(run.id);
        if (result) applied += 1;
      } else {
        const result = await deps.engine.cancel(
          run.id,
          compensate ? { compensate: true } : undefined,
        );
        if (result) applied += 1;
      }
    } catch {
      // Skip a run that can't take the action (e.g. already terminal) — matched still counts it.
    }
  }
  return ok({ matched: runs.length, applied });
}

/** `GET /health` — per-group worker health (queue backlog + live worker heartbeats), reduced to a
 *  compact shape. Kept as a public endpoint for hand-written clients; the console uses `/workers`. */
export async function health(deps: Deps): Promise<ApiResponse> {
  const groups: GroupHealth[] = await deps.engine.workerHealth();
  return ok({
    groups: groups.map((g) => ({
      group: g.group,
      depth: g.depth,
      liveWorkers: g.liveWorkers.length,
      // The actionable alert state: work piling up with no consumer.
      stalled: g.depth > 0 && g.liveWorkers.length === 0,
    })),
  });
}

/** `GET /workers` — full per-group worker health (every live worker's heartbeat, not just a count),
 *  for the new SPA's Workers panel (`pivot-by-worker.ts`/`group-by-partition.ts` need per-instance
 *  `instanceId`/`lastBeatAt`). Raw `GroupHealth[]`, unwrapped — matches
 *  `@dudousxd/nestjs-durable-dashboard`'s `GET /workers` shape byte for byte (minus the `status`
 *  telemetry field, which the AdonisJS engine's heartbeat doesn't carry — see `durable-client.ts`). */
export async function workers(deps: Deps): Promise<ApiResponse> {
  const groups = await deps.engine.workerHealth();
  return ok(groups);
}

/** `GET /topology` — this deployment's durable role, for the header badge. Pure/local (no engine
 *  round-trip): the role is already known by `dashboard_provider.ts` from `config/durable.ts`. */
export function topology(
  role: 'standalone' | 'control-plane' | 'tenant',
  tenant?: string,
): ApiResponse {
  return ok(tenant !== undefined ? { role, tenant } : { role });
}

/** Compact run shape for the list view. `waiterByRun`, when given, stamps `waiting` on a `suspended`
 *  run parked on a signal/webhook/child/breakpoint (see `listRuns`' bulk waiter scan). */
function summarizeRun(run: WorkflowRun, waiterByRun?: ReadonlyMap<string, SignalWaiter>) {
  const waiting = waiterByRun ? resolveRunWaiting(run, waiterByRun) : undefined;
  return {
    id: run.id,
    workflow: run.workflow,
    workflowVersion: run.workflowVersion,
    status: run.status,
    namespace: run.namespace,
    origin: run.origin,
    tags: run.tags ?? [],
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    // Liveness signal #1 of 2 (see `src/commands/runs.ts`'s module doc): `suspended` alone can't tell
    // a run mid-step apart from one stuck on a lost dispatch. `updatedAt` (above) already lets a
    // client derive age; `recoveryAttempts` is the other cheap tell — it's already on the run row, so
    // exposing it here is free. The other signal, the oldest pending REMOTE checkpoint's age, is
    // deliberately NOT added to this list endpoint: it would need one `listCheckpoints` call per row
    // (an N+1 the list view doesn't currently pay), whereas `GET /runs/:id` already returns the full
    // checkpoint `timeline` a client can scan for it.
    recoveryAttempts: run.recoveryAttempts ?? 0,
    ...(waiting ? { waiting } : {}),
  };
}

/** Fuller run shape for the detail view. */
function detailRun(run: WorkflowRun) {
  return {
    // recoveryAttempts already comes through from summarizeRun.
    ...summarizeRun(run),
    input: run.input,
    output: run.output,
    error: run.error,
    searchAttributes: run.searchAttributes,
    wakeAt: run.wakeAt,
  };
}

/** Compact checkpoint shape for the timeline. */
function summarizeCheckpoint(cp: StepCheckpoint) {
  const durationMs = cp.finishedAt.getTime() - cp.startedAt.getTime();
  const queueMs = cp.startedAt.getTime() - cp.enqueuedAt.getTime();
  return {
    seq: cp.seq,
    name: cp.name,
    kind: cp.kind,
    status: cp.status,
    attempts: cp.attempts,
    workerGroup: cp.workerGroup,
    input: cp.input,
    output: cp.output,
    error: cp.error,
    events: cp.events ?? [],
    // Set only on parallel-fan siblings (`ctx.all`/`ctx.gather`) — the new SPA's `group-parallel-spans`
    // helper needs this to collapse a fan-out into one timeline row.
    parallelGroup: cp.parallelGroup,
    enqueuedAt: cp.enqueuedAt.toISOString(),
    startedAt: cp.startedAt.toISOString(),
    finishedAt: cp.finishedAt.toISOString(),
    durationMs: durationMs >= 0 ? durationMs : 0,
    queueMs: queueMs >= 0 ? queueMs : 0,
  };
}
