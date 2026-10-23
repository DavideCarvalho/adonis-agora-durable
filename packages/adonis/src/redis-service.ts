/** The read view of `@adonisjs/redis`'s service: `connection(name)` returns a pub/sub-capable client. */
export interface RedisServiceLike {
  connection(name?: string): unknown;
}

/** The slice of the application the Redis-backed factories need to find `@adonisjs/redis`. */
interface RedisLookupContext {
  app?: { container: { make(service: unknown): Promise<unknown> } };
}

const isRedisService = (value: unknown): value is RedisServiceLike =>
  typeof (value as RedisServiceLike | undefined)?.connection === 'function';

/**
 * Resolve the `@adonisjs/redis` manager for a factory thunk the durable provider runs at boot.
 *
 * The container binding (`'redis'`) is registered in the redis provider's `register()`, so it exists
 * while the durable provider boots. The `@adonisjs/redis/services/main` default export does NOT: it is
 * only assigned in `app.booted()`, so reading it during boot yields `undefined` and the factory crashed
 * with `Cannot read properties of undefined (reading 'connection')`. The service module stays as a
 * fallback for a context without a container.
 */
export async function resolveRedisService(ctx?: RedisLookupContext): Promise<RedisServiceLike> {
  if (ctx?.app) {
    try {
      const fromContainer = await ctx.app.container.make('redis');
      if (isRedisService(fromContainer)) return fromContainer;
    } catch {
      // Not bound (redis provider missing): fall through to the service module.
    }
  }
  const fromService = (await import('@adonisjs/redis/services/main')).default as unknown;
  if (isRedisService(fromService)) return fromService;
  throw new Error(
    '@adonis-agora/durable: the Redis factory needs @adonisjs/redis. Install it and register ' +
      "'@adonisjs/redis/redis_provider' in adonisrc.ts before the durable provider.",
  );
}
