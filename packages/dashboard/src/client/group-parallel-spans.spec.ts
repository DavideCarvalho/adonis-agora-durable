import { describe, expect, it } from 'vitest';
import type { FanSummary, StepCheckpoint } from './durable-client.js';
import {
  fanProgress,
  fanSizeLabel,
  fanStatus,
  groupParallelSpans,
  runFinished,
} from './group-parallel-spans.js';

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

describe('groupParallelSpans with folded ctx.all waves', () => {
  it('labels a fan of folded waves by the child runs they stand for', () => {
    const folded = (seq: number, values: number[]) =>
      cp({
        seq,
        name: `fan:p.all.0.w${seq}.`,
        parallelGroup: 'all:0',
        output: { from: 0, values },
      });
    const nodes = groupParallelSpans([
      folded(0, [1, 2]),
      folded(2, [3, 4]),
      cp({ seq: 4, name: 'signal:child:p.all.0.w2.4', parallelGroup: 'all:0' }),
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.kind === 'fan' && nodes[0].label).toBe('child runs ×5');
  });
});

function fan(over: Partial<FanSummary> = {}): FanSummary {
  return {
    group: 'steps:1:40000',
    label: 'work',
    firstSeq: 1,
    lastSeq: 40000,
    size: 40000,
    failFast: false,
    counts: { completed: 40000 },
    failures: [],
    ...over,
  };
}

describe('groupParallelSpans with summarized fans', () => {
  it('places a summary where its first member sat, among the listed steps', () => {
    const nodes = groupParallelSpans(
      [cp({ seq: 0, name: 'setup' }), cp({ seq: 40001, name: 'finalize' })],
      [fan({ firstSeq: 1, lastSeq: 40000 })],
    );
    expect(nodes.map((n) => n.kind)).toEqual(['single', 'summary', 'single']);
    expect(nodes[1]).toMatchObject({ kind: 'summary', fan: { group: 'steps:1:40000' } });
  });

  it('orders several summaries by firstSeq, whatever order they arrive in', () => {
    const nodes = groupParallelSpans(
      [cp({ seq: 0, name: 'a' }), cp({ seq: 100, name: 'b' }), cp({ seq: 200, name: 'c' })],
      [fan({ group: 'late', firstSeq: 150 }), fan({ group: 'early', firstSeq: 50 })],
    );
    expect(nodes.map((n) => (n.kind === 'summary' ? n.fan.group : n.kind))).toEqual([
      'single',
      'early',
      'single',
      'late',
      'single',
    ]);
  });

  it('a summary before every step leads; one after every step trails', () => {
    const nodes = groupParallelSpans(
      [cp({ seq: 10, name: 'mid' })],
      [fan({ group: 'first', firstSeq: 0 }), fan({ group: 'last', firstSeq: 11 })],
    );
    expect(nodes.map((n) => (n.kind === 'summary' ? n.fan.group : n.kind))).toEqual([
      'first',
      'single',
      'last',
    ]);
  });

  it('positions a summary against an inline fan by that fan’s first member', () => {
    const nodes = groupParallelSpans(
      [
        cp({ seq: 0, name: 'h_a', parallelGroup: 'g' }),
        cp({ seq: 1, name: 'h_b', parallelGroup: 'g' }),
        cp({ seq: 60, name: 'tail' }),
      ],
      [fan({ firstSeq: 2 })],
    );
    expect(nodes.map((n) => n.kind)).toEqual(['fan', 'summary', 'single']);
  });

  it('a run that is nothing but a summarized fan is one summary node', () => {
    expect(groupParallelSpans([], [fan()]).map((n) => n.kind)).toEqual(['summary']);
  });
});

describe('fanProgress / fanStatus', () => {
  it('fills the statuses the server omitted with zero', () => {
    expect(fanProgress(fan({ size: 5, counts: { completed: 3, failed: 2 } }))).toEqual({
      completed: 3,
      failed: 2,
      running: 0,
      pending: 0,
      interrupted: 0,
      notStarted: 0,
      skipped: 0,
      started: 5,
      total: 5,
    });
  });

  it('is in flight while any member is, failed once settled with a failure', () => {
    expect(fanStatus(fan({ counts: { completed: 1, failed: 1, running: 1 } }))).toBe('running');
    expect(fanStatus(fan({ counts: { completed: 1, pending: 1 } }))).toBe('pending');
    expect(fanStatus(fan({ counts: { completed: 1, failed: 1 } }))).toBe('failed');
    expect(fanStatus(fan({ counts: { completed: 2 } }))).toBe('completed');
  });

  it('counts the members a live run has not started yet, and stays in flight for them', () => {
    const waves = fan({ size: 500, total: 40000, notStarted: 39500, counts: { completed: 500 } });
    const p = fanProgress(waves);
    expect(p).toMatchObject({ completed: 500, notStarted: 39500, skipped: 0, total: 40000 });
    expect(fanStatus(waves)).toBe('pending');
    expect(fanSizeLabel(p)).toBe('500 of 40000');
  });

  it('once the run finished, still-running members are interrupted and the rest never ran', () => {
    const stopped = fan({
      size: 600,
      total: 40000,
      notStarted: 39400,
      failFast: true,
      counts: { completed: 580, failed: 1, running: 19 },
    });
    const p = fanProgress(stopped, true);
    expect(p).toMatchObject({ running: 0, interrupted: 19, notStarted: 0, skipped: 39400 });
    expect(fanStatus(stopped, true)).toBe('failed');
    expect(fanSizeLabel(p)).toBe('600 of 40000');
  });

  it('shows ×N for a fan that ran whole, or whose group does not carry a size', () => {
    expect(fanSizeLabel(fanProgress(fan({ size: 3000, total: 3000 })))).toBe('×3000');
    expect(fanSizeLabel(fanProgress(fan({ size: 3000 })))).toBe('×3000');
  });
});

describe('runFinished', () => {
  it('is false while the run can still start or finish a member', () => {
    for (const s of ['pending', 'running', 'suspended', 'cancelling'])
      expect(runFinished(s)).toBe(false);
    for (const s of ['completed', 'failed', 'cancelled', 'dead']) expect(runFinished(s)).toBe(true);
  });
});
