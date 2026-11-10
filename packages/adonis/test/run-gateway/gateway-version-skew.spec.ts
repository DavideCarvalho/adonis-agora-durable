import { describe, expect, it } from 'vitest';
import { gatewayDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import { republishLifecycleRun, workflowLifecycle } from '../../src/dashboard/handlers.js';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  RunReply,
  RunRequest,
  RunRequestKind,
  StartRunMessage,
  TenantEvent,
} from '../../src/interfaces.js';
import type { RunGateway } from '../../src/run-gateway/interface.js';
import {
  ProxyRunGateway,
  type ProxyTransport,
  RunGatewayError,
} from '../../src/run-gateway/proxy-run-gateway.js';
import {
  type ResponderTransport,
  RunRequestResponder,
} from '../../src/run-gateway/run-request-responder.js';
import { StoreRunGateway } from '../../src/run-gateway/store-run-gateway.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * A tenant and a control plane on different releases (a rolling upgrade), and a control plane whose
 * gateway throws. Every request must get a reply: an unanswered one makes the tenant wait out its
 * whole timeout. And a newer tenant must still render run detail against an older control plane.
 */

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

/**
 * In-memory P4 wire. `legacy` lists verbs to answer the way a control plane that does not know a
 * verb answers (`unsupported-request`), without reaching the real responder.
 */
class Wire implements ProxyTransport, ResponderTransport {
  #onRunRequest: ((msg: RunRequest) => Promise<void>) | undefined;
  #onStartRun: ((msg: StartRunMessage) => Promise<void>) | undefined;
  readonly #replyHandlers = new Set<(r: RunReply) => void>();
  readonly requests: RunRequestKind['kind'][] = [];
  readonly replies: RunReply[] = [];
  legacy = new Set<RunRequestKind['kind']>();

  // Like a broker queue, a dispatch never sees the consumer's failure: a consumer that throws
  // without replying leaves the tenant waiting.
  async dispatchStartRun(msg: StartRunMessage): Promise<void> {
    await this.#onStartRun?.(msg).catch(() => {});
  }
  async dispatchRunRequest(msg: RunRequest): Promise<void> {
    this.requests.push(msg.body.kind);
    if (this.legacy.has(msg.body.kind)) {
      await this.publishRunReply({
        requestId: msg.requestId,
        result: {
          ok: false,
          error: { message: 'not supported', code: 'unsupported-request' },
        },
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
    this.replies.push(reply);
    for (const h of this.#replyHandlers) h(reply);
  }
  async publishTenantEvent(_evt: TenantEvent): Promise<void> {}
}

/** A control plane whose run `p` (tenant `acme`) fanned out to 80 children. */
async function controlPlane(wire: Wire, gatewayOverride?: (g: RunGateway) => RunGateway) {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, namespace: 'acme' });
  engine.register('child', '1', async (_ctx, input) => (input as { i: number }).i);
  engine.register('parent', '1', async (ctx) =>
    ctx.all<number>(
      'child',
      Array.from({ length: 80 }, (_, i) => ({ i })),
    ),
  );
  await engine.start('parent', {}, 'p');
  await until(async () => (await store.getRun('p'))?.status === 'completed');
  const base = new StoreRunGateway(engine, { role: 'control-plane' });
  new RunRequestResponder(wire, gatewayOverride ? gatewayOverride(base) : base, {
    verifyTenant: async ({ tenant }) => (tenant ? { tenant } : null),
  }).start();
  return engine;
}

function throwing(base: RunGateway, verb: keyof RunGateway): RunGateway {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === verb) {
        return () => Promise.reject(new Error(`store unavailable (${String(verb)})`));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('RunRequestResponder always replies', () => {
  for (const [verb, call] of [
    ['listRuns', (p: ProxyRunGateway) => p.listRuns({})],
    ['workerHealth', (p: ProxyRunGateway) => p.workerHealth()],
    // The pre-verb ownership read of every runId-bearing verb.
    ['getRun', (p: ProxyRunGateway) => p.getCheckpoints('p')],
  ] as const) {
    it(`a gateway whose ${verb} throws becomes an error reply, not a tenant timeout`, async () => {
      const wire = new Wire();
      await controlPlane(wire, (g) => throwing(g, verb));
      const proxy = new ProxyRunGateway(wire, { partition: 'acme', requestTimeoutMs: 1_500 });

      const started = Date.now();
      await expect(call(proxy)).rejects.toThrow(`store unavailable (${verb})`);
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  }

  it('a tenant verifier that throws becomes an error reply', async () => {
    const wire = new Wire();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    new RunRequestResponder(wire, new StoreRunGateway(engine), {
      verifyTenant: async () => {
        throw new Error('key service down');
      },
    }).start();
    const proxy = new ProxyRunGateway(wire, { partition: 'acme', requestTimeoutMs: 2_000 });
    await expect(proxy.listRuns({})).rejects.toThrow('key service down');
    await expect(proxy.start('echo', {})).rejects.toThrow('key service down');
  });

  it('answers a verb it does not know with unsupported-request, before touching the gateway', async () => {
    const wire = new Wire();
    let touched = 0;
    const engine = await controlPlane(
      wire,
      (g) =>
        new Proxy(g, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              touched += 1;
              return value.apply(target, args);
            };
          },
        }),
    );
    expect(engine).toBeDefined();
    touched = 0;
    await wire.dispatchRunRequest({
      requestId: 'q1',
      tenant: 'acme',
      body: { kind: 'fromTheFuture', runId: 'p' } as unknown as RunRequestKind,
    });
    expect(wire.replies.at(-1)).toEqual({
      requestId: 'q1',
      result: {
        ok: false,
        error: {
          message: 'the control plane does not support the fromTheFuture run request',
          code: 'unsupported-request',
        },
      },
    });
    expect(touched).toBe(0);
  });
});

describe('ProxyRunGateway against an older control plane', () => {
  it('builds the run detail from getRun + getCheckpoints when getRunDetail is unknown', async () => {
    const wire = new Wire();
    await controlPlane(wire);
    wire.legacy = new Set(['getRunDetail', 'getFanMembers']);
    const proxy = new ProxyRunGateway(wire, { partition: 'acme', requestTimeoutMs: 2_000 });

    const full = await proxy.getRunDetail('p');
    expect(full?.run.id).toBe('p');
    expect(full?.children).toHaveLength(80);
    expect(full?.fans).toBeUndefined();

    const summarized = await proxy.getRunDetail('p', { summarizeFansOver: 50 });
    expect(summarized?.fans).toHaveLength(1);
    expect(summarized?.childCount).toBe(80);

    const group = summarized?.fans?.[0]?.group as string;
    const page = await proxy.getFanMembers('p', group, { offset: 0, limit: 10 });
    expect(page?.items).toHaveLength(10);
    expect(page?.total).toBe(80);

    expect(await proxy.getRunDetail('missing')).toBeNull();
  });

  it('remembers the old control plane for capabilityTtlMs, then asks again', async () => {
    const wire = new Wire();
    await controlPlane(wire);
    wire.legacy = new Set(['getRunDetail']);
    const proxy = new ProxyRunGateway(wire, {
      partition: 'acme',
      requestTimeoutMs: 2_000,
      capabilityTtlMs: 50,
    });

    await proxy.getRunDetail('p');
    await proxy.getRunDetail('p');
    expect(wire.requests.filter((k) => k === 'getRunDetail')).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 60));
    wire.legacy = new Set(); // the control plane finished upgrading
    const detail = await proxy.getRunDetail('p', { summarizeFansOver: 50 });
    expect(wire.requests.filter((k) => k === 'getRunDetail')).toHaveLength(2);
    expect(detail?.fans).toHaveLength(1);
  });

  it('counts runFacets from runValueFacets, then from listRuns, as the control plane gets older', async () => {
    const sort = (cells: { status: string; origin: string | null; count: number }[]) =>
      [...cells].sort((a, b) => a.status.localeCompare(b.status));
    const wire = new Wire();
    await controlPlane(wire);
    const proxy = new ProxyRunGateway(wire, { partition: 'acme', requestTimeoutMs: 2_000 });
    const current = sort(await proxy.runFacets({}));
    // The fixture's workflows declare no origin: derived from their registering file (this package).
    expect(current).toEqual([{ status: 'completed', origin: '@adonis-agora/durable', count: 81 }]);

    // Before 0.51: no runFacets verb, but runValueFacets exists.
    const older = new Wire();
    await controlPlane(older);
    older.legacy = new Set(['runFacets']);
    const viaValues = new ProxyRunGateway(older, { partition: 'acme', requestTimeoutMs: 2_000 });
    expect(sort(await viaValues.runFacets({}))).toEqual(current);
    expect(older.requests).toContain('runValueFacets');
    expect(older.requests).not.toContain('listRuns');
    // The missing verb is remembered: the next call goes straight to the fallback.
    await viaValues.runFacets({});
    expect(older.requests.filter((k) => k === 'runFacets')).toHaveLength(1);

    // Older still: neither verb, so the proxy counts the tenant's matching runs.
    const oldest = new Wire();
    await controlPlane(oldest);
    oldest.legacy = new Set(['runFacets', 'runValueFacets']);
    const viaList = new ProxyRunGateway(oldest, { partition: 'acme', requestTimeoutMs: 2_000 });
    expect(sort(await viaList.runFacets({}))).toEqual(current);
    expect(sort(await viaList.runFacets({ workflow: 'parent' }))).toEqual([
      { status: 'completed', origin: '@adonis-agora/durable', count: 1 },
    ]);
    expect(oldest.requests).toContain('listRuns');
  });

  it('a real failure of getRunDetail surfaces instead of falling back', async () => {
    const wire = new Wire();
    await controlPlane(wire, (g) => throwing(g, 'getRunDetail'));
    const proxy = new ProxyRunGateway(wire, { partition: 'acme', requestTimeoutMs: 2_000 });
    await expect(proxy.getRunDetail('p')).rejects.toThrow('store unavailable (getRunDetail)');
    expect(wire.requests).toEqual(['getRunDetail']);
  });
});

describe('lifecycle verbs against an older control plane', () => {
  it('fails fast with "not supported by this server", and remembers it', async () => {
    const wire = new Wire();
    await controlPlane(wire);
    wire.legacy = new Set(['republishLifecycle', 'workflowLifecycle']);
    const proxy = new ProxyRunGateway(wire, { partition: 'acme', requestTimeoutMs: 5_000 });

    const started = Date.now();
    const runError = await proxy.republishLifecycle({ runId: 'p' }).catch((e: unknown) => e);
    expect(runError).toBeInstanceOf(RunGatewayError);
    expect((runError as Error).message).toBe(
      'republishLifecycle is not supported by this server: the control plane is older than this tenant',
    );
    expect((runError as { code?: string }).code).toBe('unsupported-request');
    await expect(proxy.republishLifecycle({ workflow: 'parent' })).rejects.toThrow(
      /not supported by this server/,
    );
    await expect(proxy.workflowLifecycle('parent')).rejects.toThrow(
      /^workflowLifecycle is not supported by this server/,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    // The second republish was not sent: the missing verb is remembered.
    expect(wire.requests.filter((k) => k === 'republishLifecycle')).toHaveLength(1);
  });

  it('a control plane whose gateway lacks the verbs answers unsupported, not a timeout', async () => {
    const wire = new Wire();
    await controlPlane(
      wire,
      (g) =>
        new Proxy(g, {
          get(target, prop, receiver) {
            if (prop === 'republishLifecycle' || prop === 'workflowLifecycle') return undefined;
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
    );
    const proxy = new ProxyRunGateway(wire, { partition: 'acme', requestTimeoutMs: 5_000 });
    await expect(proxy.republishLifecycle({ runId: 'p' })).rejects.toBeInstanceOf(RunGatewayError);
    await expect(proxy.workflowLifecycle('parent')).rejects.toBeInstanceOf(RunGatewayError);
  });

  it('rejects a malformed republish target with an error reply', async () => {
    const wire = new Wire();
    await controlPlane(wire);
    await wire.dispatchRunRequest({
      requestId: 'q1',
      tenant: 'acme',
      body: { kind: 'republishLifecycle', target: { runId: 'p', workflow: 'parent' } },
    } as unknown as RunRequest);
    expect(wire.replies.at(-1)).toEqual({
      requestId: 'q1',
      result: {
        ok: false,
        error: {
          message: 'republishLifecycle needs a { runId } or { workflow } target',
          code: 'bad-request',
        },
      },
    });
  });
});

describe("a tenant pod's dashboard over the lifecycle verbs", () => {
  it('answers the workflow page and republish against a current control plane', async () => {
    const wire = new Wire();
    await controlPlane(wire);
    const deps = {
      engine: gatewayDashboardEngine(
        new ProxyRunGateway(wire, { partition: 'acme', requestTimeoutMs: 2_000 }),
      ),
    };
    const page = await workflowLifecycle(deps, { params: { name: 'parent' }, query: {} });
    expect(page).toEqual({
      status: 200,
      body: { workflow: 'parent', startsOnSettle: [], startedBy: [] },
    });
    const republished = await republishLifecycleRun(deps, { params: { id: 'p' }, query: {} });
    expect(republished).toEqual({
      status: 200,
      body: { result: { runs: 1, started: 0, failed: [] } },
    });
  });

  it('answers 501 when the control plane is older than the verbs', async () => {
    const wire = new Wire();
    await controlPlane(wire);
    wire.legacy = new Set(['republishLifecycle', 'workflowLifecycle']);
    const deps = {
      engine: gatewayDashboardEngine(
        new ProxyRunGateway(wire, { partition: 'acme', requestTimeoutMs: 2_000 }),
      ),
    };
    const page = await workflowLifecycle(deps, { params: { name: 'parent' }, query: {} });
    expect(page.status).toBe(501);
    expect((page.body as { error: string }).error).toMatch(/not supported by this server/);
    const republished = await republishLifecycleRun(deps, { params: { id: 'p' }, query: {} });
    expect(republished.status).toBe(501);
  });
});
