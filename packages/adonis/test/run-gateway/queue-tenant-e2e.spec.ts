import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { EngineEvent, WorkflowRun } from '../../src/interfaces.js';
import { RemoteWorkflowExecutor } from '../../src/remote-workflow-executor.js';
import { hasProxyCapability, hasResponderCapability } from '../../src/role_bindings.js';
import { ProxyRunGateway } from '../../src/run-gateway/proxy-run-gateway.js';
import { RunRequestResponder } from '../../src/run-gateway/run-request-responder.js';
import { StoreRunGateway } from '../../src/run-gateway/store-run-gateway.js';
import { hmacTenantVerifier, signTenantToken } from '../../src/run-gateway/tenant-auth.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { QueueTransport } from '../../src/transports/queue.js';
import { MockAdapter } from '../../src/transports/queue-mock-adapter.js';
import { MemoryWorkerKeys } from '../../src/transports/worker-keys.js';
import { RedisWorkerRegistry } from '../../src/worker-runtime/registry.js';
import { WorkerRuntime } from '../../src/worker-runtime/worker-runtime.js';

/**
 * A store-less tenant pod talking to a control plane over `QueueTransport` ONLY — the topology that
 * used to need BullMQ. Two transports share one mock adapter and one worker-key store, as two processes
 * share one Redis/database:
 *
 * - control plane: a store-backed `WorkflowEngine` + `StoreRunGateway` + `RunRequestResponder` (the
 *   provider's `control-plane` wiring), republishing engine events per tenant;
 * - tenant pod (`acme`): a `ProxyRunGateway` (every read/control/start over the wire) and a
 *   `WorkerRuntime` serving the `charge` step and a `remote-flow` workflow body — no store at all.
 */

const SECRET = 'queue-e2e-secret';

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const terminal = (run: WorkflowRun | null) =>
  !!run && run.status !== 'pending' && run.status !== 'running' && run.status !== 'suspended';

describe('tenant pod ⇄ control plane over QueueTransport (end to end)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    vi.restoreAllMocks();
  });

  function cluster() {
    const adapter = new MockAdapter();
    const keys = new MemoryWorkerKeys();
    const store = new InMemoryStateStore();
    const common = { adapter: () => adapter, pollIntervalMs: 5, stalledCheckIntervalMs: 0 };

    // --- control plane -------------------------------------------------------------------------
    // Only the control plane has a worker-key store (its database, here in memory): it records the
    // tenant pods' event subscriptions there.
    const cpTransport = new QueueTransport({
      ...common,
      instanceId: 'control-plane',
      workerKeys: keys,
      workerKeysCacheMs: 0,
      tenantSubscribersCacheMs: 0,
    });
    const engine = new WorkflowEngine({ store, transport: cpTransport });
    engine.register('checkout', '1', async (ctx, input) => {
      const paid = await ctx.step<{ ref: string }>('charge', input);
      return { paid };
    });
    engine.register('await-go', '1', async (ctx) => ctx.waitForSignal('go'));
    engine.registerRemote('remote-flow', '1', {
      group: 'remote-flow@acme',
      executor: new RemoteWorkflowExecutor(cpTransport, 'remote-flow@acme'),
    });
    expect(hasResponderCapability(cpTransport)).toBe(true);
    const responder = new RunRequestResponder(
      cpTransport,
      new StoreRunGateway(engine, { role: 'control-plane' }),
      {
        verifyTenant: hmacTenantVerifier(SECRET),
        subscribeEngineEvents: (listener) => engine.subscribe(listener),
      },
    );
    responder.start();

    // --- tenant pod `acme`: no store, no worker-key store ---------------------------------------
    const tenantTransport = new QueueTransport({
      ...common,
      instanceId: 'acme-pod',
      partition: 'acme',
    });
    expect(hasProxyCapability(tenantTransport)).toBe(true);
    const proxy = new ProxyRunGateway(tenantTransport, {
      partition: 'acme',
      token: signTenantToken('acme', SECRET),
      requestTimeoutMs: 2000,
    });
    // What the provider does for a tenant pod: declare the role, then advertise through the transport.
    tenantTransport.useTenantRole();
    const runtime = new WorkerRuntime({
      transport: tenantTransport,
      partition: 'acme',
      instanceId: 'acme-pod',
      registry: new RedisWorkerRegistry(tenantTransport.createDescriptorRedis(), {
        ownsConnection: true,
      }),
    });
    const charged: unknown[] = [];
    runtime.handle('charge', async (input) => {
      charged.push(input);
      return { ref: 'ch_1' };
    });
    runtime.registerWorkflow('remote-flow', (ctx, input) => {
      const paid = ctx.step('charge', input);
      return { remote: true, paid };
    });

    void runtime.start();
    cleanups.push(
      () => cpTransport.close(),
      () => tenantTransport.close(),
      () => runtime.stop(),
      () => responder.stop(),
    );
    return { adapter, engine, proxy, charged, store, keys, cpTransport };
  }

  it('starts a run from the tenant, runs its remote step on the tenant worker, reads it back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { proxy, charged, store } = cluster();

    const started = await proxy.start('checkout', { amount: 5 });
    await until(async () => terminal(await store.getRun(started.runId)));

    const run = await proxy.getRun(started.runId);
    expect(run).toMatchObject({
      status: 'completed',
      namespace: 'acme',
      output: { paid: { ref: 'ch_1' } },
    });
    expect(charged).toEqual([{ amount: 5 }]);
    const checkpoints = await proxy.getCheckpoints(started.runId);
    expect(checkpoints.some((c) => c.name === 'charge')).toBe(true);
    expect((await proxy.listRuns({})).map((r) => r.id)).toEqual([started.runId]);
  });

  it('runs a REMOTE workflow body on the tenant worker (turns + decisions over the queue)', async () => {
    const { proxy, charged, store } = cluster();
    const started = await proxy.start('remote-flow', { amount: 7 });
    await until(async () => terminal(await store.getRun(started.runId)));
    const run = await proxy.getRun(started.runId);
    expect(run).toMatchObject({
      status: 'completed',
      output: { remote: true, paid: { ref: 'ch_1' } },
    });
    expect(charged).toEqual([{ amount: 7 }]);
  });

  it('live-tails the tenant’s run and signals it over the wire', async () => {
    const { proxy, store, keys } = cluster();
    const started = await proxy.start('await-go', {});
    const events: EngineEvent[] = [];
    proxy.subscribe(started.runId, (e) => events.push(e));
    // The subscription is announced to the control plane, which records it.
    await until(async () =>
      (await keys.live(Date.now())).some((k) => k.key.includes('-tenant-subscriber:acme:')),
    );
    await proxy.signal(started.runId, 'go', { done: true });
    await until(async () => terminal(await store.getRun(started.runId)));
    await until(() => events.some((e) => e.type === 'run.completed'));
    expect(events.every((e) => e.runId === started.runId)).toBe(true);
  });

  it('a second tenant pod gets its own replies and events, never acme’s', async () => {
    const { adapter, proxy, store } = cluster();
    const globexTransport = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: 5,
      stalledCheckIntervalMs: 0,
      instanceId: 'globex-pod',
      partition: 'globex',
    });
    cleanups.push(() => globexTransport.close());
    const globex = new ProxyRunGateway(globexTransport, {
      partition: 'globex',
      token: signTenantToken('globex', SECRET),
      requestTimeoutMs: 2000,
    });
    const acmeRun = await proxy.start('await-go', {});
    const globexRun = await globex.start('await-go', {});
    const [acmeList, globexList] = await Promise.all([proxy.listRuns({}), globex.listRuns({})]);
    expect(acmeList.map((r) => r.id)).toEqual([acmeRun.runId]);
    expect(globexList.map((r) => r.id)).toEqual([globexRun.runId]);
    // Anti-IDOR still holds over this transport.
    await expect(globex.getRun(acmeRun.runId)).rejects.toThrow(/another tenant/);
    expect((await store.getRun(acmeRun.runId))?.namespace).toBe('acme');
  });

  it('the control plane sees the store-less pod’s workers (advertisement forwarded over the queue)', async () => {
    const { cpTransport } = cluster();
    await until(async () => (await cpTransport.listWorkerGroups()).includes('charge@acme'));
    const [descriptor] = await cpTransport.listWorkerDescriptors('remote-flow@acme');
    expect(descriptor).toMatchObject({ steps: ['charge'], workflows: ['remote-flow'] });
  });
});
