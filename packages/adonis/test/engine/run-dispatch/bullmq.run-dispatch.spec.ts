import { afterAll, describe } from 'vitest';
import { runRunDispatchContract } from '../../../src/testing-kit/conformance.js';
import { BullMQTransport } from '../../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps } from '../../../src/transports/bullmq/deps.js';
import { backendUrl, deleteRedisKeys, uniqueRedisPrefix } from '../../support/backends.js';

// The run queue of the BullMQ transport (`${P}-runs`) over a real Redis: skipped locally without
// DURABLE_REDIS_URL, required in CI.
const REDIS_URL = backendUrl('DURABLE_REDIS_URL');

describe.skipIf(!REDIS_URL)('bullmq transport over real Redis', () => {
  let prefix = '';
  const prefixes: string[] = [];
  afterAll(async () => {
    const deps = await createBullMQDeps(REDIS_URL as string);
    const redis = deps.makeRedis() as unknown as Parameters<typeof deleteRedisKeys>[0] & {
      quit(): Promise<unknown>;
    };
    for (const p of prefixes) await deleteRedisKeys(redis, p);
    await redis.quit();
  });
  runRunDispatchContract('BullMQTransport', {
    setup: () => {
      prefix = uniqueRedisPrefix('durable-runs');
      prefixes.push(prefix);
    },
    make: async () =>
      new BullMQTransport({
        deps: await createBullMQDeps(REDIS_URL as string),
        prefix,
        closeTimeoutMs: 2_000,
      }),
  });
});
