import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkflowRun } from '../../src/interfaces.js';
import {
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  lifecycleRunId,
  runCompletedEvent,
  runWaitToken,
} from '../../src/lifecycle-events.js';
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

/** A settled `ingest` run marked owed to `subscriber`, created and settled at `at`. */
function settledRun(id: string, subscriber: string, at: number): WorkflowRun {
  return {
    id,
    workflow: 'ingest',
    workflowVersion: '1',
    status: 'completed',
    input: {},
    output: 'ok',
    tags: [LIFECYCLE_PENDING_TAG, owed(subscriber)],
    createdAt: new Date(at),
    updatedAt: new Date(at),
  } as WorkflowRun;
}

describe('lifecycle sweep paging', () => {
  it('reaches a run it can publish behind a full page of runs owed only elsewhere', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let ran = 0;
    engine.register('refresh', '1', async () => void ran++, {
      onEvent: [runCompletedEvent('ingest')],
    });
    // The listing is newest first: the run this engine can publish is the oldest, behind 150 runs
    // owed to a subscriber registered on another instance (and not orphaned yet).
    await store.createRun(settledRun('mine', 'refresh', 1_000));
    for (let i = 0; i < 150; i += 1) {
      await store.createRun(settledRun(`other-${i}`, 'elsewhere', 2_000 + i));
    }

    expect(await engine.sweepLifecycleEvents(120_000)).toBe(1);
    await poll(
      async () =>
        (await store.getRun(lifecycleRunId('mine', 'completed', 'refresh')))?.status ===
        'completed',
    );
    expect(ran).toBe(1);
    expect((await store.getRun('other-0'))?.tags).toEqual([
      LIFECYCLE_PENDING_TAG,
      owed('elsewhere'),
    ]);
  });

  it('stops once it published `limit` runs', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('refresh', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    for (let i = 0; i < 3; i += 1) await store.createRun(settledRun(`mine-${i}`, 'refresh', i));
    for (let i = 0; i < 5; i += 1) {
      await store.createRun(settledRun(`other-${i}`, 'elsewhere', 100 + i));
    }

    expect(await engine.sweepLifecycleEvents(120_000, 2)).toBe(2);
    expect(await engine.sweepLifecycleEvents(120_000, 2)).toBe(1);
    expect(await engine.sweepLifecycleEvents(120_000, 2)).toBe(0);
  });

  it('reads at most 1000 marked runs per tick', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('refresh', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    await store.createRun(settledRun('mine', 'refresh', 0));
    for (let i = 0; i < 1000; i += 1) {
      await store.createRun(settledRun(`other-${i}`, 'elsewhere', 10 + i));
    }
    let reads = 0;
    const list = store.listRuns.bind(store);
    store.listRuns = async (query) => {
      if (query.tag === LIFECYCLE_PENDING_TAG) reads += 1;
      return list(query);
    };

    expect(await engine.sweepLifecycleEvents(120_000)).toBe(0);
    expect(reads).toBe(10);
  });
});

describe('run-wait sweep paging', () => {
  it('wakes a waiter on a settled run behind more than `limit` waiters on runs in flight', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('ingest', '1', async (ctx) => {
      await ctx.waitForSignal(`go:${ctx.runId}`);
      return 'ok';
    });
    engine.register('watcher', '1', async (ctx, input) => {
      const event = await ctx.waitForRun((input as { target: string }).target);
      return event.status;
    });
    for (let i = 0; i < 150; i += 1) {
      const target = `busy-${String(i).padStart(3, '0')}`;
      await store.createRun({
        id: target,
        workflow: 'ingest',
        workflowVersion: '1',
        status: 'running',
        input: {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
      } as WorkflowRun);
      await store.putSignalWaiter({
        token: runWaitToken(target, `idle-${i}`, 0),
        runId: `idle-${i}`,
        seq: 0,
      });
    }
    await engine.start('ingest', {}, 'zz-target');
    expect((await startRun(engine, 'watcher', { target: 'zz-target' }, 'w1')).status).toBe(
      'suspended',
    );
    // The target settles without this engine noticing (another process died after the write).
    await store.updateRun('zz-target', { status: 'completed', output: 'ok' });

    expect(await engine.sweepRunWaits(100)).toBe(1);
    await poll(async () => (await store.getRun('w1'))?.status === 'completed');
  });

  it('starts the next sweep where the last one stopped reading', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('watcher', '1', async (ctx, input) => {
      const event = await ctx.waitForRun((input as { target: string }).target);
      return event.status;
    });
    for (let i = 0; i < 1000; i += 1) {
      const target = `busy-${String(i).padStart(4, '0')}`;
      await store.createRun({
        id: target,
        workflow: 'ingest',
        workflowVersion: '1',
        status: 'running',
        input: {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
      } as WorkflowRun);
      await store.putSignalWaiter({
        token: runWaitToken(target, `idle-${i}`, 0),
        runId: `idle-${i}`,
        seq: 0,
      });
    }
    await store.createRun({
      id: 'zz-target',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'running',
      input: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as WorkflowRun);
    expect((await startRun(engine, 'watcher', { target: 'zz-target' }, 'w1')).status).toBe(
      'suspended',
    );
    await store.updateRun('zz-target', { status: 'completed', output: 'ok' });

    // 1001 waited-on runs: the first sweep reads 1000 of them, the next one the rest.
    expect(await engine.sweepRunWaits(100)).toBe(0);
    expect(await engine.sweepRunWaits(100)).toBe(1);
    await poll(async () => (await store.getRun('w1'))?.status === 'completed');
  });
});
