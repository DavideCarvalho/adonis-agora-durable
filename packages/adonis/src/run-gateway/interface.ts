import type { StartOptions } from '../engine.js';
import type {
  EngineEvent,
  GroupHealth,
  RunQuery,
  RunResult,
  SearchAttributes,
  StepCheckpoint,
  WorkflowRun,
} from '../interfaces.js';
import type { WorkflowRef } from '../workflow-ref.js';

/**
 * Which durable topology a gateway speaks for — surfaced so an operator/consumer can tell a control
 * plane from a tenant (or a single-process standalone) at a glance. Cheap, synchronous, LOCAL
 * knowledge: no round-trip. Byte-compatible with aviary's `DurableTopology`, plus a `standalone` role
 * for the single-process deployment this package targets first (aviary is cluster-only, so it never
 * needed one). The store-backed gateway ({@link RunGateway} via `StoreRunGateway`) is the operator; a
 * later `ProxyRunGateway` is the `tenant`.
 */
export interface DurableTopology {
  role: 'control-plane' | 'standalone' | 'tenant';
  /** The tenant's isolation partition name; set only when `role` is 'tenant'. */
  tenant?: string | undefined;
}

/**
 * Options for {@link RunGateway.start}. Extends the engine's {@link StartOptions} with an OPTIONAL
 * `runId`: the gateway mints one (idempotency key) when the caller doesn't supply it, so a gateway
 * `start` reads `start(workflow, input, opts?)` — one fewer positional than the engine's
 * `start(workflow, input, runId, opts?)` — matching §8's verb shape while staying idempotent-by-id.
 */
export interface StartRunOptions extends StartOptions {
  /** Explicit run id (idempotency key). Omit to have the gateway mint a fresh one. */
  runId?: string | undefined;
}

/**
 * The bounded read / control / stream surface a consumer (a controller, the dashboard, a CLI) needs,
 * intended to be satisfied by BOTH durable topologies: a `standalone` / `control-plane` deployment
 * binds the store-backed `StoreRunGateway` (delegates to the local {@link WorkflowEngine}); a `tenant`
 * deployment will later bind a `ProxyRunGateway` that round-trips these same verbs over the transport
 * to the control plane (Wave 2 — NOT built here). The interface is deliberately transport-agnostic —
 * every verb is `Promise`-returning (or a synchronous unsubscribe for `subscribe`) so a proxy can
 * implement it without changing a single signature.
 *
 * Verb set follows the store-less cluster design §8. Names/shapes are kept byte-compatible with
 * aviary's `RunGateway` where the same verb exists there (`topology`, `listRuns`, `cancel`,
 * `redispatchPending`, `subscribe`); the §8-only verbs (`getRun`, `getCheckpoints`, `signal`,
 * `start`, `getSearchAttributes`) take engine-faithful shapes.
 */
export interface RunGateway {
  /** This deployment's durable role — synchronous, local metadata (no store/transport hit). */
  topology(): DurableTopology;

  /** Read a run's current persisted state, or null if unknown. */
  getRun(runId: string): Promise<WorkflowRun | null>;

  /** List runs matching `query` (paged via 1-based `page`/`size`, filtered by workflow/status/tag/search
   *  attributes), newest activity first per the store's ordering. */
  listRuns(query: RunQuery): Promise<WorkflowRun[]>;

  /** A run's step checkpoints in execution order — its timeline / history (the detail-view body). */
  getCheckpoints(runId: string): Promise<StepCheckpoint[]>;

  /** The ids of the runs this run spawned (parent→child tree) — the detail view's children list. Empty
   *  for a leaf run (or an unknown one). A `ProxyRunGateway` round-trips this over the P4 wire. */
  getRunChildren(runId: string): Promise<string[]>;

  /** Typed, queryable run data (`searchAttributes`) stamped on the run, or undefined if it has none. */
  getSearchAttributes(runId: string): Promise<SearchAttributes | undefined>;

  /** Per-group worker health (queue backlog + live worker heartbeats). On a control plane this is
   *  every group; a tenant proxy scopes it to the tenant's own groups. */
  workerHealth(): Promise<GroupHealth[]>;

  /**
   * Start a new run and return its result (carrying the `runId` — minted when `opts.runId` is
   * omitted). Idempotent by run id: a redelivered start for the same id returns the existing run's
   * state instead of creating a duplicate.
   */
  start(workflow: WorkflowRef, input: unknown, opts?: StartRunOptions): Promise<RunResult>;

  /**
   * Deliver an external `signal` (by name/token) with `payload` to the run addressed by `runId`,
   * resuming a run parked on it. Returns the run result, or null if nothing was waiting (the payload
   * is buffered for the next waiter — reliable signals). `runId` addresses the target run for a proxy
   * to route to its owning control plane.
   */
  signal(runId: string, signal: string, payload?: unknown): Promise<RunResult | null>;

  /** Cancel a run. Pass `{ compensate: true }` to run the saga undo first. Returns the run result, or
   *  null if the run is unknown. */
  cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null>;

  /**
   * Re-dispatch every remote step of a run stuck `pending` — the operator recovery for a LOST step
   * dispatch (crashed worker / dropped job) that no automatic path re-drives. Returns the run's status
   * plus how many steps were re-dispatched, or null if the run is unknown / the deployment can't
   * re-dispatch. Byte-compatible with aviary's `redispatchPending`.
   */
  redispatchPending(runId: string): Promise<(RunResult & { redispatched: number }) | null>;

  /** Live lifecycle events for ONE run; returns an unsubscribe fn. Framework-agnostic (no rxjs). */
  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void;
}
