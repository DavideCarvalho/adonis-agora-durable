import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { Heartbeat, RemoteTask, StepResult, Transport } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * REGRESSION: with several engine instances on a point-to-point transport (the `queue` transport),
 * the instances compete for the heartbeat queue, so a worker's beat can land on an instance that did
 * NOT dispatch the step. That instance persists it on the checkpoint, but only the dispatcher holds
 * the `timeoutMs` timer — which never heard the beat, fired, and failed (or re-dispatched) a step
 * that was alive and still running. The dispatcher now reads the persisted beat before giving up.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One engine's view of the broker: which deliveries reach it is up to the test. */
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

function twoInstances(heartbeatPersistThrottleMs = 10_000) {
  const store = new InMemoryStateStore();
  const dispatcherTransport = new ControlTransport();
  const otherTransport = new ControlTransport();
  const dispatcher = new WorkflowEngine({
    store,
    transport: dispatcherTransport,
    heartbeatPersistThrottleMs,
  });
  const other = new WorkflowEngine({
    store,
    transport: otherTransport,
    heartbeatPersistThrottleMs,
  });
  for (const engine of [dispatcher, other]) {
    engine.register('wf', '1', async (ctx) => ctx.step('job', {}, { timeoutMs: 60 }));
  }
  return { dispatcher, dispatcherTransport, otherTransport };
}

describe('remote-step liveness across engine instances', () => {
  it('a beat consumed by ANOTHER instance keeps the step alive on the dispatcher', async () => {
    const { dispatcher, dispatcherTransport, otherTransport } = twoInstances();
    await dispatcher.start('wf', {}, 'r1');
    const done = dispatcher.waitForRun('r1');
    await sleep(0);
    const task = dispatcherTransport.dispatched[0] as RemoteTask;

    await sleep(40);
    // The beat lands on the other instance — the dispatcher's timer never hears it.
    await otherTransport.heartbeatHandler?.({
      runId: 'r1',
      seq: task.seq,
      stepId: task.stepId,
      group: task.group,
      at: Date.now(),
    });
    await sleep(50); // 90ms: past the 60ms window, but only 50ms since the (persisted) beat
    await dispatcherTransport.resultHandler?.({
      runId: 'r1',
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output: 'ok',
    });

    const res = await done;
    expect(res.status).toBe('completed');
    expect(res.output).toBe('ok');
    expect(dispatcherTransport.dispatched).toHaveLength(1); // never re-dispatched while alive
  });

  it('beats the other instance heard but throttled away still count — up to the persist throttle', async () => {
    const { dispatcher, dispatcherTransport, otherTransport } = twoInstances(200);
    await dispatcher.start('wf', {}, 'r3');
    const done = dispatcher.waitForRun('r3');
    await sleep(0);
    const task = dispatcherTransport.dispatched[0] as RemoteTask;
    const beat = () =>
      otherTransport.heartbeatHandler?.({
        runId: 'r3',
        seq: task.seq,
        stepId: task.stepId,
        group: task.group,
        at: Date.now(),
      });
    // The worker beats every 30ms, all on the other instance; only the first beat gets persisted
    // (throttle 200ms), so the checkpoint's beat is soon older than the 60ms window.
    await beat();
    for (let i = 0; i < 5; i += 1) {
      await sleep(30);
      await beat();
    }
    await dispatcherTransport.resultHandler?.({
      runId: 'r3',
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output: 'ok',
    });

    const res = await done;
    expect(res.status).toBe('completed');
    expect(dispatcherTransport.dispatched).toHaveLength(1);
  });

  it('a lone instance gets no allowance: its own persisted beat times out on the plain window', async () => {
    const store = new InMemoryStateStore();
    const transport = new ControlTransport();
    const engine = new WorkflowEngine({ store, transport, heartbeatPersistThrottleMs: 5_000 });
    engine.register('wf', '1', async (ctx) => ctx.step('job', {}, { timeoutMs: 60 }));
    await engine.start('wf', {}, 'r4');
    const done = engine.waitForRun('r4');
    await sleep(0);
    const task = transport.dispatched[0] as RemoteTask;
    const startedAt = Date.now();
    await transport.heartbeatHandler?.({
      runId: 'r4',
      seq: task.seq,
      stepId: task.stepId,
      group: task.group,
      at: Date.now(),
    });

    const res = await done;
    expect(res.status).toBe('failed');
    // Well under the 5s throttle: the beat was this instance's own, so no extra silence was allowed.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('a step whose worker went silent everywhere still times out', async () => {
    const { dispatcher, dispatcherTransport, otherTransport } = twoInstances(100);
    await dispatcher.start('wf', {}, 'r2');
    const done = dispatcher.waitForRun('r2');
    await sleep(0);
    const task = dispatcherTransport.dispatched[0] as RemoteTask;
    // One beat early on the other instance, then silence: the persisted beat ages out.
    await otherTransport.heartbeatHandler?.({
      runId: 'r2',
      seq: task.seq,
      stepId: task.stepId,
      group: task.group,
      at: Date.now(),
    });

    const res = await done;
    expect(res.status).toBe('failed');
    expect(res.error?.message).toMatch(/no result\/heartbeat/);
  });
});
