import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  RunReply,
  RunRequest,
  StartRunMessage,
  StepCheckpoint,
  TenantEvent,
  WorkflowRun,
} from '../../src/interfaces.js';
import type { RunGateway } from '../../src/run-gateway/interface.js';
import { ProxyRunGateway, type ProxyTransport } from '../../src/run-gateway/proxy-run-gateway.js';
import {
  type ResponderTransport,
  RunRequestResponder,
} from '../../src/run-gateway/run-request-responder.js';
import { StoreRunGateway } from '../../src/run-gateway/store-run-gateway.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

/** A parent that fans out to 80 child runs, run to completion. */
async function wideParent(namespace?: string) {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, ...(namespace ? { namespace } : {}) });
  engine.register('child', '1', async (_ctx, input) => (input as { i: number }).i);
  engine.register('parent', '1', async (ctx) =>
    ctx.all<number>(
      'child',
      Array.from({ length: 80 }, (_, i) => ({ i })),
    ),
  );
  await engine.start('parent', {}, 'p');
  await until(async () => (await store.getRun('p'))?.status === 'completed');
  return { store, engine };
}

describe('StoreRunGateway with a wide fan', () => {
  it('summarizes the fan on request: one FanSummary, its members paged on demand', async () => {
    const { engine } = await wideParent();
    const gateway = new StoreRunGateway(engine);

    const full = await gateway.getRunDetail('p');
    expect(full?.fans).toBeUndefined();
    expect(full?.children).toHaveLength(80);

    const summarized = await gateway.getRunDetail('p', { summarizeFansOver: 50 });
    expect(summarized?.fans).toHaveLength(1);
    expect(summarized?.fans?.[0]).toMatchObject({ label: 'child runs', size: 80 });
    expect(summarized?.timeline.length).toBeLessThan(full?.timeline.length ?? 0);
    expect(summarized?.childCount).toBe(80);

    const group = summarized?.fans?.[0]?.group as string;
    const page = await gateway.getFanMembers('p', group, { offset: 0, limit: 10 });
    expect(page?.items).toHaveLength(10);
    expect(page?.items.every((cp) => cp.parallelGroup === group)).toBe(true);
    expect(await gateway.getFanMembers('missing', group, {})).toBeNull();
    expect(await gateway.getRunDetail('missing')).toBeNull();
  });
});

const fakeRun = (id: string, namespace: string): WorkflowRun => ({
  id,
  workflow: 'wf',
  workflowVersion: '1',
  status: 'completed',
  input: {},
  namespace,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

function fakeGateway(over: Partial<RunGateway> = {}): RunGateway {
  return {
    topology: () => ({ role: 'control-plane' }),
    getRun: vi.fn(async (id: string) => fakeRun(id, 'acme')),
    listRuns: vi.fn(async () => []),
    getCheckpoints: vi.fn(async (): Promise<StepCheckpoint[]> => []),
    getRunChildren: vi.fn(async () => []),
    getSearchAttributes: vi.fn(async () => undefined),
    workerHealth: vi.fn(async () => []),
    start: vi.fn(),
    signal: vi.fn(async () => null),
    cancel: vi.fn(async () => null),
    redispatchPending: vi.fn(async () => null),
    subscribe: () => () => {},
    ...over,
  } as RunGateway;
}

/** Delivers requests to the responder and records its replies. */
class FakeResponderTransport implements ResponderTransport {
  readonly replies: RunReply[] = [];
  #onRunRequest: ((msg: RunRequest) => Promise<void>) | undefined;
  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void {
    this.#onRunRequest = handler;
  }
  onStartRun(): void {}
  async publishRunReply(reply: RunReply): Promise<void> {
    this.replies.push(reply);
  }
  async publishTenantEvent(): Promise<void> {}
  deliver(msg: RunRequest): Promise<void> {
    return this.#onRunRequest?.(msg) ?? Promise.resolve();
  }
}

function responder(gateway: RunGateway) {
  const tx = new FakeResponderTransport();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  new RunRequestResponder(tx, gateway).start();
  warn.mockRestore();
  return tx;
}

describe('RunRequestResponder: run detail and fan members', () => {
  it('passes getRunDetail options through, and pages a fan only for the owning tenant', async () => {
    const getRunDetail = vi.fn(async () => null);
    const getFanMembers = vi.fn(async () => ({ items: [], total: 0 }));
    const gw = fakeGateway({ getRunDetail, getFanMembers });
    const tx = responder(gw);

    await tx.deliver({
      requestId: 'q1',
      tenant: 'acme',
      body: { kind: 'getRunDetail', runId: 'r1', options: { summarizeFansOver: 50 } },
    });
    expect(getRunDetail).toHaveBeenCalledWith('r1', { summarizeFansOver: 50 });

    await tx.deliver({
      requestId: 'q2',
      tenant: 'acme',
      body: { kind: 'getFanMembers', runId: 'r1', group: 'steps:0:9', query: { limit: 5 } },
    });
    expect(getFanMembers).toHaveBeenCalledWith('r1', 'steps:0:9', { limit: 5 });
    expect(tx.replies[1]).toMatchObject({ requestId: 'q2', result: { ok: true } });

    await tx.deliver({
      requestId: 'q3',
      tenant: 'beta',
      body: { kind: 'getFanMembers', runId: 'r1', group: 'steps:0:9', query: {} },
    });
    await tx.deliver({
      requestId: 'q4',
      tenant: 'beta',
      body: { kind: 'getRunDetail', runId: 'r1' },
    });
    expect(getFanMembers).toHaveBeenCalledTimes(1);
    expect(getRunDetail).toHaveBeenCalledTimes(1);
    expect(tx.replies[2]).toMatchObject({ result: { ok: false, error: { code: 'cross-tenant' } } });
    expect(tx.replies[3]).toMatchObject({ result: { ok: false, error: { code: 'cross-tenant' } } });
  });

  it('checks ownership on the run alone, never the timeline', async () => {
    const getRunDetail = vi.fn(async () => null);
    const getFanMembers = vi.fn(async () => ({ items: [], total: 0 }));
    const gw = fakeGateway({ getRunDetail, getFanMembers });
    const tx = responder(gw);

    await tx.deliver({
      requestId: 'q1',
      tenant: 'acme',
      body: { kind: 'getFanMembers', runId: 'r1', group: 'steps:0:9', query: {} },
    });
    await tx.deliver({ requestId: 'q2', tenant: 'acme', body: { kind: 'cancel', runId: 'r1' } });
    await tx.deliver({ requestId: 'q3', tenant: 'beta', body: { kind: 'cancel', runId: 'r1' } });

    expect(getRunDetail).not.toHaveBeenCalled();
    expect(gw.getCheckpoints).not.toHaveBeenCalled();
    expect(gw.getRun).toHaveBeenCalledTimes(3);
    expect(gw.cancel).toHaveBeenCalledTimes(1);
    expect(tx.replies[2]).toMatchObject({ result: { ok: false } });
  });

  it('answers both verbs from the plain reads when the gateway has neither', async () => {
    const { engine } = await wideParent();
    const store = new StoreRunGateway(engine);
    const plain = fakeGateway({
      getRun: (id) => store.getRun(id),
      getCheckpoints: (id) => store.getCheckpoints(id),
      getRunChildren: (id) => store.getRunChildren(id),
    });
    const tx = responder(plain);

    await tx.deliver({
      requestId: 'q1',
      tenant: 'default',
      body: { kind: 'getRunDetail', runId: 'p', options: { summarizeFansOver: 50 } },
    });
    const reply = tx.replies[0]?.result as { data: { fans: { group: string; size: number }[] } };
    const detail = reply.data;
    expect(detail.fans[0]?.size).toBe(80);

    await tx.deliver({
      requestId: 'q2',
      tenant: 'default',
      body: { kind: 'getFanMembers', runId: 'p', group: detail.fans[0]?.group ?? '', query: {} },
    });
    expect(tx.replies[1]?.result).toMatchObject({ ok: true, data: { total: 80 } });

    await tx.deliver({
      requestId: 'q3',
      tenant: 'default',
      body: { kind: 'getFanMembers', runId: 'missing', group: 'g', query: {} },
    });
    expect(tx.replies[2]?.result).toEqual({ ok: true, data: null });
  });
});

/** Wires a proxy straight to a responder, in process. */
class LoopbackTransport implements ProxyTransport, ResponderTransport {
  #onRunRequest: ((msg: RunRequest) => Promise<void>) | undefined;
  readonly #replies = new Set<(r: RunReply) => void>();
  async dispatchStartRun(_msg: StartRunMessage): Promise<void> {}
  async dispatchRunRequest(msg: RunRequest): Promise<void> {
    // Through JSON, as over a broker.
    await this.#onRunRequest?.(JSON.parse(JSON.stringify(msg)) as RunRequest);
  }
  onRunReply(handler: (reply: RunReply) => void): void {
    this.#replies.add(handler);
  }
  onTenantEvent(_tenant: string, _handler: (evt: TenantEvent) => void): () => void {
    return () => {};
  }
  onStartRun(): void {}
  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void {
    this.#onRunRequest = handler;
  }
  async publishRunReply(reply: RunReply): Promise<void> {
    const wire = JSON.parse(JSON.stringify(reply)) as RunReply;
    for (const h of this.#replies) h(wire);
  }
  async publishTenantEvent(): Promise<void> {}
}

describe('ProxyRunGateway run detail over the wire', () => {
  it('asks the control plane to summarize, so the members never cross the wire', async () => {
    const { engine } = await wideParent('acme');
    const tx = new LoopbackTransport();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new RunRequestResponder(tx, new StoreRunGateway(engine)).start();
    warn.mockRestore();
    const proxy = new ProxyRunGateway(tx, { partition: 'acme', requestTimeoutMs: 500 });

    const detail = await proxy.getRunDetail('p', { summarizeFansOver: 50 });
    expect(detail?.fans?.[0]).toMatchObject({ label: 'child runs', size: 80 });
    expect(detail?.childCount).toBe(80);

    const page = await proxy.getFanMembers('p', detail?.fans?.[0]?.group ?? '', {
      offset: 70,
      limit: 50,
    });
    expect(page?.total).toBe(80);
    expect(page?.items).toHaveLength(10);
  });
});
