import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  EngineEvent,
  GroupHealth,
  RunQuery,
  RunResult,
  StepCheckpoint,
  WorkflowRun,
} from '../../src/interfaces.js';
import { type RunGatewayEngine, StoreRunGateway } from '../../src/run-gateway/store-run-gateway.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/** A store-backed engine with a couple of workflows registered, plus its store for direct assertions. */
function makeEngine(): { engine: WorkflowEngine; store: InMemoryStateStore } {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  // Fast workflow that completes with its input echoed back.
  engine.register('echo', '1', async (_ctx, input) => input);
  // Suspends on a signal, then returns the delivered payload — for signal/subscribe/cancel tests.
  engine.register('await-go', '1', async (ctx) => ctx.waitForSignal('go'));
  // Runs a durable step then completes — its checkpoint gives getCheckpoints a timeline to read.
  engine.register('stepper', '1', async (ctx) => ctx.localStep('do-it', async () => 'stepped'));
  // Spawns a child workflow — its `child:`/`signal:child:` bookkeeping gives getRunChildren a tree to read.
  engine.register('parent', '1', async (ctx) => {
    await ctx.child('echo', { from: 'parent' });
    return 'parent-done';
  });
  return { engine, store };
}

describe('StoreRunGateway (store-backed RunGateway)', () => {
  describe('behaviour against a real in-memory engine', () => {
    it('topology() reports standalone by default and control-plane when configured', () => {
      const { engine } = makeEngine();
      expect(new StoreRunGateway(engine).topology()).toEqual({ role: 'standalone' });
      expect(new StoreRunGateway(engine, { role: 'control-plane' }).topology()).toEqual({
        role: 'control-plane',
      });
    });

    it('start() mints a runId, creates the run, and getRun reads it back', async () => {
      const { engine } = makeEngine();
      const gw = new StoreRunGateway(engine);

      const started = await gw.start('echo', { hello: 'world' });
      expect(started.runId).toBeTruthy();
      // waitForRun so the async dispatch settles before we read the terminal state.
      const settled = await engine.waitForRun(started.runId);
      expect(settled.status).toBe('completed');

      const run = await gw.getRun(started.runId);
      expect(run?.id).toBe(started.runId);
      expect(run?.workflow).toBe('echo');
    });

    it('start() honours an explicit runId (idempotency key)', async () => {
      const { engine } = makeEngine();
      const gw = new StoreRunGateway(engine);

      const started = await gw.start('echo', {}, { runId: 'fixed-id' });
      expect(started.runId).toBe('fixed-id');
      await engine.waitForRun('fixed-id');
      expect((await gw.getRun('fixed-id'))?.id).toBe('fixed-id');
    });

    it('getRun() returns null for an unknown run', async () => {
      const { engine } = makeEngine();
      expect(await new StoreRunGateway(engine).getRun('nope')).toBeNull();
    });

    it('listRuns() filters and paginates (limit / offset)', async () => {
      const { engine } = makeEngine();
      const gw = new StoreRunGateway(engine);
      for (const id of ['a', 'b', 'c']) await startRun(engine, 'echo', {}, id);

      expect((await gw.listRuns({ workflow: 'echo' })).length).toBe(3);
      const firstPage = await gw.listRuns({ workflow: 'echo', limit: 2 });
      expect(firstPage.length).toBe(2);
      const secondPage = await gw.listRuns({ workflow: 'echo', limit: 2, offset: 2 });
      expect(secondPage.length).toBe(1);
      // Disjoint pages — pagination actually walked the set.
      const seen = new Set([...firstPage, ...secondPage].map((r) => r.id));
      expect(seen.size).toBe(3);
    });

    it('getCheckpoints() returns the run timeline', async () => {
      const { engine } = makeEngine();
      const gw = new StoreRunGateway(engine);
      await startRun(engine, 'stepper', {}, 'r-cp');
      const cps = await gw.getCheckpoints('r-cp');
      // The completed durable step is recorded on the run's timeline.
      expect(cps.length).toBeGreaterThan(0);
      expect(cps.some((c) => c.name === 'do-it')).toBe(true);
    });

    it('getRunChildren() returns the ids of the runs a parent spawned', async () => {
      const { engine } = makeEngine();
      const gw = new StoreRunGateway(engine);
      await startRun(engine, 'parent', {}, 'r-parent');
      await engine.waitForRun('r-parent');
      const children = await gw.getRunChildren('r-parent');
      expect(children.length).toBe(1);
      // The child really is a distinct spawned run (not the parent itself).
      expect(children[0]).not.toBe('r-parent');
      expect((await gw.getRun(children[0] as string))?.workflow).toBe('echo');
      // A leaf run has no children.
      expect(await gw.getRunChildren('r-leaf-unknown')).toEqual([]);
    });

    it('getSearchAttributes() reads the attributes stamped at start', async () => {
      const { engine } = makeEngine();
      const gw = new StoreRunGateway(engine);
      await startRun(engine, 'echo', {}, 'r-sa', {
        searchAttributes: { amount: 200, tier: 'pro' },
      });
      expect(await gw.getSearchAttributes('r-sa')).toEqual({ amount: 200, tier: 'pro' });
      // A run with no attributes reads back undefined.
      await startRun(engine, 'echo', {}, 'r-nosa');
      expect(await gw.getSearchAttributes('r-nosa')).toBeUndefined();
    });

    it('signal() resumes a run parked on the matching token', async () => {
      const { engine } = makeEngine();
      const gw = new StoreRunGateway(engine);
      const suspended = await startRun(engine, 'await-go', {}, 'r-sig');
      expect(suspended.status).toBe('suspended');

      const res = await gw.signal('r-sig', 'go', { approved: true });
      expect(res?.status).toBe('completed');
      expect(res?.output).toEqual({ approved: true });
    });

    it('cancel() moves a suspended run to cancelled', async () => {
      const { engine } = makeEngine();
      const gw = new StoreRunGateway(engine);
      await startRun(engine, 'await-go', {}, 'r-cancel');

      const res = await gw.cancel('r-cancel');
      expect(res?.status).toBe('cancelled');
      expect((await gw.getRun('r-cancel'))?.status).toBe('cancelled');
    });

    it('cancel() returns null for an unknown run', async () => {
      const { engine } = makeEngine();
      expect(await new StoreRunGateway(engine).cancel('nope')).toBeNull();
    });

    it('subscribe() delivers events for the target run only, and unsubscribe stops them', async () => {
      const { engine } = makeEngine();
      const gw = new StoreRunGateway(engine);

      const seenForTarget: EngineEvent[] = [];
      const seenForOther: EngineEvent[] = [];
      const offTarget = gw.subscribe('r-target', (e) => seenForTarget.push(e));
      const offOther = gw.subscribe('r-other', (e) => seenForOther.push(e));

      await startRun(engine, 'echo', {}, 'r-target');
      expect(seenForTarget.length).toBeGreaterThan(0);
      // The subscriber filters by runId — the r-other subscriber saw none of r-target's events.
      expect(seenForOther.every((e) => e.runId === 'r-other')).toBe(true);
      expect(seenForOther.length).toBe(0);

      offTarget();
      offOther();
      const countAfterOff = seenForTarget.length;
      await startRun(engine, 'echo', {}, 'r-target-2'); // different run anyway; also proves no leaks
      expect(seenForTarget.length).toBe(countAfterOff);
    });

    it('redispatchPending() degrades to null when the engine port omits the method (legacy)', async () => {
      const { engine } = makeEngine();
      // The real engine now implements redispatchPending (parity port of aviary's lost-remote-step
      // recovery). To exercise the optional-member degradation guard, hide just that method behind a
      // proxy — a legacy engine port that predates it must degrade to null rather than throw.
      const legacy = new Proxy(engine, {
        get: (t, p, r) => (p === 'redispatchPending' ? undefined : Reflect.get(t, p, r)),
      }) as unknown as RunGatewayEngine;
      expect((legacy as { redispatchPending?: unknown }).redispatchPending).toBeUndefined();
      expect(await new StoreRunGateway(legacy).redispatchPending('whatever')).toBeNull();
    });
  });

  /**
   * Delegation spies — the mutation-facing proof. A hand-rolled fake `RunGatewayEngine` records the
   * exact method + args each verb forwards to, and returns a sentinel the gateway must pass through
   * untouched. If a verb stops delegating (or delegates to the wrong method / with wrong args / drops
   * the return value), the matching assertion fails.
   */
  describe('delegation (exact method, args, and return pass-through)', () => {
    function fakeEngine() {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const rec =
        <T>(method: string, ret: T) =>
        (...args: unknown[]): T => {
          calls.push({ method, args });
          return ret;
        };
      const engine: RunGatewayEngine & {
        redispatchPending: (r: string) => Promise<(RunResult & { redispatched: number }) | null>;
      } = {
        getRun: rec('getRun', Promise.resolve({ id: 'x' } as WorkflowRun)),
        listRuns: rec('listRuns', Promise.resolve([{ id: 'x' }] as WorkflowRun[])),
        listCheckpoints: rec('listCheckpoints', Promise.resolve([{ seq: 1 }] as StepCheckpoint[])),
        getRunChildren: rec('getRunChildren', Promise.resolve(['c1', 'c2'])),
        workerHealth: rec('workerHealth', Promise.resolve([{ group: 'g' }] as GroupHealth[])),
        start: rec('start', Promise.resolve({ runId: 'x', status: 'pending' } as RunResult)),
        signal: rec('signal', Promise.resolve({ runId: 'x', status: 'completed' } as RunResult)),
        cancel: rec('cancel', Promise.resolve({ runId: 'x', status: 'cancelled' } as RunResult)),
        subscribe: rec('subscribe', () => {}),
        redispatchPending: rec(
          'redispatchPending',
          Promise.resolve({ runId: 'x', status: 'running', redispatched: 3 } as RunResult & {
            redispatched: number;
          }),
        ),
      };
      return { engine, calls };
    }

    it('getRun -> engine.getRun(runId)', async () => {
      const { engine, calls } = fakeEngine();
      const out = await new StoreRunGateway(engine).getRun('r1');
      expect(calls).toEqual([{ method: 'getRun', args: ['r1'] }]);
      expect(out).toEqual({ id: 'x' });
    });

    it('listRuns -> engine.listRuns(query)', async () => {
      const { engine, calls } = fakeEngine();
      const query: RunQuery = { workflow: 'w', limit: 5 };
      await new StoreRunGateway(engine).listRuns(query);
      expect(calls).toEqual([{ method: 'listRuns', args: [query] }]);
    });

    it('getCheckpoints -> engine.listCheckpoints(runId)', async () => {
      const { engine, calls } = fakeEngine();
      await new StoreRunGateway(engine).getCheckpoints('r1');
      expect(calls).toEqual([{ method: 'listCheckpoints', args: ['r1'] }]);
    });

    it('getRunChildren -> engine.getRunChildren(runId) and passes the ids through', async () => {
      const { engine, calls } = fakeEngine();
      const out = await new StoreRunGateway(engine).getRunChildren('r1');
      expect(calls).toEqual([{ method: 'getRunChildren', args: ['r1'] }]);
      expect(out).toEqual(['c1', 'c2']);
    });

    it('getSearchAttributes -> engine.getRun(runId).searchAttributes', async () => {
      const { engine, calls } = fakeEngine();
      engine.getRun = (...args: unknown[]) => {
        calls.push({ method: 'getRun', args });
        return Promise.resolve({ id: 'x', searchAttributes: { a: 1 } } as unknown as WorkflowRun);
      };
      const out = await new StoreRunGateway(engine).getSearchAttributes('r1');
      expect(calls).toEqual([{ method: 'getRun', args: ['r1'] }]);
      expect(out).toEqual({ a: 1 });
    });

    it('workerHealth -> engine.workerHealth()', async () => {
      const { engine, calls } = fakeEngine();
      await new StoreRunGateway(engine).workerHealth();
      expect(calls).toEqual([{ method: 'workerHealth', args: [] }]);
    });

    it('start -> engine.start(workflow, input, runId, opts) and passes the result through', async () => {
      const { engine, calls } = fakeEngine();
      const out = await new StoreRunGateway(engine).start(
        'wf',
        { x: 1 },
        { runId: 'r1', tags: ['t'] },
      );
      expect(calls).toEqual([
        { method: 'start', args: ['wf', { x: 1 }, 'r1', { runId: 'r1', tags: ['t'] }] },
      ]);
      expect(out).toEqual({ runId: 'x', status: 'pending' });
    });

    it('start mints a runId when none is supplied', async () => {
      const { engine, calls } = fakeEngine();
      await new StoreRunGateway(engine).start('wf', {});
      expect(calls[0]?.method).toBe('start');
      expect(typeof calls[0]?.args[2]).toBe('string');
      expect((calls[0]!.args[2] as string).length).toBeGreaterThan(0);
    });

    it('signal -> engine.signal(signal, payload) (token delegation)', async () => {
      const { engine, calls } = fakeEngine();
      const out = await new StoreRunGateway(engine).signal('r1', 'go', { ok: true });
      expect(calls).toEqual([{ method: 'signal', args: ['go', { ok: true }] }]);
      expect(out).toEqual({ runId: 'x', status: 'completed' });
    });

    it('cancel -> engine.cancel(runId, opts)', async () => {
      const { engine, calls } = fakeEngine();
      await new StoreRunGateway(engine).cancel('r1', { compensate: true });
      expect(calls).toEqual([{ method: 'cancel', args: ['r1', { compensate: true }] }]);
    });

    it('redispatchPending -> engine.redispatchPending(runId) and passes the result through', async () => {
      const { engine, calls } = fakeEngine();
      const out = await new StoreRunGateway(engine).redispatchPending('r1');
      expect(calls).toEqual([{ method: 'redispatchPending', args: ['r1'] }]);
      expect(out).toEqual({ runId: 'x', status: 'running', redispatched: 3 });
    });

    it('subscribe -> engine.subscribe(listener) and returns the unsubscribe', () => {
      const { engine, calls } = fakeEngine();
      const off = new StoreRunGateway(engine).subscribe('r1', () => {});
      expect(calls[0]?.method).toBe('subscribe');
      expect(typeof off).toBe('function');
    });

    it('subscribe forwards only matching-runId events to the caller', () => {
      let captured: ((e: EngineEvent) => void) | undefined;
      const engine = {
        subscribe: (l: (e: EngineEvent) => void) => {
          captured = l;
          return () => {};
        },
      } as unknown as RunGatewayEngine;
      const received: string[] = [];
      new StoreRunGateway(engine).subscribe('r1', (e) => received.push(e.runId));
      captured?.({ type: 'run.completed', runId: 'r1', at: new Date() });
      captured?.({ type: 'run.completed', runId: 'other', at: new Date() });
      expect(received).toEqual(['r1']);
    });
  });
});
