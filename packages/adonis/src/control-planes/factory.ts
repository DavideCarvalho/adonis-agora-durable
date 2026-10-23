import type { ControlPlane } from '../interfaces.js';
import { resolveRedisService } from '../redis-service.js';

/**
 * The minimal application surface a {@link ControlPlaneFactory} thunk needs at boot to resolve an
 * optional peer's service (an `@adonisjs/redis` connection). The durable provider passes the booted
 * `ApplicationService`, which satisfies this structurally — typed here so core stays free of a hard
 * `@adonisjs/core` dependency. Mirrors `TransportContext` / `StoreContext`.
 */
export interface ControlPlaneContext {
  /** The booted application — used to resolve services/connections from the container. */
  app: {
    container: { make(service: unknown): Promise<unknown> };
    config: { get<T>(key: string, defaultValue?: T): T };
  };
}

/**
 * A configured control plane: a thunk the durable provider calls at boot to build the
 * {@link ControlPlane}. The factory lazily imports its peer dependency (`@adonisjs/redis`) inside the
 * thunk, so the driver is only loaded when it is actually selected — keeping that package optional.
 */
export type ControlPlaneFactory = (ctx: ControlPlaneContext) => Promise<ControlPlane>;

/** Options for the Redis pub/sub control plane (`@adonisjs/redis`). */
export interface RedisControlPlaneConfig {
  /**
   * Name of the `@adonisjs/redis` connection — a key of the `connections` map in `config/redis.ts` —
   * whose pub/sub this control plane broadcasts over. Defaults to `'main'`. You configure the host /
   * credentials once in `config/redis.ts`; durable just references it by name.
   */
  connection?: string;
  /**
   * Channel prefix. Defaults to `durable`; the channel is `` `${prefix}-control` ``, matched exactly
   * to the NestJS BullMQ transport so an AdonisJS fleet interoperates with a NestJS fleet on one Redis.
   */
  prefix?: string;
  /**
   * How often (ms) to PING the connection's pub/sub subscriber, so one a VPN/NAT/idle timeout dropped
   * silently is reconnected (and resubscribed) instead of sitting deaf until a restart. `0` or `false`
   * disables it. Default `30_000`.
   */
  pingIntervalMs?: number | false;
}

/**
 * The control-plane factory namespace used in `config/durable.ts`:
 *
 * ```ts
 * import { defineConfig, transports, controlPlanes } from '@adonis-agora/durable'
 *
 * export default defineConfig({
 *   transport: 'queue',
 *   transports: { queue: transports.queue({ connection: 'redis', group: 'workers' }) },
 *   // Fan out lifecycle events + cancellation across every replica over Redis pub/sub.
 *   controlPlane: controlPlanes.redis({ connection: 'main' }),
 * })
 * ```
 *
 * Each factory returns a {@link ControlPlaneFactory} — a lazy thunk. Calling it in the config file
 * costs nothing; the peer dependency is only imported when the provider builds it at boot. Omit
 * `controlPlane` entirely and the engine is local-only (single instance).
 */
export const controlPlanes = {
  /**
   * Broadcast lifecycle events + cancellation across every replica over `@adonisjs/redis` pub/sub,
   * using a connection from `config/redis.ts`. Interoperates with a NestJS fleet on the same Redis
   * via the shared `` `${prefix}-control` `` channel.
   */
  redis(config: RedisControlPlaneConfig = {}): ControlPlaneFactory {
    return async (ctx) => {
      const { RedisControlPlane } = await import('../control-plane-redis/redis-control-plane.js');
      const redis = await resolveRedisService(ctx);
      const connection = redis.connection(config.connection ?? 'main') as never;
      return new RedisControlPlane({
        connection,
        ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
        ...(config.pingIntervalMs !== undefined ? { pingIntervalMs: config.pingIntervalMs } : {}),
      });
    };
  },
};
