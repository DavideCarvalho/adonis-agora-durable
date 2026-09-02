import type { DashboardSpec } from './telescope-sdk.js';

/** Options for the durable "Workflows" dashboard. */
export interface DurableDashboardOptions {
  /**
   * URL template for deep-linking a run into the durable console.
   * Default `/durable#/run/{runId}`.
   *
   * Pass this when the console is mounted somewhere other than `/durable` (the
   * `path` in `config/durable_dashboard.ts`) — the template has to carry the mount
   * path, and this module cannot know it.
   *
   * The `#/run/...` shape is not cosmetic: the console is a hash-routed SPA, so a
   * plain path is served by the app's router, not the console, and 404s.
   */
  runHref?: string;
  /** Window (ms) bounding the "Stuck runs" table. Default 24h; pass `0` to show all. */
  recentFailuresWindowMs?: number;
}

/**
 * The "Workflows" health dashboard — a golden-signals layout (success rate / latency / backlog /
 * throughput up top, then what-needs-attention, then trends). Pure data: panels bind to the
 * `durable.*` data providers by name.
 */
export function durableDashboard(opts: DurableDashboardOptions = {}): DashboardSpec {
  // `/durable#/run/{runId}` — hash, and SINGULAR "run".
  //
  // The old default was `/durable/runs/{runId}`, wrong in both: the console routes on
  // `window.location.hash` matching `#/run/<id>`, so a path never reaches it and the
  // app's own router answers 404. Every "open this run" link from the telescope
  // dashboard was dead.
  const runHref = opts.runHref ?? '/durable#/run/{runId}';
  const windowMs = opts.recentFailuresWindowMs ?? 24 * 60 * 60 * 1000;
  return {
    id: 'durable.workflows',
    label: 'Workflows',
    panels: [],
    sections: [
      {
        title: 'Health',
        cols: 4,
        panels: [
          {
            kind: 'gauge',
            title: 'Success rate',
            data: { provider: 'durable.successRate' },
            max: 1,
            format: 'percent',
            thresholds: { warn: 0.98, bad: 0.95, direction: 'down-bad' },
          },
          {
            kind: 'stat',
            title: 'Duration p95',
            data: { provider: 'durable.duration', query: { metric: 'p95' } },
            format: 'duration',
            spark: false,
            thresholds: { warn: 2000, bad: 5000, direction: 'up-bad' },
          },
          {
            kind: 'stat',
            title: 'Backlog',
            data: { provider: 'durable.state', query: { status: 'pending' } },
            spark: false,
            thresholds: { warn: 50, bad: 200, direction: 'up-bad' },
          },
          {
            kind: 'stat',
            title: 'Throughput',
            data: { provider: 'durable.throughput' },
            format: 'rate',
            spark: true,
          },
        ],
      },
      {
        title: 'Needs attention',
        cols: 3,
        panels: [
          {
            kind: 'topN',
            title: 'Top failing workflows',
            data: { provider: 'durable.timeseries', query: { metric: 'topFailures' } },
            limit: 8,
          },
          {
            kind: 'table',
            title: 'Stuck runs',
            data: { provider: 'durable.recentFailures', query: { windowMs } },
            columns: [
              { key: 'updatedAt', label: 'Updated' },
              { key: 'workflow', label: 'Workflow' },
              { key: 'runId', label: 'Run', link: { href: runHref } },
              { key: 'error', label: 'Error' },
            ],
          },
          {
            kind: 'table',
            title: 'Starved worker groups',
            data: { provider: 'durable.workerHealth' },
            columns: [
              { key: 'group', label: 'Group' },
              { key: 'queued', label: 'Queued' },
              { key: 'liveWorkers', label: 'Workers' },
              { key: 'status', label: 'Status' },
            ],
          },
        ],
      },
      {
        title: 'Trends',
        cols: 3,
        panels: [
          {
            kind: 'timeseries',
            title: 'Runs over time',
            data: { provider: 'durable.runsOverTime' },
            series: ['done', 'failed'],
            style: 'stacked',
          },
          {
            kind: 'distribution',
            title: 'Duration distribution',
            data: { provider: 'durable.duration' },
            markers: ['p50', 'p95', 'p99'],
            format: 'duration',
          },
          {
            kind: 'breakdown',
            title: 'Runs by state',
            data: { provider: 'durable.stateBreakdown' },
            style: 'donut',
          },
        ],
      },
    ],
  };
}
