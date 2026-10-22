import { describe, expect, it } from 'vitest';
import {
  gatewayDashboardEngine,
  storeDashboardEngine,
} from '../../src/dashboard/gateway-adapter.js';
import { type ApiRequest, getFanMembers, getRun } from '../../src/dashboard/handlers.js';
import {
  InMemoryStateStore,
  InMemoryTransport,
  type StateStore,
  WorkflowEngine,
} from '../../src/index.js';
import { StoreRunGateway } from '../../src/run-gateway/store-run-gateway.js';
import { DURABLE_STEP_NAME, type StepRef } from '../../src/step-name-symbol.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { dbBackends } from '../support/backends.js';

/**
 * The console polls `GET /runs/:id` every couple of seconds. With a store that aggregates checkpoints,
 * the detail is built from `checkpointStats` + a few targeted reads (not every checkpoint of a
 * 40,000-member fan), and it carries an `ETag`: a poll whose `If-None-Match` still names it gets a
 * bare 304 after the run row and the buckets are read, with no checkpoint row loaded at all.
 */

const LINE = 'lines.process';
const processLine = Object.assign(async () => 0, { [DURABLE_STEP_NAME]: LINE }) as StepRef<
  { i: number },
  number
>;

async function wideRun<S extends StateStore>(store: S) {
  const transport = new InMemoryTransport();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  transport.handle(LINE, async (input) => {
    const { i } = input as { i: number };
    if (i >= 70) await gate; // the last 10 stay in flight until released
    return i;
  });
  const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
  engine.register('fan', '1', async (ctx) =>
    ctx.all(
      processLine,
      Array.from({ length: 80 }, (_, i) => ({ i })),
    ),
  );
  await engine.start('fan', {}, 'p');
  const settle = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 1000 && !(await check()); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  await settle(async () => (await store.countCheckpoints?.('p', 0, 79, ['completed'])) === 70);
  return { engine, store, release: () => release?.(), settle };
}

const req = (over: Partial<ApiRequest> = {}): ApiRequest => ({
  params: { id: 'p' },
  query: {},
  ...over,
});

describe('run detail ETag / 304', () => {
  it('sends an ETag, answers a matching If-None-Match with a bare 304, and moves when the run does', async () => {
    const { engine, store, release, settle } = await wideRun(new InMemoryStateStore());
    const deps = { engine: storeDashboardEngine(engine) };

    const first = await getRun(deps, req());
    expect(first.status).toBe(200);
    const etag = first.headers?.etag as string;
    expect(etag).toMatch(/^"rd-[0-9a-f]+"$/);
    expect(first.headers?.['cache-control']).toBe('private, no-cache');
    // The wide fan is summarized from the aggregates.
    expect((first.body as { fans: { size: number }[] }).fans[0]?.size).toBe(80);

    store.checkpointRowsRead = 0;
    const again = await getRun(deps, req({ headers: { 'if-none-match': etag } }));
    expect(again).toEqual({
      status: 304,
      body: null,
      headers: { etag, 'cache-control': 'private, no-cache' },
    });
    // Not one checkpoint row was loaded to answer it.
    expect(store.checkpointRowsRead).toBe(0);

    release();
    await settle(async () => (await store.getRun('p'))?.status === 'completed');
    const moved = await getRun(deps, req({ headers: { 'if-none-match': etag } }));
    expect(moved.status).toBe(200);
    expect(moved.headers?.etag).not.toBe(etag);
  });

  it('reads a fraction of the rows the full read would', async () => {
    const { engine, store } = await wideRun(new InMemoryStateStore());
    const deps = { engine: storeDashboardEngine(engine) };
    store.checkpointRowsRead = 0;
    await getRun(deps, req());
    // 80 fan rows, but the summary reads none of them (no failures, no folded rows, no children).
    expect(store.checkpointRowsRead).toBeLessThan(10);
  });

  it('versions a fan page the same way', async () => {
    const { engine } = await wideRun(new InMemoryStateStore());
    const deps = { engine: storeDashboardEngine(engine) };
    const detail = (await getRun(deps, req())).body as { fans: { group: string }[] };
    const group = detail.fans[0]?.group as string;
    const page = await getFanMembers(
      deps,
      req({ params: { id: 'p', group }, query: { limit: '5' } }),
    );
    expect(page.status).toBe(200);
    expect((page.body as { items: unknown[]; total: number }).total).toBe(80);
    const etag = page.headers?.etag as string;
    expect(etag).toMatch(/^"fp-/);
    const again = await getFanMembers(
      deps,
      req({
        params: { id: 'p', group },
        query: { limit: '5' },
        headers: { 'if-none-match': etag },
      }),
    );
    expect(again.status).toBe(304);
    // Another page is another validator.
    const other = await getFanMembers(
      deps,
      req({
        params: { id: 'p', group },
        query: { limit: '6' },
        headers: { 'if-none-match': etag },
      }),
    );
    expect(other.status).toBe(200);
  });

  it('?full=true answers in full, without an ETag', async () => {
    const { engine } = await wideRun(new InMemoryStateStore());
    const full = await getRun(
      { engine: storeDashboardEngine(engine) },
      req({ query: { full: 'true' } }),
    );
    expect(full.status).toBe(200);
    expect(full.headers).toBeUndefined();
  });

  it('crosses a RunGateway (the tenant path) with the validator intact', async () => {
    const { engine } = await wideRun(new InMemoryStateStore());
    const deps = { engine: gatewayDashboardEngine(new StoreRunGateway(engine)) };
    const first = await getRun(deps, req());
    const etag = first.headers?.etag as string;
    expect(etag).toBeDefined();
    expect((await getRun(deps, req({ headers: { 'if-none-match': etag } }))).status).toBe(304);
  });

  it.each(dbBackends())('works on the Lucid store ($name)', async ({ makeStoreDb }) => {
    const db = await makeStoreDb();
    try {
      const { engine, store, release, settle } = await wideRun(new LucidStateStore(db));
      const deps = { engine: storeDashboardEngine(engine) };
      const first = await getRun(deps, req());
      const etag = first.headers?.etag as string;
      expect(etag).toBeDefined();
      expect((await getRun(deps, req({ headers: { 'if-none-match': etag } }))).status).toBe(304);
      release();
      // Let the fan finish before the database closes under it.
      await settle(async () => (await store.getRun('p'))?.status === 'completed');
    } finally {
      await db.manager.closeAll();
    }
  });
});
