import { describe, expect, it } from 'vitest';
import type { StepEvent } from './durable-client.js';
import { groupSubProcesses } from './group-subprocesses.js';

function ev(over: Partial<StepEvent> = {}): StepEvent {
  return { at: 0, level: 'info', message: '', ...over };
}

describe('groupSubProcesses', () => {
  it('back-compat: a terminal-only event (sub) becomes one sub with no phases', () => {
    const { subs, stepLogs } = groupSubProcesses([
      ev({ at: 5, name: 'ProcessKpi', status: 'ok', message: 'ProcessKpi' }),
    ]);
    expect(stepLogs).toEqual([]);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ id: 'ProcessKpi', name: 'ProcessKpi', status: 'ok' });
    expect(subs[0]?.phases).toEqual([]);
    expect(subs[0]?.durationMs).toBeUndefined();
  });

  it('distinct subIds with the same name do NOT collapse', () => {
    const { subs } = groupSubProcesses([
      ev({ at: 1, subId: 'a', name: 'ProcessKpi', status: 'ok' }),
      ev({ at: 2, subId: 'b', name: 'ProcessKpi', status: 'ok' }),
    ]);
    expect(subs.map((s) => s.id)).toEqual(['a', 'b']);
    expect(subs).toHaveLength(2);
  });

  it('groups phases, logs and terminal under one subId; derives duration and startedAt', () => {
    const { subs } = groupSubProcesses([
      ev({ at: 100, subId: 'r1', name: 'ProcessKpi', group: 'af_fleet', phase: 'triggered' }),
      ev({ at: 120, subId: 'r1', level: 'debug', message: 'Querying MCR data' }),
      ev({ at: 150, subId: 'r1', name: 'ProcessKpi', phase: 'processing' }),
      ev({ at: 964, subId: 'r1', name: 'ProcessKpi', status: 'ok' }),
    ]);
    expect(subs).toHaveLength(1);
    const s = subs[0];
    expect(s).toMatchObject({ id: 'r1', name: 'ProcessKpi', group: 'af_fleet', status: 'ok' });
    expect(s?.phases.map((p) => p.phase)).toEqual(['triggered', 'processing']);
    expect(s?.logs.map((l) => l.message)).toEqual(['Querying MCR data']);
    expect(s?.startedAt).toBe(100);
    expect(s?.durationMs).toBe(864); // 964 - 100
  });

  it('data.durationMs on the terminal overrides the derived duration', () => {
    const { subs } = groupSubProcesses([
      ev({ at: 100, subId: 'r1', name: 'P', phase: 'processing' }),
      ev({ at: 999, subId: 'r1', name: 'P', status: 'ok', data: { durationMs: 42 } }),
    ]);
    expect(subs[0]?.durationMs).toBe(42);
  });

  it('a log line with no owner is a step-level log', () => {
    const { subs, stepLogs } = groupSubProcesses([
      ev({ at: 1, level: 'info', message: 'step started' }),
    ]);
    expect(subs).toEqual([]);
    expect(stepLogs.map((l) => l.message)).toEqual(['step started']);
  });

  it('legacy `process`-tagged logs group under a name-keyed sub', () => {
    const { subs } = groupSubProcesses([
      ev({ at: 1, name: 'ProcessKpi', status: 'ok' }),
      ev({ at: 2, level: 'debug', message: 'old log', process: 'ProcessKpi' }),
    ]);
    expect(subs).toHaveLength(1);
    expect(subs[0]?.logs.map((l) => l.message)).toEqual(['old log']);
  });

  it('a sub with no terminal keeps startedAt but leaves status/durationMs undefined', () => {
    const { subs } = groupSubProcesses([
      ev({ at: 200, subId: 'r1', name: 'P', phase: 'processing' }),
      ev({ at: 250, subId: 'r1', level: 'debug', message: 'working' }),
    ]);
    expect(subs).toHaveLength(1);
    expect(subs[0]?.status).toBeUndefined();
    expect(subs[0]?.terminal).toBeUndefined();
    expect(subs[0]?.startedAt).toBe(200);
    expect(subs[0]?.durationMs).toBeUndefined();
  });
});
