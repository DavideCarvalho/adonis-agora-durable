import { afterEach, describe, expect, it } from 'vitest';
import { BaseWorkflow, setWorkflowEngineResolver } from '../../src/base-workflow.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkflowCtx } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { getCurrentWorkflowCtx } from '../../src/workflow-als.js';
import { registerWorkflowClass } from '../../src/workflow-discovery.js';
import { workflowMeta, workflowName } from '../../src/workflow-ref.js';

async function poll(fn: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

// Always clear the injected engine resolver so an OUTSIDE test never bleeds into the next.
afterEach(() => setWorkflowEngineResolver(undefined));

describe('BaseWorkflow — authoring (static workflow)', () => {
  it('resolves name/version/tags from a `static workflow` config', () => {
    class CheckoutWorkflow extends BaseWorkflow {
      static override workflow = { name: 'checkout', version: '2', tags: ['billing'] };
      async run(_ctx: WorkflowCtx, input: { id: string }) {
        return input.id;
      }
    }
    expect(workflowName(CheckoutWorkflow)).toBe('checkout');
    expect(workflowMeta(CheckoutWorkflow)).toEqual({
      name: 'checkout',
      version: '2',
      tags: ['billing'],
    });
  });

  it('defaults version to "1" when the static config omits it', () => {
    class BareWorkflow extends BaseWorkflow {
      static override workflow = { name: 'bare' };
      async run() {
        return 'ok';
      }
    }
    expect(workflowMeta(BareWorkflow)).toEqual({ name: 'bare', version: '1' });
  });

  it('a config-less subclass is not a registrable workflow', () => {
    class NoConfig extends BaseWorkflow {
      async run() {
        return 'ok';
      }
    }
    expect(workflowMeta(NoConfig)).toBeUndefined();
    expect(() => workflowName(NoConfig)).toThrow(/NoConfig/);
  });

  it('registers + runs a `static workflow` class', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });

    class StaticGreet extends BaseWorkflow {
      static override workflow = { name: 'static-greet', version: '1' };
      async run(_ctx: WorkflowCtx, input: { name: string }) {
        return `hi ${input.name}`;
      }
    }

    expect(registerWorkflowClass(engine, StaticGreet)).toBe(true);

    const a = await startRun(engine, 'static-greet', { name: 'davi' }, 's1');
    expect(a.output).toBe('hi davi');
  });
});

describe('BaseWorkflow — OUTSIDE a workflow (engine path)', () => {
  it('.dispatch returns { runId } and does not block on the settle', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    setWorkflowEngineResolver(() => engine);

    let ran = false;
    class Audit extends BaseWorkflow {
      static override workflow = { name: 'outside-audit', version: '1' };
      async run() {
        ran = true;
        return 'logged';
      }
    }
    registerWorkflowClass(engine, Audit);

    const { runId } = await Audit.dispatch({});
    expect(typeof runId).toBe('string');
    // Fire-and-forget: the run eventually completes on the engine's own dispatcher.
    await poll(async () => (await store.getRun(runId))?.status === 'completed');
    expect(ran).toBe(true);
    expect((await store.getRun(runId))?.output).toBe('logged');
  });

  it('.dispatch honours an explicit opts.runId', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    setWorkflowEngineResolver(() => engine);

    class Noop extends BaseWorkflow {
      static override workflow = { name: 'outside-noop', version: '1' };
      async run() {
        return 'done';
      }
    }
    registerWorkflowClass(engine, Noop);

    const { runId } = await Noop.dispatch({}, { runId: 'my-fixed-id' });
    expect(runId).toBe('my-fixed-id');
    await poll(async () => (await store.getRun('my-fixed-id'))?.status === 'completed');
  });

  it('.start blocks and returns the run output (settle)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    setWorkflowEngineResolver(() => engine);

    class Double extends BaseWorkflow {
      static override workflow = { name: 'outside-double', version: '1' };
      async run(_ctx: WorkflowCtx, input: { n: number }) {
        return input.n * 2;
      }
    }
    registerWorkflowClass(engine, Double);

    const result = await Double.start({ n: 21 });
    expect(result).toBe(42); // resolved only after the run settled
  });

  it('.start waits THROUGH a suspension (waitForSignal), resolving only on the terminal output', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    setWorkflowEngineResolver(() => engine);

    class Approval extends BaseWorkflow {
      static override workflow = { name: 'outside-approval', version: '1' };
      async run(ctx: WorkflowCtx) {
        const decision = await ctx.waitForSignal<string>('approve-decision');
        return `decided:${decision}`;
      }
    }
    registerWorkflowClass(engine, Approval);

    // Fixed runId so the test can address the run for signalling / status polling.
    const startPromise = Approval.start({}, { runId: 'appr-1' });
    let settled = false;
    void startPromise.then(() => {
      settled = true;
    });

    // The run parks on the signal (suspended). `.start` must NOT resolve on that settled-but-suspended
    // state — with the old `waitForRun` (resolve-on-settle) it would return `undefined` here.
    await poll(async () => (await store.getRun('appr-1'))?.status === 'suspended');
    await new Promise((r) => setTimeout(r, 20)); // give the promise a window to (wrongly) resolve
    expect(settled).toBe(false);
    expect((await store.getRun('appr-1'))?.status).toBe('suspended');

    // Deliver the signal → the run resumes and reaches a terminal state.
    await engine.signal('approve-decision', 'yes');

    const result = await startPromise; // resolves now, with the REAL output
    expect(result).toBe('decided:yes');
    expect((await store.getRun('appr-1'))?.status).toBe('completed');
  });
});

describe('BaseWorkflow — INSIDE a running workflow (ctx path)', () => {
  it('.start creates a LINKED child, suspends the parent, and returns the child output', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    class Inner extends BaseWorkflow {
      static override workflow = { name: 'inner-start', version: '1' };
      async run(_ctx: WorkflowCtx, input: { n: number }) {
        return input.n + 1;
      }
    }
    class Parent extends BaseWorkflow {
      static override workflow = { name: 'parent-start', version: '1' };
      async run(_ctx: WorkflowCtx) {
        const childOut = await Inner.start({ n: 41 });
        return { fromChild: childOut };
      }
    }
    registerWorkflowClass(engine, Inner);
    registerWorkflowClass(engine, Parent);

    const first = await startRun(engine, 'parent-start', {}, 'p1');
    expect(first.status).toBe('suspended'); // parent parked on the child

    await poll(async () => (await store.getRun('p1'))?.status === 'completed');
    expect((await store.getRun('p1'))?.output).toEqual({ fromChild: 42 });

    // The child exists at the deterministic slot and is LINKED to the parent.
    const childId = 'p1.child.0';
    expect((await store.getRun(childId))?.status).toBe('completed');
    expect(await engine.getRunChildren('p1')).toContain(childId);
  });

  it('.dispatch is fire-and-forget: returns { runId }, parent continues without suspending', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    let childIdSeen: string | undefined;
    class Side extends BaseWorkflow {
      static override workflow = { name: 'inner-side', version: '1' };
      async run() {
        return 'side-done';
      }
    }
    class Parent extends BaseWorkflow {
      static override workflow = { name: 'parent-dispatch', version: '1' };
      async run() {
        const { runId } = await Side.dispatch({});
        childIdSeen = runId;
        return 'parent-done';
      }
    }
    registerWorkflowClass(engine, Side);
    registerWorkflowClass(engine, Parent);

    const res = await startRun(engine, 'parent-dispatch', {}, 'p1');
    expect(res.status).toBe('completed'); // parent did NOT wait on the child
    expect(res.output).toBe('parent-done');
    expect(childIdSeen).toBe('p1.child.0'); // deterministic default child id

    await poll(async () => (await store.getRun('p1.child.0'))?.status === 'completed');
    expect((await store.getRun('p1.child.0'))?.output).toBe('side-done');
  });
});

describe('BaseWorkflow — determinism / positional slot', () => {
  it('.start inside a body consumes the same positional slot as ctx.child (replay-stable)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    let innerRuns = 0;
    let parentBodyTurns = 0;
    class Inner extends BaseWorkflow {
      static override workflow = { name: 'det-inner', version: '1' };
      async run() {
        innerRuns += 1;
        return 'x';
      }
    }
    class Parent extends BaseWorkflow {
      static override workflow = { name: 'det-parent', version: '1' };
      async run() {
        parentBodyTurns += 1;
        await Inner.start({});
        return 'ok';
      }
    }
    registerWorkflowClass(engine, Inner);
    registerWorkflowClass(engine, Parent);

    await startRun(engine, 'det-parent', {}, 'p1');
    await poll(async () => (await store.getRun('p1'))?.status === 'completed');

    // The parent body ran at least twice (dispatch turn + resume/replay turn) but the child was
    // created exactly once at the deterministic slot — the start did not re-create it on replay.
    expect(parentBodyTurns).toBeGreaterThanOrEqual(2);
    expect(innerRuns).toBe(1);
    expect((await store.getRun('p1.child.0'))?.status).toBe('completed');

    // Same run resumed again over the same store re-derives the same slot: no new child, no re-run.
    await engine.resume('p1');
    expect(innerRuns).toBe(1);
  });

  it('.start and ctx.child at the same call position produce the same child id', async () => {
    const viaStart = new InMemoryStateStore();
    const engineA = new WorkflowEngine({ store: viaStart });
    const viaCtx = new InMemoryStateStore();
    const engineB = new WorkflowEngine({ store: viaCtx });

    class Inner extends BaseWorkflow {
      static override workflow = { name: 'slot-inner', version: '1' };
      async run() {
        return 'x';
      }
    }
    class ParentViaStart extends BaseWorkflow {
      static override workflow = { name: 'slot-parent', version: '1' };
      async run() {
        await Inner.start({});
        return 'ok';
      }
    }
    registerWorkflowClass(engineA, Inner);
    registerWorkflowClass(engineA, ParentViaStart);

    engineB.register('slot-inner', '1', async () => 'x');
    engineB.register('slot-parent', '1', async (ctx) => {
      await ctx.child('slot-inner', {});
      return 'ok';
    });

    await startRun(engineA, 'slot-parent', {}, 'p1');
    await startRun(engineB, 'slot-parent', {}, 'p1');
    await poll(async () => (await viaStart.getRun('p1'))?.status === 'completed');
    await poll(async () => (await viaCtx.getRun('p1'))?.status === 'completed');

    // Identical deterministic child slot regardless of whether the parent used Inner.start or ctx.child.
    expect(await engineA.getRunChildren('p1')).toEqual(await engineB.getRunChildren('p1'));
    expect(await engineA.getRunChildren('p1')).toContain('p1.child.0');
  });
});

describe('getCurrentWorkflowCtx — ALS isolation', () => {
  it('is undefined outside any workflow run', () => {
    expect(getCurrentWorkflowCtx()).toBeUndefined();
  });

  it("exposes the running run's ctx (equals the explicit param) and is scoped per run", async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    // `ambientRunId` is always written, but is `undefined` if the ambient ctx went missing — which is
    // precisely the failure this test would catch, so the type has to be able to hold it.
    const seen: Record<string, { matches: boolean; ambientRunId: string | undefined }> = {};
    const bodies = ['als-a', 'als-b'];
    for (const name of bodies) {
      engine.register(name, '1', async (ctx) => {
        // Yield so both runs are interleaved on the microtask/timer queue.
        await new Promise((r) => setTimeout(r, 5));
        const ambient = getCurrentWorkflowCtx();
        seen[ctx.runId] = { matches: ambient === ctx, ambientRunId: ambient?.runId };
        return 'ok';
      });
    }

    await Promise.all([
      startRun(engine, 'als-a', {}, 'run-a'),
      startRun(engine, 'als-b', {}, 'run-b'),
    ]);

    // Each run's ambient ctx is its OWN ctx (no bleed across the two concurrent runs).
    expect(seen['run-a']).toEqual({ matches: true, ambientRunId: 'run-a' });
    expect(seen['run-b']).toEqual({ matches: true, ambientRunId: 'run-b' });
    // And once the runs finished, the ambient ctx is gone again.
    expect(getCurrentWorkflowCtx()).toBeUndefined();
  });
});
