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
  attemptsMade?: number | undefined;
  opts?: { attempts?: number | undefined } | undefined;
}

/** The processor a task/result/decision/step-event worker runs per job. */
export type ProcessFn = (job: JobLike) => Promise<unknown>;

/** The subset of a BullMQ `Queue` this transport uses. */
export interface QueueLike {
  add(name: string, data: unknown, opts?: unknown): Promise<unknown>;
  /** Several jobs in one round trip. Optional: a queue without it gets one `add` per job. */
  addBulk?(jobs: Array<{ name: string; data: unknown; opts?: unknown }>): Promise<unknown>;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  close(): Promise<unknown>;
}

/** The subset of a BullMQ `Worker` this transport uses. */
export interface WorkerLike {
  /** The live concurrency. BullMQ's `Worker` applies an assignment to the jobs it fetches next. */
  concurrency?: number | undefined;
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
  /**
   * Liveness probe the subscriber watchdog sends (legal in subscriber mode). Optional: a client
   * without it is simply never probed.
   */
  ping?(): Promise<unknown>;
  /** ioredis connection state (`'ready'`, `'connecting'`, `'reconnecting'`, ...). The watchdog only
   *  probes a `'ready'` connection; absent reads as ready. */
  readonly status?: string | undefined;
  /** `disconnect(true)` drops the socket and lets ioredis reconnect (and `autoResubscribe`). */
  disconnect(reconnect?: boolean): void;
}

/**
 * The broker factory the transport is constructed with. Each `make*` mints a fresh broker object
 * bound to the configured connection. The default (real bullmq/ioredis) implementation comes from
 * {@link createBullMQDeps}; tests pass an in-memory fake to prove naming + job shape + the heartbeat
 * registry with no Redis.
 */
export interface BullMQDeps {
  makeQueue(name: string): QueueLike;
  /** `opts.concurrency` overrides the deps' default worker concurrency for this one worker. */
  makeWorker(name: string, process: ProcessFn, opts?: { concurrency?: number }): WorkerLike;
  /** A fresh standalone Redis client (pub/sub needs its own connection; the heartbeat registry reuses one). */
  makeRedis(): RedisLike;
}

/**
 * `value` as a BullMQ `Worker` concurrency: a finite number of at least 1, floored. Anything else
 * (absent, NaN, Infinity, below 1) is `fallback`, since BullMQ throws on a non-finite or sub-1 value.
 */
export function workerConcurrency(value: number | undefined, fallback = 1): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
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
/**
 * A `redis://` / `rediss://` URL as ioredis `ConnectionOptions`. BullMQ's `Queue`/`Worker` and this
 * module's own `{ keepAlive, ...connection }` spread only understand an options object or a `Redis`
 * instance: a bare string was spread character by character and silently fell back to ioredis's
 * default 127.0.0.1:6379. `rediss:` turns on TLS; the path's first segment selects the db.
 */
export function redisUrlToOptions(url: string): Record<string, unknown> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`@agora/durable: transports.bullmq() got an invalid Redis URL: ${url}`);
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(
      `@agora/durable: transports.bullmq() expects a redis:// or rediss:// URL, got ${parsed.protocol}`,
    );
  }
  const options: Record<string, unknown> = {
    host: parsed.hostname || '127.0.0.1',
    port: parsed.port ? Number(parsed.port) : 6379,
  };
  if (parsed.username) options.username = decodeURIComponent(parsed.username);
  if (parsed.password) options.password = decodeURIComponent(parsed.password);
  const db = parsed.pathname.replace(/^\//, '').split('/')[0];
  if (db) {
    const n = Number(db);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(
        `@agora/durable: transports.bullmq() got an invalid Redis db "${db}" in ${url}`,
      );
    }
    options.db = n;
  }
  // Query parameters (ioredis-style knobs, TLS CA paths…) are not mapped: refuse them rather than drop
  // them silently — pass `ConnectionOptions` for anything beyond host, port, credentials, db and TLS.
  if (parsed.search) {
    throw new Error(
      `@agora/durable: transports.bullmq() does not read query parameters from a Redis URL (${parsed.search}); pass ConnectionOptions instead.`,
    );
  }
  if (parsed.protocol === 'rediss:') options.tls = {};
  return options;
}

/**
 * Options carrying a `url` (`{ url: 'redis://…', … }`) with the URL read into host, port, credentials,
 * db and TLS. BullMQ reads `url` itself, but ioredis ignores it, so the pub/sub and heartbeat clients
 * would otherwise land on ioredis's default 127.0.0.1:6379 while the queues use the URL.
 */
function withUrlResolved(connection: unknown): unknown {
  if (typeof connection !== 'object' || connection === null || 'options' in connection) {
    return connection;
  }
  const { url, ...rest } = connection as { url?: unknown };
  if (typeof url !== 'string') return connection;
  return { ...rest, ...redisUrlToOptions(url) };
}

export async function createBullMQDeps(
  rawConnection: unknown,
  concurrency = 1,
): Promise<BullMQDeps> {
  const connection =
    typeof rawConnection === 'string'
      ? redisUrlToOptions(rawConnection)
      : withUrlResolved(rawConnection);
  const defaultConcurrency = workerConcurrency(concurrency);
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
    makeWorker: (name, process, opts) =>
      new Worker(name, (job) => process(job), {
        connection: workerConnection(),
        concurrency: workerConcurrency(opts?.concurrency, defaultConcurrency),
      }),
    makeRedis,
  };
}
