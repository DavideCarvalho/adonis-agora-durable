import { describe, expect, it } from 'vitest';
import { InMemoryStateStore, WorkflowEngine } from '../../src/index.js';
import {
  durableDurationProvider,
  durableRecentFailuresProvider,
  durableStateBreakdownProvider,
  durableStateProvider,
  durableSuccessRateProvider,
  durableTimeseriesProvider,
} from '../../src/telescope/index.js';
import type { ExtensionContext, TelescopeEntryLike } from '../../src/telescope/telescope-sdk.js';

/** An ExtensionContext over a real engine + a fixed list of captured durable diagnostic entries. */
function makeCtx(engine: WorkflowEngine, entries: TelescopeEntryLike[] = []): ExtensionContext {
  return {
    store: { list: async () => entries },
    container: { make: async () => engine as never },
    config: {},
  };
}

/** A captured `agora:durable:<event>` diagnostic entry, as the generic watcher records it. */
function entry(
  event: string,
  payload: Record<string, unknown> = {},
  createdAt = new Date(),
): TelescopeEntryLike {
  return { content: { lib: 'durable', event, payload }, createdAt };
}

async function engineWith(): Promise<WorkflowEngine> {
  const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
  engine.register('ok', '1', async () => 'done');
  engine.register('boom', '1', async (ctx) =>
    ctx.localStep('x', async () => {
      throw new Error('kaboom');
    }),
  );
  await engine.start('ok', {}, 'r-ok');
  await engine.waitForRun('r-ok');
  await engine.start('boom', {}, 'r-bad');
  await engine.waitForRun('r-bad');
  return engine;
}

describe('engine-backed providers', () => {
  it('durable.state counts runs in a status', async () => {
    const engine = await engineWith();
    const res = (await durableStateProvider().resolve(
      { status: 'completed' },
      makeCtx(engine),
    )) as {
      value: number;
    };
    expect(res.value).toBe(1);
  });

  it('durable.stateBreakdown returns a segment per status', async () => {
    const engine = await engineWith();
    const res = (await durableStateBreakdownProvider().resolve(undefined, makeCtx(engine))) as {
      segments: Array<{ label: string; value: number }>;
    };
    expect(res.segments.map((s) => s.label)).toEqual([
      'running',
      'pending',
      'completed',
      'failed',
      'dead',
    ]);
    expect(res.segments.find((s) => s.label === 'completed')?.value).toBe(1);
    expect(res.segments.find((s) => s.label === 'failed')?.value).toBe(1);
  });

  it('state counts come from countRuns, exact past the listing cap and without loading rows', async () => {
    const listed: string[] = [];
    const engine = {
      countRuns: async ({ status }: { status?: string }) => (status === 'running' ? 150_000 : 3),
      listRuns: async ({ status }: { status?: string }) => {
        listed.push(String(status));
        return [];
      },
    } as unknown as WorkflowEngine;
    const gauge = (await durableStateProvider().resolve(
      { status: 'running' },
      makeCtx(engine),
    )) as {
      value: number;
    };
    expect(gauge.value).toBe(150_000);

    const pie = (await durableStateBreakdownProvider().resolve(undefined, makeCtx(engine))) as {
      segments: Array<{ label: string; value: number }>;
    };
    expect(pie.segments.find((s) => s.label === 'running')?.value).toBe(150_000);
    expect(listed).toEqual([]);
  });

  it('durable.recentFailures lists failed/dead runs as rows', async () => {
    const engine = await engineWith();
    const res = (await durableRecentFailuresProvider().resolve({}, makeCtx(engine))) as {
      rows: Array<{ workflow: string; runId: string; error: string }>;
    };
    expect(res.rows.map((r) => r.runId)).toContain('r-bad');
    expect(res.rows[0]?.error).toContain('kaboom');
  });
});

describe('entry-backed providers', () => {
  const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
  const entries = [
    entry('run.completed', { workflow: 'a', runId: '1', durationMs: 100 }),
    entry('run.completed', { workflow: 'a', runId: '2', durationMs: 300 }),
    entry('run.failed', { workflow: 'b', runId: '3', durationMs: 50 }),
  ];

  it('durable.timeseries computes success rate and top failures', async () => {
    const ctx = makeCtx(engine, entries);
    const rate = (await durableTimeseriesProvider().resolve({ metric: 'successRate' }, ctx)) as {
      value: number;
    };
    expect(rate.value).toBeCloseTo(2 / 3);
    const top = (await durableTimeseriesProvider().resolve({ metric: 'topFailures' }, ctx)) as {
      items: Array<{ label: string; value: number }>;
    };
    expect(top.items[0]).toEqual({ label: 'b', value: 1 });
  });

  it('durable.duration computes percentiles from payload.durationMs', async () => {
    const res = (await durableDurationProvider().resolve(
      { metric: 'p95' },
      makeCtx(engine, entries),
    )) as {
      value: number;
    };
    expect(res.value).toBeGreaterThan(0);
  });

  it('durable.successRate returns a value with a spark', async () => {
    const res = (await durableSuccessRateProvider().resolve({}, makeCtx(engine, entries))) as {
      value: number;
      spark: number[];
    };
    expect(res.value).toBeCloseTo(2 / 3);
    expect(res.spark).toHaveLength(8);
  });
});
