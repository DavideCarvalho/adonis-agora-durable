import { describe, expect, it } from 'vitest';
import { FatalError, InMemoryStateStore, WorkflowEngine } from '../../src/index.js';
import type { EngineEvent } from '../../src/interfaces.js';
import { attachDurableMetrics, MAX_TRACKED_RUN_STARTS } from '../../src/otel/durable-metrics.js';

/** A stand-in engine whose `emit` drives the metrics listener directly. */
function fakeEngine() {
  let listener: ((e: EngineEvent) => void) | undefined;
  const engine = {
    subscribe(l: (e: EngineEvent) => void) {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
  };
  return { engine: engine as never, emit: (e: EngineEvent) => listener?.(e) };
}

/** The previous all-samples implementation, as the reference the histogram must match exactly. */
function referenceStats(xs: number[]) {
  if (xs.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  return { count: sorted.length, p50: at(50), p95: at(95), max: sorted[sorted.length - 1] ?? 0 };
}

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

  it('reports exactly the same percentiles as sorting every sample', () => {
    const { engine, emit } = fakeEngine();
    const metrics = attachDurableMetrics(engine);
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const stepSamples: number[] = [];
    const runSamples: number[] = [];
    for (let n = 1; n <= 2_000; n++) {
      const d = Math.floor(rand() * rand() * 5_000);
      stepSamples.push(d);
      emit({ type: 'step.completed', runId: `r${n}`, durationMs: d, at: new Date() });
      const start = 1_000_000 + n;
      const runD = Math.floor(rand() * 900);
      runSamples.push(runD);
      emit({ type: 'run.started', runId: `r${n}`, at: new Date(start) });
      emit({
        type: n % 3 ? 'run.completed' : 'run.failed',
        runId: `r${n}`,
        at: new Date(start + runD),
      });
      if (n % 97 === 0 || n < 25) {
        const snap = metrics.snapshot();
        expect(snap.stepDurationMs).toEqual(referenceStats(stepSamples));
        expect(snap.runDurationMs).toEqual(referenceStats(runSamples));
      }
    }
    metrics.reset();
    expect(metrics.snapshot().stepDurationMs).toEqual(referenceStats([]));
  });

  it('bounds runs that start here but never end here, keeping in-flight durations exact', () => {
    const { engine, emit } = fakeEngine();
    const metrics = attachDurableMetrics(engine);
    // A run still in flight that will end normally later.
    emit({ type: 'run.started', runId: 'live', at: new Date(0) });
    // Far more runs than the cap start and never report an end (suspended/resumed elsewhere).
    for (let n = 0; n < MAX_TRACKED_RUN_STARTS * 2; n++) {
      emit({ type: 'run.started', runId: `orphan-${n}`, at: new Date(1) });
    }
    // The oldest start was evicted: its end no longer yields a sample.
    emit({ type: 'run.completed', runId: 'live', at: new Date(50) });
    expect(metrics.snapshot().runDurationMs.count).toBe(0);
    // A recent run still in flight is tracked and measured exactly.
    const recent = `orphan-${MAX_TRACKED_RUN_STARTS * 2 - 1}`;
    emit({ type: 'run.completed', runId: recent, at: new Date(41) });
    expect(metrics.snapshot().runDurationMs).toEqual({ count: 1, p50: 40, p95: 40, max: 40 });
    expect(metrics.snapshot().runs.started).toBe(MAX_TRACKED_RUN_STARTS * 2 + 1);
  });
});
