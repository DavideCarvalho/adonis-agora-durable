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
async function poll(fn: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
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
          query: { status: 'suspended', compensate: 'true' },
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
          query: { status: 'suspended' },
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
          query: { status: 'suspended', compensate: 'false' },
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
          query: { status: 'suspended', compensate: 'sure' },
        }),
      );

      expect(res.status).toBe(400);
      await settle();
      expect(undone).toEqual([]);
      expect((await raw.getRun('bulk-comp-garbage'))?.status).not.toBe('cancelled');
    });
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
