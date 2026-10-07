import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { SignalWaiter } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * REGRESSION cover: one run must never execute twice at once in ONE process.
 *
 * The run lease is keyed by the engine instance (`lockedBy = instanceId`), and `execute()` treated
 * "the lease is held by this instance" as "the caller already owns it" (true for the leased sweeps,
 * which lock first and then resume). So any lease-free resume landing while this same process was
 * still executing the run — a signal delivered while the run was still parking, a late step result,
 * an explicit `resume()`, a second signal — sailed past the lease and ran the body concurrently: a
 * not-yet-checkpointed step's body ran twice (live: a durable step answered an external API twice).
 *
 * Each test holds the run inside a step body (a gate) so the racing resume deterministically lands
 * mid-execution, then counts how many times step bodies ran.
 */

function gate(): {
  reached: Promise<void>;
  hit: () => void;
  release: () => void;
  open: Promise<void>;
} {
  let hit!: () => void;
  const reached = new Promise<void>((resolve) => {
    hit = resolve;
  });
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, hit, release, open };
}

async function settle(engine: WorkflowEngine, runId: string): Promise<string> {
  await engine.drain(5_000);
  return (await engine.getRun(runId))?.status ?? 'missing';
}

describe('a run never executes concurrently in one process', () => {
  it('a resume landing while the run executes waits for that execution instead of joining it', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const g = gate();
    let bodies = 0;
    let live = 0;
    let maxLive = 0;
    engine.register('wf', '1', async (ctx) => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      try {
        return await ctx.localStep('call-api', async () => {
          bodies += 1;
          g.hit();
          await g.open;
          return 'answered';
        });
      } finally {
        live -= 1;
      }
    });

    const { runId } = await engine.start('wf', {}, 'r-resume-vs-running');
    await g.reached; // the first execution is inside the step, holding the lease
    const racing = engine.resume(runId);
    await new Promise((r) => setTimeout(r, 20)); // give a concurrent execution every chance to start
    g.release();
    await racing;

    expect(bodies).toBe(1);
    expect(maxLive).toBe(1);
    expect(await settle(engine, runId)).toBe('completed');
  });

  it('a signal delivered while the run is still parking does not re-run the next step concurrently', async () => {
    // The live shape: the decision lands between `putSignalWaiter` and the run settling `suspended`.
    // Its resume and the parking execution's own re-check both drive the run; the step after the
    // wait must still run exactly once.
    const box: { decide?: (() => Promise<unknown>) | undefined } = {};
    class RacingStore extends InMemoryStateStore {
      override async putSignalWaiter(waiter: SignalWaiter): Promise<void> {
        await super.putSignalWaiter(waiter);
        const decide = box.decide;
        box.decide = undefined;
        void decide?.();
      }
    }
    const engine = new WorkflowEngine({ store: new RacingStore() });
    let replies = 0;
    let live = 0;
    let maxLive = 0;
    engine.register('wf', '1', async (ctx) => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      try {
        await ctx.localStep('ask', async () => 'asked');
        const decision = await ctx.waitForSignal<string>('decision');
        return await ctx.localStep('reply', async () => {
          replies += 1;
          await new Promise((r) => setTimeout(r, 30)); // an HTTP call: slow enough to overlap
          return `replied ${decision}`;
        });
      } finally {
        live -= 1;
      }
    });

    box.decide = () => engine.signal('decision', 'approve');
    const { runId } = await engine.start('wf', {}, 'r-signal-while-parking');
    await engine.waitForRun(runId, { timeoutMs: 5_000, terminal: true });

    expect(replies).toBe(1);
    expect(maxLive).toBe(1);
    expect(await settle(engine, runId)).toBe('completed');
    expect((await engine.getRun(runId))?.output).toBe('replied approve');
  });

  it('two resumes racing each other drive the run one at a time', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const g = gate();
    let bodies = 0;
    let live = 0;
    let maxLive = 0;
    engine.register('wf', '1', async (ctx) => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      try {
        const decision = await ctx.waitForSignal<string>('approve');
        return await ctx.localStep('tool', async () => {
          bodies += 1;
          g.hit();
          await g.open;
          return `ran ${decision}`;
        });
      } finally {
        live -= 1;
      }
    });

    const { runId } = await engine.start('wf', {}, 'r-two-resumes');
    await engine.waitForRun(runId, { timeoutMs: 5_000 });
    expect((await engine.getRun(runId))?.status).toBe('suspended');

    // Resume #1: the signal drives the run into the tool step.
    const first = engine.signal('approve', 'yes');
    await g.reached;
    // Resume #2 and #3 race it — a duplicate delivery / an explicit retry / a second wake-up.
    const second = engine.resume(runId);
    const third = engine.resume(runId);
    await new Promise((r) => setTimeout(r, 20));
    g.release();
    const results = await Promise.all([first, second, third]);

    expect(bodies).toBe(1);
    expect(maxLive).toBe(1);
    // The queued resumes report the run's state after the execution they waited for, not a stale one.
    for (const result of results) expect(result?.status).toBe('completed');
    expect(await settle(engine, runId)).toBe('completed');
  });

  it('two engines sharing a store (two processes) still exclude each other through the lease', async () => {
    const store = new InMemoryStateStore();
    const g = gate();
    let bodies = 0;
    const make = () => {
      const engine = new WorkflowEngine({ store });
      engine.register('wf', '1', async (ctx) => {
        const decision = await ctx.waitForSignal<string>('approve-x');
        return ctx.localStep('tool', async () => {
          bodies += 1;
          g.hit();
          await g.open;
          return `ran ${decision}`;
        });
      });
      return engine;
    };
    const a = make();
    const b = make();
    const { runId } = await a.start('wf', {}, 'r-cross-process');
    await a.waitForRun(runId, { timeoutMs: 5_000 });

    const first = a.signal('approve-x', 'yes');
    await g.reached;
    // The other process: the lease (held by `a`) turns it away without running anything.
    const other = await b.resume(runId);
    expect(other.status).not.toBe('completed');
    g.release();
    await first;

    expect(bodies).toBe(1);
    expect(await settle(a, runId)).toBe('completed');
  });

  it('a run that resumes itself from inside its own execution does not deadlock', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    let steps = 0;
    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('poke-self', async () => {
        steps += 1;
        // Awaiting your own resume can only be satisfied after this execution ends: it must not hang.
        const r = await engine.resume(ctx.runId);
        return r.status;
      });
      return 'done';
    });
    const { runId } = await engine.start('wf', {}, 'r-self');
    const result = await engine.waitForRun(runId, { timeoutMs: 2_000, terminal: true });
    expect(result.status).toBe('completed');
    expect(steps).toBe(1);
    expect(await settle(engine, runId)).toBe('completed');
  });
});
