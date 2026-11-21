import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  Heartbeat,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowStepEvent,
} from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

/**
 * REGRESSION (issue #575): a remote step with a liveness `timeoutMs` is awaited IN MEMORY on the
 * instance that dispatched it. With several engine instances sharing the results queue, its result
 * can be consumed by ANOTHER instance — which settles the checkpoint, but has no waiter for it, and
 * whose resume is refused by the lease the dispatcher's parked turn holds. The dispatcher used to see
 * the result only when `timeoutMs` ran out (the spurious-timeout salvage), so every such step took
 * the whole `timeoutMs`. It now ends its wait from the settled checkpoint: at once on the other
 * instance's `step.completed` broadcast, or at the next checkpoint poll with no control plane.
 */

const TIMEOUT_MS = 5_000;

/** One engine's view of the broker: which deliveries reach it is up to the test. */
class ControlTransport implements Transport {
  resultHandler?: (r: StepResult) => Promise<void>;
  readonly dispatched: RemoteTask[] = [];
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(h: (r: StepResult) => Promise<void>): void {
    this.resultHandler = h;
  }
  onHeartbeat(_h: (b: Heartbeat) => Promise<void>): void {}
  async dispatchStepEvent(_event: WorkflowStepEvent): Promise<void> {}
}

function twoInstances(
  opts: { remoteResultPollMs?: number; controlPlane?: boolean; retries?: number } = {},
) {
  const store = new InMemoryStateStore();
  const control = opts.controlPlane ? new InMemoryTransport() : undefined;
  const dispatcherTransport = new ControlTransport();
  const otherTransport = new ControlTransport();
  const make = (transport: ControlTransport, instanceId: string) =>
    new WorkflowEngine({
      store,
      transport,
      instanceId,
      ...(control ? { controlPlane: control } : {}),
      ...(opts.remoteResultPollMs !== undefined
        ? { remoteResultPollMs: opts.remoteResultPollMs }
        : {}),
    });
  const dispatcher = make(dispatcherTransport, 'A');
  const other = make(otherTransport, 'B');
  for (const engine of [dispatcher, other]) {
    engine.register('wf', '1', async (ctx) => {
      const a = await ctx.step(
        'a',
        {},
        { timeoutMs: TIMEOUT_MS, ...(opts.retries ? { retries: opts.retries } : {}) },
      );
      const b = await ctx.step('b', {}, { timeoutMs: TIMEOUT_MS });
      return (a as number) + (b as number);
    });
  }
  return { dispatcher, dispatcherTransport, otherTransport };
}

async function until(predicate: () => boolean, max = 2_000): Promise<void> {
  const deadline = Date.now() + max;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Hand the result of `transport`'s `index`-th dispatched task to the OTHER instance. */
async function resultElsewhere(
  from: ControlTransport,
  to: ControlTransport,
  index: number,
  result: Pick<StepResult, 'status' | 'output' | 'error'>,
): Promise<void> {
  await until(() => from.dispatched.length > index);
  const task = from.dispatched[index] as RemoteTask;
  await to.resultHandler?.({
    runId: task.runId,
    seq: task.seq,
    stepId: task.stepId,
    startedAt: Date.now(),
    ...result,
  } as StepResult);
}

describe('timeoutMs step whose result another instance consumed (issue #575)', () => {
  it('with no control plane, the checkpoint poll ends the wait long before timeoutMs', async () => {
    const { dispatcher, dispatcherTransport, otherTransport } = twoInstances({
      remoteResultPollMs: 20,
    });
    const started = Date.now();
    await dispatcher.start('wf', {}, 'r1');
    const done = dispatcher.waitForRun('r1');
    await resultElsewhere(dispatcherTransport, otherTransport, 0, {
      status: 'completed',
      output: 1,
    });
    await resultElsewhere(dispatcherTransport, otherTransport, 1, {
      status: 'completed',
      output: 2,
    });
    const run = await done;
    expect(run.status).toBe('completed');
    expect(run.output).toBe(3);
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS / 2);
    // Settled by the instance that consumed it: nothing re-dispatched.
    expect(dispatcherTransport.dispatched).toHaveLength(2);
  });

  it("with a control plane and no poll, the other instance's broadcast ends the wait", async () => {
    const { dispatcher, dispatcherTransport, otherTransport } = twoInstances({
      remoteResultPollMs: 0,
      controlPlane: true,
    });
    const started = Date.now();
    await dispatcher.start('wf', {}, 'r2');
    const done = dispatcher.waitForRun('r2');
    await resultElsewhere(dispatcherTransport, otherTransport, 0, {
      status: 'completed',
      output: 1,
    });
    await resultElsewhere(dispatcherTransport, otherTransport, 1, {
      status: 'completed',
      output: 2,
    });
    const run = await done;
    expect(run.status).toBe('completed');
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS / 2);
  });

  it('a failure another instance consumed fails the step, without re-dispatching it', async () => {
    const { dispatcher, dispatcherTransport, otherTransport } = twoInstances({
      remoteResultPollMs: 20,
      retries: 3,
    });
    const started = Date.now();
    await dispatcher.start('wf', {}, 'r3');
    const done = dispatcher.waitForRun('r3');
    await resultElsewhere(dispatcherTransport, otherTransport, 0, {
      status: 'failed',
      error: { message: 'boom' },
    });
    const run = await done;
    expect(run.status).toBe('failed');
    expect(JSON.stringify(run.error)).toContain('boom');
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS / 2);
    expect(dispatcherTransport.dispatched).toHaveLength(1);
  });
});
