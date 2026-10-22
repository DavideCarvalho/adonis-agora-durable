import { describe, expect, it } from 'vitest';
import { FatalError, InMemoryStateStore, WorkflowEngine } from '../../src/index.js';
import { attachDurableMetrics } from '../../src/otel/durable-metrics.js';

describe('attachDurableMetrics', () => {
  it('counts runs/steps and records duration percentiles', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const metrics = attachDurableMetrics(engine);

    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('a', async () => 1);
      await ctx.localStep('b', async () => 2);
      return 'done';
    });
    await engine.start('wf', {}, 'run1');
    await engine.waitForRun('run1');

    const snap = metrics.snapshot();
    expect(snap.runs.started).toBe(1);
    expect(snap.runs.completed).toBe(1);
    expect(snap.steps.completed).toBe(2);
    expect(snap.stepDurationMs.count).toBe(2);
    expect(snap.runDurationMs.count).toBe(1);

    metrics.reset();
    expect(metrics.snapshot().runs.started).toBe(0);
    metrics.unsubscribe();
  });

  it('counts a failed run', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const metrics = attachDurableMetrics(engine);
    engine.register('boom', '1', async (ctx) =>
      ctx.localStep('x', async () => {
        throw new Error('nope');
      }),
    );
    await engine.start('boom', {}, 'run2');
    await engine.waitForRun('run2');
    const snap = metrics.snapshot();
    expect(snap.runs.failed).toBe(1);
    expect(snap.steps.failed).toBe(1);
  });

  it('counts a failure handed to an onError handler, by code', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const metrics = attachDurableMetrics(engine);
    engine.register('dlq', '1', async () => 'handled');
    engine.register(
      'line',
      '1',
      async () => {
        throw new FatalError('bad line', 'invalid_line');
      },
      { onError: [{ code: 'invalid_line', workflow: 'dlq' }] },
    );
    await engine.start('line', {}, 'r');
    await engine.waitForRun('r', { terminal: true });

    const snap = metrics.snapshot();
    expect(snap.runs.routed).toBe(1);
    expect(snap.runs.failed).toBe(0);
    expect(snap.routedByCode).toEqual({ invalid_line: 1 });
  });

  it('counts only the events this instance produced, not another pod’s re-delivered ones', async () => {
    const handlers: Array<(m: unknown) => void> = [];
    const controlPlane = {
      publishControl: async (msg: unknown) => {
        for (const h of handlers) h(JSON.parse(JSON.stringify(msg)));
      },
      onControl: (h: (m: unknown) => void) => void handlers.push(h),
    };
    const store = new InMemoryStateStore();
    const worker = new WorkflowEngine({ store, controlPlane, instanceId: 'w' } as never);
    const api = new WorkflowEngine({ store, controlPlane, instanceId: 'a' } as never);
    worker.register('wf', '1', async () => 'done');
    const onWorker = attachDurableMetrics(worker);
    const onApi = attachDurableMetrics(api);
    await worker.start('wf', {}, 'fleet');
    await worker.waitForRun('fleet');
    await new Promise((r) => setTimeout(r, 10));
    expect(onWorker.snapshot().runs.completed).toBe(1);
    expect(onApi.snapshot().runs.completed).toBe(0);
    onWorker.unsubscribe();
    onApi.unsubscribe();
  });
});
