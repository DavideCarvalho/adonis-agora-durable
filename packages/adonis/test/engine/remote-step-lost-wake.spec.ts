import { WorkflowEngine } from '../../src/engine.js';
import type { RemoteTask, StepResult, Transport, WorkflowRun } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

/**
 * REGRESSION: a `ctx.step` result that another instance settles while the turn that dispatched it
 * still holds the run's lease must still resume the run.
 *
 * The other instance's resume reaches `execute`, finds the lease held by the dispatching instance,
 * and returns without doing anything. The dispatching turn then writes `suspended` and releases the
 * lease — with the step already `completed` and nothing left to wake the run. Under a wide `ctx.all`
 * fan (40k children, six workers, results consumed by any pod) this parked ~5k children until their
 * redispatch deadline, an hour later.
 *
 * `reconcileMs: 0` turns the orphan sweep off, so the test asserts the wake itself rather than the
 * safety net.
 */

const STEP = 'lines.process';

/** Holds the dispatching turn's `suspended` write until the test lets it through. */
class HeldSuspendStore extends InMemoryStateStore {
  release: (() => void) | undefined;
  held = false;

  override async updateRunIf(
    runId: string,
    expected: Parameters<InMemoryStateStore['updateRunIf']>[1],
    patch: Partial<WorkflowRun>,
  ): Promise<boolean> {
    if (patch.status === 'suspended' && !this.held) {
      this.held = true;
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return super.updateRunIf(runId, expected, patch);
  }
}

/** Captures dispatches; results are delivered by the test, to whichever instance it picks. */
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

async function until(check: () => boolean | Promise<boolean>, max = 200): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

describe('REGRESSION: a step result settled by another instance during the dispatching turn', () => {
  it('resumes the run once the dispatching turn releases its lease', async () => {
    const store = new HeldSuspendStore();
    const onA = new CapturingTransport();
    const onB = new CapturingTransport();
    const a = new WorkflowEngine({
      store,
      transports: [{ id: 't', transport: onA }],
      reconcileMs: 0,
    });
    const b = new WorkflowEngine({
      store,
      transports: [{ id: 't', transport: onB }],
      reconcileMs: 0,
    });
    for (const engine of [a, b]) {
      engine.register('line', '1', async (ctx) => ctx.step<{ index: number }>(STEP, { index: 7 }));
    }

    const started = startRun(a, 'line', {}, 'run1');
    await until(() => onA.dispatched.length === 1 && store.release !== undefined);
    const task = onA.dispatched[0];
    if (!task) throw new Error('expected a dispatched task');

    // B settles the step; its resume finds A's lease and is dropped.
    await onB.result?.({
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output: { index: 7 },
    });
    expect((await store.getRun('run1'))?.lockedBy).toBeDefined();

    store.release?.();
    await started;
    await until(async () => (await store.getRun('run1'))?.status === 'completed');
    expect((await store.getRun('run1'))?.output).toEqual({ index: 7 });
  });

  it('does not replay the body again for a result settled on the same instance', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle(STEP, async (input) => ({ index: (input as { index: number }).index }));
    const engine = new WorkflowEngine({
      store,
      transports: [{ id: 't', transport }],
      reconcileMs: 0,
    });
    let bodyRuns = 0;
    engine.register('line', '1', async (ctx) => {
      bodyRuns += 1;
      return ctx.step<{ index: number }>(STEP, { index: 7 });
    });

    await startRun(engine, 'line', {}, 'run1');
    await until(async () => (await store.getRun('run1'))?.status === 'completed');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // One turn dispatches and suspends, one replays the result and completes.
    expect(bodyRuns).toBe(2);
  });
});
