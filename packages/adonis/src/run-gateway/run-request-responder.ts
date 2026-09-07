import type { TenantVerifier } from '../config_types.js';
import type {
  EngineEvent,
  RunReply,
  RunReplyResult,
  RunRequest,
  RunRequestKind,
  StartRunMessage,
  TenantEvent,
  WorkflowRun,
} from '../interfaces.js';
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
 * 2. **`listRuns` is namespace-forced** to the derived tenant — the client's `namespace` is discarded,
 *    never merely validated, so a tenant cannot enumerate another's runs.
 * 3. **`workerHealth` is group-scoped** to the tenant's own `@<tenant>` queues.
 * 4. **Every runId-bearing verb** (`getRun`/`getCheckpoints`/`getSearchAttributes`/`signal`/`cancel`/
 *    `redispatch`) loads the run FIRST and rejects with `cross-tenant` when `run.namespace` isn't the
 *    derived tenant — anti-IDOR, so a tenant can never read OR act on another tenant's run.
 * 5. **`start` forces the run's namespace** to the derived tenant, so a started run is owned by, and
 *    later only reachable by, that tenant.
 * 6. **Unknown verbs are rejected** rather than silently ignored.
 *
 * Do not weaken any of these — they are the isolation guarantee of the store-less cluster.
 */
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
    if (!this.#verifyTenant) {
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
      const reply = await this.#handleRequest(msg);
      await this.#transport.publishRunReply(reply);
    });
    this.#transport.onStartRun(async (msg) => {
      const reply = await this.#handleStart(msg);
      if (reply) await this.#transport.publishRunReply(reply);
    });
    if (this.#subscribeEngineEvents) {
      this.#unsubscribeEvents = this.#subscribeEngineEvents((event) => {
        void this.#republish(event);
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

    if (body.kind === 'listRuns') {
      // Force the namespace to the verified tenant — the client value is DISCARDED, never validated, so
      // a tenant can't widen its own query into another's namespace.
      const data = await this.#gateway.listRuns({ ...body.query, namespace: tenant });
      return reply(msg.requestId, { ok: true, data });
    }

    if (body.kind === 'workerHealth') {
      // Not runId-bearing. Scope by the group-name convention instead: a tenant's queues are suffixed
      // `<name>@<tenant>`, so keep only groups ending in `@<tenant>` — the operator's own bare groups
      // and every other tenant's are dropped.
      const all = await this.#gateway.workerHealth();
      const data = all.filter((h) => h.group.endsWith(`@${tenant}`));
      return reply(msg.requestId, { ok: true, data });
    }

    // Every remaining verb is runId-bearing. Load the run FIRST — before calling the verb — so a
    // cross-tenant request never reaches the gateway's mutating methods (signal/cancel/redispatch) or
    // leaks another tenant's run via a read (getRun/getCheckpoints/getSearchAttributes).
    const run = await this.#gateway.getRun(body.runId);
    if (run && run.namespace !== tenant) {
      return reply(msg.requestId, {
        ok: false,
        error: { message: 'run belongs to another tenant', code: 'cross-tenant' },
      });
    }

    try {
      const data = await this.#callVerb(body, run);
      return reply(msg.requestId, { ok: true, data });
    } catch (err) {
      return reply(msg.requestId, {
        ok: false,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /** Dispatch a runId-bearing verb. `run` is the already-loaded run (ownership-checked by the caller) —
   *  reused for `getRun` so it isn't fetched twice. An unknown verb is rejected, never silently dropped. */
  #callVerb(
    body: Exclude<RunRequestKind, { kind: 'listRuns' } | { kind: 'workerHealth' }>,
    run: WorkflowRun | null,
  ): Promise<unknown> {
    switch (body.kind) {
      case 'getRun':
        return Promise.resolve(run);
      case 'getCheckpoints':
        return this.#gateway.getCheckpoints(body.runId);
      case 'getRunChildren':
        return this.#gateway.getRunChildren(body.runId);
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
  async #resolveTenant(wireTenant: string): Promise<string | null> {
    if (!this.#verifyTenant) return wireTenant;
    const verified = await this.#verifyTenant({ token: wireTenant, tenant: wireTenant });
    return verified ? verified.tenant : null;
  }
}

/** Build a correlated {@link RunReply}. */
function reply(requestId: string, result: RunReplyResult): RunReply {
  return { requestId, result };
}
