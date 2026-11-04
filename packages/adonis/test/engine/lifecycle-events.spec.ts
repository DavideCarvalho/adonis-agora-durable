import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { FatalError } from '../../src/errors.js';
import type { EngineEvent, WorkflowRun } from '../../src/interfaces.js';
import {
  LIFECYCLE_HEAL_WINDOW_MS,
  LIFECYCLE_PENDING_TAG,
  LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX,
  lifecycleEventOf,
  lifecycleRunId,
  lifecycleSourceOf,
  runCompletedEvent,
  runFailedEvent,
  triggeredRunsOf,
  type WorkflowLifecycleEvent,
} from '../../src/lifecycle-events.js';
import { runDetailEtag } from '../../src/run-detail-summary.js';
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

function setup() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  const seen: WorkflowLifecycleEvent[] = [];
  return { store, engine, seen };
}

describe('lifecycle events (run.completed:<workflow> / run.failed:<workflow>)', () => {
  it('starts a completed-subscriber with the settled run, without the source knowing', async () => {
    const { store, engine, seen } = setup();
    engine.register('ingest', '1', async (ctx, input) => {
      await ctx.upsertSearchAttributes({ table: 'mvr' });
      return { rows: (input as { rows: number }).rows };
    });
    engine.register('refresh', '1', async (_ctx, event) => void seen.push(event as never), {
      onEvent: [runCompletedEvent('ingest')],
    });

    await engine.start('ingest', { rows: 3 }, 'i1');
    await poll(
      async () => (await store.getRun('evt:i1:completed:refresh'))?.status === 'completed',
    );

    expect(seen).toEqual([
      expect.objectContaining({
        runId: 'i1',
        workflow: 'ingest',
        workflowVersion: '1',
        status: 'completed',
        input: { rows: 3 },
        output: { rows: 3 },
        searchAttributes: { table: 'mvr' },
      }),
    ]);
  });

  it('publishes a failed run only to failed-subscribers, with its error', async () => {
    const { store, engine, seen } = setup();
    const completed: unknown[] = [];
    engine.register('ingest', '1', async () => {
      throw new FatalError('bad file', 'bad_file');
    });
    engine.register('alert', '1', async (_ctx, event) => void seen.push(event as never), {
      onEvent: [runFailedEvent('ingest')],
    });
    engine.register('refresh', '1', async (_ctx, event) => void completed.push(event), {
      onEvent: [runCompletedEvent('ingest')],
    });

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('evt:i1:failed:alert'))?.status === 'completed');
    await settle();

    expect(seen[0]).toMatchObject({
      runId: 'i1',
      status: 'failed',
      error: { message: 'bad file', code: 'bad_file' },
    });
    expect(seen[0]).not.toHaveProperty('output');
    expect(completed).toEqual([]);
  });

  it('skips a subscriber whose where rejects the settled run', async () => {
    const { store, engine } = setup();
    engine.register('ingest', '1', async (_ctx, input) => input);
    engine.register('mvr-only', '1', async () => 'ran', {
      onEvent: [
        {
          event: runCompletedEvent('ingest'),
          where: (e) => (e as WorkflowLifecycleEvent<{ table: string }>).input.table === 'mvr',
        },
      ],
    });

    await engine.start('ingest', { table: 'mel' }, 'mel-run');
    await engine.start('ingest', { table: 'mvr' }, 'mvr-run');
    await poll(async () => (await store.getRun('evt:mvr-run:completed:mvr-only')) !== null);
    await settle();

    expect(await store.getRun('evt:mel-run:completed:mvr-only')).toBeNull();
  });

  it('publishes nothing, and buffers nothing, when no workflow subscribes', async () => {
    const { store, engine } = setup();
    engine.register('ingest', '1', async () => 'ok');

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();

    expect(await store.listBufferedEvents(runCompletedEvent('ingest'), 10)).toEqual([]);
  });

  it('does not buffer a lifecycle event that every subscriber filtered out', async () => {
    const { store, engine } = setup();
    engine.register('ingest', '1', async () => 'ok');
    engine.register('never', '1', async () => 'ran', {
      onEvent: [{ event: runCompletedEvent('ingest'), where: () => false }],
    });

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();

    expect(await store.listBufferedEvents(runCompletedEvent('ingest'), 10)).toEqual([]);
  });

  it('treats a continue-as-new handoff as not completed: only the last run of the chain fires', async () => {
    const { store, engine } = setup();
    engine.register('counter', '1', async (ctx, input) => {
      const n = (input as { n: number }).n;
      if (n < 3) await ctx.continueAsNew({ n: n + 1 });
      return n;
    });
    engine.register('after', '1', async (_ctx, event) => event, {
      onEvent: [runCompletedEvent('counter')],
    });

    await engine.start('counter', { n: 1 }, 'c1');
    await poll(
      async () => (await store.getRun('evt:c1~2:completed:after'))?.status === 'completed',
    );
    await settle();

    expect(await store.getRun('evt:c1:completed:after')).toBeNull();
    expect(await store.getRun('evt:c1~1:completed:after')).toBeNull();
    expect((await store.getRun('evt:c1~2:completed:after'))?.input).toMatchObject({ output: 3 });
  });
});

describe('onEvent where filters on published events', () => {
  it('starts only the subscribers whose where accepts the payload; a throwing where rejects', async () => {
    const { store, engine } = setup();
    engine.register('big', '1', async () => 'big', {
      onEvent: [{ event: 'order.placed', where: (p) => (p as { total: number }).total > 100 }],
    });
    engine.register('any', '1', async () => 'any', { onEvent: ['order.placed'] });
    engine.register('broken', '1', async () => 'broken', {
      onEvent: [
        {
          event: 'order.placed',
          where: () => {
            throw new Error('boom');
          },
        },
      ],
    });

    expect(await engine.publishEvent('order.placed', { total: 50 }, { id: 'small' })).toBe(1);
    expect(await engine.publishEvent('order.placed', { total: 500 }, { id: 'large' })).toBe(2);

    expect(await store.getRun('evt:small:big')).toBeNull();
    expect(await store.getRun('evt:large:big')).not.toBeNull();
    expect(await store.getRun('evt:small:broken')).toBeNull();
    expect(await store.getRun('evt:large:broken')).toBeNull();
  });

  it('starts a workflow subscribed twice to one event once, if any of its filters accepts', async () => {
    const { store, engine } = setup();
    engine.register('either', '1', async () => 'ran', {
      onEvent: [
        { event: 'x', where: (p) => (p as { a?: number }).a === 1 },
        { event: 'x', where: (p) => (p as { b?: number }).b === 1 },
      ],
    });

    expect(await engine.publishEvent('x', { b: 1 }, { id: 'e1' })).toBe(1);
    expect(await engine.publishEvent('x', { c: 1 }, { id: 'e2', buffer: false })).toBe(0);
    expect(await store.getRun('evt:e1:either')).not.toBeNull();
  });
});

describe('lifecycle links between runs', () => {
  it('names the started run deterministically and links both ends', async () => {
    const { store, engine } = setup();
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });
    engine.register('alert', '1', async () => 'alerted', {
      onEvent: [runFailedEvent('ingest')],
    });

    await engine.start('ingest', {}, 'i1');
    const started = lifecycleRunId('i1', 'completed', 'refresh');
    expect(started).toBe('evt:i1:completed:refresh');
    await poll(async () => (await store.getRun(started))?.status === 'completed');

    expect(await engine.triggeredRuns('i1')).toEqual([started]);
    expect(lifecycleSourceOf((await store.getRun(started)) as WorkflowRun)).toEqual({
      runId: 'i1',
      kind: 'completed',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'run.triggered',
        runId: 'i1',
        workflow: 'ingest',
        name: 'refresh',
        triggeredRunId: started,
      }),
    );
  });

  it('lists nothing for a run that has not settled or started nobody', async () => {
    const { store, engine } = setup();
    engine.register('ingest', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      return 'ok';
    });
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [{ event: runCompletedEvent('ingest'), where: () => false }],
    });

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'suspended');
    expect(await engine.triggeredRuns('i1')).toEqual([]);

    await engine.signal('go', null);
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();
    expect(await engine.triggeredRuns('i1')).toEqual([]);
    expect(await engine.triggeredRuns('missing')).toEqual([]);
  });

  it('reads the source from the run id alone, whatever input the subscriber got', () => {
    expect(lifecycleSourceOf({ id: 'manual-1', workflow: 'refresh' })).toBeUndefined();
    expect(lifecycleSourceOf({ id: 'evt:i1:failed:other', workflow: 'refresh' })).toBeUndefined();
    expect(lifecycleSourceOf({ id: 'evt:i1:failed:refresh', workflow: 'refresh' })).toEqual({
      runId: 'i1',
      kind: 'failed',
    });
    expect(lifecycleSourceOf({ id: 'evt:a:b:completed:refresh', workflow: 'refresh' })).toEqual({
      runId: 'a:b',
      kind: 'completed',
    });
  });
});

describe('lifecycle delivery guarantees', () => {
  const source = (over: Partial<WorkflowRun> = {}): WorkflowRun =>
    ({
      id: 'i1',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: { baseId: 'b1' },
      output: { rows: 2 },
      tags: [LIFECYCLE_PENDING_TAG],
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...over,
    }) as WorkflowRun;

  it('writes the pending marker with the terminal status, then swaps it for the triggered tag', async () => {
    const { store, engine } = setup();
    const patches: Partial<WorkflowRun>[] = [];
    const updateRunIf = store.updateRunIf.bind(store);
    store.updateRunIf = async (id, expected, patch) => {
      if (id === 'i1') patches.push(patch);
      return updateRunIf(id, expected, patch);
    };
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });

    await engine.start('ingest', {}, 'i1');
    await poll(
      async () => (await store.getRun('i1'))?.tags?.includes('durable:triggered:refresh') ?? false,
    );

    expect(patches.find((p) => p.status === 'completed')?.tags).toContain(LIFECYCLE_PENDING_TAG);
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:refresh']);
  });

  it('marks nothing when no workflow subscribes to that ending', async () => {
    const { store, engine } = setup();
    engine.register('ingest', '1', async () => 'ok');
    engine.register('alert', '1', async () => 'alerted', { onEvent: [runFailedEvent('ingest')] });

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();

    expect((await store.getRun('i1'))?.tags ?? []).toEqual([]);
  });

  it('publishes, from the sweep, a run whose process died between settling and publishing', async () => {
    const { store, engine } = setup();
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });
    await store.createRun(source());

    expect(await engine.sweepLifecycleEvents(60_000)).toBe(1);
    await poll(
      async () => (await store.getRun('evt:i1:completed:refresh'))?.status === 'completed',
    );

    expect((await store.getRun('evt:i1:completed:refresh'))?.input).toMatchObject({
      runId: 'i1',
      input: { baseId: 'b1' },
      tags: [],
    });
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:refresh']);
    expect(await engine.sweepLifecycleEvents(60_000)).toBe(0);
  });

  it('leaves a just-settled run to the live publish', async () => {
    const { store, engine } = setup();
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });
    await store.createRun(source({ updatedAt: new Date(50_000) }));

    expect(await engine.sweepLifecycleEvents(60_000)).toBe(0);
    expect(await engine.sweepLifecycleEvents(90_000)).toBe(1);
  });

  it('keeps the marker when writing it back fails, and the sweep starts the subscriber once', async () => {
    const { store, engine } = setup();
    let failTagWrites = 1;
    const updateRun = store.updateRun.bind(store);
    store.updateRun = async (id, patch) => {
      if (id === 'i1' && !patch.status && failTagWrites-- > 0) throw new Error('store down');
      return updateRun(id, patch);
    };
    let runs = 0;
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => void runs++, {
      onEvent: [runCompletedEvent('ingest')],
    });
    // Read the fleet's subscriptions first, so the terminal write resolves the owed set.
    await engine.sweepLifecycleEvents();

    await engine.start('ingest', {}, 'i1');
    await poll(
      async () => (await store.getRun('evt:i1:completed:refresh'))?.status === 'completed',
    );
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual([
      LIFECYCLE_PENDING_TAG,
      'durable:lifecycle:owed:refresh',
    ]);

    expect(await engine.sweepLifecycleEvents(Date.now() + 60_000)).toBe(1);
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:refresh']);
    expect(runs).toBe(1);
  });

  it('reports a subscriber that cannot start, or whose where throws, without retrying it', async () => {
    const { store, engine } = setup();
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    engine.register('ingest', '1', async () => 'ok');
    engine.register('strict', '1', async () => 'ran', {
      onEvent: [runCompletedEvent('ingest')],
      validateInput: () => {
        throw new Error('bad input');
      },
    });
    engine.register('broken', '1', async () => 'ran', {
      onEvent: [
        {
          event: runCompletedEvent('ingest'),
          where: () => {
            throw new Error('boom');
          },
        },
      ],
    });

    await engine.start('ingest', {}, 'i1');
    await poll(async () => events.filter((e) => e.type === 'run.trigger_failed').length === 2);

    expect(events.filter((e) => e.type === 'run.trigger_failed')).toEqual([
      expect.objectContaining({ runId: 'i1', name: 'strict', error: { message: 'bad input' } }),
      expect.objectContaining({ runId: 'i1', name: 'broken', error: { message: 'boom' } }),
    ]);
    expect((await store.getRun('i1'))?.tags).toEqual([
      'durable:trigger_failed:strict',
      'durable:trigger_failed:broken',
    ]);
    expect(await engine.sweepLifecycleEvents(Date.now() + 60_000)).toBe(0);
  });
});

describe('lifecycle trigger-failed state', () => {
  const failedTag = (subscriber: string) => `${LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX}${subscriber}`;

  /**
   * `ingest` with three subscribers that fail while `broken.on` is set: `strict` rejects its input,
   * `picky`'s `where` throws, and `flaky`'s run cannot be created; and `fine`, which always starts.
   */
  function failingSetup() {
    const { store, engine } = setup();
    const broken = { on: true };
    const createRun = store.createRun.bind(store);
    store.createRun = async (run) => {
      if (broken.on && run.id === lifecycleRunId('i1', 'completed', 'flaky')) {
        throw new Error('store refused');
      }
      return createRun(run);
    };
    engine.register('ingest', '1', async () => 'ok');
    engine.register('strict', '1', async () => 'ran', {
      onEvent: [runCompletedEvent('ingest')],
      validateInput: () => {
        if (broken.on) throw new Error('bad input');
      },
    });
    engine.register('picky', '1', async () => 'ran', {
      onEvent: [
        {
          event: runCompletedEvent('ingest'),
          where: () => {
            if (broken.on) throw new Error('boom');
            return true;
          },
        },
      ],
    });
    engine.register('flaky', '1', async () => 'ran', { onEvent: [runCompletedEvent('ingest')] });
    engine.register('fine', '1', async () => 'ran', { onEvent: [runCompletedEvent('ingest')] });
    return { store, engine, broken };
  }

  it('tags the source run for each subscriber that failed, in the write that drops its owed tag', async () => {
    const { store, engine } = failingSetup();
    const tagWrites: string[][] = [];
    const updateRun = store.updateRun.bind(store);
    store.updateRun = async (id, patch) => {
      if (id === 'i1' && patch.tags && !patch.status) tagWrites.push(patch.tags);
      return updateRun(id, patch);
    };

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.tags?.includes(failedTag('flaky')) ?? false);

    expect(tagWrites).toHaveLength(1);
    expect([...((await store.getRun('i1'))?.tags ?? [])].sort()).toEqual([
      failedTag('flaky'),
      failedTag('picky'),
      failedTag('strict'),
      'durable:triggered:fine',
    ]);
    const detail = await engine.getRunDetail('i1');
    expect(detail?.lifecycleDeliveries?.map((d) => [d.subscriber, d.state])).toEqual([
      ['fine', 'started'],
      ['flaky', 'failed'],
      ['picky', 'failed'],
      ['strict', 'failed'],
    ]);
  });

  it('tags a subscriber that fails on the sweep path', async () => {
    const { store, engine } = failingSetup();
    await store.createRun({
      id: 'i1',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      output: 'ok',
      tags: [LIFECYCLE_PENDING_TAG, 'durable:lifecycle:owed:strict'],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as WorkflowRun);

    // Past the heal window, so the other subscribers the fixture never marked stay out of it.
    expect(await engine.sweepLifecycleEvents(LIFECYCLE_HEAL_WINDOW_MS + 60_000)).toBe(1);
    expect((await store.getRun('i1'))?.tags).toEqual([failedTag('strict')]);
  });

  it('clears the tag when a republish starts the subscriber', async () => {
    const { store, engine, broken } = failingSetup();
    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.tags?.includes(failedTag('flaky')) ?? false);

    broken.on = false;
    const result = await engine.republishLifecycle({ runId: 'i1' });
    expect(result.failed).toEqual([]);
    expect(result.started).toBe(3);
    expect([...((await store.getRun('i1'))?.tags ?? [])].sort()).toEqual([
      'durable:triggered:fine',
      'durable:triggered:flaky',
      'durable:triggered:picky',
      'durable:triggered:strict',
    ]);
    const detail = await engine.getRunDetail('i1');
    expect(detail?.lifecycleDeliveries?.every((d) => d.state === 'started')).toBe(true);
  });

  it('keeps the tag when a republish fails again', async () => {
    const { store, engine } = failingSetup();
    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.tags?.includes(failedTag('flaky')) ?? false);

    const result = await engine.republishLifecycle({ runId: 'i1', subscriber: 'strict' });
    expect(result.failed).toEqual([{ runId: 'i1', subscriber: 'strict', error: 'bad input' }]);
    expect((await store.getRun('i1'))?.tags).toContain(failedTag('strict'));
  });

  it('keeps the tag out of the lifecycle event payload', async () => {
    const { store, engine } = failingSetup();
    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.tags?.includes(failedTag('flaky')) ?? false);

    const run = await store.getRun('i1');
    expect(run && lifecycleEventOf(run).tags).toEqual([]);
  });
});

describe('lifecycle input mapping', () => {
  it('starts the subscriber with what input builds, and still links it to the source', async () => {
    const { store, engine } = setup();
    engine.register('ingest', '1', async () => ({ rows: 2 }));
    engine.register('refresh', '1', async (_ctx, input) => input, {
      onEvent: [
        {
          event: runCompletedEvent('ingest'),
          input: (e) => ({
            baseId: (e as WorkflowLifecycleEvent<{ baseId: string }>).input.baseId,
          }),
        },
      ],
    });

    await engine.start('ingest', { baseId: 'b1', big: 'x'.repeat(1000) }, 'i1');
    const started = lifecycleRunId('i1', 'completed', 'refresh');
    await poll(async () => (await store.getRun(started))?.status === 'completed');

    const run = (await store.getRun(started)) as WorkflowRun;
    expect(run.input).toEqual({ baseId: 'b1' });
    expect(lifecycleSourceOf(run)).toEqual({ runId: 'i1', kind: 'completed' });
  });

  it('reads the triggered links from the run, on an engine that registers no subscriber', async () => {
    const { store, engine } = setup();
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });
    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.tags?.length === 1);

    const dashboard = new WorkflowEngine({ store });
    expect(await dashboard.triggeredRuns('i1')).toEqual(['evt:i1:completed:refresh']);
  });
});

describe('run detail lifecycle links', () => {
  it('lists the runs a settled run started, and the run that started a subscriber', async () => {
    const { store, engine } = setup();
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });
    await engine.start('ingest', {}, 'i1');
    const started = lifecycleRunId('i1', 'completed', 'refresh');
    await poll(async () => (await store.getRun('i1'))?.tags?.length === 1);

    for (const options of [undefined, { summarizeFansOver: 50 }]) {
      expect(await engine.getRunDetail('i1', options)).toMatchObject({ triggered: [started] });
      const detail = await engine.getRunDetail(started, options);
      expect(detail?.triggeredBy).toEqual({
        runId: 'i1',
        kind: 'completed',
        status: 'completed',
        namespace: 'default',
      });
      expect(detail).not.toHaveProperty('triggered');
    }
  });
});

describe('runDetailEtag with lifecycle links', () => {
  it('changes when the settled run records a triggered subscriber', () => {
    const run = {
      id: 'i1',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      tags: [LIFECYCLE_PENDING_TAG],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as WorkflowRun;
    const triggered = { ...run, tags: ['durable:triggered:refresh'] };
    expect(runDetailEtag(triggered, [], 50)).not.toBe(runDetailEtag(run, [], 50));
    expect(triggeredRunsOf(triggered)).toEqual(['evt:i1:completed:refresh']);
  });
});
