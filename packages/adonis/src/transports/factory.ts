import type { Database } from '@adonisjs/lucid/database';
import type { AdapterFactory } from '@adonisjs/queue/types';
import type { ControlPlane, Transport } from '../interfaces.js';
import { resolveLucidDatabase } from '../resolve-lucid-db.js';
import { InMemoryTransport } from '../testing/in-memory-transport.js';

/**
 * The minimal application surface a {@link TransportFactory} thunk needs at boot to resolve an
 * optional peer's service (the Lucid `db`, the queue adapter, etc.). The durable provider passes the
 * booted `ApplicationService`, which satisfies this structurally — typed here so core stays free of a
 * hard `@adonisjs/core` dependency.
 */
export interface TransportContext {
  /** The booted application — used to resolve services/connections from the container. */
  app: {
    container: { make(service: unknown): Promise<unknown> };
    config: { get<T>(key: string, defaultValue?: T): T };
  };
}

/**
 * A configured transport: a thunk the durable provider calls at boot to build the {@link Transport}
 * (often also a {@link ControlPlane}). Each factory lazily imports its peer dependency
 * (`@adonisjs/queue`, `@adonisjs/lucid`) inside the thunk, so the driver is only loaded when it is
 * actually selected — keeping those packages optional.
 */
export type TransportFactory = (
  ctx: TransportContext,
) => Promise<Transport & Partial<ControlPlane>>;

/** Options for the in-memory (test-only) transport (no peer dependency). */
export interface MemoryTransportConfig {
  /* no options — in-process transport */
}

/** Options for the production in-process EventEmitter transport (no peer dependency). */
export interface EventEmitterTransportConfig {
  /**
   * The worker group this instance serves. Accepted for parity with the broker transports; handlers
   * are matched by step name in-process, so it does not affect routing.
   */
  group?: string;
  /** Stable id for this process (stamped on control `from` when a publisher leaves it unset). Default random. */
  instanceId?: string;
}

/** Options for the `@adonisjs/queue` transport. */
export interface QueueTransportConfig {
  /**
   * Name of the `@adonisjs/queue` connection — a key of the `adapters` map in `config/queue.ts` —
   * whose adapter this transport reads/writes. Omit to use that file's `default` connection. You
   * configure the driver and its host/credentials once in `config/queue.ts`; durable just references
   * it by name, exactly like `stores.lucid({ connection })` or `stores.redis({ connection })`.
   */
  connection?: string;
  /**
   * Escape hatch: pass a raw `@adonisjs/queue` adapter factory directly (e.g. `redis(...)`) instead of
   * resolving one from `config/queue.ts`. For non-Adonis setups or a bespoke adapter. Takes
   * precedence over `connection`.
   */
  adapter?: AdapterFactory;
  /**
   * @deprecated Steps route BY HANDLER NAME, so this instance serves whatever names it registers.
   * Accepted for back-compat and otherwise ignored. Use {@link partition} for isolation.
   */
  group?: string;
  /**
   * Isolation partition suffixing every per-handler task queue this worker subscribes to
   * (`<name>@<partition>`), matched against the `partition` a dispatch carries — so one backend can
   * host several worker pools serving the same handler name without their tasks crossing. Unset (or
   * `'default'`) subscribes to the bare handler-name queue.
   */
  partition?: string;
  /**
   * Logical deployment namespace folded into every queue name, so one backend can host several
   * worker-pool namespaces without their tasks/results crossing. `'default'` (and absent) keeps queue
   * names byte-identical to the un-namespaced scheme. Setting it here is explicit and wins over the
   * engine's propagation of `config.namespace`.
   */
  namespace?: string;
  /** Queue-name prefix so several apps can share one backend without colliding. Default `durable`. */
  prefix?: string;
  /** Poll interval (ms) for the result/task/heartbeat/control loops. Default 200ms. */
  pollIntervalMs?: number;
  /**
   * How often (ms) the stalled-job reclaim sweep runs. On by default (30s); set `0` to disable it.
   * A coarse background check, not run on every poll tick.
   */
  stalledCheckIntervalMs?: number;
  /**
   * How old (ms) a claim must be before the reclaim sweep presumes its worker dead and re-delivers the
   * job. Default 30min — deliberately generous, because the claim is never renewed while the worker
   * processes: raise it above your longest step, or a slow step gets double-run.
   */
  stalledThresholdMs?: number;
  /**
   * How many times one job may be reclaimed before the adapter fails it permanently instead of
   * re-delivering — the bound on a poison job. Default 3.
   */
  maxStalledCount?: number;
  /** Stable id for this process (stamped on heartbeats / control `from`). Default a random id. */
  instanceId?: string;
  /**
   * Where a poll-loop failure is reported — a job whose handler threw, or a throwing tick. Default
   * `console.error`. Point it at your app's logger to route transport failures into your logs.
   */
  onError?: (err: unknown) => void;
}

/** Options for the aviary-compatible BullMQ transport (the cross-ecosystem interop path). */
export interface BullMQTransportConfig {
  /**
   * ioredis connection — `ConnectionOptions` (host/port/…) or a `Redis` instance — handed straight to
   * BullMQ and ioredis. Required: this transport talks to a real Redis (that is the whole point of the
   * cross-language path). Typed loosely (`unknown`) so the `bullmq`/`ioredis` types are not pulled into
   * the config surface of a fleet that never selects this transport.
   */
  connection: unknown;
  /**
   * Logical isolation partition suffixing every per-handler tasks queue this instance subscribes to.
   * Unset routes each handler to the bare (sanitized) handler name.
   */
  partition?: string;
  /** Key prefix namespacing the durable queues. Default `durable`. */
  prefix?: string;
  /** Logical deployment namespace, segmenting every queue/channel/key. `"default"`/absent = unchanged. */
  namespace?: string;
  /** How many tasks a worker runs concurrently from each of its queues (BullMQ `Worker` concurrency). Default 1. */
  concurrency?: number;
  /** Stable id for this process (stamped on the worker-liveness keys). Default `ts-<host>-<pid>`. */
  instanceId?: string;
}

/** Options for the DB-table-backed (`@adonisjs/lucid`) transport. */
export interface DbTransportConfig {
  /**
   * @deprecated Steps route BY HANDLER NAME, so this instance serves whatever names it registers.
   * Accepted for back-compat and otherwise ignored. Use {@link partition} for isolation.
   */
  group?: string;
  /**
   * Isolation partition suffixing every per-handler routing token this worker claims
   * (`<name>@<partition>`), matched against the `partition` a dispatch carries. Unset (or `'default'`)
   * claims the bare handler-name tokens.
   */
  partition?: string;
  /**
   * Logical deployment namespace stamped on every row this instance writes and required on every row
   * it claims, so one set of tables can host several worker-pool namespaces without their
   * tasks/results crossing. `'default'` (and absent) stamps `'default'`. Setting it here is explicit
   * and wins over the engine's propagation of `config.namespace`.
   */
  namespace?: string;
  /** Lucid connection name to use. Defaults to the `Database` default connection. */
  connection?: string;
  /** Poll interval (ms) for the result/task/heartbeat/control loops. Default 200ms. */
  pollIntervalMs?: number;
  /** How long a claimed-but-unfinished row is owned before it's reclaimable (crash recovery). Default 30s. */
  leaseMs?: number;
  /** Max rows claimed per poll. Default 20. */
  batchSize?: number;
  /** Create the transport tables on first use if missing. Default true. */
  autoCreate?: boolean;
  /** Stable id for this process (stamped on heartbeats / control `from` / `claimed_by`). Default random. */
  instanceId?: string;
}

/**
 * The transport factory namespace used in `config/durable.ts`:
 *
 * ```ts
 * import { defineConfig, transports } from '@adonis-agora/durable'
 *
 * export default defineConfig({
 *   transport: 'queue',
 *   transports: {
 *     memory: transports.memory(),
 *     queue: transports.queue({ connection: 'redis', group: 'durable' }),
 *     db: transports.db({ connection: 'pg' }),
 *   },
 * })
 * ```
 *
 * Each factory returns a {@link TransportFactory} — a lazy thunk. Calling it in the config file costs
 * nothing; the peer dependency is only imported when the provider builds the selected transport at
 * boot.
 */
/** A `config/queue.ts` `adapters` entry: a raw adapter factory or an AdonisJS config provider. */
type QueueAdapterEntry =
  | AdapterFactory
  | { resolver: (app: unknown) => AdapterFactory | Promise<AdapterFactory> };

/**
 * Resolve a raw `@adonisjs/queue` adapter factory from `config/queue.ts` by connection name —
 * mirroring `@adonisjs/queue`'s own `resolveAdapters`: a function entry is the factory; a config
 * provider is resolved via its `resolver(app)`. Reads only the app config, so it pulls in no
 * `@adonisjs/queue` runtime code.
 */
async function resolveQueueAdapter(
  ctx: TransportContext,
  connection?: string,
): Promise<AdapterFactory> {
  const queueConfig = ctx.app.config.get<{
    default?: string;
    adapters?: Record<string, QueueAdapterEntry>;
  }>('queue', { adapters: {} });

  const name = connection ?? queueConfig.default;
  if (!name) {
    throw new Error(
      '@agora/durable: transports.queue() needs a `connection`, or a `default` in config/queue.ts',
    );
  }
  const entry = queueConfig.adapters?.[name];
  if (!entry) {
    throw new Error(
      `@agora/durable: unknown @adonisjs/queue connection "${name}" — check the adapters in config/queue.ts`,
    );
  }
  return typeof entry === 'function' ? entry : entry.resolver(ctx.app);
}

export const transports = {
  /**
   * The test-only in-process transport + control plane (the engine's default when no `transport` is
   * named). Drives `dispatch` straight into the handler for deterministic tests — for a real
   * single-process production app, prefer {@link transports.eventEmitter}.
   */
  memory(_config: MemoryTransportConfig = {}): TransportFactory {
    return async () => new InMemoryTransport();
  },

  /**
   * Production **in-process** transport + control plane backed by a single Node `EventEmitter`. Zero
   * external infrastructure (no DB, no Redis, no broker) — a single-process app runs real durable
   * workflows with nothing else to deploy. Decouples dispatch → worker → result over the event loop
   * (mirroring a real broker), unlike the test-only {@link transports.memory}.
   */
  eventEmitter(config: EventEmitterTransportConfig = {}): TransportFactory {
    return async () => {
      const { EventEmitterTransport } = await import('./event-emitter.js');
      return new EventEmitterTransport({
        ...(config.group !== undefined ? { group: config.group } : {}),
        ...(config.instanceId !== undefined ? { instanceId: config.instanceId } : {}),
      });
    };
  },

  /** Run remote steps cross-process over `@adonisjs/queue`, using a connection from `config/queue.ts`. */
  queue(config: QueueTransportConfig = {}): TransportFactory {
    return async (ctx) => {
      const { QueueTransport } = await import('./queue.js');
      const adapter = config.adapter ?? (await resolveQueueAdapter(ctx, config.connection));
      return new QueueTransport({
        adapter,
        ...(config.group !== undefined ? { group: config.group } : {}),
        ...(config.partition !== undefined ? { partition: config.partition } : {}),
        ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
        ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
        ...(config.pollIntervalMs !== undefined ? { pollIntervalMs: config.pollIntervalMs } : {}),
        ...(config.stalledCheckIntervalMs !== undefined
          ? { stalledCheckIntervalMs: config.stalledCheckIntervalMs }
          : {}),
        ...(config.stalledThresholdMs !== undefined
          ? { stalledThresholdMs: config.stalledThresholdMs }
          : {}),
        ...(config.maxStalledCount !== undefined
          ? { maxStalledCount: config.maxStalledCount }
          : {}),
        ...(config.instanceId !== undefined ? { instanceId: config.instanceId } : {}),
        ...(config.onError !== undefined ? { onError: config.onError } : {}),
      });
    };
  },

  /**
   * Run remote steps + workflow tasks cross-process AND cross-ecosystem over the real `bullmq` npm
   * package, byte-compatible with the aviary (`nestjs-durable`) BullMQ transport and its Python
   * raw-redis worker — so an Adonis engine and a Python/NestJS worker interoperate on one Redis. Pair
   * it with `controlPlanes.redis(...)` for the `${prefix}-control` broadcast (this transport does not
   * reimplement the control plane). `bullmq`/`ioredis` are imported lazily, only when selected.
   */
  bullmq(config: BullMQTransportConfig): TransportFactory {
    return async () => {
      const { BullMQTransport } = await import('./bullmq/bullmq-transport.js');
      const { createBullMQDeps } = await import('./bullmq/deps.js');
      const deps = await createBullMQDeps(config.connection, config.concurrency ?? 1);
      return new BullMQTransport({
        deps,
        ...(config.partition !== undefined ? { partition: config.partition } : {}),
        ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
        ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
        ...(config.instanceId !== undefined ? { instanceId: config.instanceId } : {}),
      });
    };
  },

  /** Run remote steps cross-process over the app's database, using `@adonisjs/lucid` — no broker. */
  db(config: DbTransportConfig = {}): TransportFactory {
    return async (ctx) => {
      const db = (await resolveLucidDatabase(ctx)) as Database;
      const { DbTransport } = await import('./db.js');
      return new DbTransport({
        db,
        ...(config.group !== undefined ? { group: config.group } : {}),
        ...(config.partition !== undefined ? { partition: config.partition } : {}),
        ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
        ...(config.connection !== undefined ? { connectionName: config.connection } : {}),
        ...(config.pollIntervalMs !== undefined ? { pollIntervalMs: config.pollIntervalMs } : {}),
        ...(config.leaseMs !== undefined ? { leaseMs: config.leaseMs } : {}),
        ...(config.batchSize !== undefined ? { batchSize: config.batchSize } : {}),
        ...(config.autoCreate !== undefined ? { autoCreate: config.autoCreate } : {}),
        ...(config.instanceId !== undefined ? { instanceId: config.instanceId } : {}),
      });
    };
  },
};
