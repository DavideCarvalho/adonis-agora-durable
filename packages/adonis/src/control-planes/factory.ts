import type { ConsoleSideOptions } from '../control-plane-redis/console-auth.js';
import type { ControlPlane } from '../interfaces.js';
import { resolveRedisService } from '../redis-service.js';
import { hintStack } from '../stack.js';

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

/**
 * Options for the Redis pub/sub control plane (`@adonisjs/redis`). As another app's entry in a
 * federated console (`apps.<key>.controlPlane`), it also says how the console authenticates its
 * commands to that app ({@link ConsoleSideOptions}: `secret`, `token`, `publicKey`, `crypto`,
 * `partition`); they mean nothing on an app's own control plane.
 */
export interface RedisControlPlaneConfig extends ConsoleSideOptions {
  /**
   * Name of the `@adonisjs/redis` connection — a key of the `connections` map in `config/redis.ts` —
   * whose pub/sub this control plane broadcasts over. Defaults to `'main'`. You configure the host /
   * credentials once in `config/redis.ts`; durable just references it by name.
   */
  connection?: string;
  /**
   * Channel prefix. Defaults to `durable`; the channel is `` `${prefix}-control` ``, or
   * `` `${prefix}-${namespace}-control` `` under a non-`default` namespace, matched exactly to the
   * NestJS BullMQ transport so an AdonisJS fleet interoperates with a NestJS fleet on one Redis.
   */
  prefix?: string;
  /**
   * Namespace folded into the channel name. Defaults to the engine's `namespace`; set it only to
   * listen on another namespace's channel.
   */
  namespace?: string;
  /**
   * Which namespaces this instance observes: `'own'` (its channel only) or `'all'` (every
   * namespace's channel too). Default: `'all'` for an engine with no namespace or a process that
   * mounts the durable dashboard, `'own'` otherwise.
   */
  observe?: 'all' | 'own';
  /**
   * How often (ms) to PING the connection's pub/sub subscriber, so one a VPN/NAT/idle timeout dropped
   * silently is reconnected (and resubscribed) instead of sitting deaf until a restart. `0` or `false`
   * disables it. Default `30_000`.
   */
  pingIntervalMs?: number | false;
}

/** The console-side options of a control plane's config (see {@link ConsoleSideOptions}). */
function consoleSideOf(config: ConsoleSideOptions): ConsoleSideOptions {
  return {
    ...(config.secret !== undefined ? { secret: config.secret } : {}),
    ...(config.token !== undefined ? { token: config.token } : {}),
    ...(config.publicKey !== undefined ? { publicKey: config.publicKey } : {}),
    ...(config.crypto !== undefined ? { crypto: config.crypto } : {}),
    ...(config.partition !== undefined ? { partition: config.partition } : {}),
  };
}

/**
 * The control-plane factory namespace used in `config/durable.ts`:
 *
 * ```ts
 * import { defineConfig, transports, controlPlanes } from '@adonis-agora/durable'
 *
 * export default defineConfig({
 *   transport: 'queue',
 *   transports: { queue: transports.queue({ connection: 'redis' }) },
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
    const consoleSide = consoleSideOf(config);
    const factory: ControlPlaneFactory = async (ctx) => {
      const { RedisControlPlane } = await import('../control-plane-redis/redis-control-plane.js');
      const redis = await resolveRedisService(ctx);
      const connection = redis.connection(config.connection ?? 'main') as never;
      return new RedisControlPlane({
        connection,
        ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
        ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
        ...(config.observe !== undefined ? { observe: config.observe } : {}),
        ...(config.pingIntervalMs !== undefined ? { pingIntervalMs: config.pingIntervalMs } : {}),
        ...(Object.keys(consoleSide).length > 0 ? { console: consoleSide } : {}),
      });
    };
    // The prefix travels with the factory: `node ace durable:console-key` derives the app's
    // console-command key from it without connecting to Redis.
    Object.defineProperty(factory, 'prefix', {
      value: config.prefix ?? 'durable',
      enumerable: false,
    });
    // A federated console reads how to authenticate to this app without building the plane.
    Object.defineProperty(factory, 'console', { value: consoleSide, enumerable: false });
    return hintStack(factory, [
      { kind: 'redis', connection: config.connection, purpose: 'control plane' },
    ]);
  },
};
