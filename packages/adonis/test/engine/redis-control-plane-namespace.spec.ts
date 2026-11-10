import { describe, expect, it } from 'vitest';
import { RedisControlPlane } from '../../src/control-plane-redis/index.js';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { controlChannel, effectivePrefix } from '../../src/transports/bullmq/naming.js';

/**
 * The control channel folds the namespace in exactly like the BullMQ transport's names (and
 * nestjs-durable's `${effectivePrefix}-control`), so a namespaced Agora fleet and a namespaced
 * NestJS/Python fleet on one Redis hear each other's cancels and lifecycle events.
 */
function fakeConnection() {
  const published: string[] = [];
  const subscribed: string[] = [];
  return {
    published,
    subscribed,
    connection: {
      publish(channel: string) {
        published.push(channel);
        return Promise.resolve(1);
      },
      subscribe(channel: string) {
        subscribed.push(channel);
        return Promise.resolve();
      },
    },
  };
}

function plane(options: { prefix?: string; namespace?: string } = {}) {
  const fake = fakeConnection();
  const cp = new RedisControlPlane({
    connection: fake.connection,
    pingIntervalMs: false,
    ...options,
  });
  return { cp, ...fake };
}

describe('RedisControlPlane channel namespace folding', () => {
  it('keeps the bare channel with no namespace or the default one', () => {
    expect(plane().cp.channel).toBe('durable-control');
    expect(plane({ namespace: 'default' }).cp.channel).toBe('durable-control');
  });

  it('folds an explicit namespace in, as nestjs-durable does', () => {
    expect(plane({ namespace: 'dev-alice' }).cp.channel).toBe('durable-dev-alice-control');
    expect(plane({ prefix: 'flip', namespace: 'dev-bob' }).cp.channel).toBe('flip-dev-bob-control');
  });

  it('matches the BullMQ transport naming for the same prefix and namespace', () => {
    for (const [prefix, namespace] of [
      ['durable', undefined],
      ['durable', 'default'],
      ['durable', 'tenant-a'],
      ['acme', 'eu'],
    ] as const) {
      expect(plane({ prefix, ...(namespace ? { namespace } : {}) }).cp.channel).toBe(
        controlChannel(effectivePrefix(prefix, namespace)),
      );
    }
  });

  it("adopts the engine's namespace before subscribing, and publishes on the same channel", async () => {
    const { cp, published, subscribed } = plane();
    new WorkflowEngine({
      store: new InMemoryStateStore(),
      controlPlane: cp,
      namespace: 'tenant-a',
    });
    expect(subscribed).toEqual(['durable-tenant-a-control']);
    await cp.publishControl({ kind: 'cancel', runId: 'r1' });
    expect(published).toEqual(['durable-tenant-a-control']);
  });

  it("an explicit namespace wins over the engine's", () => {
    const { cp, subscribed } = plane({ namespace: 'other' });
    new WorkflowEngine({
      store: new InMemoryStateStore(),
      controlPlane: cp,
      namespace: 'tenant-a',
    });
    expect(subscribed).toEqual(['durable-other-control']);
  });

  it('an operator engine (no namespace) stays on the bare channel', () => {
    const { cp, subscribed } = plane();
    new WorkflowEngine({ store: new InMemoryStateStore(), controlPlane: cp });
    expect(subscribed).toEqual(['durable-control']);
  });
});
