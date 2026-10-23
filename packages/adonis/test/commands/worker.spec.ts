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
  type LazyWorkflowImport,
  resolveSchedules,
  type ScheduledWorkflow,
  WorkflowEngine,
} from '../../src/index.js';

class ReportWorkflow {
  static workflow = { name: 'report' };
  async run(_ctx: unknown, input: { region: string }) {
    return `report for ${input.region}`;
  }
}

class NotAWorkflow {
  async run() {
    return 'never';
  }
}

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

  it('fires a schedule that names its workflow by class', async () => {
    const { engine, store } = makeEngine();
    engine.register(
      'report',
      '1',
      async (_ctx, input) => `report for ${(input as { region: string }).region}`,
    );
    const report: ScheduledWorkflow<typeof ReportWorkflow> = {
      key: 'report',
      workflow: ReportWorkflow,
      input: { region: 'eu' },
      everyMs: 60_000,
    };
    const result = await runTick(engine, { schedules: [report], now: 120_000 });

    expect(result.errors).toHaveLength(0);
    await engine.waitForRun('sched:report:2');
    expect(await store.getRun('sched:report:2')).toMatchObject({
      workflow: 'report',
      output: 'report for eu',
    });
    const [listed] = await engine.listSchedules(120_000);
    expect(listed?.workflow).toBe('report');
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

  it('resolves a config schedule that names its workflow by class', () => {
    expect(
      mergeSchedules(
        [{ key: 'r', workflow: ReportWorkflow, input: { region: 'eu' }, everyMs: 1000 }],
        [],
      ),
    ).toEqual([{ key: 'r', workflow: 'report', input: { region: 'eu' }, everyMs: 1000 }]);
  });

  it('throws for a class that is not a workflow, so the worker fails to start', () => {
    expect(() => mergeSchedules([{ key: 'n', workflow: NotAWorkflow, everyMs: 1000 }], [])).toThrow(
      'workflow class NotAWorkflow has no registered name',
    );
  });

  it('types input against the class run when the schedule is annotated', () => {
    const wrong: ScheduledWorkflow<typeof ReportWorkflow> = {
      key: 'r',
      workflow: ReportWorkflow,
      // @ts-expect-error `input` is checked against ReportWorkflow.run's input
      input: { region: 1 },
      everyMs: 1000,
    };
    // An annotated schedule still fits the plain list config.schedules takes.
    const list: ScheduledWorkflow[] = [wrong, { key: 'b', workflow: 'b', everyMs: 1000 }];
    expect(list).toHaveLength(2);
  });

  it('refuses a lazy import that has not been through resolveSchedules', () => {
    const lazy = () => Promise.resolve({ default: ReportWorkflow });
    expect(() => mergeSchedules([{ key: 'r', workflow: lazy, everyMs: 1000 }], [])).toThrow(
      'resolve the list with resolveSchedules() first',
    );
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

describe('resolveSchedules (lazy `() => import(...)` in config.schedules)', () => {
  it('calls the lazy import and resolves the default export to its registered name', async () => {
    let imported = 0;
    const lazy: LazyWorkflowImport<typeof ReportWorkflow> = async () => {
      imported += 1;
      return { default: ReportWorkflow };
    };
    const report: ScheduledWorkflow<typeof lazy> = {
      key: 'r',
      workflow: lazy,
      input: { region: 'eu' },
      everyMs: 1000,
    };

    expect(imported).toBe(0); // declaring the schedule imports nothing
    expect(await resolveSchedules([report, { key: 'b', workflow: 'b', everyMs: 1000 }])).toEqual([
      { key: 'r', workflow: 'report', input: { region: 'eu' }, everyMs: 1000 },
      { key: 'b', workflow: 'b', everyMs: 1000 },
    ]);
    expect(imported).toBe(1);
  });

  it('resolves a real dynamic import of a workflow module', async () => {
    const [resolved] = await resolveSchedules([
      { key: 'f', workflow: () => import('../fixtures/scheduled_workflow.js'), everyMs: 1000 },
    ]);
    expect(resolved?.workflow).toBe('fixture-scheduled');
  });

  it('types input against the lazily imported class', () => {
    const wrong: ScheduledWorkflow<LazyWorkflowImport<typeof ReportWorkflow>> = {
      key: 'r',
      workflow: async () => ({ default: ReportWorkflow }),
      // @ts-expect-error `input` is checked against ReportWorkflow.run's input
      input: { region: 1 },
      everyMs: 1000,
    };
    expect(wrong.key).toBe('r');
  });

  it('throws for a module without a default export, so the worker fails to start', async () => {
    const noDefault = (async () => ({})) as unknown as LazyWorkflowImport;
    await expect(
      resolveSchedules([{ key: 'x', workflow: noDefault, everyMs: 1000 }]),
    ).rejects.toThrow('schedule "x": the lazily imported module has no default export');
  });

  it('throws for a default export that is not a workflow', async () => {
    await expect(
      resolveSchedules([
        { key: 'n', workflow: async () => ({ default: NotAWorkflow }), everyMs: 1000 },
      ]),
    ).rejects.toThrow('workflow class NotAWorkflow has no registered name');
  });
});
