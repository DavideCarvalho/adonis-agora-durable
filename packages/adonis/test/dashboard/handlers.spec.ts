import { beforeEach, describe, expect, it } from 'vitest';
import {
  type ApiRequest,
  type Deps,
  cancelRun,
  getRun,
  health,
  listRuns,
  redispatchPendingRun,
  retryRun,
} from '../../src/dashboard/handlers.js';
import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '../../src/index.js';

/**
 * What this spec actually drives: the concrete {@link WorkflowEngine}, narrowed to
 * the {@link Deps} port only when it is handed to a handler.
 *
 * `Deps.engine` is deliberately the bounded `DashboardEngine` read/control port,
 * which does not declare `start`/`waitForRun` — those are engine-only. The spec needs
 * them to arrange runs, so it holds the concrete type and lets each handler call site
 * do the narrowing. `extends Deps` is load-bearing: it makes TypeScript re-check that
 * `WorkflowEngine` really is structurally assignable to the port, which is the claim
 * `DashboardEngine`'s own doc comment makes.
 */
interface TestDeps extends Deps {
  engine: WorkflowEngine;
}

/** Build a real in-memory engine and register a couple of workflows. */
function makeEngine(): TestDeps {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });

  engine.register('greet', '1', async (ctx) => {
    const a = await ctx.localStep('a', async () => 21);
    return a * 2;
  });

  // A workflow that always throws, so a run reaches `failed`.
  engine.register('boom', '1', async (ctx) => {
    await ctx.localStep('explode', async () => {
      throw new Error('kaboom');
    });
    return 'never';
  });

  // A workflow that suspends on a signal, so it stays in-flight (cancellable).
  engine.register('waiter', '1', async (ctx) => {
    await ctx.waitForSignal('go');
    return 'done';
  });

  return { engine };
}

const req = (over: Partial<ApiRequest> = {}): ApiRequest => ({
  params: {},
  query: {},
  ...over,
});

describe('JSON handlers', () => {
  let deps: TestDeps;

  beforeEach(() => {
    deps = makeEngine();
  });

  it('listRuns returns started runs with status badges', async () => {
    await deps.engine.start('greet', {}, 'run-ok');
    await deps.engine.waitForRun('run-ok');

    const res = await listRuns(deps, req());
    expect(res.status).toBe(200);
    const body = res.body as { runs: Array<{ id: string; status: string }>; statuses: string[] };
    expect(body.runs.map((r) => r.id)).toContain('run-ok');
    expect(body.runs.find((r) => r.id === 'run-ok')?.status).toBe('completed');
    expect(body.statuses).toContain('failed');
  });

  it('listRuns filters by status', async () => {
    await deps.engine.start('greet', {}, 'run-ok');
    await deps.engine.waitForRun('run-ok');
    await deps.engine.start('boom', {}, 'run-bad');
    await deps.engine.waitForRun('run-bad');

    const res = await listRuns(deps, req({ query: { status: 'failed' } }));
    const body = res.body as { runs: Array<{ id: string }> };
    expect(body.runs.map((r) => r.id)).toEqual(['run-bad']);
  });

  it('listRuns filters by workflow', async () => {
    await deps.engine.start('greet', {}, 'g1');
    await deps.engine.start('boom', {}, 'b1');
    await deps.engine.waitForRun('g1');
    await deps.engine.waitForRun('b1');

    const res = await listRuns(deps, req({ query: { workflow: 'greet' } }));
    const body = res.body as { runs: Array<{ id: string; workflow: string }> };
    expect(body.runs.every((r) => r.workflow === 'greet')).toBe(true);
  });

  it('getRun returns run detail + step timeline', async () => {
    await deps.engine.start('greet', {}, 'run-ok');
    await deps.engine.waitForRun('run-ok');

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
    await deps.engine.start('boom', {}, 'run-bad');
    await deps.engine.waitForRun('run-bad');

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

  it('redispatchPendingRun returns the run status and a redispatched count', async () => {
    await deps.engine.start('greet', {}, 'run-done'); // no remote steps → redispatched: 0
    await deps.engine.waitForRun('run-done');

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
    await deps.engine.start('waiter', {}, 'run-wait');
    await deps.engine.waitForRun('run-wait'); // settles to suspended

    const res = await cancelRun(deps, req({ params: { id: 'run-wait' } }));
    expect(res.status).toBe(200);
    const body = res.body as { result: { status: string } };
    expect(body.result.status).toBe('cancelled');

    const after = await deps.engine.getRun('run-wait');
    expect(after?.status).toBe('cancelled');
  });

  it('cancelRun 404s for an unknown run', async () => {
    const res = await cancelRun(deps, req({ params: { id: 'ghost' } }));
    expect(res.status).toBe(404);
  });

  it('health returns a groups array', async () => {
    const res = await health(deps);
    expect(res.status).toBe(200);
    const body = res.body as { groups: unknown[] };
    expect(Array.isArray(body.groups)).toBe(true);
  });
});
