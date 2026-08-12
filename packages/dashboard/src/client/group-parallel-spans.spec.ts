import { describe, expect, it } from 'vitest';
import type { StepCheckpoint } from './durable-client.js';
import { groupParallelSpans } from './group-parallel-spans.js';

function cp(over: Partial<StepCheckpoint> = {}): StepCheckpoint {
  return {
    runId: 'r1',
    seq: 0,
    name: 'step',
    kind: 'local',
    status: 'completed',
    attempts: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    ...over,
  };
}

describe('groupParallelSpans', () => {
  it('collapses a setup + 7 same-group steps + trailing into [single, fan(7), single]', () => {
    const timeline = [
      cp({ seq: 0, name: 'setup' }),
      ...Array.from({ length: 7 }, (_, k) =>
        cp({ seq: k + 1, name: `handle_${k}`, parallelGroup: 'gather:1' }),
      ),
      cp({ seq: 8, name: 'finalize' }),
    ];
    const nodes = groupParallelSpans(timeline);
    expect(nodes.map((n) => n.kind)).toEqual(['single', 'fan', 'single']);
    expect(nodes[0]).toMatchObject({ kind: 'single', step: { name: 'setup' } });
    const fan = nodes[1];
    expect(fan?.kind).toBe('fan');
    if (fan?.kind === 'fan') {
      expect(fan.group).toBe('gather:1');
      expect(fan.steps).toHaveLength(7);
      expect(fan.label).toBe('handle ×7');
    }
    expect(nodes[2]).toMatchObject({ kind: 'single', step: { name: 'finalize' } });
  });

  it('label derives from names, not the group prefix (all: prefix is cosmetic)', () => {
    const nodes = groupParallelSpans([
      cp({ seq: 0, name: 'fetchUser', parallelGroup: 'all:0' }),
      cp({ seq: 1, name: 'fetchOrders', parallelGroup: 'all:0' }),
    ]);
    const fan = nodes[0];
    expect(fan?.kind).toBe('fan');
    if (fan?.kind === 'fan') expect(fan.label).toBe('fetch ×2');
  });

  it('falls back to "parallel" when names share no common prefix', () => {
    const nodes = groupParallelSpans([
      cp({ seq: 0, name: 'alpha', parallelGroup: 'g' }),
      cp({ seq: 1, name: 'beta', parallelGroup: 'g' }),
    ]);
    const fan = nodes[0];
    if (fan?.kind === 'fan') expect(fan.label).toBe('parallel ×2');
  });

  it('steps with no parallelGroup all stay single (unchanged order)', () => {
    const timeline = [
      cp({ seq: 0, name: 'a' }),
      cp({ seq: 1, name: 'b' }),
      cp({ seq: 2, name: 'c' }),
    ];
    const nodes = groupParallelSpans(timeline);
    expect(nodes.map((n) => n.kind)).toEqual(['single', 'single', 'single']);
    expect(nodes.map((n) => (n.kind === 'single' ? n.step.name : '_'))).toEqual(['a', 'b', 'c']);
  });

  it('two DIFFERENT parallelGroups do not merge', () => {
    const nodes = groupParallelSpans([
      cp({ seq: 0, name: 'x1', parallelGroup: 'gather:1' }),
      cp({ seq: 1, name: 'x2', parallelGroup: 'gather:1' }),
      cp({ seq: 2, name: 'y1', parallelGroup: 'gather:2' }),
      cp({ seq: 3, name: 'y2', parallelGroup: 'gather:2' }),
    ]);
    expect(nodes.map((n) => n.kind)).toEqual(['fan', 'fan']);
    if (nodes[0]?.kind === 'fan') expect(nodes[0].group).toBe('gather:1');
    if (nodes[1]?.kind === 'fan') expect(nodes[1].group).toBe('gather:2');
  });

  it('a single-member group stays single, not a fan', () => {
    const nodes = groupParallelSpans([
      cp({ seq: 0, name: 'lonely', parallelGroup: 'gather:9' }),
      cp({ seq: 1, name: 'after' }),
    ]);
    expect(nodes.map((n) => n.kind)).toEqual(['single', 'single']);
    expect(nodes[0]).toMatchObject({ kind: 'single', step: { name: 'lonely' } });
  });

  it('an empty-string parallelGroup is treated as no group', () => {
    const nodes = groupParallelSpans([
      cp({ seq: 0, name: 'a', parallelGroup: '' }),
      cp({ seq: 1, name: 'b', parallelGroup: '' }),
    ]);
    expect(nodes.map((n) => n.kind)).toEqual(['single', 'single']);
  });

  it('preserves position: fan sits where its first member was', () => {
    const nodes = groupParallelSpans([
      cp({ seq: 0, name: 'pre' }),
      cp({ seq: 1, name: 'p_a', parallelGroup: 'g' }),
      cp({ seq: 2, name: 'p_b', parallelGroup: 'g' }),
      cp({ seq: 3, name: 'mid' }),
      cp({ seq: 4, name: 'q_a', parallelGroup: 'h' }),
      cp({ seq: 5, name: 'q_b', parallelGroup: 'h' }),
      cp({ seq: 6, name: 'post' }),
    ]);
    expect(nodes.map((n) => n.kind)).toEqual(['single', 'fan', 'single', 'fan', 'single']);
  });

  it('returns [] for an empty timeline', () => {
    expect(groupParallelSpans([])).toEqual([]);
  });

  it('handles a fan as the very last node (no trailing single)', () => {
    const nodes = groupParallelSpans([
      cp({ seq: 0, name: 'setup' }),
      cp({ seq: 1, name: 'handle_a', parallelGroup: 'g' }),
      cp({ seq: 2, name: 'handle_b', parallelGroup: 'g' }),
    ]);
    expect(nodes.map((n) => n.kind)).toEqual(['single', 'fan']);
    expect(nodes[1]).toMatchObject({ kind: 'fan', label: 'handle ×2' });
  });

  it('falls back to "parallel" when the shared name prefix is a single char', () => {
    const nodes = groupParallelSpans([
      cp({ seq: 0, name: 'fA', parallelGroup: 'g' }),
      cp({ seq: 1, name: 'fB', parallelGroup: 'g' }),
    ]);
    expect(nodes[0]).toMatchObject({ kind: 'fan', label: 'parallel ×2' });
  });
});
