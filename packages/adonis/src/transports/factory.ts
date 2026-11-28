import type { Database } from '@adonisjs/lucid/database';
import type { AdapterFactory } from '@adonisjs/queue/types';
import type { ControlPlane, Transport } from '../interfaces.js';
import { resolveMessageSealer, type TransportMessagesOptions } from '../messages/resolve.js';
import { resolveLucidDatabase } from '../resolve-lucid-db.js';
import { hintStack } from '../stack.js';
import { InMemoryTransport } from '../testing/in-memory-transport.js';
import type { ConcurrencyOption } from './adaptive-concurrency.js';
import type { WorkerKeyStore } from './worker-keys.js';

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
  /**
   * The process's top-level `partition` (a `tenant` pod's tenant), forwarded by the provider so a
   * transport configured without its own `partition` consumes the `<name>@<partition>` queues the
   * control plane dispatches that tenant's work to. A transport-level `partition` wins.
   */
  partition?: string | undefined;
  /** The process's top-level `instanceId`, the default for a transport without its own. */
  instanceId?: string | undefined;
  /**
   * The process's top-level `schema`, the database schema of every durable table a driver without
   * its own `schema` creates and reads (the Lucid store, the db transport, the worker-key table).
   */
  schema?: string | undefined;
  /**
   * The transport's key in `config.transports` (`bullmq`, `jobs`, …): names it in the messages boot
   * line and errors. Set by the provider.
   */
  name?: string | undefined;
}

/** A transport option that falls back to the provider-forwarded top-level value. */
function inherited(
  key: 'partition' | 'instanceId' | 'schema',
  own: string | undefined,
  ctx: TransportContext,
): Record<string, string> {
  const value = own ?? ctx[key];
  return value !== undefined ? { [key]: value } : {};
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
  /** Stable id for this process (stamped on control `from` when a publisher leaves it unset). Default random. */
  instanceId?: string;
  /** Where a failing result/heartbeat handler is reported (a failed result is redelivered). Default `console.error`. */
  onError?: (err: unknown) => void;
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
  /** How long `close()` waits for in-flight jobs before handing them back (ms). Default 5000. */
  closeTimeoutMs?: number;
  /** How often (ms) a worker refreshes the liveness key of each step name it serves. Default 10000. */
  workerHeartbeatIntervalMs?: number;
  /**
   * How many jobs of one step name a worker runs at once. Default 1. More slots share one poll loop,
   * so raising it adds no polling.
   *
   * `'adaptive'`, or `{ mode: 'adaptive', min, max, start, tickMs, ramCeilingPct, cpuCeilingPct }`,
   * moves the limit at runtime with the same controller as `transports.bullmq({ concurrency })`: up by
   * one while steps saturate it at a steady latency, down by the latency gradient when they queue, down
   * by one on a >20% error rate, a stall or the CPU ceiling, and down by 20% when RSS reaches
   * `ramCeilingPct` of the memory limit. Defaults: `min` 1, `max` 32, `start` `min`, `tickMs` 2000,
   * `ramCeilingPct` 85, `cpuCeilingPct` off. The limit applies to each step name's task loop; the
   * results, heartbeat and control loops are unaffected.
   */
  concurrency?: ConcurrencyOption;
  /** How many step results the engine side settles at once. Default 1. */
  resultConcurrency?: number;
  /**
   * Idle backoff for the task, heartbeat and control loops, in poll intervals: empty polls double the
   * sleep up to this multiple (default 4 — 800ms at the default interval) and a found job resets it.
   * Bounds an idle worker's backend load; `1` disables it. The results loop never backs off.
   */
  idleBackoffMax?: number;
  /**
   * How often (ms) the stalled-job reclaim sweep runs. On by default (30s); set `0` to disable it.
   * A coarse background check, not run on every poll tick.
   */
  stalledCheckIntervalMs?: number;
  /**
   * How old (ms) a claim must be before the reclaim sweep presumes its worker dead and re-delivers the
   * job. The transport renews every in-flight claim each half threshold, so this bounds how long a
   * worker may go silent (default 2min) — a long step is never re-delivered. An adapter without
   * `renewJobs` (only a custom one) keeps the old 30min default: raise it above your longest step, or a
   * slow step gets double-run.
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
  /**
   * Where the worker advertisement (each worker's descriptor and heartbeat keys) lives. Default: the
   * app database's `durable_transport_worker_keys` table, through `@adonisjs/lucid`, when the app has
   * it — the table the db transport uses. Pass a {@link WorkerKeyStore} to keep the keys elsewhere,
   * or `false` to advertise nothing.
   */
  workerKeys?: WorkerKeyStore | false;
  /** Lucid connection the default worker-key table lives on. Defaults to the default connection. */
  workerKeysConnection?: string;
  /**
   * Database schema the default worker-key table lives in (a database on MySQL). Defaults to the
   * top-level `schema`, else the connection's current schema. Not supported on SQLite.
   */
  workerKeysSchema?: string;
  /** How long a read of the worker keys is reused (ms). Default 5000. */
  workerKeysCacheMs?: number;
  /**
   * Store-less protocol: TTL (ms) of the event subscriptions and inbox liveness an instance announces
   * to the control plane (recorded in the control plane's worker-key store), re-announced every third
   * of it. Default 30000.
   */
  inboxTtlMs?: number;
  /** How long a control plane reuses its read of a tenant's live event subscribers (ms). Default 1000. */
  tenantSubscribersCacheMs?: number;
  /** How often (ms) a control plane drains the inboxes of tenant pods that died. Default 30000; `0` off. */
  inboxSweepIntervalMs?: number;
  /**
   * How this transport seals its messages. `seal: true` (or the top-level `messages.seal`)
   * encrypts them with a key derived from the app's `APP_KEY` (between a tenant and its control
   * plane: an `@adonis-agora/crypto` key); off by default in 1.x, sealed messages are still opened. `secret` (HMAC,
   * readable), `crypto: { cipher }` (explicit key or your own KMS), `crypto: false` / `insecure: true`
   * (plain), `acceptPlain` (default `true` in 1.x). See "Encrypting messages".
   */
  messages?: TransportMessagesOptions;
}

/**
 * The worker-key store a queue transport advertises through: the configured one, else the app
 * database's table when `@adonisjs/lucid` is bound, else none.
 */
async function queueWorkerKeys(
  ctx: TransportContext,
  config: QueueTransportConfig,
): Promise<WorkerKeyStore | undefined> {
  if (config.workerKeys === false) return undefined;
  if (config.workerKeys) return config.workerKeys;
  let db: Database;
  try {
    db = (await resolveLucidDatabase(ctx)) as Database;
  } catch {
    return undefined;
  }
  const { lucidWorkerKeys } = await import('./worker-keys-db.js');
  const schema = config.workerKeysSchema ?? ctx.schema;
  return lucidWorkerKeys(db, {
    connectionName: config.workerKeysConnection,
    ...(schema !== undefined ? { schema } : {}),
  });
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
  /**
   * How long (seconds) each BullMQ worker blocks on an EMPTY queue before polling it again (BullMQ
   * `drainDelay`). A new job wakes the worker at once and a delayed job's due time shortens the wait,
   * so this only sets how often idle queues are re-polled: one poll is ~7 Redis commands, per queue.
   * Default 30 (BullMQ's own default is 5).
   */
  drainDelay?: number;
  /**
   * How many tasks a worker runs concurrently from each of its queues (BullMQ `Worker` concurrency).
   * A number pins it: default 1, and a non-finite or sub-1 value falls back to 1.
   *
   * `'adaptive'`, or `{ mode: 'adaptive', min, max, start, tickMs, ramCeilingPct, cpuCeilingPct }`,
   * moves each task worker's limit at runtime, every `tickMs`: up by one while steps are saturating
   * the limit at a steady latency, down by the latency gradient when they queue, down by one on a
   * >20% error rate, a stall or the CPU ceiling, and down by 20% when RSS reaches `ramCeilingPct` of
   * the memory limit (cgroup, else host). Defaults: `min` 1, `max` 32, `start` `min`, `tickMs`
   * 2000, `ramCeilingPct` 85, `cpuCeilingPct` off. A non-finite or out-of-range field falls back to
   * its default. In adaptive mode the other consumers (decisions, step events, start-run,
   * run-request) run at 1.
   */
  concurrency?: ConcurrencyOption;
  /**
   * How many step results this instance settles at once from the results queue. Raise it for wide
   * fans; one run's turns still go in order on an instance. Default 1. A non-finite or sub-1 value
   * falls back to 1.
   */
  resultConcurrency?: number;
  /** Stable id for this process (stamped on the worker-liveness keys). Default `ts-<host>-<pid>`. */
  instanceId?: string;
  /**
   * Ceiling (ms) `close()` waits for graceful shutdown (workers first, then queues, one shared
   * deadline) before it disconnects anyway. Default `5000`; `0` skips the wait. After the deadline,
   * abandoned BullMQ workers may keep running their jobs on their own connections until the process
   * exits.
   */
  closeTimeoutMs?: number;
  /** Receives transport failures (including pub/sub subscribe failures). Default: swallowed or `console.warn`. */
  onError?: (err: unknown) => void;
  /**
   * How often (ms) to PING each pub/sub subscriber connection (heartbeats, run replies, tenant
   * events) so a connection a VPN/NAT/idle timeout dropped silently is reconnected and resubscribed
   * instead of sitting deaf until a restart. `0` or `false` disables it. Default `30_000`.
   */
  pingIntervalMs?: number | false;
  /**
   * Wall-clock ceiling (ms) for one step handler on this worker. A handler still running at the
   * ceiling is failed RETRYABLE so durable retry re-dispatches the step, instead of a wedged await
   * holding its job (whose lock keeps renewing) forever. Unset = no ceiling.
   */
  stepTimeoutMs?: number;
  /**
   * How often (ms) each BullMQ worker checks its queue for stalled jobs (BullMQ `stalledInterval`):
   * jobs whose worker died mid-run go back to waiting at the next check. One check is ~7 Redis
   * commands per queue, about half of an idle queue's cost. A larger value cuts that cost and makes a
   * crashed worker's jobs wait up to that long (plus their lock's 30 s) before another worker picks
   * them up. Default BullMQ's own, `30_000`.
   */
  stalledInterval?: number;
  /**
   * The worker registry (liveness and handshake descriptors). Each worker instance writes ONE field
   * of one hash per beat, whatever its token count, and a process reads the hash with one command,
   * reused for up to 30 s.
   */
  workerRegistry?: {
    /**
     * Also read the per-instance keys of workers that do not write the registry hash (1.0.0-rc.31
     * and older, the NestJS or Python SDK), with one SCAN walk shared by the whole process and run at
     * most once per `legacyScanIntervalMs`. Set `false` once every worker runs this version.
     * Default `true`.
     */
    legacyScan?: boolean;
    /** The least time (ms) between two compatibility walks. Default `60_000`. */
    legacyScanIntervalMs?: number;
    /**
     * Also write what readers on 1.0.0-rc.31 and older (and the NestJS / Python fleet) read: each
     * token's per-instance key and rc.31 hash field, refreshed every `legacyWriteIntervalMs`. Set
     * `false` once every process that reads this Redis runs this version. Default `true`.
     */
    legacyWrites?: boolean;
    /** How often (ms) the keys of `legacyWrites` are refreshed; they live three times that. Default `30_000`. */
    legacyWriteIntervalMs?: number;
    /**
     * A separate ioredis connection (options, a URL or a `Redis` instance) for the registry hashes,
     * e.g. another db of the same server. Unset uses `connection`. The per-instance keys stay on
     * `connection`. Every process of the fleet must use the same value.
     */
    connection?: unknown;
  };
  /**
   * How step and workflow tasks are laid out on queues. `'per-handler'` (default): one queue, one
   * BullMQ worker and one blocking connection per handler (`<prefix>-tasks-<handler>`), which is what
   * the NestJS and Python SDKs read. `'grouped'`: every handler of a partition shares ONE queue
   * (`<prefix>-taskgroup`), so idle polling, stalled checks and connections stop growing with the
   * number of handlers; each handler keeps its own `concurrency` through an in-process limiter.
   * Every process consuming a partition's grouped queue must register the handlers dispatched to it.
   * Every process of the fleet must use the same value (see `taskQueueDrain` for switching).
   */
  taskQueues?: 'per-handler' | 'grouped';
  /**
   * Also consume the other layout's queues of the handlers this process serves while they hold jobs:
   * the per-handler queues in `'grouped'` mode (jobs from processes not yet upgraded, delayed and
   * stalled ones), the grouped queue in `'per-handler'` mode (a rollback). One `EXISTS` per interval
   * while they are empty. Default `true` with `'grouped'`, `false` otherwise; `{ intervalMs }` sets
   * the interval (default `60_000`).
   */
  taskQueueDrain?: boolean | { intervalMs?: number };
  /**
   * How this transport seals its messages. `seal: true` (or the top-level `messages.seal`)
   * encrypts them with a key derived from the app's `APP_KEY` (between a tenant and its control
   * plane: an `@adonis-agora/crypto` key); off by default in 1.x, sealed messages are still opened. `secret` (HMAC,
   * readable), `crypto: { cipher }` (explicit key or your own KMS), `crypto: false` / `insecure: true`
   * (plain), `acceptPlain` (default `true` in 1.x). See "Encrypting messages".
   */
  messages?: TransportMessagesOptions;
}

/** Options for the DB-table-backed (`@adonisjs/lucid`) transport. */
export interface DbTransportConfig {
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
  /**
   * Database schema the transport tables live in (a database on MySQL): every statement names it,
   * and `autoCreate` creates it. Defaults to the top-level `schema`, else the connection's current
   * schema. Not supported on SQLite.
   */
  schema?: string;
  /** Poll interval (ms) for the result/task/heartbeat/control loops. Default 200ms. */
  pollIntervalMs?: number;
  /** How long a claimed-but-unfinished row is owned before it's reclaimable (crash recovery). Default 30s. */
  leaseMs?: number;
  /**
   * Max rows claimed per poll by the results, heartbeat and control loops. Default 20. The task loop
   * claims only as many rows as it has free `concurrency` slots (capped by this).
   */
  batchSize?: number;
  /**
   * How many task rows a worker runs at once. Default 1. One poll loop serves every handler name and
   * keeps up to this many rows in flight, claiming only as many per poll as it has free slots.
   *
   * `'adaptive'`, or `{ mode: 'adaptive', min, max, start, tickMs, ramCeilingPct, cpuCeilingPct }`,
   * moves the limit at runtime with the controller the BullMQ and queue transports use. Either way
   * the limit, in-flight count, RSS, CPU, throughput and p95 ride the worker's liveness key.
   */
  concurrency?: ConcurrencyOption;
  /** How many step results the engine side settles at once. Default 1. */
  resultConcurrency?: number;
  /**
   * Idle backoff for the task, heartbeat and control loops, as a multiple of `pollIntervalMs`: after
   * consecutive empty polls the sleep doubles up to this many intervals. Default 4; `1` disables it.
   * The results loop never backs off.
   */
  idleBackoffMax?: number;
  /**
   * How many times a task row's lapsed claim may be taken over before the row is treated as poison:
   * deleted, with a retryable failed result published for its step. Default 3.
   */
  maxStalledCount?: number;
  /** How often (ms) a worker refreshes its liveness key per served step name. Default 10000. */
  workerHeartbeatIntervalMs?: number;
  /** How long a read of the worker keys (groupHealth, listWorkerGroups) is reused (ms). Default 5000. */
  workerKeysCacheMs?: number;
  /** Create the transport tables on first use if missing (and add newer columns). Default true. */
  autoCreate?: boolean;
  /** Stable id for this process (stamped on heartbeats / control `from` / `claimed_by`). Default random. */
  instanceId?: string;
  /** Where transport failures (a throwing poll, a lost claim) are reported. Default `console.error`. */
  onError?: (err: unknown) => void;
  /**
   * How long (ms) `close()` waits for in-flight work before handing every claim it still holds back
   * to the table, uncounted, for another worker to pick up at once. Default 5000.
   */
  closeTimeoutMs?: number /**
   * Remote workflows and store-less tenant pods: TTL (ms) of the keys an instance writes to say it
   * consumes the rows addressed to it (replies, tenant events, decisions) and which tenants' events it
   * wants, re-written every third of it. Default 30000.
   */;
  inboxTtlMs?: number;
  /** How long a publisher reuses its read of a tenant's live event subscribers (ms). Default 1000. */
  tenantSubscribersCacheMs?: number;
  /** How often (ms) an instance deletes the rows it addressed to instances that are gone. Default
   *  30000; `0` off. */
  inboxSweepIntervalMs?: number;
  /**
   * How this transport seals its messages. `seal: true` (or the top-level `messages.seal`)
   * encrypts them with a key derived from the app's `APP_KEY` (between a tenant and its control
   * plane: an `@adonis-agora/crypto` key); off by default in 1.x, sealed messages are still opened. `secret` (HMAC,
   * readable), `crypto: { cipher }` (explicit key or your own KMS), `crypto: false` / `insecure: true`
   * (plain), `acceptPlain` (default `true` in 1.x). See "Encrypting messages".
   */
  messages?: TransportMessagesOptions;
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
 *     queue: transports.queue({ connection: 'redis' }),
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

/** The `messages` options travel with the factory: the doctor reads them without building it. */
function describeMessages(
  factory: TransportFactory,
  messages: TransportMessagesOptions | undefined,
) {
  Object.defineProperty(factory, 'messages', { value: messages ?? {}, enumerable: false });
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
    return async (ctx) => {
      const { EventEmitterTransport } = await import('./event-emitter.js');
      return new EventEmitterTransport({
        ...inherited('instanceId', config.instanceId, ctx),
        ...(config.onError !== undefined ? { onError: config.onError } : {}),
      });
    };
  },

  /** Run remote steps cross-process over `@adonisjs/queue`, using a connection from `config/queue.ts`. */
  queue(config: QueueTransportConfig = {}): TransportFactory {
    const factory: TransportFactory = async (ctx) => {
      const { QueueTransport } = await import('./queue.js');
      const adapter = config.adapter ?? (await resolveQueueAdapter(ctx, config.connection));
      const workerKeys = await queueWorkerKeys(ctx, config);
      const messages = await resolveMessageSealer(
        { app: ctx.app, name: ctx.name ?? 'queue' },
        config.messages,
      );
      return new QueueTransport({
        adapter,
        messages,
        ...(workerKeys !== undefined ? { workerKeys } : {}),
        ...(config.workerKeysCacheMs !== undefined
          ? { workerKeysCacheMs: config.workerKeysCacheMs }
          : {}),
        ...inherited('partition', config.partition, ctx),
        ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
        ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
        ...(config.pollIntervalMs !== undefined ? { pollIntervalMs: config.pollIntervalMs } : {}),
        ...(config.closeTimeoutMs !== undefined ? { closeTimeoutMs: config.closeTimeoutMs } : {}),
        ...(config.workerHeartbeatIntervalMs !== undefined
          ? { workerHeartbeatIntervalMs: config.workerHeartbeatIntervalMs }
          : {}),
        ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
        ...(config.resultConcurrency !== undefined
          ? { resultConcurrency: config.resultConcurrency }
          : {}),
        ...(config.idleBackoffMax !== undefined ? { idleBackoffMax: config.idleBackoffMax } : {}),
        ...(config.stalledCheckIntervalMs !== undefined
          ? { stalledCheckIntervalMs: config.stalledCheckIntervalMs }
          : {}),
        ...(config.stalledThresholdMs !== undefined
          ? { stalledThresholdMs: config.stalledThresholdMs }
          : {}),
        ...(config.maxStalledCount !== undefined
          ? { maxStalledCount: config.maxStalledCount }
          : {}),
        ...inherited('instanceId', config.instanceId, ctx),
        ...(config.onError !== undefined ? { onError: config.onError } : {}),
        ...(config.inboxTtlMs !== undefined ? { inboxTtlMs: config.inboxTtlMs } : {}),
        ...(config.tenantSubscribersCacheMs !== undefined
          ? { tenantSubscribersCacheMs: config.tenantSubscribersCacheMs }
          : {}),
        ...(config.inboxSweepIntervalMs !== undefined
          ? { inboxSweepIntervalMs: config.inboxSweepIntervalMs }
          : {}),
      });
    };
    describeMessages(factory, config.messages);
    // The queue backend itself is config/queue.ts's (an opaque adapter); the worker keys are ours.
    return hintStack(
      factory,
      config.workerKeys === undefined
        ? [
            {
              kind: 'lucid',
              connection: config.workerKeysConnection,
              purpose: 'worker keys',
              ifLucid: true,
            },
          ]
        : [],
    );
  },

  /**
   * Run remote steps + workflow tasks cross-process AND cross-ecosystem over the real `bullmq` npm
   * package, byte-compatible with the aviary (`nestjs-durable`) BullMQ transport and its Python
   * raw-redis worker — so an Adonis engine and a Python/NestJS worker interoperate on one Redis. Pair
   * it with `controlPlanes.redis(...)` for the `${prefix}-control` broadcast (this transport does not
   * reimplement the control plane). `bullmq`/`ioredis` are imported lazily, only when selected.
   */
  bullmq(config: BullMQTransportConfig): TransportFactory {
    const factory: TransportFactory = async (ctx) => {
      const { BullMQTransport } = await import('./bullmq/bullmq-transport.js');
      const { createBullMQDeps } = await import('./bullmq/deps.js');
      const deps = await createBullMQDeps(
        config.connection,
        typeof config.concurrency === 'number' ? config.concurrency : 1,
        config.drainDelay,
        config.stalledInterval !== undefined ? { stalledInterval: config.stalledInterval } : {},
      );
      const registryDeps =
        config.workerRegistry?.connection !== undefined
          ? await createBullMQDeps(config.workerRegistry.connection)
          : undefined;
      const messages = await resolveMessageSealer(
        { app: ctx.app, name: ctx.name ?? 'bullmq' },
        config.messages,
      );
      return new BullMQTransport({
        deps,
        messages,
        ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
        ...inherited('partition', config.partition, ctx),
        ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
        ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
        ...inherited('instanceId', config.instanceId, ctx),
        ...(config.closeTimeoutMs !== undefined ? { closeTimeoutMs: config.closeTimeoutMs } : {}),
        ...(config.resultConcurrency !== undefined
          ? { resultConcurrency: config.resultConcurrency }
          : {}),
        ...(config.onError !== undefined ? { onError: config.onError } : {}),
        ...(config.pingIntervalMs !== undefined ? { pingIntervalMs: config.pingIntervalMs } : {}),
        ...(config.stepTimeoutMs !== undefined ? { stepTimeoutMs: config.stepTimeoutMs } : {}),
        ...(config.taskQueues !== undefined ? { taskQueues: config.taskQueues } : {}),
        ...(config.taskQueueDrain !== undefined ? { taskQueueDrain: config.taskQueueDrain } : {}),
        ...(config.workerRegistry !== undefined
          ? {
              workerRegistry: {
                ...(config.workerRegistry.legacyScan !== undefined
                  ? { legacyScan: config.workerRegistry.legacyScan }
                  : {}),
                ...(config.workerRegistry.legacyScanIntervalMs !== undefined
                  ? { legacyScanIntervalMs: config.workerRegistry.legacyScanIntervalMs }
                  : {}),
                ...(config.workerRegistry.legacyWrites !== undefined
                  ? { legacyWrites: config.workerRegistry.legacyWrites }
                  : {}),
                ...(config.workerRegistry.legacyWriteIntervalMs !== undefined
                  ? { legacyWriteIntervalMs: config.workerRegistry.legacyWriteIntervalMs }
                  : {}),
                ...(registryDeps ? { makeRedis: registryDeps.makeRedis } : {}),
              },
            }
          : {}),
      });
    };
    describeMessages(factory, config.messages);
    return hintStack(factory, [
      { kind: 'ioredis', connection: config.connection, label: 'bullmq', purpose: 'queues' },
      ...(config.workerRegistry?.connection !== undefined
        ? [
            {
              kind: 'ioredis' as const,
              connection: config.workerRegistry.connection,
              label: 'bullmq registry',
              purpose: 'worker registry',
            },
          ]
        : []),
    ]);
  },

  /** Run remote steps cross-process over the app's database, using `@adonisjs/lucid` — no broker. */
  db(config: DbTransportConfig = {}): TransportFactory {
    const factory: TransportFactory = async (ctx) => {
      const db = (await resolveLucidDatabase(ctx)) as Database;
      const { DbTransport } = await import('./db.js');
      const messages = await resolveMessageSealer(
        { app: ctx.app, name: ctx.name ?? 'db' },
        config.messages,
      );
      return new DbTransport({
        db,
        messages,
        ...inherited('partition', config.partition, ctx),
        ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
        ...(config.connection !== undefined ? { connectionName: config.connection } : {}),
        ...inherited('schema', config.schema, ctx),
        ...(config.pollIntervalMs !== undefined ? { pollIntervalMs: config.pollIntervalMs } : {}),
        ...(config.leaseMs !== undefined ? { leaseMs: config.leaseMs } : {}),
        ...(config.batchSize !== undefined ? { batchSize: config.batchSize } : {}),
        ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
        ...(config.resultConcurrency !== undefined
          ? { resultConcurrency: config.resultConcurrency }
          : {}),
        ...(config.idleBackoffMax !== undefined ? { idleBackoffMax: config.idleBackoffMax } : {}),
        ...(config.maxStalledCount !== undefined
          ? { maxStalledCount: config.maxStalledCount }
          : {}),
        ...(config.workerHeartbeatIntervalMs !== undefined
          ? { workerHeartbeatIntervalMs: config.workerHeartbeatIntervalMs }
          : {}),
        ...(config.workerKeysCacheMs !== undefined
          ? { workerKeysCacheMs: config.workerKeysCacheMs }
          : {}),
        ...(config.autoCreate !== undefined ? { autoCreate: config.autoCreate } : {}),
        ...inherited('instanceId', config.instanceId, ctx),
        ...(config.onError !== undefined ? { onError: config.onError } : {}),
        ...(config.closeTimeoutMs !== undefined ? { closeTimeoutMs: config.closeTimeoutMs } : {}),
        ...(config.inboxTtlMs !== undefined ? { inboxTtlMs: config.inboxTtlMs } : {}),
        ...(config.tenantSubscribersCacheMs !== undefined
          ? { tenantSubscribersCacheMs: config.tenantSubscribersCacheMs }
          : {}),
        ...(config.inboxSweepIntervalMs !== undefined
          ? { inboxSweepIntervalMs: config.inboxSweepIntervalMs }
          : {}),
      });
    };
    describeMessages(factory, config.messages);
    return hintStack(factory, [
      { kind: 'lucid', connection: config.connection, purpose: 'queues' },
    ]);
  },
};
