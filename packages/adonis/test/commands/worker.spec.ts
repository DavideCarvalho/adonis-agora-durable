import { describe, expect, it } from 'vitest';
import {
  mergeSchedules,
  runTick,
  runWorkerLoop,
  type WorkerLogger,
} from '../../src/commands/worker.js';
import {
  InMemoryStateStore,
  InMemoryTransport,
  type ScheduledWorkflow,
  WorkflowEngine,
} from '../../src/index.js';

function makeEngine() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
  return { store, engine };
}

function captureLogger(): WorkerLogger & { infos: string[]; errors: string[] } {
  const infos: string[] = [];
  const errors: string[] = [];
  return { infos, errors, info: (m) => infos.push(m), error: (m) => errors.push(m) };
}

describe('runTick', () => {
  it('returns zero counts and no errors on an idle engine', async () => {
    const { engine } = makeEngine();
    const result = await runTick(engine);
    expect(result).toMatchObject({ pending: 0, recovered: 0, timers: 0 });
    expect(result.errors).toHaveLength(0);
  });

  it('collects a phase error instead of throwing', async () => {
    const { engine } = makeEngine();
    // Make one phase throw; the tick must still complete and record the error.
    (engine as unknown as { runPending: () => Promise<never> }).runPending = () => {
      throw new Error('boom');
    };
    const result = await runTick(engine);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.phase).toBe('runPending');
    expect(result.errors[0]?.error.message).toBe('boom');
  });

  it('invokes every engine phase exactly once per tick', async () => {
    const { engine } = makeEngine();
    const calls: string[] = [];
    const spy = (name: string) => {
      (engine as unknown as Record<string, unknown>)[name] = async () => {
        calls.push(name);
        return name === 'sweepTimeouts' ? undefined : [];
      };
    };
    for (const m of ['runPending', 'recoverIncomplete', 'resumeDueTimers', 'sweepTimeouts']) {
      spy(m);
    }
    await runTick(engine);
    expect(calls).toEqual(['runPending', 'recoverIncomplete', 'resumeDueTimers', 'sweepTimeouts']);
  });

  it('fires a DUE schedule through the tick (the 5th phase) and dispatches a run', async () => {
    const { engine, store } = makeEngine();
    engine.register('cache-sync', '1', async () => 'synced');
    const schedules: ScheduledWorkflow[] = [
      { key: 'cache-sync', workflow: 'cache-sync', everyMs: 60_000 },
    ];
    const now = 120_000; // bucket = floor(120000 / 60000) = 2 → run id sched:cache-sync:2
    const result = await runTick(engine, { schedules, now });
    expect(result.scheduled).toBe(1);
    expect(result.errors).toHaveLength(0);
    const run = await engine.waitForRun('sched:cache-sync:2');
    expect(run.status).toBe('completed');
    expect(await store.getRun('sched:cache-sync:2')).not.toBeNull();
  });

  it('skips the schedules phase entirely when none are registered', async () => {
    const { engine } = makeEngine();
    const result = await runTick(engine);
    expect(result.scheduled).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('starts each schedule window exactly once across repeated ticks (idempotent)', async () => {
    const { engine } = makeEngine();
    let runs = 0;
    engine.register('hourly', '1', async () => {
      runs += 1;
      return runs;
    });
    const schedules: ScheduledWorkflow[] = [{ key: 'hourly', workflow: 'hourly', everyMs: 60_000 }];
    const now = 120_000; // same window across both ticks
    await runTick(engine, { schedules, now });
    await runTick(engine, { schedules, now });
    await engine.waitForRun('sched:hourly:2');
    expect(runs).toBe(1);
  });
});

describe('mergeSchedules (config + colocated `static schedule`)', () => {
  it('concatenates config schedules with disjoint colocated ones', () => {
    const config: ScheduledWorkflow[] = [{ key: 'a', workflow: 'a', everyMs: 1000 }];
    const discovered: ScheduledWorkflow[] = [{ key: 'b', workflow: 'b', cron: '0 4 * * *' }];
    expect(mergeSchedules(config, discovered)).toEqual([
      { key: 'a', workflow: 'a', everyMs: 1000 },
      { key: 'b', workflow: 'b', cron: '0 4 * * *' },
    ]);
  });

  it('config WINS on a key collision — the colocated schedule is dropped', () => {
    const config: ScheduledWorkflow[] = [{ key: 'report', workflow: 'report', everyMs: 5000 }];
    const discovered: ScheduledWorkflow[] = [
      { key: 'report', workflow: 'report', cron: '0 4 * * *', timezone: 'America/Sao_Paulo' },
    ];
    expect(mergeSchedules(config, discovered)).toEqual([
      { key: 'report', workflow: 'report', everyMs: 5000 },
    ]);
  });

  it('returns colocated schedules alone when config has none', () => {
    const discovered: ScheduledWorkflow[] = [{ key: 'b', workflow: 'b', everyMs: 1000 }];
    expect(mergeSchedules([], discovered)).toEqual(discovered);
  });
});

describe('runWorkerLoop', () => {
  it('ticks until the stop signal resolves, then drains', async () => {
    const { engine } = makeEngine();
    const logger = captureLogger();
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      stop = resolve;
    });
    // Stop after two sleeps so the loop runs ~2 ticks.
    let sleeps = 0;
    const sleep = async (): Promise<void> => {
      sleeps += 1;
      if (sleeps >= 2) stop();
    };
    const ticks = await runWorkerLoop(engine, {
      intervalMs: 5,
      stopSignal,
      logger,
      drainTimeoutMs: 50,
      sleep,
    });
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(logger.infos.some((m) => m.includes('worker stopped'))).toBe(true);
  });

  it('actually advances real runs across ticks', async () => {
    const { engine, store } = makeEngine();
    engine.register('checkout', '1', async (ctx) => {
      await ctx.localStep('reserve', async () => 1);
      return 'ok';
    });
    // Enqueue a run with a no-op dispatch path by creating it pending, then let the loop pick it up.
    await engine.start('checkout', {}, 'run1');
    const logger = captureLogger();
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      stop = resolve;
    });
    let sleeps = 0;
    const sleep = async (): Promise<void> => {
      sleeps += 1;
      if (sleeps >= 3) stop();
    };
    await runWorkerLoop(engine, { intervalMs: 1, stopSignal, logger, drainTimeoutMs: 50, sleep });
    // The default in-process dispatcher may have already run it; either way it must be settled.
    const run = await store.getRun('run1');
    expect(run?.status).toBe('completed');
  });

  it('fires configured schedules from the loop', async () => {
    const { engine, store } = makeEngine();
    let runs = 0;
    engine.register('cache-sync', '1', async () => {
      runs += 1;
      return 'ok';
    });
    const schedules: ScheduledWorkflow[] = [
      { key: 'cache-sync', workflow: 'cache-sync', everyMs: 60_000 },
    ];
    const logger = captureLogger();
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      stop = resolve;
    });
    let sleeps = 0;
    const sleep = async (): Promise<void> => {
      sleeps += 1;
      if (sleeps >= 2) stop();
    };
    await runWorkerLoop(engine, {
      intervalMs: 1,
      stopSignal,
      logger,
      drainTimeoutMs: 50,
      sleep,
      schedules,
    });
    // The loop must have started the current window's run (and only once across both ticks).
    expect(runs).toBe(1);
    const ids = (await store.listRuns({})).map((r) => r.id);
    expect(ids.some((id) => id.startsWith('sched:cache-sync:'))).toBe(true);
  });
});
