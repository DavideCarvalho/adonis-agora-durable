import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { runSchedules, type ScheduledWorkflow } from '../../src/scheduler.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

function makeEngine(nowMs: () => number): WorkflowEngine {
  const transport = new InMemoryTransport();
  // The same InMemoryTransport doubles as the control plane (its publishControl broadcasts).
  const engine = new WorkflowEngine({
    store: new InMemoryStateStore(),
    transport,
    controlPlane: transport,
    clock: nowMs,
  });
  engine.register('report', '1', async () => 'done');
  return engine;
}

const SCHEDULES: ScheduledWorkflow[] = [{ key: 'hourly-report', workflow: 'report', everyMs: 100 }];

describe('runtime schedule control', () => {
  it('lists schedules with effective pause state and fire windows', async () => {
    let nowMs = 1_000;
    const engine = makeEngine(() => nowMs);
    engine.adoptSchedules(SCHEDULES);

    const [row] = await engine.listSchedules();
    expect(row?.key).toBe('hourly-report');
    expect(row?.paused).toBe(false);
    expect(row?.lastFireAt).toBe(1_000);
    expect(row?.nextFireAt).toBe(1_100);
    expect(row?.currentWindowRunId).toBe('sched:hourly-report:10');
    expect(row?.lastRunStatus).toBeUndefined(); // window not fired yet

    engine.setSchedulePaused('hourly-report', true);
    const [paused] = await engine.listSchedules();
    expect(paused?.paused).toBe(true);
    expect(paused?.pausedAtRuntime).toBe(true);
    nowMs += 1;
  });

  it('a runtime pause stops the tick from firing; resume restores it — and overrides config pause', async () => {
    let nowMs = 1_000;
    const engine = makeEngine(() => nowMs);
    engine.adoptSchedules(SCHEDULES);

    engine.setSchedulePaused('hourly-report', true);
    expect(await runSchedules(engine, SCHEDULES, nowMs)).toEqual([]);

    engine.setSchedulePaused('hourly-report', false);
    expect(await runSchedules(engine, SCHEDULES, nowMs)).toEqual(['sched:hourly-report:10']);

    // A CONFIG-paused schedule can be resumed at runtime (the override wins until redeploy).
    const configPaused: ScheduledWorkflow[] = [
      { key: 'cfg-paused', workflow: 'report', everyMs: 100, paused: true },
    ];
    engine.adoptSchedules(configPaused);
    nowMs = 2_000;
    expect(await runSchedules(engine, configPaused, nowMs)).toEqual([]);
    engine.setSchedulePaused('cfg-paused', false);
    expect(await runSchedules(engine, configPaused, nowMs)).toEqual(['sched:cfg-paused:20']);
  });

  it('setSchedulePaused returns false for an unknown key', () => {
    const engine = makeEngine(() => 1_000);
    engine.adoptSchedules(SCHEDULES);
    expect(engine.setSchedulePaused('nope', true)).toBe(false);
  });

  it('triggerSchedule fires the current window now, idempotently', async () => {
    let nowMs = 1_000;
    const engine = makeEngine(() => nowMs);
    engine.adoptSchedules(SCHEDULES);

    const first = await engine.triggerSchedule('hourly-report');
    expect(first?.runId).toBe('sched:hourly-report:10');
    await flush();
    // Triggering the same window again converges on the existing run (no duplicate).
    const again = await engine.triggerSchedule('hourly-report');
    expect(again?.runId).toBe('sched:hourly-report:10');
    expect(again?.status).toBe('completed');
    expect(await engine.triggerSchedule('nope')).toBeNull();
    nowMs += 1;
  });
});
