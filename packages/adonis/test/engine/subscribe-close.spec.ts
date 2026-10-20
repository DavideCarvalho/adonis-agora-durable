import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisAdmissionBackend } from '../../src/admission-redis/index.js';
import { RedisControlPlane } from '../../src/control-plane-redis/index.js';
import type { IoredisSubscriber } from '../../src/control-plane-redis/redis-control-plane.js';
import { BullMQTransport } from '../../src/transports/bullmq/bullmq-transport.js';
import type {
  BullMQDeps,
  QueueLike,
  RedisLike,
  WorkerLike,
} from '../../src/transports/bullmq/deps.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

/** A connection whose `subscribe` stays pending until `disconnect()`, then rejects like ioredis. */
class ConnectingSub {
  status = 'connecting';
  disconnected = false;
  private rejectSubscribe?: (e: Error) => void;
  subscribe() {
    return new Promise<never>((_, reject) => {
      this.rejectSubscribe = reject;
    });
  }
  publish() {
    return undefined;
  }
  on() {
    return this;
  }
  ping() {
    return Promise.resolve('PONG');
  }
  disconnect() {
    this.disconnected = true;
    this.rejectSubscribe?.(new Error('Connection is closed.'));
  }
}

let unhandled: unknown[] = [];
const onUnhandled = (r: unknown) => unhandled.push(r);
beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

describe('closing while pub/sub subscriptions are still connecting', () => {
  it('BullMQTransport: no unhandled rejection', async () => {
    const subs: ConnectingSub[] = [];
    const deps: BullMQDeps = {
      makeQueue: () =>
        ({ add: async () => 1, getJobCounts: async () => ({}), close: async () => 1 }) as QueueLike,
      makeWorker: () => ({ on: () => undefined, close: async () => 1 }) as WorkerLike,
      makeRedis: () => {
        const s = new ConnectingSub();
        subs.push(s);
        return s as unknown as RedisLike;
      },
    };
    const t = new BullMQTransport({ deps });
    t.onHeartbeat(async () => {});
    t.onRunReply(() => {});
    t.onTenantEvent('a', () => {});
    await t.close();
    await tick();
    expect(subs.every((s) => s.disconnected)).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it('RedisControlPlane: no unhandled rejection', async () => {
    const sub = new ConnectingSub();
    const plane = new RedisControlPlane({
      connection: {
        publish: () => undefined,
        subscribe: () => undefined,
        duplicate: () => sub as unknown as IoredisSubscriber,
      },
      pingIntervalMs: false,
    });
    plane.onControl(() => {});
    await plane.close();
    await tick();
    expect(sub.disconnected).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it('RedisAdmissionBackend: no unhandled rejection', async () => {
    const sub = new ConnectingSub();
    const redis = {
      defineCommand: () => undefined,
      set: async () => 'OK',
      duplicate: () => sub,
    };
    const backend = new RedisAdmissionBackend({ connection: redis as never });
    backend.onFreed(() => {});
    await backend.close();
    await tick();
    expect(sub.disconnected).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it('a subscribe failure while still open is logged, not thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const plane = new RedisControlPlane({
      connection: {
        publish: () => undefined,
        subscribe: () => undefined,
        duplicate: () =>
          ({
            status: 'ready',
            subscribe: () => Promise.reject(new Error('NOPERM')),
            publish: () => undefined,
            on: () => undefined,
            ping: async () => 'PONG',
            disconnect: () => undefined,
          }) as unknown as IoredisSubscriber,
      },
      pingIntervalMs: false,
    });
    plane.onControl(() => {});
    await tick();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOPERM'));
    expect(unhandled).toEqual([]);
    await plane.close();
    warn.mockRestore();
  });
});

describe('BullMQTransport.close() with a wedged worker', () => {
  function wedged(closeTimeoutMs?: number) {
    const closed: string[] = [];
    let disconnects = 0;
    const deps: BullMQDeps = {
      makeQueue: (n) =>
        ({
          add: async () => 1,
          getJobCounts: async () => ({}),
          close: async () => closed.push(n),
        }) as QueueLike,
      makeWorker: (n) =>
        ({
          on: () => undefined,
          close: n.includes('results') ? () => new Promise(() => {}) : async () => closed.push(n),
        }) as WorkerLike,
      makeRedis: () =>
        ({
          subscribe: async () => 1,
          on: () => undefined,
          publish: async () => 1,
          disconnect: () => {
            disconnects += 1;
          },
        }) as unknown as RedisLike,
    };
    const t = new BullMQTransport({
      deps,
      ...(closeTimeoutMs !== undefined ? { closeTimeoutMs } : {}),
    });
    return { t, closed, disconnects: () => disconnects };
  }

  it('returns after closeTimeoutMs, closes the other workers and still disconnects', async () => {
    const { t, closed, disconnects } = wedged(50);
    t.onHeartbeat(async () => {});
    t.onResult(async () => {});
    t.onStepEvent(async () => {});
    const started = Date.now();
    const outcome = await Promise.race([
      t.close().then(() => 'closed'),
      new Promise((r) => setTimeout(() => r('hung'), 3000)),
    ]);
    expect(outcome).toBe('closed');
    expect(Date.now() - started).toBeLessThan(1500);
    // Workers after the wedged one were still asked to close (concurrent, not sequential).
    expect(closed.length).toBeGreaterThan(0);
    expect(disconnects()).toBeGreaterThan(0);
  });

  it('closeTimeoutMs: 0 skips the graceful wait', async () => {
    const { t, disconnects } = wedged(0);
    t.onHeartbeat(async () => {});
    t.onResult(async () => {});
    await t.close();
    expect(disconnects()).toBeGreaterThan(0);
  });
});
