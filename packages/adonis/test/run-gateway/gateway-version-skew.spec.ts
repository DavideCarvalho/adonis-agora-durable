import { describe, expect, it } from 'vitest';
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
 * In-memory P4 wire. `legacy` lists verbs to answer the way a responder before 0.49 answered a
 * verb it did not know (an error message, no code) without reaching the real responder.
 */
class Wire implements ProxyTransport, ResponderTransport {
  #onRunRequest: ((msg: RunRequest) => Promise<void>) | undefined;
  #onStartRun: ((msg: StartRunMessage) => Promise<void>) | undefined;
  readonly #replyHandlers = new Set<(r: RunReply) => void>();
  readonly requests: RunRequestKind['kind'][] = [];
  readonly replies: RunReply[] = [];
  legacy = new Set<RunRequestKind['kind']>();
  /** `message`: a responder before 0.50 (no code); `code`: one that sends `unsupported-request`. */
  legacyStyle: 'message' | 'code' = 'message';

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
          error:
            this.legacyStyle === 'message'
              ? { message: `unknown run-request verb: ${msg.body.kind}` }
              : { message: 'not supported', code: 'unsupported-request' },
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

  it('falls back on the unsupported-request code too', async () => {
    const wire = new Wire();
    await controlPlane(wire);
    wire.legacy = new Set(['getRunDetail']);
    wire.legacyStyle = 'code';
    const proxy = new ProxyRunGateway(wire, { partition: 'acme', requestTimeoutMs: 2_000 });
    const detail = await proxy.getRunDetail('p', { summarizeFansOver: 50 });
    expect(detail?.fans).toHaveLength(1);
    expect(wire.requests).toContain('getCheckpoints');
  });

  it('a real failure of getRunDetail surfaces instead of falling back', async () => {
    const wire = new Wire();
    await controlPlane(wire, (g) => throwing(g, 'getRunDetail'));
    const proxy = new ProxyRunGateway(wire, { partition: 'acme', requestTimeoutMs: 2_000 });
    await expect(proxy.getRunDetail('p')).rejects.toThrow('store unavailable (getRunDetail)');
    expect(wire.requests).toEqual(['getRunDetail']);
  });
});
