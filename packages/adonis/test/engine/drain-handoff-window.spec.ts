import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkflowRun } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Gates the `createRun` write of ONE run id — the durable persist an internal handoff (continue-as-new's
 * next run, a deferred child) issues on the settle path. Holding it open lets a test reproduce the
 * escape window the review flagged: between the parent settling and the handoff's new run entering
 * `inflight` there are microtask hops + this store I/O, and the pre-fix bridge
 * (`queueMicrotask(() => void this.start(...))`) left that write UNtracked, so `drain()` could observe
 * both registries empty and return early — letting the write land after a torn-down connection (a
 * rolled-back Lucid test transaction → "Transaction query already complete").
 */
class GatedCreateStore extends InMemoryStateStore {
  gateRunId: string | null = null;
  createStarted = false;
  createCompleted = false;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  /** Let the held `createRun` through. */
  open(): void {
    this.release();
  }

  override async createRun(run: WorkflowRun): Promise<void> {
    if (this.gateRunId != null && run.id === this.gateRunId) {
      this.createStarted = true;
      await this.gate;
      await super.createRun(run);
      this.createCompleted = true;
      return;
    }
    await super.createRun(run);
  }
}

describe('drain waits for internal run handoffs (continue-as-new / deferred child)', () => {
  it('drain() does not resolve until a continue-as-new continuation is persisted and processed', async () => {
    const store = new GatedCreateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('chain', '1', async (ctx, input) => {
      const { n } = input as { n: number };
      // First run hands off to a fresh execution; the continuation (n = 1) just completes.
      if (n === 0) await ctx.continueAsNew({ n: 1 });
      return `done-${n}`;
    });

    // Gate the continuation run's persist so the handoff parks mid-flight, holding the window open.
    store.gateRunId = 'p~1';

    await engine.start('chain', { n: 0 }, 'p');
    await flush();

    // Parent settled (continue-as-new completes it), and the handoff has reached the gated persist.
    expect((await store.getRun('p'))?.status).toBe('completed');
    expect(store.createStarted).toBe(true);
    expect(store.createCompleted).toBe(false);

    // drain() must NOT resolve while the continuation's persist is still open. On the pre-fix engine the
    // handoff was an untracked `queueMicrotask(start)`, so both registries read empty here and drain
    // returned immediately → this assertion failed and the continuation's writes escaped the drain.
    let drained = false;
    const drainP = engine.drain(5_000).then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);

    store.open();
    await drainP;
    expect(drained).toBe(true);
    // The continuation was persisted AND processed to completion before drain resolved.
    expect(store.createCompleted).toBe(true);
    expect((await store.getRun('p~1'))?.status).toBe('completed');
    expect((await store.getRun('p~1'))?.output).toBe('done-1');
  });

  it('drain() does not resolve until a deferred child is persisted, processed, and its parent resumed', async () => {
    const store = new GatedCreateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('parent', '1', async (ctx) => {
      const r = await ctx.child<string>('kid', {}, 'kid-1');
      return `parent:${r}`;
    });
    engine.register('kid', '1', async () => 'kid-done');

    // Gate the child's persist: the parent suspends on `child:kid-1` while the handoff parks here.
    store.gateRunId = 'kid-1';

    await engine.start('parent', {}, 'p');
    await flush();

    expect((await store.getRun('p'))?.status).toBe('suspended');
    expect(store.createStarted).toBe(true);
    expect(store.createCompleted).toBe(false);

    // Pre-fix: the deferred child start was untracked, so drain saw empty registries and returned early.
    let drained = false;
    const drainP = engine.drain(5_000).then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);

    store.open();
    await drainP;
    expect(drained).toBe(true);
    // The child ran to completion and its parent was resumed to completion — all before drain resolved.
    expect((await store.getRun('kid-1'))?.status).toBe('completed');
    expect((await store.getRun('p'))?.status).toBe('completed');
    expect((await store.getRun('p'))?.output).toBe('parent:kid-done');
  });

  it('the settle path does NOT block on the handoff (execute returns before the continuation persists)', async () => {
    const store = new GatedCreateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('chain', '1', async (ctx, input) => {
      const { n } = input as { n: number };
      if (n === 0) await ctx.continueAsNew({ n: 1 });
      return `done-${n}`;
    });

    // Hold the continuation's persist open indefinitely.
    store.gateRunId = 'p~1';

    await engine.start('chain', { n: 0 }, 'p');
    // The parent reaches `completed` even though the continuation persist is still gated — proving the
    // handoff is off the execute() critical path (it only holds `drain`, not the settling run).
    const parent = await engine.waitForRun('p', { timeoutMs: 1_000 });
    expect(parent.status).toBe('completed');
    expect(store.createCompleted).toBe(false);

    store.open();
    await engine.drain();
    expect((await store.getRun('p~1'))?.status).toBe('completed');
  });
});

describe('drain timeout on a long / hot continue-as-new chain', () => {
  it('consumes the whole timeout, then leaves the frontier link leased for recovery (no loss)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const FRONTIER = 6; // links p → p~1 → … → p~6
    const LIMIT = 7; // one link past the frontier, so the chain terminates cleanly once released
    let releaseFrontier!: () => void;
    const frontierGate = new Promise<void>((r) => {
      releaseFrontier = r;
    });
    const reached: number[] = [];

    engine.register('chain', '1', async (ctx, input) => {
      const { n } = input as { n: number };
      reached.push(n);
      // The frontier link parks mid-execution: it is persisted + leased but never settles, so the
      // chain can't finish and drain() must lean on its timeout — a stand-in for a perpetually hot
      // continue-as-new loop that keeps handing off faster than it drains.
      if (n === FRONTIER) await frontierGate;
      if (n < LIMIT) await ctx.continueAsNew({ n: n + 1 });
      return `done-${n}`;
    });

    await engine.start('chain', { n: 0 }, 'p');
    // The chain flows across every link through the tracked handoffs until the frontier (p~6) parks.
    for (let i = 0; i < 500 && !reached.includes(FRONTIER); i += 1) await flush();
    expect(reached).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect((await store.getRun('p~5'))?.status).toBe('completed');

    // drain() can't reach steady-state empty (the frontier is in-flight and about to hand off again),
    // so it must be CUT by the timeout — not return early, not hang forever. Assert it returns at
    // ~timeoutMs: this is the "a hot continue-as-new loop consumes the whole timeout" property.
    const timeoutMs = 150;
    const t0 = Date.now();
    await engine.drain(timeoutMs);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 30);
    expect(elapsed).toBeLessThan(timeoutMs + 500);

    // No loss: at the timeout the frontier link is PERSISTED with the lease RELEASED (running,
    // lockedBy cleared), i.e. unowned work a fresh boot's recoverIncomplete() reclaims immediately —
    // not a dropped/vanished run, and not stuck behind a lease expiry.
    const frontier = await store.getRun('p~6');
    expect(frontier?.status).toBe('running');
    expect(frontier?.lockedBy).toBeFalsy();

    // And prove the frontier work is genuinely resumable, not stranded: release it and let the chain
    // finish. p~6 hands off to p~7, which is past LIMIT and completes. Nothing was lost to the timeout.
    releaseFrontier();
    for (let i = 0; i < 500 && (await store.getRun('p~7'))?.status !== 'completed'; i += 1) {
      await flush();
    }
    expect((await store.getRun('p~6'))?.status).toBe('completed');
    expect((await store.getRun('p~7'))?.output).toBe('done-7');
  });
});
