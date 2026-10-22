import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { Heartbeat, RemoteTask, StepResult, Transport } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    engine.register('wf2', '1', async (ctx) => ctx.step('job', {}, { timeoutMs: 600 }));

    await engine.start('wf2', {}, 'r2');
    const runPromise = engine.waitForRun('r2');
    await sleep(0); // let the dispatch happen
    const id = transport.dispatched[0]?.stepId as string;

    // Wide margins (10x the old 60ms window): a loaded CI runner can stall a timer by tens of ms.
    await sleep(400);
    await transport.heartbeatHandler?.({ runId: 'r2', seq: 0, stepId: id, group: 'g' }); // rearm
    await sleep(300); // 700ms total — past 600ms, but only 300ms since the last beat
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
