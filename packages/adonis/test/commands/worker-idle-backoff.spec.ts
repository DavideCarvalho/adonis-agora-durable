import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MAX_IDLE_INTERVAL_MS, runWorkerLoop } from '../../src/commands/worker.js';
import type { ControlMessage, ControlPlane } from '../../src/index.js';
import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '../../src/index.js';

/**
 * The worker loop backs off while idle (1s → 2s → 4s → 5s) and never waits past work it knows of:
 * the next due timer or schedule window caps the wait, and a run enqueued elsewhere (control-plane
 * nudge) or a run started or finished here ends it.
 */

/** A control plane the test drives: `deliver` hands a message to the engine as another pod would. */
class FakeControlPlane implements ControlPlane {
  handler: ((msg: ControlMessage) => void) | undefined;
  async publishControl(): Promise<void> {}
  onControl(handler: (msg: ControlMessage) => void): void {
    this.handler = handler;
  }
  deliver(msg: ControlMessage): void {
    this.handler?.(msg);
  }
}

const silent = { info() {}, error() {} };
const loops: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of loops.splice(0)) await stop();
});

/**
 * Run the loop with a recording sleep. `hold: true` keeps every wait pending until the test ends it
 * (`release`) or a wake-up does; otherwise a wait ends on the next macrotask.
 */
function loop(
  engine: WorkflowEngine,
  opts: { hold?: boolean; max?: number; schedules?: never[] } = {},
) {
  const waits: number[] = [];
  const pending: Array<() => void> = [];
  let ticksSeen = 0;
  let stop!: () => void;
  const stopSignal = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const done = runWorkerLoop(engine, {
    intervalMs: 1_000,
    ...(opts.max !== undefined ? { maxIdleIntervalMs: opts.max } : {}),
    ...(opts.schedules ? { schedules: opts.schedules } : {}),
    stopSignal,
    logger: silent,
    drainTimeoutMs: 100,
    sleep: (ms) => {
      waits.push(ms);
      ticksSeen += 1;
      return new Promise<void>((resolve) => {
        if (opts.hold) pending.push(resolve);
        else setImmediate(resolve);
      });
    },
  });
  const end = async () => {
    stop();
    for (const r of pending.splice(0)) r();
    await done;
  };
  loops.push(end);
  return {
    waits,
    ticks: () => ticksSeen,
    release: () => {
      for (const r of pending.splice(0)) r();
    },
    untilWaits: async (n: number) => {
      for (let i = 0; i < 1_000 && waits.length < n; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(waits.length).toBeGreaterThanOrEqual(n);
    },
    end,
  };
}

function engineWith(controlPlane: ControlPlane | undefined, store = new InMemoryStateStore()) {
  return new WorkflowEngine({
    store,
    transport: new InMemoryTransport(),
    ...(controlPlane ? { controlPlane } : {}),
  });
}

describe('worker loop idle backoff', () => {
  it('doubles the wait after each idle tick up to maxIdleIntervalMs', async () => {
    const run = loop(engineWith(new FakeControlPlane()));
    await run.untilWaits(5);
    expect(run.waits.slice(0, 5)).toEqual([2_000, 4_000, 5_000, 5_000, 5_000]);
    expect(DEFAULT_MAX_IDLE_INTERVAL_MS).toBe(5_000);
  });

  it('keeps the fixed tick when the engine cannot be woken for new runs', async () => {
    // No control plane and no run queue: only the pending-run poll finds a run started elsewhere.
    const run = loop(engineWith(undefined));
    await run.untilWaits(4);
    expect(run.waits.slice(0, 4)).toEqual([1_000, 1_000, 1_000, 1_000]);
  });

  it('keeps the fixed tick when maxIdleIntervalMs is not above intervalMs', async () => {
    const run = loop(engineWith(new FakeControlPlane()), { max: 1_000 });
    await run.untilWaits(3);
    expect(run.waits.slice(0, 3)).toEqual([1_000, 1_000, 1_000]);
  });

  it('never waits past the next due timer', async () => {
    const engine = engineWith(new FakeControlPlane());
    engine.register('nap', '1', async () => 'up');
    // A delayed start is a timer too: due in 3.2 s.
    await engine.start('nap', undefined, 'later', { startAt: Date.now() + 3_200 });
    const run = loop(engine);
    await run.untilWaits(3);
    // 2s (under the timer), then capped by it, never the 4s the backoff would reach.
    expect(run.waits[0]).toBe(2_000);
    expect(run.waits[1]).toBeLessThanOrEqual(3_200);
    expect(run.waits[1]).toBeGreaterThan(2_500);
  });

  it('a timer due sooner than the tick keeps the regular tick, never a busy loop', async () => {
    const store = new InMemoryStateStore();
    const engine = engineWith(new FakeControlPlane(), store);
    engine.register('nap2', '1', async () => 'up');
    await engine.start('nap2', undefined, 'soon', { startAt: Date.now() + 60_000 });
    // Its timer moves to the past: due, but (say) leased by another instance, so the tick skips it.
    await store.updateRun('soon', {
      wakeAt: Date.now() - 1,
      lockedBy: 'other',
      lockedUntil: Date.now() + 60_000,
    });
    const run = loop(engine);
    await run.untilWaits(3);
    expect(run.waits.slice(0, 3)).toEqual([1_000, 1_000, 1_000]);
  });

  it('never waits past the next in-process schedule window', async () => {
    const engine = engineWith(new FakeControlPlane());
    const now = Date.now();
    // Its next window starts in at most 3 s.
    const schedules = [{ key: 'tick3', workflow: 'nope', everyMs: 3_000, paused: true }];
    const run = loop(engine, { schedules: schedules as never[] });
    await run.untilWaits(4);
    const nextWindow = (Math.floor(now / 3_000) + 1) * 3_000 - now;
    for (const w of run.waits.slice(1, 4))
      expect(w).toBeLessThanOrEqual(Math.max(1_000, nextWindow + 50));
  });

  it('a run enqueued on another instance ends an idle wait at once', async () => {
    const cp = new FakeControlPlane();
    const run = loop(engineWith(cp), { hold: true });
    await run.untilWaits(1);
    expect(run.waits).toEqual([2_000]);
    cp.deliver({ kind: 'enqueued', runId: 'r-1', from: 'web-pod' });
    await run.untilWaits(2); // the held 2s wait ended: a tick ran and the next wait began
    // That tick found nothing, but work arrived: back to the regular tick before backing off again.
    expect(run.waits[1]).toBe(1_000);
  });

  it('a run started here ends a long idle wait', async () => {
    const engine = engineWith(new FakeControlPlane());
    engine.register('hello', '1', async () => 'hi');
    const run = loop(engine, { hold: true });
    await run.untilWaits(1);
    await engine.start('hello', undefined, 'r-2');
    await run.untilWaits(2);
    expect(run.waits[1]).toBe(1_000);
  });

  it('a regular wait is not cut short by activity, only by a nudge', async () => {
    const cp = new FakeControlPlane();
    const engine = engineWith(cp);
    engine.register('hello2', '1', async () => 'hi');
    // Busy start: the first tick picks up a pending run, so the wait stays at the tick.
    await engine.start('hello2', undefined, 'r-3');
    const run = loop(engine, { hold: true });
    await run.untilWaits(1);
    expect(run.waits[0]).toBe(1_000);
    await engine.start('hello2', undefined, 'r-4');
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(run.waits).toHaveLength(1); // still in the 1s wait
    run.release();
    await run.untilWaits(2);
  });
});
