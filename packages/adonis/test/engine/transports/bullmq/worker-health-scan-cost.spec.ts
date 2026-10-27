import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../../../src/engine.js';
import { InMemoryStateStore } from '../../../../src/testing/in-memory-state-store.js';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import type {
  BullMQDeps,
  QueueLike,
  RedisLike,
  WorkerLike,
} from '../../../../src/transports/bullmq/deps.js';
import { cachedLiveKeys, type WorkerKeyStore } from '../../../../src/transports/worker-keys.js';

// ---------------------------------------------------------------------------
// The dashboard's `/workers` and `/metrics` both go through `engine.workerHealth()`, which asks the
// transport for its worker groups and then for every group's health. The worker-heartbeat keys share
// the Redis db with every BullMQ job hash, so each `MATCH ${P}-worker-heartbeat:*` SCAN walks the
// whole keyspace. These specs pin the cost of that path in SCAN round trips, with a fake Redis that
// pages its keyspace like a real one does (one page per `COUNT` keys visited).
// ---------------------------------------------------------------------------

class PagingRedis implements RedisLike {
  store = new Map<string, string>();
  scanCalls = 0;
  countHints: number[] = [];
  /** Delays every SCAN a turn, so concurrent callers really overlap. */
  async scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]> {
    this.scanCalls += 1;
    await new Promise((resolve) => setImmediate(resolve));
    const pattern = String(args[1] ?? '*');
    const count = Number(args[3] ?? 10);
    this.countHints.push(count);
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    const all = [...this.store.keys()];
    const from = Number(cursor);
    const page = all.slice(from, from + count);
    const next = from + count >= all.length ? '0' : String(from + count);
    return [next, page.filter((k) => k.startsWith(prefix))];
  }
  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.store.get(k) ?? null);
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return 'OK';
  }
  async publish(): Promise<unknown> {
    return 1;
  }
  async subscribe(): Promise<unknown> {
    return 1;
  }
  on(): unknown {
    return this;
  }
  disconnect(): void {}
}

class CountingQueue implements QueueLike {
  async add(): Promise<unknown> {
    return { id: '1' };
  }
  async getJobCounts(...types: string[]): Promise<Record<string, number>> {
    return Object.fromEntries(types.map((t) => [t, 1]));
  }
  async close(): Promise<unknown> {
    return undefined;
  }
}

function broker(redis: PagingRedis): BullMQDeps {
  return {
    makeQueue: () => new CountingQueue(),
    makeWorker: () =>
      ({
        on() {
          return this;
        },
        async close() {},
      }) as unknown as WorkerLike,
    makeRedis: () => redis,
  };
}

const GROUPS = ['payments-charge', 'mail-send', 'pipeline', 'reports'];
const JOB_KEYS = 6_000;

/** A keyspace like the measured one: thousands of BullMQ job hashes, plus 3 live pods per group. */
function seededRedis(): PagingRedis {
  const redis = new PagingRedis();
  for (let i = 0; i < JOB_KEYS; i += 1) redis.store.set(`bull:durable-results:${i}`, '{}');
  for (const group of GROUPS) {
    for (let pod = 0; pod < 3; pod += 1) {
      redis.store.set(
        `durable-worker-heartbeat:${group}:pod-${pod}`,
        JSON.stringify({ ts: 1_700_000_000_000 }),
      );
    }
  }
  return redis;
}

/** SCAN calls one walk of the seeded keyspace takes at `count` keys per call. */
const walk = (redis: PagingRedis, count: number) => Math.ceil(redis.store.size / count);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BullMQ worker health — SCAN cost', () => {
  it('engine.workerHealth() walks the heartbeat keyspace ONCE for every group, at COUNT >= 1000', async () => {
    const redis = seededRedis();
    const transport = new BullMQTransport({ deps: broker(redis), instanceId: 'dash' });
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });

    const health = await engine.workerHealth();

    // Same answer as before: every group, each with its own three pods and its queue depth.
    expect(health.map((h) => h.group).sort()).toEqual([...GROUPS].sort());
    for (const h of health) {
      expect(h.depth).toBe(4);
      expect(h.liveWorkers.map((w) => w.instanceId)).toEqual(['pod-0', 'pod-1', 'pod-2']);
      expect(h.liveWorkers.every((w) => w.group === h.group)).toBe(true);
    }
    expect(Math.min(...redis.countHints)).toBeGreaterThanOrEqual(1_000);
    // One walk — not one for listWorkerGroups plus one more per group (5 walks at COUNT 100 = 305).
    expect(redis.scanCalls).toBe(walk(redis, 1_000));
  });

  it('concurrent workerHealth() calls share one walk, and the read is reused briefly', async () => {
    const redis = seededRedis();
    const transport = new BullMQTransport({ deps: broker(redis), instanceId: 'dash' });
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });

    await Promise.all(Array.from({ length: 10 }, () => engine.workerHealth()));
    expect(redis.scanCalls).toBe(walk(redis, 1_000));

    // A poll right after reuses the read …
    await engine.workerHealth();
    expect(redis.scanCalls).toBe(walk(redis, 1_000));

    // … and once it is older than the reuse window (well under the 35s key TTL) a new walk sees changes.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 1_500);
    redis.store.delete('durable-worker-heartbeat:reports:pod-2');
    const fresh = await engine.workerHealth();
    expect(redis.scanCalls).toBe(2 * walk(redis, 1_000));
    expect(fresh.find((h) => h.group === 'reports')?.liveWorkers).toHaveLength(2);
  });

  it('a freshly registered handler shows up at once, even over a cached read', async () => {
    const redis = seededRedis();
    const transport = new BullMQTransport({ deps: broker(redis), instanceId: 'self' });
    expect(await transport.listWorkerGroups()).not.toContain('fresh');

    transport.handle('fresh', async () => {});
    // Let the first heartbeat SET land.
    await new Promise((resolve) => setImmediate(resolve));

    expect(await transport.listWorkerGroups()).toContain('fresh');
    const health = await transport.groupHealth('fresh');
    expect(health.liveWorkers.map((w) => w.instanceId)).toEqual(['self']);
  });

  it('a failed walk is not cached: the next read retries', async () => {
    const redis = seededRedis();
    const transport = new BullMQTransport({ deps: broker(redis), instanceId: 'dash' });
    const scan = redis.scan.bind(redis);
    vi.spyOn(redis, 'scan').mockRejectedValueOnce(new Error('redis down'));
    await expect(transport.listWorkerGroups()).rejects.toThrow('redis down');
    vi.spyOn(redis, 'scan').mockImplementation(scan);
    expect((await transport.listWorkerGroups()).sort()).toEqual([...GROUPS].sort());
  });
});

describe('cachedLiveKeys (queue / db transports)', () => {
  it('concurrent reads on an expired cache share one store read', async () => {
    let reads = 0;
    const store: WorkerKeyStore = {
      put: async () => {},
      remove: async () => {},
      live: async () => {
        reads += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return [{ key: 'durable-worker-heartbeat:g:i', value: '{}' }];
      },
    };
    let clock = 0;
    const live = cachedLiveKeys(store, 5_000, () => clock);

    const all = await Promise.all(Array.from({ length: 8 }, () => live()));
    expect(reads).toBe(1);
    expect(all.every((entries) => entries.length === 1)).toBe(true);

    clock = 6_000;
    await Promise.all([live(), live()]);
    expect(reads).toBe(2);
  });
});
