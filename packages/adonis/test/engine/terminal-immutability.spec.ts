import { describe, expect, it } from 'vitest';
import { BaseWorkflow } from '../../src/base-workflow.js';
import { instantCheckpoint } from '../../src/checkpoints.js';
import { WorkflowEngine } from '../../src/engine.js';
import { FatalError, NestedWorkflowCallError } from '../../src/errors.js';
import type { EngineEvent, RunStatus, WorkflowCtx } from '../../src/interfaces.js';
import { runStepHandler } from '../../src/protocol.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { getCurrentWorkflowCtx, workflowAls } from '../../src/workflow-als.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/**
 * A parent that spawns a long-lived child (suspended on a signal) and then settles. The child is
 * the "next queued chat turn" from the agent-queue report: a live run whose parent is already done.
 */
function parentWithLiveChild(engine: WorkflowEngine, outcome: 'fail' | 'complete') {
  engine.register('child', '1', async (ctx) => {
    await ctx.waitForSignal('child-go');
    return 'child-done';
  });
  engine.register('parent', '1', async (ctx) => {
    await ctx.startChild('child', {}, 'child-1');
    if (outcome === 'fail') {
      await ctx.localStep('boom', async () => {
        throw new FatalError('parent blew up');
      });
    }
    return 'parent-done';
  });
}

describe('terminal runs are immutable — cancel()', () => {
  it.each([
    ['failed', 'fail'],
    ['completed', 'complete'],
  ] as const)(
    'cancel on a %s run is a no-op and never cascades to its live children',
    async (status, outcome) => {
      const store = new InMemoryStateStore();
      const engine = new WorkflowEngine({ store });
      parentWithLiveChild(engine, outcome);
      await engine.start('parent', {}, 'p-1');
      await settle();
      expect((await store.getRun('p-1'))?.status).toBe(status);
      expect((await store.getRun('child-1'))?.status).toBe('suspended');
      const before = await store.getRun('p-1');

      const events: EngineEvent[] = [];
      engine.subscribe((e) => events.push(e));
      for (const compensate of [false, true]) {
        const result = await engine.cancel('p-1', { compensate });
        expect(result?.status).toBe(status);
      }
      await settle();

      const after = await store.getRun('p-1');
      expect(after?.status).toBe(status);
      expect(after?.error).toEqual(before?.error);
      expect(after?.updatedAt).toEqual(before?.updatedAt);
      // The live child (the next queued turn) must be untouched.
      expect((await store.getRun('child-1'))?.status).toBe('suspended');
      expect(events.filter((e) => e.type === 'run.failed')).toEqual([]);
    },
  );

  it.each(['cancelled', 'dead'] as RunStatus[])(
    'cancel on a %s run is a no-op and never cascades to its live children',
    async (status) => {
      const store = new InMemoryStateStore();
      const engine = new WorkflowEngine({ store });
      parentWithLiveChild(engine, 'complete');
      await engine.start('parent', {}, 'p-1');
      await settle();
      await store.updateRun('p-1', { status, error: { message: 'original' } });

      for (const compensate of [false, true]) {
        const result = await engine.cancel('p-1', { compensate });
        expect(result?.status).toBe(status);
      }
      await settle();
      expect((await store.getRun('p-1'))?.error).toEqual({ message: 'original' });
      expect((await store.getRun('child-1'))?.status).toBe('suspended');
    },
  );

  it('cancelWhere skips terminal matches without touching their children', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    parentWithLiveChild(engine, 'fail');
    await engine.start('parent', {}, 'p-1');
    await settle();
    const results = await engine.cancelWhere({ workflow: 'parent' });
    expect(results.map((r) => r.status)).toEqual(['failed']);
    expect((await store.getRun('child-1'))?.status).toBe('suspended');
  });
});

describe('terminal runs are immutable — implicit resume paths', () => {
  function failingRun(engine: WorkflowEngine) {
    let bodyRuns = 0;
    engine.register('wf', '1', async (ctx) => {
      bodyRuns += 1;
      await ctx.localStep('boom', async () => {
        throw new FatalError('nope');
      });
    });
    return () => bodyRuns;
  }

  it('recheckWaitSeqs does not re-drive a run that has since failed', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const runs = failingRun(engine);
    await engine.start('wf', {}, 'r1');
    await settle();
    expect((await store.getRun('r1'))?.status).toBe('failed');
    const before = runs();
    const failedAt = (await store.getRun('r1'))?.updatedAt;

    // The waited checkpoint settled (the trigger for a recheck re-drive), but the run failed first.
    await store.saveCheckpoint(
      instantCheckpoint({ runId: 'r1', seq: 5, name: 'signal:late', kind: 'signal', output: 1 }),
    );
    (engine as unknown as { recheckWaitSeqs(runId: string, seqs: number[]): void }).recheckWaitSeqs(
      'r1',
      [5],
    );
    await settle();

    expect(runs()).toBe(before);
    const run = await store.getRun('r1');
    expect(run?.status).toBe('failed');
    expect(run?.updatedAt).toEqual(failedAt);
  });

  it('a late signal to a stale waiter does not re-drive a failed run', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const runs = failingRun(engine);
    await engine.start('wf', {}, 'r1');
    await settle();
    const before = runs();

    await store.putSignalWaiter({ token: 'late', runId: 'r1', seq: 7 });
    await engine.signal('late', { hello: 1 });
    await settle();

    expect(runs()).toBe(before);
    expect((await store.getRun('r1'))?.status).toBe('failed');
  });

  it('a redelivered dispatch (runOne) does not re-drive a failed run', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const runs = failingRun(engine);
    await engine.start('wf', {}, 'r1');
    await settle();
    const before = runs();
    await engine.runOne('r1');
    await settle();
    expect(runs()).toBe(before);
    expect((await store.getRun('r1'))?.status).toBe('failed');
  });

  it('explicit retry (requeue) still re-drives a failed run', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const runs = failingRun(engine);
    await engine.start('wf', {}, 'r1');
    await settle();
    const before = runs();
    await engine.requeue('r1');
    await settle();
    expect(runs()).toBe(before + 1);
  });

  it('explicit resume() still re-drives a failed run (the manual retry API)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const runs = failingRun(engine);
    await engine.start('wf', {}, 'r1');
    await settle();
    const before = runs();
    await engine.resume('r1');
    expect(runs()).toBe(before + 1);
  });
});

describe('ctx primitives called from inside a step body fail fast', () => {
  it('ctx.startChild inside a localStep body throws NestedWorkflowCallError at the call site', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('kid', '1', async () => 'kid');
    let caught: unknown;
    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('outer', async () => {
        try {
          await ctx.startChild('kid', {}, 'kid-1');
        } catch (err) {
          caught = err;
          throw err;
        }
      });
    });
    await engine.start('wf', {}, 'r1');
    await settle();

    expect(caught).toBeInstanceOf(NestedWorkflowCallError);
    expect((caught as Error).message).toMatch(/ctx\.startChild.*inside the body of step "outer"/);
    const run = await store.getRun('r1');
    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toMatch(/ctx\.startChild/);
    expect(await store.getRun('kid-1')).toBeNull();
    const names = (await store.listCheckpoints('r1')).map((c) => c.name);
    expect(names.some((n) => n.startsWith('spawn:'))).toBe(false);
  });

  it('a BaseWorkflow.dispatch() static inside a localStep body fails fast instead of corrupting the journal', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    class KidWorkflow extends BaseWorkflow {
      static override workflow = { name: 'kid-static', version: '1' };
      async run() {
        return 'kid';
      }
    }
    engine.register('kid-static', '1', async () => 'kid');
    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('outer', async () => {
        await KidWorkflow.dispatch(undefined as never, { runId: 'kid-1' });
      });
    });
    await engine.start('wf', {}, 'r1');
    await settle();
    const run = await store.getRun('r1');
    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toMatch(/inside the body of step "outer"/);
    expect(await store.getRun('kid-1')).toBeNull();
  });

  it('other seq-allocating primitives (ctx.sideEffect) inside a step body are guarded too', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('outer', async () => {
        await ctx.sideEffect(() => 1);
      });
    });
    await engine.start('wf', {}, 'r1');
    await settle();
    expect((await store.getRun('r1'))?.error?.message).toMatch(/ctx\.sideEffect/);
  });

  it('primitives OUTSIDE a step body, and parallel body branches, are unaffected', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('kid', '1', async () => 'kid');
    engine.register('wf', '1', async (ctx) => {
      const [a] = await Promise.all([
        ctx.localStep('slow', async () => {
          await new Promise((r) => setTimeout(r, 5));
          return 'a';
        }),
        ctx.startChild('kid', {}, 'kid-1'),
      ]);
      await ctx.startChild('kid', {}, 'kid-2');
      return a;
    });
    await engine.start('wf', {}, 'r1');
    await settle();
    expect((await store.getRun('r1'))?.status).toBe('completed');
    expect(await store.getRun('kid-1')).not.toBeNull();
    expect(await store.getRun('kid-2')).not.toBeNull();
  });

  it('a pre-guard journal that already recorded the nested call still replays (versioning)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('kid', '1', async () => 'kid');
    let stepRuns = 0;
    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('outer', async () => {
        stepRuns += 1;
        await ctx.startChild('kid', {}, 'kid-1');
      });
      return 'ok';
    });
    const now = new Date();
    await store.createRun({
      id: 'r1',
      workflow: 'wf',
      workflowVersion: '1',
      status: 'running',
      input: {},
      createdAt: now,
      updatedAt: now,
    });
    await store.saveCheckpoint(
      instantCheckpoint({
        runId: 'r1',
        seq: 1,
        name: 'spawn:kid-1',
        kind: 'local',
        output: 'kid-1',
      }),
    );
    const result = await engine.resume('r1');
    expect(result.status).toBe('completed');
    expect(stepRuns).toBe(1);
  });
});

describe('dispatched step handlers run outside the ambient workflow ctx', () => {
  it('a handler invoked on the body async path does not see the parent ctx', async () => {
    let seen: WorkflowCtx | undefined = {} as WorkflowCtx;
    const fakeCtx = { runId: 'parent' } as WorkflowCtx;
    const result = await workflowAls.run(fakeCtx, () =>
      runStepHandler(
        { runId: 'parent', seq: 0, stepId: 'parent:0', name: 's', input: 1, attempt: 1 } as never,
        async () => {
          seen = getCurrentWorkflowCtx();
          return 'ok';
        },
      ),
    );
    expect(result.status).toBe('completed');
    expect(seen).toBeUndefined();
  });
});
