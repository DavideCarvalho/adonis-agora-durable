import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import type {
  BullMQDeps,
  QueueLike,
  RedisLike,
  WorkerLike,
} from '../../../../src/transports/bullmq/deps.js';

/**
 * The pub/sub subscriber watchdog, exercised server-free. A subscriber connection never writes on
 * its own, so a silently-dropped TCP connection is invisible to ioredis: the watchdog's PING is the
 * only thing that surfaces it, and on a rejection or timeout it must `disconnect(true)` so ioredis
 * reconnects and `autoResubscribe` restores the channel. The real-Redis counterpart lives in
 * `bullmq-subscriber-heal.integration.spec.ts`.
 */

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, budgetMs = 1_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!cond() && Date.now() < deadline) await delay(2);
}

/** An EventEmitter-backed client: like ioredis, an `error` with no listener throws. */
class FakeSub extends EventEmitter {
  status = 'ready';
  pings = 0;
  disconnects: boolean[] = [];
  pingImpl: () => Promise<unknown> = async () => 'PONG';
  async publish(): Promise<unknown> {
    return 1;
  }
  async subscribe(): Promise<unknown> {
    return 1;
  }
  async set(): Promise<unknown> {
    return 'OK';
  }
  async scan(): Promise<[string, string[]]> {
    return ['0', []];
  }
  async get(): Promise<string | null> {
    return null;
  }
  ping(): Promise<unknown> {
    this.pings += 1;
    return this.pingImpl();
  }
  disconnect(reconnect?: boolean): void {
    this.disconnects.push(reconnect === true);
  }
}

function brokerWith(clients: FakeSub[]): BullMQDeps {
  const queue: QueueLike = {
    add: async () => undefined,
    getJobCounts: async () => ({}),
    close: async () => undefined,
  };
  const worker: WorkerLike = { on: () => undefined, close: async () => undefined };
  return {
    makeQueue: () => queue,
    makeWorker: () => worker,
    makeRedis: () => {
      const c = new FakeSub();
      clients.push(c);
      return c as unknown as RedisLike;
    },
  };
}

function transport(pingIntervalMs: number | false = 10) {
  const clients: FakeSub[] = [];
  const t = new BullMQTransport({ deps: brokerWith(clients), pingIntervalMs });
  return { t, clients };
}

describe('BullMQTransport subscriber watchdog', () => {
  it('reconnects the heartbeat, run-reply and tenant-event subscribers whose PING rejects', async () => {
    const { t, clients } = transport();
    t.onHeartbeat(async () => {});
    t.onRunReply(() => {});
    t.onTenantEvent('acme', () => {});
    expect(clients).toHaveLength(3);
    for (const c of clients) c.pingImpl = () => Promise.reject(new Error('connection is closed'));

    await until(() => clients.every((c) => c.disconnects.length > 0));
    for (const c of clients) expect(c.disconnects[0]).toBe(true);
    await t.close();
  });

  it('reconnects a subscriber whose PING hangs (timeout, not rejection)', async () => {
    const { t, clients } = transport();
    t.onRunReply(() => {});
    const [sub] = clients;
    if (!sub) throw new Error('no subscriber');
    sub.pingImpl = () => new Promise(() => {});

    await until(() => sub.disconnects.length > 0);
    expect(sub.disconnects[0]).toBe(true);
    await t.close();
  });

  it('leaves a healthy subscriber alone', async () => {
    const { t, clients } = transport();
    t.onRunReply(() => {});
    const [sub] = clients;
    if (!sub) throw new Error('no subscriber');

    await until(() => sub.pings >= 3);
    expect(sub.pings).toBeGreaterThanOrEqual(3);
    expect(sub.disconnects).toEqual([]);
    await t.close();
  });

  it('runs one shared interval for every subscriber', async () => {
    const { t, clients } = transport();
    t.onHeartbeat(async () => {});
    t.onRunReply(() => {});
    t.onTenantEvent('a', () => {});
    t.onTenantEvent('b', () => {}); // shares the tenant-event subscriber
    expect(clients).toHaveLength(3);
    await until(() => clients.every((c) => c.pings >= 2));
    expect(clients.every((c) => c.pings >= 2)).toBe(true);
    await t.close();
  });

  it('does not ping a subscriber that is mid-reconnect', async () => {
    const { t, clients } = transport();
    t.onRunReply(() => {});
    const [sub] = clients;
    if (!sub) throw new Error('no subscriber');
    sub.status = 'reconnecting';
    await delay(50);
    expect(sub.pings).toBe(0);
    await t.close();
  });

  it('pingIntervalMs: false (or 0) disables the watchdog', async () => {
    for (const off of [false, 0] as const) {
      const { t, clients } = transport(off);
      t.onRunReply(() => {});
      await delay(40);
      expect(clients[0]?.pings).toBe(0);
      await t.close();
    }
  });

  it('attaches an error listener so a subscriber error never goes unhandled', async () => {
    const { t, clients } = transport(false);
    t.onHeartbeat(async () => {});
    t.onRunReply(() => {});
    t.onTenantEvent('acme', () => {});
    for (const c of clients) {
      expect(c.listenerCount('error')).toBeGreaterThan(0);
      expect(() => c.emit('error', new Error('ECONNRESET'))).not.toThrow();
    }
    await t.close();
  });

  it('routes subscriber errors to onError, once per reconnect burst', async () => {
    const clients: FakeSub[] = [];
    const errors: unknown[] = [];
    const t = new BullMQTransport({
      deps: brokerWith(clients),
      pingIntervalMs: false,
      onError: (err) => errors.push(err),
    });
    t.onRunReply(() => {});
    const [sub] = clients;
    if (!sub) throw new Error('no subscriber');
    sub.emit('error', new Error('ECONNRESET'));
    sub.emit('error', new Error('ECONNREFUSED'));
    expect(errors).toHaveLength(1);
    sub.emit('ready');
    sub.emit('error', new Error('ETIMEDOUT'));
    expect(errors).toHaveLength(2);
    await t.close();
  });

  it('a ping still in flight when close() lands does not resurrect the subscriber', async () => {
    const { t, clients } = transport();
    t.onRunReply(() => {});
    const [sub] = clients;
    if (!sub) throw new Error('no subscriber');
    sub.pingImpl = () => new Promise(() => {});
    await until(() => sub.pings > 0);

    await t.close();
    await delay(60);
    expect(sub.disconnects).not.toContain(true);
  });
});
