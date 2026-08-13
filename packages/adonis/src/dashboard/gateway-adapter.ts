import type { EngineEvent, RunResult, SignalWaiter } from '../interfaces.js';
import { DURABLE_RUN_GATEWAY } from '../role_bindings.js';
import type { RunGateway } from '../run-gateway/interface.js';
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
  /** The engine's GLOBAL listener (every run) — {@link storeDashboardEngine} filters it to one run,
   *  same as `StoreRunGateway.subscribe` does. */
  subscribe(listener: (event: EngineEvent) => void): () => void;
  /** Bulk signal-waiter scan — forwarded 1:1 to power `listRuns`' `waiting` stamp (see
   *  `DashboardEngine.listSignalWaiters`'s doc). Every real `WorkflowEngine` has it. */
  listSignalWaiters?(prefix: string): Promise<SignalWaiter[]>;
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
    requeue: (runId) => engine.requeue(runId),
    redispatchPending: (runId) => engine.redispatchPending?.(runId) ?? Promise.resolve(null),
    cancel: (runId, opts) => engine.cancel(runId, opts),
    workerHealth: (extra) => engine.workerHealth(extra),
    retryWithInput: (runId, input) => engine.retryWithInput(runId, input),
    continue: (runId) => engine.continue(runId),
    subscribe: (runId, onEvent) =>
      engine.subscribe((event) => {
        if (event.runId === runId) onEvent(event);
      }),
    ...(engine.listSignalWaiters
      ? {
          listSignalWaiters: (prefix: string) =>
            engine.listSignalWaiters?.(prefix) as Promise<SignalWaiter[]>,
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
 * `retryWithInput`/`continue` have NO gateway verb yet (design §8 didn't need fix-and-replay or
 * breakpoint-continue over the wire) — they degrade to `null`, same convention as
 * `RunGatewayEngine.redispatchPending`'s optional degrade. A tenant pod's dashboard therefore shows
 * these actions as unavailable (the handlers 404) until the wire protocol grows the verbs.
 */
export function gatewayDashboardEngine(gateway: RunGateway): DashboardEngine {
  return {
    getRun: (runId) => gateway.getRun(runId),
    listRuns: (query) => gateway.listRuns(query),
    listCheckpoints: (runId) => gateway.getCheckpoints(runId),
    getRunChildren: (runId) => gateway.getRunChildren(runId),
    requeue: (runId): Promise<RunResult | null> => gateway.redispatchPending(runId),
    redispatchPending: (runId): Promise<RunResult | null> => gateway.redispatchPending(runId),
    cancel: (runId, opts) => gateway.cancel(runId, opts),
    workerHealth: () => gateway.workerHealth(),
    retryWithInput: () => Promise.resolve(null),
    continue: () => Promise.resolve(null),
    subscribe: (runId, onEvent) => gateway.subscribe(runId, onEvent),
  };
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
