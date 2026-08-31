import { WorkflowEngine } from '../../src/engine.js';
import { NonDeterminismError } from '../../src/errors.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('WorkflowEngine — determinism', () => {
  it('throws NonDeterminismError when a step name no longer matches the recorded history', async () => {
    const store = new InMemoryStateStore();

    // v1: two steps, suspend between them so step "a" is checkpointed but "b" isn't yet.
    const v1 = new WorkflowEngine({ store });
    v1.register('wf', '1', async (ctx) => {
      await ctx.localStep('a', async () => 1);
      await ctx.waitForSignal('go');
      await ctx.localStep('b', async () => 2);
    });
    await startRun(v1, 'wf', {}, 'run1'); // suspends after "a"

    // Code changed under the in-flight run (step renamed a→A at seq 0) WITHOUT a new version.
    const v2 = new WorkflowEngine({ store });
    v2.register('wf', '1', async (ctx) => {
      await ctx.localStep('A', async () => 1);
      await ctx.waitForSignal('go');
      await ctx.localStep('b', async () => 2);
    });

    const resumed = await v2.signal('go', null);
    expect(resumed?.status).toBe('failed');
    expect(resumed?.error?.message).toMatch(/non-determinism at run1#0/);
  });

  it('is the literal NonDeterminismError type', () => {
    const e = new NonDeterminismError('r', 3, 'expected', 'recorded');
    expect(e.name).toBe('NonDeterminismError');
    expect(e.seq).toBe(3);
  });

  it('ctx.now/sideEffect record once and replay the same value', async () => {
    const store = new InMemoryStateStore();
    let clockValue = 1000;
    const engine = new WorkflowEngine({ store, clock: () => clockValue });

    // The body runs once on start, then again on resume (replay). Each time it re-reads now +
    // sideEffect-captured random/uuid — which must return the value captured on the FIRST run, not
    // a fresh one.
    const observed: Array<{ now: number; rand: number; id: string }> = [];
    engine.register('wf', '1', async (ctx) => {
      const snapshot = {
        now: await ctx.now(),
        rand: await ctx.sideEffect(() => Math.random()),
        id: await ctx.sideEffect(() => globalThis.crypto.randomUUID()),
      };
      observed.push(snapshot);
      await ctx.waitForSignal('go'); // suspend → forces a replay on resume
      return snapshot;
    });

    await startRun(engine, 'wf', {}, 'run1');
    clockValue = 9999; // clock + a fresh Math.random/uuid would differ on replay
    const done = await engine.signal('go', null);

    // Captured on run 1, replayed verbatim on resume — both observations identical, clock pinned.
    expect(observed).toHaveLength(2);
    expect(observed[0]).toEqual(observed[1]);
    expect(observed[0]?.now).toBe(1000);
    expect((done!.output as { now: number }).now).toBe(1000);
  });
});
