import { type RunStatus, WorkflowEngine } from '../index.js';
import type { DataProvider, ExtensionContext, TelescopeEntryLike } from './telescope-sdk.js';

/**
 * The durable "Workflows" dashboard data providers. Two sources:
 *  - ENGINE-backed (state / recentFailures / workerHealth / stateBreakdown): query the live
 *    `WorkflowEngine` read API (resolved from the container), so they reflect the source of truth.
 *  - ENTRY-backed (timeseries / duration / runsOverTime / successRate / throughput): aggregate the
 *    `agora:durable:*` lifecycle events the generic diagnostics watcher captured into Telescope
 *    (recorded as `type: 'diagnostic'`, `tag: 'lib:durable'`), so they are the rolling history.
 *
 * No durable-specific watcher is needed: the `@adonis-agora/durable` provider already bridges engine events
 * onto the diagnostics bus, and Telescope's generic watcher records them.
 */

const STATE_CAP = 10_000;

/** The Telescope diagnostic-entry content the durable bridge produces (`payload` is the EngineEvent). */
interface DurableEntryContent {
  event?: string;
  payload?: { workflow?: string; runId?: string; durationMs?: number };
}

/** Resolve the live durable engine from the host container. */
function engineOf(ctx: ExtensionContext): Promise<WorkflowEngine> {
  return ctx.container.make<WorkflowEngine>(WorkflowEngine);
}

/** Fetch captured `agora:durable:*` lifecycle entries from Telescope storage (newest-first). */
async function fetchEntries(ctx: ExtensionContext, limit = 5_000): Promise<TelescopeEntryLike[]> {
  return ctx.store.list({ type: 'diagnostic', tag: 'lib:durable', limit });
}

const contentOf = (e: TelescopeEntryLike): DurableEntryContent =>
  (e.content ?? {}) as DurableEntryContent;

/** Compute the p-th percentile of a SORTED array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

/** Split entries into current `(now-window, now]` and previous `(now-2window, now-window]` windows. */
function splitWindows(
  entries: TelescopeEntryLike[],
  windowMs: number,
  now: number,
): { current: TelescopeEntryLike[]; previous: TelescopeEntryLike[] } {
  const start = now - windowMs;
  const prevStart = start - windowMs;
  const at = (e: TelescopeEntryLike) => (e.createdAt ? +new Date(e.createdAt) : 0);
  return {
    current: entries.filter((e) => at(e) > start && at(e) <= now),
    previous: entries.filter((e) => at(e) > prevStart && at(e) <= start),
  };
}

/** Success rate (completed / (completed+failed)) for a list of entries; 1 when no data. */
function successRateOf(entries: TelescopeEntryLike[]): number {
  let completed = 0;
  let failed = 0;
  for (const e of entries) {
    const event = contentOf(e).event;
    if (event === 'run.completed') completed += 1;
    else if (event === 'run.failed') failed += 1;
  }
  const total = completed + failed;
  return total === 0 ? 1 : completed / total;
}

// ─── engine-backed ──────────────────────────────────────────────────────────

/** A current-state count from the engine. `query.status` selects which (default 'dead'). */
export function durableStateProvider(): DataProvider {
  return {
    name: 'durable.state',
    async resolve(query, ctx) {
      const engine = await engineOf(ctx);
      const status = (query?.status as RunStatus) ?? 'dead';
      const runs = await engine.listRuns({ status, size: STATE_CAP });
      return { value: runs.length };
    },
  };
}

/** Recent failed + dead runs as table rows (newest first), bounded by `query.windowMs` (default 24h). */
export function durableRecentFailuresProvider(): DataProvider {
  return {
    name: 'durable.recentFailures',
    async resolve(query, ctx) {
      const engine = await engineOf(ctx);
      const limit = Math.min(200, Math.max(10, Number(query?.limit ?? 50)));
      const windowMs = query?.windowMs === undefined ? 24 * 60 * 60 * 1000 : Number(query.windowMs);
      const cutoff = windowMs > 0 ? Date.now() - windowMs : 0;
      const [failed, dead] = await Promise.all([
        engine.listRuns({ status: 'failed', size: limit }),
        engine.listRuns({ status: 'dead', size: limit }),
      ]);
      const rows = [...failed, ...dead]
        .filter((r) => +new Date(r.updatedAt) >= cutoff)
        .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
        .slice(0, limit)
        .map((r) => ({
          updatedAt: `${new Date(r.updatedAt).toISOString().replace('T', ' ').slice(0, 16)}Z`,
          workflow: r.workflow,
          runId: r.id,
          error: r.error?.message ?? '',
        }));
      return { rows };
    },
  };
}

/** Per-group worker health from the engine; `query.metric: 'starvedCount'` returns a stat. */
export function durableWorkerHealthProvider(): DataProvider {
  return {
    name: 'durable.workerHealth',
    async resolve(query, ctx) {
      const engine = await engineOf(ctx);
      const health = await engine.workerHealth();
      const isStarved = (g: { depth: number; liveWorkers: unknown[] }) =>
        g.depth > 0 && g.liveWorkers.length === 0;
      if ((query?.metric as string) === 'starvedCount') {
        return { value: health.filter(isStarved).length };
      }
      const rows = health
        .slice()
        .sort((a, b) => Number(isStarved(b)) - Number(isStarved(a)) || b.depth - a.depth)
        .map((g) => ({
          group: g.group,
          queued: g.depth,
          liveWorkers: g.liveWorkers.length,
          status: isStarved(g) ? 'STARVED' : 'ok',
        }));
      return { rows };
    },
  };
}

const STATE_BREAKDOWN_PALETTE = ['#34d399', '#fbbf24', '#f87171', '#38bdf8', '#a78bfa'];
const STATE_BREAKDOWN_STATUSES: RunStatus[] = ['running', 'pending', 'completed', 'failed', 'dead'];

/** Pie/donut segments: a count per status from the engine. */
export function durableStateBreakdownProvider(): DataProvider {
  return {
    name: 'durable.stateBreakdown',
    async resolve(_query, ctx) {
      const engine = await engineOf(ctx);
      const counts = await Promise.all(
        STATE_BREAKDOWN_STATUSES.map((status) =>
          engine.listRuns({ status, size: STATE_CAP }).then((runs) => runs.length),
        ),
      );
      const segments = STATE_BREAKDOWN_STATUSES.map((label, i) => ({
        label,
        value: counts[i],
        color: STATE_BREAKDOWN_PALETTE[i],
      }));
      return { segments };
    },
  };
}

// ─── entry-backed (captured diagnostics history) ──────────────────────────────

/** Rollups from captured run.* entries. `query.metric`: successRate | failed | total | topFailures. */
export function durableTimeseriesProvider(): DataProvider {
  return {
    name: 'durable.timeseries',
    async resolve(query, ctx) {
      const limit = Math.min(5_000, Math.max(100, Number(query?.limit ?? 2_000)));
      const entries = await fetchEntries(ctx, limit);
      let completed = 0;
      let failed = 0;
      const failByWorkflow = new Map<string, number>();
      for (const e of entries) {
        const c = contentOf(e);
        if (c.event === 'run.completed') completed += 1;
        else if (c.event === 'run.failed') {
          failed += 1;
          const wf = c.payload?.workflow ?? 'unknown';
          failByWorkflow.set(wf, (failByWorkflow.get(wf) ?? 0) + 1);
        }
      }
      const total = completed + failed;
      const metric = (query?.metric as string) ?? 'successRate';
      if (metric === 'successRate') return { value: total === 0 ? 1 : completed / total };
      if (metric === 'failed') return { value: failed };
      if (metric === 'total') return { value: total };
      if (metric === 'topFailures') {
        const items = [...failByWorkflow.entries()]
          .map(([label, value]) => ({ label, value }))
          .sort((a, b) => b.value - a.value);
        return { items };
      }
      return { value: total };
    },
  };
}

/** Duration percentiles + a ~8-bucket histogram, from `payload.durationMs` (or run.started pairing). */
export function durableDurationProvider(): DataProvider {
  return {
    name: 'durable.duration',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const startedAt = new Map<string, number>();
      for (const e of entries) {
        const c = contentOf(e);
        if (c.event === 'run.started' && c.payload?.runId && e.createdAt) {
          startedAt.set(c.payload.runId, +new Date(e.createdAt));
        }
      }
      const durs: number[] = [];
      for (const e of entries) {
        const c = contentOf(e);
        if (c.event === 'run.completed' || c.event === 'run.failed') {
          if (typeof c.payload?.durationMs === 'number') {
            durs.push(c.payload.durationMs);
          } else if (c.payload?.runId) {
            const start = startedAt.get(c.payload.runId);
            const end = e.createdAt ? +new Date(e.createdAt) : undefined;
            if (start !== undefined && end !== undefined && end >= start) durs.push(end - start);
          }
        }
      }
      durs.sort((a, b) => a - b);
      const p50 = percentile(durs, 50);
      const p95 = percentile(durs, 95);
      const p99 = percentile(durs, 99);
      const metric = query?.metric as string | undefined;
      if (metric === 'p50') return { value: p50 };
      if (metric === 'p95') return { value: p95 };
      if (metric === 'p99') return { value: p99 };
      const max = durs.at(-1) ?? 0;
      const bucketCount = 8;
      const size = Math.max(1, Math.ceil((max + 1) / bucketCount));
      const buckets = Array.from({ length: bucketCount }, (_, i) => ({
        label: `${Math.round((i * size) / 100) / 10}s`,
        count: 0,
      }));
      for (const d of durs) {
        const bucket = buckets[Math.min(bucketCount - 1, Math.floor(d / size))];
        if (bucket) bucket.count += 1;
      }
      return { buckets, p50, p95, p99 };
    },
  };
}

/** `done`/`failed` counts bucketed into `query.buckets ?? 24` equal time buckets. */
export function durableRunsOverTimeProvider(): DataProvider {
  return {
    name: 'durable.runsOverTime',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const n = Math.max(1, Number(query?.buckets ?? 24));
      const now = Date.now();
      let minT = now;
      for (const e of entries) {
        if (e.createdAt) minT = Math.min(minT, +new Date(e.createdAt));
      }
      const span = Math.max(now - minT, 1);
      const bucketSize = span / n;
      const rows = Array.from({ length: n }, (_, i) => ({
        label: new Date(minT + i * bucketSize).toISOString().slice(11, 16),
        done: 0,
        failed: 0,
      }));
      for (const e of entries) {
        const event = contentOf(e).event;
        if (event !== 'run.completed' && event !== 'run.failed') continue;
        const t = e.createdAt ? +new Date(e.createdAt) : 0;
        const row = rows[Math.min(n - 1, Math.floor((t - minT) / bucketSize))];
        if (row) {
          if (event === 'run.completed') row.done += 1;
          else row.failed += 1;
        }
      }
      return { rows };
    },
  };
}

/** Success rate over `query.windowMs` (default 24h), with `delta` vs the prior window + an 8-pt spark. */
export function durableSuccessRateProvider(): DataProvider {
  return {
    name: 'durable.successRate',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const windowMs = Number(query?.windowMs ?? 24 * 60 * 60 * 1000);
      const now = Date.now();
      const { current, previous } = splitWindows(entries, windowMs, now);
      const value = successRateOf(current);
      const delta = previous.length > 0 ? value - successRateOf(previous) : undefined;
      const sparkBuckets = 8;
      const bucketSize = windowMs / sparkBuckets;
      const sparkStart = now - windowMs;
      const spark = Array.from({ length: sparkBuckets }, (_, i) => {
        const bStart = sparkStart + i * bucketSize;
        const bEntries = current.filter((e) => {
          const t = e.createdAt ? +new Date(e.createdAt) : 0;
          return t > bStart && t <= bStart + bucketSize;
        });
        return successRateOf(bEntries);
      });
      return delta === undefined ? { value, spark } : { value, delta, spark };
    },
  };
}

/** Completed runs per hour over `query.windowMs` (default 24h), with `delta` + an 8-pt spark. */
export function durableThroughputProvider(): DataProvider {
  return {
    name: 'durable.throughput',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const windowMs = Number(query?.windowMs ?? 24 * 60 * 60 * 1000);
      const now = Date.now();
      const { current, previous } = splitWindows(entries, windowMs, now);
      const countCompleted = (es: TelescopeEntryLike[]) =>
        es.filter((e) => contentOf(e).event === 'run.completed').length;
      const windowHours = windowMs / (60 * 60 * 1000);
      const value = countCompleted(current) / windowHours;
      const delta =
        previous.length > 0 ? value - countCompleted(previous) / windowHours : undefined;
      const sparkBuckets = 8;
      const bucketSize = windowMs / sparkBuckets;
      const bucketHours = bucketSize / (60 * 60 * 1000);
      const sparkStart = now - windowMs;
      const spark = Array.from({ length: sparkBuckets }, (_, i) => {
        const bStart = sparkStart + i * bucketSize;
        const bEntries = current.filter((e) => {
          const t = e.createdAt ? +new Date(e.createdAt) : 0;
          return t > bStart && t <= bStart + bucketSize;
        });
        return countCompleted(bEntries) / bucketHours;
      });
      return delta === undefined ? { value, spark } : { value, delta, spark };
    },
  };
}
