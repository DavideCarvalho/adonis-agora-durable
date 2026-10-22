import { describe, expect, it } from 'vitest';
import { gatewayDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import { listRuns } from '../../src/dashboard/handlers.js';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  RunReply,
  RunRequest,
  RunRequestKind,
  StartRunMessage,
  TenantEvent,
} from '../../src/interfaces.js';
import type { RunGateway } from '../../src/run-gateway/interface.js';
import { ProxyRunGateway, type ProxyTransport } from '../../src/run-gateway/proxy-run-gateway.js';
import {
  type ResponderTransport,
  RunRequestResponder,
} from '../../src/run-gateway/run-request-responder.js';
import { StoreRunGateway } from '../../src/run-gateway/store-run-gateway.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * Aviary's RunGateway verbs (`retry`, `continue`, `retryWithInput`, `runFacets`, `runValueFacets`,
 * `waitingFor`) on both gateways and over the P4 wire, with the tenant boundary held on each.
 */

class Wire implements ProxyTransport, ResponderTransport {
  #onRunRequest: ((msg: RunRequest) => Promise<void>) | undefined;
  #onStartRun: ((msg: StartRunMessage) => Promise<void>) | undefined;
  readonly #replyHandlers = new Set<(r: RunReply) => void>();
  /** Verbs to answer the way a control plane before 0.50 did (unknown verb, no code). */
  legacy = new Set<RunRequestKind['kind']>();
  async dispatchStartRun(msg: StartRunMessage): Promise<void> {
    await this.#onStartRun?.(msg).catch(() => {});
  }
  async dispatchRunRequest(msg: RunRequest): Promise<void> {
    if (this.legacy.has(msg.body.kind)) {
      await this.publishRunReply({
        requestId: msg.requestId,
        result: { ok: false, error: { message: `unknown run-request verb: ${msg.body.kind}` } },
      });
      return;
    }
    await this.#onRunRequest?.(msg).catch(() => {});
  }
  onRunReply(handler: (reply: RunReply) => void): void {
    this.#replyHandlers.add(handler);
  }
  onTenantEvent(): () => void {
    return () => {};
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
  async publishTenantEvent(_evt: TenantEvent): Promise<void> {}
}

let failNext = true;

function makeEngine(store: InMemoryStateStore, namespace: string) {
  const engine = new WorkflowEngine({ store, namespace });
  engine.register(
    'flaky',
    '1',
    async (ctx) =>
      ctx.localStep('try', async () => {
        if (failNext) {
          failNext = false;
          throw new Error('first attempt fails');
        }
        return 'ok';
      }),
    { origin: '@acme/billing' },
  );
  engine.register('paused', '1', async (ctx) => {
    await ctx.breakpoint('inspect');
    return 'resumed';
  });
  engine.register('await-go', '1', async (ctx) => ctx.waitForSignal('go'));
  engine.register('echo', '1', async (_ctx, input) => input);
  return engine;
}

async function cluster(gatewayOverride?: (g: StoreRunGateway) => RunGateway) {
  const store = new InMemoryStateStore();
  const acmeEngine = makeEngine(store, 'acme');
  const globexEngine = makeEngine(store, 'globex');
  const wire = new Wire();
  const base = new StoreRunGateway(acmeEngine, { role: 'control-plane' });
  new RunRequestResponder(wire, gatewayOverride ? gatewayOverride(base) : base, {
    verifyTenant: async ({ tenant }) => (tenant ? { tenant } : null),
  }).start();
  const acme = new ProxyRunGateway(wire, { partition: 'acme', requestTimeoutMs: 2_000 });
  const globex = new ProxyRunGateway(wire, { partition: 'globex', requestTimeoutMs: 2_000 });
  return { store, acmeEngine, globexEngine, wire, base, acme, globex };
}

describe('aviary RunGateway verbs over the wire', () => {
  it('retry re-runs a failed run in place', async () => {
    failNext = true;
    const { acmeEngine, acme } = await cluster();
    await acme.start('flaky', {}, { runId: 'f1' });
    expect((await acmeEngine.waitForRun('f1')).status).toBe('failed');

    const retried = await acme.retry('f1');
    expect(retried?.runId).toBe('f1');
    expect((await acmeEngine.waitForRun('f1')).status).toBe('completed');
  });

  it('continue resumes a breakpoint, retryWithInput starts a linked run', async () => {
    const { acmeEngine, acme } = await cluster();
    await acme.start('paused', {}, { runId: 'bp1' });
    await acmeEngine.waitForRun('bp1').catch(() => undefined);
    expect(await acme.waitingFor(['bp1', 'nope'])).toEqual({
      bp1: { on: 'breakpoint', name: 'breakpoint' },
    });
    await acme.continue('bp1');
    expect((await acmeEngine.waitForRun('bp1')).output).toBe('resumed');

    await acme.start('echo', { v: 1 }, { runId: 'e1' });
    await acmeEngine.waitForRun('e1');
    const replay = await acme.retryWithInput('e1', { v: 2 });
    expect(replay?.runId).toMatch(/^e1~retry~/);
    const fixed = await acmeEngine.waitForRun(replay?.runId as string);
    expect(fixed.output).toEqual({ v: 2 });
    expect((await acme.getRun(replay?.runId as string))?.namespace).toBe('acme');
  });

  it('runFacets and runValueFacets count only the tenant’s own runs', async () => {
    failNext = false;
    const { acmeEngine, globexEngine, acme, base } = await cluster();
    await acme.start('flaky', {}, { runId: 'a1' });
    await acme.start('echo', {}, { runId: 'a2' });
    await acmeEngine.waitForRun('a1');
    await acmeEngine.waitForRun('a2');
    await globexEngine.start('echo', {}, 'g1');
    await globexEngine.waitForRun('g1');

    const facets = await acme.runFacets({ namespace: 'globex' }); // the claim is discarded
    expect(facets).toEqual(
      expect.arrayContaining([
        { status: 'completed', origin: '@acme/billing', count: 1 },
        { status: 'completed', origin: null, count: 1 },
      ]),
    );
    expect(facets.reduce((n, f) => n + f.count, 0)).toBe(2);
    // The store-backed gateway sees all three.
    expect((await base.runFacets({})).reduce((n, f) => n + f.count, 0)).toBe(3);

    const workflows = await acme.runValueFacets({ field: 'workflow' }, {});
    expect(workflows.map((r) => r.value).sort()).toEqual(['echo', 'flaky']);
  });

  it('waitingFor drops another tenant’s runs; retry/continue/retryWithInput reject cross-tenant', async () => {
    const { globexEngine, acme } = await cluster();
    await globexEngine.start('await-go', {}, 'g-wait');
    await globexEngine.start('paused', {}, 'g-bp');
    await new Promise((r) => setTimeout(r, 20));

    expect(await acme.waitingFor(['g-wait', 'g-bp'])).toEqual({});
    await expect(acme.retry('g-wait')).rejects.toMatchObject({ code: 'cross-tenant' });
    await expect(acme.continue('g-bp')).rejects.toMatchObject({ code: 'cross-tenant' });
    await expect(acme.retryWithInput('g-wait', {})).rejects.toMatchObject({
      code: 'cross-tenant',
    });
    expect(await globexEngine.continue('g-bp')).not.toBeNull(); // still paused: untouched
  });

  it('a control-plane gateway without an optional verb answers unsupported-request', async () => {
    const { acme } = await cluster(
      (g) =>
        ({
          ...Object.fromEntries(
            ['topology', 'getRun', 'listRuns', 'getCheckpoints', 'getRunChildren'].map((k) => [
              k,
              (g as unknown as Record<string, (...a: unknown[]) => unknown>)[k]?.bind(g),
            ]),
          ),
        }) as unknown as RunGateway,
    );
    await expect(acme.retry('x')).rejects.toMatchObject({ code: 'unsupported-request' });
    // runFacets degrades instead: the proxy counts the cells from the tenant's `listRuns`.
    await expect(acme.runFacets({})).resolves.toBeInstanceOf(Array);
    await expect(acme.waitingFor(['x'])).rejects.toMatchObject({ code: 'unsupported-request' });
  });
});

describe('a tenant pod’s console over the new verbs', () => {
  it('retry, continue and fix-and-replay work; list rows name what a run waits on', async () => {
    failNext = true;
    const { acmeEngine, acme } = await cluster();
    const port = gatewayDashboardEngine(acme);

    await acme.start('flaky', {}, { runId: 'cf1' });
    await acmeEngine.waitForRun('cf1');
    await port.requeue('cf1');
    expect((await acmeEngine.waitForRun('cf1')).status).toBe('completed');

    await acme.start('await-go', {}, { runId: 'cw1' });
    await new Promise((r) => setTimeout(r, 20));
    const res = await listRuns({ engine: port }, { params: {}, query: {}, body: undefined });
    const row = (res.body as { runs: Array<{ id: string; waiting?: unknown }> }).runs.find(
      (r) => r.id === 'cw1',
    );
    expect(row?.waiting).toEqual({ on: 'signal', name: 'go' });

    await acme.start('paused', {}, { runId: 'cb1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(await port.continue('cb1')).not.toBeNull();
    expect(await port.retryWithInput('cb1', {})).not.toBeNull();
  });

  it('against an older control plane each verb degrades the way it did before', async () => {
    const { wire, acme } = await cluster();
    wire.legacy = new Set(['retry', 'continue', 'retryWithInput', 'waitingFor', 'runValueFacets']);
    const port = gatewayDashboardEngine(acme);
    await acme.start('await-go', {}, { runId: 'ow1' });
    await new Promise((r) => setTimeout(r, 20));

    expect(await port.requeue('ow1')).toMatchObject({ runId: 'ow1' }); // re-dispatch, as before
    expect(await port.continue('ow1')).toBeNull();
    expect(await port.retryWithInput('ow1', {})).toBeNull();
    expect(await port.waitingFor?.(['ow1'])).toEqual({});
    const values = await port.runValueFacets?.({ field: 'workflow' }, {});
    expect(values?.map((v) => v.value)).toContain('await-go');
  });
});
