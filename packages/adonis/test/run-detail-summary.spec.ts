import type { StepCheckpoint } from '../src/interfaces.js';
import { FAN_SUMMARY_FAILURES, pageFan, summarizeTimeline } from '../src/run-detail-summary.js';

const at = (ms: number) => new Date(1_000_000 + ms);

function cp(seq: number, over: Partial<StepCheckpoint> = {}): StepCheckpoint {
  return {
    runId: 'p',
    seq,
    name: 'Lines.process',
    kind: 'remote',
    stepId: `p:${seq}`,
    status: 'completed',
    output: seq,
    attempts: 1,
    enqueuedAt: at(seq),
    startedAt: at(seq),
    finishedAt: at(seq + 10),
    ...over,
  };
}

const stepFan = (
  from: number,
  n: number,
  over: (i: number) => Partial<StepCheckpoint> = () => ({}),
) =>
  Array.from({ length: n }, (_, i) =>
    cp(from + i, { parallelGroup: `steps:${from}:${n}`, ...over(i) }),
  );

describe('summarizeTimeline', () => {
  it('turns a fan wider than the threshold into one summary and drops its members', () => {
    const before = cp(0, { name: 'Lines.load' });
    const fan = stepFan(1, 120, (i) =>
      i < 3
        ? { status: 'failed', error: { message: `bad ${i}` } }
        : i >= 100
          ? { status: 'pending' }
          : {},
    );
    const after = cp(121, { name: 'Lines.report' });

    const { timeline, fans } = summarizeTimeline([before, ...fan, after], 50);

    expect(timeline.map((c) => c.seq)).toEqual([0, 121]);
    expect(fans).toHaveLength(1);
    expect(fans[0]).toMatchObject({
      group: 'steps:1:120',
      label: 'Lines.process',
      firstSeq: 1,
      lastSeq: 120,
      size: 120,
      counts: { failed: 3, completed: 97, pending: 20 },
    });
    expect(fans[0]?.failures.map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it('keeps a fan at or under the threshold inline', () => {
    const fan = stepFan(0, 50);
    const { timeline, fans } = summarizeTimeline(fan, 50);
    expect(timeline).toHaveLength(50);
    expect(fans).toEqual([]);
  });

  it('counts a failed child as failed, and a folded checkpoint as the children it stands for', () => {
    const group = 'all:0';
    const children = Array.from({ length: 60 }, (_, i) =>
      cp(i, {
        name: `signal:child:p.all.0.${i}`,
        kind: 'signal',
        parallelGroup: group,
        output: i === 5 ? { ok: false, error: 'boom' } : { ok: true, value: i },
      }),
    );
    const folded = cp(60, {
      name: 'fan:p.all.0.w9.',
      kind: 'signal',
      parallelGroup: group,
      output: { from: 540, values: Array.from({ length: 300 }, (_, i) => i) },
    });

    const { fans } = summarizeTimeline([...children, folded], 50);

    expect(fans[0]).toMatchObject({
      label: 'child runs',
      size: 360,
      counts: { completed: 359, failed: 1 },
    });
    expect(fans[0]?.failures.map((f) => f.seq)).toEqual([5]);
  });

  it('caps the failure sample', () => {
    const fan = stepFan(0, 100, () => ({ status: 'failed' }));
    expect(summarizeTimeline(fan, 50).fans[0]?.failures).toHaveLength(FAN_SUMMARY_FAILURES);
  });
});

describe('pageFan', () => {
  const fan = stepFan(0, 120, (i) => (i % 40 === 0 ? { status: 'failed' } : {}));

  it('pages a fan in seq order with the total', () => {
    const page = pageFan(fan, 'steps:0:120', { offset: 100, limit: 50 });
    expect(page.total).toBe(120);
    expect(page.items.map((c) => c.seq)).toEqual(Array.from({ length: 20 }, (_, i) => 100 + i));
  });

  it('filters to failed members', () => {
    const page = pageFan(fan, 'steps:0:120', { failedOnly: true });
    expect(page.total).toBe(3);
    expect(page.items.map((c) => c.seq)).toEqual([0, 40, 80]);
  });

  it('falls back to sane bounds for a non-finite query', () => {
    const page = pageFan(fan, 'steps:0:120', { offset: Number.NaN, limit: Number.NaN });
    expect(page.items).toHaveLength(100);
    expect(page.items[0]?.seq).toBe(0);
  });
});
describe('a fan whose size its group declares', () => {
  it('counts the members not started yet, and summarizes a fan sent in small waves', () => {
    // 30 of 40.000 sent so far (concurrency 30): narrow in rows, wide by declaration.
    const sent = Array.from({ length: 30 }, (_, i) =>
      cp(i, { parallelGroup: 'steps:0:40000', status: i < 10 ? 'completed' : 'pending' }),
    );
    const { fans, timeline } = summarizeTimeline(sent, 50);
    expect(timeline).toEqual([]);
    expect(fans[0]).toMatchObject({ size: 30, total: 40000, notStarted: 39970, failFast: false });
  });

  it('reads the size and the failFast mark off a child fan group, and tolerates the old one', () => {
    const member = (group: string) =>
      cp(0, {
        name: 'signal:child:p.all.0.0',
        kind: 'signal',
        parallelGroup: group,
        output: { ok: true },
      });
    expect(summarizeTimeline([member('all:0:n3000:failFast')], 0).fans[0]).toMatchObject({
      total: 3000,
      notStarted: 2999,
      failFast: true,
    });
    expect(summarizeTimeline([member('all:0')], 0).fans[0]).toMatchObject({
      total: undefined,
      notStarted: undefined,
      failFast: false,
    });
  });
});
