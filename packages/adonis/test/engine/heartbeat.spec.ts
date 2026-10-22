import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { Heartbeat, RemoteTask, StepResult, Transport } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, budgetMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await sleep(1);
  }
}

/** A transport whose result/heartbeat delivery the test drives by hand. */
class ControlTransport implements Transport {
  resultHandler?: (r: StepResult) => Promise<void>;
  heartbeatHandler?: (b: Heartbeat) => Promise<void>;
  readonly dispatched: RemoteTask[] = [];
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(h: (r: StepResult) => Promise<void>): void {
    this.resultHandler = h;
  }
  onHeartbeat(h: (b: Heartbeat) => Promise<void>): void {
    this.heartbeatHandler = h;
  }
}

describe('remote-step liveness (heartbeats)', () => {
  it('times out and re-dispatches a presumed-dead worker, then fails', async () => {
    const transport = new ControlTransport();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    engine.register('wf', '1', async (ctx) => ctx.step('job', {}, { timeoutMs: 30, retries: 2 }));

    const res = await startRun(engine, 'wf', {}, 'r1'); // never delivered → timeout × 2 → fail
    expect(res.status).toBe('failed');
    expect(res.error?.message).toMatch(/no result\/heartbeat/);
    expect(transport.dispatched.length).toBe(2); // initial + 1 retry
  });

  it('a heartbeat rearms the window so a beating worker survives past timeoutMs', async () => {
    const transport = new ControlTransport();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    // One attempt: a window that lapses fails the run instead of re-dispatching.
    const timeoutMs = 1000;
    engine.register('wf2', '1', async (ctx) => ctx.step('job', {}, { timeoutMs, retries: 1 }));

    await engine.start('wf2', {}, 'r2');
    const runPromise = engine.waitForRun('r2');
    await until(() => transport.dispatched.length > 0);
    const dispatchedAt = Date.now();
    const id = transport.dispatched[0]?.stepId as string;

    // Beat well inside the window until the step has outlived it 2.5 times over: only the rearm keeps
    // it alive. Anchored on real elapsed time, so a slow machine stretches the run, not the verdict
    // (a gap between beats would have to exceed the whole 1s window to lapse it).
    while (Date.now() - dispatchedAt < timeoutMs * 2.5) {
      await transport.heartbeatHandler?.({ runId: 'r2', seq: 0, stepId: id, group: 'g' });
      await sleep(50);
    }
    await transport.resultHandler?.({
      runId: 'r2',
      seq: 0,
      stepId: id,
      status: 'completed',
      output: 'ok',
    });

    const res = await runPromise;
    expect(res.status).toBe('completed');
    expect(res.output).toBe('ok');
  });
});
