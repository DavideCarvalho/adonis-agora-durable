import type { ApplicationService } from '@adonisjs/core/types';
import { describe, expect, it, vi } from 'vitest';
import DurableProvider from '../providers/durable_provider.js';
import { runTick } from '../src/commands/worker.js';
import type { DurableConfig } from '../src/define_config.js';
import { type StateStore, WorkflowEngine, type WorkflowRun } from '../src/index.js';
import { LucidStateStore } from '../src/stores/lucid.js';
import { makeStoreDb } from '../src/stores/lucid-helpers.js';
import { DURABLE_TABLES } from '../src/stores/lucid-schema.js';
import { InMemoryStateStore } from '../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../src/testing/in-memory-transport.js';

/**
 * Provider wiring for three things a web pod's config decides:
 * - `drive: false` — the process never executes a run (it stays `pending` for a driving instance);
 * - shutdown — every store-backed process drains its in-flight runs before closing the transport;
 * - an absent `namespace` — the default pool on a standalone engine, the operator on a control plane.
 */

function fakeApp(config: DurableConfig, environment = 'web') {
  let factory: (() => unknown) | undefined;
  let singleton: unknown;
  const app = {
    config: { get: (key: string, fallback?: unknown) => (key === 'durable' ? config : fallback) },
    getEnvironment: () => environment,
    makePath: (...parts: string[]) => ['/app', ...parts].join('/'),
    container: {
      singleton: (_key: unknown, f: () => unknown) => {
        factory = f;
      },
      make: async (key: unknown) => {
        if (key === WorkflowEngine) {
          if (!singleton) singleton = await factory?.();
          return singleton as WorkflowEngine;
        }
        const Ctor = key as new () => unknown;
        return new Ctor();
      },
    },
  } as unknown as ApplicationService;
  const provider = new DurableProvider(app);
  provider.register();
  return {
    provider,
    resolve: async () => (await app.container.make(WorkflowEngine)) as WorkflowEngine,
  };
}

const withStore = (store: StateStore, extra: Partial<DurableConfig> = {}): DurableConfig =>
  ({ store: 'mem', stores: { mem: async () => store }, ...extra }) as DurableConfig;

async function until(check: () => Promise<boolean>, max = 400): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never held');
}

const run = (id: string, namespace?: string): WorkflowRun => ({
  id,
  workflow: 'echo',
  workflowVersion: '1',
  status: 'pending',
  input: { id },
  ...(namespace !== undefined ? { namespace } : {}),
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('drive: false', () => {
  it('a started run stays pending; durable:work’s tick executes it', async () => {
    const store = new InMemoryStateStore();
    const { resolve } = fakeApp(withStore(store, { drive: false }));
    const engine = await resolve();
    engine.register('echo', '1', async (_ctx, input) => input);

    await engine.start('echo', { n: 1 }, 'r1');
    await new Promise((r) => setTimeout(r, 30));
    expect((await store.getRun('r1'))?.status).toBe('pending');

    await runTick(engine);
    await until(async () => (await store.getRun('r1'))?.status === 'completed');
    expect((await store.getRun('r1'))?.output).toEqual({ n: 1 });
  });

  it('throws at boot together with the embedded worker', () => {
    expect(() =>
      fakeApp(withStore(new InMemoryStateStore(), { drive: false, worker: { embedded: true } })),
    ).toThrow(/drive: false.*embedded/);
  });

  it('an explicit runDispatcher still decides where a run goes', async () => {
    const dispatched: string[] = [];
    const { resolve } = fakeApp(
      withStore(new InMemoryStateStore(), {
        drive: false,
        runDispatcher: { dispatch: (id: string) => void dispatched.push(id) },
      }),
    );
    const engine = await resolve();
    engine.register('echo', '1', async (_ctx, input) => input);
    await engine.start('echo', {}, 'r1');
    expect(dispatched).toEqual(['r1']);
  });

  it('drive: true (the default) executes the run in-process', async () => {
    const store = new InMemoryStateStore();
    const { resolve } = fakeApp(withStore(store));
    const engine = await resolve();
    engine.register('echo', '1', async (_ctx, input) => input);
    await engine.start('echo', {}, 'r1');
    await until(async () => (await store.getRun('r1'))?.status === 'completed');
  });
});

describe('shutdown drains the engine', () => {
  function slowApp(store: StateStore, stepMs: number, extra: Partial<DurableConfig> = {}) {
    const transport = new InMemoryTransport() as InMemoryTransport & {
      close?: () => Promise<void>;
    };
    let closedWith: string | undefined;
    // Records the close, and whether the run was already settled at that moment.
    transport.close = async () => {
      closedWith = (await store.getRun('r1'))?.status ?? 'closed';
    };
    transport.handle('slow', async () => {
      await new Promise((r) => setTimeout(r, stepMs));
      return 'done';
    });
    const app = fakeApp(
      withStore(store, {
        transport: 'mem',
        transports: { mem: async () => transport },
        ...extra,
      } as Partial<DurableConfig>),
    );
    return { ...app, closed: () => closedWith };
  }

  it('waits for a run in flight on a web process before closing the transport', async () => {
    const store = new InMemoryStateStore();
    const { provider, resolve, closed } = slowApp(store, 80);
    const engine = await resolve();
    engine.register('wf', '1', async (ctx) => ctx.step('slow', {}));
    await engine.start('wf', {}, 'r1');
    await until(async () => (await store.getRun('r1'))?.lockedBy !== undefined);

    await provider.shutdown();
    // The transport closed only after the run settled.
    expect(closed()).toBe('completed');
    expect((await store.getRun('r1'))?.status).toBe('completed');
  });

  it('gives up after drainTimeoutMs and releases the lease of a run still executing', async () => {
    const store = new InMemoryStateStore();
    const { provider, resolve } = slowApp(store, 5_000, { drainTimeoutMs: 50 });
    const engine = await resolve();
    // A body still executing in-process (not suspended on a step): it holds the run lease.
    engine.register('busy', '1', async () => new Promise(() => {}));
    await engine.start('busy', {}, 'b1');
    await until(async () => (await store.getRun('b1'))?.lockedBy !== undefined);

    const started = Date.now();
    await provider.shutdown();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await store.getRun('b1'))?.lockedBy).toBeUndefined();
  });
});

describe('an absent namespace', () => {
  it('standalone: the default pool only — another pool’s run on the shared store is left alone', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(run('theirs', 'other'));
    await store.createRun(run('ours', 'default'));
    await store.createRun(run('legacy')); // a row written before namespaces existed
    const { resolve } = fakeApp(withStore(store));
    const engine = await resolve();
    engine.register('echo', '1', async (_ctx, input) => input);

    await engine.runPending();
    await until(async () => (await store.getRun('legacy'))?.status === 'completed');
    expect((await store.getRun('ours'))?.status).toBe('completed');
    expect((await store.getRun('theirs'))?.status).toBe('pending');
    // And what it starts is stamped into the default pool.
    await engine.start('echo', {}, 'fresh');
    expect((await store.getRun('fresh'))?.namespace).toBe('default');
  });

  it('standalone on Lucid: a legacy row stored with no namespace is in the default pool', async () => {
    const db = await makeStoreDb();
    try {
      const store = new LucidStateStore(db);
      const now = Date.now();
      // Inserted by hand without the column: the schema's DEFAULT fills it, as for a pre-namespace row.
      await db.table(DURABLE_TABLES.runs).insert({
        id: 'legacy',
        workflow: 'echo',
        workflow_version: '1',
        status: 'pending',
        input: '{}',
        created_at: now,
        updated_at: now,
      });
      await store.createRun(run('theirs', 'other'));
      const { resolve } = fakeApp(withStore(store));
      const engine = await resolve();
      engine.register('echo', '1', async (_ctx, input) => input);
      await engine.runPending();
      await until(async () => (await store.getRun('legacy'))?.status === 'completed');
      expect((await store.getRun('theirs'))?.status).toBe('pending');
    } finally {
      await db.manager.closeAll();
    }
  });

  it('control-plane: the operator — it drives every pool', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(run('theirs', 'other'));
    await store.createRun(run('ours', 'default'));
    const { resolve } = fakeApp(
      withStore(store, { role: 'control-plane' } as Partial<DurableConfig>),
    );
    const engine = await resolve();
    engine.register('echo', '1', async (_ctx, input) => input);
    await engine.runPending();
    await until(async () => (await store.getRun('theirs'))?.status === 'completed');
    expect((await store.getRun('ours'))?.status).toBe('completed');
  });

  it('an explicit namespace still wins', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(run('theirs', 'other'));
    await store.createRun(run('ours', 'default'));
    const { resolve } = fakeApp(withStore(store, { namespace: 'other' }));
    const engine = await resolve();
    engine.register('echo', '1', async (_ctx, input) => input);
    await engine.runPending();
    await until(async () => (await store.getRun('theirs'))?.status === 'completed');
    expect((await store.getRun('ours'))?.status).toBe('pending');
  });
});

describe('declarative queues, dead-letter default and retention bounds', () => {
  it('registers config.queues on the engine at boot', async () => {
    const spy = vi.spyOn(WorkflowEngine.prototype, 'registerQueue');
    try {
      const { resolve } = fakeApp(
        withStore(new InMemoryStateStore(), {
          queues: [
            { name: 'emails', concurrency: 10, rateLimit: { limit: 1000, periodMs: 3_600_000 } },
            { name: 'reports', concurrency: 1 },
          ],
        }),
      );
      await resolve();
      expect(spy.mock.calls.map(([q]) => q.name)).toEqual(['emails', 'reports']);
    } finally {
      spy.mockRestore();
    }
  });

  it('a queue named twice in config throws at boot', async () => {
    const { resolve } = fakeApp(
      withStore(new InMemoryStateStore(), { queues: [{ name: 'emails' }, { name: 'emails' }] }),
    );
    await expect(resolve()).rejects.toThrow(/queue "emails" twice/);
  });

  it('a config-level deadLetterWorkflow receives dead runs', async () => {
    const store = new InMemoryStateStore();
    const { resolve } = fakeApp(
      withStore(store, { deadLetterWorkflow: 'global-dlq', maxRecoveryAttempts: 0 }),
    );
    const engine = await resolve();
    engine.register('echo', '1', async () => 'x');
    engine.register('global-dlq', '1', async (_ctx, input) => input);
    await store.createRun({ ...run('r1'), status: 'running' });
    await engine.recoverIncomplete();
    await until(async () => (await store.getRun('dlq:r1'))?.status === 'completed');
  });

  it('a retention policy with neither maxAge nor maxCount throws at boot', async () => {
    const { resolve } = fakeApp(
      withStore(new InMemoryStateStore(), {
        retention: { policies: [{ statuses: ['completed'], scope: {} }] },
      }),
    );
    await expect(resolve()).rejects.toThrow(/maxAge and\/or maxCount/);
  });
});
