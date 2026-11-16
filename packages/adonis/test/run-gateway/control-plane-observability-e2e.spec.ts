import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachDurableDiagnostics } from '../../src/diagnostics-bridge.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkflowRun } from '../../src/interfaces.js';
import { RemoteWorkflowExecutor } from '../../src/remote-workflow-executor.js';
import { ProxyRunGateway } from '../../src/run-gateway/proxy-run-gateway.js';
import { RunRequestResponder } from '../../src/run-gateway/run-request-responder.js';
import { StoreRunGateway } from '../../src/run-gateway/store-run-gateway.js';
import { sharedSecretVerifier, signTenantToken } from '../../src/run-gateway/tenant-auth.js';
import { enableRunTraceScope, runTraceId, withRunTrace } from '../../src/run-trace.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { QueueTransport } from '../../src/transports/queue.js';
import { MockAdapter } from '../../src/transports/queue-mock-adapter.js';
import { MemoryWorkerKeys } from '../../src/transports/worker-keys.js';
import { WorkerRuntime } from '../../src/worker-runtime/worker-runtime.js';

/**
 * Observability with a control plane, end to end over `QueueTransport`: the control plane records
 * the lifecycle of the tenant pod's runs (attributed to the tenant's app, once each), and the tenant
 * pod runs the step in the run's trace, the join key for what the pod records inside the step.
 */

const SECRET = 'cp-obs-secret';
const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
const TRACE_SCOPE = Symbol.for('@agora/telescope:trace-scope');
const slot = globalThis as Record<symbol, unknown>;

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const terminal = (run: WorkflowRun | null) =>
  !!run && run.status !== 'pending' && run.status !== 'running' && run.status !== 'suspended';

interface Scope {
  upstreamTraceId: string | null;
}

describe('control plane observability for a tenant pod (end to end)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    delete slot[EMIT_SLOT];
    delete slot[TRACE_SCOPE];
    enableRunTraceScope(false);
    vi.restoreAllMocks();
  });

  function cluster() {
    const emitted: Array<{
      event: string;
      payload: { runId: string; app?: string; seq?: number };
    }> = [];
    slot[EMIT_SLOT] = (_lib: string, event: string, payload: unknown) => {
      emitted.push({ event, payload: payload as (typeof emitted)[number]['payload'] });
    };
    // Telescope's trace scope, as the tenant pod's Telescope publishes it.
    const traceScope = new AsyncLocalStorage<Scope>();
    slot[TRACE_SCOPE] = traceScope;
    // What the provider does on a tenant pod.
    enableRunTraceScope();

    const adapter = new MockAdapter();
    const keys = new MemoryWorkerKeys();
    const store = new InMemoryStateStore();
    const common = { adapter: () => adapter, pollIntervalMs: 5, stalledCheckIntervalMs: 0 };

    // control plane: what the provider wires for `topology: 'control-plane'` with diagnostics.
    const cpTransport = new QueueTransport({
      ...common,
      instanceId: 'control-plane',
      workerKeys: keys,
      workerKeysCacheMs: 0,
      tenantSubscribersCacheMs: 0,
    });
    const engine = new WorkflowEngine({ store, transport: cpTransport });
    engine.register('checkout', '1', async (ctx, input) => ctx.step('charge', input));
    engine.registerRemote('remote-flow', '1', {
      group: 'remote-flow@acme',
      executor: new RemoteWorkflowExecutor(cpTransport, 'remote-flow@acme'),
    });
    const responder = new RunRequestResponder(
      cpTransport,
      new StoreRunGateway(engine, { topology: 'control-plane' }),
      {
        verifyTenant: sharedSecretVerifier({ partitions: { acme: SECRET } }),
        subscribeEngineEvents: (listener) => engine.subscribe(listener),
      },
    );
    responder.start();
    const detach = attachDurableDiagnostics(engine, {
      tenants: { namespaceOf: async (id) => (await engine.getRun(id))?.namespace },
    });

    // tenant pod `acme`: no store, no bridge (the provider attaches none on a tenant).
    const tenantTransport = new QueueTransport({
      ...common,
      instanceId: 'acme-pod',
      partition: 'acme',
    });
    const proxy = new ProxyRunGateway(tenantTransport, {
      partition: 'acme',
      token: signTenantToken('acme', SECRET),
      requestTimeoutMs: 2000,
    });
    tenantTransport.useTenantTopology();
    const runtime = new WorkerRuntime({
      transport: tenantTransport,
      partition: 'acme',
      instanceId: 'acme-pod',
    });
    const stepTraces: Array<string | null | undefined> = [];
    runtime.handle('charge', async () => {
      stepTraces.push(traceScope.getStore()?.upstreamTraceId);
      return { ref: 'ch_1' };
    });
    const turnTraces: Array<string | null | undefined> = [];
    runtime.registerWorkflow('remote-flow', (ctx, input) => {
      turnTraces.push(traceScope.getStore()?.upstreamTraceId);
      return { paid: ctx.step('charge', input) };
    });
    void runtime.start();
    cleanups.push(
      () => detach(),
      () => cpTransport.close(),
      () => tenantTransport.close(),
      () => runtime.stop(),
      () => responder.stop(),
    );
    return { proxy, store, emitted, stepTraces, turnTraces };
  }

  it("records the tenant's run on the control plane, attributed to `acme`, each transition once", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { proxy, store, emitted, stepTraces } = cluster();
    const started = await proxy.start('checkout', { amount: 5 });
    // A tenant live-tailing its run must not make the run's events counted twice.
    proxy.subscribe(started.runId, () => undefined);
    await until(async () => terminal(await store.getRun(started.runId)));
    await until(() => emitted.some((e) => e.event === 'run.completed'));

    const ofRun = emitted.filter((e) => e.payload.runId === started.runId);
    const events = ofRun.map((e) => e.event);
    expect(events).toEqual(
      expect.arrayContaining(['run.started', 'step.started', 'step.completed', 'run.completed']),
    );
    // Each transition is recorded once: nothing the tenant pod heard is forwarded again.
    const keys = ofRun.map((e) => `${e.event}:${e.payload.seq ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ofRun.every((e) => e.payload.app === 'acme')).toBe(true);
    // The tenant pod ran the step inside the run's trace.
    expect(stepTraces).toEqual([runTraceId(started.runId)]);
  });

  it('runs a remote workflow turn in its run trace too', async () => {
    const { proxy, store, turnTraces } = cluster();
    const started = await proxy.start('remote-flow', { amount: 7 });
    await until(async () => terminal(await store.getRun(started.runId)));
    expect(turnTraces.length).toBeGreaterThan(0);
    expect(new Set(turnTraces)).toEqual(new Set([runTraceId(started.runId)]));
  });
});

describe('withRunTrace', () => {
  afterEach(() => {
    delete slot[TRACE_SCOPE];
    enableRunTraceScope(false);
  });

  it('runs `fn` as is unless the tenant provider turned it on and Telescope is loaded', () => {
    const storage = new AsyncLocalStorage<Scope>();
    slot[TRACE_SCOPE] = storage;
    expect(withRunTrace({ runId: 'r' }, () => storage.getStore())).toBeUndefined();
    enableRunTraceScope();
    expect(withRunTrace({ runId: 'r' }, () => storage.getStore()?.upstreamTraceId)).toBe(
      runTraceId('r'),
    );
    delete slot[TRACE_SCOPE];
    expect(withRunTrace({ runId: 'r' }, () => 42)).toBe(42);
  });

  it('derives a stable, valid W3C trace id from the run id', () => {
    expect(runTraceId('abc')).toMatch(/^[0-9a-f]{32}$/);
    expect(runTraceId('abc')).toBe(runTraceId('abc'));
    expect(runTraceId('abc')).not.toBe(runTraceId('abd'));
  });
});
