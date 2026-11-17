import { afterAll, describe, expect, it } from 'vitest';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps, type RedisLike } from '../../../../src/transports/bullmq/deps.js';
import { backendUrl, uniqueRedisPrefix } from '../../../support/backends.js';

/**
 * The worker registry over a real Redis (gated on `DURABLE_REDIS_URL`, required in CI): the ioredis
 * command shapes the transport relies on (HSET/HGETALL/ZRANGEBYSCORE … '+inf'), the instances hash,
 * the keys written for older readers, the compatibility walk and the clean removal on close.
 */
const REDIS_URL = backendUrl('DURABLE_REDIS_URL');

const closers: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const c of closers) await Promise.resolve(c()).catch(() => {});
});

describe.skipIf(!REDIS_URL)('BullMQ worker registry over real Redis', () => {
  it('writes, reads and removes the registry hashes next to the per-instance keys', async () => {
    const prefix = uniqueRedisPrefix('durable-reg');
    const connection = { url: REDIS_URL } as unknown;
    const raw = (await createBullMQDeps(connection)).makeRedis() as RedisLike & {
      hgetall(key: string): Promise<Record<string, string>>;
      zrange(key: string, start: number, stop: number): Promise<string[]>;
      pttl(key: string): Promise<number>;
      quit(): Promise<unknown>;
    };
    closers.push(() => raw.disconnect());

    const worker = new BullMQTransport({
      deps: await createBullMQDeps(connection),
      prefix,
      instanceId: 'ts-worker',
      pingIntervalMs: false,
    });
    const engine = new BullMQTransport({
      deps: await createBullMQDeps(connection),
      prefix,
      instanceId: 'ts-engine',
      pingIntervalMs: false,
    });
    closers.push(() => engine.close());

    worker.handle('reg.charge', async () => ({}));
    worker.handle('reg.mail', async () => ({}));
    // An older writer: only its per-instance keys.
    await raw.set(
      `${prefix}-worker-heartbeat:reg.render:py-1`,
      JSON.stringify({ ts: Date.now() }),
      'EX',
      35,
    );
    await raw.set(
      `${prefix}-worker-descriptor:reg.render:py-1`,
      JSON.stringify({ instanceId: 'py-1' }),
      'EX',
      35,
    );
    // A store-less worker runtime writing through the transport's descriptor writer.
    const writer = worker.createDescriptorRedis();
    await writer.set(
      `${prefix}-worker-descriptor:reg.charge:ts-worker`,
      JSON.stringify({ instanceId: 'ts-worker' }),
      'EX',
      35,
    );

    await expect
      .poll(async () => (await engine.listWorkerGroups()).sort(), { timeout: 10_000 })
      .toEqual(['reg.charge', 'reg.mail', 'reg.render']);

    const hash = await raw.hgetall(`${prefix}-workers:heartbeats:reg.charge`);
    expect(Object.keys(hash)).toEqual(['ts-worker']);
    expect(JSON.parse(hash['ts-worker'] as string).expiresAt).toBeGreaterThan(Date.now());
    expect((await raw.zrange(`${prefix}-workers:tokens`, 0, -1)).sort()).toEqual([
      'reg.charge',
      'reg.mail',
    ]);
    expect(await raw.pttl(`${prefix}-workers:heartbeats:reg.charge`)).toBeGreaterThan(0);
    expect(await raw.get(`${prefix}-worker-heartbeat:reg.charge:ts-worker`)).not.toBeNull();

    expect((await engine.listWorkerDescriptors('reg.charge')).map((d) => d.instanceId)).toEqual([
      'ts-worker',
    ]);
    expect((await engine.listWorkerDescriptors('reg.render')).map((d) => d.instanceId)).toEqual([
      'py-1',
    ]);
    expect((await engine.readAllWorkerDescriptors()).map((d) => d.instanceId).sort()).toEqual([
      'py-1',
      'ts-worker',
    ]);

    await writer.del?.(`${prefix}-worker-descriptor:reg.charge:ts-worker`);
    writer.disconnect();
    await worker.close();
    expect(await raw.hgetall(`${prefix}-workers:heartbeats:reg.charge`)).toEqual({});
    expect(await raw.get(`${prefix}-worker-heartbeat:reg.charge:ts-worker`)).toBeNull();
    expect(await raw.hgetall(`${prefix}-workers:descriptors:reg.charge`)).toEqual({});
  }, 30_000);

  it('legacyWrites: false keeps the whole registry in one hash field per instance', async () => {
    const prefix = uniqueRedisPrefix('durable-reg');
    const connection = { url: REDIS_URL } as unknown;
    const raw = (await createBullMQDeps(connection)).makeRedis() as RedisLike & {
      hgetall(key: string): Promise<Record<string, string>>;
      keys(pattern: string): Promise<string[]>;
      pttl(key: string): Promise<number>;
    };
    closers.push(() => raw.disconnect());
    const options = { prefix, pingIntervalMs: false as const };
    const registry = { legacyWrites: false, legacyScan: false };
    const worker = new BullMQTransport({
      deps: await createBullMQDeps(connection),
      ...options,
      instanceId: 'ts-worker',
      workerRegistry: registry,
    });
    const engine = new BullMQTransport({
      deps: await createBullMQDeps(connection),
      ...options,
      instanceId: 'ts-engine',
      workerRegistry: registry,
    });
    closers.push(() => engine.close());
    for (let i = 0; i < 20; i += 1) worker.handle(`reg.step${i}`, async () => ({}));

    await expect
      .poll(async () => Object.keys(await raw.hgetall(`${prefix}-workers:instances`)).length, {
        timeout: 5_000,
      })
      .toBe(1);
    expect(await raw.keys(`${prefix}-worker*`)).toEqual([`${prefix}-workers:instances`]);
    expect(await raw.pttl(`${prefix}-workers:instances`)).toBeGreaterThan(0);
    // A fresh engine reads all 20 tokens back with one HGETALL.
    const reader = new BullMQTransport({
      deps: await createBullMQDeps(connection),
      ...options,
      instanceId: 'ts-reader',
      workerRegistry: registry,
    });
    closers.push(() => reader.close());
    expect((await reader.listWorkerGroups()).length).toBe(20);
    expect((await reader.groupHealth('reg.step3')).liveWorkers.map((w) => w.instanceId)).toEqual([
      'ts-worker',
    ]);

    await worker.close();
    expect(await raw.hgetall(`${prefix}-workers:instances`)).toEqual({});
  }, 30_000);
});
