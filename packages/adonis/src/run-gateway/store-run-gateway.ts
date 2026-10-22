import type {
  EngineEvent,
  GroupHealth,
  RunFacetQuery,
  RunQuery,
  RunResult,
  RunValueAxis,
  RunValueFacetOptions,
  RunValueFacetRow,
  RunWaiting,
  SearchAttributes,
  SignalWaiter,
  StepCheckpoint,
  WorkflowRun,
} from '../interfaces.js';
import {
  type FanPage,
  type FanPageQuery,
  loadFanMembers,
  loadRunDetail,
  type RunDetail,
  type RunDetailOptions,
} from '../run-detail-summary.js';
import { type RunFacetRow, runFacetsOf, waitingForRuns } from '../run-facets.js';
import type { WorkflowRef } from '../workflow-ref.js';
import type { DurableTopology, RunGateway, StartRunOptions } from './interface.js';

/**
 * The slice of {@link WorkflowEngine} the {@link StoreRunGateway} delegates to. Declared structurally
 * (not by importing the concrete class) so the gateway depends only on the verbs it forwards, and so
 * `redispatchPending` — which the AdonisJS engine does NOT yet implement (the lost-remote-step
 * re-dispatch machinery from aviary's core engine isn't ported) — can be declared OPTIONAL: the
 * gateway calls it when present and degrades to `null` when absent. The real `WorkflowEngine` is
 * structurally assignable to this.
 *
 * TODO(integrator): once the engine grows a `redispatchPending(runId)` method (port of aviary
 * `WorkflowEngine.redispatchPending`), this optional member becomes a hard delegation. Consider
 * exporting a shared engine-facing port type from the package so this local structural mirror can be
 * dropped.
 */
export interface RunGatewayEngine {
  getRun(runId: string): Promise<WorkflowRun | null>;
  listRuns(query: RunQuery): Promise<WorkflowRun[]>;
  listCheckpoints(runId: string): Promise<StepCheckpoint[]>;
  getRunChildren(parentRunId: string): Promise<string[]>;
  workerHealth(extra?: string[]): Promise<GroupHealth[]>;
  start(
    workflow: string,
    input: unknown,
    runId: string,
    opts?: StartRunOptions,
  ): Promise<RunResult>;
  signal(token: string, payload: unknown): Promise<RunResult | null>;
  cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null>;
  subscribe(listener: (event: EngineEvent) => void): () => void;
  /** Optional — absent on the current AdonisJS engine; see {@link RunGatewayEngine} note. */
  redispatchPending?(runId: string): Promise<(RunResult & { redispatched: number }) | null>;
  /** The aviary verbs below. Optional on the port so a narrower engine double still fits; the real
   *  `WorkflowEngine` has every one. A missing one degrades to `null` / `[]` / `{}`. */
  requeue?(runId: string): Promise<RunResult | null>;
  continue?(runId: string): Promise<RunResult | null>;
  retryWithInput?(runId: string, input: unknown): Promise<{ runId: string } | null>;
  runValueFacets?(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]>;
  listSignalWaitersByRunIds?(runIds: string[]): Promise<SignalWaiter[]>;
}

/** Options for {@link StoreRunGateway}. */
export interface StoreRunGatewayOptions {
  /**
   * The role reported by {@link StoreRunGateway.topology}. `standalone` for a single-process
   * deployment (the default — this package's first target); `control-plane` when this engine is the
   * store-owning operator that tenant proxies round-trip to. A store-backed gateway is never a
   * `tenant` (that's the proxy's role), so only these two are accepted.
   */
  role?: 'standalone' | 'control-plane' | undefined;
}

/**
 * Store-backed {@link RunGateway} — the operator-side implementation. Wraps the local
 * {@link WorkflowEngine} and forwards each read/control/stream verb to the engine's existing method,
 * exactly the surface a `standalone` or `control-plane` deployment exposes. It holds NO state of its
 * own beyond the injected engine and its declared role; all durability lives in the engine/store.
 *
 * Idiomatic AdonisJS: a plain class constructed with its dependency, wired by the package's provider /
 * `defineConfig` (no framework DI decorators). A later `ProxyRunGateway` (Wave 2) will implement the
 * SAME {@link RunGateway} interface over the transport for `tenant` deployments — nothing here needs
 * to change for that.
 */
export class StoreRunGateway implements RunGateway {
  readonly #engine: RunGatewayEngine;
  readonly #role: 'standalone' | 'control-plane';

  constructor(engine: RunGatewayEngine, options: StoreRunGatewayOptions = {}) {
    this.#engine = engine;
    this.#role = options.role ?? 'standalone';
  }

  topology(): DurableTopology {
    return { role: this.#role };
  }

  getRun(runId: string): Promise<WorkflowRun | null> {
    return this.#engine.getRun(runId);
  }

  listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    return this.#engine.listRuns(query);
  }

  getCheckpoints(runId: string): Promise<StepCheckpoint[]> {
    return this.#engine.listCheckpoints(runId);
  }

  getRunChildren(runId: string): Promise<string[]> {
    return this.#engine.getRunChildren(runId);
  }

  getRunDetail(runId: string, options?: RunDetailOptions): Promise<RunDetail | null> {
    return loadRunDetail(this.#engine, runId, options);
  }

  getFanMembers(runId: string, group: string, query: FanPageQuery): Promise<FanPage | null> {
    return loadFanMembers(this.#engine, runId, group, query);
  }

  async getSearchAttributes(runId: string): Promise<SearchAttributes | undefined> {
    const run = await this.#engine.getRun(runId);
    return run?.searchAttributes;
  }

  workerHealth(): Promise<GroupHealth[]> {
    return this.#engine.workerHealth();
  }

  async start(workflow: WorkflowRef, input: unknown, opts?: StartRunOptions): Promise<RunResult> {
    const runId = opts?.runId ?? globalThis.crypto.randomUUID();
    // `start` is overloaded per ref kind (class | string) on the engine; a `WorkflowRef` union fits
    // neither overload, so resolve to the string overload (the engine handles both at runtime).
    return this.#engine.start(workflow as string, input, runId, opts);
  }

  /**
   * Deliver `signal` (by name) with `payload` to the addressed run. Confirmed against the engine's
   * waiter convention (design §8): `engine.signal` is GENUINELY GLOBAL-BY-NAME — `ctx.waitForSignal(name)`
   * registers a waiter under the caller-chosen `name` VERBATIM, and `engine.signal(name, payload)` matches
   * by that exact string. There is NO `signal:<runId>:<name>` waiter convention: the run-scoped families
   * (`task:<runId>:<name>`, `update:<runId>:<name>`, `wh:<runId>:<seq>`, `child:<id>`) are the FRAMEWORK
   * composing the token before it hands it to `waitForSignal` — an external, user-named signal never is.
   * Deriving a run-scoped token here would therefore reach NO waiter (a run parked on `waitForSignal('go')`
   * would never see `signal('go')`), so the name is forwarded unchanged.
   *
   * `runId` is NOT dropped from the port on purpose: the `RunRequestResponder` uses it for the tenant
   * ownership check (loads the run, rejects cross-tenant) BEFORE this delegates, and a `ProxyRunGateway`
   * uses it to route to the run's owning control plane. So the signal stays name-addressed while the run
   * boundary is still enforced one layer up.
   */
  signal(_runId: string, signal: string, payload?: unknown): Promise<RunResult | null> {
    return this.#engine.signal(signal, payload);
  }

  cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null> {
    return this.#engine.cancel(runId, opts);
  }

  redispatchPending(runId: string): Promise<(RunResult & { redispatched: number }) | null> {
    // The AdonisJS engine doesn't yet expose per-step re-dispatch; degrade to null when absent so the
    // verb stays byte-compatible for a proxy without inventing engine behaviour. See RunGatewayEngine.
    return this.#engine.redispatchPending?.(runId) ?? Promise.resolve(null);
  }

  retry(runId: string): Promise<RunResult | null> {
    return this.#engine.requeue?.(runId) ?? Promise.resolve(null);
  }

  continue(runId: string): Promise<RunResult | null> {
    return this.#engine.continue?.(runId) ?? Promise.resolve(null);
  }

  retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null> {
    return this.#engine.retryWithInput?.(runId, input) ?? Promise.resolve(null);
  }

  runFacets(query: RunFacetQuery): Promise<RunFacetRow[]> {
    const engine = this.#engine;
    const facets = engine.runValueFacets;
    if (!facets) return Promise.resolve([]);
    return runFacetsOf(
      { runValueFacets: (axis, q, opts) => facets.call(engine, axis, q, opts) },
      query,
    );
  }

  runValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]> {
    return this.#engine.runValueFacets?.(axis, query, opts) ?? Promise.resolve([]);
  }

  waitingFor(runIds: string[]): Promise<Record<string, RunWaiting>> {
    const engine = this.#engine;
    const byRunIds = engine.listSignalWaitersByRunIds;
    if (!byRunIds) return Promise.resolve({});
    return waitingForRuns(
      {
        getRun: (runId) => engine.getRun(runId),
        listSignalWaitersByRunIds: (ids) => byRunIds.call(engine, ids),
      },
      runIds,
    );
  }

  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void {
    return this.#engine.subscribe((event) => {
      if (event.runId === runId) onEvent(event);
    });
  }
}
