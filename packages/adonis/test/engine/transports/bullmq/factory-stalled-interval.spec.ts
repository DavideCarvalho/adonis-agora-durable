import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import type {
  BullMQTransportConfig,
  TransportContext,
} from '../../../../src/transports/factory.js';
import { transports } from '../../../../src/transports/factory.js';

/**
 * `transports.bullmq({ stalledInterval })` from config/durable.ts down to the real BullMQ `Worker`
 * options, with `bullmq`/`ioredis` mocked: every worker gets it, and unset (or an unusable value)
 * leaves BullMQ's own default by not passing the option at all.
 */

const workers = vi.hoisted(() => [] as Array<{ name: string; opts: Record<string, unknown> }>);

vi.mock('bullmq', () => ({
  Queue: class {
    async add() {}
    async close() {}
    async getJobCounts() {
      return {};
    }
  },
  Worker: class {
    readonly name: string;
    readonly opts: Record<string, unknown>;
    constructor(name: string, _process: unknown, opts: Record<string, unknown>) {
      this.name = name;
      this.opts = opts;
      workers.push(this);
    }
    on() {}
    async close() {}
  },
}));

vi.mock('ioredis', () => ({
  Redis: class {
    async set() {
      return 'OK';
    }
    async publish() {
      return 1;
    }
    async subscribe() {}
    on() {}
    disconnect() {}
  },
}));

async function build(stalledInterval: BullMQTransportConfig['stalledInterval']) {
  const transport = (await transports.bullmq({
    connection: { host: '127.0.0.1', port: 6379 },
    closeTimeoutMs: 0,
    ...(stalledInterval !== undefined ? { stalledInterval } : {}),
  })({} as TransportContext)) as BullMQTransport;
  transport.handle('charge', async () => 'ok');
  transport.handle('mail', async () => 'ok');
  transport.onDecision(async () => {});
  return transport;
}

describe('transports.bullmq({ stalledInterval })', () => {
  beforeEach(() => {
    workers.length = 0;
  });

  it('unset leaves BullMQ its own default on every worker', async () => {
    const transport = await build(undefined);
    expect(workers.length).toBeGreaterThan(2);
    expect(workers.every((w) => !('stalledInterval' in w.opts))).toBe(true);
    await transport.close();
  });

  it('passes a custom value to every worker', async () => {
    const transport = await build(120_000);
    expect(workers.length).toBeGreaterThan(2);
    expect([...new Set(workers.map((w) => w.opts.stalledInterval))]).toEqual([120_000]);
    await transport.close();
  });

  it('an unusable value leaves the default', async () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      workers.length = 0;
      const transport = await build(bad);
      expect(workers.every((w) => !('stalledInterval' in w.opts))).toBe(true);
      await transport.close();
    }
  });
});
