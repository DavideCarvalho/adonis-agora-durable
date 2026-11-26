import { describe, expect, it } from 'vitest';
import { RedisControlPlane } from '../../src/control-plane-redis/index.js';

/**
 * An `@adonisjs/redis` connection opens its own subscriber connection on the first `subscribe`.
 * The control plane must give it back on close (unsubscribe its handlers, and close the subscriber
 * when nobody else listens on it), or an ace command never exits; and a console/REPL process must
 * not subscribe at all until it becomes a worker.
 */
function adonisConnection() {
  const subscriptions = new Map<string, Set<unknown>>();
  const psubscriptions = new Map<string, Set<unknown>>();
  const state = { disconnected: 0, subscribeCalls: 0 };
  const connection = {
    subscriptions,
    psubscriptions,
    ioSubscriberConnection: undefined as { status: string; disconnect(): void } | undefined,
    publish: async () => 0,
    subscribe(channel: string, handler: unknown) {
      state.subscribeCalls += 1;
      connection.ioSubscriberConnection ??= {
        status: 'ready',
        disconnect() {
          this.status = 'end';
          state.disconnected += 1;
        },
      };
      const set = subscriptions.get(channel) ?? new Set();
      set.add(handler);
      subscriptions.set(channel, set);
      return Promise.resolve();
    },
    psubscribe(pattern: string, handler: unknown) {
      const set = psubscriptions.get(pattern) ?? new Set();
      set.add(handler);
      psubscriptions.set(pattern, set);
      return Promise.resolve();
    },
    unsubscribe(channel: string, handler: unknown) {
      const set = subscriptions.get(channel);
      set?.delete(handler);
      if (set && set.size === 0) subscriptions.delete(channel);
      return Promise.resolve();
    },
    punsubscribe(pattern: string, handler: unknown) {
      const set = psubscriptions.get(pattern);
      set?.delete(handler);
      if (set && set.size === 0) psubscriptions.delete(pattern);
      return Promise.resolve();
    },
  };
  return { connection, state };
}

describe('RedisControlPlane on @adonisjs/redis: subscriptions are given back', () => {
  it('close() unsubscribes its channels and patterns and closes the subscriber it alone used', async () => {
    const { connection, state } = adonisConnection();
    const plane = new RedisControlPlane({ connection, prefix: 'app', pingIntervalMs: 0 });
    plane.observeAll?.();
    plane.onControl(() => undefined);
    expect(connection.subscriptions.size + connection.psubscriptions.size).toBeGreaterThan(0);
    await plane.close();
    expect(connection.subscriptions.size).toBe(0);
    expect(connection.psubscriptions.size).toBe(0);
    expect(state.disconnected).toBe(1);
    expect(connection.ioSubscriberConnection?.status).toBe('end');
  });

  it('leaves the subscriber alone when the app still listens on the connection', async () => {
    const { connection, state } = adonisConnection();
    connection.subscribe('app-own-channel', () => undefined);
    const plane = new RedisControlPlane({ connection, prefix: 'app', pingIntervalMs: 0 });
    plane.onControl(() => undefined);
    await plane.close();
    expect([...connection.subscriptions.keys()]).toEqual(['app-own-channel']);
    expect(state.disconnected).toBe(0);
  });

  it('deferSubscriptions holds the control subscription until startSubscriptions', async () => {
    const { connection, state } = adonisConnection();
    const plane = new RedisControlPlane({ connection, prefix: 'app', pingIntervalMs: 0 });
    plane.deferSubscriptions();
    const seen: unknown[] = [];
    plane.onControl((msg) => seen.push(msg));
    expect(state.subscribeCalls).toBe(0);
    expect(connection.ioSubscriberConnection).toBeUndefined();
    plane.startSubscriptions();
    expect(state.subscribeCalls).toBe(1);
    await plane.close();
    expect(state.disconnected).toBe(1);
  });
});
