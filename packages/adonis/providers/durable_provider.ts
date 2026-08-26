import { pathToFileURL } from 'node:url';
import type { ApplicationService } from '@adonisjs/core/types';
import type { AdmissionContext } from '../src/admissions/factory.js';
import type { ControlPlaneConfig, TenantConfig } from '../src/config_types.js';
import type { ControlPlaneContext } from '../src/control-planes/factory.js';
import type { DurableConfig } from '../src/define_config.js';
import { type EmitterLike, attachEventTriggerBridge } from '../src/event-trigger-bridge.js';
import {
  type AdmissionBackend,
  type ControlPlane,
  InMemoryStateStore,
  InMemoryTransport,
  ProxyRunGateway,
  type RunGateway,
  RunRequestResponder,
  type StateStore,
  type StepServer,
  type StepsBarrel,
  type StoreContext,
  StoreRunGateway,
  type Transport,
  type TransportContext,
  WorkflowEngine,
  type WorkflowEngineDeps,
  type WorkflowsBarrel,
  attachDurableDiagnostics,
  registerStepsFromBarrel,
  registerStepsFromDir,
  registerWorkflowsFromBarrel,
  registerWorkflowsFromDir,
} from '../src/index.js';
import {
  DURABLE_RUN_GATEWAY,
  DURABLE_RUN_REQUEST_RESPONDER,
  DURABLE_TRANSPORT,
  DURABLE_WORKER_RUNTIME,
  NOOP_RUN_DISPATCHER,
  descriptorRedisFrom,
  hasProxyCapability,
  hasResponderCapability,
} from '../src/role_bindings.js';
import { setBootedApp } from '../src/services/booted_app.js';
import {
  NoopWorkerRegistry,
  RedisWorkerRegistry,
  type WorkerRegistry,
  WorkerRuntime,
  type WorkerTransport,
} from '../src/worker-runtime/index.js';

/** The read view of `@adonis-agora/context`'s accessor, read structurally from its global slot. */
interface ContextAccessorLike {
  get(): Record<string, unknown> | undefined;
}
const CONTEXT_ACCESSOR = Symbol.for('@agora/context:accessor');

/**
 * Global slot `@adonis-agora/diagnostics-otel` publishes its `otelTraceparent` under: a
 * `() => string | undefined` returning the active OTel span's W3C `traceparent`.
 * Read structurally so durable continues the OpenTelemetry trace on remote steps
 * with zero config when OTel is installed — and no hard dependency when it is not.
 */
const OTEL_TRACEPARENT = Symbol.for('@agora/otel:traceparent');

/** `@adonis-agora/diagnostics`'s emit capability slot (set at that package's module load when installed). */
const DIAGNOSTICS_EMIT = Symbol.for('@agora/diagnostics:emit');

/**
 * Wires `@adonis-agora/durable` into the AdonisJS application, branching on the config's `role` (design
 * §5) so a **store-less cluster** boots per role:
 *
 * - **`standalone`** (default — a config with no `role` lands here, byte-identical to today): the
 *   store-backed {@link WorkflowEngine} + a {@link StoreRunGateway} + the embedded worker (app/steps
 *   served in-process) + the engine's in-process run dispatcher.
 * - **`control-plane`**: the same store-backed engine + `StoreRunGateway`, but a PURE coordinator — no
 *   embedded worker (app/steps are NOT served here) and a no-op run dispatcher (a started run stays
 *   `pending` for the poll loop). When the transport carries the P4 methods, a
 *   {@link RunRequestResponder} is bound + started so tenant pods can round-trip to it.
 * - **`tenant`**: NO store-backed engine and NO store binding (structural isolation, design §5) — a
 *   {@link ProxyRunGateway} (read/control/start over the wire) plus, for a worker pod, a
 *   {@link WorkerRuntime} the `durable:worker` command drives.
 *
 * `services/main` exposes the ACTIVE role's {@link RunGateway} under {@link DURABLE_RUN_GATEWAY}, so
 * app/dashboard code is identical whether or not a store is present.
 *
 * Store roles keep the historical binding, so nothing that resolves the engine directly changes:
 * ```ts
 * const engine = await app.container.make(WorkflowEngine)
 * engine.register('order', '1', async (ctx) => { ... })
 * await engine.start('order', input, runId)
 * ```
 */
export default class DurableProvider {
  #detachDiagnostics: (() => void) | null = null;
  #transport: (Transport & { close?: () => Promise<void> }) | null = null;
  #controlPlane: (ControlPlane & { close?: () => Promise<void> }) | null = null;
  #responder: RunRequestResponder | null = null;
  /** Memoized tenant transport so the ProxyRunGateway + WorkerRuntime share ONE broker connection. */
  #tenantTransportPromise: Promise<Transport & { close?: () => Promise<void> }> | null = null;

  constructor(protected app: ApplicationService) {}

  register() {
    // Hand the booted app to `services/main` so its eager population reads the SAME @adonisjs/core
    // copy bin/server booted, never a pnpm-split non-booted one (see services/booted_app.ts).
    setBootedApp(this.app);
    const config = this.app.config.get<DurableConfig>('durable', {});
    const role = config.role ?? 'standalone';
    if (role === 'tenant') {
      this.#registerTenantRole(config as TenantConfig);
    } else {
      this.#registerStoreRole(config, role);
    }
  }

  // ---------------------------------------------------------------------------
  // store roles — standalone / control-plane
  // ---------------------------------------------------------------------------

  /** Bind the store-backed engine, its {@link StoreRunGateway}, and (P4-capable transports) the
   *  operator-side {@link RunRequestResponder}. Shared by `standalone` and `control-plane`. */
  #registerStoreRole(config: DurableConfig, role: 'standalone' | 'control-plane') {
    // The active RunGateway = the store-backed gateway wrapping the local engine (design §8).
    this.app.container.singleton(DURABLE_RUN_GATEWAY, async () => {
      const engine = await this.app.container.make(WorkflowEngine);
      return new StoreRunGateway(engine, { role });
    });

    // Operator-side responder. Only meaningful when the transport carries the P4 store-less methods
    // (broker transports only); returns `null` otherwise. `boot()` gates on the SAME capability, so this
    // factory is only ever resolved when it can produce a live responder.
    this.app.container.singleton(
      DURABLE_RUN_REQUEST_RESPONDER,
      async (): Promise<RunRequestResponder | null> => {
        const engine = await this.app.container.make(WorkflowEngine);
        const transport = this.#transport;
        if (!hasResponderCapability(transport)) return null;
        const gateway = await this.app.container.make(DURABLE_RUN_GATEWAY);
        const verifyTenant = (config as ControlPlaneConfig).verifyTenant;
        return new RunRequestResponder(transport, gateway, {
          ...(verifyTenant ? { verifyTenant } : {}),
          // Republish the engine's lifecycle events, scoped by namespace, so tenants can live-tail.
          subscribeEngineEvents: (listener) => engine.subscribe(listener),
        });
      },
    );

    // Publish the engine's task transport so the store-agnostic dashboard fleet-health panel can enumerate
    // the LIVE worker fleet off it (design §10). Resolving the engine first guarantees `#transport` is set
    // (the engine factory assigns it). A broker transport carries `listWorkerGroups`/`listWorkerDescriptors`;
    // an in-process one doesn't, so the panel degrades to diagnostics-only — no special-casing needed here.
    this.app.container.singleton(DURABLE_TRANSPORT, async (): Promise<Transport> => {
      await this.app.container.make(WorkflowEngine);
      // Non-null after the engine factory ran; `#resolveTransport` always yields a transport (in-memory
      // default when none is configured).
      return this.#transport as Transport;
    });

    // Register the engine LAST: a naive/legacy container double (see durable_provider.spec) captures a
    // SINGLE factory, overwritten on each singleton() call, so binding WorkflowEngine last keeps
    // make(WorkflowEngine) resolving the engine. The real AdonisJS container is key-aware — order is
    // irrelevant there; this only shields the test double.
    this.#registerEngine(config, role);
  }

  /** Bind the store-backed {@link WorkflowEngine} singleton (today's build), applying the role's run
   *  dispatcher default: `control-plane` gets the no-op dispatcher (pure coordinator); `standalone`
   *  keeps the engine's in-process default (embedded worker). An explicit `config.runDispatcher` wins. */
  #registerEngine(config: DurableConfig, role: 'standalone' | 'control-plane') {
    this.app.container.singleton(WorkflowEngine, async () => {
      const accessor = (globalThis as Record<symbol, unknown>)[CONTEXT_ACCESSOR] as
        | ContextAccessorLike
        | undefined;
      const otelTraceparent = (globalThis as Record<symbol, unknown>)[OTEL_TRACEPARENT] as
        | (() => string | undefined)
        | undefined;

      const ctx: TransportContext & StoreContext & ControlPlaneContext & AdmissionContext = {
        app: this.app,
      };
      const store = await this.#resolveStore(config, ctx);
      const transport = await this.#resolveTransport(config, ctx);
      // Console/REPL processes must not become broker consumers (`consumers: 'auto'`, the default):
      // a one-off `node ace` process that subscribes competes with the worker fleet for point-to-point
      // jobs — it claims steps it dies with, steals results addressed to the real engine, and a boot
      // command with queued jobs never exits (the burst-drain loop keeps feeding it). Deferring keeps
      // such a process a pure producer; `durable:work` re-enables consumption for itself via
      // `engine.startConsumers()`. Web/test processes keep today's eager behavior, as does
      // `consumers: 'always'`. Transports without `deferConsumers` (in-process) are unaffected.
      if ((config.consumers ?? 'auto') === 'auto') {
        // Optional call: naive test doubles of ApplicationService may not carry getEnvironment.
        const environment = this.app.getEnvironment?.();
        if (environment === 'console' || environment === 'repl') transport.deferConsumers?.();
      }
      // Hold the transport so `shutdown()` can release broker workers/connections cleanly.
      this.#transport = transport;
      const controlPlane = await this.#resolveControlPlane(config, ctx);
      // Hold the control plane so `shutdown()` can tear down its subscriber connection cleanly.
      this.#controlPlane = controlPlane;
      const admission = await this.#resolveAdmission(config, ctx);

      const deps: WorkflowEngineDeps = {
        store,
        transport,
        ...(controlPlane ? { controlPlane } : {}),
        ...(config.leaseMs !== undefined ? { leaseMs: config.leaseMs } : {}),
        ...(config.instanceId ? { instanceId: config.instanceId } : {}),
        ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
        ...(config.maxRecoveryAttempts !== undefined
          ? { maxRecoveryAttempts: config.maxRecoveryAttempts }
          : {}),
        ...(config.compensationRetries !== undefined
          ? { compensationRetries: config.compensationRetries }
          : {}),
        // Fleet-wide flow control: the configured admission backend replaces the engine's in-process
        // default, so `{ queue }` caps count across every replica instead of per pod.
        ...(admission ? { admission } : {}),
        // Public callback URL builder for `ctx.webhook()` tokens.
        ...(config.webhookUrl ? { webhookUrl: config.webhookUrl } : {}),
        ...(config.trackStepStart !== undefined ? { trackStepStart: config.trackStepStart } : {}),
        // The store-driven lost-dispatch net (see BaseDurableConfig.remoteRedispatchMs) — off by
        // default, since re-dispatch can double-run a step whose original job is merely slow.
        ...(config.remoteRedispatchMs !== undefined
          ? { remoteRedispatchMs: config.remoteRedispatchMs }
          : {}),
        ...(config.remoteRedispatchMax !== undefined
          ? { remoteRedispatchMax: config.remoteRedispatchMax }
          : {}),
        // Where a freshly-started run executes: explicit config wins; else `control-plane` leaves it
        // pending for the poll loop (no inline execution), and `standalone` uses the engine's in-process
        // default (embedded worker).
        ...(config.runDispatcher
          ? { runDispatcher: config.runDispatcher }
          : role === 'control-plane'
            ? { runDispatcher: NOOP_RUN_DISPATCHER }
            : {}),
        // Best-effort context propagation from @adonis-agora/context (no hard dep): pass the opaque
        // carrier through verbatim. The carrier is producer-owned and shape-opaque; the worker's
        // scope slot round-trips the whole snapshot via Context.run, so no field-picking is needed.
        ...(accessor ? { context: () => accessor.get() } : {}),
        // Trace continuation on dispatched remote tasks. An explicit `config.traceparent` wins;
        // otherwise best-effort from @adonis-agora/diagnostics-otel's global slot (no hard dep).
        ...(config.traceparent
          ? { traceparent: config.traceparent }
          : otelTraceparent
            ? { traceparent: otelTraceparent }
            : {}),
      };

      return new WorkflowEngine(deps);
    });
  }

  // ---------------------------------------------------------------------------
  // tenant role — store-less (no engine, no store binding)
  // ---------------------------------------------------------------------------

  /**
   * Bind the store-less objects for a `tenant` pod (design §5): a {@link ProxyRunGateway} (every
   * read/control/start round-trips over the wire) and a {@link WorkerRuntime} for a worker pod. NO
   * {@link WorkflowEngine} and NO store binding are registered — resolving either throws, which is the
   * container layer of the three-layer structural isolation (type · container · object).
   */
  #registerTenantRole(config: TenantConfig) {
    this.app.container.singleton(DURABLE_RUN_GATEWAY, async () => {
      const transport = await this.#tenantTransport(config);
      if (!hasProxyCapability(transport)) {
        throw new Error(
          `@agora/durable: role 'tenant' needs a transport with the P4 store-less methods (dispatchStartRun/dispatchRunRequest/onRunReply/onTenantEvent); the selected transport ("${config.transport}") does not expose them.`,
        );
      }
      return new ProxyRunGateway(transport, {
        partition: config.partition,
        ...(config.tenant?.token !== undefined ? { token: config.tenant.token } : {}),
        ...(config.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: config.requestTimeoutMs }
          : {}),
      });
    });

    this.app.container.singleton(DURABLE_WORKER_RUNTIME, async () => {
      const transport = await this.#tenantTransport(config);
      if (typeof (transport as Partial<WorkerTransport>).handle !== 'function') {
        throw new Error(
          `@agora/durable: role 'tenant' worker needs a transport that can serve handlers (handle()); the selected transport ("${config.transport}") cannot.`,
        );
      }
      return new WorkerRuntime({
        transport: transport as unknown as WorkerTransport,
        partition: config.partition,
        ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
        ...(config.instanceId !== undefined ? { instanceId: config.instanceId } : {}),
        ...(config.capabilities !== undefined ? { capabilities: config.capabilities } : {}),
        registry: this.#buildWorkerRegistry(transport),
      });
    });
  }

  /**
   * Build the descriptor/heartbeat registry for a tenant worker: a real {@link RedisWorkerRegistry} when
   * the transport can mint a descriptor-Redis client (design §7.2), else the {@link NoopWorkerRegistry}
   * (the descriptor is still built + observable, just not published to the shared Redis).
   */
  #buildWorkerRegistry(transport: Transport): WorkerRegistry {
    const redis = descriptorRedisFrom(transport);
    if (redis) return new RedisWorkerRegistry(redis, { ownsConnection: true });
    // TODO(integrator): expose `createDescriptorRedis()` on the tenant broker transport
    // (e.g. BullMQTransport, keyed off the same connection its queues use) so a real pod advertises its
    // descriptor + heartbeat on the shared Redis instead of falling back to the no-op registry.
    return new NoopWorkerRegistry();
  }

  /** Build the tenant transport ONCE and memoize it, so the ProxyRunGateway and the WorkerRuntime share
   *  one broker connection (and one set of P4 consumers). Held on {@link #transport} for clean shutdown. */
  #tenantTransport(config: TenantConfig): Promise<Transport & { close?: () => Promise<void> }> {
    if (!this.#tenantTransportPromise) {
      this.#tenantTransportPromise = (async () => {
        const transport = await this.#resolveTransport(config, { app: this.app });
        transport.useNamespace?.(config.namespace ?? 'default');
        this.#transport = transport;
        return transport;
      })();
    }
    return this.#tenantTransportPromise;
  }

  // ---------------------------------------------------------------------------
  // boot — auto-registration + responder bring-up (store roles)
  // ---------------------------------------------------------------------------

  /**
   * Auto-register the `app/workflows` convention so users never call `engine.register(...)` by hand
   * (mirrors `@adonisjs/queue`'s `app/jobs`), then serve `app/steps` for the embedded worker
   * (`standalone` only), then bring up the {@link RunRequestResponder} on a P4-capable transport.
   *
   * Prefers the **build-time barrel** generated by the Assembler `init` hook
   * (`@adonis-agora/durable/hooks/workflows` → `.adonisjs/durable/workflows.js`): registering from it
   * avoids any runtime `readdir`. When that barrel is absent it FALLS BACK to the runtime directory scan.
   *
   * A `tenant` pod owns no engine, so boot is a no-op for it (a worker pod registers `app/steps` on the
   * container-bound {@link WorkerRuntime} from the `durable:worker` command instead).
   */
  async boot() {
    const config = this.app.config.get<DurableConfig>('durable', {});
    const role = config.role ?? 'standalone';
    if (role === 'tenant') return;
    if (config.workflowsPath === false) return;
    const engine = await this.app.container.make(WorkflowEngine);

    // Instantiate workflows through the container, so a workflow class gets constructor dependency
    // injection exactly like an `@adonisjs/queue` job. A class with no dependencies is unaffected —
    // the container simply calls `new Ctor()`.
    const workflowFactory = (ctor: { new (): unknown }) => this.app.container.make(ctor);

    const barrel = await this.#loadGeneratedWorkflowsBarrel();
    if (barrel) {
      await registerWorkflowsFromBarrel(engine, barrel, workflowFactory);
    } else {
      // Fallback: no generated barrel — scan the configured directory at runtime.
      const dir = this.app.makePath(config.workflowsPath ?? 'app/workflows');
      await registerWorkflowsFromDir(engine, dir, workflowFactory);
    }

    // Event-triggered workflows (`static on` / `@OnEvent` / `@OnDiagnostic`): bridge the
    // Adonis emitter + the diagnostics bus into the engine. Registered AFTER discovery so
    // every trigger (incl. the engine's `onEvent` subscribers) is in place.
    const triggers = engine.discoveredEventTriggers;
    if (triggers.length > 0) {
      const emitter = await this.#resolveEmitter();
      this.#detachEventTriggers = attachEventTriggerBridge(triggers, {
        engine,
        ...(emitter !== undefined ? { emitter } : {}),
      });
    }

    // Embedded worker: only `standalone` serves step bodies in-process (design §3). A `control-plane` is
    // a pure coordinator — its step bodies run on separate tenant worker pods — so it does NOT serve
    // app/steps.
    if (role === 'standalone') await this.#registerSteps(config);

    await this.#startResponder();
  }

  /** The bridge disposer, released on shutdown so a hot-reload doesn't leak listeners. */
  #detachEventTriggers: (() => void) | undefined;

  /** The AdonisJS app emitter, when resolvable (missing = emitter triggers are inert). */
  async #resolveEmitter(): Promise<EmitterLike | undefined> {
    try {
      return (await this.app.container.make('emitter')) as EmitterLike;
    } catch {
      return undefined;
    }
  }

  /**
   * Bring up the operator-side {@link RunRequestResponder} so tenant pods can round-trip read/control/
   * start to this control plane — but only when the transport actually carries the P4 methods (in-process
   * transports do not). The capability gate here means the responder binding is never resolved on a
   * non-P4 transport, so a legacy container double never sees it.
   */
  async #startResponder() {
    // Idempotent (singleton) — also guarantees the transport exists before the capability probe.
    await this.app.container.make(WorkflowEngine);
    if (!hasResponderCapability(this.#transport)) return;
    const responder = (await this.app.container.make(
      DURABLE_RUN_REQUEST_RESPONDER,
    )) as RunRequestResponder | null;
    if (!responder) return;
    responder.start();
    this.#responder = responder;
  }

  /**
   * Auto-register the `app/steps` convention: every `@Step` class / `defineStep(...)` handler is
   * served BY NAME on the app's transport, so `ctx.step('name', input)` (or a typed ref) routes to it
   * with no manual `transport.handle(...)`. Opt-out with `config.stepsPath = false`. Prefers the
   * build-time barrel (`@adonis-agora/durable/hooks/steps`), falling back to a runtime directory scan.
   * A transport that can't serve handlers (no `handle`) is skipped.
   */
  async #registerSteps(config: DurableConfig) {
    if (config.stepsPath === false) return;
    const server = this.#transport as (Transport & Partial<StepServer>) | null;
    if (!server || typeof server.handle !== 'function') return;
    const barrel = await this.#loadGeneratedStepsBarrel();
    if (barrel) {
      await registerStepsFromBarrel(server as StepServer, barrel);
      return;
    }
    const dir = this.app.makePath(config.stepsPath ?? 'app/steps');
    await registerStepsFromDir(server as StepServer, dir);
  }

  /** Best-effort import of the build-time steps barrel; `null` when absent (fall back to the scan). */
  async #loadGeneratedStepsBarrel(): Promise<StepsBarrel | null> {
    const path = this.app.makePath('.adonisjs/durable/steps.js');
    try {
      const mod = (await import(pathToFileURL(path).href)) as { steps?: StepsBarrel };
      return mod.steps ?? null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Best-effort import of the build-time workflows barrel the Assembler `init` hook generates. Returns
   * the barrel's `workflows` export when present, or `null` when the file doesn't exist (the hook
   * isn't registered) — the signal for `boot()` to fall back to the runtime scan. Only a genuine
   * "module not found" is swallowed; any other import error propagates (a broken generated barrel
   * should surface, not silently degrade).
   */
  async #loadGeneratedWorkflowsBarrel(): Promise<WorkflowsBarrel | null> {
    const path = this.app.makePath('.adonisjs/durable/workflows.js');
    try {
      const mod = (await import(pathToFileURL(path).href)) as { workflows?: WorkflowsBarrel };
      return mod.workflows ?? null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Resolve the configured state store (a key of `config.stores`), or the in-memory default. */
  async #resolveStore(config: DurableConfig, ctx: StoreContext): Promise<StateStore> {
    const name = config.store;
    if (!name) return new InMemoryStateStore();
    const factory = config.stores?.[name];
    if (!factory) {
      throw new Error(
        `@agora/durable: config.store is "${name}", but config.stores.${name} is not defined`,
      );
    }
    const store = await factory(ctx);
    // Autoschema (default on): provision the store's tables at boot. Idempotent
    // (`CREATE TABLE IF NOT EXISTS`); the store resolves its Lucid db from the container's
    // `'lucid.db'` alias, which is available at boot. `autoSchema: false` opts out (manage via a
    // migration with `createDurableTables`). The in-memory store omits `ensureSchema` — the optional
    // call is then a no-op.
    if (config.autoSchema !== false) {
      await store.ensureSchema?.();
    }
    return store;
  }

  /** Resolve the configured transport (a key of `config.transports`), or the in-memory default. */
  async #resolveTransport(config: DurableConfig, ctx: TransportContext): Promise<Transport> {
    const name = config.transport;
    if (!name) return new InMemoryTransport();
    const factory = config.transports?.[name];
    if (!factory) {
      throw new Error(
        `@agora/durable: config.transport is "${name}", but config.transports.${name} is not defined`,
      );
    }
    return factory(ctx);
  }

  /**
   * Resolve the configured admission backend. `config.admission` may be a ready
   * {@link AdmissionBackend} (used as-is) or an {@link AdmissionFactory} thunk (called at boot so its
   * peer dependency loads lazily). Omitted → `null`, and the engine keeps its in-process default.
   */
  async #resolveAdmission(
    config: DurableConfig,
    ctx: AdmissionContext,
  ): Promise<AdmissionBackend | null> {
    const admission = config.admission;
    if (!admission) return null;
    return typeof admission === 'function' ? admission(ctx) : admission;
  }

  /**
   * Resolve the configured control plane. `config.controlPlane` may be a ready {@link ControlPlane}
   * instance (used as-is) or a {@link ControlPlaneFactory} thunk (called at boot so its peer
   * dependency loads lazily). Omitted → no control plane (the engine runs local-only).
   */
  async #resolveControlPlane(
    config: DurableConfig,
    ctx: ControlPlaneContext,
  ): Promise<(ControlPlane & { close?: () => Promise<void> }) | null> {
    const cp = config.controlPlane;
    if (!cp) return null;
    return typeof cp === 'function' ? cp(ctx) : cp;
  }

  /**
   * Once everything is booted, bridge engine lifecycle events onto the `@adonis-agora/diagnostics` bus —
   * but only when diagnostics is actually installed (its emit slot is populated at module load).
   * Gating on the slot avoids eagerly constructing the engine when diagnostics is absent; when it is
   * present, this makes durable runs visible to `onDiagnostic`, Telescope, the relays and OTel with
   * zero config. No hard dependency on `@adonis-agora/diagnostics`. A `tenant` pod owns no engine, so this
   * is a no-op for it.
   */
  async ready() {
    const config = this.app.config.get<DurableConfig>('durable', {});
    if ((config.role ?? 'standalone') === 'tenant') return;
    const emit = (globalThis as Record<symbol, unknown>)[DIAGNOSTICS_EMIT];
    if (typeof emit !== 'function') return;
    const engine = await this.app.container.make(WorkflowEngine);
    this.#detachDiagnostics = attachDurableDiagnostics(engine);
  }

  async shutdown() {
    // Stop republishing tenant events before the transport connections drop.
    this.#responder?.stop();
    this.#responder = null;
    this.#detachDiagnostics?.();
    this.#detachDiagnostics = null;
    this.#detachEventTriggers?.();
    this.#detachEventTriggers = undefined;
    // Release the transport's broker workers / queues / connections so a deploy hands off cleanly.
    await this.#transport?.close?.();
    this.#transport = null;
    this.#tenantTransportPromise = null;
    // Tear down the control plane's subscriber connection (Redis pub/sub) on the way out.
    await this.#controlPlane?.close?.();
    this.#controlPlane = null;
  }
}
