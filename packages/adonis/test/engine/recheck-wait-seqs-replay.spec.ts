import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { RemoteTask, StepResult, Transport, WorkflowRun } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * A step result settled on the SAME instance while the dispatching turn still holds the lease must
 * not make the engine replay the body an extra time: that result's own resume already drives the
 * run (`execute` admits this instance into a lease it holds). A body with effects between steps —
 * an agent turn recording its tool call — breaks on the extra replay.
 */

const STEP = 'ext.ping';

/** Holds the dispatching turn's `suspended` write until the result has been settled and resumed. */
class HoldSuspendStore extends InMemoryStateStore {
  gate: Promise<void> | undefined;
  override async updateRunIf(
    runId: string,
    expected: Parameters<InMemoryStateStore['updateRunIf']>[1],
    patch: Partial<WorkflowRun>,
  ): Promise<boolean> {
    if (patch.status === 'suspended' && this.gate) {
      const gate = this.gate;
      this.gate = undefined;
      await gate;
    }
    return super.updateRunIf(runId, expected, patch);
  }
}

class CapturingTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  result: ((r: StepResult) => Promise<void>) | undefined;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(): void {}
}

describe('recheckWaitSeqs and a result settled on the same instance', () => {
  it('does not replay the body an extra time', async () => {
    const store = new HoldSuspendStore();
    const transport = new CapturingTransport();
    const engine = new WorkflowEngine({
      store,
      transports: [{ id: 't', transport }],
      reconcileMs: 0,
    });
    let bodyRuns = 0;
    engine.register('wf', '1', async (ctx) => {
      bodyRuns += 1;
      return ctx.step<{ pong: boolean }>(STEP, {});
    });

    let open!: () => void;
    store.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const started = startRun(engine, 'wf', {}, 'r1');
    for (let i = 0; i < 200 && transport.dispatched.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const task = transport.dispatched[0];
    if (!task) throw new Error('expected a dispatched task');
    // The result lands on this instance mid-settle; its resume re-enters the held lease and completes.
    await transport.result?.({
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output: { pong: true },
    });
    for (let i = 0; i < 200 && (await store.getRun('r1'))?.status !== 'completed'; i += 1) {
      await new Promise((r) => setTimeout(r, 1));
    }
    open();
    await started.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));

    expect(bodyRuns).toBe(2);
  });
  it('does not replay the body an extra time while the result resume is in flight', async () => {
    const store = new HoldSuspendStore();
    const transport = new CapturingTransport();
    const engine = new WorkflowEngine({
      store,
      transports: [{ id: 't', transport }],
      reconcileMs: 0,
    });
    let bodyRuns = 0;
    engine.register('wf', '1', async (ctx) => {
      bodyRuns += 1;
      return ctx.step<{ pong: boolean }>(STEP, {});
    });

    let open!: () => void;
    store.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const started = startRun(engine, 'wf', {}, 'r1');
    for (let i = 0; i < 200 && transport.dispatched.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const task = transport.dispatched[0];
    if (!task) throw new Error('expected a dispatched task');
    // The result lands on this instance mid-settle; its resume re-enters the held lease and completes.
    void transport.result?.({
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output: { pong: true },
    });
    await new Promise((r) => setImmediate(r));
    open();
    await started.catch(() => undefined);
    for (let i = 0; i < 200 && (await store.getRun('r1'))?.status !== 'completed'; i += 1) {
      await new Promise((r) => setTimeout(r, 2));
    }
    await new Promise((r) => setTimeout(r, 50));

    expect(bodyRuns).toBe(2);
  });
});
