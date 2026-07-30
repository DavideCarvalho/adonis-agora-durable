import { join } from 'node:path';
import type { ApplicationService, ContainerBindings } from '@adonisjs/core/types';
import { describe, expect, it } from 'vitest';
import DurableProvider from '../providers/durable_provider.js';
import type { DurableConfig } from '../src/define_config.js';
import {
  InMemoryStateStore,
  InMemoryTransport,
  ProxyRunGateway,
  RunRequestResponder,
  StoreRunGateway,
  WorkflowEngine,
} from '../src/index.js';
import type { RunReply, RunRequest, StartRunMessage, TenantEvent } from '../src/interfaces.js';
import {
  DURABLE_RUN_GATEWAY,
  DURABLE_RUN_REQUEST_RESPONDER,
  DURABLE_WORKER_RUNTIME,
} from '../src/role_bindings.js';
import type { DescriptorRedis } from '../src/worker-runtime/index.js';
import { WorkerRuntime } from '../src/worker-runtime/index.js';

/**
 * A P4-capable transport: the in-memory transport (so a store-backed engine builds and runs against it)
 * PLUS the store-less read/control/start methods (design §8), so the provider's capability probe wires a
 * `RunRequestResponder` (operator side) and a `ProxyRunGateway` (tenant side) over it. Records the
 * consumer handlers the responder installs, so a test can assert the responder actually started.
 */
class P4Transport extends InMemoryTransport {
  runRequestHandler: ((msg: RunRequest) => Promise<void>) | undefined;
  startRunHandler: ((msg: StartRunMessage) => Promise<void>) | undefined;
  replyHandler: ((reply: RunReply) => void) | undefined;

  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void {
    this.runRequestHandler = handler;
  }
  onStartRun(handler: (msg: StartRunMessage) => Promise<void>): void {
    this.startRunHandler = handler;
  }
  async publishRunReply(_reply: RunReply): Promise<void> {}
  async publishTenantEvent(_evt: TenantEvent): Promise<void> {}
  async dispatchStartRun(_msg: StartRunMessage): Promise<void> {}
  async dispatchRunRequest(_msg: RunRequest): Promise<void> {}
  onRunReply(handler: (reply: RunReply) => void): void {
    this.replyHandler = handler;
  }
  onTenantEvent(_tenant: string, _handler: (evt: TenantEvent) => void): () => void {
    return () => {};
  }
}

/** A P4 transport that also exposes the optional `createDescriptorRedis()` capability, minting a fake
 *  Redis that records every `SET key value EX ttl` — so a test can prove the tenant WorkerRuntime got a
 *  real `RedisWorkerRegistry` (advertises to Redis), not the no-op registry. */
class P4RedisTransport extends P4Transport {
  readonly sets: { key: string; value: string; ttl: number }[] = [];
  disconnected = false;

  createDescriptorRedis(): DescriptorRedis {
    return {
      set: async (key: string, value: string, _mode: 'EX', ttl: number) => {
        this.sets.push({ key, value, ttl });
        return 'OK';
      },
      disconnect: () => {
        this.disconnected = true;
      },
    };
  }
}

/** Anything the real container accepts as a resolution key here: one of the abstract tokens this package
 *  publishes into `ContainerBindings` (see `src/role_bindings.ts`), or a class constructor. */
type BindingKey = keyof ContainerBindings | (abstract new (...args: never[]) => unknown);

/** What a given {@link BindingKey} resolves to — the same mapping the real AdonisJS container applies:
 *  a published token yields its declared `ContainerBindings` type, a class key yields an instance. */
type Resolved<K extends BindingKey> = K extends keyof ContainerBindings
  ? ContainerBindings[K]
  : K extends abstract new (
        ...args: never[]
      ) => infer T
    ? T
    : never;

/** A key-aware container/app double — a faithful stand-in for the real AdonisJS container (unlike the
 *  legacy single-factory double in durable_provider.spec): each binding is keyed, and an unbound key
 *  throws on `make`, which is exactly how we prove tenant structural isolation (no store binding). */
function makeApp(config: DurableConfig, appRoot = '/app') {
  const factories = new Map<unknown, () => unknown>();
  const cache = new Map<unknown, unknown>();

  /** The untyped resolution the double actually performs: build-once, then serve from cache. */
  async function resolve(key: unknown): Promise<unknown> {
    if (cache.has(key)) return cache.get(key);
    const factory = factories.get(key);
    if (!factory) throw new Error(`no binding for ${String(key)}`);
    const value = await factory();
    cache.set(key, value);
    return value;
  }

  const container = {
    singleton(key: unknown, factory: () => unknown) {
      factories.set(key, factory);
    },
    bind(key: unknown, factory: () => unknown) {
      factories.set(key, factory);
    },
    /**
     * Typed exactly like the real container's `make`: the key decides the result type. The single cast
     * lives here, where the real container also erases its heterogeneous factory map — pushing it out to
     * the call sites would instead leave every resolved object as `unknown` and hide what the provider
     * actually bound.
     */
    async make<K extends BindingKey>(key: K): Promise<Resolved<K>> {
      return (await resolve(key)) as Resolved<K>;
    },
    hasBinding(key: unknown) {
      return factories.has(key);
    },
  };
  const app = {
    config: { get: (k: string, fb?: unknown) => (k === 'durable' ? config : fb) },
    makePath: (...parts: string[]) => join(appRoot, ...parts),
    container,
  } as unknown as ApplicationService;
  return { app, container };
}

describe('DurableProvider — role branching (standalone)', () => {
  it('binds the engine + a standalone StoreRunGateway, and runs end-to-end (embedded worker)', async () => {
    const { app, container } = makeApp({});
    new DurableProvider(app).register();

    const gateway = await container.make(DURABLE_RUN_GATEWAY);
    expect(gateway).toBeInstanceOf(StoreRunGateway);
    expect(gateway.topology()).toEqual({ role: 'standalone' });

    // The embedded worker + in-process dispatch still run a workflow to completion (today's behavior).
    const engine = await container.make(WorkflowEngine);
    engine.register('greet', '1', async (ctx) => (await ctx.localStep('a', async () => 21)) * 2);
    await engine.start('greet', {}, 'run-1');
    const result = await engine.waitForRun('run-1');
    expect(result.status).toBe('completed');
    expect(result.output).toBe(42);
  });

  it('binds no responder on a non-P4 (in-memory) transport — boot() starts nothing', async () => {
    const { app, container } = makeApp({});
    const provider = new DurableProvider(app);
    provider.register();
    await provider.boot();

    // The in-memory transport has no P4 methods, so the responder resolves to null (nothing to start).
    expect(await container.make(DURABLE_RUN_REQUEST_RESPONDER)).toBeNull();
  });

  it('starts a RunRequestResponder when the standalone transport IS P4-capable', async () => {
    const transport = new P4Transport();
    const { app, container } = makeApp({
      transport: 'p4',
      transports: { p4: async () => transport },
    });
    const provider = new DurableProvider(app);
    provider.register();
    await provider.boot();

    const responder = await container.make(DURABLE_RUN_REQUEST_RESPONDER);
    expect(responder).toBeInstanceOf(RunRequestResponder);
    // boot() started it: the responder installed its consumers on the transport.
    expect(transport.runRequestHandler).toBeTypeOf('function');
    expect(transport.startRunHandler).toBeTypeOf('function');
  });
});

describe('DurableProvider — role branching (control-plane)', () => {
  function controlPlaneConfig(transport: InMemoryTransport): DurableConfig {
    return {
      role: 'control-plane',
      store: 'mem',
      stores: { mem: async () => new InMemoryStateStore() },
      transport: 'p4',
      transports: { p4: async () => transport },
    } as DurableConfig;
  }

  it('binds a control-plane StoreRunGateway + a started responder', async () => {
    const transport = new P4Transport();
    const { app, container } = makeApp(controlPlaneConfig(transport));
    const provider = new DurableProvider(app);
    provider.register();
    await provider.boot();

    const gateway = await container.make(DURABLE_RUN_GATEWAY);
    expect(gateway).toBeInstanceOf(StoreRunGateway);
    expect(gateway.topology()).toEqual({ role: 'control-plane' });

    const responder = await container.make(DURABLE_RUN_REQUEST_RESPONDER);
    expect(responder).toBeInstanceOf(RunRequestResponder);
    expect(transport.runRequestHandler).toBeTypeOf('function');
  });

  it('uses the no-op dispatcher: a started run stays pending (pure coordinator, no inline execution)', async () => {
    const { app, container } = makeApp(controlPlaneConfig(new P4Transport()));
    new DurableProvider(app).register();

    const engine = await container.make(WorkflowEngine);
    engine.register('coord', '1', async () => 'done');
    await engine.start('coord', {}, 'cp-run');
    // Give any (wrongly-scheduled) microtask dispatch a chance to run — it must NOT, under no-op dispatch.
    await Promise.resolve();
    const run = await engine.getRun('cp-run');
    expect(run?.status).toBe('pending');
  });
});

describe('DurableProvider — role branching (tenant, store-less)', () => {
  function tenantConfig(
    transport: InMemoryTransport,
    extra: Record<string, unknown> = {},
  ): DurableConfig {
    return {
      role: 'tenant',
      transport: 'p4',
      transports: { p4: async () => transport },
      partition: 'acme',
      ...extra,
    } as DurableConfig;
  }

  it('registers NO store/engine binding — resolving the engine throws (structural isolation)', async () => {
    const { app, container } = makeApp(tenantConfig(new P4Transport()));
    new DurableProvider(app).register();

    expect(container.hasBinding(WorkflowEngine)).toBe(false);
    await expect(container.make(WorkflowEngine)).rejects.toThrow(/no binding/);
  });

  it('exposes a ProxyRunGateway with the tenant topology', async () => {
    const { app, container } = makeApp(tenantConfig(new P4Transport()));
    new DurableProvider(app).register();

    const gateway = await container.make(DURABLE_RUN_GATEWAY);
    expect(gateway).toBeInstanceOf(ProxyRunGateway);
    expect(gateway.topology()).toEqual({ role: 'tenant', tenant: 'acme' });
  });

  it('boot() is a no-op for a tenant pod (no engine to build, no workflows to scan)', async () => {
    const { app } = makeApp(tenantConfig(new P4Transport()));
    const provider = new DurableProvider(app);
    provider.register();
    await expect(provider.boot()).resolves.toBeUndefined();
  });

  it('binds a WorkerRuntime; a P4 transport with createDescriptorRedis gets a real RedisWorkerRegistry', async () => {
    const transport = new P4RedisTransport();
    const { app, container } = makeApp(tenantConfig(transport));
    new DurableProvider(app).register();

    const runtime = await container.make(DURABLE_WORKER_RUNTIME);
    expect(runtime).toBeInstanceOf(WorkerRuntime);

    // Register a step so the runtime has a routing token to advertise, then start it: a RedisWorkerRegistry
    // publishes the descriptor with SET…EX to the transport's Redis; the NoopWorkerRegistry would not.
    runtime.handle('charge', async () => ({ ok: true }));
    await runtime.start();
    expect(transport.sets.length).toBeGreaterThan(0);
    expect(transport.sets.some((s) => s.key.includes('worker-descriptor'))).toBe(true);
    await runtime.stop();
    // The registry owns the minted client and disconnects it on stop.
    expect(transport.disconnected).toBe(true);
  });

  it('falls back to the no-op registry when the transport lacks createDescriptorRedis', async () => {
    const transport = new P4Transport(); // no createDescriptorRedis
    const { app, container } = makeApp(tenantConfig(transport));
    new DurableProvider(app).register();

    const runtime = await container.make(DURABLE_WORKER_RUNTIME);
    runtime.handle('charge', async () => ({ ok: true }));
    // Starting must not throw even though nothing is published; the descriptor is still observable.
    await runtime.start();
    expect(runtime.descriptor().steps).toContain('charge');
    await runtime.stop();
  });
});
