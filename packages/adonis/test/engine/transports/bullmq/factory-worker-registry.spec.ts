import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import type { TransportContext } from '../../../../src/transports/factory.js';
import { transports } from '../../../../src/transports/factory.js';

/**
 * `transports.bullmq({ workerRegistry })` from config/durable.ts down to the transport, with
 * `bullmq`/`ioredis` mocked: `connection` gets its own Redis client for the hashes,
 * `legacyScan: false` turns the compatibility walk off and `legacyWrites: false` the keys older
 * readers read.
 */

const clients = vi.hoisted(
  () => [] as Array<{ options: Record<string, unknown>; scans: number; sets: number }>,
);

vi.mock('bullmq', () => ({
  Queue: class {
    async add() {}
    async close() {}
    async getJobCounts() {
      return {};
    }
  },
  Worker: class {
    on() {}
    async close() {}
  },
}));

vi.mock('ioredis', () => ({
  Redis: class {
    readonly options: Record<string, unknown>;
    scans = 0;
    sets = 0;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      clients.push(this);
    }
    async set() {
      this.sets += 1;
      return 'OK';
    }
    async scan() {
      this.scans += 1;
      return ['0', []];
    }
    async hset() {
      return 1;
    }
    async hgetall() {
      return {};
    }
    async hdel() {
      return 0;
    }
    async pexpire() {
      return 1;
    }
    async zadd() {
      return 1;
    }
    async zrangebyscore() {
      return [];
    }
    async zremrangebyscore() {
      return 0;
    }
    async publish() {
      return 1;
    }
    async subscribe() {}
    on() {}
    disconnect() {}
  },
}));

async function build(workerRegistry?: Parameters<typeof transports.bullmq>[0]['workerRegistry']) {
  return (await transports.bullmq({
    connection: { host: 'main.redis', port: 6379 },
    closeTimeoutMs: 0,
    ...(workerRegistry !== undefined ? { workerRegistry } : {}),
  })({} as TransportContext)) as BullMQTransport;
}

describe('transports.bullmq({ workerRegistry })', () => {
  beforeEach(() => {
    clients.length = 0;
  });

  it('`connection` puts the registry on its own Redis client', async () => {
    const transport = await build({ connection: { host: 'registry.redis', port: 6380 } });
    await transport.listWorkerDescriptors('charge');
    expect(clients.some((c) => c.options.host === 'registry.redis')).toBe(true);
    await transport.close();
  });

  it('without `connection` every client is on the main Redis', async () => {
    const transport = await build();
    await transport.listWorkerDescriptors('charge');
    expect(clients.every((c) => c.options.host === 'main.redis')).toBe(true);
    await transport.close();
  });

  it('`legacyScan: false` never walks the keyspace', async () => {
    const transport = await build({ legacyScan: false });
    await transport.listWorkerDescriptors('charge');
    await transport.readAllWorkerDescriptors();
    expect(clients.reduce((n, c) => n + c.scans, 0)).toBe(0);
    await transport.close();
  });

  it('the legacy walk is on by default', async () => {
    const transport = await build();
    await transport.listWorkerDescriptors('charge');
    expect(clients.reduce((n, c) => n + c.scans, 0)).toBeGreaterThan(0);
    await transport.close();
  });

  it("older readers' keys are written by default, and not with `legacyWrites: false`", async () => {
    const sets = () => clients.reduce((n, c) => n + c.sets, 0);
    const legacy = await build();
    legacy.handle('charge', async () => ({}));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sets()).toBeGreaterThan(0);
    await legacy.close();

    clients.length = 0;
    const current = await build({ legacyWrites: false, legacyWriteIntervalMs: 60_000 });
    current.handle('charge', async () => ({}));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sets()).toBe(0);
    await current.close();
  });
});
