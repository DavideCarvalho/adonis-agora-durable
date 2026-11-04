import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { accumulatorRunId } from '../../src/event-accumulators.js';
import type { EngineEvent, WorkflowRun } from '../../src/interfaces.js';
import {
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  runCompletedEvent,
} from '../../src/lifecycle-events.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

async function poll(fn: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const owed = (subscriber: string) => `${LIFECYCLE_OWED_TAG_PREFIX}${subscriber}`;

/** A store whose run reads take a while, so two publishers' read-then-write cycles interleave. */
class SlowReadStore extends InMemoryStateStore {
  override async getRun(runId: string): Promise<WorkflowRun | null> {
    await new Promise((r) => setTimeout(r, 10));
    return super.getRun(runId);
  }
}

function settledRun(id: string, tags: string[], at = 0): WorkflowRun {
  return {
    id,
    workflow: 'ingest',
    workflowVersion: '1',
    status: 'completed',
    input: {},
    output: 'ok',
    tags,
    createdAt: new Date(at),
    updatedAt: new Date(at),
  } as WorkflowRun;
}

describe('concurrent lifecycle publishers', () => {
  it('converge on the right tags with one emission each when their targets are disjoint', async () => {
    const store = new SlowReadStore();
    const a = new WorkflowEngine({ store, instanceId: 'a' });
    const b = new WorkflowEngine({ store, instanceId: 'b' });
    const events: EngineEvent[] = [];
    for (const engine of [a, b]) engine.subscribe((e) => events.push(e));
    a.register('x', '1', async () => 'x', { onEvent: [runCompletedEvent('ingest')] });
    b.register('y', '1', async () => 'y', { onEvent: [runCompletedEvent('ingest')] });
    await Promise.all([a.sweepLifecycleEvents(0), b.sweepLifecycleEvents(0)]);
    await store.createRun(settledRun('i1', [LIFECYCLE_PENDING_TAG, owed('x'), owed('y')]));

    // Past the heal window, so each sweep only publishes the marked run.
    const later = 10 * 60_000;
    await Promise.all([a.sweepLifecycleEvents(later), b.sweepLifecycleEvents(later)]);
    await settle();

    expect((await store.getRun('i1'))?.tags?.sort()).toEqual([
      'durable:triggered:x',
      'durable:triggered:y',
    ]);
    const triggered = events.filter((e) => e.type === 'run.triggered' && e.runId === 'i1');
    expect(triggered.map((e) => (e as { name?: string }).name).sort()).toEqual(['x', 'y']);
  });

  it('emits run.triggered once when the same run is published twice at once', async () => {
    const store = new SlowReadStore();
    const a = new WorkflowEngine({ store, instanceId: 'a' });
    const events: EngineEvent[] = [];
    a.subscribe((e) => events.push(e));
    a.register('x', '1', async () => 'x', { onEvent: [runCompletedEvent('ingest')] });
    await a.sweepLifecycleEvents(0);
    await store.createRun(settledRun('i1', [LIFECYCLE_PENDING_TAG, owed('x')]));

    const later = 10 * 60_000;
    await Promise.all([a.sweepLifecycleEvents(later), a.sweepLifecycleEvents(later)]);
    await settle();

    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:x']);
    expect(events.filter((e) => e.type === 'run.triggered')).toHaveLength(1);
  });

  it('counts an event routed twice into a batch once', async () => {
    const store = new InMemoryStateStore();
    const a = new WorkflowEngine({ store, instanceId: 'a' });
    const b = new WorkflowEngine({ store, instanceId: 'b' });
    const fired: unknown[] = [];
    for (const engine of [a, b]) {
      engine.register('ingest', '1', async () => 'ok');
      engine.register('digest', '1', async (_ctx, input) => void fired.push(input), {
        onEvent: [runCompletedEvent('ingest')],
        eventBatch: { mode: 'batch', maxSize: 2, windowMs: 60_000 },
      });
    }
    await a.sweepLifecycleEvents();
    await b.sweepLifecycleEvents();

    await a.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun(accumulatorRunId('digest'))) !== null);
    await poll(async () => !(await store.getRun('i1'))?.tags?.includes(LIFECYCLE_PENDING_TAG));
    // A batched subscriber leaves no triggered tag, so B's heal routes the same event again.
    await b.sweepLifecycleEvents(Date.now() + 1_000);
    await a.start('ingest', {}, 'i2');
    await poll(async () => fired.length > 0);
    await settle();

    expect(fired).toHaveLength(1);
    const batch = fired[0] as { events: { runId: string }[] };
    expect(batch.events.map((e) => e.runId)).toEqual(['i1', 'i2']);
  });

  it('lets an explicit retry wait for a lifecycle publish holding the settled run', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let fail = true;
    engine.register('wf', '1', async () => {
      if (fail) throw new Error('boom');
      return 'ok';
    });
    await engine.sweepLifecycleEvents();
    await engine.start('wf', {}, 'r1');
    await poll(async () => (await store.getRun('r1'))?.status === 'failed');

    const now = Date.now();
    expect(await store.tryLockRun('r1', 'other#lifecycle#1', now + 30_000, now)).toBe(true);
    setTimeout(() => void store.releaseRunLock('r1', 'other#lifecycle#1'), 50);
    fail = false;
    expect((await engine.resume('r1')).status).toBe('completed');
  });
});
