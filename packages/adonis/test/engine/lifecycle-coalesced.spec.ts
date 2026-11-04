import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { accumulatorRunId } from '../../src/event-accumulators.js';
import type { EngineEvent, WorkflowRun } from '../../src/interfaces.js';
import {
  coalescedSubscribersOf,
  deliveredSubscribersOf,
  isLifecycleTag,
  LIFECYCLE_COALESCED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  lifecycleCoalescedTag,
  lifecycleDeliveriesOf,
  lifecycleEventOf,
  lifecycleOwedTag,
  lifecycleTriggerFailedTag,
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

function settledRun(id: string, tags: string[], at = Date.now()): WorkflowRun {
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

/** An engine with `digest` batching `ingest`'s completions, counting what it routes and emits. */
function batchingEngine(store: InMemoryStateStore, instanceId: string) {
  const engine = new WorkflowEngine({ store, instanceId });
  engine.register('ingest', '1', async () => 'ok');
  engine.register('digest', '1', async () => 'digested', {
    onEvent: [runCompletedEvent('ingest')],
    eventBatch: { mode: 'batch', maxSize: 50, windowMs: 60_000 },
  });
  const routed: string[] = [];
  const accumulators = (engine as unknown as { accumulators: { route: Function } }).accumulators;
  const route = accumulators.route.bind(accumulators);
  accumulators.route = (workflow: string, ...rest: unknown[]) => {
    routed.push(workflow);
    return route(workflow, ...rest);
  };
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  const triggered = () =>
    events.filter((e) => e.type === 'run.triggered').map((e) => (e as { name?: string }).name);
  return { engine, routed, triggered };
}

describe('coalesced lifecycle deliveries', () => {
  it('tags a live delivery into an accumulator and emits run.triggered once', async () => {
    const store = new InMemoryStateStore();
    const a = batchingEngine(store, 'a');
    await a.engine.sweepLifecycleEvents();
    await a.engine.start('ingest', {}, 'i1');
    await poll(async () => !(await store.getRun('i1'))?.tags?.includes(LIFECYCLE_PENDING_TAG));
    await settle();

    expect((await store.getRun('i1'))?.tags).toEqual([lifecycleCoalescedTag('digest')]);
    expect(a.routed).toEqual(['digest']);
    expect(a.triggered()).toEqual(['digest']);
    expect(await store.getRun(accumulatorRunId('digest'))).not.toBeNull();
  });

  it('heals a coalescing subscriber with one route and one run.triggered', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(settledRun('i1', []));
    const b = batchingEngine(store, 'b');

    await b.engine.sweepLifecycleEvents(Date.now() + 1_000);
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual([lifecycleCoalescedTag('digest')]);
    expect(b.routed).toEqual(['digest']);
    expect(b.triggered()).toEqual(['digest']);

    await b.engine.sweepLifecycleEvents(Date.now() + 2_000);
    await settle();
    expect(b.routed).toEqual(['digest']);
    expect(b.triggered()).toEqual(['digest']);
  });

  it('does not heal a run already tagged coalesced, even on a freshly booted instance', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(settledRun('i1', [lifecycleCoalescedTag('digest')]));
    const c = batchingEngine(store, 'c');

    await c.engine.sweepLifecycleEvents(Date.now() + 1_000);
    await settle();
    expect(c.routed).toEqual([]);
    expect(c.triggered()).toEqual([]);
    expect((await store.getRun('i1'))?.tags).toEqual([lifecycleCoalescedTag('digest')]);
  });

  it('republishes to a coalescing subscriber only when it has no coalesced tag or failed', async () => {
    const store = new InMemoryStateStore();
    const old = Date.now() - 60 * 60_000;
    await store.createRun(settledRun('done', [lifecycleCoalescedTag('digest')], old));
    await store.createRun(settledRun('failed', [lifecycleTriggerFailedTag('digest')], old));
    await store.createRun(
      settledRun(
        'both',
        [lifecycleCoalescedTag('digest'), lifecycleTriggerFailedTag('digest')],
        old,
      ),
    );
    const a = batchingEngine(store, 'a');

    expect(await a.engine.republishLifecycle({ runId: 'done' })).toEqual({
      runs: 1,
      started: 0,
      failed: [],
    });
    expect(a.routed).toEqual([]);
    expect((await store.getRun('done'))?.tags).toEqual([lifecycleCoalescedTag('digest')]);

    await a.engine.republishLifecycle({ runId: 'failed' });
    expect(a.routed).toEqual(['digest']);
    expect((await store.getRun('failed'))?.tags).toEqual([lifecycleCoalescedTag('digest')]);
    expect(a.triggered()).toEqual(['digest']);

    await a.engine.republishLifecycle({ runId: 'both' });
    expect(a.routed).toEqual(['digest', 'digest']);
    expect((await store.getRun('both'))?.tags).toEqual([lifecycleCoalescedTag('digest')]);
    // The coalesced tag was already there: nothing new to announce.
    expect(a.triggered()).toEqual(['digest']);

    await a.engine.republishLifecycle({ runId: 'failed', subscriber: 'digest' });
    expect(a.routed).toEqual(['digest', 'digest']);
  });

  it('does not owe a coalesced subscriber again on an instance that cannot deliver it', async () => {
    const store = new InMemoryStateStore();
    const b = batchingEngine(store, 'b');
    await b.engine.heartbeatLifecycleRegistry();
    const a = new WorkflowEngine({ store, instanceId: 'a' });
    a.register('ingest', '1', async () => 'ok');
    await store.createRun(
      settledRun('i1', [lifecycleCoalescedTag('digest')], Date.now() - 60 * 60_000),
    );

    await a.republishLifecycle({ runId: 'i1' });
    expect(a.lifecycleSubscribers('ingest', 'completed')).toEqual(['digest']);
    expect((await store.getRun('i1'))?.tags).toEqual([lifecycleCoalescedTag('digest')]);
  });

  it('keeps the coalesced tag out of the event payload', () => {
    const run = settledRun('i1', [
      'user-tag',
      lifecycleCoalescedTag('digest'),
      lifecycleOwedTag('other'),
    ]);
    expect(isLifecycleTag(lifecycleCoalescedTag('digest'))).toBe(true);
    expect(lifecycleEventOf(run).tags).toEqual(['user-tag']);
    expect(coalescedSubscribersOf(run.tags)).toEqual(['digest']);
    expect(deliveredSubscribersOf(run)).toEqual(new Set(['digest']));
    expect(lifecycleCoalescedTag('digest')).toBe(`${LIFECYCLE_COALESCED_TAG_PREFIX}digest`);
  });

  it('shows a subscriber with the coalesced tag as coalesced, with the accumulator when known', () => {
    const run = settledRun('i1', [lifecycleCoalescedTag('a'), lifecycleCoalescedTag('b')]);
    expect(
      lifecycleDeliveriesOf(run, {
        subscribers: ['a', 'b', 'c'],
        live: new Set(['a', 'b', 'c']),
        coalesced: new Map([['a', accumulatorRunId('a')]]),
      }),
    ).toEqual([
      { subscriber: 'a', state: 'coalesced', runId: accumulatorRunId('a') },
      { subscriber: 'b', state: 'coalesced' },
      { subscriber: 'c', state: 'not-started' },
    ]);
  });

  it('shows coalesced over failed and owed tags', () => {
    const run = settledRun('i1', [
      lifecycleCoalescedTag('a'),
      lifecycleTriggerFailedTag('a'),
      lifecycleCoalescedTag('b'),
      lifecycleOwedTag('b'),
      LIFECYCLE_PENDING_TAG,
    ]);
    expect(
      lifecycleDeliveriesOf(run, { subscribers: ['a', 'b'], live: new Set(['a', 'b']) }),
    ).toEqual([
      { subscriber: 'a', state: 'coalesced' },
      { subscriber: 'b', state: 'coalesced' },
    ]);
  });
});
