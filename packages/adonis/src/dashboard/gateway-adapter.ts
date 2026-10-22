import type { ScheduleInfo } from '../engine.js';
import type {
  EngineEvent,
  RunFacetQuery,
  RunQuery,
  RunResult,
  RunValueAxis,
  RunValueFacetOptions,
  RunValueFacetRow,
  SignalWaiter,
  UpdateResult,
} from '../interfaces.js';
import { DURABLE_RUN_GATEWAY } from '../role_bindings.js';
import type { FanPageQuery, RunDetailOptions } from '../run-detail-summary.js';
import type { RunGateway } from '../run-gateway/interface.js';
import { UNSUPPORTED_RUN_REQUEST } from '../run-gateway/run-request-responder.js';
import { scanRunValueFacets } from '../run-value-facets.js';
import type { DashboardEngine } from './handlers.js';

/**
 * The slice of {@link import('../engine.js').WorkflowEngine} a store role's {@link
 * storeDashboardEngine} delegates to. Declared structurally (not by importing the concrete class) so
 * this module depends only on the verbs it forwards — mirrors `run-gateway/store-run-gateway.ts`'s
 * `RunGatewayEngine` pattern. The real `WorkflowEngine` is structurally assignable to this (every
 * method here — including `retryWithInput`, `continue`, and the global `subscribe` — already exists
 * on it).
 */
export interface StoreEngineLike {
  getRun: DashboardEngine['getRun'];
  listRuns: DashboardEngine['listRuns'];
  listCheckpoints: DashboardEngine['listCheckpoints'];
  getRunChildren: DashboardEngine['getRunChildren'];
  /** The run detail from the store's checkpoint aggregates (with an `etag`) — forwarded when the
   *  engine has it; without it the handlers build the detail from the full checkpoint list. */
  getRunDetail?: DashboardEngine['getRunDetail'];
  getFanMembers?: DashboardEngine['getFanMembers'];
  requeue: DashboardEngine['requeue'];
  redispatchPending?: DashboardEngine['redispatchPending'];
  cancel: DashboardEngine['cancel'];
  workerHealth: DashboardEngine['workerHealth'];
  retryWithInput(
    runId: string,
    input: unknown,
    newRunId?: string,
  ): Promise<{ runId: string } | null>;
  continue(runId: string): Promise<RunResult | null>;
  /** Console human-in-the-loop verbs — every real `WorkflowEngine` has them; forwarded 1:1. */
  signal(token: string, payload: unknown): Promise<RunResult | null>;
  update(runId: string, name: string, arg: unknown): Promise<UpdateResult>;
  completeTask(runId: string, name: string, result: unknown): Promise<RunResult | null>;
  failTask(runId: string, name: string, error: string): Promise<RunResult | null>;
  /** Runtime schedule control — every real `WorkflowEngine` has these; forwarded 1:1. */
  listSchedules(): Promise<ScheduleInfo[]>;
  setSchedulePaused(key: string, paused: boolean): boolean;
  triggerSchedule(key: string): Promise<RunResult | null>;
  /** The engine's GLOBAL listener (every run) — {@link storeDashboardEngine} filters it to one run,
   *  same as `StoreRunGateway.subscribe` does. */
  subscribe(listener: (event: EngineEvent) => void): () => void;
  /** Bulk signal-waiter scan — forwarded 1:1 to power `listRuns`' `waiting` stamp (see
   *  `DashboardEngine.listSignalWaiters`'s doc). Every real `WorkflowEngine` has it. */
  listSignalWaiters?(prefix: string): Promise<SignalWaiter[]>;
  /** Targeted per-page variant (`run_id IN (...)`, indexed) — forwarded when the engine has it. */
  listSignalWaitersByRunIds?(runIds: string[]): Promise<SignalWaiter[]>;
  /** Backlog gauges for `GET /metrics` and the `ctx.setEvent` live query — forwarded 1:1. */
  countRuns?(query: Omit<RunQuery, 'page' | 'size'>): Promise<number>;
  getEvent?(runId: string, key: string): Promise<unknown>;
  /** Value enumeration for the console's pickers — forwarded 1:1 when the engine has it. */
  runValueFacets?(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]>;
}

/**
 * Adapt a store-backed {@link import('../engine.js').WorkflowEngine} to the {@link DashboardEngine}
 * port — an explicit wrapper (not a raw `as DashboardEngine` cast) because two verbs need shape
 * bridging, not just a type assertion:
 * - `subscribe(runId, onEvent)` — the engine's `subscribe` is a GLOBAL listener with no `runId`
 *   filter; this narrows it to one run's events, byte-for-byte the same filter `StoreRunGateway`
 *   already applies.
 * - `redispatchPending` — degrades to `null` when the engine lacks it (kept optional for the same
 *   reason `RunGatewayEngine.redispatchPending` is: not every engine build has it yet).
 * Every other verb (including `retryWithInput`/`continue`, which the AdonisJS engine already
 * implements) forwards 1:1 — behavior unchanged from a plain cast for those.
 */
export function storeDashboardEngine(engine: StoreEngineLike): DashboardEngine {
  return {
    getRun: (runId) => engine.getRun(runId),
    listRuns: (query) => engine.listRuns(query),
    listCheckpoints: (runId) => engine.listCheckpoints(runId),
    getRunChildren: (runId) => engine.getRunChildren(runId),
    ...(engine.getRunDetail
      ? {
          getRunDetail: (runId: string, options?: RunDetailOptions) =>
            (engine.getRunDetail as NonNullable<StoreEngineLike['getRunDetail']>)(runId, options),
        }
      : {}),
    ...(engine.getFanMembers
      ? {
          getFanMembers: (runId: string, group: string, query: FanPageQuery) =>
            (engine.getFanMembers as NonNullable<StoreEngineLike['getFanMembers']>)(
              runId,
              group,
              query,
            ),
        }
      : {}),
    requeue: (runId) => engine.requeue(runId),
    redispatchPending: (runId) => engine.redispatchPending?.(runId) ?? Promise.resolve(null),
    cancel: (runId, opts) => engine.cancel(runId, opts),
    workerHealth: (extra) => engine.workerHealth(extra),
    retryWithInput: (runId, input) => engine.retryWithInput(runId, input),
    continue: (runId) => engine.continue(runId),
    signal: (token, payload) => engine.signal(token, payload),
    update: (runId, name, arg) => engine.update(runId, name, arg),
    completeTask: (runId, name, result) => engine.completeTask(runId, name, result),
    failTask: (runId, name, error) => engine.failTask(runId, name, error),
    listSchedules: () => engine.listSchedules(),
    setSchedulePaused: (key, paused) => engine.setSchedulePaused(key, paused),
    triggerSchedule: (key) => engine.triggerSchedule(key),
    subscribe: (runId, onEvent) =>
      engine.subscribe((event) => {
        if (event.runId === runId) onEvent(event);
      }),
    ...(engine.countRuns
      ? {
          countRuns: (query: Omit<RunQuery, 'page' | 'size'>) =>
            (engine.countRuns as NonNullable<StoreEngineLike['countRuns']>)(query),
        }
      : {}),
    ...(engine.getEvent
      ? {
          getEvent: (runId: string, key: string) =>
            (engine.getEvent as NonNullable<StoreEngineLike['getEvent']>)(runId, key),
        }
      : {}),
    ...(engine.listSignalWaiters
      ? {
          listSignalWaiters: (prefix: string) =>
            engine.listSignalWaiters?.(prefix) as Promise<SignalWaiter[]>,
        }
      : {}),
    ...(engine.listSignalWaitersByRunIds
      ? {
          listSignalWaitersByRunIds: (runIds: string[]) =>
            engine.listSignalWaitersByRunIds?.(runIds) as Promise<SignalWaiter[]>,
        }
      : {}),
    ...(engine.runValueFacets
      ? {
          runValueFacets: (
            axis: RunValueAxis,
            query: RunFacetQuery,
            opts?: RunValueFacetOptions,
          ): Promise<RunValueFacetRow[]> =>
            (engine.runValueFacets as NonNullable<StoreEngineLike['runValueFacets']>)(
              axis,
              query,
              opts,
            ),
        }
      : {}),
  };
}

/**
 * Adapt a {@link RunGateway} to the {@link DashboardEngine} port the JSON handlers drive, so a
 * **store-less `tenant` pod** serves the SAME dashboard over the wire (design §8) — every read/control
 * verb round-trips through the pod's `ProxyRunGateway` to the control plane, with NO local store or
 * engine. Store presence stays invisible above the handler line.
 *
 * The gateway is a near-superset of the port; three verbs need bridging:
 * - `listCheckpoints` → the gateway's `getCheckpoints` (same shape, §8 naming);
 * - `requeue` → the gateway's `redispatchPending` (the operator recovery verb; the extra
 *   `redispatched` count on the result is a harmless superset of `RunResult`);
 * - `subscribe(runId, onEvent)` → the gateway's own per-run `subscribe` (already scoped, no filtering
 *   needed here — unlike the store-role adapter above).
 *
 * `getRunChildren` (parent→child fan-out) rides the P4 read surface too (a `getRunChildren`
 * `RunRequestKind` verb), so a store-less tenant pod's run detail view lists children round-tripped over
 * the wire — the responder enforces the tenant-ownership check before answering (anti-IDOR).
 *
 * `retry`, `continue`, `retryWithInput`, `runValueFacets` and `waitingFor` ride the wire too (aviary's
 * verbs), so a tenant pod's console retries in place, continues a breakpoint, fixes and replays,
 * fills its value pickers and names what a suspended run waits on. Against a control plane that
 * predates them (it answers `unsupported-request` or an unknown-verb error) each degrades the way it
 * did before those verbs existed: `requeue` re-dispatches the run's pending steps, `continue` and
 * `retryWithInput` answer `null` (the handlers 404), the pickers count a bounded `listRuns` scan,
 * and the list rows carry no `waiting` stamp.
 */
export function gatewayDashboardEngine(gateway: RunGateway): DashboardEngine {
  return {
    getRun: (runId) => gateway.getRun(runId),
    listRuns: (query) => gateway.listRuns(query),
    listCheckpoints: (runId) => gateway.getCheckpoints(runId),
    getRunChildren: (runId) => gateway.getRunChildren(runId),
    ...(gateway.getRunDetail
      ? {
          getRunDetail: (runId: string, options?: RunDetailOptions) =>
            (gateway.getRunDetail as NonNullable<RunGateway['getRunDetail']>)(runId, options),
        }
      : {}),
    ...(gateway.getFanMembers
      ? {
          getFanMembers: (runId: string, group: string, query: FanPageQuery) =>
            (gateway.getFanMembers as NonNullable<RunGateway['getFanMembers']>)(
              runId,
              group,
              query,
            ),
        }
      : {}),
    requeue: (runId): Promise<RunResult | null> =>
      gateway.retry
        ? orOlder(gateway.retry(runId), () => gateway.redispatchPending(runId))
        : gateway.redispatchPending(runId),
    redispatchPending: (runId): Promise<RunResult | null> => gateway.redispatchPending(runId),
    cancel: (runId, opts) => gateway.cancel(runId, opts),
    workerHealth: () => gateway.workerHealth(),
    retryWithInput: (runId, input) =>
      gateway.retryWithInput
        ? orOlder(gateway.retryWithInput(runId, input), () => Promise.resolve(null))
        : Promise.resolve(null),
    continue: (runId) =>
      gateway.continue
        ? orOlder(gateway.continue(runId), () => Promise.resolve(null))
        : Promise.resolve(null),
    ...(gateway.runValueFacets
      ? {
          runValueFacets: (
            axis: RunValueAxis,
            query: RunFacetQuery,
            opts?: RunValueFacetOptions,
          ): Promise<RunValueFacetRow[]> =>
            orOlder(
              (gateway.runValueFacets as NonNullable<RunGateway['runValueFacets']>)(
                axis,
                query,
                opts,
              ),
              () => scanRunValueFacets({ listRuns: (q) => gateway.listRuns(q) }, axis, query, opts),
            ),
        }
      : {}),
    ...(gateway.runFacets
      ? {
          // The metrics backlog gauges, scoped to the tenant by the control plane.
          countRuns: async ({
            status,
            statuses,
            ...rest
          }: Omit<RunQuery, 'page' | 'size'>): Promise<number> => {
            const wanted = new Set(statuses ?? (status ? [status] : []));
            const cells = await (gateway.runFacets as NonNullable<RunGateway['runFacets']>)(rest);
            return cells
              .filter((c) => wanted.size === 0 || wanted.has(c.status))
              .reduce((n, c) => n + c.count, 0);
          },
        }
      : {}),
    ...(gateway.waitingFor
      ? {
          waitingFor: (runIds: string[]) =>
            orOlder((gateway.waitingFor as NonNullable<RunGateway['waitingFor']>)(runIds), () =>
              Promise.resolve({}),
            ),
        }
      : {}),
    subscribe: (runId, onEvent) => gateway.subscribe(runId, onEvent),
  };
}

/** `work`, or `older()` when the control plane answered that it does not know the verb. */
async function orOlder<T>(work: Promise<T>, older: () => Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === UNSUPPORTED_RUN_REQUEST) return older();
    throw err;
  }
}

/** The minimal container surface {@link dashboardEngineForRole} resolves bindings through. */
export interface DashboardContainer {
  make(key: unknown): Promise<unknown>;
}

/**
 * Resolve the dashboard's read/control port for the active durable `role` (design §5) — the single seam
 * that makes the dashboard store-agnostic:
 *
 * - **`tenant`** (store-less): resolve the {@link DURABLE_RUN_GATEWAY} token (a `ProxyRunGateway`) and
 *   adapt it — the engine binding is deliberately ABSENT on a tenant pod (structural isolation), so we
 *   MUST NOT reach for `WorkflowEngine` here;
 * - **store roles** (`standalone`/`control-plane`): resolve the concrete `WorkflowEngine` and adapt it
 *   via {@link storeDashboardEngine} — every verb still forwards 1:1, just through an explicit wrapper
 *   instead of a raw cast (see that function's doc for why).
 *
 * `engineToken` is injected (rather than imported) so the module doesn't hard-depend on the engine class
 * for the tenant path — the tenant branch never touches it.
 */
export async function dashboardEngineForRole(
  role: 'standalone' | 'control-plane' | 'tenant',
  container: DashboardContainer,
  engineToken: unknown,
): Promise<DashboardEngine> {
  if (role === 'tenant') {
    const gateway = (await container.make(DURABLE_RUN_GATEWAY)) as RunGateway;
    return gatewayDashboardEngine(gateway);
  }
  const engine = (await container.make(engineToken)) as StoreEngineLike;
  return storeDashboardEngine(engine);
}
