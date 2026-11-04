import { describe, expect, it } from 'vitest';
import { BaseWorkflow } from '../../src/base-workflow.js';
import { WorkflowEngine } from '../../src/engine.js';
import { accumulatorRunId } from '../../src/event-accumulators.js';
import type { WorkflowCtx } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { registerWorkflowClass } from '../../src/workflow-discovery.js';
import { OnWorkflowCompleted, OnWorkflowFailed } from '../../src/workflow-events.js';
import { workflowMeta } from '../../src/workflow-ref.js';

const tick = () => new Promise((r) => setImmediate(r));
async function until(pred: () => boolean, n = 200) {
  for (let i = 0; i < n && !pred(); i += 1) await tick();
}

describe('keyed debounce / batch', () => {
  it('keeps the unkeyed accumulator id, and makes any key a safe id', () => {
    expect(accumulatorRunId('refresh')).toBe('__evtacc__:refresh');
    expect(accumulatorRunId('refresh', 'base:1/a b~2#x')).toBe(
      '__evtacc__:refresh#base%3A1%2Fa%20b%7E2%23x',
    );
    expect(accumulatorRunId('refresh', 'a')).not.toBe(accumulatorRunId('refresh', 'b'));
  });

  it('debounce: one target run per key, each with its own last input', async () => {
    let now = 1000;
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), clock: () => now });
    const fired: unknown[] = [];
    engine.register('refresh', '1', async (_ctx, input) => void fired.push(input), {
      onEvent: ['ingested'],
      eventBatch: {
        mode: 'debounce',
        windowMs: 5000,
        key: (input) => (input as { baseId: string }).baseId,
      },
    });

    await engine.publishEvent('ingested', { baseId: 'b1', n: 1 });
    await engine.publishEvent('ingested', { baseId: 'b2', n: 2 });
    await engine.waitForRun(accumulatorRunId('refresh', 'b1'));
    await engine.waitForRun(accumulatorRunId('refresh', 'b2'));
    await engine.publishEvent('ingested', { baseId: 'b1', n: 3 });
    await tick();
    expect(fired).toEqual([]);

    now += 6000;
    await engine.resumeDueTimers(now);
    await until(() => fired.length >= 2);
    await tick();
    expect(fired).toHaveLength(2);
    expect(fired).toEqual(
      expect.arrayContaining([
        { baseId: 'b1', n: 3 },
        { baseId: 'b2', n: 2 },
      ]),
    );
  });

  it('batch: collects per key', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), clock: () => 1000 });
    const fired: unknown[] = [];
    engine.register('agg', '1', async (_ctx, input) => void fired.push(input), {
      onEvent: ['hit'],
      eventBatch: {
        mode: 'batch',
        maxSize: 2,
        windowMs: 60_000,
        key: (input) => (input as { k: string }).k,
      },
    });

    await engine.publishEvent('hit', { k: 'a', n: 1 });
    await engine.publishEvent('hit', { k: 'b', n: 2 });
    await engine.waitForRun(accumulatorRunId('agg', 'a'));
    await engine.waitForRun(accumulatorRunId('agg', 'b'));
    await engine.publishEvent('hit', { k: 'a', n: 3 });
    await until(() => fired.length > 0);
    expect(fired).toEqual([
      {
        events: [
          { k: 'a', n: 1 },
          { k: 'a', n: 3 },
        ],
      },
    ]);
  });
});

class IngestWorkflow extends BaseWorkflow {
  static override workflow = { name: 'keyed-ingest' };
  async run(_ctx: WorkflowCtx, input: { baseId: string; file: string }) {
    return { rows: input.file.length };
  }
}

describe('@OnWorkflowCompleted / @OnWorkflowFailed debounce and batch', () => {
  it('maps debounce onto the workflow eventBatch, keyed by the subscriber input', async () => {
    const key = (input: { baseId: string }) => input.baseId;
    @OnWorkflowCompleted(IngestWorkflow, {
      input: (e) => ({ baseId: e.input.baseId }),
      debounce: { windowMs: '5s', key },
    })
    class RefreshWorkflow extends BaseWorkflow {
      static override workflow = { name: 'keyed-refresh' };
      async run(_ctx: WorkflowCtx, input: { baseId: string }) {
        return input.baseId;
      }
    }
    expect(workflowMeta(RefreshWorkflow)?.eventBatch).toEqual({
      mode: 'debounce',
      windowMs: 5000,
      key,
    });

    let now = 1000;
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), clock: () => now });
    await registerWorkflowClass(engine, IngestWorkflow);
    await registerWorkflowClass(engine, RefreshWorkflow);
    for (const [id, baseId] of [
      ['i1', 'b1'],
      ['i2', 'b1'],
      ['i3', 'b2'],
    ] as const) {
      await engine.start('keyed-ingest', { baseId, file: id }, id);
    }
    await until(() => false, 50);
    now += 6000;
    await engine.resumeDueTimers(now);
    await until(() => false, 100);

    const refreshes = await engine.listRuns({ workflow: 'keyed-refresh' });
    const bases = refreshes.map((r) => (r.input as { baseId: string }).baseId).sort();
    expect(bases).toEqual(['b1', 'b2']);
  });

  it('maps batch onto the workflow eventBatch', () => {
    @OnWorkflowFailed(IngestWorkflow, {
      input: (e) => ({ baseId: e.input.baseId }),
      batch: { maxSize: 10, windowMs: 60_000 },
    })
    class FailureDigestWorkflow extends BaseWorkflow {
      static override workflow = { name: 'failure-digest' };
      async run(_ctx: WorkflowCtx, input: { events: { baseId: string }[] }) {
        return input.events.length;
      }
    }
    expect(workflowMeta(FailureDigestWorkflow)?.eventBatch).toEqual({
      mode: 'batch',
      maxSize: 10,
      windowMs: 60_000,
    });
  });

  it('rejects debounce and batch together, and a differing eventBatch on the workflow', () => {
    expect(() =>
      OnWorkflowCompleted('keyed-ingest', {
        debounce: { windowMs: 1000 },
        batch: { maxSize: 2, windowMs: 1000 },
      }),
    ).toThrow(/debounce or batch, not both/);

    expect(() => {
      @OnWorkflowCompleted('keyed-ingest', { debounce: { windowMs: 1000 } })
      class Conflicting extends BaseWorkflow {
        static override workflow = {
          name: 'conflicting',
          eventBatch: { mode: 'batch' as const, maxSize: 5, windowMs: 1000 },
        };
        async run() {}
      }
      return Conflicting;
    }).toThrow(/differs from the workflow's eventBatch/);

    expect(() => {
      @OnWorkflowFailed('keyed-ingest', { debounce: { windowMs: '1s' } })
      @OnWorkflowCompleted('keyed-ingest', { debounce: { windowMs: 1000 } })
      class Same extends BaseWorkflow {
        static override workflow = { name: 'same' };
        async run() {}
      }
      return Same;
    }).not.toThrow();
  });

  it('accepts separately written identical key functions, and rejects keys that differ', () => {
    expect(() => {
      @OnWorkflowFailed(IngestWorkflow, {
        debounce: { windowMs: '5s', key: (input) => input.input.baseId },
      })
      @OnWorkflowCompleted(IngestWorkflow, {
        debounce: { windowMs: 5000, key: (input) => input.input.baseId },
      })
      class SameKey extends BaseWorkflow {
        static override workflow = { name: 'same-key' };
        async run() {}
      }
      return SameKey;
    }).not.toThrow();

    // Keys that compute the same thing but are written differently still differ.
    expect(() => {
      @OnWorkflowFailed(IngestWorkflow, {
        batch: { maxSize: 5, windowMs: 1000, key: (e) => e.input.baseId },
      })
      @OnWorkflowCompleted(IngestWorkflow, {
        batch: { maxSize: 5, windowMs: 1000, key: (input) => input.input.baseId },
      })
      class OtherKey extends BaseWorkflow {
        static override workflow = { name: 'other-key' };
        async run() {}
      }
      return OtherKey;
    }).toThrow(/differs from the workflow's eventBatch/);
  });
});

describe('accumulator dedupe', () => {
  it('counts an event routed twice into a batch once', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), clock: () => 1000 });
    const fired: unknown[] = [];
    engine.register('agg', '1', async (_ctx, input) => void fired.push(input), {
      onEvent: ['hit'],
      eventBatch: { mode: 'batch', maxSize: 2, windowMs: 60_000 },
    });

    await engine.publishEvent('hit', { n: 1 }, { id: 'e1' });
    await engine.waitForRun(accumulatorRunId('agg'));
    await engine.publishEvent('hit', { n: 1 }, { id: 'e1' });
    await engine.publishEvent('hit', { n: 2 }, { id: 'e2' });
    await until(() => fired.length > 0);
    expect(fired).toEqual([{ events: [{ n: 1 }, { n: 2 }] }]);

    // The next burst still knows the first one's events.
    await engine.publishEvent('hit', { n: 2 }, { id: 'e2' });
    await engine.publishEvent('hit', { n: 3 }, { id: 'e3' });
    await engine.publishEvent('hit', { n: 4 }, { id: 'e4' });
    await until(() => fired.length > 1);
    expect(fired[1]).toEqual({ events: [{ n: 3 }, { n: 4 }] });
  });

  it('does not let a duplicate debounced event fire the target again', async () => {
    let now = 1000;
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), clock: () => now });
    const fired: unknown[] = [];
    engine.register('refresh', '1', async (_ctx, input) => void fired.push(input), {
      onEvent: ['ingested'],
      eventBatch: { mode: 'debounce', windowMs: 5000 },
    });

    await engine.publishEvent('ingested', { n: 1 }, { id: 'e1' });
    await engine.waitForRun(accumulatorRunId('refresh'));
    now += 6000;
    await engine.resumeDueTimers(now);
    await until(() => fired.length > 0);
    await until(() => false, 50);

    await engine.publishEvent('ingested', { n: 1 }, { id: 'e1' });
    await until(() => false, 50);
    now += 6000;
    await engine.resumeDueTimers(now);
    await until(() => false, 100);
    expect(fired).toEqual([{ n: 1 }]);
  });
});
