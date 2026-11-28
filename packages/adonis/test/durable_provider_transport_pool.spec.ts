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
  started = false;
  closed = false;
  failDispatch = false;
  namespace: string | undefined;
  resultHandler: ((r: StepResult) => Promise<void>) | undefined;
  async dispatch(task: RemoteTask): Promise<void> {
    if (this.failDispatch) throw new Error('broker down');
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.resultHandler = handler;
  }
  onHeartbeat(): void {}
  deferConsumers(): void {
    this.deferred = true;
  }
  startConsumers(): void {
    this.started = true;
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

async function engineFor(
  config: Partial<DurableConfig>,
  environment?: string,
  store: InMemoryStateStore = new InMemoryStateStore(),
) {
  const { app, container } = makeApp(
    {
      store: 'mem',
      stores: { mem: async () => store },
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
  it('a pin to a transport no config entry defines fails naming the configured ones', async () => {
    const queue = new FakeTransport();
    const { engine, provider } = await engineFor({
      transport: 'queue',
      transports: { queue: async () => queue, db: async () => new FakeTransport() },
    });
    engine.register('wf', '1', async (ctx) => ctx.step('ext.ping', {}, { transport: 'nope' }));
    const result = await startRun(engine, 'wf', {}, 'r1');
    expect(result.status).toBe('failed');
    expect(result.error?.message).toMatch(/transport "nope" is not registered/);
    expect(result.error?.message).toMatch(/configured: "queue", "db"/);
    expect(queue.dispatched).toEqual([]);
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

  it('with every configured transport built at boot, an unknown pin still names them', async () => {
    const { engine, provider } = await engineFor({
      transport: 'queue',
      transportPool: ['db'],
      transports: { queue: async () => new FakeTransport(), db: async () => new FakeTransport() },
    });
    engine.register('wf', '1', async (ctx) => ctx.step('ext.ping', {}, { transport: 'nope' }));
    const result = await startRun(engine, 'wf', {}, 'u1');
    expect(result.error?.message).toMatch(
      /transport "nope" is not registered on this engine \(registered: "queue", "db"; .*\)\. Define it in `transports` in config\/durable\.ts \(configured: "queue", "db"\)\./,
    );
    await provider.shutdown();
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

describe('transports built on demand (a pin to a configured transport not built at boot)', () => {
  it('builds the transport on first use, with the treatment a pool member gets', async () => {
    const queue = new FakeTransport();
    const db = new FakeTransport();
    let builds = 0;
    const { engine, provider } = await engineFor(
      {
        transport: 'queue',
        transports: {
          queue: async () => queue,
          db: async () => {
            builds += 1;
            return db;
          },
        },
      },
      'console',
    );
    expect(builds).toBe(0);
    engine.register('pinned', '1', async (ctx) => ctx.step('ext.ping', {}, { transport: 'db' }));
    engine.register('plain', '1', async (ctx) => ctx.step('ext.ping', {}));

    expect((await startRun(engine, 'pinned', {}, 'p1')).status).toBe('suspended');
    await startRun(engine, 'plain', {}, 'p2');
    expect(builds).toBe(1);
    expect(db.dispatched.map((t) => [t.runId, t.transport])).toEqual([['p1', 'db']]);
    expect(queue.dispatched.map((t) => [t.runId, t.transport])).toEqual([['p2', 'queue']]);
    // Deferred like the pool in a console process, namespaced, its results consumed by the engine.
    expect(db.deferred).toBe(true);
    expect(db.started).toBe(false);
    expect(db.namespace).toBe('default');
    expect(db.resultHandler).toBeTypeOf('function');
    expect(engine.transportsBuiltOnDemand).toEqual(['db']);
    // The engine becoming a worker starts it like the others.
    engine.startConsumers();
    expect(db.started).toBe(true);

    const task = db.dispatched[0] as RemoteTask;
    await db.resultHandler?.({
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output: { pong: true },
    });
    await expect.poll(async () => (await engine.getRun('p1'))?.status).toBe('completed');

    await provider.shutdown();
    expect(queue.closed && db.closed).toBe(true);
  });

  it('a transport built after the engine became a worker starts consuming at once', async () => {
    const db = new FakeTransport();
    const { engine, provider } = await engineFor(
      {
        transport: 'queue',
        transports: { queue: async () => new FakeTransport(), db: async () => db },
      },
      'console',
    );
    engine.startConsumers();
    engine.register('pinned', '1', async (ctx) => ctx.step('ext.ping', {}, { transport: 'db' }));
    await startRun(engine, 'pinned', {}, 'p1');
    expect(db.deferred && db.started).toBe(true);
    await provider.shutdown();
  });

  it('a web process does not defer the consumers of a transport built on demand', async () => {
    const db = new FakeTransport();
    const { engine, provider } = await engineFor({
      transport: 'queue',
      transports: { queue: async () => new FakeTransport(), db: async () => db },
    });
    engine.register('pinned', '1', async (ctx) => ctx.step('ext.ping', {}, { transport: 'db' }));
    await startRun(engine, 'pinned', {}, 'p1');
    expect(db.deferred).toBe(false);
    expect(db.dispatched).toHaveLength(1);
    await provider.shutdown();
  });

  it('two simultaneous first uses build exactly one instance', async () => {
    let builds = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const db = new FakeTransport();
    const { engine, provider } = await engineFor({
      transport: 'queue',
      transports: {
        queue: async () => new FakeTransport(),
        db: async () => {
          builds += 1;
          await gate;
          return db;
        },
      },
    });
    engine.register('pinned', '1', async (ctx) => ctx.step('ext.ping', {}, { transport: 'db' }));
    const runs = [startRun(engine, 'pinned', {}, 'c1'), startRun(engine, 'pinned', {}, 'c2')];
    await expect.poll(() => builds).toBe(1);
    release();
    await Promise.all(runs);
    expect(builds).toBe(1);
    expect(db.dispatched.map((t) => t.runId).sort()).toEqual(['c1', 'c2']);
    expect(engine.transportsBuiltOnDemand).toEqual(['db']);
    await provider.shutdown();
  });

  it('a failed build fails that dispatch and is built again on the next use', async () => {
    let builds = 0;
    const db = new FakeTransport();
    const { engine, provider } = await engineFor({
      transport: 'queue',
      transports: {
        queue: async () => new FakeTransport(),
        db: async () => {
          builds += 1;
          if (builds === 1) throw new Error('db connection refused');
          return db;
        },
      },
    });
    engine.register('pinned', '1', async (ctx) => ctx.step('ext.ping', {}, { transport: 'db' }));
    const first = await startRun(engine, 'pinned', {}, 'f1');
    expect(first.status).toBe('failed');
    expect(first.error?.message).toMatch(/db connection refused/);
    expect(engine.transportsBuiltOnDemand).toEqual([]);

    expect((await startRun(engine, 'pinned', {}, 'f2')).status).toBe('suspended');
    expect(builds).toBe(2);
    expect(db.dispatched.map((t) => t.runId)).toEqual(['f2']);
    await provider.shutdown();
    expect(db.closed).toBe(true);
  });

  it('a transport whose build finishes during shutdown is closed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const db = new FakeTransport();
    let building = false;
    const { engine, provider } = await engineFor({
      transport: 'queue',
      transports: {
        queue: async () => new FakeTransport(),
        db: async () => {
          building = true;
          await gate;
          return db;
        },
      },
    });
    engine.register('pinned', '1', async (ctx) => ctx.step('ext.ping', {}, { transport: 'db' }));
    const run = startRun(engine, 'pinned', {}, 's1');
    await expect.poll(() => building).toBe(true);
    const shutdown = provider.shutdown();
    release();
    await Promise.all([run, shutdown]);
    expect(db.closed).toBe(true);
    expect(db.dispatched).toEqual([]);
  });

  it('after a restart, builds the transports pending steps name, though no run pins them again', async () => {
    const store = new InMemoryStateStore();
    const before = new FakeTransport();
    const first = await engineFor(
      {
        transport: 'queue',
        transports: { queue: async () => new FakeTransport(), db: async () => before },
      },
      'web',
      store,
    );
    first.engine.register('pinned', '1', async (ctx) =>
      ctx.step('ext.ping', {}, { transport: 'db' }),
    );
    expect((await startRun(first.engine, 'pinned', {}, 'r1')).status).toBe('suspended');
    expect((await store.getCheckpoint('r1', 0))?.transport).toBe('db');
    await first.provider.shutdown();

    // The restarted process: `db` is built while the engine is, before any run is driven.
    const after = new FakeTransport();
    let builds = 0;
    const second = await engineFor(
      {
        transport: 'queue',
        transports: {
          queue: async () => new FakeTransport(),
          db: async () => {
            builds += 1;
            return after;
          },
          bull: async () => {
            throw new Error('never built: no pending step names it');
          },
        },
      },
      'web',
      store,
    );
    expect(builds).toBe(1);
    expect(second.engine.transportsBuiltOnDemand).toEqual(['db']);
    second.engine.register('pinned', '1', async (ctx) =>
      ctx.step('ext.ping', {}, { transport: 'db' }),
    );
    const task = before.dispatched[0] as RemoteTask;
    await after.resultHandler?.({
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output: 'pong',
    });
    await expect.poll(async () => (await second.engine.getRun('r1'))?.status).toBe('completed');
    await second.provider.shutdown();
    expect(after.closed).toBe(true);
  });

  it('a transport built on demand joins after transportPool, so unpinned failover is unchanged', async () => {
    const queue = new FakeTransport();
    const pooled = new FakeTransport();
    const bull = new FakeTransport();
    const { engine, provider } = await engineFor({
      transport: 'queue',
      transportPool: ['db'],
      transports: { queue: async () => queue, db: async () => pooled, bull: async () => bull },
    });
    engine.register('pinned', '1', async (ctx) => ctx.step('ext.ping', {}, { transport: 'bull' }));
    engine.register('plain', '1', async (ctx) => ctx.step('ext.ping', {}));
    await startRun(engine, 'pinned', {}, 'o1');
    queue.failDispatch = true;
    await startRun(engine, 'plain', {}, 'o2');
    expect(bull.dispatched.map((t) => t.runId)).toEqual(['o1']);
    expect(pooled.dispatched.map((t) => [t.runId, t.transport])).toEqual([['o2', 'db']]);
    await provider.shutdown();
  });
});
