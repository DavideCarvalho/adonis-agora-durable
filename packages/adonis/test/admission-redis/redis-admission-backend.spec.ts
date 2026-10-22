import { Redis } from 'ioredis';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  RedisAdmissionBackend,
  type RedisAdmissionOptions,
} from '../../src/admission-redis/index.js';
import { backendUrl, deleteRedisKeys, uniqueRedisPrefix } from '../support/backends.js';

/**
 * Redis-specific behaviour of the global admission backend, run against a REAL Redis (set REDIS_URL,
 * e.g. `redis://127.0.0.1:6399`). Self-skips when REDIS_URL is unset (locally; CI requires it) so the default suite stays green
 * without a server. Covers what's unique to the distributed backend: cross-pod globality,
 * liveness-based slot reclaim, the freed-slot pub/sub, and arrival ordering.
 */
const REDIS_URL = backendUrl('REDIS_URL');
// Every key this file writes starts with PREFIX, so cleanup never touches another file's keys.
const PREFIX = uniqueRedisPrefix('adm');
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!REDIS_URL)('RedisAdmissionBackend (real Redis)', () => {
  let redis: Redis;
  const open: RedisAdmissionBackend[] = [];
  let ns = 0;

  beforeAll(() => {
    redis = new Redis(REDIS_URL as string);
  });

  afterEach(async () => {
    for (const b of open) await b.close();
    open.length = 0;
    await deleteRedisKeys(redis, PREFIX);
  });

  /** A backend bound to a distinct instanceId, sharing the one Redis (each test gets a fresh prefix). */
  function pod(instanceId: string, prefix: string, opts: Partial<RedisAdmissionOptions> = {}) {
    const b = new RedisAdmissionBackend({ connection: redis, instanceId, prefix, ...opts });
    open.push(b);
    return b;
  }

  it('enforces concurrency GLOBALLY across pods, freed on release', async () => {
    const p = `${PREFIX}-t${++ns}`;
    const a = pod('A', p);
    const b = pod('B', p);
    a.register({ name: 'q', concurrency: 1 });
    b.register({ name: 'q', concurrency: 1 });

    expect((await a.tryAdmit('q', { waiterId: 'a1' })).ok).toBe(true);
    expect((await b.tryAdmit('q', { waiterId: 'b1' })).ok).toBe(false); // global cap of 1
    await a.release('q', 'a1');
    expect((await b.tryAdmit('q', { waiterId: 'b1' })).ok).toBe(true);
  });

  it('admits blocked waiters in arrival order (FIFO)', async () => {
    const p = `${PREFIX}-t${++ns}`;
    const a = pod('A', p);
    a.register({ name: 'q', concurrency: 1 });
    expect((await a.tryAdmit('q', { waiterId: 'first' })).ok).toBe(true);
    expect((await a.tryAdmit('q', { waiterId: 'w1' })).ok).toBe(false); // registers first
    expect((await a.tryAdmit('q', { waiterId: 'w2' })).ok).toBe(false); // registers second
    await a.release('q', 'first');
    expect((await a.tryAdmit('q', { waiterId: 'w2' })).ok).toBe(false); // not its turn
    expect((await a.tryAdmit('q', { waiterId: 'w1' })).ok).toBe(true); // FIFO winner
  });

  it('admits the most recent arrival first with order: lifo', async () => {
    const p = `${PREFIX}-t${++ns}`;
    const a = pod('A', p);
    a.register({ name: 'q', concurrency: 1, order: 'lifo' });
    expect((await a.tryAdmit('q', { waiterId: 'first' })).ok).toBe(true);
    expect((await a.tryAdmit('q', { waiterId: 'w1' })).ok).toBe(false);
    expect((await a.tryAdmit('q', { waiterId: 'w2' })).ok).toBe(false);
    await a.release('q', 'first');
    expect((await a.tryAdmit('q', { waiterId: 'w1' })).ok).toBe(false); // older waits
    expect((await a.tryAdmit('q', { waiterId: 'w2' })).ok).toBe(true); // LIFO winner
  });

  it('enforces a fixed-window rate limit', async () => {
    const p = `${PREFIX}-t${++ns}`;
    const a = pod('A', p);
    a.register({ name: 'q', rateLimit: { limit: 2, periodMs: 60_000 } });
    expect((await a.tryAdmit('q', { waiterId: 'r1' })).ok).toBe(true);
    expect((await a.tryAdmit('q', { waiterId: 'r2' })).ok).toBe(true);
    expect((await a.tryAdmit('q', { waiterId: 'r3' })).ok).toBe(false); // window exhausted
  });

  it("reclaims a crashed pod's slot once its liveness lapses", async () => {
    const p = `${PREFIX}-t${++ns}`;
    const a = pod('A', p, { instanceTtlMs: 300 });
    const b = pod('B', p, { instanceTtlMs: 300 });
    a.register({ name: 'q', concurrency: 1 });
    b.register({ name: 'q', concurrency: 1 });

    expect((await a.tryAdmit('q', { waiterId: 'a1' })).ok).toBe(true);
    expect((await b.tryAdmit('q', { waiterId: 'b1' })).ok).toBe(false);
    await a.close(); // pod A "crashes": heartbeat stops, its liveness key lapses within the TTL
    await delay(500);
    expect((await b.tryAdmit('q', { waiterId: 'b1' })).ok).toBe(true); // A's slot reclaimed
  });

  it('publishes a freed-slot signal on release that onFreed receives', async () => {
    const p = `${PREFIX}-t${++ns}`;
    const a = pod('A', p);
    a.register({ name: 'q', concurrency: 1 });
    const freed: string[] = [];
    a.onFreed((queue) => freed.push(queue));
    await delay(50); // let the subscriber connect
    await a.tryAdmit('q', { waiterId: 'a1' });
    await a.release('q', 'a1');
    await delay(50);
    expect(freed).toContain('q');
  });
});
