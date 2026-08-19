import type { AdmissionBackend } from '../admission.js';

/**
 * The minimal application surface an {@link AdmissionFactory} thunk needs at boot to resolve an
 * optional peer's service (an `@adonisjs/redis` connection). The durable provider passes the booted
 * `ApplicationService`, which satisfies this structurally — typed here so core stays free of a hard
 * `@adonisjs/core` dependency. Mirrors `TransportContext` / `StoreContext` / `ControlPlaneContext`.
 */
export interface AdmissionContext {
  /** The booted application — used to resolve services/connections from the container. */
  app: {
    container: { make(service: unknown): Promise<unknown> };
    config: { get<T>(key: string, defaultValue?: T): T };
  };
}

/**
 * A configured admission backend: a thunk the durable provider calls at boot to build the
 * {@link AdmissionBackend}. The factory lazily imports its peer dependency (`@adonisjs/redis`) inside
 * the thunk, so the driver is only loaded when it is actually selected — keeping that package optional.
 */
export type AdmissionFactory = (ctx: AdmissionContext) => Promise<AdmissionBackend>;

/** Options for the Redis-backed (fleet-wide) admission backend. */
export interface RedisAdmissionConfig {
  /**
   * Name of the `@adonisjs/redis` connection — a key of the `connections` map in `config/redis.ts` —
   * whose keys hold the fleet-wide slots and waiter queue. Defaults to `'main'`. You configure the
   * host / credentials once in `config/redis.ts`; durable just references it by name.
   */
  connection?: string;
  /** Key prefix namespacing the admission keys. Defaults to `durable`. */
  prefix?: string;
  /** Stable id for this engine instance ("pod"). Defaults to a random uuid. */
  instanceId?: string;
  /**
   * Liveness TTL (ms) for this instance's heartbeat key — a held slot is reclaimed only once its
   * owner's heartbeat lapses. Default 30s.
   */
  instanceTtlMs?: number;
  /** How long a blocked waiter's place survives its last `tryAdmit` (ms). Defaults to `retryMs * 3`. */
  waiterTtlMs?: number;
  /** Delay (ms) a blocked call is told to wait before re-trying admission. Default 1000. */
  retryMs?: number;
}

/** The read view of `@adonisjs/redis`'s service: `connection(name)` returns an ioredis-compatible client. */
interface RedisServiceLike {
  connection(name?: string): unknown;
}

/**
 * The admission-backend factory namespace used in `config/durable.ts`:
 *
 * ```ts
 * import { admissions, defineConfig, transports } from '@adonis-agora/durable'
 *
 * export default defineConfig({
 *   transport: 'queue',
 *   transports: { queue: transports.queue({ connection: 'redis' }) },
 *   // Make every `ctx.step(..., { queue })` cap FLEET-WIDE instead of per-pod.
 *   admission: admissions.redis({ connection: 'main' }),
 * })
 * ```
 *
 * Each factory returns an {@link AdmissionFactory} — a lazy thunk. Calling it in the config file costs
 * nothing; the peer dependency is only imported when the provider builds it at boot. Omit `admission`
 * entirely and the engine uses its in-process default (caps count per engine instance).
 */
export const admissions = {
  /**
   * Fleet-wide flow control over `@adonisjs/redis`: concurrency, rate and ordering are enforced in a
   * single atomic Lua script on Redis, so `concurrency: 5` means five in-flight steps across the whole
   * fleet rather than five per pod. Slots held by a pod that dies are reclaimed once its heartbeat lapses.
   */
  redis(config: RedisAdmissionConfig = {}): AdmissionFactory {
    return async () => {
      const { RedisAdmissionBackend } = await import('../admission-redis/index.js');
      const redis = (await import('@adonisjs/redis/services/main')).default as RedisServiceLike;
      const connection = redis.connection(config.connection ?? 'main') as never;
      return new RedisAdmissionBackend({
        connection,
        ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
        ...(config.instanceId !== undefined ? { instanceId: config.instanceId } : {}),
        ...(config.instanceTtlMs !== undefined ? { instanceTtlMs: config.instanceTtlMs } : {}),
        ...(config.waiterTtlMs !== undefined ? { waiterTtlMs: config.waiterTtlMs } : {}),
        ...(config.retryMs !== undefined ? { retryMs: config.retryMs } : {}),
      });
    };
  },
};
