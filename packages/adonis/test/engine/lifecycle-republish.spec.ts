import { describe, expect, it } from 'vitest';
import { renderRepublishResult, republishLifecycleTarget } from '../../src/commands/runs.js';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import { republishLifecycleRun } from '../../src/dashboard/handlers.js';
import { WorkflowEngine } from '../../src/engine.js';
import { FatalError } from '../../src/errors.js';
import type { WorkflowRun } from '../../src/interfaces.js';
import {
  LIFECYCLE_HEAL_WINDOW_MS,
  lifecycleRunId,
  runCompletedEvent,
  runFailedEvent,
  triggeredRunsOf,
} from '../../src/lifecycle-events.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

async function poll(fn: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

const settle = () => new Promise((r) => setTimeout(r, 30));

/** An engine with three settled `ingest` runs (two completed, one failed) and no subscriber yet. */
async function setup() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  engine.register('ingest', '1', async (_ctx, input) => {
    if ((input as { fail?: boolean }).fail) throw new FatalError('bad file');
    return 'ok';
  });
  for (const [id, input] of [
    ['i1', {}],
    ['i2', {}],
    ['i3', { fail: true }],
  ] as const) {
    await engine.start('ingest', input, id);
    await poll(async () =>
      ['completed', 'failed'].includes((await store.getRun(id))?.status ?? ''),
    );
  }
  await settle();
  return { store, engine };
}

describe('engine.republishLifecycle', () => {
  it('backfills a subscriber registered after the runs settled, once', async () => {
    const { store, engine } = await setup();
    const ran: string[] = [];
    engine.register(
      'refresh',
      '1',
      async (_ctx, e) => void ran.push((e as { runId: string }).runId),
      {
        onEvent: [runCompletedEvent('ingest')],
      },
    );

    expect(await engine.republishLifecycle({ workflow: 'ingest' })).toEqual({
      runs: 3,
      started: 2,
      failed: [],
    });
    await poll(async () => ran.length === 2);
    expect(ran.sort()).toEqual(['i1', 'i2']);
    expect(triggeredRunsOf((await store.getRun('i1')) as WorkflowRun)).toEqual([
      lifecycleRunId('i1', 'completed', 'refresh'),
    ]);

    expect(await engine.republishLifecycle({ workflow: 'ingest' })).toEqual({
      runs: 3,
      started: 0,
      failed: [],
    });
    await settle();
    expect(ran).toHaveLength(2);
  });

  it('restricts to one subscriber, one run, and one ending', async () => {
    const { store, engine } = await setup();
    engine.register('a', '1', async () => 'a', { onEvent: [runCompletedEvent('ingest')] });
    engine.register('b', '1', async () => 'b', { onEvent: [runCompletedEvent('ingest')] });
    engine.register('alert', '1', async () => 'alert', { onEvent: [runFailedEvent('ingest')] });

    expect(await engine.republishLifecycle({ runId: 'i1', subscriber: 'a' })).toMatchObject({
      runs: 1,
      started: 1,
    });
    expect(await store.getRun(lifecycleRunId('i1', 'completed', 'a'))).not.toBeNull();
    expect(await store.getRun(lifecycleRunId('i1', 'completed', 'b'))).toBeNull();

    expect(await engine.republishLifecycle({ workflow: 'ingest', kind: 'failed' })).toEqual({
      runs: 1,
      started: 1,
      failed: [],
    });
    expect(await store.getRun(lifecycleRunId('i3', 'failed', 'alert'))).not.toBeNull();
    expect(await engine.republishLifecycle({ workflow: 'ingest', limit: 1 })).toMatchObject({
      runs: 1,
    });
  });

  it('selects runs by when they settled', async () => {
    const { engine } = await setup();
    engine.register('a', '1', async () => 'a', { onEvent: [runCompletedEvent('ingest')] });
    const future = new Date(Date.now() + 60_000);
    expect(await engine.republishLifecycle({ workflow: 'ingest', since: future })).toEqual({
      runs: 0,
      started: 0,
      failed: [],
    });
    expect(
      await engine.republishLifecycle({ workflow: 'ingest', until: new Date(0) }),
    ).toMatchObject({ runs: 0 });
    expect(await engine.republishLifecycle({ workflow: 'ingest', until: future })).toMatchObject({
      runs: 3,
      started: 2,
    });
  });

  it('reports a subscriber it could not start, and marks one registered elsewhere as owed', async () => {
    const { store, engine } = await setup();
    engine.register('strict', '1', async () => 'ran', {
      onEvent: [runCompletedEvent('ingest')],
      validateInput: () => {
        throw new Error('bad input');
      },
    });

    expect(await engine.republishLifecycle({ runId: 'i1' })).toEqual({
      runs: 1,
      started: 0,
      failed: [{ runId: 'i1', subscriber: 'strict', error: 'bad input' }],
    });
    // `elsewhere` is registered on another instance, which announces it in the registry.
    const other = new WorkflowEngine({ store });
    other.register('elsewhere', '1', async () => 'ran', { onEvent: [runCompletedEvent('ingest')] });
    await other.sweepLifecycleEvents(Date.now() + LIFECYCLE_HEAL_WINDOW_MS + 60_000);
    await engine.sweepLifecycleEvents(Date.now() + LIFECYCLE_HEAL_WINDOW_MS + 60_000);
    expect(await engine.republishLifecycle({ runId: 'i1', subscriber: 'elsewhere' })).toEqual({
      runs: 1,
      started: 0,
      failed: [],
    });
    expect((await store.getRun('i1'))?.tags).toEqual([
      'durable:trigger_failed:strict',
      'durable:lifecycle:owed:elsewhere',
      'durable:lifecycle:pending',
    ]);
  });

  it('refuses a subscriber that does not subscribe, and marks nothing', async () => {
    const { store, engine } = await setup();
    const before = (await store.getRun('i1'))?.tags;
    expect(await engine.republishLifecycle({ runId: 'i1', subscriber: 'nobody' })).toEqual({
      runs: 1,
      started: 0,
      failed: [
        {
          runId: 'i1',
          subscriber: 'nobody',
          error: 'subscriber nobody does not subscribe to run.completed:ingest',
        },
      ],
    });
    expect(
      await engine.republishLifecycle({
        workflow: 'ingest',
        kind: 'completed',
        subscriber: 'nobody',
      }),
    ).toMatchObject({ runs: 2, started: 0 });
    expect((await store.getRun('i1'))?.tags).toEqual(before);
    expect((await store.getRun('i2'))?.tags ?? []).not.toContain('durable:lifecycle:owed:nobody');
  });

  it('publishes nothing for an unknown or unsettled run', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wait', '1', async (ctx) => ctx.waitForSignal('go'));
    engine.register('a', '1', async () => 'a', { onEvent: [runCompletedEvent('wait')] });
    await engine.start('wait', {}, 'w1');
    expect(await engine.republishLifecycle({ runId: 'missing' })).toEqual({
      runs: 0,
      started: 0,
      failed: [],
    });
    expect(await engine.republishLifecycle({ runId: 'w1' })).toMatchObject({ runs: 0 });
  });
});

describe('POST /runs/:id/republish-lifecycle', () => {
  it('republishes a settled run and answers with the result', async () => {
    const { engine } = await setup();
    engine.register('a', '1', async () => 'a', { onEvent: [runCompletedEvent('ingest')] });
    const deps = { engine: storeDashboardEngine(engine) };

    const res = await republishLifecycleRun(deps, { params: { id: 'i1' }, query: {} });
    expect(res).toEqual({ status: 200, body: { result: { runs: 1, started: 1, failed: [] } } });
    expect((await republishLifecycleRun(deps, { params: { id: 'nope' }, query: {} })).status).toBe(
      404,
    );
    expect(
      (
        await republishLifecycleRun(deps, {
          params: { id: 'i1' },
          query: {},
          body: { subscriber: 1 },
        })
      ).status,
    ).toBe(400);
  });

  it('refuses a run that has not settled, and reports the subscribers on the run detail', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wait', '1', async (ctx) => ctx.waitForSignal('go'));
    engine.register('a', '1', async () => 'a', { onEvent: [runCompletedEvent('wait')] });
    await engine.start('wait', {}, 'w1');
    const deps = { engine: storeDashboardEngine(engine) };
    expect((await republishLifecycleRun(deps, { params: { id: 'w1' }, query: {} })).status).toBe(
      409,
    );

    await engine.signal('go', {});
    await poll(async () => (await store.getRun('w1'))?.status === 'completed');
    expect((await engine.getRunDetail('w1'))?.lifecycleSubscribers).toEqual(['a']);
  });
});

describe('durable:lifecycle:republish flags', () => {
  it('builds a run or workflow target', () => {
    expect(republishLifecycleTarget({ run: 'i1', subscriber: 'a' })).toEqual({
      runId: 'i1',
      subscriber: 'a',
    });
    expect(
      republishLifecycleTarget({
        workflow: 'ingest',
        since: '2026-01-01',
        until: '2026-02-01T00:00:00Z',
        kind: 'failed',
        limit: 10,
      }),
    ).toEqual({
      workflow: 'ingest',
      kind: 'failed',
      since: new Date('2026-01-01'),
      until: new Date('2026-02-01T00:00:00Z'),
      limit: 10,
    });
  });

  it('rejects flags that name no target, or both, or a bad date or kind', () => {
    expect(republishLifecycleTarget({})).toEqual({ error: 'pass --run <id> or --workflow <name>' });
    expect(republishLifecycleTarget({ run: 'i1', workflow: 'w' })).toHaveProperty('error');
    expect(republishLifecycleTarget({ run: 'i1', since: '2026-01-01' })).toHaveProperty('error');
    expect(republishLifecycleTarget({ workflow: 'w', since: 'yesterday' })).toEqual({
      error: '--since is not a date: yesterday',
    });
    expect(republishLifecycleTarget({ workflow: 'w', kind: 'dead' })).toHaveProperty('error');
  });

  it('renders the result', () => {
    expect(
      renderRepublishResult({
        runs: 2,
        started: 1,
        failed: [{ runId: 'i1', subscriber: 'a', error: 'boom' }],
      }),
    ).toBe('Republished 2 run(s): started 1 subscriber run(s), 1 failed.\n  i1 -> a: boom');
  });
});
