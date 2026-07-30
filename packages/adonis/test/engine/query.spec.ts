import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * A store WITHOUT the optional targeted-read methods — exactly what a consumer's custom StateStore
 * looks like before they implement the new (optional) interface members. The engine must transparently
 * fall back to `listCheckpoints` + an in-JS filter and produce identical results.
 */
/**
 * `InMemoryStateStore` MINUS the two optional query members. Extending the class directly can't express
 * "this member is gone" — the base declares them as concrete methods — so the base constructor is retyped
 * to the narrowed shape, which is what lets the subclass below legitimately declare them absent.
 */
type WithoutTargetedReads<T> = Omit<T, 'getLatestCheckpointByName' | 'listCheckpointsByNamePrefix'>;

const LegacyBase: new () => WithoutTargetedReads<InMemoryStateStore> = InMemoryStateStore;

class LegacyStore extends LegacyBase {
  // Deliberately drop the optional members to emulate a legacy custom store that never implemented them.
  // The `= undefined` own properties are load-bearing: they shadow the inherited prototype methods.
  getLatestCheckpointByName = undefined;
  listCheckpointsByNamePrefix = undefined;
}

describe('ctx.setEvent / engine.getEvent — live query of a running run', () => {
  it('reads the latest value a running workflow published, without disturbing it', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('job', '1', async (ctx) => {
      await ctx.setEvent('progress', 0);
      await ctx.localStep('phase-1', async () => 'a');
      await ctx.setEvent('progress', 50);
      await ctx.waitForSignal('go'); // suspend so we can query mid-flight
      await ctx.setEvent('progress', 100);
      return 'done';
    });

    await startRun(engine, 'job', {}, 'r1'); // runs until the signal wait, then suspends

    expect(await engine.getEvent('r1', 'progress')).toBe(50);
    expect(await engine.getEvent('r1', 'missing')).toBeUndefined();

    await engine.signal('go', undefined); // resume to completion
    expect(await engine.getEvent<number>('r1', 'progress')).toBe(100);
    expect((await store.getRun('r1'))?.status).toBe('completed');
  });

  it('falls back to listCheckpoints when the store omits the optional targeted-read methods', async () => {
    const store = new LegacyStore();
    expect(store.getLatestCheckpointByName).toBeUndefined();
    expect(store.listCheckpointsByNamePrefix).toBeUndefined();

    // `StateStore` declares the two members OPTIONAL, and under `exactOptionalPropertyTypes` "absent" and
    // "present but `undefined`" are different types. A legacy store is the former, so the engine gets the
    // store through the absent-members view — a plain upcast (no assertion), matching what the shadowing
    // above achieves at runtime.
    const legacy: WithoutTargetedReads<LegacyStore> = store;
    const engine = new WorkflowEngine({ store: legacy });
    engine.register('job', '1', async (ctx) => {
      await ctx.setEvent('progress', 50);
      await ctx.waitForSignal('go');
      await ctx.setEvent('progress', 100);
      return 'done';
    });

    await startRun(engine, 'job', {}, 'r1');

    // getEvent must use the fallback scan and still return the latest value.
    expect(await engine.getEvent('r1', 'progress')).toBe(50);
    expect(await engine.getEvent('r1', 'missing')).toBeUndefined();

    await engine.signal('go', undefined);
    expect(await engine.getEvent<number>('r1', 'progress')).toBe(100);

    // getRunChildren must also work via the prefix-scan fallback (no children here ⇒ empty).
    expect(await engine.getRunChildren('r1')).toEqual([]);
  });
});
