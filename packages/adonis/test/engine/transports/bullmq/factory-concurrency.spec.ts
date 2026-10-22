import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import type {
  BullMQTransportConfig,
  TransportContext,
} from '../../../../src/transports/factory.js';
import { transports } from '../../../../src/transports/factory.js';

/**
 * `transports.bullmq({ concurrency })` from config/durable.ts down to the real BullMQ `Worker`
 * options, with `bullmq`/`ioredis` mocked: a number pins every consumer, adaptive starts the task
 * workers at `start` and leaves the other consumers at 1.
 */

const workers = vi.hoisted(() => [] as Array<{ name: string; concurrency: number }>);

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
    concurrency: number;
    constructor(name: string, _process: unknown, opts: { concurrency: number }) {
      this.name = name;
      this.concurrency = opts.concurrency;
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

async function build(concurrency: BullMQTransportConfig['concurrency']) {
  const transport = (await transports.bullmq({
    connection: { host: '127.0.0.1', port: 6379 },
    closeTimeoutMs: 0,
    ...(concurrency !== undefined ? { concurrency } : {}),
  })({} as TransportContext)) as BullMQTransport;
  transport.handle('charge', async () => 'ok');
  transport.onDecision(async () => {});
  const byName = (name: string) => workers.find((w) => w.name === name)?.concurrency;
  return {
    transport,
    task: () => byName('durable-tasks-charge'),
    decisions: () => byName('durable-decisions'),
  };
}

describe('transports.bullmq({ concurrency })', () => {
  beforeEach(() => {
    workers.length = 0;
  });

  it('a number pins the task and the other consumers', async () => {
    const { transport, task, decisions } = await build(6);
    expect([task(), decisions()]).toEqual([6, 6]);
    await transport.close();
  });

  it('unset runs every consumer at 1', async () => {
    const { transport, task, decisions } = await build(undefined);
    expect([task(), decisions()]).toEqual([1, 1]);
    await transport.close();
  });

  it("'adaptive' starts the task workers at min", async () => {
    const { transport, task, decisions } = await build('adaptive');
    expect([task(), decisions()]).toEqual([1, 1]);
    await transport.close();
  });

  it('an adaptive config starts the task workers at start, the other consumers at 1', async () => {
    const { transport, task, decisions } = await build({ mode: 'adaptive', min: 2, start: 3 });
    expect([task(), decisions()]).toEqual([3, 1]);
    await transport.close();
  });

  it('a non-finite adaptive min and start fall back to 1', async () => {
    const { transport, task } = await build({
      mode: 'adaptive',
      min: Number.NaN,
      start: Number.NaN,
    });
    expect(task()).toBe(1);
    await transport.close();
  });
});
