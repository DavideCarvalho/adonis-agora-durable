import { join } from 'node:path';
import type { ApplicationService } from '@adonisjs/core/types';
import { describe, expect, it } from 'vitest';
import DurableProvider from '../providers/durable_provider.js';
import type { DurableConfig } from '../src/define_config.js';
import { WorkflowEngine } from '../src/engine.js';
import type { RemoteTask, StepResult, Transport } from '../src/interfaces.js';
import { startRun } from '../src/test-helpers.js';
import { InMemoryStateStore } from '../src/testing/in-memory-state-store.js';

/** A capturing transport: records dispatches and every lifecycle call the provider makes on it. */
class FakeTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  deferred = false;
  closed = false;
  namespace: string | undefined;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(_handler: (r: StepResult) => Promise<void>): void {}
  onHeartbeat(): void {}
  deferConsumers(): void {
    this.deferred = true;
  }
  useNamespace(namespace: string): void {
    this.namespace = namespace;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeApp(config: DurableConfig, environment = 'web') {
  const factories = new Map<unknown, () => unknown>();
  const cache = new Map<unknown, unknown>();
  const container = {
    singleton(key: unknown, factory: () => unknown) {
      factories.set(key, factory);
    },
    bind(key: unknown, factory: () => unknown) {
      factories.set(key, factory);
    },
    async make(key: unknown): Promise<unknown> {
      if (cache.has(key)) return cache.get(key);
      const factory = factories.get(key);
      if (!factory) throw new Error(`no binding for ${String(key)}`);
      const value = await factory();
      cache.set(key, value);
      return value;
    },
    hasBinding(key: unknown) {
      return factories.has(key);
    },
  };
  const app = {
    config: { get: (k: string, fb?: unknown) => (k === 'durable' ? config : fb) },
    makePath: (...parts: string[]) => join('/app', ...parts),
    getEnvironment: () => environment,
    container,
  } as unknown as ApplicationService;
  return { app, container };
}

async function engineFor(config: Partial<DurableConfig>, environment?: string) {
  const { app, container } = makeApp(
    {
      store: 'mem',
      stores: { mem: async () => new InMemoryStateStore() },
      ...config,
    } as DurableConfig,
    environment,
  );
  const provider = new DurableProvider(app);
  provider.register();
  const engine = (await container.make(WorkflowEngine)) as WorkflowEngine;
  return { engine, provider };
}

describe('config-driven transport pins (ctx.step { transport })', () => {
  it('a pin to a configured but unselected transport fails with an actionable error', async () => {
    const queue = new FakeTransport();
    const { engine, provider } = await engineFor({
      transport: 'queue',
      transports: { queue: async () => queue, db: async () => new FakeTransport() },
    });
    engine.register('wf', '1', async (ctx) => ctx.step('ext.ping', {}, { transport: 'db' }));
    const result = await startRun(engine, 'wf', {}, 'r1');
    expect(result.status).toBe('failed');
    expect(result.error?.message).toMatch(/transport "db" is not registered/);
    expect(result.error?.message).toMatch(/transportPool/);
    await provider.shutdown();
  });

  it('transportPool builds the listed transports so a step can pin them by name', async () => {
    const queue = new FakeTransport();
    const db = new FakeTransport();
    const { engine, provider } = await engineFor(
      {
        transport: 'queue',
        transportPool: ['db'],
        transports: { queue: async () => queue, db: async () => db },
      },
      'console',
    );
    engine.register('pinned', '1', async (ctx) => ctx.step('ext.ping', {}, { transport: 'db' }));
    engine.register('primary', '1', async (ctx) =>
      ctx.step('ext.ping', {}, { transport: 'queue' }),
    );
    engine.register('legacy', '1', async (ctx) =>
      ctx.step('ext.ping', {}, { transport: 'default' }),
    );
    engine.register('plain', '1', async (ctx) => ctx.step('ext.ping', {}));

    await startRun(engine, 'pinned', {}, 'p1');
    await startRun(engine, 'primary', {}, 'p2');
    await startRun(engine, 'legacy', {}, 'p3');
    await startRun(engine, 'plain', {}, 'p4');

    expect(db.dispatched.map((t) => [t.runId, t.transport])).toEqual([['p1', 'db']]);
    // The selected transport is addressable by its config name, and `default` (the id a task
    // persisted before this change carries) still means it.
    expect(queue.dispatched.map((t) => [t.runId, t.transport])).toEqual([
      ['p2', 'queue'],
      ['p3', 'queue'],
      ['p4', 'queue'],
    ]);
    // Each pooled transport gets the same lifecycle as the primary: consumer deferral (a console
    // process), the namespace, and close on shutdown.
    expect(queue.deferred && db.deferred).toBe(true);
    expect(db.namespace).toBe('default');
    await provider.shutdown();
    expect(queue.closed && db.closed).toBe(true);
  });

  it('rejects a transportPool entry that is not in config.transports', async () => {
    await expect(
      engineFor({
        transport: 'queue',
        transportPool: ['nope'],
        transports: { queue: async () => new FakeTransport() },
      }),
    ).rejects.toThrow(/transportPool.*"nope".*config\.transports\.nope/);
  });
});
