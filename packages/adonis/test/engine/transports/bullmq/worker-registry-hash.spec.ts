import { afterEach, describe, expect, it, vi } from 'vitest';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import type {
  BullMQDeps,
  QueueLike,
  RedisLike,
  WorkerLike,
} from '../../../../src/transports/bullmq/deps.js';

// ---------------------------------------------------------------------------
// The worker registry: one hash per routing token (heartbeats, descriptors) indexed by a sorted set,
// written next to the per-instance keys. Readers must not walk the keyspace per token or per dispatch;
// the per-instance keys of older writers are read by one shared, throttled walk.
// ---------------------------------------------------------------------------

type Value = string | Map<string, string> | Map<string, number>;

/** A fake Redis holding strings, hashes and sorted sets, paging SCAN like a real one and counting
 *  every command. `hashless` hides the hash/sorted-set commands (a reader on an older version). */
class FakeRedis implements RedisLike {
  readonly data: Map<string, Value>;
  readonly ttl = new Map<string, number>();
  readonly calls = new Map<string, number>();
  constructor(data = new Map<string, Value>()) {
    this.data = data;
  }
  #count(cmd: string): void {
    this.calls.set(cmd, (this.calls.get(cmd) ?? 0) + 1);
  }
  n(cmd: string): number {
    return this.calls.get(cmd) ?? 0;
  }
  total(): number {
    return [...this.calls.values()].reduce((a, b) => a + b, 0);
  }
  #hash(key: string): Map<string, string> {
    let h = this.data.get(key);
    if (!(h instanceof Map)) {
      h = new Map<string, string>();
      this.data.set(key, h);
    }
    return h as Map<string, string>;
  }
  async scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]> {
    this.#count('scan');
    const prefix = String(args[1]).slice(0, -1);
    const count = Number(args[3]);
    const all = [...this.data.keys()];
    const from = Number(cursor);
    const next = from + count >= all.length ? '0' : String(from + count);
    return [next, all.slice(from, from + count).filter((k) => k.startsWith(prefix))];
  }
  async mget(...keys: string[]): Promise<(string | null)[]> {
    this.#count('mget');
    return keys.map((k) => {
      const v = this.data.get(k);
      return typeof v === 'string' ? v : null;
    });
  }
  async get(key: string): Promise<string | null> {
    this.#count('get');
    const v = this.data.get(key);
    return typeof v === 'string' ? v : null;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.#count('set');
    this.data.set(key, value);
    return 'OK';
  }
  async del(...keys: string[]): Promise<number> {
    this.#count('del');
    let n = 0;
    for (const k of keys) if (this.data.delete(k)) n += 1;
    return n;
  }
  async hset(key: string, field: string, value: string): Promise<number> {
    this.#count('hset');
    const h = this.#hash(key);
    const added = h.has(field) ? 0 : 1;
    h.set(field, value);
    return added;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    this.#count('hgetall');
    const h = this.data.get(key);
    return h instanceof Map ? Object.fromEntries(h as Map<string, string>) : {};
  }
  async hdel(key: string, ...fields: string[]): Promise<number> {
    this.#count('hdel');
    const h = this.data.get(key);
    if (!(h instanceof Map)) return 0;
    let n = 0;
    for (const f of fields) if (h.delete(f)) n += 1;
    if (h.size === 0) this.data.delete(key);
    return n;
  }
  async pexpire(key: string, ms: number): Promise<number> {
    this.#count('pexpire');
    this.ttl.set(key, ms);
    return this.data.has(key) ? 1 : 0;
  }
  async zadd(key: string, score: number, member: string): Promise<unknown> {
    this.#count('zadd');
    let z = this.data.get(key);
    if (!(z instanceof Map)) {
      z = new Map<string, number>();
      this.data.set(key, z);
    }
    (z as Map<string, number>).set(member, score);
    return 1;
  }
  async zrangebyscore(key: string, min: number | string): Promise<string[]> {
    this.#count('zrangebyscore');
    const z = this.data.get(key);
    if (!(z instanceof Map)) return [];
    return [...(z as Map<string, number>)].filter(([, s]) => s >= Number(min)).map(([m]) => m);
  }
  async zremrangebyscore(
    key: string,
    _min: number | string,
    max: number | string,
  ): Promise<number> {
    this.#count('zremrangebyscore');
    const z = this.data.get(key);
    if (!(z instanceof Map)) return 0;
    let n = 0;
    for (const [m, s] of [...(z as Map<string, number>)]) {
      if (s <= Number(max)) {
        (z as Map<string, number>).delete(m);
        n += 1;
      }
    }
    return n;
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

/** The same keyspace seen by a client without hash commands: an older reader or writer. */
function hashless(redis: FakeRedis): RedisLike {
  const old = new FakeRedis(redis.data);
  return Object.assign(old, {
    hset: undefined,
    hgetall: undefined,
    hdel: undefined,
    pexpire: undefined,
    zadd: undefined,
    zrangebyscore: undefined,
    zremrangebyscore: undefined,
  }) as unknown as RedisLike;
}

class NullQueue implements QueueLike {
  async add(): Promise<unknown> {
    return { id: '1' };
  }
  async getJobCounts(...types: string[]): Promise<Record<string, number>> {
    return Object.fromEntries(types.map((t) => [t, 0]));
  }
  async close(): Promise<unknown> {
    return undefined;
  }
}

function deps(redis: RedisLike): BullMQDeps {
  return {
    makeQueue: () => new NullQueue(),
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

function transport(redis: RedisLike, extra: Record<string, unknown> = {}): BullMQTransport {
  return new BullMQTransport({
    deps: deps(redis),
    instanceId: 'self',
    pingIntervalMs: false,
    closeTimeoutMs: 100,
    ...extra,
  });
}

/** Thousands of unrelated keys (sessions, cache, jobs), like the production db. */
function crowded(redis: FakeRedis, n = 5_000): FakeRedis {
  for (let i = 0; i < n; i += 1) redis.data.set(`session:${i}`, '{}');
  return redis;
}

const descriptor = (instanceId: string) => JSON.stringify({ instanceId, capabilities: [] });
const beat = (ts = Date.now()) => JSON.stringify({ ts });
const field = (value: string, expiresAt: number) => JSON.stringify({ expiresAt, value });
const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BullMQ worker registry hashes', () => {
  it('a worker writes its heartbeat to the per-instance key AND its token hash, indexed', async () => {
    const redis = new FakeRedis();
    const worker = transport(redis);
    worker.handle('charge', async () => ({}));
    await flush();

    expect(typeof redis.data.get('durable-worker-heartbeat:charge:self')).toBe('string');
    const hash = redis.data.get('durable-workers:heartbeats:charge') as Map<string, string>;
    const stored = JSON.parse(hash.get('self') as string) as { expiresAt: number; value: string };
    expect(stored.expiresAt).toBeGreaterThan(Date.now() + 30_000);
    expect(JSON.parse(stored.value).ts).toBeTypeOf('number');
    expect([...(redis.data.get('durable-workers:tokens') as Map<string, number>).keys()]).toEqual([
      'charge',
    ]);
    // The hash and the index carry a TTL, so a token nobody writes any more disappears.
    expect(redis.ttl.get('durable-workers:heartbeats:charge')).toBeGreaterThan(0);
    expect(redis.ttl.get('durable-workers:tokens')).toBeGreaterThan(0);
    await worker.close();
  });

  it('an old reader (per-instance keys only) still sees a new writer', async () => {
    const redis = new FakeRedis();
    const worker = transport(redis);
    worker.handle('charge', async () => ({}));
    await flush();

    const oldReader = transport(hashless(redis), { instanceId: 'dash' });
    expect(await oldReader.listWorkerGroups()).toEqual(['charge']);
    const health = await oldReader.groupHealth('charge');
    expect(health.liveWorkers.map((w) => w.instanceId)).toEqual(['self']);
    await worker.close();
  });

  it('a new reader sees an old writer through the compatibility walk', async () => {
    const redis = crowded(new FakeRedis());
    redis.data.set('durable-worker-heartbeat:render:py-1', beat());
    redis.data.set('durable-worker-descriptor:render:py-1', descriptor('py-1'));
    const reader = transport(redis, { instanceId: 'dash' });

    expect(await reader.listWorkerGroups()).toEqual(['render']);
    expect((await reader.listWorkerDescriptors('render')).map((d) => d.instanceId)).toEqual([
      'py-1',
    ]);
    expect((await reader.readAllWorkerDescriptors()).map((d) => d.instanceId)).toEqual(['py-1']);
    expect((await reader.readAllWorkerHeartbeats()).map((h) => h.instanceId)).toEqual(['py-1']);
    // Heartbeats and descriptors came from ONE walk, shared by every read above.
    expect(redis.n('scan')).toBe(Math.ceil(redis.data.size / 1_000));
  });

  it('merges hash fields and walked keys, the hash field winning for the same instance', async () => {
    const redis = new FakeRedis();
    const now = Date.now();
    redis.data.set(
      'durable-workers:descriptors:render',
      new Map([['new-1', field(descriptor('new-1'), now + 30_000)]]),
    );
    redis.data.set('durable-workers:tokens', new Map([['render', now + 600_000]]));
    redis.data.set('durable-worker-descriptor:render:new-1', descriptor('stale-copy'));
    redis.data.set('durable-worker-descriptor:render:old-1', descriptor('old-1'));
    const reader = transport(redis, { instanceId: 'dash' });

    const ids = (await reader.listWorkerDescriptors('render')).map((d) => d.instanceId).sort();
    expect(ids).toEqual(['new-1', 'old-1']);
  });

  it('skips a field past its expiresAt, and a malformed one', async () => {
    const redis = new FakeRedis();
    const now = Date.now();
    redis.data.set(
      'durable-workers:heartbeats:charge',
      new Map([
        ['live', field(beat(now), now + 30_000)],
        ['dead', field(beat(now - 60_000), now - 1)],
        ['junk', '{nope'],
      ]),
    );
    redis.data.set('durable-workers:tokens', new Map([['charge', now + 600_000]]));
    const reader = transport(redis, { instanceId: 'dash', workerRegistry: { legacyScan: false } });

    const health = await reader.groupHealth('charge');
    expect(health.liveWorkers.map((w) => w.instanceId)).toEqual(['live']);
  });

  it('a writer prunes expired fields and stale index entries, not on every beat', async () => {
    const redis = new FakeRedis();
    const now = Date.now();
    redis.data.set(
      'durable-workers:heartbeats:charge',
      new Map([['gone', field(beat(now - 60_000), now - 1)]]),
    );
    redis.data.set(
      'durable-workers:tokens',
      new Map([
        ['charge', now + 600_000],
        ['retired', now - 1],
      ]),
    );
    const worker = transport(redis);
    worker.handle('charge', async () => ({}));
    await flush();

    const hash = redis.data.get('durable-workers:heartbeats:charge') as Map<string, string>;
    expect([...hash.keys()]).toEqual(['self']);
    expect([...(redis.data.get('durable-workers:tokens') as Map<string, number>).keys()]).toEqual([
      'charge',
    ]);

    // Steady beats are one SET and one HSET; the upkeep (TTL, index, prune) waits its interval.
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      const fresh = transport(redis, { instanceId: 'other' });
      fresh.handle('mail', async () => ({}));
      await flush();
      const before = { hgetall: redis.n('hgetall'), zadd: redis.n('zadd'), hset: redis.n('hset') };
      vi.advanceTimersByTime(10_000);
      await flush();
      expect(redis.n('hset') - before.hset).toBe(1);
      expect(redis.n('hgetall')).toBe(before.hgetall);
      expect(redis.n('zadd')).toBe(before.zadd);
      // Five minutes later the next beat sees to the hash again.
      const at = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(at + 5 * 60_000);
      vi.advanceTimersByTime(10_000);
      await flush();
      expect(redis.n('hgetall')).toBe(before.hgetall + 1);
      expect(redis.n('zadd')).toBe(before.zadd + 1);
      await fresh.close();
    } finally {
      vi.useRealTimers();
    }
    await worker.close();
  });

  it('close() removes its own fields and per-instance keys, and leaves other instances alone', async () => {
    const redis = new FakeRedis();
    const peer = transport(redis, { instanceId: 'peer' });
    peer.handle('charge', async () => ({}));
    const worker = transport(redis);
    worker.handle('charge', async () => ({}));
    await flush();

    await worker.close();
    const hash = redis.data.get('durable-workers:heartbeats:charge') as Map<string, string>;
    expect([...hash.keys()]).toEqual(['peer']);
    expect(redis.data.has('durable-worker-heartbeat:charge:self')).toBe(false);
    expect(redis.data.has('durable-worker-heartbeat:charge:peer')).toBe(true);
    await peer.close();
  });

  it('own freshly registered handler is visible at once, despite a cached read', async () => {
    const redis = new FakeRedis();
    const t = transport(redis);
    expect(await t.listWorkerGroups()).toEqual([]);
    t.handle('charge', async () => ({}));
    await flush();
    expect(await t.listWorkerGroups()).toEqual(['charge']);
    await t.close();
  });

  it('many tokens with zero descriptors: one HGETALL per token per window, never a SCAN per token', async () => {
    const redis = crowded(new FakeRedis());
    const engineSide = transport(redis, { instanceId: 'engine' });
    const tokens = Array.from({ length: 78 }, (_, i) => `step-${i}`);
    const walk = Math.ceil(redis.data.size / 1_000);

    // A dispatch-heavy loop: every token asked many times.
    for (let round = 0; round < 20; round += 1) {
      await Promise.all(tokens.map((t) => engineSide.listWorkerDescriptors(t)));
    }
    expect(redis.n('scan')).toBe(walk); // ONE compatibility walk for every token and round
    expect(redis.n('hgetall')).toBe(tokens.length);

    // Past the descriptor reuse window: another HGETALL per token, still no walk (throttled to 60s).
    const at = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(at + 6_000);
    await Promise.all(tokens.map((t) => engineSide.listWorkerDescriptors(t)));
    expect(redis.n('scan')).toBe(walk);
    expect(redis.n('hgetall')).toBe(2 * tokens.length);
    // `fresh` (the engine's re-read before it parks a run) re-reads the hash, not the keyspace.
    await engineSide.listWorkerDescriptors('step-0', { fresh: true });
    expect(redis.n('scan')).toBe(walk);
  });

  it('the compatibility walk runs at most once per legacyScanIntervalMs, serving the last walk meanwhile', async () => {
    const redis = crowded(new FakeRedis(), 2_000);
    redis.data.set('durable-worker-descriptor:render:py-1', descriptor('py-1'));
    const reader = transport(redis, {
      instanceId: 'dash',
      workerRegistry: { legacyScanIntervalMs: 30_000 },
    });
    const walk = Math.ceil(redis.data.size / 1_000);
    const at = Date.now();
    const clock = vi.spyOn(Date, 'now');

    await reader.readAllWorkerDescriptors();
    expect(redis.n('scan')).toBe(walk);
    clock.mockReturnValue(at + 29_000);
    await reader.readAllWorkerDescriptors();
    await reader.readAllWorkerHeartbeats();
    expect(redis.n('scan')).toBe(walk);

    // Due: the reader is answered from the last walk while the next one runs behind it.
    redis.data.set('durable-worker-descriptor:render:py-2', descriptor('py-2'));
    clock.mockReturnValue(at + 31_000);
    expect((await reader.readAllWorkerDescriptors()).map((d) => d.instanceId)).toEqual(['py-1']);
    const next = walk + Math.ceil(redis.data.size / 1_000);
    await vi.waitFor(() => expect(redis.n('scan')).toBe(next));
    await flush();
    expect((await reader.readAllWorkerDescriptors()).map((d) => d.instanceId).sort()).toEqual([
      'py-1',
      'py-2',
    ]);
  });

  it('legacyScan: false never walks the keyspace', async () => {
    const redis = crowded(new FakeRedis());
    redis.data.set('durable-worker-descriptor:render:py-1', descriptor('py-1'));
    const reader = transport(redis, { instanceId: 'dash', workerRegistry: { legacyScan: false } });

    expect(await reader.listWorkerDescriptors('render')).toEqual([]);
    expect(await reader.readAllWorkerDescriptors()).toEqual([]);
    expect(await reader.listWorkerGroups()).toEqual([]);
    expect(redis.n('scan')).toBe(0);
  });

  it('drops a walked heartbeat whose own TTL ended since the walk', async () => {
    const redis = new FakeRedis();
    redis.data.set('durable-worker-heartbeat:render:py-1', beat());
    const reader = transport(redis, { instanceId: 'dash' });
    expect(await reader.listWorkerGroups()).toEqual(['render']);

    const at = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(at + 40_000);
    // Inside the 60s walk interval, but the beat is older than its 35s TTL.
    expect(await reader.listWorkerGroups()).toEqual([]);
  });

  it('the worker runtime writer mirrors its keys into the hashes, and removes them on stop', async () => {
    const redis = new FakeRedis();
    const t = transport(redis, { workerRegistry: { legacyScan: false } });
    const writer = t.createDescriptorRedis();

    await writer.set('durable-worker-descriptor:render:pod-1', descriptor('pod-1'), 'EX', 35);
    await writer.set('durable-worker-heartbeat:render:pod-1', beat(), 'EX', 35);
    expect(typeof redis.data.get('durable-worker-descriptor:render:pod-1')).toBe('string');
    expect((await t.listWorkerDescriptors('render')).map((d) => d.instanceId)).toEqual(['pod-1']);
    expect(await t.listWorkerGroups()).toEqual(['render']);

    await writer.del?.(
      'durable-worker-descriptor:render:pod-1',
      'durable-worker-heartbeat:render:pod-1',
    );
    expect(redis.data.has('durable-workers:descriptors:render')).toBe(false);
    expect(redis.data.has('durable-worker-descriptor:render:pod-1')).toBe(false);
    expect(await t.listWorkerDescriptors('render', { fresh: true })).toEqual([]);
    expect(await t.listWorkerGroups()).toEqual([]);
  });

  it('workerRegistry.makeRedis puts the hashes on their own connection, the keys stay put', async () => {
    const main = new FakeRedis();
    const registry = new FakeRedis();
    const worker = transport(main, { workerRegistry: { makeRedis: () => registry } });
    worker.handle('charge', async () => ({}));
    await flush();

    expect(main.data.has('durable-worker-heartbeat:charge:self')).toBe(true);
    expect(main.data.has('durable-workers:heartbeats:charge')).toBe(false);
    expect(registry.data.has('durable-workers:heartbeats:charge')).toBe(true);

    const reader = transport(main, {
      instanceId: 'dash',
      workerRegistry: { makeRedis: () => registry, legacyScan: false },
    });
    expect(await reader.listWorkerGroups()).toEqual(['charge']);
    await worker.close();
  });

  it('dispatches are untouched: a run in progress does not depend on the registry', async () => {
    const redis = new FakeRedis();
    const t = transport(redis);
    const before = redis.total();
    await t.dispatch({
      kind: 'step',
      runId: 'r',
      stepId: 's',
      name: 'charge',
      group: 'charge',
      input: null,
      attempt: 1,
    } as never);
    expect(redis.total()).toBe(before);
  });
});
