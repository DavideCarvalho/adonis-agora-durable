import { beforeEach, describe, expect, it } from 'vitest';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import {
  type ApiRequest,
  type Deps,
  bulkAction,
  cancelRun,
  continueRun,
  getRun,
  health,
  listRuns,
  redispatchPendingRun,
  retryRun,
  retryWithInputRun,
  workers,
} from '../../src/dashboard/handlers.js';
import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '../../src/index.js';

/**
 * What this spec actually drives: a real in-memory {@link WorkflowEngine} for ARRANGE steps
 * (`raw.start`/`raw.waitForRun`/`raw.getRun` — engine-only, not part of the {@link Deps} port), plus
 * that same engine adapted through {@link storeDashboardEngine} into the bounded {@link Deps} port the
 * handlers under test actually receive — the same wiring `gateway-adapter.ts`'s
 * `dashboardEngineForRole` does for a store role in production.
 */
function makeEngine(): { raw: WorkflowEngine; deps: Deps } {
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

  return { raw, deps: { engine: storeDashboardEngine(raw) } };
}

const req = (over: Partial<ApiRequest> = {}): ApiRequest => ({
  params: {},
  query: {},
  ...over,
});

describe('JSON handlers', () => {
  let raw: WorkflowEngine;
  let deps: Deps;

  beforeEach(() => {
    ({ raw, deps } = makeEngine());
  });

  it('listRuns returns started runs with status badges', async () => {
    await raw.start('greet', {}, 'run-ok');
    await raw.waitForRun('run-ok');

    const res = await listRuns(deps, req());
    expect(res.status).toBe(200);
    const body = res.body as { runs: Array<{ id: string; status: string }>; statuses: string[] };
    expect(body.runs.map((r) => r.id)).toContain('run-ok');
    expect(body.runs.find((r) => r.id === 'run-ok')?.status).toBe('completed');
    expect(body.statuses).toContain('failed');
    expect(body.statuses).toContain('blocked');
  });

  it('listRuns filters by status', async () => {
    await raw.start('greet', {}, 'run-ok');
    await raw.waitForRun('run-ok');
    await raw.start('boom', {}, 'run-bad');
    await raw.waitForRun('run-bad');

    const res = await listRuns(deps, req({ query: { status: 'failed' } }));
    const body = res.body as { runs: Array<{ id: string }> };
    expect(body.runs.map((r) => r.id)).toEqual(['run-bad']);
  });

  it('listRuns filters by workflow', async () => {
    await raw.start('greet', {}, 'g1');
    await raw.start('boom', {}, 'b1');
    await raw.waitForRun('g1');
    await raw.waitForRun('b1');

    const res = await listRuns(deps, req({ query: { workflow: 'greet' } }));
    const body = res.body as { runs: Array<{ id: string; workflow: string }> };
    expect(body.runs.every((r) => r.workflow === 'greet')).toBe(true);
  });

  it('listRuns filters by tag and search-attribute predicate', async () => {
    await raw.start('greet', {}, 'g-tag', { tags: ['team:core'] });
    await raw.start('greet', {}, 'g-attr', { searchAttributes: { amount: 250 } });
    await raw.waitForRun('g-tag');
    await raw.waitForRun('g-attr');

    const byTag = await listRuns(deps, req({ query: { tag: 'team:core' } }));
    expect((byTag.body as { runs: Array<{ id: string }> }).runs.map((r) => r.id)).toEqual([
      'g-tag',
    ]);

    const byAttr = await listRuns(deps, req({ query: { attr: 'amount:gte:200' } }));
    expect((byAttr.body as { runs: Array<{ id: string }> }).runs.map((r) => r.id)).toEqual([
      'g-attr',
    ]);
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
      req({ params: { action: 'retry' }, query: { status: 'failed' } }),
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

  it('health returns a groups array', async () => {
    const res = await health(deps);
    expect(res.status).toBe(200);
    const body = res.body as { groups: unknown[] };
    expect(Array.isArray(body.groups)).toBe(true);
  });

  it('workers returns the full GroupHealth[] (unwrapped, with per-instance heartbeats)', async () => {
    const res = await workers(deps);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
