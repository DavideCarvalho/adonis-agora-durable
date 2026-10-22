import { join } from 'node:path';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DurableProvider from '../../providers/durable_provider.js';
import type { DurableConfig } from '../../src/define_config.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkflowRun } from '../../src/interfaces.js';
import { DURABLE_RUN_GATEWAY, DURABLE_WORKER_RUNTIME } from '../../src/role_bindings.js';
import type { ProxyRunGateway } from '../../src/run-gateway/proxy-run-gateway.js';
import { RunRequestResponder } from '../../src/run-gateway/run-request-responder.js';
import { StoreRunGateway } from '../../src/run-gateway/store-run-gateway.js';
import { hmacTenantVerifier, signTenantToken } from '../../src/run-gateway/tenant-auth.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { transports } from '../../src/transports/factory.js';
import { QueueTransport } from '../../src/transports/queue.js';
import { MockAdapter } from '../../src/transports/queue-mock-adapter.js';
import { MemoryWorkerKeys } from '../../src/transports/worker-keys.js';
import type { WorkerRuntime } from '../../src/worker-runtime/worker-runtime.js';

/**
 * A tenant pod configured the way the docs show — `partition` (and `instanceId`) set ONLY at the top
 * level of `config/durable.ts`, never on the transport — must consume its own `<name>@<tenant>`
 * queues, the ones the control plane dispatches that tenant's steps to.
 */

const SECRET = 'partition-e2e-secret';

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeApp(config: DurableConfig) {
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
    container,
  } as unknown as ApplicationService;
  return { app, container };
}

const terminal = (run: WorkflowRun | null) =>
  !!run && run.status !== 'pending' && run.status !== 'running' && run.status !== 'suspended';

describe('tenant pod with a top-level partition only (provider-built transport)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    vi.restoreAllMocks();
  });

  function controlPlane(adapter: MockAdapter) {
    const keys = new MemoryWorkerKeys();
    const store = new InMemoryStateStore();
    const cpTransport = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: 5,
      stalledCheckIntervalMs: 0,
      instanceId: 'control-plane',
      workerKeys: keys,
      workerKeysCacheMs: 0,
      tenantSubscribersCacheMs: 0,
    });
    const engine = new WorkflowEngine({ store, transport: cpTransport });
    engine.register('checkout', '1', async (ctx, input) => ({
      paid: await ctx.step<{ ref: string }>('charge', input),
    }));
    const responder = new RunRequestResponder(
      cpTransport,
      new StoreRunGateway(engine, { role: 'control-plane' }),
      {
        verifyTenant: hmacTenantVerifier(SECRET),
        subscribeEngineEvents: (listener) => engine.subscribe(listener),
      },
    );
    responder.start();
    cleanups.push(
      () => cpTransport.close(),
      () => responder.stop(),
    );
    return { store, cpTransport };
  }

  async function tenantPod(adapter: MockAdapter, transportPartition?: string) {
    const { app, container } = makeApp({
      role: 'tenant',
      transport: 'queue',
      transports: {
        queue: transports.queue({
          adapter: () => adapter,
          workerKeys: false,
          pollIntervalMs: 5,
          stalledCheckIntervalMs: 0,
          ...(transportPartition !== undefined ? { partition: transportPartition } : {}),
        }),
      },
      partition: 'acme',
      instanceId: 'acme-pod',
      tenant: { token: signTenantToken('acme', SECRET) },
      requestTimeoutMs: 2000,
    } as DurableConfig);
    const provider = new DurableProvider(app);
    provider.register();
    const proxy = (await container.make(DURABLE_RUN_GATEWAY)) as ProxyRunGateway;
    const runtime = (await container.make(DURABLE_WORKER_RUNTIME)) as WorkerRuntime;
    cleanups.push(() => provider.shutdown());
    return { proxy, runtime };
  }

  it("serves the tenant's <name>@<tenant> step queue the control plane dispatches to", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new MockAdapter();
    const { store, cpTransport } = controlPlane(adapter);
    const { proxy, runtime } = await tenantPod(adapter);
    const charged: unknown[] = [];
    runtime.handle('charge', async (input) => {
      charged.push(input);
      return { ref: 'ch_1' };
    });
    void runtime.start();
    cleanups.push(() => runtime.stop());

    const started = await proxy.start('checkout', { amount: 5 });
    await until(async () => terminal(await store.getRun(started.runId)));
    expect(await store.getRun(started.runId)).toMatchObject({
      status: 'completed',
      namespace: 'acme',
      output: { paid: { ref: 'ch_1' } },
    });
    expect(charged).toEqual([{ amount: 5 }]);
    // The pod advertises its partitioned group, not the bare one.
    await until(async () => (await cpTransport.listWorkerGroups()).includes('charge@acme'));
    expect(await cpTransport.listWorkerGroups()).not.toContain('charge');
  });

  it('an explicit transport-level partition still wins over the top-level one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new MockAdapter();
    const polled = new Set<string>();
    const popFrom = adapter.popFrom.bind(adapter);
    adapter.popFrom = async (queue: string) => {
      polled.add(queue);
      return popFrom(queue);
    };
    const { runtime } = await tenantPod(adapter, 'explicit');
    runtime.handle('charge', async () => ({ ref: 'x' }));
    void runtime.start();
    cleanups.push(() => runtime.stop());
    await until(() => [...polled].some((q) => q.includes('charge@')));
    const taskQueues = [...polled].filter((q) => q.includes('charge'));
    expect(taskQueues.some((q) => q.includes('charge@explicit'))).toBe(true);
    expect(taskQueues.some((q) => q.includes('charge@acme'))).toBe(false);
  });
});
