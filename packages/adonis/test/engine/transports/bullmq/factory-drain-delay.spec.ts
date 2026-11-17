import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import type {
  BullMQTransportConfig,
  TransportContext,
} from '../../../../src/transports/factory.js';
import { transports } from '../../../../src/transports/factory.js';

/**
 * `transports.bullmq({ drainDelay })` from config/durable.ts down to the real BullMQ `Worker`
 * options, with `bullmq`/`ioredis` mocked: every worker gets it, default 30 s, and an unusable
 * value falls back to the default.
 */

const workers = vi.hoisted(() => [] as Array<{ name: string; drainDelay: number }>);

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
    drainDelay: number;
    constructor(name: string, _process: unknown, opts: { drainDelay: number }) {
      this.name = name;
      this.drainDelay = opts.drainDelay;
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

async function build(drainDelay: BullMQTransportConfig['drainDelay']) {
  const transport = (await transports.bullmq({
    connection: { host: '127.0.0.1', port: 6379 },
    closeTimeoutMs: 0,
    ...(drainDelay !== undefined ? { drainDelay } : {}),
  })({} as TransportContext)) as BullMQTransport;
  transport.handle('charge', async () => 'ok');
  transport.onDecision(async () => {});
  return { transport, delays: () => [...new Set(workers.map((w) => w.drainDelay))] };
}

describe('transports.bullmq({ drainDelay })', () => {
  beforeEach(() => {
    workers.length = 0;
  });

  it('defaults every worker to 30 s', async () => {
    const { transport, delays } = await build(undefined);
    expect(workers.length).toBeGreaterThan(1);
    expect(delays()).toEqual([30]);
    await transport.close();
  });

  it('passes a custom value to every worker', async () => {
    const { transport, delays } = await build(12);
    expect(delays()).toEqual([12]);
    await transport.close();
  });

  it('an unusable value falls back to the default', async () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      workers.length = 0;
      const { transport, delays } = await build(bad);
      expect(delays()).toEqual([30]);
      await transport.close();
    }
  });
});
