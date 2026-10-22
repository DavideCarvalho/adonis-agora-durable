import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { FatalError } from '../../src/errors.js';
import { collectMetrics } from '../../src/metrics.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('collectMetrics', () => {
  it('counts run/step outcomes and per-workflow runs from engine events', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const metrics = collectMetrics(engine);

    engine.register('ok', '1', async (ctx) => {
      await ctx.localStep('a', async () => 1);
      return 'done';
    });
    engine.register('bad', '1', async () => {
      throw new Error('boom');
    });

    await startRun(engine, 'ok', {}, 'r1');
    await startRun(engine, 'bad', {}, 'r2');

    const s = metrics.snapshot();
    expect(s.runs.started).toBe(2);
    expect(s.runs.completed).toBe(1);
    expect(s.runs.failed).toBe(1);
    expect(s.steps.completed).toBe(1);
    expect(s.byWorkflow.ok).toEqual({ started: 1, completed: 1, failed: 0 });
    expect(s.byWorkflow.bad?.failed).toBe(1);

    const prom = metrics.prometheus();
    expect(prom).toContain('durable_runs_total{event="completed"} 1');
    expect(prom).toContain('durable_runs_by_workflow_total{workflow="ok",event="completed"} 1');

    metrics.stop();
  });

  it('counts failures handed to an onError handler, and exposes them by code', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const metrics = collectMetrics(engine);
    engine.register('dlq', '1', async () => 'handled');
    engine.register(
      'line',
      '1',
      async () => {
        throw new FatalError('bad line', 'invalid_line');
      },
      { onError: [{ code: 'invalid_line', workflow: 'dlq' }] },
    );
    await startRun(engine, 'line', {}, 'r');
    await engine.waitForRun('r', { terminal: true });

    expect(metrics.snapshot().runs.routed).toBe(1);
    expect(metrics.snapshot().routedByCode).toEqual({ invalid_line: 1 });
    expect(metrics.prometheus()).toContain('durable_runs_routed_total{code="invalid_line"} 1');
    metrics.stop();
  });
});
