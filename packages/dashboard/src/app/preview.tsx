import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { RunDetail, StepCheckpoint } from '../client/durable-client';
import { App } from './App';
import { RunSpans } from './SpansTimeline';
import { installMockConsoleApi } from './mock-console';
// Same two stylesheets `main.tsx` loads, in the same order — without react-flow's own CSS the
// console's workflow graph renders unstyled, which would make any screenshot taken here a lie.
import '@xyflow/react/dist/style.css';
import './index.css';

/**
 * Standalone visual-verification entry, two views:
 *
 *  - default — renders the `RunSpans` timeline against a hand-built MOCK run so the parallel-fan
 *    layout can be screenshotted with the dashboard's REAL styling. No server, no API (`RunSpans`
 *    reads everything off static props, and a fan with no child-ref steps fires no `useChildRuns`
 *    query), so this is a faithful render of the production component.
 *  - `?view=console` — renders the WHOLE `App` against a stubbed `fetch` (see `mock-console.ts`), so
 *    the header, filter chips, workers panel, run list and run detail can be screenshotted together.
 *    Deep-link a run the same way the real console does: `?view=console#/run/ord-9f2c1a4b`.
 */

const iso = (epoch: number): string => new Date(epoch).toISOString();

// A clean wall-clock baseline so the bars have realistic, readable durations.
const T0 = Date.parse('2026-06-22T14:00:00.000Z');

/** The 7 `ctx.gather` siblings: SAME parallelGroup, staggered-but-overlapping windows (so they
 *  visibly ran in parallel), one of them `failed` to show the failed-member styling. */
const FAN_GROUP = 'gather:1';
const fanMembers: { name: string; start: number; end: number; failed?: boolean }[] = [
  { name: 'handle_AF_FLEET', start: 2_000, end: 8_200 },
  { name: 'handle_MEL', start: 2_120, end: 6_900 },
  { name: 'handle_METADATA', start: 2_050, end: 5_400 },
  { name: 'handle_MVR', start: 2_300, end: 9_600, failed: true },
  { name: 'handle_SCHED_MX', start: 2_080, end: 7_300 },
  { name: 'handle_SUBWO', start: 2_260, end: 8_900 },
  { name: 'handle_UTIL', start: 2_010, end: 4_700 },
];

const fanSteps: StepCheckpoint[] = fanMembers.map((m, i) => ({
  runId: 'mock-run',
  seq: 2 + i,
  name: m.name,
  kind: 'remote',
  status: m.failed ? 'failed' : 'completed',
  parallelGroup: FAN_GROUP,
  attempts: 1,
  workerGroup: 'gather',
  startedAt: iso(T0 + m.start),
  finishedAt: iso(T0 + m.end),
  ...(m.failed ? { error: { message: 'MVR lookup timed out after 7s' } } : {}),
}));

const timeline: StepCheckpoint[] = [
  // 1) sequential setup (completed)
  {
    runId: 'mock-run',
    seq: 1,
    name: 'setup',
    kind: 'local',
    status: 'completed',
    attempts: 1,
    startedAt: iso(T0 + 0),
    finishedAt: iso(T0 + 1_800),
  },
  // 2) the 7-way parallel fan
  ...fanSteps,
  // 3) trailing finalize (completed) — starts after the slowest fan member ends
  {
    runId: 'mock-run',
    seq: 9,
    name: 'finalize',
    kind: 'local',
    status: 'completed',
    attempts: 1,
    startedAt: iso(T0 + 9_700),
    finishedAt: iso(T0 + 11_200),
  },
];

const mock: RunDetail = {
  run: {
    id: 'mock-run',
    workflow: 'gatherAircraftData',
    workflowVersion: '1',
    status: 'completed',
    createdAt: iso(T0),
    updatedAt: iso(T0 + 11_200),
  },
  timeline,
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: false, refetchOnWindowFocus: false } },
});

const noop = (): void => {};

const isConsole = new URLSearchParams(window.location.search).get('view') === 'console';
if (isConsole) installMockConsoleApi();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {isConsole ? (
        <App />
      ) : (
        <>
          <div className="app-bg" />
          <div className="relative z-10 mx-auto max-w-3xl p-8">
            <div className="mb-3 mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
              preview · parallel-fan timeline
            </div>
            <div className="rounded-lg border border-line bg-panel p-2">
              <RunSpans
                run={mock.run}
                timeline={mock.timeline}
                depth={0}
                selectedKey={undefined}
                onSelect={noop}
                onOpenRun={noop}
                expanded={new Set<string>()}
                onToggleChild={noop}
              />
            </div>
          </div>
        </>
      )}
    </QueryClientProvider>
  </StrictMode>,
);
