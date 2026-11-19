import { describe, expect, it } from 'vitest';
import { admissions } from '../src/admissions/factory.js';
import { controlPlanes } from '../src/control-planes/factory.js';
import { defineConfig } from '../src/define_config.js';
import { durableStackUses, STACK_DESCRIPTOR } from '../src/stack.js';
import { stores } from '../src/stores/factory.js';
import { transports } from '../src/transports/factory.js';

const usesOf = (value: object): unknown => (value as Record<symbol, unknown>)[STACK_DESCRIPTOR];

function appConfig(values: Record<string, unknown>) {
  return {
    get(key: string) {
      let v: unknown = values;
      for (const part of key.split('.')) v = (v as Record<string, unknown> | undefined)?.[part];
      return v;
    },
  };
}

describe('stack descriptor', () => {
  it('describes the selected Lucid store and db transport, non-enumerable', () => {
    const config = defineConfig({
      transport: 'db',
      transports: { db: transports.db({ connection: 'jobs' }), memory: transports.memory() },
      store: 'lucid',
      stores: { lucid: stores.lucid({ connection: 'educacao' }) },
    });
    expect(usesOf(config)).toEqual([
      { tech: 'sql', connection: 'educacao', purpose: 'run history' },
      { tech: 'sql', connection: 'jobs', purpose: 'queues' },
    ]);
    expect(Object.keys(config)).not.toContain(STACK_DESCRIPTOR.toString());
    expect(Object.getOwnPropertyDescriptor(config, STACK_DESCRIPTOR)?.enumerable).toBe(false);
  });

  it('does not describe drivers that are listed but not selected', () => {
    const config = defineConfig({
      transport: 'memory',
      transports: { memory: transports.memory(), db: transports.db() },
      stores: { lucid: stores.lucid() },
    });
    expect(usesOf(config)).toEqual([]);
  });

  it('resolves the default Lucid connection and its client from the app config', () => {
    const config = defineConfig({
      transport: 'queue',
      transports: { queue: transports.queue({ connection: 'redis' }) },
      store: 'lucid',
      stores: { lucid: stores.lucid() },
    });
    const app = appConfig({
      database: { connection: 'pg', connections: { pg: { client: 'pg' } } },
    });
    expect(durableStackUses(config, app)).toEqual([
      { tech: 'postgres', connection: 'pg', purpose: 'run history' },
      { tech: 'postgres', connection: 'pg', purpose: 'worker keys' },
    ]);
    // No Lucid in the app: the queue transport advertises no worker keys.
    expect(
      durableStackUses(
        defineConfig({ transport: 'queue', transports: { queue: transports.queue() } }),
        appConfig({}),
      ),
    ).toEqual([]);
  });

  it('describes Redis admission and control plane on the `main` connection by default', () => {
    const config = defineConfig({
      admission: admissions.redis(),
      controlPlane: controlPlanes.redis({ connection: 'pubsub' }),
    });
    expect(usesOf(config)).toEqual([
      { tech: 'redis', connection: 'main', purpose: 'admission' },
      { tech: 'redis', connection: 'pubsub', purpose: 'control plane' },
    ]);
  });

  it('describes a bullmq transport by its Redis host, pool included', () => {
    const config = defineConfig({
      transport: 'bull',
      transportPool: ['db'],
      transports: {
        bull: transports.bullmq({ connection: { host: 'redis.internal', port: 6379 } }),
        db: transports.db(),
      },
    });
    expect(usesOf(config)).toEqual([
      { tech: 'redis', label: 'bullmq', purpose: 'queues', host: 'redis.internal:6379/' },
      { tech: 'sql', purpose: 'queues' },
    ]);
  });

  it('a wrapped factory (a Proxy, like encryptedTransport) keeps its uses', () => {
    const inner = transports.db({ connection: 'jobs' });
    const wrapped = new Proxy(inner, {});
    const config = defineConfig({
      transport: 'db',
      transports: { db: wrapped },
      store: 'lucid',
      stores: { lucid: stores.lucid({ connection: 'educacao' }) },
    });
    expect(usesOf(config)).toEqual([
      { tech: 'sql', connection: 'educacao', purpose: 'run history' },
      { tech: 'sql', connection: 'jobs', purpose: 'queues' },
    ]);
  });
});
