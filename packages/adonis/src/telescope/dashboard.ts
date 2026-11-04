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
            title: 'Failed triggers',
            data: { provider: 'durable.failedTriggers' },
            columns: [
              { key: 'at', label: 'Time' },
              { key: 'workflow', label: 'Source workflow' },
              { key: 'runId', label: 'Source run', link: { href: runHref } },
              { key: 'subscriber', label: 'Subscriber' },
              { key: 'error', label: 'Error' },
            ],
          },
          {
            kind: 'table',
            title: 'Owed lifecycle events',
            data: { provider: 'durable.owedLifecycle' },
            columns: [
              { key: 'settledAt', label: 'Settled' },
              { key: 'workflow', label: 'Workflow' },
              { key: 'runId', label: 'Run', link: { href: runHref } },
              { key: 'owed', label: 'Owed to' },
            ],
          },
          {
            kind: 'table',
            // Lists EVERY worker group (starved ones first); the Status column flags STARVED (queued
            // work, zero live workers). "Starved worker groups" read as if every row were starved.
            title: 'Worker health',
            data: { provider: 'durable.workerHealth' },
            columns: [
              { key: 'group', label: 'Group' },
              { key: 'queued', label: 'Queued' },
              { key: 'liveWorkers', label: 'Workers' },
              { key: 'status', label: 'Status' },
            ],
          },
          {
            kind: 'stat',
            title: 'Owed runs',
            data: { provider: 'durable.owedLifecycle', query: { metric: 'count' } },
            spark: false,
            thresholds: { warn: 1, bad: 50, direction: 'up-bad' },
          },
        ],
      },
      {
        // One row per LIVE worker instance (the group table above has one per group). A heartbeat
        // with no status reads `n/a`; a status with nothing measured yet (an idle worker) reads `—`.
        title: 'Workers',
        panels: [
          {
            kind: 'table',
            title: 'Workers',
            data: { provider: 'durable.workerStatus' },
            columns: [
              { key: 'group', label: 'Group' },
              { key: 'instanceId', label: 'Instance' },
              { key: 'mode', label: 'Mode' },
              { key: 'limit', label: 'Limit' },
              { key: 'minMax', label: 'Range' },
              { key: 'saturation', label: 'In flight' },
              { key: 'queued', label: 'Queued' },
              { key: 'rssPct', label: 'RAM %' },
              { key: 'cpuPct', label: 'CPU %' },
              { key: 'throughputPerMin', label: 'Steps/min' },
              { key: 'p95Ms', label: 'p95 ms' },
              { key: 'lastAdjust', label: 'Last adjust' },
              { key: 'lastBeat', label: 'Last beat' },
            ],
          },
        ],
      },
      {
        // Workflows started when another one settles (`run.completed:<wf>` / `run.failed:<wf>`).
        title: 'Lifecycle',
        cols: 2,
        panels: [
          {
            kind: 'timeseries',
            title: 'Lifecycle triggers over time',
            data: { provider: 'durable.lifecycleTriggers' },
            series: ['triggered', 'failed'],
            style: 'stacked',
          },
          {
            kind: 'topN',
            title: 'Triggered by subscriber',
            data: { provider: 'durable.lifecycleTriggers', query: { metric: 'bySubscriber' } },
            limit: 10,
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
