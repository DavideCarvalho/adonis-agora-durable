import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdaptiveController,
  resolveConcurrency,
} from '../../../../src/transports/bullmq/adaptive-concurrency.js';

/** Build a controller with deterministic RSS / memory-limit and a captured `apply`. */
function makeController(opts: {
  concurrency?: Parameters<typeof resolveConcurrency>[0];
  rss?: number;
  memLimit?: number;
  now?: () => number;
  readCpuUsage?: () => NodeJS.CpuUsage;
  readCpuCount?: () => number;
}) {
  const applied: number[] = [];
  const controller = new AdaptiveController({
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    apply: (limit) => applied.push(limit),
    readRss: () => opts.rss ?? 100_000_000,
    readMemoryLimit: () => opts.memLimit ?? 8_000_000_000,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.readCpuUsage ? { readCpuUsage: opts.readCpuUsage } : {}),
    ...(opts.readCpuCount ? { readCpuCount: opts.readCpuCount } : {}),
  });
  return { controller, applied };
}

/** A fake cumulative CPU clock: `spend(ms)` adds CPU time (microseconds) the next read returns. */
function fakeCpu() {
  let user = 0;
  return {
    read: (): NodeJS.CpuUsage => ({ user, system: 0 }),
    spend: (ms: number) => {
      user += ms * 1000;
    },
  };
}

/** Fill the completion window with `n` settled STEP tasks each `durationMs`, `okRatio` fraction
 *  succeeding. Steps (not workflow turns) are what the measurement window is allowed to see. */
function fill(c: AdaptiveController, n: number, durationMs: number, okRatio = 1): void {
  for (let i = 0; i < n; i++) {
    c.onStart();
    c.onSettle(durationMs, i / n < okRatio, 'step');
  }
}

describe('resolveConcurrency', () => {
  it('a bare number is fixed', () => {
    expect(resolveConcurrency(8)).toEqual({ mode: 'fixed', fixed: 8 });
  });

  it('undefined keeps the historical default of 1 (fixed)', () => {
    expect(resolveConcurrency(undefined)).toEqual({ mode: 'fixed', fixed: 1 });
  });

  it("'adaptive' applies every default", () => {
    expect(resolveConcurrency('adaptive')).toEqual({
      mode: 'adaptive',
      adaptive: { min: 1, max: 32, start: 1, ramCeilingPct: 85, tickMs: 2000 },
    });
  });

  it('an object overrides defaults and clamps start into [min,max]', () => {
    expect(
      resolveConcurrency({ mode: 'adaptive', min: 2, max: 6, start: 99, cpuCeilingPct: 90 }),
    ).toEqual({
      mode: 'adaptive',
      adaptive: { min: 2, max: 6, start: 6, ramCeilingPct: 85, tickMs: 2000, cpuCeilingPct: 90 },
    });
  });
});

describe('resolveConcurrency — non-finite values fall back to defaults', () => {
  const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -2, 0.5];

  it.each(bad)('a fixed %s becomes 1', (value) => {
    expect(resolveConcurrency(value)).toEqual({ mode: 'fixed', fixed: 1 });
  });

  it('a valid fixed value is floored', () => {
    expect(resolveConcurrency(4.7)).toEqual({ mode: 'fixed', fixed: 4 });
  });

  it.each(bad)('adaptive min/max/start/tickMs of %s fall back to their defaults', (value) => {
    expect(
      resolveConcurrency({ mode: 'adaptive', min: value, max: value, start: value, tickMs: value }),
    ).toEqual({
      mode: 'adaptive',
      adaptive: { min: 1, max: 32, start: 1, ramCeilingPct: 85, tickMs: 2000 },
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -5])(
    'a ramCeilingPct of %s falls back to 85 and a cpuCeilingPct of it turns the CPU ceiling off',
    (value) => {
      expect(
        resolveConcurrency({ mode: 'adaptive', ramCeilingPct: value, cpuCeilingPct: value }),
      ).toEqual({
        mode: 'adaptive',
        adaptive: { min: 1, max: 32, start: 1, ramCeilingPct: 85, tickMs: 2000 },
      });
    },
  );

  it('a NaN ram ceiling still brakes at the default 85%', () => {
    const { controller, applied } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 16, start: 10, ramCeilingPct: Number.NaN },
      rss: 900_000_000,
      memLimit: 1_000_000_000,
    });
    fill(controller, 20, 100);
    controller.tick();
    expect(applied).toEqual([8]);
  });
});

describe('AdaptiveController.snapshot — the WorkerStatus contract', () => {
  it('fixed mode reports mode:fixed, limit, inFlight, rss* and (after work) throughput/p95', () => {
    const { controller } = makeController({
      concurrency: 4,
      rss: 200_000_000,
      memLimit: 1_000_000_000,
    });
    controller.onStart();
    controller.onStart();
    const before = controller.snapshot();
    expect(before.concurrency).toEqual({ mode: 'fixed', limit: 4 });
    expect(before.runtime).toBe('node');
    expect(before.inFlight).toBe(2);
    expect(before.rssBytes).toBe(200_000_000);
    expect(before.rssLimitBytes).toBe(1_000_000_000);
    expect(before.rssPct).toBeCloseTo(20);
    // no completions yet → these stay omitted
    expect(before.p95Ms).toBeUndefined();
    expect(before.throughputPerMin).toBeUndefined();

    controller.onSettle(100, true, 'step');
    controller.onSettle(100, true, 'step');
    const after = controller.snapshot();
    expect(after.inFlight).toBe(0);
    expect(after.p95Ms).toBe(100);
    expect(after.throughputPerMin).toBeGreaterThan(0);
  });

  it('adaptive mode carries min/max on the concurrency block', () => {
    const { controller } = makeController({
      concurrency: { mode: 'adaptive', min: 2, max: 16, start: 5 },
    });
    expect(controller.snapshot().concurrency).toEqual({
      mode: 'adaptive',
      limit: 5,
      min: 2,
      max: 16,
    });
  });
});

describe('AdaptiveController.tick — AIMD decisions', () => {
  it('doubles when gradient is healthy AND saturated, until it first backs off', () => {
    const { controller, applied } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 10, start: 4 },
    });
    fill(controller, 20, 100); // equal durations → rttLong≈p50 → gradient≈1
    for (let i = 0; i < 4; i++) controller.onStart(); // inFlight=4 ≥ 4*0.8 → saturated
    controller.tick();
    expect(controller.limit).toBe(8);
    expect(applied).toEqual([8]);
    expect(controller.snapshot().lastAdjust).toMatchObject({ from: 4, to: 8, reason: 'grow' });
    for (let i = 0; i < 4; i++) controller.onStart(); // inFlight=8 → saturated again
    controller.tick();
    expect(controller.limit).toBe(10); // capped at max
  });

  it('in slow start, grows after each limit of settled steps without waiting for a tick', () => {
    const { controller, applied } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 32, start: 4 },
    });
    // A consumer that keeps every slot busy: each settled step is replaced by the next one.
    let inFlight = 0;
    const fillSlots = () => {
      for (; inFlight < controller.limit; inFlight++) controller.onStart();
    };
    fillSlots();
    for (let settled = 0; settled < 28; settled++) {
      controller.onSettle(2, true, 'step');
      inFlight -= 1;
      fillSlots();
    }
    expect(applied).toEqual([8, 16, 32]); // after 4, then 8, then 16 settled steps
  });

  it('in slow start, never shrinks or brakes between ticks', () => {
    const { controller, applied } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 32, start: 4 },
      rss: 950_000_000,
      memLimit: 1_000_000_000, // over the RAM ceiling: no growth
    });
    for (let i = 0; i < 4; i++) controller.onStart();
    controller.onSettle(1, true, 'step');
    controller.onStart();
    for (let settled = 0; settled < 20; settled++) {
      controller.onSettle(500, true, 'step'); // latency far past the tolerance
      controller.onStart();
    }
    expect(applied).toEqual([]);
    controller.tick(); // the tick is where it backs off
    expect(controller.snapshot().lastAdjust?.reason).toBe('ram_ceiling');
  });

  it('after backing off, grows by √limit a tick', () => {
    const { controller, applied } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 64, start: 20 },
    });
    fill(controller, 20, 100, 0.5); // 50% errors → backpressure: 20 → 19
    controller.tick();
    expect(controller.limit).toBe(19);
    fill(controller, 100, 100); // a healthy window again
    for (let i = 0; i < 19; i++) controller.onStart();
    controller.tick();
    expect(controller.limit).toBe(23); // 19 + floor(√19)
    expect(applied).toEqual([19, 23]);
  });

  it('does not shrink a worker of fast steps on latency jitter', () => {
    const { controller, applied } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 32, start: 8 },
    });
    // 1–5 ms steps: the fastest is a fifth of the slowest, but none of it is queuing.
    for (let i = 0; i < 100; i++) {
      controller.onStart();
      controller.onSettle(1 + (i % 5), true, 'step');
    }
    for (let tick = 0; tick < 5; tick++) controller.tick();
    expect(controller.limit).toBe(8);
    expect(applied).toEqual([]);
  });

  it('holds while p50 stays within twice the no-queuing baseline', () => {
    const { controller, applied } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 32, start: 8 },
    });
    controller.onStart();
    controller.onSettle(100, true, 'step'); // baseline 100 ms
    fill(controller, 99, 200); // p50 200 ms: (2 × 100 + 5) / 200 ≈ 1
    controller.tick();
    expect(controller.limit).toBe(8);
    expect(applied).toEqual([]);
  });

  it('still shrinks fast steps whose latency grows past the noise', () => {
    const { controller } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 32, start: 16 },
    });
    controller.onStart();
    controller.onSettle(1, true, 'step'); // the no-queuing baseline: 1 ms
    fill(controller, 99, 30); // p50 30 ms: (1 + 5) / 30 = 0.2
    controller.tick();
    expect(controller.limit).toBe(3); // floor(16 × 0.2)
    expect(controller.snapshot().lastAdjust?.reason).toBe('shrink');
  });

  it('does NOT grow when healthy but not saturated (raising a ceiling no one hits is meaningless)', () => {
    const { controller, applied } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 10, start: 4 },
    });
    fill(controller, 20, 100); // settled → inFlight back to 0, not saturated
    controller.tick();
    expect(controller.limit).toBe(4);
    expect(applied).toEqual([]);
  });

  it('shrinks by the gradient when latency inflates (queuing)', () => {
    const { controller, applied } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 10, start: 8 },
    });
    controller.onStart();
    controller.onSettle(10, true, 'step'); // one fast sample seeds rttLong≈10
    fill(controller, 19, 100); // p50≈100 → gradient≈0.1 < 0.7 → shrink
    controller.tick();
    expect(controller.limit).toBeLessThan(8);
    expect(controller.snapshot().lastAdjust?.reason).toBe('shrink');
    expect(applied[0]).toBe(controller.limit);
  });

  it('hard-brakes on RAM when rssPct ≥ ramCeilingPct', () => {
    const { controller } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 10, start: 5 },
      rss: 950_000_000,
      memLimit: 1_000_000_000, // 95% ≥ 85
    });
    fill(controller, 20, 100);
    controller.tick();
    expect(controller.limit).toBe(4); // floor(5*0.8)
    expect(controller.snapshot().lastAdjust?.reason).toBe('ram_ceiling');
  });

  it('sheds on backpressure when the error rate is high', () => {
    const { controller } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 10, start: 5 },
    });
    fill(controller, 20, 100, 0.5); // 50% errors > 20%
    controller.tick();
    expect(controller.limit).toBe(4);
    expect(controller.snapshot().lastAdjust?.reason).toBe('backpressure');
  });

  it('workflow-turn settlements do NOT enter the measurement window or move the limit', () => {
    const { controller, applied } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 10, start: 4 },
    });
    // A burst of WORKFLOW turns: wildly varying (gradient-corrupting) durations, all settled.
    for (const d of [5, 2000, 3, 1500, 7, 1800, 4]) {
      controller.onStart();
      controller.onSettle(d, true, 'workflow');
    }
    // None of those reached the window → no throughput/p95 measured, and a tick can't grow/shrink.
    const snap = controller.snapshot();
    expect(snap.p95Ms).toBeUndefined();
    expect(snap.throughputPerMin).toBeUndefined();
    expect(snap.inFlight).toBe(0); // every turn still decremented in-flight
    controller.tick();
    expect(controller.limit).toBe(4);
    expect(applied).toEqual([]);

    // STEP settlements DO populate the window — proving the gate is kind-based, not a no-op.
    fill(controller, 10, 100);
    const afterSteps = controller.snapshot();
    expect(afterSteps.p95Ms).toBe(100);
    expect(afterSteps.throughputPerMin).toBeGreaterThan(0);
  });

  it('a workflow burst keeps the worker off the stall path (turns are forward progress)', () => {
    const { controller } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 10, start: 4 },
    });
    // In-flight step work that never settles, but workflow turns keep completing each tick.
    controller.onStart();
    for (let tick = 0; tick < 3; tick++) {
      controller.onStart();
      controller.onSettle(5, true, 'workflow');
      controller.tick();
    }
    // completionsThisTick saw the turns → not stalled → no backpressure shrink from the stall path.
    expect(controller.snapshot().lastAdjust?.reason).not.toBe('backpressure');
  });

  it('never adjusts in fixed mode, but still tracks the window', () => {
    const { controller, applied } = makeController({ concurrency: 5 });
    fill(controller, 20, 100);
    for (let i = 0; i < 5; i++) controller.onStart();
    controller.tick();
    expect(controller.limit).toBe(5);
    expect(applied).toEqual([]);
    expect(controller.snapshot().lastAdjust).toBeUndefined();
  });
});

describe('AdaptiveController.snapshot — throughput decays when idle', () => {
  it('reads 0 once a minute passes with no completion, and recovers on new work', () => {
    let now = 1_000_000;
    const { controller } = makeController({ concurrency: 4, now: () => now });
    for (let i = 0; i < 10; i++) {
      controller.onStart();
      controller.onSettle(100, true, 'step');
      now += 1_000;
    }
    // 10 completions over the last 10s → 60/min.
    expect(controller.snapshot().throughputPerMin).toBeCloseTo(60);

    now += 61_000;
    const idle = controller.snapshot();
    expect(idle.throughputPerMin).toBe(0);
    // p95 still describes the last window of work.
    expect(idle.p95Ms).toBe(100);

    controller.onStart();
    controller.onSettle(100, true, 'step');
    expect(controller.snapshot().throughputPerMin).toBeGreaterThan(0);
  });

  it('decays while idle inside the minute', () => {
    let now = 1_000_000;
    const { controller } = makeController({ concurrency: 4, now: () => now });
    for (let i = 0; i < 10; i++) {
      controller.onStart();
      controller.onSettle(100, true, 'step');
      now += 1_000;
    }
    const busy = controller.snapshot().throughputPerMin ?? 0;
    now += 30_000;
    const quieter = controller.snapshot().throughputPerMin ?? 0;
    expect(quieter).toBeLessThan(busy);
    expect(quieter).toBeCloseTo(15); // 10 completions over the trailing 40s
  });

  it('counts only the trailing minute when the window reaches further back', () => {
    let now = 1_000_000;
    const { controller } = makeController({ concurrency: 4, now: () => now });
    for (let i = 0; i < 20; i++) {
      controller.onStart();
      controller.onSettle(100, true, 'step');
      now += 10_000; // one every 10s, window spans 200s
    }
    // 6 of the 20 completed within the last minute.
    expect(controller.snapshot().throughputPerMin).toBeCloseTo(6);
  });
});

describe('AdaptiveController.start — the control loop runs only in adaptive mode', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fixed mode schedules no timer and never ticks', () => {
    vi.useFakeTimers();
    const { controller } = makeController({ concurrency: 5 });
    const tick = vi.spyOn(controller, 'tick');
    controller.start();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(tick).not.toHaveBeenCalled();
    expect(controller.snapshot().concurrency).toEqual({ mode: 'fixed', limit: 5 });
    controller.stop();
  });

  it('adaptive mode schedules its loop every tickMs', () => {
    vi.useFakeTimers();
    const { controller } = makeController({
      concurrency: { mode: 'adaptive', min: 1, max: 4, tickMs: 1_000 },
    });
    const tick = vi.spyOn(controller, 'tick');
    controller.start();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3_000);
    expect(tick).toHaveBeenCalledTimes(3);
    controller.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fixed mode still reports cpuPct, sampled by the snapshot over its own elapsed time', () => {
    let now = 1_000_000;
    const cpu = fakeCpu();
    const { controller } = makeController({
      concurrency: 2,
      now: () => now,
      readCpuUsage: cpu.read,
      readCpuCount: () => 2,
    });
    controller.start();
    expect(controller.snapshot().cpuPct).toBeUndefined();
    now += 4_000;
    cpu.spend(2_000); // 2s of CPU over 4s on 2 cores → 25%
    expect(controller.snapshot().cpuPct).toBeCloseTo(25);
    // A back-to-back snapshot keeps the last reading instead of sampling a near-zero span.
    now += 10;
    cpu.spend(10);
    expect(controller.snapshot().cpuPct).toBeCloseTo(25);
  });
});

describe('AdaptiveController.tick — CPU ceiling', () => {
  function saturatedAtCpu(pct: number) {
    const cpu = fakeCpu();
    const { controller, applied } = makeController({
      concurrency: {
        mode: 'adaptive',
        min: 1,
        max: 10,
        start: 4,
        cpuCeilingPct: 80,
        tickMs: 1_000,
      },
      readCpuUsage: cpu.read,
      readCpuCount: () => 2,
    });
    controller.start();
    fill(controller, 20, 100); // healthy gradient
    for (let i = 0; i < 4; i++) controller.onStart(); // saturated → would otherwise grow
    cpu.spend((pct / 100) * 1_000 * 2); // pct of 2 cores over one 1s tick
    controller.tick();
    controller.stop();
    return { controller, applied };
  }

  it('sheds one with reason cpu_ceiling when CPU is at or over the ceiling', () => {
    const { controller, applied } = saturatedAtCpu(95);
    expect(controller.snapshot().cpuPct).toBeCloseTo(95);
    expect(controller.limit).toBe(3);
    expect(applied).toEqual([3]);
    expect(controller.snapshot().lastAdjust?.reason).toBe('cpu_ceiling');
  });

  it('grows as usual when CPU is under the ceiling', () => {
    const { controller } = saturatedAtCpu(25);
    expect(controller.snapshot().cpuPct).toBeCloseTo(25);
    expect(controller.limit).toBe(8);
    expect(controller.snapshot().lastAdjust?.reason).toBe('grow');
  });

  it('a non-finite core count falls back to one core', () => {
    const cpu = fakeCpu();
    const { controller } = makeController({
      concurrency: { mode: 'adaptive', tickMs: 1_000 },
      readCpuUsage: cpu.read,
      readCpuCount: () => Number.NaN,
    });
    controller.start();
    cpu.spend(500);
    controller.tick();
    controller.stop();
    expect(controller.snapshot().cpuPct).toBeCloseTo(50);
  });
});
