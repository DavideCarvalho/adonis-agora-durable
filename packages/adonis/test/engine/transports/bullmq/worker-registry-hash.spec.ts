import { afterEach, describe, expect, it, vi } from 'vitest';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import type {
  BullMQDeps,
  QueueLike,
  RedisLike,
  WorkerLike,
} from '../../../../src/transports/bullmq/deps.js';

// ---------------------------------------------------------------------------
// The worker registry: ONE hash per prefix (`<P>-workers:instances`), one field per writing instance
// listing every token it serves. A writer costs one HSET per beat whatever its token count; a process
// reads with one HGETALL, reused for 30s. Older readers' keys (per-instance keys, rc.31 per-token
// hashes) are written on a slower cadence while `legacyWrites` is on; older writers' per-instance
// keys are read by one shared, throttled walk.
// ---------------------------------------------------------------------------

type Value = string | Map<string, string> | Map<string, number>;

/** A fake Redis holding strings, hashes and sorted sets, paging SCAN like a real one and counting
 *  every command. `hashless` hides the hash/sorted-set commands (a reader on an older version). */
class FakeRedis implements RedisLike {
  readonly data: Map<string, Value>;
  readonly ttl = new Map<string, number>();
  /** The `EX` seconds of the last SET of each key. */
  readonly ex = new Map<string, number>();
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
  async set(key: string, value: string, ...args: (string | number)[]): Promise<unknown> {
    this.#count('set');
    this.data.set(key, value);
    if (args[0] === 'EX') this.ex.set(key, Number(args[1]));
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

const INSTANCES = 'durable-workers:instances';
const descriptor = (instanceId: string) => JSON.stringify({ instanceId, capabilities: [] });
const beat = (ts = Date.now()) => JSON.stringify({ ts });
const field = (value: string, expiresAt: number) => JSON.stringify({ expiresAt, value });
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** SCAN calls of one compatibility walk of `redis` (COUNT 10_000). */
const walkOf = (redis: FakeRedis) => Math.ceil(redis.data.size / 10_000);

/** The fields of the instances hash, parsed. */
function instances(redis: FakeRedis): Record<
  string,
  {
    v: number;
    instance: string;
    expiresAt: number;
    heartbeats: Array<{ value: string; expiresAt: number; tokens: string[] }>;
    descriptors: Array<{ value: string; expiresAt: number; tokens: string[] }>;
  }
> {
  const hash = redis.data.get(INSTANCES);
  if (!(hash instanceof Map)) return {};
  return Object.fromEntries([...(hash as Map<string, string>)].map(([f, v]) => [f, JSON.parse(v)]));
}

/** What a 1.0.0-rc.31 reader does: the token index, then one HGETALL per token hash. */
async function rc31Heartbeats(
  redis: FakeRedis,
): Promise<Array<{ token: string; instance: string }>> {
  const now = Date.now();
  const tokens = await redis.zrangebyscore('durable-workers:tokens', now);
  const out: Array<{ token: string; instance: string }> = [];
  for (const token of tokens) {
    for (const [instance, stored] of Object.entries(
      await redis.hgetall(`durable-workers:heartbeats:${token}`),
    )) {
      const { expiresAt } = JSON.parse(stored) as { expiresAt: number };
      if (expiresAt > now) out.push({ token, instance });
    }
  }
  return out;
}

/** A record of the instances hash as another writer would store it. */
function record(
  instance: string,
  expiresAt: number,
  kinds: { heartbeats?: Record<string, string[]>; descriptors?: Record<string, string[]> },
): string {
  const groups = (by: Record<string, string[]> = {}) =>
    Object.entries(by).map(([value, tokens]) => ({ value, expiresAt, tokens }));
  return JSON.stringify({
    v: 1,
    instance,
    expiresAt,
    heartbeats: groups(kinds.heartbeats),
    descriptors: groups(kinds.descriptors),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('BullMQ worker registry: one field per instance', () => {
  it('a worker writes ONE field listing every token it serves, once per beat', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const redis = new FakeRedis();
    const worker = transport(redis, { workerRegistry: { legacyWrites: false } });
    const tokens = Array.from({ length: 85 }, (_, i) => `step-${i}`);
    for (const t of tokens) worker.handle(t, async () => ({}));
    await flush();

    const fields = instances(redis);
    expect(Object.keys(fields)).toHaveLength(1);
    const [name, stored] = Object.entries(fields)[0] as [
      string,
      ReturnType<typeof instances>[string],
    ];
    expect(name.startsWith('self#')).toBe(true);
    expect(stored.instance).toBe('self');
    // One beat value for all tokens: one group, not 85 copies.
    expect(stored.heartbeats).toHaveLength(1);
    expect(stored.heartbeats[0]?.tokens.sort()).toEqual([...tokens].sort());
    expect(stored.expiresAt).toBeGreaterThan(Date.now() + 30_000);
    expect(redis.ttl.get(INSTANCES)).toBeGreaterThan(0);
    // No per-instance key, no rc.31 hash.
    expect(redis.n('set')).toBe(0);
    expect([...redis.data.keys()].filter((k) => k !== INSTANCES)).toEqual([]);

    const before = redis.total();
    const hsets = redis.n('hset');
    vi.advanceTimersByTime(10_000);
    await flush();
    expect(redis.n('hset')).toBe(hsets + 1);
    expect(redis.total()).toBe(before + 1); // the beat is that one HSET
    await worker.close();
  });

  it('legacy writes: per-instance keys and rc.31 hash fields, refreshed once per legacyWriteIntervalMs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const clock = vi.spyOn(Date, 'now');
    const t0 = Date.now();
    clock.mockReturnValue(t0);
    const redis = new FakeRedis();
    const worker = transport(redis);
    for (const t of ['charge', 'mail', 'render']) worker.handle(t, async () => ({}));
    await flush();

    // Written at once for a new token, living three intervals.
    expect(redis.n('set')).toBe(3);
    expect(redis.ex.get('durable-worker-heartbeat:charge:self')).toBe(90);
    const rc31 = JSON.parse(
      (redis.data.get('durable-workers:heartbeats:charge') as Map<string, string>).get(
        'self',
      ) as string,
    ) as { expiresAt: number };
    expect(rc31.expiresAt).toBe(t0 + 90_000);

    // Beats inside the interval only rewrite the instances field.
    for (let i = 1; i <= 2; i += 1) {
      clock.mockReturnValue(t0 + i * 10_000);
      vi.advanceTimersByTime(10_000);
      await flush();
    }
    expect(redis.n('set')).toBe(3);
    // The interval is up: each key once more.
    clock.mockReturnValue(t0 + 30_000);
    vi.advanceTimersByTime(10_000);
    await flush();
    await flush();
    expect(redis.n('set')).toBe(6);
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

  it('an rc.31 reader (per-token hashes) still sees a new writer', async () => {
    const redis = new FakeRedis();
    const worker = transport(redis);
    worker.handle('charge', async () => ({}));
    worker.handle('mail', async () => ({}));
    await flush();
    await flush();

    expect((await rc31Heartbeats(redis)).sort((a, b) => a.token.localeCompare(b.token))).toEqual([
      { token: 'charge', instance: 'self' },
      { token: 'mail', instance: 'self' },
    ]);
    await worker.close();
  });

  it('with legacyWrites: false older readers no longer see the writer', async () => {
    const redis = new FakeRedis();
    const worker = transport(redis, { workerRegistry: { legacyWrites: false } });
    worker.handle('charge', async () => ({}));
    await flush();
    expect(await rc31Heartbeats(redis)).toEqual([]);
    expect(await transport(hashless(redis), { instanceId: 'dash' }).listWorkerGroups()).toEqual([]);
    // A reader on this version does.
    expect(await transport(redis, { instanceId: 'dash' }).listWorkerGroups()).toEqual(['charge']);
    await worker.close();
  });

  it('a new reader sees an old writer through the compatibility walk', async () => {
    const redis = crowded(new FakeRedis(), 25_000);
    redis.data.set('durable-worker-heartbeat:render:py-1', beat());
    redis.data.set('durable-worker-descriptor:render:py-1', descriptor('py-1'));
    const reader = transport(redis, { instanceId: 'dash' });

    expect(await reader.listWorkerGroups()).toEqual(['render']);
    expect((await reader.listWorkerDescriptors('render')).map((d) => d.instanceId)).toEqual([
      'py-1',
    ]);
    expect((await reader.readAllWorkerDescriptors()).map((d) => d.instanceId)).toEqual(['py-1']);
    expect((await reader.readAllWorkerHeartbeats()).map((h) => h.instanceId)).toEqual(['py-1']);
    // Heartbeats and descriptors came from ONE walk shared by every read above, 10k keys a call.
    expect(redis.n('scan')).toBe(walkOf(redis));
    expect(redis.n('scan')).toBe(3);
  });

  it('merges the instances hash and walked keys, the hash winning for the same instance', async () => {
    const redis = new FakeRedis();
    const now = Date.now();
    redis.data.set(
      INSTANCES,
      new Map([
        [
          'new-1#a',
          record('new-1', now + 30_000, { descriptors: { [descriptor('new-1')]: ['render'] } }),
        ],
      ]),
    );
    redis.data.set('durable-worker-descriptor:render:new-1', descriptor('stale-copy'));
    redis.data.set('durable-worker-descriptor:render:old-1', descriptor('old-1'));
    const reader = transport(redis, { instanceId: 'dash' });

    const ids = (await reader.listWorkerDescriptors('render')).map((d) => d.instanceId).sort();
    expect(ids).toEqual(['new-1', 'old-1']);
  });

  it('skips expired, malformed and unknown-version fields', async () => {
    const redis = new FakeRedis();
    const now = Date.now();
    redis.data.set(
      INSTANCES,
      new Map([
        ['live#a', record('live', now + 30_000, { heartbeats: { [beat(now)]: ['charge'] } })],
        ['dead#a', record('dead', now - 1, { heartbeats: { [beat(now - 60_000)]: ['charge'] } })],
        ['junk#a', '{nope'],
        ['future#a', JSON.stringify({ v: 2, instance: 'future', expiresAt: now + 30_000 })],
      ]),
    );
    const reader = transport(redis, { instanceId: 'dash', workerRegistry: { legacyScan: false } });

    const health = await reader.groupHealth('charge');
    expect(health.liveWorkers.map((w) => w.instanceId)).toEqual(['live']);
  });

  it('reads: one HGETALL per process per 30s, whatever the token count or the readers', async () => {
    const redis = crowded(new FakeRedis());
    const engineSide = transport(redis, { instanceId: 'engine' });
    const tokens = Array.from({ length: 85 }, (_, i) => `step-${i}`);
    const walk = walkOf(redis);

    // A dispatch-heavy loop, plus every other reader of the process.
    for (let round = 0; round < 20; round += 1) {
      await Promise.all(tokens.map((t) => engineSide.listWorkerDescriptors(t)));
      await engineSide.readAllWorkerDescriptors();
      await engineSide.readAllWorkerHeartbeats();
      await engineSide.groupHealth('step-1');
    }
    expect(redis.n('hgetall')).toBe(1);
    expect(redis.n('scan')).toBe(walk); // ONE compatibility walk

    const clock = vi.spyOn(Date, 'now');
    const at = Date.now();
    clock.mockReturnValue(at + 29_000);
    await Promise.all(tokens.map((t) => engineSide.listWorkerDescriptors(t)));
    expect(redis.n('hgetall')).toBe(1);
    clock.mockReturnValue(at + 31_000);
    await Promise.all(tokens.map((t) => engineSide.listWorkerDescriptors(t)));
    expect(redis.n('hgetall')).toBe(2);
    // `fresh` (the engine's re-read before it parks a run) re-reads the hash, never the keyspace.
    await engineSide.listWorkerDescriptors('step-0', { fresh: true });
    expect(redis.n('hgetall')).toBe(3);
    expect(redis.n('scan')).toBe(walk);
  });

  it("another instance's new worker is seen once the read is due, or at once by a fresh read", async () => {
    const redis = new FakeRedis();
    const reader = transport(redis, { instanceId: 'dash', workerRegistry: { legacyScan: false } });
    expect(await reader.listWorkerDescriptors('render')).toEqual([]);

    const worker = transport(redis, { instanceId: 'pod-1', workerRegistry: { legacyScan: false } });
    const writer = worker.createDescriptorRedis();
    await writer.set('durable-worker-descriptor:render:pod-1', descriptor('pod-1'), 'EX', 35);
    expect(await reader.listWorkerDescriptors('render')).toEqual([]); // the 30s read
    expect(
      (await reader.listWorkerDescriptors('render', { fresh: true })).map((d) => d.instanceId),
    ).toEqual(['pod-1']);
    await worker.close();
  });

  it('own freshly registered handler is visible at once, despite a cached read', async () => {
    const redis = new FakeRedis();
    const t = transport(redis);
    expect(await t.listWorkerGroups()).toEqual([]);
    t.handle('charge', async () => ({}));
    expect(await t.listWorkerGroups()).toEqual(['charge']);
    await t.close();
  });

  it('close() removes its own field, keys and rc.31 fields, and leaves other instances alone', async () => {
    const redis = new FakeRedis();
    const peer = transport(redis, { instanceId: 'peer' });
    peer.handle('charge', async () => ({}));
    const worker = transport(redis);
    worker.handle('charge', async () => ({}));
    await flush();
    await flush();

    await worker.close();
    expect(Object.values(instances(redis)).map((r) => r.instance)).toEqual(['peer']);
    const hash = redis.data.get('durable-workers:heartbeats:charge') as Map<string, string>;
    expect([...hash.keys()]).toEqual(['peer']);
    expect(redis.data.has('durable-worker-heartbeat:charge:self')).toBe(false);
    expect(redis.data.has('durable-worker-heartbeat:charge:peer')).toBe(true);
    await peer.close();
  });

  it('a writer deletes other writers expired fields and refreshes the TTL, not on every beat', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const clock = vi.spyOn(Date, 'now');
    const t0 = Date.now();
    clock.mockReturnValue(t0);
    const redis = new FakeRedis();
    redis.data.set(
      INSTANCES,
      new Map([
        ['gone#a', record('gone', t0 - 1, { heartbeats: { [beat(t0 - 60_000)]: ['charge'] } })],
      ]),
    );
    const worker = transport(redis, { workerRegistry: { legacyWrites: false } });
    worker.handle('charge', async () => ({}));
    await flush();
    await flush();
    expect(Object.values(instances(redis)).map((r) => r.instance)).toEqual(['self']);
    const upkeep = { hgetall: redis.n('hgetall'), pexpire: redis.n('pexpire') };

    clock.mockReturnValue(t0 + 10_000);
    vi.advanceTimersByTime(10_000);
    await flush();
    expect(redis.n('hgetall')).toBe(upkeep.hgetall);
    expect(redis.n('pexpire')).toBe(upkeep.pexpire);
    // Five minutes later a beat sees to the hash again.
    clock.mockReturnValue(t0 + 5 * 60_000 + 1);
    vi.advanceTimersByTime(10_000);
    await flush();
    await flush();
    expect(redis.n('hgetall')).toBe(upkeep.hgetall + 1);
    expect(redis.n('pexpire')).toBe(upkeep.pexpire + 1);
    await worker.close();
  });

  it('rc.31 hashes: TTL and index refreshed every 10 minutes, pruned every 30, never per beat', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const clock = vi.spyOn(Date, 'now');
    const t0 = Date.now();
    clock.mockReturnValue(t0);
    const redis = new FakeRedis();
    redis.data.set(
      'durable-workers:heartbeats:charge',
      new Map([['gone', field(beat(t0 - 60_000), t0 - 1)]]),
    );
    redis.data.set(
      'durable-workers:tokens',
      new Map([
        ['charge', t0 + 600_000],
        ['retired', t0 - 1],
      ]),
    );
    const worker = transport(redis);
    worker.handle('charge', async () => ({}));
    await flush();
    await flush();
    const hash = redis.data.get('durable-workers:heartbeats:charge') as Map<string, string>;
    expect([...hash.keys()]).toEqual(['self']);
    expect([...(redis.data.get('durable-workers:tokens') as Map<string, number>).keys()]).toEqual([
      'charge',
    ]);
    const zadds = redis.n('zadd');
    // Legacy refreshes every 30s for 9 minutes: an HSET each, no index upkeep.
    for (let s = 30; s < 600; s += 30) {
      clock.mockReturnValue(t0 + s * 1000);
      vi.advanceTimersByTime(10_000);
      await flush();
      await flush();
    }
    expect(redis.n('zadd')).toBe(zadds);
    clock.mockReturnValue(t0 + 600_000);
    vi.advanceTimersByTime(10_000);
    await flush();
    await flush();
    expect(redis.n('zadd')).toBe(zadds + 1);
    await worker.close();
  });

  it('the compatibility walk runs at most once per legacyScanIntervalMs, serving the last walk meanwhile', async () => {
    const redis = crowded(new FakeRedis(), 2_000);
    redis.data.set('durable-worker-descriptor:render:py-1', descriptor('py-1'));
    const reader = transport(redis, {
      instanceId: 'dash',
      workerRegistry: { legacyScanIntervalMs: 30_000 },
    });
    const at = Date.now();
    const clock = vi.spyOn(Date, 'now');

    await reader.readAllWorkerDescriptors();
    expect(redis.n('scan')).toBe(1);
    clock.mockReturnValue(at + 29_000);
    await reader.readAllWorkerDescriptors();
    await reader.readAllWorkerHeartbeats();
    expect(redis.n('scan')).toBe(1);

    // Due: the reader is answered from the last walk while the next one runs behind it.
    redis.data.set('durable-worker-descriptor:render:py-2', descriptor('py-2'));
    clock.mockReturnValue(at + 31_000);
    expect((await reader.readAllWorkerDescriptors()).map((d) => d.instanceId)).toEqual(['py-1']);
    await vi.waitFor(() => expect(redis.n('scan')).toBe(2));
    await flush();
    clock.mockReturnValue(at + 62_000);
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

  it('keeps a walked heartbeat for its TTL plus a walk interval, then drops it', async () => {
    const redis = new FakeRedis();
    redis.data.set('durable-worker-heartbeat:render:py-1', beat());
    const reader = transport(redis, { instanceId: 'dash' });
    expect(await reader.listWorkerGroups()).toEqual(['render']);

    const at = Date.now();
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(at + 40_000);
    expect(await reader.listWorkerGroups()).toEqual(['render']);
    // The key is gone and the last walk's beat is older than 35s + 60s.
    redis.data.delete('durable-worker-heartbeat:render:py-1');
    clock.mockReturnValue(at + 96_000);
    expect(await reader.listWorkerGroups()).toEqual([]);
  });

  it('the worker runtime writer: one field for a whole beat, removed on stop', async () => {
    const redis = new FakeRedis();
    const t = transport(redis, { workerRegistry: { legacyScan: false, legacyWrites: false } });
    const writer = t.createDescriptorRedis();
    const tokens = ['render', 'charge', 'mail'];

    await Promise.all(
      tokens.flatMap((tok) => [
        writer.set(`durable-worker-descriptor:${tok}:pod-1`, descriptor('pod-1'), 'EX', 35),
        writer.set(`durable-worker-heartbeat:${tok}:pod-1`, beat(), 'EX', 35),
      ]),
    );
    expect(redis.n('hset')).toBe(1);
    expect(redis.n('set')).toBe(0);
    const stored = Object.values(instances(redis));
    expect(stored.map((r) => r.instance)).toEqual(['pod-1']);
    expect(stored[0]?.descriptors[0]?.tokens.sort()).toEqual(['charge', 'mail', 'render']);
    expect((await t.listWorkerDescriptors('render')).map((d) => d.instanceId)).toEqual(['pod-1']);
    expect((await t.listWorkerGroups()).sort()).toEqual(['charge', 'mail', 'render']);

    await writer.del?.(
      ...tokens.flatMap((tok) => [
        `durable-worker-descriptor:${tok}:pod-1`,
        `durable-worker-heartbeat:${tok}:pod-1`,
      ]),
    );
    expect(redis.data.has(INSTANCES)).toBe(false);
    expect(await t.listWorkerDescriptors('render', { fresh: true })).toEqual([]);
    expect(await t.listWorkerGroups()).toEqual([]);
  });

  it('the worker runtime writer keeps the per-instance keys for older readers by default', async () => {
    const redis = new FakeRedis();
    const t = transport(redis);
    const writer = t.createDescriptorRedis();
    await writer.set('durable-worker-descriptor:render:pod-1', descriptor('pod-1'), 'EX', 35);
    expect(redis.data.get('durable-worker-descriptor:render:pod-1')).toBe(descriptor('pod-1'));
    // The same value again inside the interval is not rewritten; a changed descriptor is, at once.
    await writer.set('durable-worker-descriptor:render:pod-1', descriptor('pod-1'), 'EX', 35);
    expect(redis.n('set')).toBe(1);
    await writer.set('durable-worker-descriptor:render:pod-1', descriptor('pod-1b'), 'EX', 35);
    expect(redis.n('set')).toBe(2);
    expect(redis.data.get('durable-worker-descriptor:render:pod-1')).toBe(descriptor('pod-1b'));
    await writer.del?.('durable-worker-descriptor:render:pod-1');
    expect(redis.data.has('durable-worker-descriptor:render:pod-1')).toBe(false);
    expect(redis.data.has('durable-workers:descriptors:render')).toBe(false);
  });

  it('a client without hash commands keeps the per-instance keys on every beat', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const redis = new FakeRedis();
    const old = hashless(redis) as FakeRedis;
    const worker = transport(old);
    worker.handle('charge', async () => ({}));
    await flush();
    expect(old.n('set')).toBe(1);
    expect(old.ex.get('durable-worker-heartbeat:charge:self')).toBe(35);
    vi.advanceTimersByTime(10_000);
    await flush();
    expect(old.n('set')).toBe(2);
    expect(redis.data.has(INSTANCES)).toBe(false);
    await worker.close();
  });

  it('workerRegistry.makeRedis puts the hashes on their own connection, the keys stay put', async () => {
    const main = new FakeRedis();
    const registry = new FakeRedis();
    const worker = transport(main, { workerRegistry: { makeRedis: () => registry } });
    worker.handle('charge', async () => ({}));
    await flush();

    expect(main.data.has('durable-worker-heartbeat:charge:self')).toBe(true);
    expect(main.data.has(INSTANCES)).toBe(false);
    expect(registry.data.has(INSTANCES)).toBe(true);
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
