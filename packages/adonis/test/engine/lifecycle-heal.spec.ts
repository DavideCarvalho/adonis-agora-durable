import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { RunQuery, WorkflowRun } from '../../src/interfaces.js';
import {
  LIFECYCLE_HEAL_WINDOW_MS,
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  LIFECYCLE_REGISTRY_TAG,
  LIFECYCLE_REGISTRY_WORKFLOW,
  lifecycleRegistryRunId,
  lifecycleRunId,
  runCompletedEvent,
} from '../../src/lifecycle-events.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

async function poll(fn: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const owed = (subscriber: string) => `${LIFECYCLE_OWED_TAG_PREFIX}${subscriber}`;

/** A store whose reads of the lifecycle subscription registry fail while `failing` is set. */
class FlakyRegistryStore extends InMemoryStateStore {
  failing = false;
  override async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    if (this.failing && query.workflow === LIFECYCLE_REGISTRY_WORKFLOW) {
      throw new Error('registry unreadable');
    }
    return super.listRuns(query);
  }
}

/** Every tag list the terminal status write of `runId` carried. */
function terminalTags(store: InMemoryStateStore, runId: string): string[][] {
  const seen: string[][] = [];
  const updateRunIf = store.updateRunIf.bind(store);
  store.updateRunIf = async (id, statuses, patch) => {
    if (id === runId && (patch.status === 'completed' || patch.status === 'failed')) {
      seen.push([...(patch.tags ?? [])]);
    }
    return updateRunIf(id, statuses, patch);
  };
  return seen;
}

describe('lifecycle events settled before the fleet is visible', () => {
  it('marks a run settled before the first read unresolved, and resolves it on publish', async () => {
    const store = new InMemoryStateStore();
    const b = new WorkflowEngine({ store, instanceId: 'b' });
    let ranY = 0;
    b.register('y', '1', async () => void ranY++, { onEvent: [runCompletedEvent('ingest')] });
    await b.sweepLifecycleEvents();

    // A has never read the fleet when its run settles.
    const a = new WorkflowEngine({ store, instanceId: 'a' });
    a.register('ingest', '1', async () => 'ok');
    const written = terminalTags(store, 'i1');
    await a.start('ingest', {}, 'i1');
    await poll(async () => written.length > 0);
    expect(written).toEqual([[LIFECYCLE_PENDING_TAG]]);

    // A's live publish reads the fleet and owes the event to B's subscriber.
    await poll(async () => (await store.getRun('i1'))?.tags?.includes(owed('y')) ?? false);
    expect((await store.getRun('i1'))?.tags?.sort()).toEqual([owed('y'), LIFECYCLE_PENDING_TAG]);

    await b.sweepLifecycleEvents(Date.now() + 31_000);
    await poll(async () => ranY === 1);
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:y']);
    await b.sweepLifecycleEvents(Date.now() + 31_000);
    await settle();
    expect(ranY).toBe(1);
  });

  it('keeps a run unresolved while the read fails, then resolves it from the sweep', async () => {
    const store = new FlakyRegistryStore();
    const b = new WorkflowEngine({ store, instanceId: 'b' });
    const ran = { x: 0, y: 0 };
    b.register('y', '1', async () => void ran.y++, { onEvent: [runCompletedEvent('ingest')] });
    await b.sweepLifecycleEvents();

    store.failing = true;
    const a = new WorkflowEngine({ store, instanceId: 'a' });
    a.register('ingest', '1', async () => 'ok');
    a.register('x', '1', async () => void ran.x++, { onEvent: [runCompletedEvent('ingest')] });
    await a.sweepLifecycleEvents();
    await a.start('ingest', {}, 'i1');

    // A starts its own subscriber, and the run stays unresolved for the one it cannot see.
    await poll(async () => ran.x === 1);
    await poll(
      async () => (await store.getRun('i1'))?.tags?.includes('durable:triggered:x') ?? false,
    );
    expect((await store.getRun('i1'))?.tags?.sort()).toEqual([
      LIFECYCLE_PENDING_TAG,
      'durable:triggered:x',
    ]);

    store.failing = false;
    const later = Date.now() + 31_000;
    await a.sweepLifecycleEvents(later);
    expect((await store.getRun('i1'))?.tags?.sort()).toEqual([
      owed('y'),
      LIFECYCLE_PENDING_TAG,
      'durable:triggered:x',
    ]);
    await b.sweepLifecycleEvents(later);
    await poll(async () => ran.y === 1);
    await settle();
    expect((await store.getRun('i1'))?.tags?.sort()).toEqual([
      'durable:triggered:x',
      'durable:triggered:y',
    ]);
    expect(ran).toEqual({ x: 1, y: 1 });
  });

  it('heals a subscriber announced a few seconds after the run settled', async () => {
    const store = new InMemoryStateStore();
    const a = new WorkflowEngine({ store, instanceId: 'a' });
    a.register('ingest', '1', async () => 'ok');
    await a.sweepLifecycleEvents();
    await a.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();
    // Nobody subscribed when it settled: no marker.
    expect((await store.getRun('i1'))?.tags ?? []).toEqual([]);

    const b = new WorkflowEngine({ store, instanceId: 'b' });
    let ranY = 0;
    b.register('y', '1', async () => void ranY++, { onEvent: [runCompletedEvent('ingest')] });
    await b.sweepLifecycleEvents(Date.now() + 5_000);
    await poll(async () => ranY === 1);
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:y']);
    expect(await store.getRun(lifecycleRunId('i1', 'completed', 'y'))).not.toBeNull();

    await b.sweepLifecycleEvents(Date.now() + 10_000);
    await a.sweepLifecycleEvents(Date.now() + 10_000);
    await settle();
    expect(ranY).toBe(1);
  });

  it('heals a subscriber registered elsewhere by owing it the event', async () => {
    const store = new InMemoryStateStore();
    let now = Date.now();
    const a = new WorkflowEngine({ store, instanceId: 'a', clock: () => now });
    a.register('ingest', '1', async () => 'ok');
    await a.sweepLifecycleEvents();
    await a.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();

    const b = new WorkflowEngine({ store, instanceId: 'b' });
    let ranY = 0;
    b.register('y', '1', async () => void ranY++, { onEvent: [runCompletedEvent('ingest')] });
    await b.heartbeatLifecycleRegistry();
    // A heals it once its snapshot is read again, past the TTL: owed, for B's sweep.
    now += 6_000;
    await a.sweepLifecycleEvents(now);
    expect((await store.getRun('i1'))?.tags?.sort()).toEqual([owed('y'), LIFECYCLE_PENDING_TAG]);
    expect(ranY).toBe(0);
  });

  it('does not heal a run settled before the heal window: that is a republish backfill', async () => {
    const store = new InMemoryStateStore();
    const settledAt = Date.now() - LIFECYCLE_HEAL_WINDOW_MS - 60_000;
    await store.createRun({
      id: 'old',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      output: 'ok',
      tags: [],
      createdAt: new Date(settledAt),
      updatedAt: new Date(settledAt),
    } as WorkflowRun);
    const b = new WorkflowEngine({ store });
    let ranY = 0;
    b.register('y', '1', async () => void ranY++, { onEvent: [runCompletedEvent('ingest')] });
    await b.sweepLifecycleEvents();
    await settle();
    expect(ranY).toBe(0);
    expect((await store.getRun('old'))?.tags).toEqual([]);

    expect(await b.republishLifecycle({ runId: 'old' })).toEqual({
      runs: 1,
      started: 1,
      failed: [],
    });
    await poll(async () => ranY === 1);
  });

  it('reads every row of a registry larger than one page', async () => {
    const store = new InMemoryStateStore();
    const at = Date.now();
    for (let i = 0; i < 1001; i += 1) {
      const subscriber = `sub-${String(i).padStart(4, '0')}`;
      await store.createRun({
        id: lifecycleRegistryRunId(`engine-${i}`),
        workflow: LIFECYCLE_REGISTRY_WORKFLOW,
        workflowVersion: '1',
        status: 'completed',
        input: {
          instanceId: `engine-${i}`,
          runtime: 'node',
          engineNamespace: null,
          subscriptions: [{ workflow: subscriber, events: [runCompletedEvent('ingest')] }],
        },
        tags: [LIFECYCLE_REGISTRY_TAG],
        createdAt: new Date(at - i),
        updatedAt: new Date(at - i),
      } as WorkflowRun);
    }
    const engine = new WorkflowEngine({ store });
    await engine.sweepLifecycleEvents();
    const subscribers = engine.lifecycleSubscribers('ingest', 'completed');
    expect(subscribers).toHaveLength(1001);
    expect(subscribers).toContain('sub-1000');
  });
});
