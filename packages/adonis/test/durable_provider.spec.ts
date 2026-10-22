import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import DurableProvider from '../providers/durable_provider.js';
import type { DurableConfig } from '../src/define_config.js';
import {
  InMemoryAdmissionBackend,
  InMemoryStateStore,
  type StepCheckpoint,
  WorkflowEngine,
} from '../src/index.js';

/** In-memory store recording every checkpoint write, so a skipped write is observable. */
class CheckpointSpyStore extends InMemoryStateStore {
  readonly writes: { name: string; status: string }[] = [];
  override async saveCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    this.writes.push({ name: checkpoint.name, status: checkpoint.status });
    await super.saveCheckpoint(checkpoint);
  }
  statusesFor(name: string): string[] {
    return this.writes.filter((w) => w.name === name).map((w) => w.status);
  }
}

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
      make: async (key: unknown) => {
        // O container real: `make(WorkflowEngine)` resolve o singleton registrado; `make(Ctor)`
        // (usado pelo workflow factory para injeção) instancia a classe.
        if (key === WorkflowEngine) {
          if (!singletonInstance) singletonInstance = await factory?.();
          return singletonInstance as WorkflowEngine;
        }
        const Ctor = key as new () => unknown;
        return new Ctor();
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

  it('forwards eventBufferTtl (a duration) to the engine as eventBufferTtlMs', async () => {
    const { app, resolve } = fakeApp({ eventBufferTtl: '2h' });
    new DurableProvider(app).register();
    const engine = await resolve();
    expect((engine as unknown as { eventBufferTtlMs: number }).eventBufferTtlMs).toBe(7_200_000);
  });

  it('scopeReads hands the engine the store fenced to its namespace', async () => {
    const inner = new InMemoryStateStore();
    await inner.createRun({
      id: 'theirs',
      workflow: 'wf',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      namespace: 'globex',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { app, resolve } = fakeApp({
      namespace: 'acme',
      scopeReads: true,
      store: 'mem',
      stores: { mem: async () => inner },
    } as DurableConfig);
    new DurableProvider(app).register();
    const engine = await resolve();
    expect(await engine.getRun('theirs')).toBeNull();
    expect(await inner.getRun('theirs')).not.toBeNull();
  });

  it('forwards remoteAdvanceSilenceMs to the engine (unset by default)', async () => {
    const configured = fakeApp({ remoteAdvanceSilenceMs: 120_000 });
    new DurableProvider(configured.app).register();
    const engine = await configured.resolve();
    expect((engine as unknown as { remoteAdvanceSilenceMs?: number }).remoteAdvanceSilenceMs).toBe(
      120_000,
    );
    const plain = fakeApp();
    new DurableProvider(plain.app).register();
    const defaults = await plain.resolve();
    expect(
      (defaults as unknown as { remoteAdvanceSilenceMs?: number }).remoteAdvanceSilenceMs,
    ).toBeUndefined();
  });

  it('forwards timerBatchSize to the engine', async () => {
    const { app, resolve } = fakeApp({ timerBatchSize: 50 });
    new DurableProvider(app).register();
    const engine = await resolve();
    expect((engine as unknown as { timerBatchSize: number }).timerBatchSize).toBe(50);
  });

  it('forwards reconcileMs and blockedPollMs to the engine', async () => {
    const { app, resolve } = fakeApp({ reconcileMs: 60_000, blockedPollMs: 250 });
    new DurableProvider(app).register();
    const engine = await resolve();
    const deps = engine as unknown as { reconcileMs?: number; blockedPollMs: number };
    expect(deps.reconcileMs).toBe(60_000);
    expect(deps.blockedPollMs).toBe(250);
  });

  it('reconcileMs: 0 disables the fallback; non-finite tuning values fall back to the defaults', async () => {
    const off = fakeApp({ reconcileMs: 0, blockedPollMs: 0 });
    new DurableProvider(off.app).register();
    const disabled = (await off.resolve()) as unknown as {
      reconcileMs?: number;
      blockedPollMs: number;
    };
    expect(disabled.reconcileMs).toBeUndefined();
    expect(disabled.blockedPollMs).toBe(5000);

    const bad = fakeApp({ reconcileMs: Number.NaN, blockedPollMs: Number.POSITIVE_INFINITY });
    new DurableProvider(bad.app).register();
    const guarded = (await bad.resolve()) as unknown as {
      reconcileMs?: number;
      blockedPollMs: number;
    };
    expect(guarded.reconcileMs).toBe(300_000);
    expect(guarded.blockedPollMs).toBe(5000);
  });

  it('forwards config.webhookUrl so ctx.webhook() gets a public url', async () => {
    const { app, resolve } = fakeApp({
      webhookUrl: (token) => `https://api.example.com/durable/webhooks/${token}`,
    });
    new DurableProvider(app).register();
    const engine = await resolve();
    let url: string | undefined;
    engine.register('wf', '1', async (ctx) => {
      url = ctx.webhook().url;
      return 'ok';
    });
    await engine.start('wf', {}, 'hook-run');
    await engine.waitForRun('hook-run');
    expect(url).toMatch(/^https:\/\/api\.example\.com\/durable\/webhooks\/.+/);
  });

  it('leaves the webhook url undefined when config.webhookUrl is omitted', async () => {
    const { app, resolve } = fakeApp();
    new DurableProvider(app).register();
    const engine = await resolve();
    let url: string | undefined = 'unset';
    engine.register('wf', '1', async (ctx) => {
      url = ctx.webhook().url;
      return 'ok';
    });
    await engine.start('wf', {}, 'hook-run-2');
    await engine.waitForRun('hook-run-2');
    expect(url).toBeUndefined();
  });

  it('forwards a ready admission backend instance', async () => {
    const backend = new InMemoryAdmissionBackend(() => Date.now());
    const { app, resolve } = fakeApp({ admission: backend });
    new DurableProvider(app).register();
    const engine = await resolve();
    engine.registerQueue({ name: 'billing', concurrency: 1 });
    // The engine registered the queue on OUR backend, not on its own in-process default.
    expect(backend.handles('billing')).toBe(true);
  });

  it('calls an admission factory thunk at boot and forwards what it builds', async () => {
    const backend = new InMemoryAdmissionBackend(() => Date.now());
    let calls = 0;
    const { app, resolve } = fakeApp({
      admission: async () => {
        calls += 1;
        return backend;
      },
    });
    new DurableProvider(app).register();
    const engine = await resolve();
    engine.registerQueue({ name: 'billing', concurrency: 1 });
    expect(calls).toBe(1);
    expect(backend.handles('billing')).toBe(true);
  });

  it('forwards trackStepStart: false so a local step skips its `running` checkpoint write', async () => {
    const store = new CheckpointSpyStore();
    const { app, resolve } = fakeApp({
      trackStepStart: false,
      store: 'spy',
      stores: { spy: async () => store },
    });
    new DurableProvider(app).register();
    const engine = await resolve();
    engine.register('wf', '1', async (ctx) => ctx.localStep('a', async () => 1));
    await engine.start('wf', {}, 'track-off');
    await engine.waitForRun('track-off');
    // Only the settled write — the extra in-flight `running` checkpoint is skipped.
    expect(store.statusesFor('a')).toEqual(['completed']);
  });

  it('keeps the `running` checkpoint write when trackStepStart is omitted (default on)', async () => {
    const store = new CheckpointSpyStore();
    const { app, resolve } = fakeApp({ store: 'spy', stores: { spy: async () => store } });
    new DurableProvider(app).register();
    const engine = await resolve();
    engine.register('wf', '1', async (ctx) => ctx.localStep('a', async () => 1));
    await engine.start('wf', {}, 'track-on');
    await engine.waitForRun('track-on');
    expect(store.statusesFor('a')).toEqual(['running', 'completed']);
  });

  it('lets config.traceparent win over the @agora/otel:traceparent global slot', async () => {
    const OTEL_TRACEPARENT = Symbol.for('@agora/otel:traceparent');
    const g = globalThis as Record<symbol, unknown>;
    g[OTEL_TRACEPARENT] = () => 'from-global';
    try {
      const { app, resolve } = fakeApp({ traceparent: () => 'from-config' });
      new DurableProvider(app).register();
      const engine = await resolve();
      const thunk = (engine as unknown as { traceparent?: () => string | undefined }).traceparent;
      expect(thunk?.()).toBe('from-config');
    } finally {
      delete g[OTEL_TRACEPARENT];
    }
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

  it('workflowsPath: false still serves app/steps (stepsPath governs steps)', async () => {
    await mkdir(join(dir, 'app/steps'), { recursive: true });
    await writeFile(
      join(dir, 'app/steps/charge_step.ts'),
      `import { defineStep } from '${SRC}/step-ref.js'
       export const charge = defineStep('charge', async (input) => 'charged:' + input)`,
    );
    const { app, resolve } = fakeApp({ workflowsPath: false }, dir);
    const provider = new DurableProvider(app);
    provider.register();
    await provider.boot();

    // Workflows registered by hand (no discovery) still reach the auto-registered step.
    const engine = await resolve();
    engine.register('order', '1', async (ctx, input) => ctx.step('charge', input));
    await engine.start('order', 'x', 'o1');
    expect((await engine.waitForRun('o1', { terminal: true, timeoutMs: 5000 })).output).toBe(
      'charged:x',
    );
  });

  it('workflowsPath and stepsPath both false leave the engine unbuilt at boot', async () => {
    const { app } = fakeApp(
      {
        workflowsPath: false,
        stepsPath: false,
        stores: {
          s: async () => {
            throw new Error('the engine must not be built at boot');
          },
        },
        store: 's',
      },
      dir,
    );
    const provider = new DurableProvider(app);
    provider.register();
    await expect(provider.boot()).resolves.toBeUndefined();
  });

  const workflowFile = (cls: string, name: string, body: string) =>
    `import { BaseWorkflow } from '${SRC}/base-workflow.js'
     export default class ${cls} extends BaseWorkflow {
       static workflow = { name: '${name}', version: '1' }
       async run(ctx, input) { ${body} }
     }`;

  it('scans every directory of a workflowsPath / stepsPath array (no barrel)', async () => {
    await mkdir(join(dir, 'orders/flows'), { recursive: true });
    await mkdir(join(dir, 'billing/flows'), { recursive: true });
    await mkdir(join(dir, 'billing/steps'), { recursive: true });
    await writeFile(
      join(dir, 'orders/flows/order_workflow.ts'),
      workflowFile('OrderWorkflow', 'order', "return ctx.step('charge', input)"),
    );
    await writeFile(
      join(dir, 'billing/flows/refund_workflow.ts'),
      workflowFile('RefundWorkflow', 'refund', "return 'refund:' + input"),
    );
    await writeFile(
      join(dir, 'billing/steps/charge_step.ts'),
      `import { defineStep } from '${SRC}/step-ref.js'
       export const charge = defineStep('charge', async (input) => 'charged:' + input)`,
    );

    const { app, resolve } = fakeApp(
      {
        workflowsPath: ['orders/flows', 'billing/flows'],
        stepsPath: ['orders/steps', 'billing/steps'],
      },
      dir,
    );
    const provider = new DurableProvider(app);
    provider.register();
    await provider.boot();

    const engine = await resolve();
    await engine.start('order', 'x', 'o1');
    expect((await engine.waitForRun('o1', { terminal: true, timeoutMs: 5000 })).output).toBe(
      'charged:x',
    );
    await engine.start('refund', 'y', 'r1');
    expect((await engine.waitForRun('r1')).output).toBe('refund:y');
  });

  it('an empty workflowsPath array is the same as false (nothing discovered)', async () => {
    await writeFile(
      join(dir, 'order_workflow.ts'),
      workflowFile('OrderWorkflow', 'order', "return 'x'"),
    );
    const { app, resolve } = fakeApp({ workflowsPath: [] }, dir);
    const provider = new DurableProvider(app);
    provider.register();
    await provider.boot();
    await expect((await resolve()).start('order', {}, 'o1')).rejects.toThrow();
  });

  it('fails boot when two workflowsPath roots define the same workflow, naming both files', async () => {
    await mkdir(join(dir, 'a'), { recursive: true });
    await mkdir(join(dir, 'b'), { recursive: true });
    await writeFile(join(dir, 'a/charge_workflow.ts'), workflowFile('A', 'charge', "return 'a'"));
    await writeFile(join(dir, 'b/charge_workflow.ts'), workflowFile('B', 'charge', "return 'b'"));
    const { app } = fakeApp({ workflowsPath: ['a', 'b'] }, dir);
    const provider = new DurableProvider(app);
    provider.register();
    await expect(provider.boot()).rejects.toThrow(
      `${join(dir, 'a/charge_workflow.ts')} and ${join(dir, 'b/charge_workflow.ts')}`,
    );
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

  it("consumers: 'never' defers in every environment (pure producer)", async () => {
    for (const environment of ['web', 'test', 'console', 'repl']) {
      expect((await resolveWith(environment, { consumers: 'never' })).calls).toEqual(['defer']);
    }
  });

  it("engine.startConsumers() after 'never' flushes (the durable:work path)", async () => {
    const { engine, calls } = await resolveWith('web', { consumers: 'never' });
    expect(calls).toEqual(['defer']);
    // What durable:work's loop does before its first tick.
    engine.startConsumers();
    expect(calls).toEqual(['defer', 'start']);
  });
});
