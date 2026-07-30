import { describe, expect, it } from 'vitest';
import { RedisControlPlane } from '../../src/control-plane-redis/index.js';
import type { RedisPubSub } from '../../src/control-plane-redis/redis-control-plane.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, budgetMs = 1000) {
  const deadline = Date.now() + budgetMs;
  while (!cond() && Date.now() < deadline) await delay(2);
}

/**
 * A fake subscriber connection standing in for the `duplicate()`d ioredis one. Deterministic and
 * server-free: the watchdog's whole contract is "PING, and on rejection/timeout disconnect(true)",
 * none of which needs a real Redis.
 */
class FakeSub implements RedisPubSub {
  status = 'ready';
  pings = 0;
  /** Every `disconnect()` call, recording its `reconnect` argument. */
  disconnects: boolean[] = [];
  listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  /** Swapped per-test to simulate a healthy / dead / hanging connection. */
  pingImpl: () => Promise<unknown> = async () => 'PONG';

  publish() {
    return undefined;
  }
  subscribe() {
    return undefined;
  }
  on(event: string, listener: (...args: never[]) => void) {
    const l = this.listeners.get(event) ?? [];
    // The port declares `never[]` purely so any listener shape is accepted; `emit` below calls this
    // back with exactly the args the real ioredis event carries.
    l.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, l);
    return undefined;
  }
  emit(event: string, ...args: unknown[]) {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
  ping() {
    this.pings++;
    return this.pingImpl();
  }
  disconnect(reconnect?: boolean) {
    this.disconnects.push(reconnect === true);
  }
}

/** A fake ioredis-shaped command connection whose `duplicate()` hands back our fake subscriber. */
function connFor(sub: FakeSub): RedisPubSub {
  return {
    publish: () => undefined,
    subscribe: () => undefined,
    duplicate: () => sub,
  };
}

describe('RedisControlPlane subscriber watchdog', () => {
  it('reconnects a subscriber whose PING rejects (silently-dead connection)', async () => {
    const sub = new FakeSub();
    sub.pingImpl = () => Promise.reject(new Error('connection is closed'));
    const plane = new RedisControlPlane({ connection: connFor(sub), pingIntervalMs: 10 });
    plane.onControl(() => {});

    // A subscriber connection never writes, so a dropped TCP connection is invisible to ioredis:
    // no write fails, no timeout fires, and it sits "subscribed" while PUBSUB NUMSUB shows 0. The
    // watchdog's PING is the only thing that surfaces it — on rejection it must force a reconnect
    // (disconnect(true)), which is what makes retryStrategy + autoResubscribe restore the channel.
    await until(() => sub.disconnects.length > 0);
    expect(sub.disconnects[0]).toBe(true);

    await plane.close();
  });

  it('leaves a healthy subscriber alone', async () => {
    const sub = new FakeSub();
    const plane = new RedisControlPlane({ connection: connFor(sub), pingIntervalMs: 10 });
    plane.onControl(() => {});

    await until(() => sub.pings >= 3);
    expect(sub.disconnects).toEqual([]);

    await plane.close();
  });

  it('reconnects a subscriber whose PING hangs (timeout, not rejection)', async () => {
    const sub = new FakeSub();
    sub.pingImpl = () => new Promise(() => {}); // never settles
    const plane = new RedisControlPlane({ connection: connFor(sub), pingIntervalMs: 10 });
    plane.onControl(() => {});

    await until(() => sub.disconnects.length > 0);
    expect(sub.disconnects[0]).toBe(true);

    await plane.close();
  });

  it('attaches an error listener so a subscriber error never goes unhandled', async () => {
    const sub = new FakeSub();
    const plane = new RedisControlPlane({ connection: connFor(sub), pingIntervalMs: 10 });
    plane.onControl(() => {});

    // An unhandled 'error' on an ioredis instance crashes the process in some setups, and a
    // dead/reconnecting subscriber emits them in bursts.
    expect(sub.listeners.get('error')?.length).toBeGreaterThan(0);
    expect(() => sub.emit('error', new Error('ECONNRESET'))).not.toThrow();

    await plane.close();
  });

  it('does not ping a connection that is not ready (already mid-reconnect)', async () => {
    const sub = new FakeSub();
    sub.status = 'connecting';
    const plane = new RedisControlPlane({ connection: connFor(sub), pingIntervalMs: 10 });
    plane.onControl(() => {});

    await delay(50);
    expect(sub.pings).toBe(0);

    await plane.close();
  });

  it('pingIntervalMs: false disables the watchdog entirely', async () => {
    const sub = new FakeSub();
    const plane = new RedisControlPlane({ connection: connFor(sub), pingIntervalMs: false });
    plane.onControl(() => {});

    await delay(50);
    expect(sub.pings).toBe(0);

    await plane.close();
  });

  it('a ping still in flight when close() lands does not resurrect the subscriber', async () => {
    const sub = new FakeSub();
    sub.pingImpl = () => new Promise(() => {}); // hangs past close()
    const plane = new RedisControlPlane({ connection: connFor(sub), pingIntervalMs: 10 });
    plane.onControl(() => {});
    await until(() => sub.pings > 0);

    // close() tears the subscriber down with disconnect() (no reconnect). The in-flight ping's
    // timeout fires afterwards — if it still ran its failure path, disconnect(true) would RECONNECT
    // the connection we just closed, leaking it for the process's lifetime.
    await plane.close();
    await delay(60);

    expect(sub.disconnects).toEqual([false]); // close()'s teardown only — no reconnect
  });

  it('close() stops the watchdog', async () => {
    const sub = new FakeSub();
    const plane = new RedisControlPlane({ connection: connFor(sub), pingIntervalMs: 10 });
    plane.onControl(() => {});
    await until(() => sub.pings > 0);

    await plane.close();
    const after = sub.pings;
    await delay(50);
    expect(sub.pings).toBe(after);
  });
});
