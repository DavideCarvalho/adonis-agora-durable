import { describe, expect, it } from 'vitest';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import { getRun, workflowLifecycle } from '../../src/dashboard/handlers.js';
import { WorkflowEngine } from '../../src/engine.js';
import { accumulatorRunId } from '../../src/event-accumulators.js';
import type { WorkflowRun } from '../../src/interfaces.js';
import {
  LIFECYCLE_ORPHAN_MS,
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  LIFECYCLE_REGISTRY_TAG,
  LIFECYCLE_REGISTRY_WORKFLOW,
  LIFECYCLE_TRACE_TAG_PREFIX,
  LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX,
  LIFECYCLE_TRIGGERED_TAG_PREFIX,
  lifecycleDeliveriesOf,
  lifecycleRegistryRunId,
  lifecycleRunId,
  runCompletedEvent,
} from '../../src/lifecycle-events.js';
import { collectMetrics } from '../../src/metrics.js';
import { classifyWaiterToken, resolveRunWaiting } from '../../src/run-waiting.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

async function poll(fn: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

const owed = (subscriber: string) => `${LIFECYCLE_OWED_TAG_PREFIX}${subscriber}`;
const triggered = (subscriber: string) => `${LIFECYCLE_TRIGGERED_TAG_PREFIX}${subscriber}`;

function settledRun(tags: string[], updatedAt = new Date(1_000_000)): WorkflowRun {
  return {
    id: 'r1',
    workflow: 'ingest',
    workflowVersion: '1',
    status: 'completed',
    input: {},
    tags,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('lifecycleDeliveriesOf', () => {
  it('names each subscriber’s state, sorted, from the subscribers and the run’s tags', () => {
    const run = settledRun([triggered('a'), owed('b'), owed('gone'), LIFECYCLE_PENDING_TAG]);
    expect(
      lifecycleDeliveriesOf(run, {
        subscribers: ['a', 'b', 'c', 'd'],
        live: new Set(['a', 'b', 'c', 'd']),
        coalesced: new Map([['c', accumulatorRunId('c')]]),
      }),
    ).toEqual([
      { subscriber: 'a', state: 'started', runId: lifecycleRunId('r1', 'completed', 'a') },
      { subscriber: 'b', state: 'owed', owedSince: 1_000_000 },
      { subscriber: 'c', state: 'coalesced', runId: '__evtacc__:c' },
      { subscriber: 'd', state: 'not-started' },
      {
        subscriber: 'gone',
        state: 'owed',
        owedSince: 1_000_000,
        orphanAt: 1_000_000 + LIFECYCLE_ORPHAN_MS,
      },
    ]);
  });

  it('names a subscriber with a trigger-failed tag failed, unless it started or is owed again', () => {
    const failed = (subscriber: string) => `${LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX}${subscriber}`;
    const run = settledRun([
      failed('a'),
      failed('b'),
      triggered('b'),
      failed('c'),
      owed('c'),
      LIFECYCLE_PENDING_TAG,
      failed('gone'),
    ]);
    expect(
      lifecycleDeliveriesOf(run, { subscribers: ['a', 'b', 'c'], live: new Set(['a', 'b', 'c']) }),
    ).toEqual([
      { subscriber: 'a', state: 'failed' },
      { subscriber: 'b', state: 'started', runId: lifecycleRunId('r1', 'completed', 'b') },
      { subscriber: 'c', state: 'owed', owedSince: 1_000_000 },
      { subscriber: 'gone', state: 'failed' },
    ]);
  });

  it('reads a run marked pending without owed tags as owed to every subscriber it did not start', () => {
    const run = settledRun([LIFECYCLE_PENDING_TAG, triggered('a')]);
    expect(
      lifecycleDeliveriesOf(run, { subscribers: ['a', 'b'], live: new Set(['a', 'b']) }).map(
        (d) => d.state,
      ),
    ).toEqual(['started', 'owed']);
  });

  it('leaves out a coalesced accumulator id it could not derive, and answers nothing before settling', () => {
    expect(
      lifecycleDeliveriesOf(settledRun([]), {
        subscribers: ['c'],
        live: new Set(['c']),
        coalesced: new Map([['c', undefined]]),
      }),
    ).toEqual([{ subscriber: 'c', state: 'coalesced' }]);
    expect(
      lifecycleDeliveriesOf(
        { ...settledRun([owed('b')]), status: 'running' },
        { subscribers: ['b'], live: new Set() },
      ),
    ).toEqual([]);
  });
});

/** An engine where `ingest` completes once signalled `go:<runId>`, and `watcher` waits for a run. */
function waitSetup() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  engine.register('ingest', '1', async (ctx) => ctx.waitForSignal(`go:${ctx.runId}`));
  engine.register('watcher', '1', async (ctx, input) =>
    ctx.waitForRun((input as { target: string }).target),
  );
  return { store, engine };
}

describe('run detail: ctx.waitForRun links', () => {
  it('lists the run a suspended run waits for, and the runs waiting for a run, with statuses', async () => {
    const { store, engine } = waitSetup();
    await engine.start('ingest', {}, 'i1');
    await startRun(engine, 'watcher', { target: 'i1' }, 'w1');
    await startRun(engine, 'watcher', { target: 'i1' }, 'w2');

    const waiting = await engine.getRunDetail('w1');
    expect(waiting?.waitsFor).toEqual([
      { runId: 'i1', seq: expect.any(Number), status: 'suspended', namespace: 'default' },
    ]);
    expect(waiting).not.toHaveProperty('awaitedBy');
    const target = await engine.getRunDetail('i1');
    expect(target?.awaitedBy?.map((l) => [l.runId, l.status]).sort()).toEqual([
      ['w1', 'suspended'],
      ['w2', 'suspended'],
    ]);
    expect(target).not.toHaveProperty('waitsFor');

    await engine.signal('go:i1', {});
    await poll(async () => (await store.getRun('w1'))?.status === 'completed');
    await poll(async () => (await store.getRun('w2'))?.status === 'completed');
    expect(await engine.getRunDetail('w1')).not.toHaveProperty('waitsFor');
    expect(await engine.getRunDetail('i1')).not.toHaveProperty('awaitedBy');
  });

  it('names a ctx.waitForRun wait in the run list as waiting on the run', async () => {
    const { store, engine } = waitSetup();
    await engine.start('ingest', {}, 'i1');
    await startRun(engine, 'watcher', { target: 'i1' }, 'w1');
    const [waiter] = await store.listSignalWaitersByRunIds(['w1']);
    const run = (await store.getRun('w1')) as WorkflowRun;
    expect(resolveRunWaiting(run, new Map([['w1', waiter as never]]))).toEqual({
      on: 'run',
      name: 'i1',
    });
    expect(classifyWaiterToken('approve')).toEqual({ on: 'signal', name: 'approve' });
  });

  it('serves the links through GET /runs/:id', async () => {
    const { engine } = waitSetup();
    await engine.start('ingest', {}, 'i1');
    await startRun(engine, 'watcher', { target: 'i1' }, 'w1');
    const deps = { engine: storeDashboardEngine(engine) };
    const res = await getRun(deps, { params: { id: 'w1' }, query: {} });
    expect((res.body as { waitsFor: unknown[] }).waitsFor).toEqual([
      expect.objectContaining({ runId: 'i1', status: 'suspended' }),
    ]);
    const target = await getRun(deps, { params: { id: 'i1' }, query: {} });
    expect((target.body as { awaitedBy: unknown[] }).awaitedBy).toEqual([
      expect.objectContaining({ runId: 'w1' }),
    ]);
  });
});

describe('run detail: lifecycle deliveries', () => {
  it('shows each subscriber started, coalesced, declined or owed, with the started run’s status', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, instanceId: 'me' });
    engine.register('ingest', '1', async () => 'ok');
    engine.register('notify', '1', async (ctx) => ctx.waitForSignal('release'), {
      onEvent: [runCompletedEvent('ingest')],
    });
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [{ event: runCompletedEvent('ingest'), input: () => ({ base: 'b1' }) }],
      eventBatch: {
        mode: 'debounce',
        windowMs: 60_000,
        key: (input) => (input as { base: string }).base,
      },
    });
    engine.register('picky', '1', async () => 'never', {
      onEvent: [{ event: runCompletedEvent('ingest'), where: () => false }],
    });
    // A subscriber another live engine announces, which this one cannot start.
    await store.createRun({
      id: lifecycleRegistryRunId('other'),
      workflow: LIFECYCLE_REGISTRY_WORKFLOW,
      workflowVersion: '1',
      status: 'completed',
      input: {
        instanceId: 'other',
        runtime: 'node',
        engineNamespace: null,
        subscriptions: [{ workflow: 'elsewhere', events: [runCompletedEvent('ingest')] }],
      },
      tags: [LIFECYCLE_REGISTRY_TAG],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await engine.sweepLifecycleEvents();

    await startRun(engine, 'ingest', {}, 'i1');
    const notifyRun = lifecycleRunId('i1', 'completed', 'notify');
    await poll(async () => (await store.getRun(notifyRun))?.status === 'suspended');
    await poll(async () => !(await store.getRun('i1'))?.tags?.includes(owed('notify')));

    const detail = await engine.getRunDetail('i1');
    expect(detail?.lifecycleSubscribers).toEqual(['elsewhere', 'notify', 'picky', 'refresh']);
    expect(detail?.lifecycleDeliveries).toEqual([
      {
        subscriber: 'elsewhere',
        state: 'owed',
        owedSince: expect.any(Number),
      },
      {
        subscriber: 'notify',
        state: 'started',
        runId: notifyRun,
        status: 'suspended',
        namespace: 'default',
      },
      { subscriber: 'picky', state: 'not-started' },
      { subscriber: 'refresh', state: 'coalesced', runId: accumulatorRunId('refresh', 'b1') },
    ]);
  });

  it('gives an owed subscriber nothing announces the instant the sweep drops it', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const settledAt = new Date(Date.now() - 60_000);
    await store.createRun({
      ...settledRun([LIFECYCLE_PENDING_TAG, owed('gone')], settledAt),
      id: 'old',
    });
    const detail = await engine.getRunDetail('old');
    expect(detail?.lifecycleDeliveries).toEqual([
      {
        subscriber: 'gone',
        state: 'owed',
        owedSince: settledAt.getTime(),
        orphanAt: settledAt.getTime() + LIFECYCLE_ORPHAN_MS,
      },
    ]);
  });

  it('names a subscriber run’s source with its status and the trace id it recorded', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('ingest', '1', async () => 'ok');
    engine.register('notify', '1', async () => 'sent', {
      onEvent: [runCompletedEvent('ingest')],
    });
    await startRun(engine, 'ingest', {}, 'i1');
    const notifyRun = lifecycleRunId('i1', 'completed', 'notify');
    await poll(async () => (await store.getRun(notifyRun))?.status === 'completed');

    expect((await engine.getRunDetail(notifyRun))?.triggeredBy).toEqual({
      runId: 'i1',
      kind: 'completed',
      status: 'completed',
      namespace: 'default',
    });
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const tags = (await store.getRun('i1'))?.tags ?? [];
    await store.updateRun('i1', {
      tags: [...tags, `${LIFECYCLE_TRACE_TAG_PREFIX}00-${traceId}-00f067aa0ba902b7-01`],
    });
    expect((await engine.getRunDetail(notifyRun))?.triggeredBy?.traceId).toBe(traceId);
  });

  it('changes the detail’s ETag when a linked run changes, and answers 304 while nothing does', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('ingest', '1', async () => 'ok');
    engine.register('notify', '1', async (ctx) => ctx.waitForSignal('release'), {
      onEvent: [runCompletedEvent('ingest')],
    });
    await startRun(engine, 'ingest', {}, 'i1');
    const notifyRun = lifecycleRunId('i1', 'completed', 'notify');
    await poll(async () => (await store.getRun(notifyRun))?.status === 'suspended');
    await poll(async () =>
      Boolean((await store.getRun('i1'))?.tags?.includes(triggered('notify'))),
    );

    const first = await engine.getRunDetail('i1', { summarizeFansOver: 50 });
    expect(first?.etag).toBeDefined();
    const again = await engine.getRunDetail('i1', {
      summarizeFansOver: 50,
      ifNoneMatch: first?.etag as string,
    });
    expect(again?.notModified).toBe(true);
    expect(again?.etag).toBe(first?.etag);

    await engine.signal('release', {});
    await poll(async () => (await store.getRun(notifyRun))?.status === 'completed');
    const changed = await engine.getRunDetail('i1', {
      summarizeFansOver: 50,
      ifNoneMatch: first?.etag as string,
    });
    expect(changed?.notModified).toBeUndefined();
    expect(changed?.etag).not.toBe(first?.etag);
    expect(changed?.lifecycleDeliveries?.[0]?.status).toBe('completed');
  });
});

describe('GET /workflows/:name/lifecycle trigger counts', () => {
  it('adds per-subscriber started and failed counts from the process metrics', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const metrics = collectMetrics(engine);
    engine.register('ingest', '1', async () => 'ok');
    engine.register('notify', '1', async () => 'sent', {
      onEvent: [runCompletedEvent('ingest')],
    });
    engine.register('strict', '1', async () => 'never', {
      onEvent: [runCompletedEvent('ingest')],
      validateInput: () => {
        throw new Error('rejected');
      },
    });
    await startRun(engine, 'ingest', {}, 'i1');
    await poll(async () => metrics.snapshot().runs.triggerFailed === 1);
    await poll(async () => metrics.snapshot().runs.triggered === 1);

    const res = await workflowLifecycle(
      { engine: storeDashboardEngine(engine), metrics },
      { params: { name: 'ingest' }, query: {} },
    );
    expect((res.body as { triggerCounts: unknown }).triggerCounts).toEqual({
      notify: { triggered: 1, failed: 0 },
      strict: { triggered: 0, failed: 1 },
    });
    expect(metrics.prometheus()).toContain(
      'durable_runs_trigger_failed_total{workflow="ingest",subscriber="strict"} 1',
    );
    const bare = await workflowLifecycle(
      { engine: storeDashboardEngine(engine) },
      { params: { name: 'ingest' }, query: {} },
    );
    expect(bare.body).not.toHaveProperty('triggerCounts');
    metrics.stop();
  });
});
