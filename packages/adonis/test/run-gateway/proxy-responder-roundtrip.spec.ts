import { beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  EngineEvent,
  RunReply,
  RunRequest,
  StartRunMessage,
  TenantEvent,
} from '../../src/interfaces.js';
import {
  LIFECYCLE_REGISTRY_TAG,
  LIFECYCLE_REGISTRY_WORKFLOW,
  lifecycleRegistryRunId,
  runCompletedEvent,
} from '../../src/lifecycle-events.js';
import type { ProxyTransport } from '../../src/run-gateway/proxy-run-gateway.js';
import { ProxyRunGateway } from '../../src/run-gateway/proxy-run-gateway.js';
import type { ResponderTransport } from '../../src/run-gateway/run-request-responder.js';
import { RunRequestResponder } from '../../src/run-gateway/run-request-responder.js';
import { StoreRunGateway } from '../../src/run-gateway/store-run-gateway.js';
import { hmacTenantVerifier, signTenantToken } from '../../src/run-gateway/tenant-auth.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * A single-process in-memory P4 transport wiring a {@link ProxyRunGateway} (tenant side) to a
 * {@link RunRequestResponder} (control-plane side): a `dispatch*` on the tenant side is delivered
 * straight to the responder's consumer, whose reply is fanned back to every `onRunReply`/`onTenantEvent`
 * listener — so the FULL round-trip runs with no Redis. Failure injection (`dropRequests`, `failDispatch`)
 * proves the proxy's fail-fast paths.
 */
class FakeP4Transport implements ProxyTransport, ResponderTransport {
  #onStartRun: ((msg: StartRunMessage) => Promise<void>) | undefined;
  #onRunRequest: ((msg: RunRequest) => Promise<void>) | undefined;
  readonly #replyHandlers = new Set<(r: RunReply) => void>();
  readonly #tenantHandlers = new Map<string, Set<(e: TenantEvent) => void>>();

  /** Swallow a dispatch without delivering it to the responder — models a down/silent control plane. */
  dropRequests = false;
  /** Make a dispatch throw — models a transport-level failure. */
  failDispatch = false;

  async dispatchStartRun(msg: StartRunMessage): Promise<void> {
    if (this.failDispatch) throw new Error('transport unavailable');
    if (this.dropRequests) return;
    await this.#onStartRun?.(msg);
  }
  async dispatchRunRequest(msg: RunRequest): Promise<void> {
    if (this.failDispatch) throw new Error('transport unavailable');
    if (this.dropRequests) return;
    await this.#onRunRequest?.(msg);
  }
  onRunReply(handler: (reply: RunReply) => void): void {
    this.#replyHandlers.add(handler);
  }
  onTenantEvent(tenant: string, handler: (evt: TenantEvent) => void): () => void {
    let set = this.#tenantHandlers.get(tenant);
    if (!set) {
      set = new Set();
      this.#tenantHandlers.set(tenant, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }
  onStartRun(handler: (msg: StartRunMessage) => Promise<void>): void {
    this.#onStartRun = handler;
  }
  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void {
    this.#onRunRequest = handler;
  }
  async publishRunReply(reply: RunReply): Promise<void> {
    for (const h of this.#replyHandlers) h(reply);
  }
  async publishTenantEvent(evt: TenantEvent): Promise<void> {
    for (const h of this.#tenantHandlers.get(evt.tenant) ?? []) h(evt);
  }
}

function makeEngine(namespace: string): WorkflowEngine {
  const engine = new WorkflowEngine({ store: new InMemoryStateStore(), namespace });
  engine.register('echo', '1', async (_ctx, input) => input);
  engine.register('await-go', '1', async (ctx) => ctx.waitForSignal('go'));
  engine.register('stepper', '1', async (ctx) => ctx.localStep('do-it', async () => 'stepped'));
  engine.register('parent', '1', async (ctx) => {
    await ctx.child('echo', { from: 'parent' });
    return 'parent-done';
  });
  return engine;
}

/**
 * Wire a control plane (engine + StoreRunGateway + responder) onto `transport`. The engine is stamped
 * with `namespace` (default the primary test tenant `acme`) so it ALSO executes that tenant's runs in
 * this single process — in a real cluster a store-less acme WORKER pod would; here the coordinator
 * doubles as it, letting a run actually run to completion so the read/control verbs have real state.
 */
async function poll(fn: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

function wireControlPlane(
  transport: FakeP4Transport,
  options: { verify?: ReturnType<typeof hmacTenantVerifier>; namespace?: string } = {},
): WorkflowEngine {
  const engine = makeEngine(options.namespace ?? 'acme');
  const gateway = new StoreRunGateway(engine, { role: 'control-plane' });
  const responder = new RunRequestResponder(transport, gateway, {
    ...(options.verify ? { verifyTenant: options.verify } : {}),
    subscribeEngineEvents: (listener) => engine.subscribe(listener),
  });
  responder.start();
  return engine;
}

describe('ProxyRunGateway ↔ RunRequestResponder round-trip (prefix-only, no token)', () => {
  let transport: FakeP4Transport;
  let engine: WorkflowEngine;
  let proxy: ProxyRunGateway;

  beforeEach(() => {
    transport = new FakeP4Transport();
    engine = wireControlPlane(transport);
    proxy = new ProxyRunGateway(transport, { partition: 'acme', requestTimeoutMs: 500 });
  });

  it('topology() reports the tenant role + partition — synchronous, no round-trip', () => {
    expect(proxy.topology()).toEqual({ role: 'tenant', tenant: 'acme' });
  });

  it('start() round-trips a StartRunMessage and the control plane stamps the run with the tenant namespace', async () => {
    const started = await proxy.start('echo', { hello: 'world' });
    expect(started.runId).toBeTruthy();
    const settled = await engine.waitForRun(started.runId);
    expect(settled.status).toBe('completed');

    // The responder FORCED the run's namespace to the requester's tenant.
    const run = await proxy.getRun(started.runId);
    expect(run?.namespace).toBe('acme');
    expect(run?.workflow).toBe('echo');
  });

  it('getCheckpoints round-trips the run timeline', async () => {
    const started = await proxy.start('stepper', {});
    await engine.waitForRun(started.runId);
    const checkpoints = await proxy.getCheckpoints(started.runId);
    expect(checkpoints.some((c) => c.name === 'do-it')).toBe(true);
  });

  it('getRunChildren round-trips the parent→child fan-out over the wire (real children, not [])', async () => {
    const started = await proxy.start('parent', {}, { runId: 'p-children' });
    await engine.waitForRun(started.runId);
    // The proxy answers with the REAL child ids the responder read from the store — mutation: break the
    // `getRunChildren` verb (proxy/responder/store) and this collapses to [] → fails.
    const children = await proxy.getRunChildren('p-children');
    expect(children.length).toBe(1);
    expect(children[0]).not.toBe('p-children');
    const child = await proxy.getRun(children[0] as string);
    expect(child?.workflow).toBe('echo');
  });

  it('signal round-trips and resumes a parked run', async () => {
    const started = await proxy.start('await-go', {});
    // Deliver the signal over the wire; the run resumes and completes with the payload.
    await proxy.signal(started.runId, 'go', { delivered: true });
    const settled = await engine.waitForRun(started.runId);
    expect(settled.status).toBe('completed');
    expect(settled.output).toEqual({ delivered: true });
  });

  it('cancel round-trips and cancels the run', async () => {
    const started = await proxy.start('await-go', {});
    const result = await proxy.cancel(started.runId);
    expect(result?.status).toBe('cancelled');
  });

  it('listRuns is scoped to the requester tenant even when other tenants have runs', async () => {
    // A second tenant on the SAME control plane. Its run stamps namespace `globex`; the engine (an
    // `acme` node here) doesn't execute it, but it IS persisted — enough to prove listRuns scoping.
    const other = new ProxyRunGateway(transport, { partition: 'globex', requestTimeoutMs: 500 });
    const acmeRun = await proxy.start('echo', { who: 'acme' });
    const globexRun = await other.start('echo', { who: 'globex' });

    const acmeList = await proxy.listRuns({});
    const globexList = await other.listRuns({});
    expect(acmeList.map((r) => r.id)).toEqual([acmeRun.runId]);
    expect(globexList.map((r) => r.id)).toEqual([globexRun.runId]);
  });

  it('subscribe live-tails the tenant’s own run over the tenant-events channel', async () => {
    // Park a run, THEN subscribe, so the resume/completion events arrive after the subscription.
    const started = await proxy.start('await-go', {});
    const events: EngineEvent[] = [];
    const off = proxy.subscribe(started.runId, (e) => events.push(e));
    await proxy.signal(started.runId, 'go', { done: true });
    await engine.waitForRun(started.runId);
    off();
    expect(events.some((e) => e.runId === started.runId && e.type === 'run.completed')).toBe(true);
    // Never another run's events (filtered by runId in subscribe()).
    expect(events.every((e) => e.runId === started.runId)).toBe(true);
  });
});

describe('tenant boundary — anti-IDOR (spec §8/§9)', () => {
  let transport: FakeP4Transport;
  let engine: WorkflowEngine;
  let acme: ProxyRunGateway;
  let evil: ProxyRunGateway;

  beforeEach(() => {
    transport = new FakeP4Transport();
    engine = wireControlPlane(transport);
    acme = new ProxyRunGateway(transport, { partition: 'acme', requestTimeoutMs: 500 });
    evil = new ProxyRunGateway(transport, { partition: 'evil', requestTimeoutMs: 500 });
  });

  it('a tenant cannot READ another tenant’s run (getRun rejects cross-tenant)', async () => {
    const started = await acme.start('await-go', {});
    await expect(evil.getRun(started.runId)).rejects.toThrow(/another tenant/);
  });

  it('a tenant cannot CANCEL another tenant’s run (cancel rejects, run untouched)', async () => {
    const started = await acme.start('await-go', {});
    await expect(evil.cancel(started.runId)).rejects.toThrow(/another tenant/);
    // Proof the run was never touched: acme's own cancel still succeeds afterwards.
    const result = await acme.cancel(started.runId);
    expect(result?.status).toBe('cancelled');
  });

  it('a tenant cannot SIGNAL another tenant’s run', async () => {
    const started = await acme.start('await-go', {});
    await expect(evil.signal(started.runId, 'go', {})).rejects.toThrow(/another tenant/);
  });

  it('a tenant cannot enumerate another tenant’s CHILDREN (getRunChildren rejects cross-tenant)', async () => {
    const started = await acme.start('await-go', {});
    await expect(evil.getRunChildren(started.runId)).rejects.toThrow(/another tenant/);
  });

  it('an unknown run is not an error (returns null), so it leaks nothing about existence', async () => {
    await expect(evil.getRun('does-not-exist')).resolves.toBeNull();
  });
});

describe('layered tenant auth over the round-trip (signed token, spec §9)', () => {
  const SECRET = 'round-trip-secret';
  let transport: FakeP4Transport;
  let engine: WorkflowEngine;

  beforeEach(() => {
    transport = new FakeP4Transport();
    engine = wireControlPlane(transport, { verify: hmacTenantVerifier(SECRET) });
  });

  it('a validly-signed pod starts + reads its runs; the tenant is DERIVED from the token', async () => {
    const proxy = new ProxyRunGateway(transport, {
      partition: 'acme',
      token: signTenantToken('acme', SECRET),
      requestTimeoutMs: 500,
    });
    const started = await proxy.start('echo', { ok: true });
    await engine.waitForRun(started.runId);
    const run = await proxy.getRun(started.runId);
    expect(run?.namespace).toBe('acme'); // derived from the verified token, not the body
  });

  it('a pod presenting a token signed with the WRONG secret is rejected (unauthorized)', async () => {
    const forged = new ProxyRunGateway(transport, {
      partition: 'acme',
      token: signTenantToken('acme', 'the-wrong-secret'),
      requestTimeoutMs: 500,
    });
    await expect(forged.start('echo', {})).rejects.toThrow(/unauthorized|invalid/i);
  });

  it('a pod whose token claim was tampered cannot impersonate another tenant', async () => {
    const good = signTenantToken('acme', SECRET);
    const [, sig] = good.split('.');
    const impersonator = new ProxyRunGateway(transport, {
      partition: 'globex',
      token: `globex.${sig}`, // acme's signature over a globex claim
      requestTimeoutMs: 500,
    });
    await expect(impersonator.listRuns({})).rejects.toThrow(/unauthorized|invalid/i);
  });
});

describe('proxy fail-fast (spec §8)', () => {
  it('rejects with a clear timeout error when the control plane never replies', async () => {
    const transport = new FakeP4Transport();
    wireControlPlane(transport);
    transport.dropRequests = true; // control plane "down": request delivered nowhere
    const proxy = new ProxyRunGateway(transport, { partition: 'acme', requestTimeoutMs: 30 });
    await expect(proxy.getRun('r1')).rejects.toThrow(/did not answer getRun within 30ms/);
  });

  it('rejects immediately when the transport dispatch itself fails', async () => {
    const transport = new FakeP4Transport();
    wireControlPlane(transport);
    transport.failDispatch = true;
    const proxy = new ProxyRunGateway(transport, { partition: 'acme', requestTimeoutMs: 5_000 });
    await expect(proxy.listRuns({})).rejects.toThrow(/transport unavailable/);
  });
});

describe('republishLifecycle over the round-trip', () => {
  let transport: FakeP4Transport;
  let engine: WorkflowEngine;
  let acme: ProxyRunGateway;
  let evil: ProxyRunGateway;

  beforeEach(() => {
    transport = new FakeP4Transport();
    engine = wireControlPlane(transport);
    acme = new ProxyRunGateway(transport, { partition: 'acme', requestTimeoutMs: 500 });
    evil = new ProxyRunGateway(transport, { partition: 'evil', requestTimeoutMs: 500 });
  });

  it('republishes a tenant’s own settled run to a subscriber registered after it settled', async () => {
    const started = await acme.start('echo', { n: 1 });
    await engine.waitForRun(started.runId);
    // The run's live publish has finished before the subscriber is deployed.
    await poll(
      async () =>
        !(await engine.getRun(started.runId))?.tags?.includes('durable:lifecycle:pending'),
    );
    engine.register('audit', '1', async () => 'audited', {
      onEvent: [runCompletedEvent('echo')],
    });

    const result = await acme.republishLifecycle({ runId: started.runId, subscriber: 'audit' });
    expect(result).toEqual({ runs: 1, started: 1, failed: [] });
    expect(await acme.republishLifecycle({ runId: started.runId })).toEqual({
      runs: 1,
      started: 0,
      failed: [],
    });
  });

  it('refuses a subscriber that does not subscribe in the tenant’s namespace', async () => {
    const started = await acme.start('echo', { n: 1 });
    await engine.waitForRun(started.runId);
    await expect(
      acme.republishLifecycle({ runId: started.runId, subscriber: 'nobody' }),
    ).rejects.toMatchObject({
      code: 'bad-request',
      message: 'subscriber nobody does not subscribe to run.completed:echo',
    });
    await expect(
      acme.republishLifecycle({ workflow: 'echo', kind: 'failed', subscriber: 'nobody' }),
    ).rejects.toMatchObject({
      code: 'bad-request',
      message: 'subscriber nobody does not subscribe to run.failed:echo',
    });
    expect((await engine.getRun(started.runId))?.tags ?? []).not.toContain(
      'durable:lifecycle:owed:nobody',
    );
  });

  it('requires a positive integer limit and clamps it to 1000', async () => {
    for (const limit of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      await expect(acme.republishLifecycle({ workflow: 'echo', limit })).rejects.toMatchObject({
        code: 'bad-request',
        message: 'republishLifecycle limit must be a positive integer',
      });
    }
    const seen: unknown[] = [];
    const republish = engine.republishLifecycle.bind(engine);
    engine.republishLifecycle = async (target) => {
      seen.push(target);
      return republish(target);
    };
    await acme.republishLifecycle({ workflow: 'echo', limit: 1_000_000_000 });
    expect(seen).toEqual([expect.objectContaining({ workflow: 'echo', limit: 1000 })]);
  });

  it('rejects another tenant’s run like retry', async () => {
    const started = await acme.start('echo', {});
    await engine.waitForRun(started.runId);
    await expect(evil.republishLifecycle({ runId: started.runId })).rejects.toThrow(
      /another tenant/,
    );
    await expect(evil.retry(started.runId)).rejects.toThrow(/another tenant/);
  });

  it('republishes a workflow’s runs, confined to the tenant’s namespace', async () => {
    const store = new InMemoryStateStore();
    // An operator control plane: no namespace of its own, so it serves every tenant's runs.
    const operator = new WorkflowEngine({ store });
    operator.register('echo', '1', async (_ctx, input) => input);
    const wire = new FakeP4Transport();
    new RunRequestResponder(wire, new StoreRunGateway(operator, { role: 'control-plane' })).start();
    const tenantA = new ProxyRunGateway(wire, { partition: 'acme', requestTimeoutMs: 500 });
    const tenantB = new ProxyRunGateway(wire, { partition: 'evil', requestTimeoutMs: 500 });
    const ids = [
      (await tenantA.start('echo', { n: 1 })).runId,
      (await tenantA.start('echo', { n: 2 })).runId,
      (await tenantB.start('echo', { n: 3 })).runId,
    ];
    for (const id of ids) {
      await operator.waitForRun(id);
      await poll(
        async () => !(await store.getRun(id))?.tags?.includes('durable:lifecycle:pending'),
      );
    }
    let audited = 0;
    operator.register('audit', '1', async () => void audited++, {
      onEvent: [runCompletedEvent('echo')],
    });

    // A namespace the tenant names is replaced by its own.
    expect(
      await tenantB.republishLifecycle({ workflow: 'echo', kind: 'completed', namespace: 'acme' }),
    ).toEqual({ runs: 1, started: 1, failed: [] });
    expect(
      await tenantA.republishLifecycle({
        workflow: 'echo',
        since: new Date(0),
        until: new Date(Date.now() + 60_000),
      }),
    ).toEqual({ runs: 2, started: 2, failed: [] });
    // The operator's own subscriber is not one of the tenant's subscriptions to name.
    await expect(
      tenantA.republishLifecycle({ workflow: 'echo', subscriber: 'audit' }),
    ).rejects.toMatchObject({ code: 'bad-request' });
    expect(await tenantA.republishLifecycle({ workflow: 'echo', until: new Date(0) })).toEqual({
      runs: 0,
      started: 0,
      failed: [],
    });
    for (const id of ids) await operator.waitForRun(`evt:${id}:completed:audit`);
    expect(audited).toBe(3);
  });

  it('sends since/until as ISO strings over JSON and gets them back as dates', async () => {
    const json = new FakeP4Transport();
    const send = json.dispatchRunRequest.bind(json);
    json.dispatchRunRequest = (msg) => send(JSON.parse(JSON.stringify(msg)));
    const control = wireControlPlane(json);
    const tenant = new ProxyRunGateway(json, { partition: 'acme', requestTimeoutMs: 500 });
    const started = await tenant.start('echo', {});
    await control.waitForRun(started.runId);
    expect(
      await tenant.republishLifecycle({
        workflow: 'echo',
        since: new Date(Date.now() - 60_000),
        until: new Date(Date.now() + 60_000),
      }),
    ).toEqual({ runs: 1, started: 0, failed: [] });
    expect(
      await tenant.republishLifecycle({ workflow: 'echo', since: new Date(Date.now() + 60_000) }),
    ).toEqual({ runs: 0, started: 0, failed: [] });
  });

  it('answers who starts whom for a workflow', async () => {
    engine.register('audit', '1', async () => 'audited', {
      onEvent: [runCompletedEvent('echo')],
    });
    expect(await acme.workflowLifecycle('echo')).toEqual({
      workflow: 'echo',
      startsOnSettle: [
        {
          workflow: 'audit',
          kind: 'completed',
          local: true,
          announced: false,
          where: false,
          input: false,
        },
      ],
      startedBy: [],
    });
    expect((await acme.workflowLifecycle('audit')).startedBy.map((l) => l.workflow)).toEqual([
      'echo',
    ]);
  });

  it('shows a tenant only the subscriptions of its own namespace', async () => {
    const store = new InMemoryStateStore();
    const operator = new WorkflowEngine({ store });
    operator.register('echo', '1', async (_ctx, input) => input);
    // Registered on the operator itself, which serves the default namespace.
    operator.register('audit', '1', async () => 'audited', {
      onEvent: [runCompletedEvent('echo')],
    });
    for (const [instance, namespace, workflow] of [
      ['a', 'acme', 'notify-acme'],
      ['e', 'evil', 'notify-evil'],
    ] as const) {
      await store.createRun({
        id: lifecycleRegistryRunId(instance),
        workflow: LIFECYCLE_REGISTRY_WORKFLOW,
        workflowVersion: '1',
        status: 'completed',
        namespace,
        input: {
          instanceId: instance,
          runtime: 'node',
          subscriptions: [{ workflow, events: [runCompletedEvent('echo')] }],
        },
        tags: [LIFECYCLE_REGISTRY_TAG],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const wire = new FakeP4Transport();
    new RunRequestResponder(wire, new StoreRunGateway(operator, { role: 'control-plane' })).start();
    const tenantA = new ProxyRunGateway(wire, { partition: 'acme', requestTimeoutMs: 500 });
    const tenantB = new ProxyRunGateway(wire, { partition: 'evil', requestTimeoutMs: 500 });

    const names = (links: { startsOnSettle: { workflow: string }[] }) =>
      links.startsOnSettle.map((l) => l.workflow);
    expect(names(await operator.workflowLifecycle('echo'))).toEqual([
      'audit',
      'notify-acme',
      'notify-evil',
    ]);
    expect(names(await tenantA.workflowLifecycle('echo'))).toEqual(['notify-acme']);
    expect(names(await tenantB.workflowLifecycle('echo'))).toEqual(['notify-evil']);

    // The run detail's links are narrowed the same way.
    const started = await tenantA.start('echo', {});
    await operator.waitForRun(started.runId);
    const detail = await tenantA.getRunDetail(started.runId);
    expect(detail?.lifecycleSubscribers).toEqual(['notify-acme']);
    expect(detail && names(detail.workflowLifecycle ?? { startsOnSettle: [] })).toEqual([
      'notify-acme',
    ]);
  });

  it('keeps a tenant’s run detail links to its own namespace’s runs', async () => {
    const store = new InMemoryStateStore();
    const operator = new WorkflowEngine({ store });
    operator.register('target', '1', async (ctx) => ctx.waitForSignal(`go:${ctx.runId}`));
    operator.register('watcher', '1', async (ctx, input) =>
      ctx.waitForRun((input as { target: string }).target),
    );
    await operator.start('target', {}, 'acme-target', { namespace: 'acme' });
    await operator.start('target', {}, 'evil-target', { namespace: 'evil' });
    await operator.start('watcher', { target: 'acme-target' }, 'acme-watch', { namespace: 'acme' });
    await operator.start('watcher', { target: 'acme-target' }, 'evil-watch', { namespace: 'evil' });
    await operator.start('watcher', { target: 'evil-target' }, 'acme-peek', { namespace: 'acme' });
    const suspended = async (id: string) => (await store.getRun(id))?.status === 'suspended';
    for (let i = 0; i < 100; i++) {
      const all = await Promise.all(['acme-watch', 'evil-watch', 'acme-peek'].map(suspended));
      if (all.every(Boolean)) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const wire = new FakeP4Transport();
    new RunRequestResponder(wire, new StoreRunGateway(operator, { role: 'control-plane' })).start();
    const tenantA = new ProxyRunGateway(wire, { partition: 'acme', requestTimeoutMs: 500 });

    expect(
      (await operator.getRunDetail('acme-target'))?.awaitedBy?.map((l) => l.runId).sort(),
    ).toEqual(['acme-watch', 'evil-watch']);
    expect((await tenantA.getRunDetail('acme-target'))?.awaitedBy).toEqual([
      expect.objectContaining({ runId: 'acme-watch', status: 'suspended' }),
    ]);
    // A wait on another tenant's run keeps the id the tenant gave, not that run's status.
    expect((await tenantA.getRunDetail('acme-peek'))?.waitsFor).toEqual([
      { runId: 'evil-target', seq: expect.any(Number) },
    ]);
  });

  it('applies the tenant verifier to both verbs', async () => {
    const SECRET = 'lifecycle-secret';
    const wire = new FakeP4Transport();
    const control = wireControlPlane(wire, { verify: hmacTenantVerifier(SECRET) });
    const forged = new ProxyRunGateway(wire, {
      partition: 'acme',
      token: signTenantToken('acme', 'the-wrong-secret'),
      requestTimeoutMs: 500,
    });
    const genuine = new ProxyRunGateway(wire, {
      partition: 'acme',
      token: signTenantToken('acme', SECRET),
      requestTimeoutMs: 500,
    });
    const started = await genuine.start('echo', {});
    await control.waitForRun(started.runId);

    await expect(forged.republishLifecycle({ runId: started.runId })).rejects.toThrow(
      /unauthorized/,
    );
    await expect(forged.republishLifecycle({ workflow: 'echo' })).rejects.toThrow(/unauthorized/);
    await expect(forged.workflowLifecycle('echo')).rejects.toThrow(/unauthorized/);
    expect(await genuine.republishLifecycle({ runId: started.runId })).toEqual({
      runs: 1,
      started: 0,
      failed: [],
    });
  });
});
