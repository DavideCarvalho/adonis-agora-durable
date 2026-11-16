import { describe, expect, it } from 'vitest';
import { OWED_LIFECYCLE_SWEEP_INTERVAL_MS, runTick } from '../../src/commands/worker.js';
import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '../../src/index.js';

/**
 * The owed-lifecycle read filters settled runs by tag, which no index serves: a worker does it once
 * per interval, not on every tick. The cheap part of the sweep (run waiters) still runs every tick.
 */
function spyOnSweep(engine: WorkflowEngine) {
  const owed: (boolean | undefined)[] = [];
  const original = engine.sweepLifecycleEvents.bind(engine);
  engine.sweepLifecycleEvents = async (nowMs, limit, options) => {
    owed.push(options?.owed);
    return original(nowMs, limit, options);
  };
  return owed;
}

describe('worker tick: owed lifecycle sweep', () => {
  it('reads the owed runs on the first tick, then once per interval', async () => {
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
    });
    const owed = spyOnSweep(engine);
    const t0 = 1_000_000;

    await runTick(engine, { now: t0 });
    await runTick(engine, { now: t0 + 1_000 });
    await runTick(engine, { now: t0 + OWED_LIFECYCLE_SWEEP_INTERVAL_MS - 1 });
    await runTick(engine, { now: t0 + OWED_LIFECYCLE_SWEEP_INTERVAL_MS });
    await runTick(engine, { now: t0 + OWED_LIFECYCLE_SWEEP_INTERVAL_MS + 1_000 });

    expect(owed).toEqual([true, false, false, true, false]);
  });

  it('a clock that goes back reads the owed runs again', async () => {
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
    });
    const owed = spyOnSweep(engine);

    await runTick(engine, { now: 5_000_000 });
    await runTick(engine, { now: 1_000_000 });

    expect(owed).toEqual([true, true]);
  });

  it('each engine keeps its own interval', async () => {
    const a = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
    });
    const b = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
    });
    const owedA = spyOnSweep(a);
    const owedB = spyOnSweep(b);

    await runTick(a, { now: 1_000_000 });
    await runTick(b, { now: 1_000_500 });

    expect(owedA).toEqual([true]);
    expect(owedB).toEqual([true]);
  });
});
