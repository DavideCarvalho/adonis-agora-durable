/**
 * Compile-time proof that {@link RedisPubSub} can actually be satisfied by the two clients its
 * docblock advertises. There is nothing to run: this file is deliberately NOT a `.spec.ts`, so
 * vitest never collects it — `tsconfig.tests.json` is what checks it, and `pnpm typecheck` is what
 * fails when it regresses.
 *
 * It exists because the port once claimed "BOTH a raw `ioredis` instance and an `@adonisjs/redis`
 * connection satisfy it structurally" while **neither** did:
 *
 * - `Redis` failed on `subscribe`. The port declared `(channel, handler?)` — the `@adonisjs/redis`
 *   shape — but ioredis's real overloads are `(...channels: (string|Buffer)[], callback?)` where
 *   `callback` is a node-style `(err, result)` completion callback, not a per-message handler.
 * - `RedisConnection` failed on `on`. The port declared `(event: string, listener)`; the real one is
 *   emittery-style `<Name extends keyof ConnectionEvents>(eventName, listener, options?)`.
 *
 * Both were invisible because the driver's own tests handed it hand-written fakes, and the one spec
 * that used a real client cast the mismatch away. A consumer passing `new Redis(url)` straight to
 * `defineConfig` got a type error, on an API whose feature detection assumes they can.
 *
 * The assignments below are the regression test. Keep them as plain typed declarations — a cast of
 * any kind here would defeat the entire point of the file.
 */
import type { RedisConnection } from '@adonisjs/redis';
import type { Redis } from 'ioredis';
import type {
  AdonisRedisPubSub,
  IoredisPubSub,
  RedisPubSub,
} from '../../src/control-plane-redis/redis-control-plane.js';
import type { RedisControlPlaneOptions } from '../../src/control-plane-redis/redis-control-plane.js';

declare const rawIoredis: Redis;
declare const adonisConnection: RedisConnection;

/** A real `ioredis` client satisfies the union… */
export const ioredisIsPubSub: RedisPubSub = rawIoredis;
/** …and specifically its raw-ioredis arm. */
export const ioredisIsIoredisArm: IoredisPubSub = rawIoredis;

/** A real `@adonisjs/redis` connection satisfies the union… */
export const adonisIsPubSub: RedisPubSub = adonisConnection;
/** …and specifically its `@adonisjs/redis` arm. */
export const adonisIsAdonisArm: AdonisRedisPubSub = adonisConnection;

/**
 * The seam that actually matters to a consumer: both clients must go into the driver's options
 * object — this is the exact position a user writes in `config/durable.ts`.
 */
export const ioredisOptions: RedisControlPlaneOptions = { connection: rawIoredis };
export const adonisOptions: RedisControlPlaneOptions = { connection: adonisConnection };
