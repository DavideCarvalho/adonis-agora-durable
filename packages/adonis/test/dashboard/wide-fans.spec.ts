import { describe, expect, it } from 'vitest';
import {
  gatewayDashboardEngine,
  storeDashboardEngine,
} from '../../src/dashboard/gateway-adapter.js';
import { type ApiRequest, getFanMembers, getRun } from '../../src/dashboard/handlers.js';
import {
  GatherError,
  InMemoryStateStore,
  InMemoryTransport,
  WorkflowEngine,
} from '../../src/index.js';
import type { RunGateway } from '../../src/run-gateway/interface.js';
import { StoreRunGateway } from '../../src/run-gateway/store-run-gateway.js';
import { DURABLE_STEP_NAME, type StepRef } from '../../src/step-name-symbol.js';

const LINE = 'lines.process';
const processLine = Object.assign(async () => 0, { [DURABLE_STEP_NAME]: LINE }) as StepRef<
  { i: number },
  number
>;

/** A run whose body is one 80-step fan; steps 3 and 40 fail. */
async function wideRun() {
  const store = new InMemoryStateStore();
  const transport = new InMemoryTransport();
  transport.handle(LINE, async (input) => {
    const { i } = input as { i: number };
    if (i === 3 || i === 40) throw new Error(`bad line ${i}`);
    return i;
  });
  const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
  engine.register('fan', '1', async (ctx) => {
    try {
      return await ctx.all(
        processLine,
        Array.from({ length: 80 }, (_, i) => ({ i })),
      );
    } catch (err) {
      if (err instanceof GatherError) return 'some failed';
      throw err;
    }
  });
  await engine.start('fan', {}, 'p');
  for (let i = 0; i < 500 && (await store.getRun('p'))?.status !== 'completed'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return engine;
}

const req = (over: Partial<ApiRequest> = {}): ApiRequest => ({ params: {}, query: {}, ...over });

type Detail = {
  timeline: { seq: number; status: string; redacted?: boolean }[];
  fans?: {
    group: string;
    size: number;
    counts: Record<string, number>;
    startedAt?: string;
    failures: { seq: number; redacted?: boolean }[];
  }[];
  childCount?: number;
};

describe('GET /runs/:id with a wide fan', () => {
  it('summarizes a fan over 50 members by default; ?full=true lists every member', async () => {
    const deps = { engine: storeDashboardEngine(await wideRun()) };

    const summarized = (await getRun(deps, req({ params: { id: 'p' } }))).body as Detail;
    expect(summarized.timeline).toHaveLength(0);
    expect(summarized.fans).toHaveLength(1);
    expect(summarized.fans?.[0]).toMatchObject({
      group: 'steps:0:80',
      size: 80,
      counts: { completed: 78, failed: 2 },
    });
    expect(typeof summarized.fans?.[0]?.startedAt).toBe('string');
    expect(summarized.fans?.[0]?.failures.map((f) => f.seq)).toEqual([3, 40]);
    expect(summarized.childCount).toBe(0);

    const full = (await getRun(deps, req({ params: { id: 'p' }, query: { full: 'true' } })))
      .body as Detail;
    expect(full.timeline).toHaveLength(80);
    expect(full.fans).toBeUndefined();

    expect(
      (await getRun(deps, req({ params: { id: 'p' }, query: { full: 'maybe' } }))).status,
    ).toBe(400);
  });

  it('redacts the sampled failures like the timeline steps', async () => {
    const deps = {
      engine: storeDashboardEngine(await wideRun()),
      redact: { checkpoint: (cp: Record<string, unknown>) => ({ ...cp, redacted: true }) },
    };
    const body = (await getRun(deps, req({ params: { id: 'p' } }))).body as Detail;
    expect(body.fans?.[0]?.failures.every((f) => f.redacted)).toBe(true);
  });

  it('summarizes on the gateway side when the port can, for a tenant pod', async () => {
    const gateway = new StoreRunGateway(await wideRun());
    let checkpointReads = 0;
    const counting: RunGateway = {
      topology: () => gateway.topology(),
      getRun: (id) => gateway.getRun(id),
      listRuns: (q) => gateway.listRuns(q),
      getCheckpoints: (id) => {
        checkpointReads += 1;
        return gateway.getCheckpoints(id);
      },
      getRunChildren: (id) => gateway.getRunChildren(id),
      getRunDetail: (id, options) => gateway.getRunDetail(id, options),
      getFanMembers: (id, group, query) => gateway.getFanMembers(id, group, query),
      getSearchAttributes: (id) => gateway.getSearchAttributes(id),
      workerHealth: () => gateway.workerHealth(),
      start: (w, i, o) => gateway.start(w, i, o),
      signal: (id, sig, payload) => gateway.signal(id, sig, payload),
      cancel: (id, o) => gateway.cancel(id, o),
      redispatchPending: (id) => gateway.redispatchPending(id),
      subscribe: (id, on) => gateway.subscribe(id, on),
    };
    const deps = { engine: gatewayDashboardEngine(counting) };

    const body = (await getRun(deps, req({ params: { id: 'p' } }))).body as Detail;
    expect(body.fans?.[0]?.size).toBe(80);
    expect(checkpointReads).toBe(0);
  });
});

describe('GET /runs/:id/fans/:group', () => {
  it('pages the members in seq order, with the total', async () => {
    const deps = { engine: storeDashboardEngine(await wideRun()) };
    const res = await getFanMembers(
      deps,
      req({ params: { id: 'p', group: 'steps:0:80' }, query: { offset: '70', limit: '50' } }),
    );
    const page = res.body as { items: { seq: number }[]; total: number };
    expect(page.total).toBe(80);
    expect(page.items.map((c) => c.seq)).toEqual(Array.from({ length: 10 }, (_, i) => 70 + i));
  });

  it('filters to failed members', async () => {
    const deps = { engine: storeDashboardEngine(await wideRun()) };
    const res = await getFanMembers(
      deps,
      req({ params: { id: 'p', group: 'steps:0:80' }, query: { failed: 'true' } }),
    );
    expect((res.body as { items: { seq: number }[] }).items.map((c) => c.seq)).toEqual([3, 40]);
  });

  it('404s for an unknown run and 400s for a bad flag', async () => {
    const deps = { engine: storeDashboardEngine(await wideRun()) };
    expect((await getFanMembers(deps, req({ params: { id: 'nope', group: 'g' } }))).status).toBe(
      404,
    );
    const bad = await getFanMembers(
      deps,
      req({ params: { id: 'p', group: 'steps:0:80' }, query: { failed: 'maybe' } }),
    );
    expect(bad.status).toBe(400);
  });
});
