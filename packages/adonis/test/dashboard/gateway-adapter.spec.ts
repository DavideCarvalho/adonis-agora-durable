import { describe, expect, it } from 'vitest';
import {
  dashboardEngineForRole,
  gatewayDashboardEngine,
  type StoreEngineLike,
  storeDashboardEngine,
} from '../../src/dashboard/gateway-adapter.js';
import { WorkflowEngine } from '../../src/engine.js';
import { DURABLE_RUN_GATEWAY } from '../../src/role_bindings.js';
import type { RunGateway } from '../../src/run-gateway/interface.js';

/** A `StoreEngineLike` spy — records which verbs `storeDashboardEngine` routes to it. */
function storeEngineSpy(): StoreEngineLike & { calls: string[] } {
  const calls: string[] = [];
  const track = <T>(label: string, value: T): T => {
    calls.push(label);
    return value;
  };
  return {
    calls,
    getRun: async (id) => track(`getRun:${id}`, null),
    listRuns: async () => track('listRuns', []),
    listCheckpoints: async (id) => track(`listCheckpoints:${id}`, []),
    getRunChildren: async (id) => track(`getRunChildren:${id}`, []),
    requeue: async (id) => track(`requeue:${id}`, null),
    cancel: async (id) => track(`cancel:${id}`, null),
    workerHealth: async () => track('workerHealth', []),
    retryWithInput: async (id) => track(`retryWithInput:${id}`, null),
    continue: async (id) => track(`continue:${id}`, null),
    // The engine's own `subscribe` is GLOBAL (every run) — the adapter narrows it to one run.
    subscribe: (listener) => {
      calls.push('subscribe');
      listener({ type: 'run.started', runId: 'other-run', at: new Date() });
      listener({ type: 'run.started', runId: 'run-1', at: new Date() });
      return () => calls.push('unsubscribe');
    },
  };
}

/** A RunGateway spy that records which verbs the adapter routes to it. */
function gatewaySpy(): RunGateway & { calls: string[] } {
  const calls: string[] = [];
  const track = <T>(label: string, value: T): T => {
    calls.push(label);
    return value;
  };
  return {
    calls,
    topology: () => ({ role: 'tenant', tenant: 'acme' }),
    getRun: async (id) => track(`getRun:${id}`, null),
    listRuns: async () => track('listRuns', []),
    getCheckpoints: async (id) => track(`getCheckpoints:${id}`, []),
    getRunChildren: async (id) => track(`getRunChildren:${id}`, ['child-a', 'child-b']),
    getSearchAttributes: async () => undefined,
    workerHealth: async () => track('workerHealth', []),
    start: async () => ({ runId: 'r', status: 'pending' }),
    signal: async () => null,
    cancel: async (id) => track(`cancel:${id}`, null),
    redispatchPending: async (id) => track(`redispatch:${id}`, null),
    subscribe: () => () => {},
  };
}

describe('gatewayDashboardEngine — RunGateway → DashboardEngine port', () => {
  it('maps listCheckpoints → getCheckpoints and requeue → redispatchPending', async () => {
    const gw = gatewaySpy();
    const engine = gatewayDashboardEngine(gw);

    await engine.listCheckpoints('run-1');
    await engine.requeue('run-1');
    await engine.cancel('run-1');
    await engine.workerHealth();
    await engine.listRuns({ limit: 10, offset: 0 });

    expect(gw.calls).toContain('getCheckpoints:run-1');
    expect(gw.calls).toContain('redispatch:run-1'); // requeue routed to the proxy recovery verb
    expect(gw.calls).toContain('cancel:run-1');
    expect(gw.calls).toContain('workerHealth');
    expect(gw.calls).toContain('listRuns');
  });

  it('routes getRunChildren → gateway.getRunChildren (P4 wire verb, real children)', async () => {
    const gw = gatewaySpy();
    const engine = gatewayDashboardEngine(gw);
    // The adapter delegates rather than degrading to [] — a tenant pod now lists real children over the
    // wire. Mutation: revert the adapter to `async () => []` and this returns [] → fails.
    expect(await engine.getRunChildren('run-1')).toEqual(['child-a', 'child-b']);
    expect(gw.calls).toContain('getRunChildren:run-1');
  });

  it('degrades retryWithInput/continue to null — no gateway verb exists yet for either', async () => {
    const gw = gatewaySpy();
    const engine = gatewayDashboardEngine(gw);
    expect(await engine.retryWithInput('run-1', {})).toBeNull();
    expect(await engine.continue('run-1')).toBeNull();
  });

  it('subscribe delegates straight to the gateway (already run-scoped, no filtering needed)', async () => {
    const gw = gatewaySpy();
    const engine = gatewayDashboardEngine(gw);
    let called = false;
    const unsubscribe = engine.subscribe('run-1', () => {
      called = true;
    });
    expect(called).toBe(false); // the gateway spy's subscribe never fires on its own
    unsubscribe();
  });
});

describe('storeDashboardEngine — WorkflowEngine → DashboardEngine port', () => {
  it('forwards every verb 1:1, including retryWithInput/continue', async () => {
    const raw = storeEngineSpy();
    const engine = storeDashboardEngine(raw);

    await engine.getRun('run-1');
    await engine.listRuns({ limit: 5, offset: 0 });
    await engine.listCheckpoints('run-1');
    await engine.getRunChildren('run-1');
    await engine.requeue('run-1');
    await engine.cancel('run-1');
    await engine.workerHealth();
    await engine.retryWithInput('run-1', { fixed: true });
    await engine.continue('run-1');

    expect(raw.calls).toEqual(
      expect.arrayContaining([
        'getRun:run-1',
        'listRuns',
        'listCheckpoints:run-1',
        'getRunChildren:run-1',
        'requeue:run-1',
        'cancel:run-1',
        'workerHealth',
        'retryWithInput:run-1',
        'continue:run-1',
      ]),
    );
  });

  it('subscribe narrows the engine-global listener to one run', async () => {
    const raw = storeEngineSpy();
    const engine = storeDashboardEngine(raw);

    const seen: string[] = [];
    const unsubscribe = engine.subscribe('run-1', (event) => seen.push(event.runId));
    unsubscribe();

    // The spy's `subscribe` fires for BOTH 'other-run' and 'run-1' — only 'run-1' should reach here.
    expect(seen).toEqual(['run-1']);
    expect(raw.calls).toContain('subscribe');
    expect(raw.calls).toContain('unsubscribe');
  });

  it('redispatchPending degrades to null when the underlying engine lacks the method', async () => {
    const raw = storeEngineSpy();
    delete raw.redispatchPending;
    const engine = storeDashboardEngine(raw);
    expect(await engine.redispatchPending('run-1')).toBeNull();
  });
});

/** A key-aware container double: an unbound key throws — exactly how we prove a tenant dashboard never
 *  reaches for the (absent) engine binding. */
function containerWith(bindings: Map<unknown, unknown>) {
  const touched: unknown[] = [];
  return {
    touched,
    async make(key: unknown) {
      touched.push(key);
      if (!bindings.has(key)) throw new Error(`no binding for ${String(key)}`);
      return bindings.get(key);
    },
  };
}

describe('dashboardEngineForRole — role-branched resolution', () => {
  it('tenant: resolves the DURABLE_RUN_GATEWAY token and NEVER touches WorkflowEngine (store-less)', async () => {
    const gw = gatewaySpy();
    // Only the gateway is bound — the engine token is deliberately ABSENT (tenant structural isolation).
    const container = containerWith(new Map<unknown, unknown>([[DURABLE_RUN_GATEWAY, gw]]));

    const engine = await dashboardEngineForRole('tenant', container, WorkflowEngine);
    // The returned port delegates to the gateway (proving it IS the proxy, not an engine).
    await engine.listRuns({ limit: 5, offset: 0 });
    expect(gw.calls).toContain('listRuns');

    // The KEY isolation assertion: it resolved the gateway token, and never asked for WorkflowEngine.
    expect(container.touched).toContain(DURABLE_RUN_GATEWAY);
    expect(container.touched).not.toContain(WorkflowEngine);
  });

  it('store role: resolves WorkflowEngine and adapts it via storeDashboardEngine (verbs still forward 1:1)', async () => {
    const fakeEngine = storeEngineSpy();
    const container = containerWith(new Map<unknown, unknown>([[WorkflowEngine, fakeEngine]]));

    const resolved = await dashboardEngineForRole('standalone', container, WorkflowEngine);
    // Not the same reference (an explicit adapter, not a raw cast — see storeDashboardEngine's doc),
    // but delegation is still 1:1: calling through the port reaches the real engine's methods.
    expect(resolved).not.toBe(fakeEngine);
    await resolved.getRun('run-1');
    expect(fakeEngine.calls).toContain('getRun:run-1');

    expect(container.touched).toContain(WorkflowEngine);
    expect(container.touched).not.toContain(DURABLE_RUN_GATEWAY);
  });
});
