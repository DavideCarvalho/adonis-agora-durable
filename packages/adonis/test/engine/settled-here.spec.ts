import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { RemoteTask, StepResult, Transport } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * A result that lands right after the turn that sent its step suspended is settled here and resumes
 * the run here. The suspended turn's re-check of that step then finds it settled, and must not
 * resume the run a second time: each step costs one replay.
 */

/** Answers every step a moment after it is sent, before the sending turn's re-check runs. */
class InstantTransport implements Transport {
  result?: (r: StepResult) => Promise<void>;
  sent = 0;
  async dispatch(task: RemoteTask): Promise<void> {
    this.sent += 1;
    setImmediate(() => {
      void this.result?.({
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        status: 'completed',
        output: task.seq,
      });
    });
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(): void {}
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

describe('a result settled here right after its turn suspended', () => {
  it('resumes the run once: one replay per step', async () => {
    const store = new InMemoryStateStore();
    const transport = new InstantTransport();
    const engine = new WorkflowEngine({
      store,
      transports: [{ id: 't', transport }],
      reconcileMs: 0,
    });
    let turns = 0;
    const STEPS = 8;
    engine.register('chat', '1', async (ctx) => {
      turns += 1;
      const out: unknown[] = [];
      for (let i = 0; i < STEPS; i += 1) out.push(await ctx.step('llm.ask', { turn: i }));
      return out;
    });
    await startRun(engine, 'chat', {}, 'r1');
    await until(async () => (await store.getRun('r1'))?.status === 'completed');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((await store.getRun('r1'))?.output).toEqual(Array.from({ length: STEPS }, (_, i) => i));
    expect(transport.sent).toBe(STEPS);
    // The first turn, then one per settled step.
    expect(turns).toBe(STEPS + 1);
  });

  it('keeps the steps it settled for a lease only', () => {
    let now = 0;
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      leaseMs: 100,
      clock: () => now,
    });
    const internals = engine as unknown as {
      settledHere: Map<string, number>;
      noteSettledHere(runId: string, seqs: number[]): void;
    };
    internals.noteSettledHere('a', [0, 1]);
    now = 50;
    internals.noteSettledHere('b', [0]);
    now = 90;
    internals.noteSettledHere('a', [1]);
    now = 160;
    internals.noteSettledHere('c', [0]);
    // `a:0` (noted at 0) and `b:0` (at 50) are stale; `a:1` was noted again at 90.
    expect([...internals.settledHere.keys()]).toEqual(['a:1', 'c:0']);
  });
});
