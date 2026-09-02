import type { AdmissionBackend } from './admission.js';
import type {
  AdmissionContext,
  AdmissionFactory,
  RedisAdmissionConfig,
} from './admissions/factory.js';
import { admissions } from './admissions/factory.js';
import type {
  ControlPlaneConfig,
  StandaloneConfig,
  TenantConfig,
  TenantVerifier,
  VerifiedTenant,
} from './config_types.js';
import type {
  ControlPlaneContext,
  ControlPlaneFactory,
  RedisControlPlaneConfig,
} from './control-planes/factory.js';
import { controlPlanes } from './control-planes/factory.js';
import type { ControlPlane, RunDispatcher } from './interfaces.js';
import type { ScheduledWorkflow } from './scheduler.js';
import type { LucidStoreConfig, StoreContext, StoreFactory } from './stores/factory.js';
import { stores } from './stores/factory.js';
import type {
  DbTransportConfig,
  EventEmitterTransportConfig,
  MemoryTransportConfig,
  QueueTransportConfig,
  TransportContext,
  TransportFactory,
} from './transports/factory.js';
import { transports } from './transports/factory.js';

/**
 * The **shared** fields of `config/durable.ts`, common to every {@link DurableConfig} role. Everything
 * here is optional — by default the engine uses an in-process
 * state store + transport (single-process, no extra infra). Pick a `transport`/`store` by name from
 * the `transports`/`stores` maps to run cross-process or persist durably; build the entries with the
 * {@link transports} / {@link stores} factories so each peer dependency (`@adonisjs/queue`,
 * `@adonisjs/lucid`) is imported lazily, only when that driver is actually selected.
 *
 * ```ts
 * import { defineConfig, transports, stores } from '@adonis-agora/durable'
 * import { redis } from '@adonisjs/queue'
 *
 * export default defineConfig({
 *   transport: 'queue',
 *   transports: {
 *     // production single-process, no external infra:
 *     'event-emitter': transports.eventEmitter(),
 *     queue: transports.queue({ adapter: redis({ host: '127.0.0.1' }), group: 'durable' }),
 *     db: transports.db({ connection: 'pg' }),
 *   },
 *   store: 'lucid',
 *   stores: {
 *     lucid: stores.lucid({ connection: 'pg' }),
 *   },
 * })
 * ```
 */
/**
 * Opt-in embedded worker loop — see {@link BaseDurableConfig.worker}. A dedicated `durable:work` pod
 * stays the right shape for a fleet that scales workers independently of web traffic; this is for the
 * app whose background work does not justify a second container.
 */
export interface EmbeddedWorkerConfig {
  /** Start the worker loop in this process (web environment only). Default `false`. */
  embedded?: boolean;
  /** Poll interval in ms between ticks. Default 1000 — the same default as `durable:work`. */
  intervalMs?: number;
  /** Drain timeout in ms applied on shutdown, passed to `engine.drain`. Default 10_000. */
  drainTimeoutMs?: number;
}

export interface BaseDurableConfig {
  /**
   * Which topology this engine runs as (spec §3): `'standalone'` (default — control-plane + embedded
   * worker), `'control-plane'` (pure coordinator), or `'tenant'` (store-less thin pod). Selected
   * explicitly, never inferred. Omit it and {@link defineConfig} defaults to `'standalone'`, so a
   * config written before roles existed behaves identically. The concrete per-role shape is a member
   * of the {@link DurableConfig} union; this base only declares the discriminant for shared reads.
   */
  role?: 'standalone' | 'control-plane' | 'tenant';
  /**
   * Name of the transport (a key of {@link transports}) the engine dispatches over. Omit for the
   * in-process transport (single-process, no extra infra).
   */
  transport?: string;
  /** Named transports, built with the {@link transports} factory. */
  transports?: Record<string, TransportFactory>;
  /**
   * Name of the state store (a key of {@link stores}) for runs/checkpoints/timers. Omit for the
   * in-memory store (single-process).
   */
  store?: string;
  /** Named state stores, built with the {@link stores} factory. */
  stores?: Record<string, StoreFactory>;
  /**
   * Whether the provider provisions the selected store's schema at boot by calling its
   * `ensureSchema()` (idempotent `CREATE TABLE IF NOT EXISTS`). Default `true` — the lib manages its
   * own tables, matching the rest of the ecosystem (agent/authz/telescope). Set `false` to manage the
   * schema yourself via a migration (`createDurableTables(db, connection)`) — e.g. when the app's DB
   * user may not run DDL at boot, or you want explicit, reviewed schema changes. The in-memory store
   * has no schema, so this is a no-op for it.
   */
  autoSchema?: boolean;
  /**
   * Cross-instance broadcast for lifecycle events + cancellation. Omit for single-instance. Either a
   * ready {@link ControlPlane} instance, or a {@link ControlPlaneFactory} built with the
   * {@link controlPlanes} factory (e.g. `controlPlanes.redis({ connection: 'main' })`) so the peer
   * dependency (`@adonisjs/redis`) is imported lazily, only when selected.
   */
  controlPlane?: ControlPlane | ControlPlaneFactory;
  /**
   * Backend for the remote-step flow-control gate (`ctx.step(name, input, { queue })`). Omit for the
   * in-process default, whose concurrency/rate caps count **per engine instance**. Either a ready
   * {@link AdmissionBackend}, or an {@link AdmissionFactory} built with the {@link admissions} factory
   * (e.g. `admissions.redis({ connection: 'main' })`) so the peer dependency (`@adonisjs/redis`) is
   * imported lazily, only when selected — which makes the caps GLOBAL across every replica.
   */
  admission?: AdmissionBackend | AdmissionFactory;
  /**
   * Build the public callback URL for a `ctx.webhook()` token, e.g.
   * ``(token) => `https://api.example.com/durable/webhooks/${token}` ``. It populates the `url` field
   * of the object `ctx.webhook()` returns, so a step can hand a third party a ready callback address.
   * Omit to leave `url` undefined and build it yourself from the token.
   */
  webhookUrl?: (token: string) => string;
  /**
   * Supply the current W3C `traceparent` to stamp on every dispatched remote task, so a worker (the
   * Python SDK included) continues the same distributed trace. When `@adonis-agora/diagnostics-otel`
   * is installed the provider wires this automatically from the active span — set it here only to
   * override that, or to bridge a tracer durable does not know about. Omit to send none.
   */
  traceparent?: () => string | undefined;
  /**
   * Persist a `running` checkpoint the moment a **local** step's body begins, so an in-flight step is
   * visible in the dashboard and the REST/CLI listings before it finishes — not only once it settles.
   * Default `true`. Set `false` on hot paths with many short local steps to halve their checkpoint
   * writes; the live `step.started` event still fires either way, so you only lose the visibility that
   * survives a page reload.
   */
  trackStepStart?: boolean;
  /** Recovery lease duration in ms. Default 30s. */
  leaseMs?: number;
  /** Unique id for this engine instance. Defaults to a random id. */
  instanceId?: string;
  /**
   * Worker-pool partition for this engine. Stamped on every run it creates; the poll/recovery paths
   * only act on runs in this namespace, and a non-`'default'` namespace also segments the transport's
   * queue names. Default `'default'` — byte-identical to a single-pool deployment. Set distinct values
   * to safely share ONE state store + broker across non-interchangeable pools (e.g. local dev vs a cluster).
   */
  namespace?: string;
  /** Cap crash-recovery pickups before dead-lettering a poison run. Omit for unlimited. */
  maxRecoveryAttempts?: number;
  /** Attempts per saga compensation on run failure. Default 1. */
  compensationRetries?: number;
  /** Where a freshly-started run executes. Defaults to in-process (microtask). */
  runDispatcher?: RunDispatcher;
  /**
   * When this process's transport starts its broker **consumer** loops. `'auto'` (default): a
   * `console`/`repl` process defers consumption — it can dispatch runs and read the store, but never
   * claims broker jobs — because those queues are point-to-point and a one-off `node ace` process
   * that subscribes competes with the real worker fleet: it claims step jobs it dies with, steals
   * results addressed to the long-lived engine, and (with jobs queued) never exits. `durable:work`
   * re-enables consumption for itself via `engine.startConsumers()`, so the worker command behaves
   * identically under either value. `'always'`: every booted process consumes eagerly (the pre-0.17
   * behavior) — for a console script that must round-trip remote steps inline. Web and test
   * processes always consume eagerly; in-process transports (memory/event-emitter) are unaffected.
   */
  consumers?: 'auto' | 'always';
  /**
   * Opt-in self-heal window (ms) for a remote step with no `timeoutMs` whose dispatched job was LOST
   * — the worker crashed mid-step, or the transport dropped the job (a store flush/eviction, or a
   * broker moving a stalled job to `failed`). By design, the reconcile re-drive re-suspends a
   * still-`pending` step rather than re-dispatching it (so a slow-but-live worker is never
   * double-run) — which means a genuinely lost dispatch would otherwise hang forever. When set, a
   * reconcile pass that finds a remote step still `pending` PAST this window re-dispatches it
   * (bounded by {@link BaseDurableConfig.remoteRedispatchMax}). Off by default: re-dispatch can
   * double-run a step whose original job is merely slow, so **this window MUST exceed the longest
   * legitimate run of that step, and the step MUST be idempotent**. Prefer a per-step `timeoutMs`
   * where you can (tighter, heartbeat-aware); this is the store-driven net for no-timeout steps that
   * must survive a lost dispatch. The engine's `redispatchPending(runId)` is the manual counterpart
   * for an operator to re-drive a stuck run by hand.
   */
  remoteRedispatchMs?: number;
  /**
   * Max times {@link BaseDurableConfig.remoteRedispatchMs} re-dispatches one lost remote step before
   * giving up and failing it (`code: 'remote_step_lost'`), so the run fails / dead-letters instead of
   * re-dispatching forever. Default 10. Ignored when `remoteRedispatchMs` is unset.
   */
  remoteRedispatchMax?: number;
  /**
   * Recurring workflows to start on a schedule (fixed interval via `everyMs`, or cron via `cron` +
   * `timezone`). The `durable:work` worker loop fires any due windows on every tick (the 5th phase,
   * after timeouts are swept). `engine.start` is idempotent by each schedule's time-bucket run id, so
   * racing worker instances start every window **exactly once**. Cron schedules need the optional
   * `cron-parser` peer dependency. Omit (or leave empty) to register no schedules.
   *
   * Schedules can also be declared **on the workflow class** via `static schedule` (colocation) — those
   * are discovered by `app/workflows` auto-discovery and merged with this list, and fired identically.
   * On a `key` collision, an entry here **wins** (an explicit config override of the colocated one).
   */
  schedules?: ScheduledWorkflow[];
  /**
   * Run the worker loop **inside this process** instead of a separate `node ace durable:work` pod.
   * The loop is the same one the command drives (pending, recovery, timers, timeouts, schedules), so
   * an app that only needs a cadence — a nightly sync, an hourly cleanup — ships one image and one
   * process rather than a second container idling 24h to fire it.
   *
   * The loop starts in `ready()` and **only in the `web` environment**. That gate is what keeps a
   * console process from silently becoming a worker: without it, `node ace migration:run` would spin
   * up a loop, and `node ace durable:work` would run *two* — the command's and the embedded one — in
   * the same process, double-ticking every phase.
   *
   * Shutdown is wired to the provider, not to `process`: the web environment already turns SIGTERM
   * into `app.terminate()`, which stops the loop, drains in-flight executions, and only then closes
   * the transport and control plane. A deploy hands off exactly as it does for a dedicated worker.
   *
   * Omit for the default: no embedded loop, schedules fire only from `durable:work`.
   */
  worker?: EmbeddedWorkerConfig;
  /**
   * Directory (relative to the app root) the provider scans at boot for workflow classes
   * (`BaseWorkflow` subclasses) to auto-register on the engine — the
   * `app/workflows` convention, mirroring `@adonisjs/queue`'s
   * `app/jobs`. Default `'app/workflows'`. Set `false` to disable discovery entirely (register by
   * hand with `engine.register(...)`). A missing directory is fine — nothing to register.
   */
  workflowsPath?: string | false;
  /**
   * Directory (relative to the app root) the provider scans at boot for `@Step`-decorated classes and
   * `defineStep(...)` handlers to auto-register on the app's transport — the `app/steps` convention,
   * mirroring `app/workflows`. Each discovered handler is served by name so `ctx.step('name', input)`
   * (or a typed ref) routes to it with zero manual `transport.handle(...)`. Default `'app/steps'`. Set
   * `false` to disable (register by hand). A missing directory is fine — nothing to register.
   */
  stepsPath?: string | false;
}

/**
 * Shape of `config/durable.ts` — a **role-discriminated union** (spec §5). TypeScript narrows the
 * accepted config on the `role` literal, so each topology gets exactly the right fields and an
 * invalid combination is a compile error. The headline invariant: a `tenant` config may not name a
 * store (`store?: never` on {@link TenantConfig}), making store-less isolation a compile-time fact.
 * A config with no `role` lands on {@link StandaloneConfig} — the default — preserving the
 * pre-roles config byte-for-byte.
 */
export type DurableConfig = StandaloneConfig | ControlPlaneConfig | TenantConfig;

/**
 * Identity helper giving `config/durable.ts` full type-checking. Overloaded so the return type
 * **narrows on `role`**: pass a `tenant` config and you get a {@link TenantConfig} back, etc. The
 * `role` is defaulted to `'standalone'` at runtime, so a config that omits it (every config written
 * before roles existed) still boots as the single-process standalone engine.
 */
export function defineConfig(config: TenantConfig): TenantConfig;
export function defineConfig(config: ControlPlaneConfig): ControlPlaneConfig;
export function defineConfig(config?: StandaloneConfig): StandaloneConfig;
export function defineConfig(config: DurableConfig = { role: 'standalone' }): DurableConfig {
  // Default the discriminant so downstream (provider, gateway) can branch on a always-present `role`
  // without re-deriving it. `...config` wins, so an explicit role is preserved.
  return { role: 'standalone', ...config } as DurableConfig;
}

export type {
  AdmissionContext,
  AdmissionFactory,
  ControlPlaneConfig,
  ControlPlaneContext,
  ControlPlaneFactory,
  DbTransportConfig,
  EventEmitterTransportConfig,
  LucidStoreConfig,
  MemoryTransportConfig,
  QueueTransportConfig,
  RedisAdmissionConfig,
  RedisControlPlaneConfig,
  StandaloneConfig,
  StoreContext,
  StoreFactory,
  TenantConfig,
  TenantVerifier,
  TransportContext,
  TransportFactory,
  VerifiedTenant,
};
export { admissions, controlPlanes, stores, transports };
