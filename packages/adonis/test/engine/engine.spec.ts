import { WorkflowEngine } from '../../src/engine.js';
import { FatalError } from '../../src/errors.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('WorkflowEngine — deterministic replay', () => {
  it('does not re-run an already-completed step when the run is resumed', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    const aRuns: number[] = [];
    let failOnce = true;

    engine.register('wf', '1', async (ctx) => {
      const a = await ctx.localStep('a', async () => {
        aRuns.push(1);
        return 10;
      });
      const b = await ctx.localStep('b', async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('boom');
        }
        return a + 5;
      });
      return b;
    });

    const first = await startRun(engine, 'wf', {}, 'run1');
    expect(first.status).toBe('failed');

    const second = await engine.resume('run1');
    expect(second.status).toBe('completed');
    expect(second.output).toBe(15);

    // 'a' completed on the first attempt, so resume must replay its checkpoint, not re-run it.
    expect(aRuns).toHaveLength(1);
  });

  it('retries a failing step up to the configured limit before the run succeeds', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    let attempts = 0;
    engine.register('wf', '1', async (ctx) =>
      ctx.localStep(
        'flaky',
        async () => {
          attempts += 1;
          if (attempts < 3) throw new Error('try again');
          return 'ok';
        },
        { retries: 3 },
      ),
    );

    const result = await startRun(engine, 'wf', {}, 'run1');

    expect(result.status).toBe('completed');
    expect(result.output).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('fails the run when a step exhausts its retries', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    let attempts = 0;
    engine.register('wf', '1', async (ctx) =>
      ctx.localStep(
        'always-fails',
        async () => {
          attempts += 1;
          throw new Error('nope');
        },
        { retries: 2 },
      ),
    );

    const result = await startRun(engine, 'wf', {}, 'run1');

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('nope');
    expect(attempts).toBe(2);
  });

  it('assigns deterministic checkpoints to steps run in parallel (fan-out)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    const order: string[] = [];
    engine.register('wf', '1', async (ctx) => {
      const [a, b, c] = await Promise.all([
        ctx.localStep('a', async () => {
          order.push('a');
          return 1;
        }),
        ctx.localStep('b', async () => {
          order.push('b');
          return 2;
        }),
        ctx.localStep('c', async () => {
          order.push('c');
          return 3;
        }),
      ]);
      return a + b + c;
    });

    const result = await startRun(engine, 'wf', {}, 'run1');

    expect(result.status).toBe('completed');
    expect(result.output).toBe(6);
    // seq is assigned by call order (the synchronous prefix runs before any await),
    // so the checkpoints are stable regardless of which step's body settles first.
    const checkpoints = await store.listCheckpoints('run1');
    expect(checkpoints.map((cp) => [cp.seq, cp.name])).toEqual([
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
    ]);
  });

  it('does not retry a step that throws a FatalError', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    let attempts = 0;
    engine.register('wf', '1', async (ctx) =>
      ctx.localStep(
        'boom',
        async () => {
          attempts += 1;
          throw new FatalError('do not retry me');
        },
        { retries: 5 },
      ),
    );

    const result = await startRun(engine, 'wf', {}, 'run1');

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('do not retry me');
    expect(attempts).toBe(1);
  });

  it('recovers runs left running after a crash, replaying completed steps', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    let aRuns = 0;
    engine.register('wf', '1', async (ctx) => {
      const a = await ctx.localStep('a', async () => {
        aRuns += 1;
        return 1;
      });
      const b = await ctx.localStep('b', async () => 2);
      return a + b;
    });

    // Simulate a crash: a run that started and completed step 'a' but was left 'running'.
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
    await store.saveCheckpoint({
      runId: 'r1',
      seq: 0,
      name: 'a',
      kind: 'local',
      stepId: 'r1:0',
      status: 'completed',
      output: 1,
      attempts: 1,
      enqueuedAt: now,
      startedAt: now,
      finishedAt: now,
    });

    const recovered = await engine.recoverIncomplete();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe('pending'); // re-enqueued, not resumed inline

    const result = await engine.waitForRun('r1'); // a worker replays + finishes it
    expect(result.status).toBe('completed');
    expect(result.output).toBe(3);
    // 'a' was replayed from its checkpoint, not re-executed.
    expect(aRuns).toBe(0);
  });
});
