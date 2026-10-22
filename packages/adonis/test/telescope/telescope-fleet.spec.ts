import { describe, expect, it } from 'vitest';
import type { GroupHealth } from '../../src/index.js';
import { InMemoryStateStore, WorkflowEngine } from '../../src/index.js';
import {
  dedupeRunEvents,
  durableDashboard,
  durableRunsOverTimeProvider,
  durableStateBreakdownProvider,
  durableSuccessRateProvider,
  durableThroughputProvider,
  durableTimeseriesProvider,
  durableWorkerStatusProvider,
} from '../../src/telescope/index.js';
import type { ExtensionContext, TelescopeEntryLike } from '../../src/telescope/telescope-sdk.js';

function makeCtx(engine: unknown, entries: TelescopeEntryLike[] = []): ExtensionContext {
  return {
    store: { list: async () => entries },
    container: { make: async () => engine as never },
    config: {},
  };
}

function entry(event: string, payload: Record<string, unknown>, createdAt = new Date()) {
  return { content: { lib: 'durable', event, payload }, createdAt } as TelescopeEntryLike;
}

/** The same lifecycle event recorded by `pods` pods: identical payload (same `at`), ±ms createdAt. */
function onEveryPod(event: string, payload: Record<string, unknown>, pods = 3) {
  return Array.from({ length: pods }, (_, i) => entry(event, payload, new Date(Date.now() - i)));
}

describe('telescope: one event recorded by every pod counts once', () => {
  const at = new Date().toISOString();
  const tripled = [
    ...onEveryPod('run.completed', { workflow: 'a', runId: '1', at }),
    ...onEveryPod('run.completed', { workflow: 'a', runId: '2', at }),
    ...onEveryPod('run.failed', { workflow: 'b', runId: '3', at }),
  ];

  it('dedupeRunEvents keeps one copy per event + run + instant', () => {
    expect(dedupeRunEvents(tripled)).toHaveLength(3);
  });

  it('keeps a retried run’s second failure and every suspension: they have their own instant', () => {
    const t1 = new Date(1_000).toISOString();
    const t2 = new Date(2_000).toISOString();
    const kept = dedupeRunEvents([
      entry('run.failed', { runId: 'r', at: t1 }),
      entry('run.failed', { runId: 'r', at: t2 }),
      entry('run.suspended', { runId: 'r', at: t1 }),
      entry('run.suspended', { runId: 'r', at: t2 }),
      entry('step.completed', { runId: 'r', at: t1 }),
      entry('step.completed', { runId: 'r', at: t1 }),
    ]);
    expect(kept).toHaveLength(6);
  });

  it('falls back to event + run for once-per-attempt events recorded without an instant', () => {
    const kept = dedupeRunEvents([
      entry('run.completed', { runId: 'r' }),
      entry('run.completed', { runId: 'r' }),
      entry('run.suspended', { runId: 'r' }),
      entry('run.suspended', { runId: 'r' }),
    ]);
    expect(kept.map((e) => (e.content as { event: string }).event)).toEqual([
      'run.completed',
      'run.suspended',
      'run.suspended',
    ]);
  });

  it('timeseries, success rate, throughput and runs-over-time are not inflated', async () => {
    const ctx = makeCtx({}, tripled);
    const total = (await durableTimeseriesProvider().resolve({ metric: 'total' }, ctx)) as {
      value: number;
    };
    expect(total.value).toBe(3);
    const failed = (await durableTimeseriesProvider().resolve({ metric: 'failed' }, ctx)) as {
      value: number;
    };
    expect(failed.value).toBe(1);
    const rate = (await durableSuccessRateProvider().resolve({}, ctx)) as { value: number };
    expect(rate.value).toBeCloseTo(2 / 3);
    const overTime = (await durableRunsOverTimeProvider().resolve({ buckets: 1 }, ctx)) as {
      rows: Array<{ done: number; failed: number }>;
    };
    expect(overTime.rows[0]).toMatchObject({ done: 2, failed: 1 });
    const throughput = (await durableThroughputProvider().resolve({}, ctx)) as { value: number };
    const once = (await durableThroughputProvider().resolve(
      {},
      makeCtx({}, dedupeRunEvents(tripled)),
    )) as { value: number };
    expect(throughput.value).toBe(once.value);
  });
});

describe('telescope: state breakdown palette', () => {
  it('completed is green and failed is red', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const res = (await durableStateBreakdownProvider().resolve(undefined, makeCtx(engine))) as {
      segments: Array<{ label: string; color: string }>;
    };
    const color = (label: string) => res.segments.find((s) => s.label === label)?.color;
    expect(color('completed')).toBe('#34d399');
    expect(color('failed')).toBe('#f87171');
    expect(color('running')).toBe('#38bdf8');
    expect(new Set(res.segments.map((s) => s.color)).size).toBe(res.segments.length);
  });
});

describe('telescope: worker panels', () => {
  it('the per-group panel is titled "Worker health", not "Starved worker groups"', () => {
    const json = JSON.stringify(durableDashboard());
    expect(json).toContain('"Worker health"');
    expect(json).not.toContain('Starved worker groups');
    expect(json).toContain('durable.workerStatus');
  });

  it('durable.workerStatus lists one row per live instance, backlog groups first', async () => {
    const now = Date.now();
    const health: GroupHealth[] = [
      {
        group: 'idle',
        depth: 0,
        liveWorkers: [{ group: 'idle', instanceId: 'old-sdk', lastBeatAt: now }],
      },
      {
        group: 'busy',
        depth: 4,
        liveWorkers: [
          {
            group: 'busy',
            instanceId: 'b-2',
            lastBeatAt: now,
            status: { concurrency: { mode: 'fixed', limit: 4 }, inFlight: 1 },
          },
          {
            group: 'busy',
            instanceId: 'b-1',
            lastBeatAt: now,
            status: {
              concurrency: { mode: 'adaptive', limit: 6, min: 2, max: 10 },
              inFlight: 6,
              rssPct: 41.6,
              throughputPerMin: 12.2,
              lastAdjust: { at: now, from: 8, to: 6, reason: 'shrink' },
            },
          },
        ],
      },
    ];
    const engine = { workerHealth: async () => health };
    const res = (await durableWorkerStatusProvider().resolve(undefined, makeCtx(engine))) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(res.rows.map((r) => r.instanceId)).toEqual(['b-1', 'b-2', 'old-sdk']);
    expect(res.rows[0]).toMatchObject({
      group: 'busy',
      mode: 'adaptive',
      limit: 6,
      minMax: '2–10',
      saturation: '6/6',
      queued: 4,
      rssPct: 42,
      cpuPct: '—',
      throughputPerMin: 12,
      lastAdjust: 'shrink 8→6 0s ago',
    });
    expect(res.rows[1]).toMatchObject({ mode: 'fixed', minMax: 'n/a', lastAdjust: '—' });
    expect(res.rows[2]).toMatchObject({ mode: 'n/a', saturation: 'n/a', rssPct: 'n/a' });
  });
});
