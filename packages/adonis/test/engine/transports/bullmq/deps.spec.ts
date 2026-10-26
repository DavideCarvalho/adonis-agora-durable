import { afterEach, describe, expect, it } from 'vitest';
import { createBullMQDeps, redisUrlToOptions } from '../../../../src/transports/bullmq/deps.js';

/**
 * Regression test for the redis-connection-standalone bug: `createBullMQDeps()` used to build
 * `makeRedis()` as `new Redis({ keepAlive: 10_000, ...connection })` with NO validation — a
 * falsy/empty `connection` spread to nothing, so the resulting ioredis client silently landed on
 * ioredis's OWN default (`127.0.0.1:6379`) instead of the caller's Redis. That is invisible until
 * the wrong Redis is unreachable (an app's real Redis on a non-default port, say), at which point
 * boot hangs in an `ECONNREFUSED 6379` retry loop instead of failing with an actionable error.
 *
 * `createBullMQDeps()` must now reject up front (before `makeRedis()`/`makeQueue()`/`makeWorker()`
 * ever run) whenever `connection` carries nothing usable, and must keep working normally otherwise
 * — a real `Redis` instance, a connection string, or a non-empty options object all still resolve.
 */
describe('createBullMQDeps — connection validation', () => {
  const clients: Array<{ disconnect(): void }> = [];
  afterEach(() => {
    for (const c of clients) c.disconnect();
    clients.length = 0;
  });

  it('rejects an undefined connection instead of silently defaulting to ioredis:6379', async () => {
    await expect(createBullMQDeps(undefined)).rejects.toThrow(/connection/i);
  });

  it('rejects a null connection', async () => {
    await expect(createBullMQDeps(null)).rejects.toThrow(/connection/i);
  });

  it('rejects an empty-object connection (e.g. a config lookup that resolved to `{}`)', async () => {
    await expect(createBullMQDeps({})).rejects.toThrow(/connection/i);
  });

  it('the rejection names the dangerous default, so the failure is actionable', async () => {
    await expect(createBullMQDeps(undefined)).rejects.toThrow(/6379/);
  });

  it('still builds normally for a real (non-empty) connection options object', async () => {
    const deps = await createBullMQDeps({ host: '127.0.0.1', port: 16382, lazyConnect: true });
    const redis = deps.makeRedis();
    clients.push(redis);
    // The client actually carries the configured host/port — not ioredis's own default.
    expect((redis as unknown as { options: { host: string; port: number } }).options).toMatchObject(
      { host: '127.0.0.1', port: 16382 },
    );
  });

  it('still builds normally for an already-connected Redis instance', async () => {
    const deps = await createBullMQDeps({ host: '127.0.0.1', port: 16382, lazyConnect: true });
    const seed = deps.makeRedis();
    clients.push(seed);
    // `isRedisInstance` must keep recognizing a real `Redis` instance as usable on its own (no
    // host/port fields to inspect on the wrapper — the instance already carries them internally).
    const deps2 = await createBullMQDeps(seed);
    const duplicated = deps2.makeRedis();
    clients.push(duplicated);
    expect(
      (duplicated as unknown as { options: { host: string; port: number } }).options,
    ).toMatchObject({ host: '127.0.0.1', port: 16382 });
  });

  it('honours a connection STRING instead of silently connecting to 127.0.0.1:6379', async () => {
    // A string used to be spread character by character into the options, so every client — Redis,
    // Queue and Worker — fell back to ioredis's default while the boot looked fine.
    const deps = await createBullMQDeps('redis://:s3cret@10.0.0.7:16383/2');
    const redis = deps.makeRedis();
    clients.push(redis);
    expect((redis as unknown as { options: Record<string, unknown> }).options).toMatchObject({
      host: '10.0.0.7',
      port: 16383,
      password: 's3cret',
      db: 2,
    });
  });

  it('honours a `url` in the options for every client, not only the queues', async () => {
    // BullMQ reads `url` itself; ioredis ignores it, so the pub/sub and heartbeat clients used to
    // reach 127.0.0.1:6379 while the queues used the URL.
    const deps = await createBullMQDeps({
      url: 'redis://10.0.0.7:16384/3',
      lazyConnect: true,
    });
    const redis = deps.makeRedis();
    clients.push(redis);
    expect((redis as unknown as { options: Record<string, unknown> }).options).toMatchObject({
      host: '10.0.0.7',
      port: 16384,
      db: 3,
      lazyConnect: true,
    });
  });

  it('keeps the keys set next to a `url`, such as a TLS CA', async () => {
    const deps = await createBullMQDeps({
      url: 'rediss://10.0.0.7:16385',
      tls: { ca: 'my-ca' },
      db: 4,
      lazyConnect: true,
    });
    const redis = deps.makeRedis();
    clients.push(redis);
    expect((redis as unknown as { options: Record<string, unknown> }).options).toMatchObject({
      host: '10.0.0.7',
      port: 16385,
      db: 4,
      tls: { ca: 'my-ca' },
    });
  });

  it('rejects a malformed or non-redis URL instead of falling back', async () => {
    await expect(createBullMQDeps('')).rejects.toThrow(/Redis URL/);
    await expect(createBullMQDeps('http://localhost:6379')).rejects.toThrow(/redis:\/\//);
  });
});

describe('redisUrlToOptions', () => {
  it('maps host, port, credentials, db and TLS', () => {
    expect(redisUrlToOptions('redis://localhost')).toEqual({ host: 'localhost', port: 6379 });
    expect(redisUrlToOptions('rediss://user:p%40ss@cache.internal:6380/5')).toEqual({
      host: 'cache.internal',
      port: 6380,
      username: 'user',
      password: 'p@ss',
      db: 5,
      tls: {},
    });
  });

  it('refuses query parameters instead of dropping them', () => {
    expect(() => redisUrlToOptions('redis://localhost:6379?enableReadyCheck=false')).toThrow(
      /query/,
    );
  });

  it('rejects a non-numeric db', () => {
    expect(() => redisUrlToOptions('redis://localhost/abc')).toThrow(/db/);
  });
});
