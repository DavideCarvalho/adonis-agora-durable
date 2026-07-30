import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import DurableProvider from '../providers/durable_provider.js';
import type { DurableConfig } from '../src/define_config.js';
import { InMemoryStateStore, WorkflowEngine } from '../src/index.js';

/** In-memory store that records `ensureSchema()` calls, to assert boot-time provisioning. */
class SchemaSpyStore extends InMemoryStateStore {
  ensureSchemaCalls = 0;
  async ensureSchema(): Promise<void> {
    this.ensureSchemaCalls += 1;
  }
}

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** Minimal Adonis container/app stand-in capturing the singleton factory. */
function fakeApp(config: DurableConfig = {}, appRoot = '/app', environment = 'web') {
  let factory: (() => unknown) | undefined;
  let singletonInstance: unknown;
  const app = {
    config: { get: (key: string, fallback?: unknown) => (key === 'durable' ? config : fallback) },
    getEnvironment: () => environment,
    makePath: (...parts: string[]) => join(appRoot, ...parts),
    container: {
      singleton: (_key: unknown, f: () => unknown) => {
        factory = f;
      },
      make: async () => {
        if (!singletonInstance) singletonInstance = await factory?.();
        return singletonInstance as WorkflowEngine;
      },
    },
  } as unknown as ApplicationService;
  return { app, resolve: async () => (await app.container.make(WorkflowEngine)) as WorkflowEngine };
}

describe('DurableProvider', () => {
  it('binds a WorkflowEngine built from config (in-memory defaults)', async () => {
    const { app, resolve } = fakeApp();
    new DurableProvider(app).register();

    const engine = await resolve();
    expect(engine).toBeInstanceOf(WorkflowEngine);

    // The engine works end-to-end through the binding: register + run a workflow.
    engine.register('greet', '1', async (ctx) => {
      const a = await ctx.localStep('a', async () => 21);
      return a * 2;
    });
    await engine.start('greet', {}, 'run-1');
    const result = await engine.waitForRun('run-1');

    expect(result.status).toBe('completed');
    expect(result.output).toBe(42);
  });

  it('uses the configured store', async () => {
    const { app, resolve } = fakeApp({ instanceId: 'engine-a' });
    new DurableProvider(app).register();
    expect(await resolve()).toBeInstanceOf(WorkflowEngine);
  });

  it('provisions the store schema at boot by default (autoSchema on)', async () => {
    const store = new SchemaSpyStore();
    const { app, resolve } = fakeApp({ store: 'spy', stores: { spy: async () => store } });
    new DurableProvider(app).register();
    await resolve();
    expect(store.ensureSchemaCalls).toBe(1);
  });

  it('skips schema provisioning when autoSchema is false', async () => {
    const store = new SchemaSpyStore();
    const { app, resolve } = fakeApp({
      store: 'spy',
      stores: { spy: async () => store },
      autoSchema: false,
    });
    new DurableProvider(app).register();
    await resolve();
    expect(store.ensureSchemaCalls).toBe(0);
  });

  it('consumes the @agora/otel:traceparent global slot when present (no break)', async () => {
    const OTEL_TRACEPARENT = Symbol.for('@agora/otel:traceparent');
    const g = globalThis as Record<symbol, unknown>;
    g[OTEL_TRACEPARENT] = () => '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    try {
      const { app, resolve } = fakeApp();
      new DurableProvider(app).register();
      const engine = await resolve();
      engine.register('wf', '1', async (ctx) => ctx.localStep('s', async () => 'ok'));
      await engine.start('wf', {}, 'otel-run');
      const result = await engine.waitForRun('otel-run');
      expect(result.status).toBe('completed');
      expect(result.output).toBe('ok');
    } finally {
      delete g[OTEL_TRACEPARENT];
    }
  });

  it('passes the @agora/context carrier through verbatim (opaque, no field-picking)', async () => {
    const CONTEXT_ACCESSOR = Symbol.for('@agora/context:accessor');
    const g = globalThis as Record<symbol, unknown>;
    const carrier = { correlationId: 'corr-1', userRef: 'user-7', tenantId: 'acme' };
    g[CONTEXT_ACCESSOR] = { get: () => carrier };
    try {
      const { app, resolve } = fakeApp();
      new DurableProvider(app).register();
      const engine = await resolve();
      // Reach the engine's context thunk via the same path dispatch uses.
      const ctxThunk = (engine as unknown as { context?: () => Record<string, unknown> }).context;
      // The carrier is opaque: whatever the accessor returns rides the task unchanged.
      expect(ctxThunk?.()).toBe(carrier);
    } finally {
      delete g[CONTEXT_ACCESSOR];
    }
  });

  it('forwards remoteRedispatchMs/remoteRedispatchMax to the engine', async () => {
    const { app, resolve } = fakeApp({ remoteRedispatchMs: 5 * 60 * 1000, remoteRedispatchMax: 3 });
    new DurableProvider(app).register();
    const engine = await resolve();
    const deps = engine as unknown as { remoteRedispatchMs?: number; remoteRedispatchMax?: number };
    expect(deps.remoteRedispatchMs).toBe(5 * 60 * 1000);
    expect(deps.remoteRedispatchMax).toBe(3);
  });

  it('leaves the engine defaults when remoteRedispatchMs/Max are omitted (net off by default)', async () => {
    const { app, resolve } = fakeApp();
    new DurableProvider(app).register();
    const engine = await resolve();
    const deps = engine as unknown as { remoteRedispatchMs?: number; remoteRedispatchMax?: number };
    // Unset window means the self-heal net is off; `remoteRedispatchMax` still falls back to the
    // engine's default (10) even though it's never consulted while the window is off.
    expect(deps.remoteRedispatchMs).toBeUndefined();
    expect(deps.remoteRedispatchMax).toBe(10);
  });
});

describe('DurableProvider — app/workflows auto-discovery (boot)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'durable-prov-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('scans the configured dir and auto-registers workflow classes (no manual register)', async () => {
    await writeFile(
      join(dir, 'order_workflow.ts'),
      `import { BaseWorkflow } from '${SRC}/base-workflow.js'
       export default class OrderWorkflow extends BaseWorkflow {
         static workflow = { name: 'order', version: '1' }
         async run(_ctx, input) { return 'order:' + input.id }
       }`,
    );

    // workflowsPath is given as a path relative to the (faked) app root === dir.
    const { app, resolve } = fakeApp({ workflowsPath: '.' }, dir);
    const provider = new DurableProvider(app);
    provider.register();
    await provider.boot();

    const engine = await resolve();
    await engine.start('order', { id: 'abc' }, 'o1');
    const result = await engine.waitForRun('o1');
    expect(result.status).toBe('completed');
    expect(result.output).toBe('order:abc');
  });

  it('skips discovery when workflowsPath is false', async () => {
    const { app } = fakeApp({ workflowsPath: false }, dir);
    const provider = new DurableProvider(app);
    provider.register();
    await expect(provider.boot()).resolves.toBeUndefined();
  });
});

describe('DurableProvider: consumer deferral by environment', () => {
  /** A transport double recording the deferral calls the provider makes on it. */
  function spyTransport() {
    const calls: string[] = [];
    const transport = {
      deferConsumers: () => void calls.push('defer'),
      startConsumers: () => void calls.push('start'),
      onResult: () => {},
      onHeartbeat: () => {},
      dispatch: async () => {},
      useNamespace: () => {},
    };
    return { transport, calls };
  }

  const resolveWith = async (environment: string, config: Partial<DurableConfig> = {}) => {
    const { transport, calls } = spyTransport();
    const { app, resolve } = fakeApp(
      {
        transport: 'spy',
        transports: { spy: () => transport as never },
        ...config,
      } as DurableConfig,
      '/app',
      environment,
    );
    new DurableProvider(app).register();
    const engine = await resolve();
    return { engine, calls };
  };

  it("defers a console process's consumers; engine.startConsumers() flushes them", async () => {
    const { engine, calls } = await resolveWith('console');
    expect(calls).toEqual(['defer']);
    // What durable:work's loop does before its first tick.
    engine.startConsumers();
    expect(calls).toEqual(['defer', 'start']);
  });

  it('a repl process defers too; web and test processes stay eager', async () => {
    expect((await resolveWith('repl')).calls).toEqual(['defer']);
    expect((await resolveWith('web')).calls).toEqual([]);
    expect((await resolveWith('test')).calls).toEqual([]);
  });

  it("consumers: 'always' keeps a console process eager (the pre-0.17 behavior)", async () => {
    const { calls } = await resolveWith('console', { consumers: 'always' });
    expect(calls).toEqual([]);
  });
});
