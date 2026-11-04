import { describe, expect, it } from 'vitest';
import {
  InMemoryStateStore,
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  WorkflowEngine,
} from '../../src/index.js';
import {
  dedupeRunEvents,
  durableDashboard,
  durableDurationProvider,
  durableFailedTriggersProvider,
  durableLifecycleTriggersProvider,
  durableOwedLifecycleProvider,
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

describe('lifecycle providers', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  const at = minutesAgo(5).toISOString();
  const entries = [
    entry(
      'run.trigger_failed',
      { runId: 'i1', workflow: 'ingest', name: 'notify', error: { message: 'rejected' }, at },
      minutesAgo(5),
    ),
    entry('run.triggered', { runId: 'i1', workflow: 'ingest', name: 'audit', at }, minutesAgo(5)),
    // Another subscriber of the same run, emitted in the same instant.
    entry('run.triggered', { runId: 'i1', workflow: 'ingest', name: 'refresh', at }, minutesAgo(5)),
    entry('run.triggered', { runId: 'i2', workflow: 'ingest', name: 'audit' }, minutesAgo(1)),
    entry('run.completed', { runId: 'i2', workflow: 'ingest' }, minutesAgo(1)),
  ];

  it('dedupeRunEvents keeps two subscribers of one run whose events share an instant', () => {
    expect(dedupeRunEvents(entries)).toHaveLength(entries.length);
    expect(dedupeRunEvents([entries[1], entries[1]] as TelescopeEntryLike[])).toHaveLength(1);
  });

  it('durable.failedTriggers lists recent run.trigger_failed events', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const res = (await durableFailedTriggersProvider().resolve({}, makeCtx(engine, entries))) as {
      rows: Array<Record<string, string>>;
    };
    expect(res.rows).toEqual([
      {
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z$/),
        workflow: 'ingest',
        runId: 'i1',
        subscriber: 'notify',
        error: 'rejected',
      },
    ]);
  });

  it('durable.lifecycleTriggers buckets triggers over time and counts them by subscriber', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const ctx = makeCtx(engine, entries);
    const over = (await durableLifecycleTriggersProvider().resolve({ buckets: 4 }, ctx)) as {
      rows: Array<{ label: string; triggered: number; failed: number }>;
    };
    expect(over.rows).toHaveLength(4);
    expect(over.rows.reduce((n, r) => n + r.triggered, 0)).toBe(3);
    expect(over.rows.reduce((n, r) => n + r.failed, 0)).toBe(1);
    const top = (await durableLifecycleTriggersProvider().resolve(
      { metric: 'bySubscriber' },
      ctx,
    )) as { items: Array<{ label: string; value: number }> };
    expect(top.items).toEqual([
      { label: 'ingest → audit', value: 2 },
      { label: 'ingest → refresh', value: 1 },
    ]);
  });

  it('durable.owedLifecycle lists settled runs still owed past the grace, with their subscribers', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const run = (id: string, updatedAt: Date, tags: string[]) => ({
      id,
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed' as const,
      input: {},
      tags,
      createdAt: updatedAt,
      updatedAt,
    });
    await store.createRun(
      run('old', minutesAgo(10), [LIFECYCLE_PENDING_TAG, `${LIFECYCLE_OWED_TAG_PREFIX}notify`]),
    );
    await store.createRun(run('legacy', minutesAgo(20), [LIFECYCLE_PENDING_TAG]));
    await store.createRun(
      run('fresh', new Date(), [LIFECYCLE_PENDING_TAG, `${LIFECYCLE_OWED_TAG_PREFIX}notify`]),
    );
    await store.createRun(run('done', minutesAgo(10), ['durable:triggered:notify']));

    const res = (await durableOwedLifecycleProvider().resolve({}, makeCtx(engine))) as {
      rows: Array<Record<string, string>>;
    };
    expect(res.rows.map((r) => [r.runId, r.workflow, r.owed])).toEqual([
      ['old', 'ingest', 'notify'],
      ['legacy', 'ingest', 'every subscriber'],
    ]);
    expect(
      await durableOwedLifecycleProvider().resolve({ metric: 'count' }, makeCtx(engine)),
    ).toEqual({ value: 2 });
  });

  it('the Workflows dashboard binds the lifecycle panels', () => {
    const spec = durableDashboard({ runHref: '/ops#/run/{runId}' });
    const attention = spec.sections?.find((s) => s.title === 'Needs attention');
    const failed = attention?.panels.find((p) => p.title === 'Failed triggers');
    const owed = attention?.panels.find((p) => p.title === 'Owed lifecycle events');
    expect(failed).toMatchObject({ kind: 'table', data: { provider: 'durable.failedTriggers' } });
    expect(owed).toMatchObject({ kind: 'table', data: { provider: 'durable.owedLifecycle' } });
    expect(attention?.panels.map((p) => [p.kind, p.title])).toEqual([
      ['topN', 'Top failing workflows'],
      ['table', 'Stuck runs'],
      ['table', 'Failed triggers'],
      ['table', 'Owed lifecycle events'],
      ['table', 'Worker health'],
      ['stat', 'Owed runs'],
    ]);
    expect(attention?.panels.find((p) => p.title === 'Owed runs')).toMatchObject({
      data: { provider: 'durable.owedLifecycle', query: { metric: 'count' } },
    });
    for (const panel of [failed, owed]) {
      const columns = (panel as { columns: Array<{ key: string; link?: { href: string } }> })
        .columns;
      expect(columns.find((c) => c.key === 'runId')?.link?.href).toBe('/ops#/run/{runId}');
    }
    const lifecycle = spec.sections?.find((s) => s.title === 'Lifecycle');
    expect(lifecycle?.panels.map((p) => [p.kind, p.title, p.data.provider])).toEqual([
      ['timeseries', 'Lifecycle triggers over time', 'durable.lifecycleTriggers'],
      ['topN', 'Triggered by subscriber', 'durable.lifecycleTriggers'],
    ]);
  });
});
