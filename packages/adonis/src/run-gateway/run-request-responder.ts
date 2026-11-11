import type { TenantVerifier } from '../config_types.js';
import type {
  EngineEvent,
  RunReply,
  RunReplyResult,
  RunRequest,
  RunRequestKind,
  RunWaiting,
  StartRunMessage,
  TenantEvent,
  WorkflowRun,
} from '../interfaces.js';
import {
  type LifecycleKind,
  lifecycleEventName,
  lifecycleKindOf,
  type RepublishLifecycleTarget,
} from '../lifecycle-events.js';
import {
  loadFanMembers,
  loadRunDetail,
  type RunDetail,
  type RunDetailSource,
} from '../run-detail-summary.js';
import { runFacetsOf } from '../run-facets.js';
import type { RunGateway } from './interface.js';

/**
 * The narrow slice of {@link import('../interfaces.js').Transport} the {@link RunRequestResponder}
 * consumes — the control-plane side of the P4 protocol, declared NON-optional. All four are optional
 * on the full `Transport` (only broker transports carry P4), so the wiring code capability-checks
 * before constructing the responder. Mirrors aviary's `RunRequestTransport` narrowing convention.
 */
export interface ResponderTransport {
  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void;
  onStartRun(handler: (msg: StartRunMessage) => Promise<void>): void;
  publishRunReply(reply: RunReply): Promise<void>;
  publishTenantEvent(evt: TenantEvent): Promise<void>;
}

/**
 * The error `code` a responder answers a verb it does not know with, so a newer tenant can tell
 * "this control plane is older than me" from a real failure and fall back at once instead of
 * waiting out its timeout.
 */
export const UNSUPPORTED_RUN_REQUEST = 'unsupported-request';

/** Every verb this responder answers. Checked before the gateway is touched. */
const KNOWN_KINDS: ReadonlySet<string> = new Set<RunRequestKind['kind']>([
  'getRun',
  'listRuns',
  'getCheckpoints',
  'getSearchAttributes',
  'getRunChildren',
  'getRunDetail',
  'getFanMembers',
  'workerHealth',
  'signal',
  'cancel',
  'redispatch',
  'runFacets',
  'runValueFacets',
  'retry',
  'continue',
  'retryWithInput',
  'waitingFor',
  'republishLifecycle',
  'workflowLifecycle',
]);

/** A wire `since`/`until` (an ISO string after JSON) back to a `Date`. */
function wireDate(value: unknown): Date | undefined {
  if (value === undefined || value === null) return undefined;
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : undefined;
  if (!date || Number.isNaN(date.getTime())) throw new Error(`invalid date ${String(value)}`);
  return date;
}

/** The most runs one tenant `republishLifecycle` of a workflow walks (a larger `limit` is clamped). */
export const REPUBLISH_LIMIT_CAP = 1000;

/** The code of a reply refusing a malformed or disallowed request. */
export const BAD_REQUEST = 'bad-request';

/**
 * The {@link RepublishLifecycleTarget} a wire target stands for: exactly one of `runId` and
 * `workflow`, `since`/`until` back to dates. Throws on a malformed one.
 */
function republishTargetOf(value: unknown): RepublishLifecycleTarget {
  const t = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const subscriber = t.subscriber;
  if (subscriber !== undefined && typeof subscriber !== 'string') {
    throw new BadRequestError('republishLifecycle subscriber must be a string');
  }
  const sub = subscriber !== undefined ? { subscriber } : {};
  if (typeof t.runId === 'string' && t.workflow === undefined) return { runId: t.runId, ...sub };
  if (typeof t.workflow !== 'string' || t.runId !== undefined) {
    throw new BadRequestError('republishLifecycle needs a { runId } or { workflow } target');
  }
  if (t.kind !== undefined && t.kind !== 'completed' && t.kind !== 'failed') {
    throw new BadRequestError('republishLifecycle kind must be completed or failed');
  }
  if (
    t.limit !== undefined &&
    (typeof t.limit !== 'number' || !Number.isInteger(t.limit) || t.limit <= 0)
  ) {
    throw new BadRequestError('republishLifecycle limit must be a positive integer');
  }
  const limit = t.limit === undefined ? undefined : Math.min(t.limit, REPUBLISH_LIMIT_CAP);
  const since = wireDate(t.since);
  const until = wireDate(t.until);
  return {
    workflow: t.workflow,
    ...(t.kind !== undefined ? { kind: t.kind } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...sub,
  };
}

/** The verbs that carry no `runId` and are scoped some other way. */
type UnscopedKind = Extract<
  RunRequestKind,
  {
    kind:
      | 'listRuns'
      | 'workerHealth'
      | 'runFacets'
      | 'runValueFacets'
      | 'waitingFor'
      | 'republishLifecycle'
      | 'workflowLifecycle';
  }
>;

/** Options for {@link RunRequestResponder}. */
export interface RunRequestResponderOptions {
  /**
   * Verifies a tenant's signed claim and DERIVES the real tenant from it (spec §9). Absent → the pod
   * runs on prefix/network isolation alone and the wire `tenant` is trusted verbatim (aviary-compatible);
   * present → an invalid/tampered/absent token is REJECTED with an `unauthorized` error reply, and the
   * body's tenant claim is discarded in favour of the verified one.
   */
  verifyTenant?: TenantVerifier | undefined;
  /**
   * The engine's GLOBAL lifecycle-event source (typically `engine.subscribe`). The responder
   * re-publishes each event, scoped by the run's namespace, as a {@link TenantEvent} so a store-less
   * tenant can live-tail its OWN runs. Omit to disable tenant-events republishing (e.g. a control plane
   * that only answers read/control, with live-tail served elsewhere).
   */
  subscribeEngineEvents?: ((listener: (event: EngineEvent) => void) => () => void) | undefined;
  /**
   * Warn at construction when no {@link verifyTenant} is set. Default `true`. The durable provider
   * passes `false` for a `standalone` engine: there the responder only answers tenant pods if you run
   * some, and anyone with broker access can already enqueue steps and results, so the warning was
   * noise on every boot of an app that never uses tenants. An explicit `topology: 'control-plane'` keeps it.
   */
  warnWithoutVerifier?: boolean | undefined;
}

/** `EngineEvent` types that END a run's lifecycle — no further event for that `runId` follows, so it is
 *  the safe point to drop the run from the namespace cache. Cancellation + dead-lettering are both
 *  emitted as `run.failed`; `run.suspended` is NOT terminal (a suspended run resumes). */
function isTerminalRunEvent(event: EngineEvent): boolean {
  return event.type === 'run.completed' || event.type === 'run.failed';
}

/**
 * Operator-side consumer of a store-less tenant's P4 traffic — the TRUST BOUNDARY of the tenant run
 * gateway (spec §8/§9). It answers each {@link RunRequest}/{@link StartRunMessage} against a
 * store-backed {@link RunGateway} (typically `StoreRunGateway`), and re-publishes the engine's
 * lifecycle events to each tenant's channel.
 *
 * Enforcement, per request, BEFORE any run is touched:
 * 1. **Authenticate + derive tenant.** With a {@link RunRequestResponderOptions.verifyTenant}, the
 *    signed token (carried in the wire `tenant` field) is verified and the real tenant is DERIVED from
 *    it; the body's claim is ignored. An invalid token short-circuits to an `unauthorized` reply.
 * 2. **`listRuns`, `runFacets` and `runValueFacets` are namespace-forced** to the derived tenant —
 *    the client's `namespace` is discarded, never merely validated, so a tenant cannot enumerate (or
 *    count, or read the tag vocabulary of) another's runs. **`waitingFor`** answers only the ids the
 *    tenant owns.
 * 3. **`workerHealth` is group-scoped** to the tenant's own `@<tenant>` queues.
 * 4. **Every runId-bearing verb** (`getRun`/`getCheckpoints`/`getRunDetail`/`getFanMembers`/
 *    `getSearchAttributes`/`signal`/`cancel`/`redispatch`/`retry`/`continue`/`retryWithInput`, and
 *    `republishLifecycle` of one run) loads the run alone FIRST — never its timeline — and rejects
 *    with `cross-tenant` when `run.namespace` isn't the derived tenant —
 *    anti-IDOR, so a tenant can never read OR act on another tenant's run. A `republishLifecycle`
 *    of a workflow's runs is forced to the tenant's namespace, like `listRuns`.
 *    `workflowLifecycle`, and the lifecycle links of `getRunDetail`, list only the subscriptions of
 *    the tenant's namespace.
 * 5. **`start` forces the run's namespace** to the derived tenant, so a started run is owned by, and
 *    later only reachable by, that tenant.
 * 6. **Unknown verbs are rejected** rather than silently ignored, with the
 *    {@link UNSUPPORTED_RUN_REQUEST} code and before the gateway is touched.
 *
 * Every request gets a reply: a gateway (or verifier) that throws becomes an error reply, because a
 * request left unanswered makes the tenant wait out its whole timeout.
 *
 * Do not weaken any of these — they are the isolation guarantee of the store-less cluster.
 */
/**
 * `detail` with its links to other runs kept to `tenant`'s namespace: `awaitedBy` without the
 * waiting runs of other namespaces, and what was read of a `triggeredBy`, `waitsFor` or started
 * `lifecycleDeliveries` run (its status, namespace and trace id) only when that run is the tenant's.
 */
function scopeRunLinks(detail: RunDetail, tenant: string): RunDetail {
  const own = (link: { namespace?: string | undefined }) => link.namespace === tenant;
  const bare = <T extends { status?: unknown; namespace?: string | undefined }>(link: T): T => {
    if (own(link)) return link;
    const { status: _status, namespace: _namespace, ...rest } = link;
    return rest as T;
  };
  const awaitedBy = detail.awaitedBy?.filter(own);
  const { awaitedBy: _awaitedBy, ...rest } = detail;
  const source = detail.triggeredBy;
  return {
    ...rest,
    ...(source
      ? { triggeredBy: own(source) ? source : { runId: source.runId, kind: source.kind } }
      : {}),
    ...(awaitedBy && awaitedBy.length > 0 ? { awaitedBy } : {}),
    ...(detail.waitsFor ? { waitsFor: detail.waitsFor.map(bare) } : {}),
    ...(detail.lifecycleDeliveries
      ? { lifecycleDeliveries: detail.lifecycleDeliveries.map(bare) }
      : {}),
  };
}

export class RunRequestResponder {
  readonly #transport: ResponderTransport;
  readonly #gateway: RunGateway;
  readonly #verifyTenant: TenantVerifier | undefined;
  readonly #subscribeEngineEvents:
    | ((listener: (event: EngineEvent) => void) => () => void)
    | undefined;

  // Per-run namespace memo for tenant-events republishing: read the store at most once per run id (a
  // `step.*` event carries no namespace), dropped on the run's terminal event so it stays bounded to
  // in-flight runs. `null` = "resolved, not a tenant" (distinct from absent = "not yet resolved").
  readonly #runNamespaces = new Map<string, string | null>();
  #unsubscribeEvents: (() => void) | undefined;

  constructor(
    transport: ResponderTransport,
    gateway: RunGateway,
    options: RunRequestResponderOptions = {},
  ) {
    this.#transport = transport;
    this.#gateway = gateway;
    this.#verifyTenant = options.verifyTenant;
    if (!this.#verifyTenant && options.warnWithoutVerifier !== false) {
      // Loud on purpose: without a verifier the anti-IDOR machinery below is bypassable by simply
      // CLAIMING another tenant's name in the wire `tenant` field — any process with broker access
      // can then list/signal/cancel/start runs as any tenant. Prefix/network isolation may be an
      // acceptable posture (it is the aviary-compatible default), but it must be a CHOSEN one.
      console.warn(
        '[adonis-durable] run-request responder started WITHOUT a tenant verifier: the wire ' +
          '`tenant` claim is trusted verbatim (prefix/network isolation only). Any broker client ' +
          'can act as any tenant. Configure `verifyTenant` (e.g. hmacTenantVerifier(secret)) and ' +
          'signed tenant tokens unless your broker is fully isolated per tenant.',
      );
    }
    this.#subscribeEngineEvents = options.subscribeEngineEvents;
  }

  /**
   * Register the consumers on the transport (idempotent per transport). Each request is answered
   * independently; a handler failure never throws back into the transport — every error is captured
   * into an error reply. If an engine-event source was given, starts re-publishing tenant events.
   */
  start(): void {
    this.#transport.onRunRequest(async (msg) => {
      let answer: RunReply;
      try {
        answer = await this.#handleRequest(msg);
      } catch (err) {
        // Without a reply the tenant waits out its whole timeout for an answer that never comes.
        answer = reply(msg.requestId, { ok: false, error: { message: errorMessage(err) } });
      }
      await this.#transport.publishRunReply(answer);
    });
    this.#transport.onStartRun(async (msg) => {
      let answer: RunReply | undefined;
      try {
        answer = await this.#handleStart(msg);
      } catch (err) {
        answer =
          msg.runId === undefined
            ? undefined
            : reply(msg.runId, { ok: false, error: { message: errorMessage(err) } });
      }
      if (answer) await this.#transport.publishRunReply(answer);
    });
    if (this.#subscribeEngineEvents) {
      this.#unsubscribeEvents = this.#subscribeEngineEvents((event) => {
        // Best-effort, like the publish itself: a failing run lookup (the store briefly down) must
        // not surface as an unhandled rejection from an event listener.
        void this.#republish(event).catch(() => undefined);
      });
    }
  }

  /** Stop re-publishing tenant events (the transport consumers are torn down with the transport). */
  stop(): void {
    this.#unsubscribeEvents?.();
    this.#unsubscribeEvents = undefined;
    this.#runNamespaces.clear();
  }

  // ---------------------------------------------------------------------------
  // read / control
  // ---------------------------------------------------------------------------

  async #handleRequest(msg: RunRequest): Promise<RunReply> {
    const tenant = await this.#resolveTenant(msg.tenant);
    if (tenant === null) {
      return reply(msg.requestId, {
        ok: false,
        error: { message: 'invalid or unauthorized tenant token', code: 'unauthorized' },
      });
    }

    const { body } = msg;

    if (!KNOWN_KINDS.has(body.kind)) {
      return reply(msg.requestId, {
        ok: false,
        error: {
          message: `the control plane does not support the ${String(body.kind)} run request`,
          code: UNSUPPORTED_RUN_REQUEST,
        },
      });
    }

    try {
      return reply(msg.requestId, { ok: true, data: await this.#answer(body, tenant) });
    } catch (err) {
      if (err instanceof CrossTenantError) {
        return reply(msg.requestId, {
          ok: false,
          error: { message: 'run belongs to another tenant', code: 'cross-tenant' },
        });
      }
      if (err instanceof BadRequestError) {
        return reply(msg.requestId, {
          ok: false,
          error: { message: err.message, code: BAD_REQUEST },
        });
      }
      if (err instanceof GatewayLacksVerbError) {
        return reply(msg.requestId, {
          ok: false,
          error: { message: err.message, code: UNSUPPORTED_RUN_REQUEST },
        });
      }
      return reply(msg.requestId, { ok: false, error: { message: errorMessage(err) } });
    }
  }

  /** Answer a known verb for the verified `tenant`. A run of another tenant throws
   *  {@link CrossTenantError} before the verb runs. */
  async #answer(body: RunRequestKind, tenant: string): Promise<unknown> {
    if (body.kind === 'listRuns') {
      // Force the namespace to the verified tenant — the client value is DISCARDED, never validated, so
      // a tenant can't widen its own query into another's namespace.
      return this.#gateway.listRuns({ ...body.query, namespace: tenant });
    }

    if (body.kind === 'workerHealth') {
      // Not runId-bearing. Scope by the group-name convention instead: a tenant's queues are suffixed
      // `<name>@<tenant>`, so keep only groups ending in `@<tenant>` — the operator's own bare groups
      // and every other tenant's are dropped.
      const all = await this.#gateway.workerHealth();
      return all.filter((h) => h.group.endsWith(`@${tenant}`));
    }

    if (body.kind === 'runFacets') {
      // Forced to the tenant exactly like `listRuns`: the counts label the tenant's own list.
      const scoped = { ...body.query, namespace: tenant };
      if (this.#gateway.runFacets) return this.#gateway.runFacets(scoped);
      const facets = this.#gateway.runValueFacets;
      if (!facets) throw new GatewayLacksVerbError(body.kind);
      return runFacetsOf(
        { runValueFacets: (axis, q, opts) => facets.call(this.#gateway, axis, q, opts) },
        scoped,
      );
    }

    if (body.kind === 'runValueFacets') {
      // Forced too: enumerating values over other tenants' runs would leak their tag and attribute
      // vocabulary, and offer picks this tenant's list can never match.
      if (!this.#gateway.runValueFacets) throw new GatewayLacksVerbError(body.kind);
      return this.#gateway.runValueFacets(
        body.axis,
        { ...body.query, namespace: tenant },
        body.opts,
      );
    }

    if (body.kind === 'waitingFor') {
      // Bulk and caller-chosen ids, which could probe another tenant's runs: keep only the matches
      // the tenant owns, checked per MATCHED entry (bounded by how many ids are actually waiting).
      if (!this.#gateway.waitingFor) throw new GatewayLacksVerbError(body.kind);
      const all = await this.#gateway.waitingFor(body.runIds);
      const owned: Record<string, RunWaiting> = {};
      await Promise.all(
        Object.entries(all).map(async ([runId, waiting]) => {
          const owner = await this.#gateway.getRun(runId);
          if (owner && owner.namespace === tenant) owned[runId] = waiting;
        }),
      );
      return owned;
    }

    if (body.kind === 'workflowLifecycle') {
      if (!this.#gateway.workflowLifecycle) throw new GatewayLacksVerbError(body.kind);
      if (typeof body.workflow !== 'string' || body.workflow.length === 0) {
        throw new Error('workflowLifecycle needs a workflow name');
      }
      // Only the subscriptions of the tenant's namespace: another tenant's are not its to see.
      return this.#gateway.workflowLifecycle(body.workflow, { namespace: tenant });
    }

    if (body.kind === 'republishLifecycle') {
      if (!this.#gateway.republishLifecycle) throw new GatewayLacksVerbError(body.kind);
      const target = republishTargetOf(body.target);
      if ('runId' in target) {
        // Ownership first, like every runId-bearing verb: another tenant's run is never republished.
        const run = await this.#gateway.getRun(target.runId);
        if (run && run.namespace !== tenant) throw new CrossTenantError();
        if (run && target.subscriber !== undefined) {
          const kind = lifecycleKindOf(run.status);
          await this.#assertSubscribes(run.workflow, kind, target.subscriber, tenant);
        }
        return this.#gateway.republishLifecycle(target);
      }
      if (target.subscriber !== undefined) {
        await this.#assertSubscribes(target.workflow, target.kind, target.subscriber, tenant);
      }
      // A workflow's runs: forced to the tenant's namespace, never a body claim.
      return this.#gateway.republishLifecycle({ ...target, namespace: tenant });
    }

    // Every remaining verb is runId-bearing. Load the run FIRST — before calling the verb — so a
    // cross-tenant request never reaches the gateway's mutating methods (signal/cancel/redispatch/
    // retry/continue/retryWithInput) or leaks another tenant's run via a read
    // (getRun/getCheckpoints/getSearchAttributes).
    const run = await this.#gateway.getRun(body.runId);
    if (run && run.namespace !== tenant) throw new CrossTenantError();
    const answer = await this.#callVerb(body, run);
    if (body.kind === 'getRunDetail' && answer) {
      return this.#scopeLifecycle(answer as RunDetail, tenant);
    }
    return answer;
  }

  /**
   * `detail` with its lifecycle links (`workflowLifecycle`, `lifecycleSubscribers`) narrowed to the
   * subscriptions of `tenant`'s namespace, as the `workflowLifecycle` verb answers them, and its
   * links to other runs kept to `tenant`'s: a run of another namespace waiting on this one is left
   * out, and a linked run of another namespace keeps its id (derived from this run) but not its
   * status.
   */
  async #scopeLifecycle(input: RunDetail, tenant: string): Promise<RunDetail> {
    const detail = scopeRunLinks(input, tenant);
    if (detail.workflowLifecycle === undefined && detail.lifecycleSubscribers === undefined) {
      return detail;
    }
    const { workflowLifecycle: _links, lifecycleSubscribers: _subscribers, ...rest } = detail;
    const links = await this.#gateway.workflowLifecycle?.(detail.run.workflow, {
      namespace: tenant,
    });
    if (!links) return rest;
    const kind = lifecycleKindOf(detail.run.status);
    const subscribers = kind
      ? [...new Set(links.startsOnSettle.filter((l) => l.kind === kind).map((l) => l.workflow))]
      : [];
    const linked = links.startsOnSettle.length > 0 || links.startedBy.length > 0;
    return {
      ...rest,
      ...(subscribers.length > 0 ? { lifecycleSubscribers: subscribers } : {}),
      ...(linked ? { workflowLifecycle: links } : {}),
    };
  }

  /** Dispatch a runId-bearing verb. `run` is the already-loaded run (ownership-checked by the caller) —
   *  reused for `getRun` so it isn't fetched twice. An unknown verb is rejected, never silently dropped. */
  #callVerb(
    body: Exclude<RunRequestKind, UnscopedKind>,
    run: WorkflowRun | null,
  ): Promise<unknown> {
    switch (body.kind) {
      case 'retry':
        if (!this.#gateway.retry) throw new GatewayLacksVerbError(body.kind);
        return this.#gateway.retry(body.runId);
      case 'continue':
        if (!this.#gateway.continue) throw new GatewayLacksVerbError(body.kind);
        return this.#gateway.continue(body.runId);
      case 'retryWithInput':
        if (!this.#gateway.retryWithInput) throw new GatewayLacksVerbError(body.kind);
        return this.#gateway.retryWithInput(body.runId, body.input);
      case 'getRun':
        return Promise.resolve(run);
      case 'getCheckpoints':
        return this.#gateway.getCheckpoints(body.runId);
      case 'getRunChildren':
        return this.#gateway.getRunChildren(body.runId);
      case 'getRunDetail':
        return this.#gateway.getRunDetail
          ? this.#gateway.getRunDetail(body.runId, body.options)
          : loadRunDetail(this.#detailSource(run), body.runId, body.options);
      case 'getFanMembers':
        if (!run) return Promise.resolve(null);
        return this.#gateway.getFanMembers
          ? this.#gateway.getFanMembers(body.runId, body.group, body.query)
          : loadFanMembers(this.#detailSource(run), body.runId, body.group, body.query);
      case 'getSearchAttributes':
        return this.#gateway.getSearchAttributes(body.runId);
      case 'signal':
        return this.#gateway.signal(body.runId, body.signal, body.payload);
      case 'cancel':
        return this.#gateway.cancel(body.runId, body.opts);
      case 'redispatch':
        return this.#gateway.redispatchPending(body.runId);
      default:
        // Exhaustiveness guard: an unrecognised verb (a newer/incompatible client) is rejected loudly.
        return Promise.reject(
          new Error(`unknown run-request verb: ${(body as { kind: string }).kind}`),
        );
    }
  }

  /** The gateway's reads as a {@link RunDetailSource}, reusing the run the ownership check loaded. */
  #detailSource(run: WorkflowRun | null): RunDetailSource {
    return {
      getRun: () => Promise.resolve(run),
      listCheckpoints: (runId) => this.#gateway.getCheckpoints(runId),
      getRunChildren: (runId) => this.#gateway.getRunChildren(runId),
    };
  }

  // ---------------------------------------------------------------------------
  // start-run
  // ---------------------------------------------------------------------------

  /**
   * Answer a start-run. The reply is correlated by the message's `runId` (the proxy mints/forwards one
   * so the fire-and-forget aviary `StartRunMessage` can carry a correlated answer). The run's namespace
   * is FORCED to the verified tenant, so the started run is owned by that tenant and later reachable
   * only by it. Returns `undefined` (no reply) only when there is no id to correlate on.
   */
  async #handleStart(msg: StartRunMessage): Promise<RunReply | undefined> {
    const correlationId = msg.runId;
    const tenant = await this.#resolveTenant(msg.tenant);
    if (tenant === null) {
      return correlationId === undefined
        ? undefined
        : reply(correlationId, {
            ok: false,
            error: { message: 'invalid or unauthorized tenant token', code: 'unauthorized' },
          });
    }

    try {
      const result = await this.#gateway.start(msg.workflow, msg.input, {
        ...(msg.runId !== undefined ? { runId: msg.runId } : {}),
        ...(msg.tags !== undefined ? { tags: msg.tags } : {}),
        ...(msg.searchAttributes !== undefined ? { searchAttributes: msg.searchAttributes } : {}),
        // Force the run's namespace to the verified tenant — never a body claim (anti-IDOR at the root).
        namespace: tenant,
      });
      return reply(correlationId ?? result.runId, { ok: true, data: result });
    } catch (err) {
      return correlationId === undefined
        ? undefined
        : reply(correlationId, {
            ok: false,
            error: { message: err instanceof Error ? err.message : String(err) },
          });
    }
  }

  // ---------------------------------------------------------------------------
  // tenant-events republishing
  // ---------------------------------------------------------------------------

  async #republish(event: EngineEvent): Promise<void> {
    const namespace = await this.#namespaceFor(event);
    // A terminal run emits no further events — drop its cache entry now regardless of whether this event
    // was itself re-published, so the slot is reclaimed even for a bare/default run.
    if (isTerminalRunEvent(event)) this.#runNamespaces.delete(event.runId);
    // Skip bare/default runs — no real tenant to re-publish to.
    if (!namespace || namespace === 'default') return;
    await this.#transport.publishTenantEvent({ tenant: namespace, event }).catch(() => undefined);
  }

  async #namespaceFor(event: EngineEvent): Promise<string | undefined> {
    if (this.#runNamespaces.has(event.runId)) {
      const cached = this.#runNamespaces.get(event.runId);
      return cached === null ? undefined : cached;
    }
    if (event.namespace !== undefined) {
      this.#runNamespaces.set(event.runId, event.namespace === 'default' ? null : event.namespace);
      return event.namespace === 'default' ? undefined : event.namespace;
    }
    const run = await this.#gateway.getRun(event.runId);
    const ns = run?.namespace !== undefined && run.namespace !== 'default' ? run.namespace : null;
    this.#runNamespaces.set(event.runId, ns);
    return ns === null ? undefined : ns;
  }

  // ---------------------------------------------------------------------------
  // trust boundary
  // ---------------------------------------------------------------------------

  /**
   * Resolve the tenant a request is ALLOWED to act as. With a verifier, the wire `tenant` is treated as
   * the signed token: it is verified and the real tenant DERIVED from it (`null` on reject). Without a
   * verifier, the wire value is trusted verbatim (prefix/network isolation only, aviary-compatible).
   */
  /**
   * Refuse ({@link BadRequestError}) a republish naming a `subscriber` that does not subscribe to
   * `workflow`'s lifecycle event (`kind`, or either when undefined) in `tenant`'s namespace, so a
   * tenant can only owe a run's event to one of its own subscribers.
   */
  async #assertSubscribes(
    workflow: string,
    kind: LifecycleKind | undefined,
    subscriber: string,
    tenant: string,
  ): Promise<void> {
    if (!this.#gateway.workflowLifecycle) throw new GatewayLacksVerbError('workflowLifecycle');
    const links = await this.#gateway.workflowLifecycle(workflow, { namespace: tenant });
    const subscribes = links.startsOnSettle.some(
      (link) => link.workflow === subscriber && (kind === undefined || link.kind === kind),
    );
    if (!subscribes) {
      const event = kind
        ? lifecycleEventName(workflow, kind)
        : `the lifecycle events of ${workflow}`;
      throw new BadRequestError(`subscriber ${subscriber} does not subscribe to ${event}`);
    }
  }

  async #resolveTenant(wireTenant: string): Promise<string | null> {
    if (!this.#verifyTenant) return wireTenant;
    const verified = await this.#verifyTenant({ token: wireTenant, tenant: wireTenant });
    return verified ? verified.tenant : null;
  }
}

/** A runId-bearing request addressed a run of another tenant. */
class CrossTenantError extends Error {}

/** A request that is malformed or asks for something the tenant may not do; replied as `bad-request`. */
class BadRequestError extends Error {}

/** The control plane's gateway does not implement an optional verb (a hand-written gateway). */
class GatewayLacksVerbError extends Error {
  constructor(kind: string) {
    super(`the control plane does not support the ${kind} run request`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build a correlated {@link RunReply}. */
function reply(requestId: string, result: RunReplyResult): RunReply {
  return { requestId, result };
}
