import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { RemoteTask, WorkflowRun } from '../../src/interfaces.js';
import { defineStep } from '../../src/step-ref.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

const flush = async (rounds = 20): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const baseRun = (over: Partial<WorkflowRun> & { id: string; workflow: string }): WorkflowRun => ({
  workflowVersion: '1',
  status: 'completed',
  input: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe('zombie fencing — a turn that lost its lease must not settle', () => {
  it('a renew that reports takeover fences the settle: the old executor cannot clobber the run', async () => {
    const store = new InMemoryStateStore();
    // Tiny lease → renew interval ≈ 50ms, so the takeover is observed quickly.
    const engine = new WorkflowEngine({ store, leaseMs: 100, instanceId: 'A' });
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((r) => {
      releaseBody = r;
    });
    engine.register('slow', '1', async (ctx) => {
      await ctx.localStep('park', async () => {
        await bodyGate;
      });
      return 'zombie-output';
    });

    await engine.start('slow', {}, 'z');
    await flush();
    expect((await store.getRun('z'))?.status).toBe('running');

    // Simulate the takeover: the lease lapses (operator clear stands in for expiry) and another
    // instance claims the run. A's next renew (≤50ms away) returns false → A is fenced.
    await store.releaseRunLock('z');
    expect(await store.tryLockRun('z', 'intruder', Date.now() + 60_000, Date.now())).toBe(true);
    await sleep(150);

    // The zombie turn finishes its body — but its settle must degrade to an echo, never a write.
    releaseBody();
    await flush();
    const run = await store.getRun('z');
    expect(run?.status).toBe('running'); // the new owner's to settle, untouched by the zombie
    expect(run?.output).toBeUndefined();
    expect(run?.lockedBy).toBe('intruder'); // the owner-scoped release left the intruder's lease alone
  });
});

describe('durable child-completion recovery — the run row is the source of truth', () => {
  it('ctx.child resolves from an already-terminal child even when its notify signal was lost', async () => {
    const store = new InMemoryStateStore();
    // The child's terminal state exists ONLY as its run row: no signal was delivered, none buffered
    // — exactly the state a crash between the child's settle and its parent notify leaves behind.
    await store.createRun(baseRun({ id: 'kid-1', workflow: 'kid', output: 'kid-done' }));
    const engine = new WorkflowEngine({ store });
    engine.register('parent', '1', async (ctx) => {
      const r = await ctx.child<string>('kid', {}, 'kid-1');
      return `parent:${r}`;
    });
    engine.register('kid', '1', async () => 'never-runs');

    await engine.start('parent', {}, 'p');
    await flush();
    const parent = await store.getRun('p');
    expect(parent?.status).toBe('completed');
    expect(parent?.output).toBe('parent:kid-done');
  });

  it('ctx.child observes a cancelled child as a failure instead of waiting forever', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(
      baseRun({
        id: 'kid-1',
        workflow: 'kid',
        status: 'cancelled',
        error: { message: 'cancelled' },
      }),
    );
    const engine = new WorkflowEngine({ store });
    engine.register('parent', '1', async (ctx) => {
      await ctx.child('kid', {}, 'kid-1');
      return 'unreachable';
    });
    engine.register('kid', '1', async () => 'never-runs');

    await engine.start('parent', {}, 'p');
    await flush();
    const parent = await store.getRun('p');
    expect(parent?.status).toBe('failed');
    expect(parent?.error?.message).toContain('cancelled');
  });

  it('ctx.all resolves a fan whose completions were all lost, from the child run rows', async () => {
    const store = new InMemoryStateStore();
    // Fan ids are `<runId>.all.<firstSeq>.<i>`; the all() is the workflow's first ctx call → seq 0.
    await store.createRun(baseRun({ id: 'p.all.0.0', workflow: 'kid', output: 'a' }));
    await store.createRun(baseRun({ id: 'p.all.0.1', workflow: 'kid', output: 'b' }));
    const engine = new WorkflowEngine({ store });
    engine.register('parent', '1', async (ctx) => {
      const outs = await ctx.all<string>('kid', [{}, {}]);
      return outs.join('+');
    });
    engine.register('kid', '1', async () => 'never-runs');

    await engine.start('parent', {}, 'p');
    await flush();
    const parent = await store.getRun('p');
    expect(parent?.status).toBe('completed');
    expect(parent?.output).toBe('a+b');
  });
});

describe('continue-as-new convergence', () => {
  it('converges on an already-persisted continuation instead of throwing (crash-recovery replay)', async () => {
    const store = new InMemoryStateStore();
    // The continuation persisted, then the process crashed before the parent's terminal write:
    // recovery replays the parent, ContinueAsNew re-throws, and the pre-persisted `p~1` must be
    // adopted, not treated as a duplicate error.
    await store.createRun(
      baseRun({ id: 'p~1', workflow: 'chain', status: 'pending', input: { n: 1 } }),
    );
    const engine = new WorkflowEngine({ store });
    engine.register('chain', '1', async (ctx, input) => {
      const { n } = input as { n: number };
      if (n === 0) await ctx.continueAsNew({ n: 1 });
      return `done-${n}`;
    });

    await engine.start('chain', { n: 0 }, 'p');
    await flush();
    expect((await store.getRun('p'))?.status).toBe('completed');
    expect((await store.getRun('p~1'))?.status).toBe('completed');
    expect((await store.getRun('p~1'))?.output).toBe('done-1');
  });
});

describe('start() duplicate-race convergence', () => {
  class RaceStore extends InMemoryStateStore {
    /** Ids whose NEXT getRun returns null — simulating the read-before-create miss of a true race. */
    readonly missOnce = new Set<string>();
    override async getRun(runId: string): Promise<WorkflowRun | null> {
      if (this.missOnce.delete(runId)) return null;
      return super.getRun(runId);
    }
  }

  it('a losing createRun race returns the winner’s state instead of throwing', async () => {
    const store = new RaceStore();
    await store.createRun(baseRun({ id: 'dup', workflow: 'wf', output: 42 }));
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async () => 'fresh');

    store.missOnce.add('dup');
    const result = await engine.start('wf', {}, 'dup');
    expect(result.status).toBe('completed');
    expect(result.output).toBe(42);
    // The winner's row was not clobbered.
    expect((await store.getRun('dup'))?.output).toBe(42);
  });
});

describe('recoverIncomplete cannot resurrect a settled run', () => {
  class SettlingLockStore extends InMemoryStateStore {
    /** When set, the run settles `completed` right AFTER recovery acquires its lock — the
     *  redelivered-result-wins-the-race interleaving. */
    settleOnLock: string | null = null;
    override async tryLockRun(
      runId: string,
      owner: string,
      leaseUntilMs: number,
      nowMs: number,
    ): Promise<boolean> {
      const ok = await super.tryLockRun(runId, owner, leaseUntilMs, nowMs);
      if (ok && runId === this.settleOnLock) {
        this.settleOnLock = null;
        await super.updateRun(runId, {
          status: 'completed',
          output: 'late',
          updatedAt: new Date(),
        });
      }
      return ok;
    }
  }

  it('skips the pending flip when the run settled in the gap (no double execution)', async () => {
    const store = new SettlingLockStore();
    await store.createRun(baseRun({ id: 'r', workflow: 'wf', status: 'running' }));
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async () => 'fresh');

    store.settleOnLock = 'r';
    const results = await engine.recoverIncomplete();
    await flush();
    expect(results).toEqual([]); // nothing recovered — the settled run was left alone
    const run = await store.getRun('r');
    expect(run?.status).toBe('completed'); // NOT clobbered back to pending / re-executed
    expect(run?.output).toBe('late');
    expect(run?.lockedBy).toBeUndefined(); // and the recovery lease was released
  });
});

describe('durable saga compensation', () => {
  it('a dispatched undo whose result lands on ANOTHER pod still completes the unwind', async () => {
    const store = new InMemoryStateStore();
    const tA = new (class extends InMemoryTransport {
      other?: InMemoryTransport;
      forward = new Set<string>();
      override async dispatch(task: RemoteTask): Promise<void> {
        // Shared-results-queue simulation: the undo's job (and thus its RESULT) goes to pod B.
        if (this.other && this.forward.has(task.name)) return this.other.dispatch(task);
        return super.dispatch(task);
      }
    })();
    const tB = new InMemoryTransport();
    tA.other = tB;
    tA.forward.add('billing:refund');

    const undoCalls: unknown[] = [];
    tA.handle('billing:charge', async () => ({ chargeId: 'ch_1' }));
    tB.handle('billing:refund', async (undo) => {
      undoCalls.push(undo);
      return { refunded: true };
    });
    const refund = defineStep('billing:refund', async () => ({ refunded: true }));

    const register = (target: WorkflowEngine): void => {
      target.register('checkout', '1', async (ctx) => {
        await ctx.step('billing:charge', { amount: 1 }, { compensate: refund });
        await ctx.localStep('boom', async () => {
          throw new Error('downstream failure');
        });
      });
    };
    const engineA = new WorkflowEngine({ store, transport: tA, instanceId: 'A' });
    const engineB = new WorkflowEngine({ store, transport: tB, instanceId: 'B' });
    register(engineA);
    register(engineB);

    await engineA.start('checkout', {}, 'run1');
    // Drive to failure; the unwind awaits the undo whose result pod B consumes. Pod A's checkpoint
    // poll (1s cadence) must observe B's settle — the old in-memory-only waiter hung here forever.
    for (let i = 0; i < 40; i += 1) {
      await flush();
      if ((await store.getRun('run1'))?.status === 'failed') break;
      await sleep(100);
    }
    const run = await store.getRun('run1');
    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toBe('downstream failure');
    expect(undoCalls).toHaveLength(1);
    // The undo left its durable marker at the reserved negative seq.
    const cp = await store.getCheckpoint('run1', -2);
    expect(cp?.status).toBe('completed');
    expect(cp?.name).toBe('compensate:billing:refund');
  }, 15_000);

  it('a re-driven unwind skips undos already recorded as done (no double refund)', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let undoRan = 0;
    transport.handle('billing:charge', async () => ({ chargeId: 'ch_1' }));
    transport.handle('billing:refund', async () => {
      undoRan += 1;
      return { refunded: true };
    });
    const refund = defineStep('billing:refund', async () => ({ refunded: true }));
    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (ctx) => {
      await ctx.step('billing:charge', { amount: 1 }, { compensate: refund });
      await ctx.localStep('boom', async () => {
        throw new Error('always fails');
      });
    });

    await engine.start('checkout', {}, 'run1');
    for (let i = 0; i < 50; i += 1) {
      await flush();
      if ((await store.getRun('run1'))?.status === 'failed') break;
    }
    expect((await store.getRun('run1'))?.status).toBe('failed');
    expect(undoRan).toBe(1);
    expect((await store.getCheckpoint('run1', -2))?.status).toBe('completed');

    // Retry the run: replay re-fails, the unwind re-enters — and must SKIP the recorded undo.
    await engine.requeue('run1');
    for (let i = 0; i < 50; i += 1) {
      await flush();
      if ((await store.getRun('run1'))?.status === 'failed') break;
    }
    expect((await store.getRun('run1'))?.status).toBe('failed');
    expect(undoRan).toBe(1); // still exactly once
  });
});

describe('durable compensating cancel', () => {
  it('a compensate-cancel issued by a pod that cannot run the workflow is honored by the worker pod', async () => {
    const store = new InMemoryStateStore();
    let undone = 0;
    const workerEngine = new WorkflowEngine({ store, instanceId: 'worker' });
    workerEngine.register('order', '1', async (ctx) => {
      await ctx.localStep('reserve', async () => 'reserved', {
        compensate: async () => {
          undone += 1;
        },
      });
      await ctx.waitForSignal('approval');
      return 'done';
    });

    await workerEngine.start('order', {}, 'o1');
    await flush();
    expect((await store.getRun('o1'))?.status).toBe('suspended');

    // An "API pod" — same store, workflow NOT registered — cancels with compensation. Its own
    // resume attempt fails (no registration), so only the DURABLE marker carries the intent.
    const apiEngine = new WorkflowEngine({ store, instanceId: 'api' });
    await apiEngine.cancel('o1', { compensate: true });
    await flush();
    expect((await store.getRun('o1'))?.status).toBe('suspended'); // api pod couldn't unwind

    // The worker pod re-drives the run (reconcile/timer stand-in) and must find the durable intent.
    await workerEngine.resume('o1');
    await flush();
    const run = await store.getRun('o1');
    expect(run?.status).toBe('cancelled');
    expect(undone).toBe(1);
    // The marker was consumed once the cancellation was recorded.
    expect(await store.takeBufferedSignal('cancel:o1')).toBeNull();
  });
});

describe('durable flow-control slot release', () => {
  it('persists the admitted queue on the pending checkpoint so any pod can release the slot', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    transport.handle('slow:step', async () => {
      await gate;
      return 'ok';
    });
    const engine = new WorkflowEngine({ store, transport });
    engine.registerQueue({ name: 'q', concurrency: 1 });
    engine.register('wf', '1', async (ctx) => {
      await ctx.step('slow:step', {}, { queue: 'q' });
      return 'done';
    });

    await engine.start('wf', {}, 'w1');
    await flush(5);
    const cp = await store.getCheckpoint('w1', 0);
    expect(cp?.status).toBe('pending');
    expect(cp?.queue).toBe('q'); // durable — a cross-pod result consumer can free the slot from it
    release();
    await flush();
    expect((await store.getRun('w1'))?.status).toBe('completed');
  });
});
