/**
 * The tiny broker surface the {@link import('./bullmq-transport.js').BullMQTransport} depends on, and
 * the real-`bullmq` implementation of it. Splitting the concrete broker behind these structural
 * interfaces is what keeps the transport itself PURE and unit-testable with fakes — and lets the
 * package build/test without `bullmq` installed, since the only place that touches the real dependency
 * is {@link createBullMQDeps}, which `import()`s it LAZILY (so a non-bullmq fleet never loads it).
 */

/** A BullMQ job as this transport reads it — only the fields it uses. `data` is the raw DTO. */
export interface JobLike {
  data: unknown;
  failedReason?: string | undefined;
}

/** The processor a task/result/decision/step-event worker runs per job. */
export type ProcessFn = (job: JobLike) => Promise<unknown>;

/** The subset of a BullMQ `Queue` this transport uses. */
export interface QueueLike {
  add(name: string, data: unknown, opts?: unknown): Promise<unknown>;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  close(): Promise<unknown>;
}

/** The subset of a BullMQ `Worker` this transport uses. */
export interface WorkerLike {
  on(event: 'failed', listener: (job: JobLike | undefined, err: Error) => void): unknown;
  close(): Promise<unknown>;
}

/** The subset of an ioredis client this transport uses (pub/sub + the worker-heartbeat keyspace). */
export interface RedisLike {
  publish(channel: string, message: string): Promise<unknown> | unknown;
  subscribe(channel: string): Promise<unknown> | unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]>;
  get(key: string): Promise<string | null>;
  /** Batched read — optional: a client without it falls back to per-key `get`. */
  mget?(...keys: string[]): Promise<(string | null)[]>;
  disconnect(): void;
}

/**
 * The broker factory the transport is constructed with. Each `make*` mints a fresh broker object
 * bound to the configured connection. The default (real bullmq/ioredis) implementation comes from
 * {@link createBullMQDeps}; tests pass an in-memory fake to prove naming + job shape + the heartbeat
 * registry with no Redis.
 */
export interface BullMQDeps {
  makeQueue(name: string): QueueLike;
  makeWorker(name: string, process: ProcessFn): WorkerLike;
  /** A fresh standalone Redis client (pub/sub needs its own connection; the heartbeat registry reuses one). */
  makeRedis(): RedisLike;
}

/**
 * Build the real bullmq/ioredis-backed {@link BullMQDeps} for `connection` (ioredis `ConnectionOptions`
 * or a `Redis` instance) at a `concurrency`. `bullmq` and `ioredis` are imported LAZILY here — via a
 * non-literal specifier so the package type-checks and unit-tests without them installed — and only
 * this call (i.e. only when the transport is actually selected + run) pulls them in.
 *
 * Workers require `maxRetriesPerRequest: null`; a plain-options connection is cloned with it set (a
 * passed-in `Redis` instance is preserved as-is). A standalone client for pub/sub / heartbeat keys is
 * a `duplicate()` of a passed-in instance, or a fresh client with a keepalive floor from the options.
 *
 * @throws when `connection` is falsy or an empty object — otherwise `makeRedis()` would silently mint
 * an ioredis client with NO host/port, landing on ioredis's own default (`127.0.0.1:6379`) instead of
 * the caller's Redis.
 */
export async function createBullMQDeps(connection: unknown, concurrency = 1): Promise<BullMQDeps> {
  // Non-literal specifiers: keep `tsc` from resolving 'bullmq'/'ioredis' at build time (they are a
  // runtime-only dependency of the selected transport), so the wider package builds without them.
  const bullmqSpecifier = 'bullmq';
  const ioredisSpecifier = 'ioredis';
  const { Queue, Worker } = (await import(bullmqSpecifier)) as {
    Queue: new (name: string, opts: unknown) => QueueLike;
    Worker: new (name: string, processor: (job: JobLike) => unknown, opts: unknown) => WorkerLike;
  };
  const { Redis } = (await import(ioredisSpecifier)) as {
    Redis: new (opts?: unknown) => RedisLike;
  };

  const isRedisInstance = (value: unknown): value is RedisLike & { duplicate(): RedisLike } =>
    value instanceof (Redis as unknown as abstract new (...args: never[]) => object);

  // A falsy/empty `connection` would otherwise reach `makeRedis()`'s `{ keepAlive: 10_000, ...connection }`
  // spread with nothing useful in it, silently minting an ioredis client bound to ioredis's OWN default
  // (127.0.0.1:6379) instead of the caller's Redis — a footgun that reads as "it connected" right up until
  // it hits the wrong instance (see adonis-durable's redis-connection-standalone regression). Fail loudly
  // instead, the same way `resolveQueueAdapter` does for a missing `transports.queue()` connection: an
  // existing `Redis` instance, a connection string, or a non-empty options object is required.
  const hasUsableConnection =
    isRedisInstance(connection) ||
    typeof connection === 'string' ||
    (typeof connection === 'object' && connection !== null && Object.keys(connection).length > 0);
  if (!hasUsableConnection) {
    const got = connection === undefined ? 'undefined' : JSON.stringify(connection);
    throw new Error(
      `@agora/durable: transports.bullmq() needs a \`connection\` — an ioredis \`Redis\` instance, a connection string, or ConnectionOptions (host/port/path/sentinels/…). Got ${got}, which would otherwise silently fall back to ioredis's own default (127.0.0.1:6379) instead of your app's Redis.`,
    );
  }

  // Workers require `maxRetriesPerRequest: null`; preserve a passed-in Redis instance as-is.
  const workerConnection = (): unknown =>
    connection && typeof connection === 'object' && !('options' in connection)
      ? { ...(connection as object), maxRetriesPerRequest: null }
      : connection;

  const makeRedis = (): RedisLike => {
    if (isRedisInstance(connection)) return connection.duplicate();
    return new Redis({ keepAlive: 10_000, ...(connection as object) });
  };

  return {
    makeQueue: (name) => new Queue(name, { connection }),
    makeWorker: (name, process) =>
      new Worker(name, (job) => process(job), { connection: workerConnection(), concurrency }),
    makeRedis,
  };
}
