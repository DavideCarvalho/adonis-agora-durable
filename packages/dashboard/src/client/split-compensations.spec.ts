import { describe, expect, it } from 'vitest';
import type { StepCheckpoint } from './durable-client.js';
import {
  compensationDisplayName,
  compensationSummary,
  splitCompensations,
} from './split-compensations.js';

function step(over: Partial<StepCheckpoint> = {}): StepCheckpoint {
  return {
    runId: 'r1',
    seq: 0,
    name: 'processing',
    kind: 'remote',
    status: 'completed',
    attempts: 1,
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('splitCompensations', () => {
  it('a timeline with no compensations returns everything as body, unchanged order', () => {
    const timeline = [step({ seq: 0 }), step({ seq: 1 })];
    const { body, compensations } = splitCompensations(timeline);
    expect(body).toEqual(timeline);
    expect(compensations).toEqual([]);
  });

  it('splits negative-seq checkpoints out of the body', () => {
    const bodyStep0 = step({ seq: 0, name: 'charge' });
    const bodyStep1 = step({ seq: 1, name: 'ship' });
    const comp1 = step({ seq: -1, name: 'compensate:ship' });
    const timeline = [bodyStep0, bodyStep1, comp1];
    const { body, compensations } = splitCompensations(timeline);
    expect(body).toEqual([bodyStep0, bodyStep1]);
    expect(compensations).toEqual([comp1]);
  });

  it('sorts compensations descending by seq so -1 (ran first) leads — unwind order', () => {
    const comp1 = step({ seq: -1, name: 'compensate:ship' });
    const comp2 = step({ seq: -2, name: 'compensate:charge' });
    // Stored in arbitrary order — the split must reorder to unwind order regardless.
    const { compensations } = splitCompensations([comp2, comp1]);
    expect(compensations).toEqual([comp1, comp2]);
  });

  it('body keeps its original relative order untouched', () => {
    const stepA = step({ seq: 2, name: 'c' });
    const stepB = step({ seq: 0, name: 'a' });
    const { body } = splitCompensations([stepA, stepB]);
    expect(body).toEqual([stepA, stepB]); // NOT re-sorted by seq
  });
});

describe('compensationSummary', () => {
  it('tallies completed/failed/in-flight compensations', () => {
    const compensations = [
      step({ seq: -1, status: 'completed' }),
      step({ seq: -2, status: 'failed' }),
      step({ seq: -3, status: 'pending' }),
      step({ seq: -4, status: 'running' }),
    ];
    expect(compensationSummary(compensations)).toEqual({
      total: 4,
      done: 1,
      failed: 1,
      pending: 2,
    });
  });

  it('an empty list summarizes to all zeros', () => {
    expect(compensationSummary([])).toEqual({ total: 0, done: 0, failed: 0, pending: 0 });
  });
});

describe('compensationDisplayName', () => {
  it('strips the compensate: prefix', () => {
    expect(compensationDisplayName('compensate:chargeCard')).toBe('chargeCard');
  });

  it('passes non-prefixed names through unchanged', () => {
    expect(compensationDisplayName('chargeCard')).toBe('chargeCard');
  });
});
