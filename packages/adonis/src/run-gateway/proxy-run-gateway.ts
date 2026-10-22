import { childIdsOf } from '../fan-join.js';
import type {
  EngineEvent,
  GroupHealth,
  RunFacetQuery,
  RunFacetRow,
  RunQuery,
  RunReply,
  RunRequest,
  RunRequestKind,
  RunResult,
  RunValueAxis,
  RunValueFacetOptions,
  RunValueFacetRow,
  RunWaiting,
  SearchAttributes,
  StartRunMessage,
  StepCheckpoint,
  TenantEvent,
  WorkflowRun,
} from '../interfaces.js';
import {
  type FanPage,
  type FanPageQuery,
  loadFanMembers,
  loadRunDetail,
  type RunDetail,
  type RunDetailOptions,
  type RunDetailSource,
} from '../run-detail-summary.js';
import { runFacetsOf } from '../run-facets.js';
import type { WorkflowRef } from '../workflow-ref.js';
import type { DurableTopology, RunGateway, StartRunOptions } from './interface.js';
import { UNSUPPORTED_RUN_REQUEST } from './run-request-responder.js';

/** The control plane answered a verb it does not know: it runs an older release than this tenant. */
class UnsupportedRunRequestError extends Error {
  readonly code = UNSUPPORTED_RUN_REQUEST;
}

/** The message a responder before 0.50 rejected an unknown verb with (it sent no `code`). */
const LEGACY_UNKNOWN_VERB = /^unknown run-request verb: /;

/**
 * The narrow slice of {@link import('../interfaces.js').Transport} the {@link ProxyRunGateway} needs —
 * the P4 store-less protocol methods, here declared NON-optional. They are all optional on the full
 * `Transport` (only broker transports carry P4), so the wiring code capability-checks
 * (`transport.dispatchRunRequest ? … : …`) before handing the transport in — the same pattern the
 * operator-side responder uses. Mirrors aviary's `ProxyRunGateway` transport dependency.
 */
export interface ProxyTransport {
  dispatchStartRun(msg: StartRunMessage): Promise<void>;
  dispatchRunRequest(msg: RunRequest): Promise<void>;
  onRunReply(handler: (reply: RunReply) => void): void;
  onTenantEvent(tenant: string, handler: (evt: TenantEvent) => void): () => void;
}

/** Options for {@link ProxyRunGateway}. */
export interface ProxyRunGatewayOptions {
  /**
   * Which tenant/partition this pod is — the human namespace name (NOT the signed token). Stamped on
   * {@link DurableTopology.tenant}, and it is the channel the proxy live-tails
   * (`${P}-tenant-events-<partition>`), because the control plane re-publishes a run's events keyed by
   * its resolved NAMESPACE (which equals this partition), never by the token.
   */
  partition: string;
  /**
   * The pod's signed claim, presented verbatim in the `tenant` field of every {@link RunRequest} /
   * {@link StartRunMessage}. The responder verifies it and DERIVES the real tenant from it, ignoring
   * the body (spec §9). Omit to run token-less on prefix/network isolation alone (aviary-compatible) —
   * then the raw `partition` travels in the `tenant` field and the responder trusts it directly.
   */
  token?: string | undefined;
  /** Round-trip timeout (ms) for a proxied read/control/start. Default 10_000. Spec §8: on timeout the
   *  proxy fails fast with a clear error rather than hanging a request forever. */
  requestTimeoutMs?: number | undefined;
  /**
   * How long (ms) the proxy remembers that the control plane does not know a verb (an older release,
   * mid rolling upgrade) and serves it from older verbs instead of asking again. Default 60_000.
   */
  capabilityTtlMs?: number | undefined;
}

/**
 * A pending wire round-trip, keyed in {@link ProxyRunGateway}'s correlation map by the id the matching
 * {@link RunReply} carries back (a minted `requestId` for a read/control request, or the minted `runId`
 * for a start). Method-shorthand signatures are deliberate: TypeScript checks method parameters
 * bivariantly, so a concrete `Promise<T>`'s `resolve` can be stored here erased to `unknown` with no
 * cast — the one place the generic `T` from {@link ProxyRunGateway} crosses into the untyped map.
 */
interface PendingReply {
  resolve(data: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Tenant-side {@link RunGateway} — a store-less pod's read/control/start surface, implemented ENTIRELY
 * over the wire. It owns NO store (structural isolation, spec §5): every verb round-trips to the
 * control plane's `RunRequestResponder` and back.
 *
 * - read/control (`getRun`/`listRuns`/`getCheckpoints`/`getRunChildren`/`getRunDetail`/
 *   `getFanMembers`/`getSearchAttributes`/`runFacets`/`runValueFacets`/`waitingFor`/`workerHealth`/
 *   `signal`/`cancel`/`retry`/`continue`/`retryWithInput`/`redispatchPending`) → publish a {@link RunRequest} correlated by a minted `requestId`,
 *   await the {@link RunReply} within `requestTimeoutMs`;
 * - `start` → publish a {@link StartRunMessage} (its own channel, byte-compatible with aviary), then
 *   await the reply the responder correlates by the minted `runId`;
 * - `subscribe` → bridge onto the transport's per-tenant event stream (`${P}-tenant-events-<partition>`);
 * - `topology` → `{ role: 'tenant', tenant: partition }` — synchronous local metadata, no round-trip.
 *
 * Fail-fast: a request whose reply never arrives within the timeout (a down/unreachable control plane,
 * a dropped reply) rejects with a clear, verb-named error instead of hanging forever.
 *
 * Idiomatic AdonisJS: a plain class constructed with its transport dependency, wired by the package's
 * provider for the `tenant` role. The counterpart to the operator-side `StoreRunGateway`.
 */
export class ProxyRunGateway implements RunGateway {
  readonly #transport: ProxyTransport;
  readonly #partition: string;
  readonly #wireTenant: string;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, PendingReply>();
  readonly #capabilityTtlMs: number;
  /**
   * Verb → when to ask the control plane for it again, after it answered that it does not know it.
   * During a rolling upgrade the control plane is several pods of mixed versions behind one queue and
   * a reply does not say which pod sent it, so the whole control plane counts as old until then.
   */
  readonly #unsupportedUntil = new Map<RunRequestKind['kind'], number>();

  constructor(transport: ProxyTransport, options: ProxyRunGatewayOptions) {
    this.#transport = transport;
    this.#partition = options.partition;
    // The signed token (verified + tenant-derived by the responder) travels in the `tenant` field; with
    // no token, the raw partition does (prefix-isolation-only, aviary-compatible).
    this.#wireTenant = options.token ?? options.partition;
    this.#timeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#capabilityTtlMs = options.capabilityTtlMs ?? 60_000;
    // One reply subscription for the whole gateway; every RunReply is matched to its pending call by id.
    this.#transport.onRunReply((reply) => this.#handleReply(reply));
  }

  #handleReply(reply: RunReply): void {
    const pending = this.#pending.get(reply.requestId);
    if (!pending) return; // an unknown/expired id (or another pod's reply on the shared channel) — ignore
    clearTimeout(pending.timer);
    this.#pending.delete(reply.requestId);
    if (reply.result.ok) {
      pending.resolve(reply.result.data);
    } else if (
      reply.result.error.code === UNSUPPORTED_RUN_REQUEST ||
      (reply.result.error.code === undefined &&
        LEGACY_UNKNOWN_VERB.test(reply.result.error.message))
    ) {
      pending.reject(new UnsupportedRunRequestError(reply.result.error.message));
    } else {
      const err = new Error(reply.result.error.message) as Error & { code?: string };
      if (reply.result.error.code !== undefined) err.code = reply.result.error.code;
      pending.reject(err);
    }
  }

  /** Register a pending reply keyed by `correlationId`, arm the fail-fast timeout, and run `send` (the
   *  publish). A publish rejection settles the pending call immediately; a missing reply trips the timer. */
  #awaitReply<T>(correlationId: string, verbLabel: string, send: () => Promise<void>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(correlationId);
        reject(
          new Error(
            `durable control plane did not answer ${verbLabel} within ${this.#timeoutMs}ms`,
          ),
        );
      }, this.#timeoutMs);
      // Don't keep the event loop alive just waiting on a reply.
      timer.unref?.();
      this.#pending.set(correlationId, { resolve: resolve as (d: unknown) => void, reject, timer });
      send().catch((error: unknown) => {
        const stillPending = this.#pending.get(correlationId);
        if (!stillPending) return; // already settled (timed out / replied) — don't double-reject
        clearTimeout(stillPending.timer);
        this.#pending.delete(correlationId);
        stillPending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /** Publish a read/control {@link RunRequest} with a freshly minted `requestId` and await its reply. */
  #request<T>(body: RunRequestKind): Promise<T> {
    const requestId = globalThis.crypto.randomUUID();
    return this.#awaitReply<T>(requestId, body.kind, () =>
      this.#transport.dispatchRunRequest({ requestId, tenant: this.#wireTenant, body }),
    );
  }

  topology(): DurableTopology {
    return { role: 'tenant', tenant: this.#partition };
  }

  getRun(runId: string): Promise<WorkflowRun | null> {
    return this.#request<WorkflowRun | null>({ kind: 'getRun', runId });
  }

  listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    return this.#request<WorkflowRun[]>({ kind: 'listRuns', query });
  }

  getCheckpoints(runId: string): Promise<StepCheckpoint[]> {
    return this.#request<StepCheckpoint[]>({ kind: 'getCheckpoints', runId });
  }

  getRunChildren(runId: string): Promise<string[]> {
    return this.#request<string[]>({ kind: 'getRunChildren', runId });
  }

  /**
   * The detail in one round-trip. A control plane older than the verb (before 0.49) rejects it as
   * unknown; the proxy then builds the same detail here from `getRun` + `getCheckpoints` (+
   * `getRunChildren`), each still ownership-checked by the responder, and summarizes it locally.
   */
  getRunDetail(runId: string, options?: RunDetailOptions): Promise<RunDetail | null> {
    return this.#withFallback(
      'getRunDetail',
      () =>
        this.#request<RunDetail | null>(
          options === undefined
            ? { kind: 'getRunDetail', runId }
            : { kind: 'getRunDetail', runId, options },
        ),
      () => loadRunDetail(this.#legacyDetailSource(), runId, options),
    );
  }

  /** One page of a fan, paged here from the full timeline when the control plane predates the verb. */
  getFanMembers(runId: string, group: string, query: FanPageQuery): Promise<FanPage | null> {
    return this.#withFallback(
      'getFanMembers',
      () => this.#request<FanPage | null>({ kind: 'getFanMembers', runId, group, query }),
      () => loadFanMembers(this.#legacyDetailSource(), runId, group, query),
    );
  }

  /**
   * Ask the control plane for `kind`, or serve `fallback` when it answers that it does not know the
   * verb (remembered for `capabilityTtlMs`, so a fleet mid-upgrade costs one extra round-trip a
   * minute rather than one per call). Any other failure propagates.
   */
  async #withFallback<T>(
    kind: RunRequestKind['kind'],
    ask: () => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    if (!this.#knownUnsupported(kind)) {
      try {
        return await ask();
      } catch (err) {
        if (!(err instanceof UnsupportedRunRequestError)) throw err;
        this.#unsupportedUntil.set(kind, Date.now() + this.#capabilityTtlMs);
      }
    }
    return fallback();
  }

  #knownUnsupported(kind: RunRequestKind['kind']): boolean {
    const until = this.#unsupportedUntil.get(kind);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    this.#unsupportedUntil.delete(kind);
    return false;
  }

  /** The verbs every control plane answers, as a {@link RunDetailSource}. Children fall back to the
   *  timeline's child edges if even `getRunChildren` is unknown. */
  #legacyDetailSource(): RunDetailSource {
    return {
      getRun: (runId) => this.getRun(runId),
      listCheckpoints: (runId) => this.getCheckpoints(runId),
      getRunChildren: (runId) =>
        this.#withFallback(
          'getRunChildren',
          () => this.getRunChildren(runId),
          async () => [...new Set(childIdsOf(await this.getCheckpoints(runId)))],
        ),
    };
  }

  getSearchAttributes(runId: string): Promise<SearchAttributes | undefined> {
    return this.#request<SearchAttributes | undefined>({ kind: 'getSearchAttributes', runId });
  }

  /** Round-trips to the operator, which scopes the result to this tenant's own `@<partition>` groups. */
  workerHealth(): Promise<GroupHealth[]> {
    return this.#request<GroupHealth[]>({ kind: 'workerHealth' });
  }

  /**
   * Publish a {@link StartRunMessage} (its own `${P}-start-run` channel) and await the reply the
   * responder correlates by the minted `runId`. The proxy ALWAYS mints/forwards a `runId` (idempotency
   * key) so the fire-and-forget aviary `StartRunMessage` can carry a correlated answer back without
   * changing its bytes.
   */
  start(workflow: WorkflowRef, input: unknown, opts?: StartRunOptions): Promise<RunResult> {
    const runId = opts?.runId ?? globalThis.crypto.randomUUID();
    const msg: StartRunMessage = {
      tenant: this.#wireTenant,
      // A `WorkflowRef` is a class or a string; the wire carries the registered NAME. The engine's
      // string overload accepts both at runtime, so resolve to the string form on the wire.
      workflow: workflow as string,
      input,
      runId,
      ...(opts?.tags !== undefined ? { tags: opts.tags } : {}),
      ...(opts?.searchAttributes !== undefined ? { searchAttributes: opts.searchAttributes } : {}),
    };
    return this.#awaitReply<RunResult>(runId, 'start', () => this.#transport.dispatchStartRun(msg));
  }

  signal(runId: string, signal: string, payload?: unknown): Promise<RunResult | null> {
    return this.#request<RunResult | null>(
      payload === undefined
        ? { kind: 'signal', runId, signal }
        : { kind: 'signal', runId, signal, payload },
    );
  }

  cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null> {
    return this.#request<RunResult | null>(
      opts === undefined ? { kind: 'cancel', runId } : { kind: 'cancel', runId, opts },
    );
  }

  redispatchPending(runId: string): Promise<(RunResult & { redispatched: number }) | null> {
    return this.#request<(RunResult & { redispatched: number }) | null>({
      kind: 'redispatch',
      runId,
    });
  }

  retry(runId: string): Promise<RunResult | null> {
    return this.#request<RunResult | null>({ kind: 'retry', runId });
  }

  continue(runId: string): Promise<RunResult | null> {
    return this.#request<RunResult | null>({ kind: 'continue', runId });
  }

  retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null> {
    return this.#request<{ runId: string } | null>({ kind: 'retryWithInput', runId, input });
  }

  /**
   * Scoped by the control plane to this tenant's own runs (the query's namespace is replaced). A
   * control plane older than the verb rejects it as unknown; the proxy then counts the same cells
   * from `runValueFacets` (the status axis per origin), or — on one older still — from a `listRuns`
   * of the tenant's matching runs. Each answer is scoped by the control plane like the verb itself.
   */
  runFacets(query: RunFacetQuery): Promise<RunFacetRow[]> {
    return this.#withFallback(
      'runFacets',
      () => this.#request<RunFacetRow[]>({ kind: 'runFacets', query }),
      () =>
        this.#withFallback(
          'runValueFacets',
          () =>
            runFacetsOf(
              { runValueFacets: (axis, q, opts) => this.runValueFacets(axis, q, opts) },
              query,
            ),
          () => runFacetsOf({ listRuns: (q) => this.listRuns(q) }, query),
        ),
    );
  }

  /** Scoped by the control plane to this tenant's own runs (the query's namespace is replaced). */
  runValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]> {
    return this.#request<RunValueFacetRow[]>(
      opts === undefined
        ? { kind: 'runValueFacets', axis, query }
        : { kind: 'runValueFacets', axis, query, opts },
    );
  }

  /** Only this tenant's own runs come back; another tenant's ids are silently absent. */
  waitingFor(runIds: string[]): Promise<Record<string, RunWaiting>> {
    if (runIds.length === 0) return Promise.resolve({});
    return this.#request<Record<string, RunWaiting>>({ kind: 'waitingFor', runIds });
  }

  /** Live-tail ONE run by bridging onto this tenant's event channel and filtering by `runId`. */
  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void {
    return this.#transport.onTenantEvent(this.#partition, (evt) => {
      if (evt.event.runId === runId) onEvent(evt.event);
    });
  }
}
