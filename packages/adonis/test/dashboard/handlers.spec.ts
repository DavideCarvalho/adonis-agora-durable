import { beforeEach, describe, expect, it } from 'vitest';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import {
  type ApiRequest,
  bulkAction,
  cancelRun,
  continueRun,
  type Deps,
  getRun,
  health,
  listRuns,
  listSchedules,
  redispatchPendingRun,
  retryRun,
  retryWithInputRun,
  runValues,
  workers,
} from '../../src/dashboard/handlers.js';
import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '../../src/index.js';

/**
 * What this spec actually drives: a real in-memory {@link WorkflowEngine} for ARRANGE steps
 * (`raw.start`/`raw.waitForRun`/`raw.getRun` — engine-only, not part of the {@link Deps} port), plus
 * that same engine adapted through {@link storeDashboardEngine} into the bounded {@link Deps} port the
 * handlers under test actually receive — the same wiring `gateway-adapter.ts`'s
 * `dashboardEngineForTopology` does for a store topology in production.
 */
function makeEngine(): { raw: WorkflowEngine; undone: string[]; deps: Deps } {
  const store = new InMemoryStateStore();
  const raw = new WorkflowEngine({ store, transport: new InMemoryTransport() });

  raw.register('greet', '1', async (ctx) => {
    const a = await ctx.localStep('a', async () => 21);
    return a * 2;
  });

  // A workflow that always throws, so a run reaches `failed`.
  raw.register('boom', '1', async (ctx) => {
    await ctx.localStep('explode', async () => {
      throw new Error('kaboom');
    });
    return 'never';
  });

  // A workflow that suspends on a signal, so it stays in-flight (cancellable).
  raw.register('waiter', '1', async (ctx) => {
    await ctx.waitForSignal('go');
    return 'done';
  });

  // Completes a compensable step, then parks on a signal — so it is cancellable AND has a saga to
  // undo. `undone` is the observable proof that compensation actually ran: a plain cancel leaves it
  // empty, which is exactly the silent failure this fixture exists to catch.
  const undone: string[] = [];
  raw.register('compensable', '1', async (ctx) => {
    await ctx.localStep('charge', async () => 'charged', {
      compensate: async () => void undone.push('charge'),
    });
    await ctx.waitForSignal('go');
    return 'done';
  });

  return { raw, undone, deps: { engine: storeDashboardEngine(raw) } };
}

const req = (over: Partial<ApiRequest> = {}): ApiRequest => ({
  params: {},
  query: {},
  ...over,
});

/** Wait for `fn` to hold, or throw. A compensating cancel drives the saga in the BACKGROUND (see
 *  `engine.cancel`) so the handler can answer without replaying the workflow inside the HTTP
 *  request — which means the undo lands after the response, not before it. */
async function poll(fn: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('poll timed out');
}

/** Give any background work a few macrotasks to land. Used to assert a NEGATIVE (no compensation
 *  ran) fairly — otherwise the assertion could pass simply by being early. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('JSON handlers', () => {
  let raw: WorkflowEngine;
  let deps: Deps;
  let undone: string[];

  beforeEach(() => {
    ({ raw, undone, deps } = makeEngine());
  });

  type RunsBody = {
    data: Array<{ id: string; status: string; workflow: string }>;
    meta: {
      total: number;
      perPage: number;
      currentPage: number;
      lastPage: number;
      firstPage: number;
    };
    statuses: string[];
  };
  const runsBody = (res: { body: unknown }) => res.body as RunsBody;
  const runIds = (res: { body: unknown }) => runsBody(res).data.map((r) => r.id);

  it('listRuns answers { data, meta, statuses }', async () => {
    await raw.start('greet', {}, 'run-ok');
    await raw.waitForRun('run-ok');

    const res = await listRuns(deps, req());
    expect(res.status).toBe(200);
    const body = runsBody(res);
    expect(body.data.find((r) => r.id === 'run-ok')?.status).toBe('completed');
    expect(body.meta).toEqual({ total: 1, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 });
    expect(body.statuses).toContain('failed');
    expect(body.statuses).toContain('blocked');
  });

  it('listRuns filters by filter[status]', async () => {
    await raw.start('greet', {}, 'run-ok');
    await raw.waitForRun('run-ok');
    await raw.start('boom', {}, 'run-bad');
    await raw.waitForRun('run-bad');

    const res = await listRuns(deps, req({ query: { filter: { status: 'failed' } } }));
    expect(runIds(res)).toEqual(['run-bad']);
    expect(runsBody(res).meta.total).toBe(1);
  });

  it('listRuns filters by filter[workflow]', async () => {
    await raw.start('greet', {}, 'g1');
    await raw.start('boom', {}, 'b1');
    await raw.waitForRun('g1');
    await raw.waitForRun('b1');

    const res = await listRuns(deps, req({ query: { filter: { workflow: 'greet' } } }));
    expect(runsBody(res).data.map((r) => r.workflow)).toEqual(['greet']);
  });

  it('listRuns filters by tag and search-attribute predicate', async () => {
    await raw.start('greet', {}, 'g-tag', { tags: ['team:core'] });
    await raw.start('greet', {}, 'g-attr', { searchAttributes: { amount: 250 } });
    await raw.waitForRun('g-tag');
    await raw.waitForRun('g-attr');

    const byTag = await listRuns(deps, req({ query: { filter: { tag: 'team:core' } } }));
    expect(runIds(byTag)).toEqual(['g-tag']);

    const byAttr = await listRuns(deps, req({ query: { filter: { attr: 'amount:gte:200' } } }));
    expect(runIds(byAttr)).toEqual(['g-attr']);

    const structured = await listRuns(
      deps,
      req({ query: { filter: { 'attr.amount': { gte: '200' } } } }),
    );
    expect(runIds(structured)).toEqual(['g-attr']);
  });

  it('listRuns 400s a filter field sent bare, an unknown field and an unknown sort', async () => {
    await raw.start('greet', {}, 'g1');
    await raw.waitForRun('g1');

    for (const query of [
      { status: 'failed' },
      { tag: 'etl' },
      { 'attr.amount': 'x' },
      { filter: { nope: 'x' } },
      { filter: { status: { contains: 'fail' } } },
      { sort: 'workflow' },
      { sort: 'createdAt' },
      { sort: '-createdAt,id' },
    ]) {
      const res = await listRuns(deps, req({ query }));
      expect(res.status, JSON.stringify(query)).toBe(400);
    }
    expect((await listRuns(deps, req({ query: { sort: '-createdAt' } }))).status).toBe(200);
  });

  describe("listRuns paging — 1-based `page`/`size`, the ecosystem's offset shape", () => {
    /** Three runs, newest last-started (the listing is newest-first). */
    async function threeRuns(): Promise<void> {
      for (const id of ['r1', 'r2', 'r3']) {
        await raw.start('greet', {}, id);
        await raw.waitForRun(id);
      }
    }

    const meta = (res: { body: unknown }) => runsBody(res).meta;

    it('walks disjoint pages, with the total and the last page', async () => {
      await threeRuns();

      const first = await listRuns(deps, req({ query: { page: '1', size: '2' } }));
      const second = await listRuns(deps, req({ query: { page: '2', size: '2' } }));

      expect(runIds(first)).toHaveLength(2);
      expect(runIds(second)).toHaveLength(1);
      expect(new Set([...runIds(first), ...runIds(second)]).size).toBe(3);
      expect(meta(first)).toEqual({
        total: 3,
        perPage: 2,
        currentPage: 1,
        lastPage: 2,
        firstPage: 1,
      });
      expect(meta(second).currentPage).toBe(2);
    });

    it('defaults to page 1, size 50', async () => {
      await threeRuns();

      expect(meta(await listRuns(deps, req({ query: { size: '2' } }))).currentPage).toBe(1);
      expect(meta(await listRuns(deps, req({ query: {} })))).toEqual({
        total: 3,
        perPage: 50,
        currentPage: 1,
        lastPage: 1,
        firstPage: 1,
      });
    });

    it('caps `size` at 200 and reads a page below 1 as the first page', async () => {
      await threeRuns();

      expect(meta(await listRuns(deps, req({ query: { size: '5000' } }))).perPage).toBe(200);
      expect(meta(await listRuns(deps, req({ query: { page: '0', size: '2' } }))).currentPage).toBe(
        1,
      );
      expect(runIds(await listRuns(deps, req({ query: { page: '0', size: '2' } })))).toEqual(
        runIds(await listRuns(deps, req({ query: { page: '1', size: '2' } }))),
      );
    });

    it('counts the matching set, not the store', async () => {
      await threeRuns();
      await raw.start('boom', {}, 'bad');
      await raw.waitForRun('bad');

      const res = await listRuns(
        deps,
        req({ query: { filter: { workflow: 'greet' }, page: '1', size: '1' } }),
      );
      expect(meta(res)).toMatchObject({ total: 3, lastPage: 3 });
    });

    it("counts by listing when a tenant pod's control plane is too old to count", async () => {
      await threeRuns();
      const port = {
        ...deps.engine,
        countRuns: async () => {
          throw Object.assign(new Error('unknown verb'), { code: 'unsupported-request' });
        },
      };
      const res = await listRuns({ engine: port }, req({ query: { size: '2' } }));
      expect(meta(res)).toMatchObject({ total: 3, lastPage: 2 });
    });

    it('counts by listing when the port has no countRuns', async () => {
      await threeRuns();
      const { countRuns: _count, ...port } = deps.engine;
      const res = await listRuns({ engine: port }, req({ query: { size: '2' } }));
      expect(meta(res)).toMatchObject({ total: 3, lastPage: 2 });
    });
  });

  it('getRun returns run detail + step timeline', async () => {
    await raw.start('greet', {}, 'run-ok');
    await raw.waitForRun('run-ok');

    const res = await getRun(deps, req({ params: { id: 'run-ok' } }));
    expect(res.status).toBe(200);
    const body = res.body as {
      run: { id: string; status: string; output: unknown };
      timeline: Array<{ name: string; status: string; attempts: number; durationMs: number }>;
      children: string[];
    };
    expect(body.run.id).toBe('run-ok');
    expect(body.run.status).toBe('completed');
    expect(body.run.output).toBe(42);
    expect(body.timeline.length).toBeGreaterThan(0);
    const step = body.timeline.find((s) => s.name === 'a');
    expect(step?.status).toBe('completed');
    expect(step?.attempts).toBeGreaterThanOrEqual(1);
    expect(typeof step?.durationMs).toBe('number');
  });

  it('getRun names what a suspended run is waiting on, as the list rows do', async () => {
    await raw.start('waiter', {}, 'run-waiting');
    await raw.waitForRun('run-waiting');
    const res = await getRun(deps, req({ params: { id: 'run-waiting' } }));
    const body = res.body as { run: { status: string; waiting?: { on: string; name: string } } };
    expect(body.run.status).toBe('suspended');
    expect(body.run.waiting).toEqual({ on: 'signal', name: 'go' });
  });

  it('getRun 404s for an unknown run', async () => {
    const res = await getRun(deps, req({ params: { id: 'nope' } }));
    expect(res.status).toBe(404);
  });

  it('retryRun re-enqueues a failed run', async () => {
    await raw.start('boom', {}, 'run-bad');
    await raw.waitForRun('run-bad');

    const res = await retryRun(deps, req({ params: { id: 'run-bad' } }));
    expect(res.status).toBe(200);
    const body = res.body as { result: { runId: string; status: string } };
    expect(body.result.runId).toBe('run-bad');
    // requeue resets the run to pending for a worker to pick up.
    expect(body.result.status).toBe('pending');
  });

  it('retryRun 404s for an unknown run', async () => {
    const res = await retryRun(deps, req({ params: { id: 'ghost' } }));
    expect(res.status).toBe(404);
  });

  it('retryWithInputRun starts a fresh linked run with the corrected input', async () => {
    await raw.start('boom', { bad: true }, 'run-bad');
    await raw.waitForRun('run-bad');

    const res = await retryWithInputRun(
      deps,
      req({ params: { id: 'run-bad' }, body: { input: { bad: false } } }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { result: { runId: string } };
    expect(body.result.runId).toMatch(/^run-bad~retry~/);

    // The original run is untouched.
    const original = await raw.getRun('run-bad');
    expect(original?.status).toBe('failed');
  });

  it('retryWithInputRun 404s for an unknown run', async () => {
    const res = await retryWithInputRun(
      deps,
      req({ params: { id: 'ghost' }, body: { input: {} } }),
    );
    expect(res.status).toBe(404);
  });

  it('continueRun 404s for a run not paused at a breakpoint', async () => {
    await raw.start('greet', {}, 'run-ok');
    await raw.waitForRun('run-ok');

    const res = await continueRun(deps, req({ params: { id: 'run-ok' } }));
    expect(res.status).toBe(404);
  });

  it('redispatchPendingRun returns the run status and a redispatched count', async () => {
    await raw.start('greet', {}, 'run-done'); // no remote steps → redispatched: 0
    await raw.waitForRun('run-done');

    const res = await redispatchPendingRun(deps, req({ params: { id: 'run-done' } }));
    expect(res.status).toBe(200);
    const body = res.body as { result: { runId: string; redispatched: number } };
    expect(body.result.runId).toBe('run-done');
    expect(body.result.redispatched).toBe(0);
  });

  it('redispatchPendingRun 404s for an unknown run', async () => {
    const res = await redispatchPendingRun(deps, req({ params: { id: 'ghost' } }));
    expect(res.status).toBe(404);
  });

  it('cancelRun cancels an in-flight (suspended) run', async () => {
    await raw.start('waiter', {}, 'run-wait');
    await raw.waitForRun('run-wait'); // settles to suspended

    const res = await cancelRun(deps, req({ params: { id: 'run-wait' } }));
    expect(res.status).toBe(200);
    const body = res.body as { result: { status: string } };
    expect(body.result.status).toBe('cancelled');

    const after = await raw.getRun('run-wait');
    expect(after?.status).toBe('cancelled');
  });

  it('cancelRun 404s for an unknown run', async () => {
    const res = await cancelRun(deps, req({ params: { id: 'ghost' } }));
    expect(res.status).toBe(404);
  });

  it('bulkAction retries every matching run, skipping the rest', async () => {
    await raw.start('boom', {}, 'bulk-bad-1');
    await raw.start('boom', {}, 'bulk-bad-2');
    await raw.start('greet', {}, 'bulk-ok');
    await raw.waitForRun('bulk-bad-1');
    await raw.waitForRun('bulk-bad-2');
    await raw.waitForRun('bulk-ok');

    const res = await bulkAction(
      deps,
      req({ params: { action: 'retry' }, query: { filter: { status: 'failed' } } }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { matched: number; applied: number };
    expect(body.matched).toBe(2);
    expect(body.applied).toBe(2);

    // Requeue re-enqueues for a worker to pick up — by the time the (synchronous, in-memory) worker
    // has actually re-run both, either is a fair snapshot depending on exactly which microtask this
    // assertion lands on; the one status that's now IMPOSSIBLE is the original 'failed'.
    expect((await raw.getRun('bulk-bad-1'))?.status).not.toBe('failed');
    expect((await raw.getRun('bulk-bad-2'))?.status).not.toBe('failed');
  });

  it('bulkAction 400s on an unknown action', async () => {
    const res = await bulkAction(deps, req({ params: { action: 'nuke' }, query: {} }));
    expect(res.status).toBe(400);
  });

  it('bulkAction 400s a bare filter field instead of acting on every run', async () => {
    await raw.start('boom', {}, 'bulk-bare');
    await raw.waitForRun('bulk-bare');
    const res = await bulkAction(
      deps,
      req({ params: { action: 'retry' }, query: { status: 'failed' } }),
    );
    expect(res.status).toBe(400);
    expect((await raw.getRun('bulk-bare'))?.status).toBe('failed');
  });

  describe('runValues: the picker enumeration', () => {
    type FacetRow = { value: string | null; count: number };

    /** A few runs spread across workflows, tenants, tags and attributes. */
    async function seed() {
      await raw.start('greet', {}, 'v-a', {
        tags: ['etl', 'nightly'],
        namespace: 'acme',
        searchAttributes: { tier: 'pro', amount: 200 },
      });
      await raw.start('greet', {}, 'v-b', {
        tags: ['etl'],
        namespace: 'acme',
        searchAttributes: { tier: 'pro', amount: 500 },
      });
      await raw.start('boom', {}, 'v-c', {
        tags: ['nightly'],
        namespace: 'globex',
        searchAttributes: { tier: 'free' },
      });
      await raw.waitForRun('v-a');
      await raw.waitForRun('v-b');
      await raw.waitForRun('v-c');
    }

    it('enumerates tag values with counts, most common first', async () => {
      await seed();
      const res = await runValues(deps, req({ query: { field: 'tag' } }));
      expect(res.status).toBe(200);
      expect(res.body as FacetRow[]).toEqual([
        { value: 'etl', count: 2 },
        { value: 'nightly', count: 2 },
      ]);
    });

    it('enumerates attribute keys (attr) and the values under one key (attr.<key>)', async () => {
      await seed();
      const keys = await runValues(deps, req({ query: { field: 'attr' } }));
      expect(keys.body as FacetRow[]).toEqual([
        { value: 'tier', count: 3 },
        { value: 'amount', count: 2 },
      ]);
      const tiers = await runValues(deps, req({ query: { field: 'attr.tier' } }));
      expect(tiers.body as FacetRow[]).toEqual([
        { value: 'pro', count: 2 },
        { value: 'free', count: 1 },
      ]);
    });

    it('scopes the enumeration by the other filters, searches and pages server-side', async () => {
      await seed();
      // Under one tenant, only that tenant's tags are offered.
      const scoped = await runValues(
        deps,
        req({ query: { field: 'tag', filter: { namespace: 'globex' } } }),
      );
      expect(scoped.body as FacetRow[]).toEqual([{ value: 'nightly', count: 1 }]);

      // Search narrows before the bound.
      const searched = await runValues(deps, req({ query: { field: 'tag', search: 'IGHT' } }));
      expect(searched.body as FacetRow[]).toEqual([{ value: 'nightly', count: 2 }]);

      // Paging walks the fixed order.
      const first = await runValues(deps, req({ query: { field: 'tag', limit: '1' } }));
      expect((first.body as FacetRow[]).map((r) => r.value)).toEqual(['etl']);
      const second = await runValues(
        deps,
        req({ query: { field: 'tag', limit: '1', offset: '1' } }),
      );
      expect((second.body as FacetRow[]).map((r) => r.value)).toEqual(['nightly']);
    });

    it('drops status from the scope so pickers stay usable under a status chip', async () => {
      await seed();
      // `v-c` is the only failed run, but the tag picker still offers every tenant's tags: status
      // is the axis being viewed, not a scope for the other axes.
      const res = await runValues(
        deps,
        req({ query: { field: 'tag', filter: { status: 'failed' } } }),
      );
      expect(res.status).toBe(200);
      expect(res.body as FacetRow[]).toEqual([
        { value: 'etl', count: 2 },
        { value: 'nightly', count: 2 },
      ]);
    });

    it('400s on a missing or unknown field', async () => {
      expect((await runValues(deps, req({ query: {} }))).status).toBe(400);
      expect((await runValues(deps, req({ query: { field: 'nope' } }))).status).toBe(400);
      expect((await runValues(deps, req({ query: { field: 'attr.' } }))).status).toBe(400);
    });

    it('listRuns accepts repeated tag params as a set (union) and attr in-sets', async () => {
      await seed();
      const union = await listRuns(deps, req({ query: { filter: { tag: ['etl', 'nope'] } } }));
      expect(runIds(union).sort()).toEqual(['v-a', 'v-b']);

      const inSet = await listRuns(deps, req({ query: { filter: { attr: 'tier:in:pro|free' } } }));
      expect(runIds(inSet).sort()).toEqual(['v-a', 'v-b', 'v-c']);
    });

    it('falls back to a bounded listRuns scan on a port without runValueFacets', async () => {
      await seed();
      // A store-less tenant pod's adapter has no native enumeration — the handler still answers by
      // counting a scan, same shape.
      const scanDeps: Deps = {
        engine: { listRuns: (q) => raw.listRuns(q) } as Deps['engine'],
      };
      const res = await runValues(scanDeps, req({ query: { field: 'tag' } }));
      expect(res.status).toBe(200);
      expect(res.body as FacetRow[]).toEqual([
        { value: 'etl', count: 2 },
        { value: 'nightly', count: 2 },
      ]);
    });

    it('reads the structured filter envelope through the same class', async () => {
      await seed();
      const scoped = await runValues(
        deps,
        req({ query: { field: 'tag', filter: { namespace: 'globex' } } }),
      );
      expect(scoped.status).toBe(200);
      expect(scoped.body as FacetRow[]).toEqual([{ value: 'nightly', count: 1 }]);

      const listed = await listRuns(
        deps,
        req({ query: { filter: { tag: ['etl'], namespace: ['acme', 'globex'] } } }),
      );
      expect(runIds(listed).sort()).toEqual(['v-a', 'v-b']);
    });

    it('reads the groupByCount envelope block for the axis and its bounds', async () => {
      await seed();
      const res = await runValues(
        deps,
        req({
          query: {
            filter: { namespace: 'globex' },
            groupByCount: { field: 'tag', limit: '1' },
          },
        }),
      );
      expect(res.status).toBe(200);
      expect(res.body as FacetRow[]).toEqual([{ value: 'nightly', count: 1 }]);
    });

    it('400s a refused structured filter instead of silently widening', async () => {
      await seed();
      const unknown = await listRuns(deps, req({ query: { filter: { nope: 'x' } } }));
      expect(unknown.status).toBe(400);
      const ored = await listRuns(
        deps,
        req({
          query: {
            where: [
              {
                field: '',
                operator: 'equals',
                OR: [{ field: 'tag', operator: 'equals', value: 'etl' }],
              },
            ],
          },
        }),
      );
      expect(ored.status).toBe(400);
      // Bare keys no filter method owns are not filters, and are ignored.
      const lenient = await listRuns(deps, req({ query: { whatever: 'x' } }));
      expect(lenient.status).toBe(200);
      // A bare filter field is refused on the pickers too.
      expect((await runValues(deps, req({ query: { field: 'tag', tag: 'etl' } }))).status).toBe(
        400,
      );
    });
  });

  /**
   * The bundled React console sends `POST /runs/:id/cancel?compensate=true` with NO body (see
   * `durable-client.ts`'s `cancel`), while the handler used to read the flag only from the JSON body.
   * The result was the worst possible shape of failure: "Cancel + Undo" returned `200 cancelled`, the
   * UI reported success, and no compensation ran. These cases pin BOTH channels down.
   */
  describe('cancel: the compensate flag', () => {
    /** Arrange a run that has completed a compensable step and is parked on a signal. */
    async function arrangeCompensable(runId: string) {
      await raw.start('compensable', {}, runId);
      await raw.waitForRun(runId);
      expect(undone).toEqual([]);
    }

    it('compensates when the flag arrives on the QUERY STRING (the console path)', async () => {
      await arrangeCompensable('run-comp-query');

      const res = await cancelRun(
        deps,
        req({ params: { id: 'run-comp-query' }, query: { compensate: 'true' } }),
      );

      expect(res.status).toBe(200);
      await poll(async () => undone.length === 1);
      expect(undone).toEqual(['charge']);
      expect((await raw.getRun('run-comp-query'))?.status).toBe('cancelled');
    });

    it('still compensates when the flag arrives in the BODY (the documented path)', async () => {
      await arrangeCompensable('run-comp-body');

      const res = await cancelRun(
        deps,
        req({ params: { id: 'run-comp-body' }, body: { compensate: true } }),
      );

      expect(res.status).toBe(200);
      await poll(async () => undone.length === 1);
      expect(undone).toEqual(['charge']);
    });

    it('does NOT compensate when the flag is absent', async () => {
      await arrangeCompensable('run-comp-none');

      const res = await cancelRun(deps, req({ params: { id: 'run-comp-none' } }));

      expect(res.status).toBe(200);
      // A plain cancel is terminal in the response itself — no background saga to wait for.
      expect((res.body as { result: { status: string } }).result.status).toBe('cancelled');
      await settle();
      expect(undone).toEqual([]);
    });

    // The coercion trap: every one of these is a non-empty string, so a `Boolean(raw)` test would
    // read them all as "yes" and run an undo the operator explicitly declined.
    for (const spelling of ['false', '0', 'no', 'off', 'FALSE', ' false ']) {
      it(`treats ?compensate=${JSON.stringify(spelling)} as false`, async () => {
        const runId = `run-comp-false-${spelling.trim().toLowerCase()}`;
        await arrangeCompensable(runId);

        const res = await cancelRun(
          deps,
          req({ params: { id: runId }, query: { compensate: spelling } }),
        );

        expect(res.status).toBe(200);
        // Answered `cancelled` outright: the compensating path would have returned `suspended` and
        // finished in the background, so this alone proves the undo was never scheduled.
        expect((res.body as { result: { status: string } }).result.status).toBe('cancelled');
        await settle();
        expect(undone).toEqual([]);
      });
    }

    for (const spelling of ['true', '1', 'yes', 'on', 'TRUE', '']) {
      it(`treats ?compensate=${JSON.stringify(spelling)} as true`, async () => {
        const runId = `run-comp-true-${spelling || 'bare'}`;
        await arrangeCompensable(runId);

        const res = await cancelRun(
          deps,
          req({ params: { id: runId }, query: { compensate: spelling } }),
        );

        expect(res.status).toBe(200);
        await poll(async () => undone.length === 1);
        expect(undone).toEqual(['charge']);
      });
    }

    it('lets an explicit body value win over the query string', async () => {
      await arrangeCompensable('run-comp-precedence');

      const res = await cancelRun(
        deps,
        req({
          params: { id: 'run-comp-precedence' },
          query: { compensate: 'true' },
          body: { compensate: false },
        }),
      );

      expect(res.status).toBe(200);
      expect((res.body as { result: { status: string } }).result.status).toBe('cancelled');
      await settle();
      expect(undone).toEqual([]);
    });

    it('400s on an unreadable value instead of guessing', async () => {
      await arrangeCompensable('run-comp-garbage');

      const res = await cancelRun(
        deps,
        req({ params: { id: 'run-comp-garbage' }, query: { compensate: 'maybe' } }),
      );

      expect(res.status).toBe(400);
      await settle();
      expect(undone).toEqual([]);
      // The run must be untouched — a rejected request cancels nothing.
      expect((await raw.getRun('run-comp-garbage'))?.status).not.toBe('cancelled');
    });
  });

  describe('bulk cancel: the compensate flag', () => {
    async function arrangeCompensable(runId: string) {
      await raw.start('compensable', {}, runId);
      await raw.waitForRun(runId);
    }

    it('compensates every matched run on ?compensate=true', async () => {
      await arrangeCompensable('bulk-comp-1');
      await arrangeCompensable('bulk-comp-2');

      const res = await bulkAction(
        deps,
        req({
          params: { action: 'cancel' },
          query: { filter: { status: 'suspended' }, compensate: 'true' },
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ matched: 2, applied: 2 });
      await poll(async () => undone.length === 2);
      expect(undone).toEqual(['charge', 'charge']);
    });

    it('reads the flag from the body too', async () => {
      await arrangeCompensable('bulk-comp-body');

      const res = await bulkAction(
        deps,
        req({
          params: { action: 'cancel' },
          query: { filter: { status: 'suspended' } },
          body: { compensate: true },
        }),
      );

      expect(res.status).toBe(200);
      await poll(async () => undone.length === 1);
      expect(undone).toEqual(['charge']);
    });

    it('treats ?compensate=false as false', async () => {
      await arrangeCompensable('bulk-comp-off');

      const res = await bulkAction(
        deps,
        req({
          params: { action: 'cancel' },
          query: { filter: { status: 'suspended' }, compensate: 'false' },
        }),
      );

      expect(res.status).toBe(200);
      expect((await raw.getRun('bulk-comp-off'))?.status).toBe('cancelled');
      await settle();
      expect(undone).toEqual([]);
    });

    it('400s on an unreadable value before touching a single run', async () => {
      await arrangeCompensable('bulk-comp-garbage');

      const res = await bulkAction(
        deps,
        req({
          params: { action: 'cancel' },
          query: { filter: { status: 'suspended' }, compensate: 'sure' },
        }),
      );

      expect(res.status).toBe(400);
      await settle();
      expect(undone).toEqual([]);
      expect((await raw.getRun('bulk-comp-garbage'))?.status).not.toBe('cancelled');
    });
  });

  describe('listSchedules', () => {
    const schedule = (key: string, over: Record<string, unknown> = {}) => ({
      key,
      workflow: 'greet',
      paused: false,
      pausedAtRuntime: false,
      lastFireAt: 0,
      nextFireAt: 0,
      currentWindowRunId: `w-${key}`,
      ...over,
    });
    const port = (rows: ReturnType<typeof schedule>[]): Deps => ({
      engine: { ...deps.engine, listSchedules: async () => rows },
    });
    const keys = (res: { body: unknown }) =>
      (res.body as { data: Array<{ key: string }> }).data.map((s) => s.key);

    it('answers { data, meta }, sorted by key, offset-paged', async () => {
      const d = port(['c', 'a', 'b'].map((k) => schedule(k)));
      const first = await listSchedules(d, req({ query: { size: '2' } }));
      expect(keys(first)).toEqual(['a', 'b']);
      expect((first.body as { meta: unknown }).meta).toEqual({
        total: 3,
        perPage: 2,
        currentPage: 1,
        lastPage: 2,
        firstPage: 1,
      });
      expect(keys(await listSchedules(d, req({ query: { size: '2', page: '2' } })))).toEqual(['c']);
    });

    it('filters by workflow, namespace and paused, and sorts by the allow-list', async () => {
      const d = port([
        schedule('a', { workflow: 'x', nextFireAt: 3 }),
        schedule('b', { workflow: 'y', namespace: 'eu', paused: true, nextFireAt: 1 }),
        schedule('c', { workflow: 'y', nextFireAt: 2 }),
      ]);
      expect(keys(await listSchedules(d, req({ query: { filter: { workflow: 'y' } } })))).toEqual([
        'b',
        'c',
      ]);
      expect(keys(await listSchedules(d, req({ query: { filter: { namespace: 'eu' } } })))).toEqual(
        ['b'],
      );
      expect(keys(await listSchedules(d, req({ query: { filter: { paused: 'false' } } })))).toEqual(
        ['a', 'c'],
      );
      expect(keys(await listSchedules(d, req({ query: { sort: 'nextFireAt' } })))).toEqual([
        'b',
        'c',
        'a',
      ]);
      expect(keys(await listSchedules(d, req({ query: { sort: '-workflow,key' } })))).toEqual([
        'b',
        'c',
        'a',
      ]);
    });

    it('400s an unknown filter field, a bare filter field and an unknown sort', async () => {
      const d = port([schedule('a')]);
      for (const query of [
        { filter: { cron: 'x' } },
        { workflow: 'greet' },
        { filter: { paused: 'maybe' } },
        { sort: 'cron' },
      ]) {
        expect((await listSchedules(d, req({ query }))).status, JSON.stringify(query)).toBe(400);
      }
    });
  });

  it('health answers { data }', async () => {
    const res = await health(deps);
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { data: unknown[] }).data)).toBe(true);
  });

  it('workers answers { data: GroupHealth[] }', async () => {
    const res = await workers(deps);
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { data: unknown[] }).data)).toBe(true);
  });
});
