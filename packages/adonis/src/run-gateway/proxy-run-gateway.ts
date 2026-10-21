import type {
  EngineEvent,
  GroupHealth,
  RunQuery,
  RunReply,
  RunRequest,
  RunRequestKind,
  RunResult,
  SearchAttributes,
  StartRunMessage,
  StepCheckpoint,
  TenantEvent,
  WorkflowRun,
} from '../interfaces.js';
import type { FanPage, FanPageQuery, RunDetail, RunDetailOptions } from '../run-detail-summary.js';
import type { WorkflowRef } from '../workflow-ref.js';
import type { DurableTopology, RunGateway, StartRunOptions } from './interface.js';

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
 * - read/control (`getRun`/`listRuns`/`getCheckpoints`/`getSearchAttributes`/`workerHealth`/`signal`/
 *   `cancel`/`redispatchPending`) → publish a {@link RunRequest} correlated by a minted `requestId`,
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

  constructor(transport: ProxyTransport, options: ProxyRunGatewayOptions) {
    this.#transport = transport;
    this.#partition = options.partition;
    // The signed token (verified + tenant-derived by the responder) travels in the `tenant` field; with
    // no token, the raw partition does (prefix-isolation-only, aviary-compatible).
    this.#wireTenant = options.token ?? options.partition;
    this.#timeoutMs = options.requestTimeoutMs ?? 10_000;
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

  getRunDetail(runId: string, options?: RunDetailOptions): Promise<RunDetail | null> {
    return this.#request<RunDetail | null>(
      options === undefined
        ? { kind: 'getRunDetail', runId }
        : { kind: 'getRunDetail', runId, options },
    );
  }

  getFanMembers(runId: string, group: string, query: FanPageQuery): Promise<FanPage | null> {
    return this.#request<FanPage | null>({ kind: 'getFanMembers', runId, group, query });
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

  /** Live-tail ONE run by bridging onto this tenant's event channel and filtering by `runId`. */
  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void {
    return this.#transport.onTenantEvent(this.#partition, (evt) => {
      if (evt.event.runId === runId) onEvent(evt.event);
    });
  }
}
