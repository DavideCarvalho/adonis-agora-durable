import { describe, expect, it } from 'vitest';
import {
  type RunDetail,
  type StepCheckpoint,
  type StepEvent,
  type WorkflowRun,
} from './durable-client.js';
import { mergeLiveEvents } from './merge-live-events.js';

const RUN: WorkflowRun = {
  id: 'r1',
  workflow: 'pipeline',
  workflowVersion: '1',
  status: 'running',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function step(over: Partial<StepCheckpoint> = {}): StepCheckpoint {
  return {
    runId: 'r1',
    seq: 0,
    name: 'processing',
    kind: 'local',
    status: 'running',
    attempts: 1,
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const ev = (n: number): StepEvent => ({ at: n }) as StepEvent;
const detail = (timeline: StepCheckpoint[]): RunDetail => ({ run: RUN, timeline });

describe('mergeLiveEvents', () => {
  it('returns the fresh run untouched when there is no prior cache', () => {
    const fresh = detail([step()]);
    expect(mergeLiveEvents(undefined, fresh)).toBe(fresh);
  });

  it('keeps the streamed events for an in-flight step the refetch returns empty', () => {
    const prev = detail([step({ status: 'running', events: [ev(1), ev(2)] })]);
    const fresh = detail([step({ status: 'running', events: [] })]); // store has none until completion
    const merged = mergeLiveEvents(prev, fresh);
    expect(merged.timeline[0]?.events).toEqual([ev(1), ev(2)]); // not wiped → no flicker
  });

  it('uses the authoritative fetched events once the step has completed', () => {
    const prev = detail([step({ status: 'running', events: [ev(1), ev(2)] })]);
    const fresh = detail([step({ status: 'completed', events: [ev(1), ev(2), ev(3)] })]);
    expect(mergeLiveEvents(prev, fresh).timeline[0]?.events).toEqual([ev(1), ev(2), ev(3)]);
  });

  it('does not resurrect streamed events onto a completed step the store reports as empty', () => {
    const prev = detail([step({ status: 'running', events: [ev(1)] })]);
    const fresh = detail([step({ status: 'completed', events: [] })]); // genuinely emitted nothing
    expect(mergeLiveEvents(prev, fresh).timeline[0]?.events).toEqual([]);
  });

  it('lets a fetch that already carries events win over the cache', () => {
    const prev = detail([step({ status: 'running', events: [ev(1)] })]);
    const fresh = detail([step({ status: 'running', events: [ev(9)] })]);
    expect(mergeLiveEvents(prev, fresh).timeline[0]?.events).toEqual([ev(9)]);
  });

  it('matches steps by seq, not position', () => {
    const prev = detail([
      step({ seq: 0, status: 'completed', events: [ev(1)] }),
      step({ seq: 1, status: 'running', events: [ev(7), ev(8)] }),
    ]);
    const fresh = detail([
      step({ seq: 1, status: 'running', events: [] }),
      step({ seq: 0, status: 'completed', events: [ev(1)] }),
    ]);
    const bySeq = new Map(mergeLiveEvents(prev, fresh).timeline.map((s) => [s.seq, s.events]));
    expect(bySeq.get(1)).toEqual([ev(7), ev(8)]); // preserved despite reordering
  });
});
