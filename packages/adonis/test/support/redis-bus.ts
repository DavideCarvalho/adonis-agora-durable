import type { AdonisRedisPubSub } from '../../src/control-plane-redis/redis-control-plane.js';

/**
 * An in-memory stand-in for one Redis server, handing out `@adonisjs/redis`-shaped connections:
 * `PUBLISH` answers how many subscribers got the message, and `SET … PX … NX` is atomic, so the
 * console-command claim works across the "instances" a test makes. Lets the real
 * `RedisControlPlane` run its console-command path without a Redis server.
 */
export class RedisBus {
  readonly #subscribers = new Map<string, Set<(message: string) => void>>();
  readonly #keys = new Map<string, string>();
  readonly published: Array<{ channel: string; message: string }> = [];

  connection(): AdonisRedisPubSub {
    return {
      publish: async (channel: string, message: string) => {
        this.published.push({ channel, message });
        const handlers = [...(this.#subscribers.get(channel) ?? [])];
        // Delivered asynchronously, like a real server round trip.
        queueMicrotask(() => {
          for (const handler of handlers) handler(message);
        });
        return handlers.length;
      },
      set: async (key: string, value: string) => {
        if (this.#keys.has(key)) return null;
        this.#keys.set(key, value);
        return 'OK';
      },
      subscribe: async (channel: string, handler: (message: string) => void) => {
        let set = this.#subscribers.get(channel);
        if (!set) {
          set = new Set();
          this.#subscribers.set(channel, set);
        }
        set.add(handler);
      },
    };
  }

  /** Everything that crossed the bus, as one string (to assert a secret never did). */
  get wire(): string {
    return this.published.map((p) => p.message).join('\n');
  }
}

/** Let queued deliveries (and the handlers they start) run. */
export const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
