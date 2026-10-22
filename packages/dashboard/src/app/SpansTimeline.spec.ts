import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FanSummary, StepCheckpoint, WorkflowRun } from '../client/durable-client';
import { RunSpans } from './SpansTimeline';

// A structural (not pixel) render test for the StepRow / ParallelFan split: render RunSpans to a
// static HTML string and assert on counts, the fan label, and single-vs-fan grouping. No jsdom/RTL
// (the repo has neither) — react-dom/server is already a dashboard dep for SSR, so this is infra-free.

const RUN: WorkflowRun = {
  id: 'r1',
  workflow: 'demo',
  workflowVersion: '1',
  status: 'completed',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:05.000Z',
};

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

/** Render RunSpans for a timeline to a static HTML string (wrapped in a QueryClientProvider, which
 *  `useChildRuns` needs). */
function renderSpans(timeline: StepCheckpoint[], fans?: FanSummary[], run = RUN): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RunSpans, {
        run,
        timeline,
        fans,
        depth: 0,
        onSelect: () => {},
        onOpenRun: () => {},
        expanded: new Set<string>(),
        onToggleChild: () => {},
      }),
    ),
  );
}

/** The fan group header carries this exact title attribute — count it to count fan groups. */
const FAN_HEADER = 'parallel fan-out (ctx.gather / ctx.all)';
/** Every StepRow's top-level clickable row carries the grid template column for its name+bar. */
const STEP_ROW = 'grid-cols-[150px_1fr]';

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('RunSpans render structure', () => {
  it('renders a [setup, fan×3, finalize] timeline as 1 fan group + N+2 step rows', () => {
    const timeline = [
      cp({ seq: 0, name: 'setup' }),
      ...Array.from({ length: 3 }, (_, k) =>
        cp({ seq: k + 1, name: `handle_${k}`, parallelGroup: 'gather:1' }),
      ),
      cp({ seq: 4, name: 'finalize' }),
    ];
    const html = renderSpans(timeline);

    // Exactly ONE fan group, labelled from the shared name prefix (`handle ×3`).
    expect(count(html, FAN_HEADER)).toBe(1);
    expect(html).toContain('handle ×3');

    // Total step rows = the 3 fan members + the 2 sequential singles = 5.
    expect(count(html, STEP_ROW)).toBe(5);

    // The fan members are present by name; the two sequential steps render as ordinary rows.
    for (const name of ['handle_0', 'handle_1', 'handle_2', 'setup', 'finalize']) {
      expect(html).toContain(name);
    }
  });

  it('renders an all-single timeline (no parallelGroup) with no fan group', () => {
    const timeline = [
      cp({ seq: 0, name: 'a' }),
      cp({ seq: 1, name: 'b' }),
      cp({ seq: 2, name: 'c' }),
    ];
    const html = renderSpans(timeline);

    // No parallelGroup anywhere → no fan group, every step is a single row.
    expect(count(html, FAN_HEADER)).toBe(0);
    expect(count(html, STEP_ROW)).toBe(3);
    for (const name of ['a', 'b', 'c']) expect(html).toContain(name);
  });
});

describe('RunSpans with a summarized fan', () => {
  const failure = cp({ seq: 7, name: 'work', status: 'failed', parallelGroup: 'steps:1:40000' });
  const fan: FanSummary = {
    group: 'steps:1:40000',
    label: 'work',
    firstSeq: 1,
    lastSeq: 40000,
    size: 40000,
    failFast: false,
    counts: { completed: 39990, failed: 10 },
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:04.000Z',
    failures: [failure],
  };

  it('draws the fan as one header with its size and counts, not a row per member', () => {
    const html = renderSpans(
      [cp({ seq: 0, name: 'setup' }), cp({ seq: 40001, name: 'finalize' })],
      [fan],
    );
    expect(html).toContain('work ×40000');
    expect(html).toContain('39990 done');
    expect(html).toContain('10 failed');
    // setup + finalize + the fan header + its one sampled failure.
    expect(count(html, STEP_ROW)).toBe(4);
    expect(html.indexOf('setup')).toBeLessThan(html.indexOf('work ×40000'));
    expect(html.indexOf('work ×40000')).toBeLessThan(html.indexOf('finalize'));
  });

  it('says the failures listed are a sample when there are more', () => {
    const html = renderSpans([], [fan]);
    expect(html).toContain('first 1 of 10 failed');
  });
});

describe('RunSpans with a fan larger than what it started', () => {
  const partial = (over: Partial<FanSummary> = {}): FanSummary => ({
    group: 'all:1:n40000:failFast',
    label: 'child runs',
    firstSeq: 1,
    lastSeq: 600,
    size: 600,
    total: 40000,
    notStarted: 39400,
    failFast: true,
    counts: { completed: 500, running: 100 },
    failures: [],
    ...over,
  });

  it('names the fan by its declared size and says how much of it started', () => {
    const html = renderSpans([], [partial()], { ...RUN, status: 'running' });
    expect(html).toContain('child runs ×40000');
    expect(html).toContain('600 of 40000 started');
    expect(html).toContain('39400 not started');
    expect(html).toContain('100 running');
  });

  it('once the run finished, shows the cut-short members, marked failFast', () => {
    const html = renderSpans([], [partial()], { ...RUN, status: 'failed' });
    expect(html).toContain('100 interrupted');
    expect(html).toContain('39400 never ran (failFast)');
    expect(html).not.toContain('not started');
  });
});
